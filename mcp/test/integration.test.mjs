import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateKeyPair, SignJWT } from 'jose';
import { ListmonkClient, SendReviews } from '../src/listmonk.mjs';
import { createServer } from '../src/server.mjs';
import { createHttpApp } from '../src/http.mjs';

function fixture() {
  const state = {
    campaign: { id: 7, name: 'Weekly', subject: 'Finch news', body: '<p>News</p>', lists: [{ id: 1, name: 'Finch' }], status: 'draft', type: 'regular', messenger: 'email', template_id: 2, from_email: 'Finch <news@finchnow.com>', to_send: 5000 },
    template: { id: 2, type: 'campaign', body: '{{ template "content" . }}', is_default: true },
    list: { id: 1, name: 'Finch', status: 'active', subscriber_count: 5000 },
    calls: [],
  };
  const client = new ListmonkClient({ url: 'http://127.0.0.1:9000', user: 'test', token: 'not-a-real-token', allowedListIds: [1],
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      const path = url.pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      state.calls.push({ path, method: options.method, body });
      let value;
      if (path === '/api/campaigns/7/status') { state.campaign.status = body.status; value = state.campaign; }
      else if (path === '/api/campaigns' && options.method === 'POST') { state.campaign = { ...state.campaign, ...body, status: 'draft' }; value = state.campaign; }
      else if (path === '/api/campaigns/7' && options.method === 'PUT') { state.campaign = { ...state.campaign, ...body }; value = state.campaign; }
      else if (path === '/api/campaigns/7') value = state.campaign;
      else if (path === '/api/templates') value = [state.template];
      else if (path === '/api/lists/1') value = state.list;
      else if (path === '/api/campaigns/7/preview') return new Response('<html>Sample newsletter</html>');
      else throw new Error(`Unexpected API route: ${path}`);
      return Response.json({ data: value });
    },
  });
  return { state, client };
}
async function connect(t, options = {}) {
  const f = fixture();
  const server = createServer({ client: f.client, reviews: new SendReviews(), enableSend: true, ...options });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '1.0' });
  await mcp.connect(b);
  t.after(async () => { await mcp.close(); await server.close(); });
  return { ...f, mcp };
}
const call = (mcp, name, args = {}) => mcp.callTool({ name, arguments: args });
const data = response => JSON.parse(response.content[0].text);

test('official MCP client discovers tools and creates a draft without calling a send endpoint', async t => {
  const { mcp, state } = await connect(t);
  const tools = await mcp.listTools();
  assert.equal(tools.tools.length, 8);
  assert.equal(tools.tools.find(t => t.name === 'send_newsletter').annotations.destructiveHint, true);
  const response = await call(mcp, 'create_newsletter_draft', {
    name: 'Draft', subject: 'This week', lists: [1], body: '<p>Draft content</p>', content_type: 'html', template_id: 2, from_email: 'Finch <news@finchnow.com>',
  });
  assert.equal(data(response).status, 'draft');
  assert.deepEqual(state.calls.map(c => c.path), ['/api/campaigns']);
});

test('blocks disallowed audiences and editing campaigns that are not drafts', async t => {
  const { mcp, state } = await connect(t);
  state.campaign.lists = [{ id: 99 }];
  assert.equal((await call(mcp, 'get_newsletter', { campaign_id: 7 })).isError, true);
  state.campaign.lists = [{ id: 1 }];
  state.campaign.status = 'running';
  const r = await call(mcp, 'update_newsletter_draft', { campaign_id: 7, name: 'Draft', subject: 'S', lists: [1], body: 'B', content_type: 'plain', template_id: 2, from_email: 'news@finchnow.com' });
  assert.equal(r.isError, true);
  assert.equal(state.calls.some(c => c.method === 'PUT'), false);
});

test('review permits only one send and replays cannot send again', async t => {
  const { mcp, state } = await connect(t);
  const review = data(await call(mcp, 'prepare_newsletter_send', { campaign_id: 7 }));
  assert.equal(review.recipient_estimate, 5000);
  const results = await Promise.all([0, 1].map(() => call(mcp, 'send_newsletter', { campaign_id: 7, review_token: review.review_token })));
  assert.equal(results.filter(r => !r.isError).length, 1);
  assert.equal(state.calls.filter(c => c.path.endsWith('/status')).length, 1);
});

