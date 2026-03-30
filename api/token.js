// Adaptación para Vercel: token.js
const { handler } = require('../netlify/functions/token');

export default async function(request, response) {
  const event = {
    httpMethod: request.method,
    headers: request.headers,
    queryStringParameters: request.query,
    body: request.body,
    path: request.url
  };
  const context = {};
  const result = await handler(event, context);
  response.status(result.statusCode || 200).set(result.headers || {}).send(result.body);
}
