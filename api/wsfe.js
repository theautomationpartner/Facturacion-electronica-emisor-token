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
const zlib = require('zlib');

const LOG = '[wsfe]';

const ENDPOINTS = {
  prod: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  homo: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
};

// EL PUNTO CLAVE DE TODO ESTE ARCHIVO:
//   AFIP negocia DHE-RSA-AES256-GCM-SHA384 con un grupo Diffie-Hellman de 1024
//   bits. OpenSSL 3 (Node 18+) usa por defecto security level 2, que exige DH de
//   >=2048 bits, y corta con "dh key too small" — el mismo error que tira Make.
//   O sea: sin esto el proxy falla igual que Make y no sirve para nada.
//
//   SECLEVEL=1 es la mínima concesión que hace falta: sigue exigiendo TLS 1.2 y
//   sigue rechazando cifrados rotos; sólo acepta el DH corto de AFIP. No usar
//   SECLEVEL=0, que además habilita cosas realmente inseguras.
//   Aplica SOLO a esta conexión con AFIP, no al resto del proyecto.
const AFIP_CIPHERS = 'DEFAULT@SECLEVEL=1';

// Busca un header sin importar mayúsculas/minúsculas.
function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// Obtiene el body como texto, sin importar cómo lo entregue Vercel.
// Ojo: si Vercel ya consumió el stream, request.body es la única fuente; si no
// lo consumió, request.body viene vacío y hay que leer el stream. Por eso se
// chequean las dos cosas, en ese orden.
function getRawBody(request) {
  const b = request.body;

  if (typeof b === 'string' && b.length > 0) return Promise.resolve(b);
  if (Buffer.isBuffer(b) && b.length > 0) return Promise.resolve(b.toString('utf8'));

  // Si Vercel parseó el body a objeto, el XML original ya se perdió. No lo
  // convertimos a JSON (eso le mandaba basura a AFIP y AFIP respondía 500).
  // Con bodyParser:false esto no debería pasar nunca.
  if (b && typeof b === 'object' && !Buffer.isBuffer(b) && Object.keys(b).length > 0) {
    return Promise.reject(new Error(
      'El body llegó parseado como objeto y el XML original se perdió. ' +
      'Revisá que el módulo de Make mande Content-Type: text/xml con el XML crudo.'
    ));
  }

  // Si el stream ya fue consumido y aun así el body vino vacío, el XML ya no
  // existe: 'end' no se vuelve a disparar y esperarlo colgaría la función.
  //
  // OJO: acá va readableEnded, NO request.complete. Son cosas distintas:
  //   complete      = el mensaje HTTP se recibió entero (Vercel bufferea el
  //                   request antes de invocar, así que llega true de entrada,
  //                   con el body todavía sin leer y perfectamente disponible).
  //   readableEnded = ya se emitió 'end', o sea alguien YA lo consumió.
  // Usar complete acá abortaba en Vercel con el XML intacto en el buffer.
  if (request.readableEnded) {
    return Promise.reject(new Error(
      'El stream del request ya fue consumido y request.body llegó vacío: ' +
      'no se puede recuperar el XML. Revisá la config de bodyParser.'
    ));
  }

  // Caso normal: leer el stream entrante como binario y recién ahí decodificar
  // (concatenar strings rompe caracteres multi-byte partidos entre chunks).
  return new Promise((resolve, reject) => {
    const chunks = [];
    let listo = false;
    const terminar = (fn, arg) => { if (!listo) { listo = true; fn(arg); } };

    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => terminar(resolve, Buffer.concat(chunks).toString('utf8')));
    request.on('error', (e) => terminar(reject, e));

    // Red de seguridad: nunca colgarse esperando un stream que no termina.
    const t = setTimeout(
      () => terminar(reject, new Error('Timeout de 10s leyendo el body del request')),
      10000
    );
    if (typeof t.unref === 'function') t.unref();
  });
}

// Descomprime la respuesta según el Content-Encoding que haya declarado AFIP.
// No pedimos compresión, pero si igual llega comprimida la manejamos.
function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!buffer.length) return buffer;
  if (enc === 'gzip') return zlib.gunzipSync(buffer);
  if (enc === 'deflate') return zlib.inflateSync(buffer);
  if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  return buffer;
}

// Hace el POST a AFIP usando el módulo https nativo (confiable en serverless).
function postAAfip(endpointUrl, soapBody, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpointUrl);
    const payload = Buffer.from(soapBody, 'utf8');

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
        'Content-Length': payload.length,
        // Pedimos explícitamente sin comprimir: menos superficie para fallar.
        'Accept-Encoding': 'identity',
      },
      // Sin esto: "dh key too small". Ver comentario en AFIP_CIPHERS.
      ciphers: AFIP_CIPHERS,
      minVersion: 'TLSv1.2',
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const text = decompress(raw, res.headers['content-encoding']).toString('utf8');
          resolve({ status: res.statusCode, body: text });
        } catch (e) {
          reject(new Error('No se pudo descomprimir la respuesta de AFIP: ' + e.message));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('AFIP no respondió en 30s')));
    req.write(payload);
    req.end();
  });
}

async function wsfeHandler(request, response) {
  try {
    if (request.method !== 'POST') {
      response.setHeader('Content-Type', 'application/json');
      return response.status(405).send(JSON.stringify({ ok: false, error: 'Usá POST' }));
    }

    const soapBody = await getRawBody(request);

    if (!soapBody || soapBody.trim() === '') {
      console.error(LOG, 'Body vacío. content-type=', getHeader(request.headers, 'content-type'));
      response.setHeader('Content-Type', 'application/json');
      return response.status(400).send(JSON.stringify({ ok: false, error: 'Body vacío: falta el XML SOAP' }));
    }

    const soapAction = getHeader(request.headers, 'SOAPAction') || '';
    const env = String(getHeader(request.headers, 'x-afip-env') || 'prod').toLowerCase();
    const endpoint = ENDPOINTS[env] || ENDPOINTS.prod;

    const afip = await postAAfip(endpoint, soapBody, soapAction);

    // AFIP devuelve HTTP 500 con un SOAP Fault adentro cuando algo del XML no le
    // gusta. Lo dejamos pasar tal cual (es lo que Make recibía antes yendo
    // directo), pero lo logueamos para poder diagnosticar desde Vercel.
    if (afip.status >= 400) {
      console.error(LOG, 'AFIP respondió', afip.status, 'para SOAPAction=', soapAction);
      console.error(LOG, 'cuerpo:', afip.body.slice(0, 1000));
    }

    response.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return response.status(afip.status || 200).send(afip.body);

  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error(LOG, 'Error en el proxy:', msg, e && e.stack);
    response.setHeader('Content-Type', 'application/json');
    return response.status(500).send(JSON.stringify({ ok: false, error: msg }));
  }
}

module.exports = wsfeHandler;

// Le pedimos a Vercel que NO toque el body: lo queremos crudo, tal cual llega.
// Sin esto Vercel puede parsearlo y dejar request.body como objeto, perdiendo el
// XML. Tiene que ir DESPUÉS del module.exports de arriba: al revés se pisa.
// El handler igual funciona si Vercel ignora esta config (lee request.body).
module.exports.config = { api: { bodyParser: false } };