test('editing refuses attachments and other settings it cannot preserve', async t => {
  const { mcp, state } = await connect(t);
  state.campaign.media = [{ id: 12 }];
  const response = await call(mcp, 'update_newsletter_draft', { campaign_id: 7, name: 'Draft', subject: 'S', lists: [1], body: 'B', content_type: 'plain', template_id: 2, from_email: 'news@finchnow.com' });
  assert.equal(response.isError, true);
  assert.equal(state.calls.some(c => c.method === 'PUT'), false);
});

for (const changed of ['body', 'template', 'audience']) {
  test(`a changed ${changed} invalidates the send review`, async t => {
    const { mcp, state } = await connect(t);
    const review = data(await call(mcp, 'prepare_newsletter_send', { campaign_id: 7 }));
    if (changed === 'body') state.campaign.body = 'changed';
    if (changed === 'template') state.template.body = 'changed template';
    if (changed === 'audience') state.list.subscriber_count += 1;
    const sent = await call(mcp, 'send_newsletter', { campaign_id: 7, review_token: review.review_token });
    assert.equal(sent.isError, true);
    assert.match(sent.content[0].text, /changed/);
    assert.equal(state.calls.some(c => c.path.endsWith('/status')), false);
  });
}

test('sending disabled and missing send scope both block delivery', async t => {
  for (const options of [{ enableSend: false }, { scopes: ['newsletter:manage'] }]) {
    const { mcp, state } = await connect(t, options);
    const review = data(await call(mcp, 'prepare_newsletter_send', { campaign_id: 7 }));
    assert.equal((await call(mcp, 'send_newsletter', { campaign_id: 7, review_token: review.review_token })).isError, true);
    assert.equal(state.calls.some(c => c.path.endsWith('/status')), false);
  }
});

test('reviews are bound to owner, campaign, expiry, content and single use', () => {
  let now = 0;
  const reviews = new SendReviews({ now: () => now, ttlMs: 100 });
  const r = reviews.prepare('a', 7, 'hash');
  assert.throws(() => reviews.consume(r.review_token, 'b', 7, 'hash'), /Invalid/);
  assert.throws(() => reviews.consume(r.review_token, 'a', 8, 'hash'), /Invalid/);
  now = 100;
  assert.throws(() => reviews.consume(r.review_token, 'a', 7, 'hash'), /expired/);
  const fresh = reviews.prepare('a', 7, 'hash');
  assert.throws(() => reviews.consume(fresh.review_token, 'a', 7, 'new-hash'), /changed/);
  assert.throws(() => reviews.consume(fresh.review_token, 'a', 7, 'hash'), /Invalid/);
});

test('HTTP transport validates JWT signature, expiry, audience, issuer and scopes; real client round trip succeeds', async t => {
  const { client } = fixture();
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const issuer = 'https://issuer.example/';
  const resourceUrl = 'https://newsletter.finchnow.com/mcp';
  const app = createHttpApp({ client, reviews: new SendReviews(), enableSend: false, issuer, jwksUrl: 'https://issuer.example/jwks', resourceUrl, keySet: publicKey });
  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise(resolve => { httpServer.close(resolve); httpServer.closeAllConnections(); }));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const sign = (overrides = {}, key = privateKey) => new SignJWT({ sub: 'operator', scope: 'newsletter:manage', ...overrides })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(overrides.iss ?? issuer).setAudience(overrides.aud ?? resourceUrl)
    .setExpirationTime(overrides.exp ?? '5m').sign(key);
  assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status, 200);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
  const wrongKey = await generateKeyPair('RS256');
  for (const token of ['bad', await sign({ aud: 'wrong' }), await sign({ iss: 'https://wrong.example/' }), await sign({ exp: 1 }), await sign({}, wrongKey.privateKey)]) {
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 401);
  }
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${await sign({ scope: 'unrelated' })}` } })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${await sign()}`, Origin: 'https://untrusted.example' } })).status, 403);
  const mcp = new Client({ name: 'http-test', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await sign()}` } } });
  await mcp.connect(transport);
  assert.equal((await mcp.listTools()).tools.length, 8);
  assert.equal(data(await call(mcp, 'list_newsletter_audiences'))[0].id, 1);
  await mcp.close();
});
