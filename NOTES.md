# Field notes

What this server does and does not do well, from testing every tool against a
live Odoo instance (SaaS 19.4 Enterprise) through the deployed Worker.

These are operational caveats, not a changelog. Most of them are Odoo's
behaviour showing through rather than bugs in this server — which is exactly
why they are worth writing down, because an agent cannot infer them.

## Verified

All ten tools were exercised end to end against a real database:

| Tool | Result |
| --- | --- |
| `odoo_version` | `saas~19.4+e` |
| `odoo_list_servers` | resolves the configured default |
| `odoo_search_count` | correct count |
| `odoo_search_read` | fields, `limit`, `order`, and `'\|'` domains all work |
| `odoo_read` | returns the requested fields |
| `odoo_fields_get` | 120 fields on `res.partner` |
| `odoo_create` | returns the new id |
| `odoo_write` | returns `true`, change confirmed by reading back |
| `odoo_delete` | returns `true`, record gone, count restored |
| `odoo_execute` | `name_search` returned the expected pairs |

Non-ASCII text round-trips correctly — a Thai company name survived
create → read unchanged.

Failures come back as tool errors carrying Odoo's own exception, not as
transport errors, so a model can read and correct them:

```
Error: builtins.ValueError: Invalid field 'login_date' on 'res.partner'
Error: odoo.exceptions.UserError: Object res.nope doesn't exist
```

## Caveats for AI agents

### Odoo silently drops writes to readonly fields

The most consequential one. Creating a partner with `is_company: true`
returns a new id and every outward sign of success — but reading the record
back shows `is_company: false`. `is_company` is `readonly: true` on Odoo 19.4,
and Odoo neither errors nor warns; it discards the value.

An agent that trusts the return value will report work it did not do. Read
back after a write when the result matters, or check `odoo_fields_get` for
`readonly` before writing. (`company_type`, the usual way to set this, does
not exist on this version — it returns `Invalid field`.)

### `odoo_read` on a missing id returns `[]`, not an error

Deleted, never existed, and invisible-to-this-user are indistinguishable.
Use `odoo_search_count` to tell "gone" from "not permitted".

### `odoo_search_read` returns 50 records unless told otherwise

Odoo imposes no limit of its own, so omitting `limit` used to return every
matching record. It now defaults to 50. Raise it deliberately when you need
more — `ir.model.fields` on a stock database holds over 4,500 rows, and an
unbounded read of a model that size exhausts a caller's context well before
Odoo would complain.

### `odoo_execute` calls arbitrary methods

It is an escape hatch by design, and it inherits whatever the configured Odoo
account can do. Give the account only the access it needs — see the security
note in the README.

## Client compatibility

**Server-side connectors work.** Requests without an `Origin` header — every
server-side MCP client — pass through.

**Browser-based clients are refused unless configured.** A preflight from a
browser origin gets `403` by default — the handler trusts only localhost and
the endpoint's own `workers.dev` hostname. Set `ALLOWED_ORIGIN_HOSTNAMES` to a
comma-separated list of hostnames, or `*`, to widen it. Origins outside the
list still get `403`, and the bearer token is required either way.

**Both accept types are required.** A client must send
`Accept: application/json, text/event-stream`. Sending only the first, or
omitting the header, returns `406` per the streamable-HTTP spec.

**Protocol version.** `initialize` negotiates to `2025-11-25` even when the
client offers `2026-07-28`.

## Not done yet

Have `odoo_create` and `odoo_write` read the record back and return it, so
silently dropped fields become visible at the call site. This is the one that
would have caught the `is_company` surprise above without a second call.

## Deploying

Give a deploy about ten seconds before testing it. Requests immediately after
`wrangler deploy` can still land on an isolate running the previous version —
an unbounded `search_read` returned 4,517 records once for exactly that reason,
then 50 on every attempt after the rollout settled.
