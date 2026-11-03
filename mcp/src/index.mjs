import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListmonkClient, SendReviews } from './listmonk.mjs';
import { createServer } from './server.mjs';
import { createHttpApp } from './http.mjs';

const client = new ListmonkClient({
  url: process.env.LISTMONK_URL ?? 'http://127.0.0.1:9000',
  user: process.env.LISTMONK_API_USER, token: process.env.LISTMONK_API_TOKEN,
  allowedListIds: (process.env.LISTMONK_ALLOWED_LIST_IDS ?? '').split(',').filter(Boolean).map(Number),
});
const reviews = new SendReviews();
const enableSend = process.env.ENABLE_SEND === 'true';
const transport = process.env.MCP_TRANSPORT ?? 'stdio';
if (transport === 'stdio') {
  await createServer({ client, reviews, enableSend }).connect(new StdioServerTransport());
} else if (transport === 'http') {
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.MCP_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP_PORT.');
  const app = createHttpApp({ client, reviews, enableSend, host,
    issuer: process.env.OAUTH_ISSUER, jwksUrl: process.env.OAUTH_JWKS_URL,
    resourceUrl: process.env.MCP_RESOURCE_URL,
  });
  app.listen(port, host, () => console.error(`Finch newsletter MCP listening on ${host}:${port}`));
} else throw new Error('MCP_TRANSPORT must be stdio or http.');
