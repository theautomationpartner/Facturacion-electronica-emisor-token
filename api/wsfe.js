// api/wsfe.js
// -----------------------------------------------------------------------------
// Proxy hacia el Web Service de Facturación Electrónica de AFIP (WSFEv1).
//
// POR QUÉ EXISTE:
//   Make (Integromat) no puede conectarse directo a AFIP porque AFIP usa TLS
//   antiguo (clave Diffie-Hellman de 1024 bits) y Make lo rechaza con el error
//   "dh key too small". Desde Vercel/Node esa conexión funciona sin problema.
//
// QUÉ HACE:
//   Recibe lo mismo que Make le mandaba a AFIP: el XML SOAP crudo en el body y
//   el header "SOAPAction". Lo reenvía a AFIP y devuelve la respuesta XML igual.
//   En Make sólo hay que cambiar la URL del módulo.
// -----------------------------------------------------------------------------

const https = require('https');

// Busca un header sin importar mayúsculas/minúsculas.
function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// Obtiene el body como texto, sin importar cómo lo entregue Vercel:
//   - Si ya viene como string  -> lo usa.
//   - Si viene como Buffer     -> lo convierte a texto.
//   - Si viene como objeto     -> lo pasa a string (caso raro).
//   - Si no vino nada          -> lo lee del stream de la request.
function getRawBody(request) {
  return new Promise((resolve) => {
    const b = request.body;

    if (typeof b === 'string') return resolve(b);
    if (Buffer.isBuffer(b)) return resolve(b.toString('utf8'));
    if (b && typeof b === 'object') {
      // Vercel a veces entrega un objeto vacío {} cuando no supo parsear.
      // En ese caso caemos a leer el stream. Si tiene contenido real, lo serializamos.
      const keys = Object.keys(b);
      if (keys.length > 0) return resolve(typeof b === 'string' ? b : JSON.stringify(b));
    }

    // Leer del stream entrante.
    let data = '';
    let terminado = false;
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => { if (!terminado) { terminado = true; resolve(data); } });
    request.on('error', () => { if (!terminado) { terminado = true; resolve(data); } });
    // Red de seguridad: si el stream nunca dispara 'end', resolvemos igual a los 8s.
    setTimeout(() => { if (!terminado) { terminado = true; resolve(data); } }, 8000);
  });
}

// Hace el POST a AFIP usando el módulo https nativo (confiable en serverless).
function postAAfip(endpointUrl, soapBody, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpointUrl);
    const payload = Buffer.from(soapBody, 'utf8');

    const opciones = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
        'Content-Length': payload.length,
      },
    };

    const req = https.request(opciones, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

module.exports = async function (request, response) {
  try {
    if (request.method !== 'POST') {
      response.setHeader('Content-Type', 'application/json');
      return response.status(405).send(JSON.stringify({ ok: false, error: 'Usá POST' }));
    }

    const soapBody = await getRawBody(request);

    if (!soapBody || soapBody.trim() === '') {
      response.setHeader('Content-Type', 'application/json');
      return response.status(400).send(JSON.stringify({ ok: false, error: 'Body vacío: falta el XML SOAP' }));
    }

    const soapAction = getHeader(request.headers, 'SOAPAction') || '';

    // Endpoint AFIP: producción por defecto. Homologación con header x-afip-env: homo
    const env = (getHeader(request.headers, 'x-afip-env') || 'prod').toLowerCase();
    const endpoint = env === 'homo'
      ? 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'
      : 'https://servicios1.afip.gov.ar/wsfev1/service.asmx';

    const afip = await postAAfip(endpoint, soapBody, soapAction);

    // Devolvemos la respuesta de AFIP tal cual, para que Make la parsee igual que antes.
    response.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return response.status(afip.status || 200).send(afip.body);

  } catch (e) {
    // Cualquier error interno lo devolvemos legible, para poder diagnosticar.
    response.setHeader('Content-Type', 'application/json');
    return response.status(500).send(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
};
