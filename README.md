# cf-odoo-mcp-server

An [MCP](https://modelcontextprotocol.io) server for Odoo ERP, running on Cloudflare Workers.

Stateless HTTP transport — no Durable Objects, no container, no always-on process.
It fits comfortably in the Workers free tier.

Ported from [odoo-mcp-claude](https://github.com/monthop-gmail/odoo-mcp-claude), which
runs the same ten tools as a Python process over XML-RPC.

## Why JSON-RPC instead of XML-RPC

Python's `xmlrpc.client` needs raw sockets, which the Workers runtime does not
provide. Odoo exposes the same `execute_kw` surface over JSON-RPC at `/jsonrpc`,
which is ordinary HTTP and works under `fetch` unchanged.

## Requirements

Odoo must be reachable from the public internet over HTTPS. A Worker cannot
reach a LAN address; put [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
in front of it if yours is not already public.

## Tools

| Tool | Odoo method |
| --- | --- |
| `odoo_list_servers` | — (lists configured servers) |
| `odoo_search_read` | `search_read` |
| `odoo_search_count` | `search_count` |
| `odoo_read` | `read` |
| `odoo_create` | `create` |
| `odoo_write` | `write` |
| `odoo_delete` | `unlink` |
| `odoo_execute` | any method |
| `odoo_fields_get` | `fields_get` |
| `odoo_version` | `common.version` |

## Configuration

| Variable | Purpose |
| --- | --- |
| `MCP_AUTH_TOKEN` | Required. Bearer token callers must present. |
| `ODOO_SERVERS` | JSON, for one or more servers. Takes precedence. |
| `ODOO_URL` `ODOO_DB` `ODOO_USERNAME` `ODOO_PASSWORD` | Single-server fallback. |

Prefer an Odoo **API key** over an account password, and give the account only
the access the tools actually need — `odoo_delete` and `odoo_write` reach whatever
that account can reach.

`ODOO_SERVERS` looks like:

```json
{
  "default_server": "prod",
  "servers": {
    "prod": { "url": "https://odoo.example.com", "db": "mydb", "username": "bot@example.com", "password": "api-key" }
  }
}
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill it in
npm run dev
```

`.dev.vars` is gitignored. Never commit credentials.

## Deploy

```bash
npx wrangler login
npx wrangler deploy

npx wrangler secret put MCP_AUTH_TOKEN     # openssl rand -hex 32
npx wrangler secret put ODOO_URL
npx wrangler secret put ODOO_DB
npx wrangler secret put ODOO_USERNAME
npx wrangler secret put ODOO_PASSWORD
```

Secrets are encrypted at rest and never appear in `wrangler.jsonc`.

## Connecting a client

```json
{
  "mcpServers": {
    "odoo": {
      "type": "streamable-http",
      "url": "https://cf-odoo-mcp-server.<subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

`GET /health` is unauthenticated and returns `{"status":"ok"}`.

## Security

The endpoint is public, so every request to `/mcp` must carry the bearer token;
it is compared in constant time. If `MCP_AUTH_TOKEN` is unset the Worker returns
500 rather than falling open.

A shared token is appropriate for a personal or internal server. For per-user
identity, put the [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
in front instead.

## Field notes

[NOTES.md](NOTES.md) records what was verified against a live Odoo instance and
the caveats that matter when an AI agent drives these tools — notably that Odoo
silently discards writes to readonly fields.

## License

MIT
