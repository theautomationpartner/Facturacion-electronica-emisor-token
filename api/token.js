// Adaptación para Vercel: token.js
const { handler } = require('../netlify/functions/token');

module.exports = async function(request, response) {
  const event = {
    httpMethod: request.method,
    headers: request.headers,
    queryStringParameters: request.query,
    body: typeof request.body === 'object' ? JSON.stringify(request.body) : request.body,
    path: request.url
  };
  const context = {};
  const result = await handler(event, context);
  
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      response.setHeader(key, value);
    }
  }
  
  response.status(result.statusCode || 200).send(result.body);
};
