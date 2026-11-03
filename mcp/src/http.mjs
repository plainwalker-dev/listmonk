import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createServer } from './server.mjs';

export function createHttpApp({ client, reviews, enableSend, issuer, jwksUrl, resourceUrl, host = '127.0.0.1', keySet }) {
  for (const value of [issuer, jwksUrl, resourceUrl]) {
    if (!value || new URL(value).protocol !== 'https:') throw new Error('HTTP transport requires HTTPS OAuth issuer, JWKS URL and resource URL.');
  }
  const resource = new URL(resourceUrl);
  if (resource.pathname !== '/mcp' || resource.search || resource.hash) throw new Error('MCP_RESOURCE_URL must end in /mcp without a query or fragment.');
  const jwks = keySet ?? createRemoteJWKSet(new URL(jwksUrl));
  const verify = async token => (await jwtVerify(token, jwks, {
    issuer, audience: resourceUrl, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp'],
  })).payload;
  const app = express();
  app.use(hostHeaderValidation([resource.hostname, 'localhost', '127.0.0.1']), express.json({ limit: '2mb' }));
  app.disable('x-powered-by');
  const metadata = {
    resource: resourceUrl, authorization_servers: [issuer],
    scopes_supported: ['newsletter:manage', 'newsletter:send'], bearer_methods_supported: ['header'],
  };
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(metadata));
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(metadata));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use('/mcp', async (req, res, next) => {
    const challenge = `Bearer resource_metadata="${resource.origin}/.well-known/oauth-protected-resource/mcp"`;
    const origin = req.headers.origin;
    if (origin && origin !== resource.origin && origin !== 'https://chatgpt.com') return res.sendStatus(403);
    try {
      const authorization = req.headers.authorization ?? '';
      if (!authorization.startsWith('Bearer ')) throw new Error('Missing bearer token');
      const payload = await verify(authorization.slice(7));
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Missing token subject');
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
      if (!scopes.includes('newsletter:manage')) {
        return res.set('WWW-Authenticate', `${challenge}, error="insufficient_scope", scope="newsletter:manage"`).sendStatus(403);
      }
      req.newsletterAuth = { owner: `${issuer}|${payload.sub}`, scopes };
      next();
    } catch {
      res.set('WWW-Authenticate', challenge).sendStatus(401);
    }
  });
  app.post('/mcp', async (req, res) => {
    const server = createServer({ client, reviews, enableSend, ...req.newsletterAuth });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP request failed.' } });
    }
  });
  app.all('/mcp', (_req, res) => res.set('Allow', 'POST').sendStatus(405));
  return app;
}
