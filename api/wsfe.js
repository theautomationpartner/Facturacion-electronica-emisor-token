// api/wsfe.js
// -----------------------------------------------------------------------------
// Proxy hacia el Web Service de Facturación Electrónica de AFIP (WSFEv1).
//
// POR QUÉ EXISTE:
//   Make (Integromat) no puede conectarse directo a los servidores de AFIP porque
//   AFIP usa parámetros TLS antiguos (clave Diffie-Hellman de 1024 bits) y el motor
//   de Make los rechaza con el error "dh key too small". Desde Vercel/Node esa misma
//   conexión funciona sin problema (igual que ya funciona /api/token).
//
// QUÉ HACE:
//   Recibe EXACTAMENTE lo mismo que Make le mandaba a AFIP:
//     - El cuerpo (body) es el XML SOAP crudo, tal cual.
//     - El header "SOAPAction" viaja igual que antes.
//   Reenvía todo a AFIP y devuelve la respuesta XML sin modificarla.
//
// RESULTADO:
//   En Make sólo hay que cambiar la URL del módulo. Nada más se toca:
//   ni el body, ni los headers, ni los módulos anteriores o posteriores.
// -----------------------------------------------------------------------------

// Lee el cuerpo crudo de la request como texto (sin intentar parsear JSON).
// Necesario porque el body es XML, no JSON.
function readRawBody(request) {
  return new Promise((resolve, reject) => {
    // Si Vercel ya dejó el body disponible, lo usamos directamente.
    if (typeof request.body === 'string') {
      return resolve(request.body);
    }
    if (request.body && typeof request.body === 'object' && Buffer.isBuffer(request.body)) {
      return resolve(request.body.toString('utf8'));
    }
    // Si no, lo leemos del stream entrante, chunk por chunk.
    let data = '';
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => resolve(data));
    request.on('error', (err) => reject(err));
  });
}

// Busca un header sin importar mayúsculas/minúsculas (los headers no distinguen caso).
function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

module.exports = async function (request, response) {
  try {
    // Sólo aceptamos POST (SOAP siempre va por POST).
    if (request.method !== 'POST') {
      response.setHeader('Content-Type', 'application/json');
      return response.status(405).send(JSON.stringify({ ok: false, error: 'Usá POST' }));
    }

    // 1) El XML SOAP crudo que envía Make (idéntico al que iba a AFIP).
    const soapBody = await readRawBody(request);

    if (!soapBody || soapBody.trim() === '') {
      response.setHeader('Content-Type', 'application/json');
      return response.status(400).send(JSON.stringify({ ok: false, error: 'Body vacío: falta el XML SOAP' }));
    }

    // 2) El SOAPAction viene en el header, igual que hoy en Make.
    //    (Ej: http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado)
    const soapAction = getHeader(request.headers, 'SOAPAction') || '';

    // 3) Endpoint de AFIP. Producción por defecto.
    //    Si algún día querés homologación, mandá el header  x-afip-env: homo
    const env = (getHeader(request.headers, 'x-afip-env') || 'prod').toLowerCase();
    const endpoint = env === 'homo'
      ? 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'
      : 'https://servicios1.afip.gov.ar/wsfev1/service.asmx';

    // 4) Reenviamos a AFIP con los mismos headers que usaba Make.
    const afipRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
      },
      body: soapBody,
    });

    // 5) Devolvemos la respuesta de AFIP TAL CUAL (mismo XML, mismo status).
    //    Así los módulos siguientes de Make la parsean exactamente igual que antes.
    const text = await afipRes.text();

    response.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return response.status(afipRes.status).send(text);

  } catch (e) {
    response.setHeader('Content-Type', 'application/json');
    return response.status(500).send(JSON.stringify({ ok: false, error: e.message }));
  }
};

// Desactiva el parseo automático del body por parte de Vercel, para recibir el
// XML crudo intacto. Sin esto, Vercel podría intentar interpretar el body y
// alterarlo o vaciarlo. Debe ir DESPUÉS de asignar module.exports.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
