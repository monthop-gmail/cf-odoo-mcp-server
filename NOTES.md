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
| `odoo_create` | returns the new id and the record as stored |
| `odoo_write` | returns the records as stored |
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

Creating a partner with `is_company: true` returns a new id and every outward
sign of success, while the stored record comes back with `is_company: false`.
Odoo neither errors nor warns; it discards the value.

`odoo_create` and `odoo_write` now read the written fields back and return
them, listing anything Odoo did not store under `fields_not_applied`:

```json
{
  "id": 12,
  "record": { "id": 12, "name": "Prod ReadBack", "is_company": false },
  "fields_not_applied": ["is_company"],
  "warning": "Odoo did not store these fields..."
}
```

Two things this does not do. The comparison is best-effort: it skips x2many
command lists and nested writes, which have no comparable stored form, and it
treats an html field's normalisation as applied — writing `"ok"` to `comment`
stores `"<p>ok</p>"`, which is the value landing, not being dropped. And the
read-back is skipped when writing to more than 50 records at once, so one call
does not become an unbounded read.

Worth knowing that the same field can behave differently between the two
calls. `is_company` is dropped by `create` and applied by `write`, reproducibly.
Whatever the reason, it is not something an agent can predict from the schema —
which is the whole argument for reading back rather than trusting the return
value.

### `odoo_read` on a missing id returns `[]`, not an error

Deleted, never existed, and invisible-to-this-user are indistinguishable.
Use `odoo_search_count` to tell "gone" from "not permitted".

### `odoo_search_read` returns 50 records unless told otherwise

Odoo imposes no limit of its own, so omitting `limit` used to return every
matching record. It now defaults to 50. Raise it deliberately when you need
more — `ir.model.fields` on a stock database holds over 4,500 rows, and an
unbounded read of a model that size exhausts a caller's context well before
Odoo would complain.

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

## Known limits

`odoo_execute` calls arbitrary methods with whatever access the configured Odoo
account has. That is the point of it, but it means the account's permissions are
the only thing standing between an agent and the rest of the database.

`fields_not_applied` reports fields it is confident about and stays silent
otherwise — a false alarm would send an agent chasing a write that succeeded.
Read the returned `record` when a value really matters.

## Compared with Odoo's built-in MCP server

Odoo 19 ships its own MCP server at `/mcp`, reachable with an API key of type
`mcp`. Everything below was measured against the same instance this project was
tested on (SaaS 19.4 Enterprise), so the two columns are directly comparable.

It identifies itself as `{"name": "Odoo", "version": "1.0.0"}` and negotiates
protocol `2025-11-25`.

### What it offers

Five tools, all read-only:

| Tool | Purpose |
| --- | --- |
| `ai_tool_mcp_retrieve_initial_context` | Timezone, user, and active company |
| `ai_tool_get_models` | The models an agent may touch |
| `ai_tool_get_fields` | Field definitions for a model |
| `ai_tool_search` | Search and read |
| `ai_tool_read_group` | Grouped aggregates |

There are no write tools. `ai_tool_create`, `ai_tool_write` and
`ai_tool_unlink` all return `The tool '...' doesn't exist`, the same answer an
invented tool name gets. (Measured with a read-only `mcp` key; Odoo also offers
a read-write scope, which may expose more.)

### Where it is better

**It knows it is talking to an agent.** `retrieve_initial_context` returns the
timezone, the current user, and the active company, along with a note that
stored datetimes are UTC and should only be converted for display. Nothing here
does that.

**It refuses technical models.** Asking for `ir.model.fields` returns
`The model ir.model.fields cannot be used by AI Agents`; the allowlist runs to
116 models, only one of them under `ir.`. This project exposes whatever the
configured account can reach.

**Nothing to run.** No deployment, no hosting, and no copy of the Odoo
credentials outside Odoo.

### Where it will trip an agent up

**`domain` is a string containing Python, not JSON.** The schema types it as
`string` while the description says "Use an empty list", and the contents are
evaluated as a Python literal:

```
[["is_company","=",true]]                    -> "should be 'string'"
"[\"|\",(\"is_company\",\"=\",true),...]"  -> malformed: Name(id='true')
"[\"|\",(\"is_company\",\"=\",True),...]"  -> works
```

JSON's `true` fails; Python's `True` is required. An agent reading
`"type": "string"` will reach for JSON first nearly every time. This project
takes domains as real arrays.

**Output is Python `repr`, not JSON.** `read_group` returns `"[(False, 2)]"`.

**`limit` defaults to all.** Per its schema, an omitted limit returns
everything — the same hazard this project now defaults to 50 to avoid. Not
confirmed on a populated database.

### Choosing

Read-only work is better served by the built-in server: less to run, fewer
places holding credentials, and a model allowlist this project lacks.

Use this one for what the built-in server does not do — writes, several Odoo
instances behind one endpoint, bounded reads, and domains that are ordinary
JSON. They coexist: the two key types are strictly scoped, so an `rpc` key gets
`401` from `/mcp` and an `mcp` key cannot authenticate over JSON-RPC. Connecting
a client to both is a reasonable setup.

## Deploying

Give a deploy about ten seconds before testing it. Requests immediately after
`wrangler deploy` can still land on an isolate running the previous version —
an unbounded `search_read` returned 4,517 records once for exactly that reason,
then 50 on every attempt after the rollout settled.
