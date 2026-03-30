// Adaptación para Vercel: sign.js
const { handler } = require('../netlify/functions/sign');

module.exports = async (req, res) => {
  // Adaptar el objeto event de Netlify a req/res de Vercel
  const event = {
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: req.query,
    body: req.body,
    path: req.url
  };
  const context = {};
  const result = await handler(event, context);
  res.status(result.statusCode || 200).set(result.headers || {}).send(result.body);
};
