# Finch listmonk MCP bridge

An API companion in the listmonk fork, using the official MCP TypeScript SDK.
ChatGPT generates the newsletter content; no separate OpenAI API key is needed
for this bridge. It supports stdio for a trusted local operator and authenticated
Streamable HTTP for a remote ChatGPT connection.

## Run locally

Requires Node.js 22+, a running listmonk v6.2 instance, a dedicated listmonk API
user, and a nonempty allowlist of permitted list IDs.

```sh
cd mcp
npm ci --ignore-scripts
cp .env.example .env
# Populate the API credentials and allowed list IDs in .env.
npm start
```

For an MCP desktop client, use command `node`, arguments
`["/absolute/path/to/listmonk/mcp/src/index.mjs"]`, and pass the variables in
`.env` through the client's environment configuration. Never put secrets into
chat or checked-in client configuration. Stdio is a local trust boundary: the
process owner has both management and send scope, subject to ENABLE_SEND.

## Remote ChatGPT

Set `MCP_TRANSPORT=http`, `MCP_RESOURCE_URL=https://newsletter.finchnow.com/mcp`,
`OAUTH_ISSUER`, and `OAUTH_JWKS_URL`. Configure the OAuth provider to issue signed
JWT **access tokens**, with this resource URL as audience and `newsletter:manage`
scope. Grant `newsletter:send` only to approved newsletter operators. Restrict
provider app assignment to Finch staff; do not allow arbitrary public signups
to obtain these scopes. RS256 and ES256 signatures are accepted.

The provider must support the ChatGPT authorization-code/PKCE flow with a
supported client registration method (CIMD, DCR, or configured static OAuth
client credentials). Configure ChatGPT's exact redirect URI and refresh-token
policy there. This repository supplies protected-resource metadata and token
validation; it does not supply or provision an authorization server.

Copy `mcp/.env.example` to `mcp/.env` on the server and populate it. From
`deploy/finch`, run `docker compose --profile mcp up -d --build`. The default
deployment starts without MCP until this step; Caddy returns an upstream error
for MCP routes while that service is disabled.

In ChatGPT, add a custom MCP server using the full `/mcp` URL and OAuth,
authenticate, inspect the discovered tools, and install/select it for the chat.
Availability follows the account/workspace's current permissions. Verify the
client requires human confirmation on `send_newsletter`. Keep `ENABLE_SEND=false`
until the live approval and delivery tests pass, then change it and recreate the
MCP service. Do not configure automatic approval for the send tool.

## Tools

| Tool | Behavior |
| --- | --- |
| list_newsletter_audiences | Allowed lists and counts, without individual contacts |
| list_newsletter_templates | Available templates for newsletter styling |
| get_newsletter | One campaign restricted to allowed lists |
| create_newsletter_draft | Save a regular email draft |
| update_newsletter_draft | Replace supported fields in a draft only |
| preview_newsletter | Render with listmonk's sample subscriber |
| prepare_newsletter_send | Show review, audience estimate and a 10-minute token |
| send_newsletter | Start delivery after explicit human approval in the client |

The send action is annotated as destructive. The review token is bound to
the authenticated user, campaign, content/template/list snapshot and expiry.
It is single-use. A token is **not proof of human approval**; that approval is a
client responsibility. Restarting the server invalidates all outstanding reviews.
Run a single MCP instance: pending reviews are intentionally process-local.

This first implementation has no scheduling, raw API passthrough, subscriber
export, arbitrary SQL, bulk subscription modification, or transactional sends.
Keep contact migration outside chat tools. `update_newsletter_draft` replaces
the supported draft fields; do not use it for campaigns with attachments,
custom headers, custom attributes, public-archive settings or scheduled sends.

Listmonk's API does not offer an atomic compare-and-send operation. The bridge
rechecks the snapshot immediately before sending but cannot lock out a
simultaneous direct admin/API edit or detect a same-count audience membership
swap. Avoid editing templates, audiences or the draft between review and send.
Recipients are resolved by listmonk when sending, with its current suppression
and subscription states. Estimates are not an immutable recipient manifest.

If a send request times out, check the campaign in listmonk before taking any
further action. The token is already consumed and the campaign may be running;
never retry blindly or create a duplicate campaign.

## Validation

```sh
npm test
```

Tests use the real SDK client over in-memory and HTTP transports, a simulated
listmonk API, and signed JWTs. They cover tool discovery, draft-only creation,
audience restrictions, non-draft edits, single use/concurrent send, review
expiry/ownership, content/template/audience changes, disabled sends, scope
checks, signature/issuer/audience/expiry validation, and blocked origins.
They do not replace a live listmonk/SES/ChatGPT end-to-end test.
