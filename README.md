# cf-odoo-mcp-server

An [MCP](https://modelcontextprotocol.io) server for Odoo ERP, running on Cloudflare Workers.

Stateless HTTP transport — no Durable Objects, no container, no always-on process.
It fits comfortably in the Workers free tier.

Ported from [odoo-mcp-claude](https://github.com/monthop-gmail/odoo-mcp-claude), which
runs the same ten tools as a Python process over XML-RPC.

## Odoo 19 has two API key types — check which one you need

Odoo 19 issues API keys in two scopes, and they are not interchangeable:

| Key type | Speaks to | What you get |
| --- | --- | --- |
| **`mcp`** | Odoo's own `/mcp` endpoint | A built-in MCP server. Five tools, **read-only**. |
| **`rpc`** | `/jsonrpc` | Full ORM access. **This project uses this one.** |

The scoping is strict: an `rpc` key gets `401` from `/mcp`, and an `mcp` key
fails to authenticate over JSON-RPC.

**So you may not need this project at all.** If your agent only reads, Odoo's
built-in server needs no deployment, no hosting, and no copy of your Odoo
credentials anywhere else — point your client at `https://<your-odoo>/mcp` with
an `mcp` key and you are done. It also refuses technical models outright, a
guardrail this project does not have.

Reach for this project when you need what the built-in one does not offer:
creating, updating, or deleting records; several Odoo instances behind one
endpoint; or a bounded default on reads. The two can run side by side.

[NOTES.md](NOTES.md#compared-with-odoos-built-in-mcp-server) has the full
comparison, including a schema quirk in the built-in server that will trip an
agent up.

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
| `odoo_create` | `create`, then reads the written fields back |
| `odoo_write` | `write`, then reads the written fields back |
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
| `ALLOWED_ORIGIN_HOSTNAMES` | Optional. Comma-separated hostnames whose browser `Origin` may call `/mcp`, or `*`. Unset, only localhost and this Worker's own `workers.dev` hostname are accepted. Server-side clients send no `Origin` and are unaffected. |

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
