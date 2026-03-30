// Adaptación para Vercel: token.js
const { handler } = require('../netlify/functions/token');

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
