import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  assertModelAllowed,
  isModelAllowed,
  loadConfig,
  loadModelPolicy,
  pickServer,
  type Env,
  type ModelPolicy,
} from "./config";
import { OdooError, execute, version, type OdooConfig, type ServerConfig } from "./odoo";

/**
 * An Odoo search domain: a flat list whose terms are either a prefix operator
 * (`'&'`, `'|'`, `'!'`) or a `[field, operator, value]` triple.
 *
 * Every array level carries an `items` schema. Strict validators (notably
 * OpenAI's) reject a level without one — the bug fixed twice in the Python
 * original, in commits 9075284 and d8385af.
 */
const Domain = z
  .array(z.union([z.string(), z.array(z.any())]))
  .describe(
    "Search domain as a list of conditions. " +
      "Example: [['is_company', '=', true], ['country_id.code', '=', 'TH']]. " +
      "Prefix operators '&', '|' and '!' may appear as bare strings.",
  );

/**
 * Applied when `odoo_search_read` is called without a limit. Odoo itself
 * imposes none, so the unbounded read of a production model that follows would
 * exhaust the caller's context long before it failed on its own.
 */
const DEFAULT_LIMIT = 50;

const Model = z.string().describe("Odoo model name (e.g. 'res.partner', 'sale.order')");
const Ids = z.array(z.number().int()).describe("Record IDs");
const Server = z
  .string()
  .optional()
  .describe("Server name from config. Omitted, the default server is used.");

/** Match the Python original's `format_result`: pretty JSON, raw text otherwise. */
function formatResult(result: unknown) {
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? String(result);
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Surface failures as tool errors rather than transport errors, so the model
 * sees the message and can correct itself (bad model name, bad field, and so
 * on) instead of the request simply failing.
 */
function formatError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return formatResult(await fn());
  } catch (error) {
    return formatError(error);
  }
}

/** Compare two strings ignoring html markup and whitespace differences. */
function sameText(a: string, b: string): boolean {
  const strip = (value: string) =>
    value
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  return strip(a) === strip(b);
}

/**
 * Compare what was written against what Odoo stored.
 *
 * Odoo discards writes to readonly fields without erroring, so a successful
 * `create` or `write` proves nothing about whether the values landed. Reading
 * the written fields back is the only way to find out.
 *
 * Best-effort by design: it reports a field only when the comparison is
 * unambiguous, and stays silent rather than guessing. A false alarm here would
 * send an agent chasing a write that actually succeeded.
 */
function fieldsNotApplied(
  requested: Record<string, unknown>,
  stored: Record<string, unknown>,
): string[] {
  const dropped: string[] = [];

  for (const [field, want] of Object.entries(requested)) {
    if (!(field in stored)) continue;
    // x2many command lists and nested writes have no comparable stored form.
    if (want !== null && typeof want === "object") continue;

    let got = stored[field];
    // A many2one reads back as [id, display_name]; compare against the id.
    if (Array.isArray(got) && got.length === 2 && typeof got[0] === "number") {
      got = got[0];
    }
    // Odoo stores an empty string as false.
    if (want === "" && got === false) continue;
    if (got === want) continue;
    // An html field normalises plain text on the way in -- "ok" is stored as
    // "<p>ok</p>". That is the value being applied, not dropped.
    if (typeof want === "string" && typeof got === "string" && sameText(got, want)) {
      continue;
    }

    dropped.push(field);
  }

  return dropped;
}

/**
 * Read back the fields just written. Bounded, so that writing to a large set
 * does not turn one call into an unbounded read.
 */
async function readBack(
  key: string,
  server: ServerConfig,
  model: string,
  ids: number[],
  values: Record<string, unknown>,
): Promise<Record<string, unknown>[] | null> {
  const fields = Object.keys(values);
  if (fields.length === 0 || ids.length > DEFAULT_LIMIT) return null;
  return execute<Record<string, unknown>[]>(key, server, model, "read", [ids], { fields });
}

/**
 * Group-and-aggregate, across Odoo versions.
 *
 * `read_group` is gone in Odoo 19 -- calling it raises
 * `The method 'res.partner.read_group' does not exist` -- and
 * `formatted_read_group` replaces it. Most Odoo material still documents the
 * old name, so an agent left to call the method itself picks the one that no
 * longer exists. Try the current name, fall back to the old one.
 */
async function groupBy(
  key: string,
  server: ServerConfig,
  model: string,
  domain: unknown[],
  groupby: string[],
  aggregates: string[],
  kwargs: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await execute(key, server, model, "formatted_read_group", [domain, groupby, aggregates], kwargs);
  } catch (error) {
    const missing = error instanceof OdooError && /does not exist/.test(error.message);
    if (!missing) throw error;

    // Pre-17 signature: aggregates were plain field names, and `__count`
    // came back whether or not it was asked for.
    const fields = aggregates
      .filter((entry) => entry !== "__count")
      .map((entry) => entry.split(":")[0]);
    return execute(key, server, model, "read_group", [domain, fields, groupby], {
      ...kwargs,
      lazy: false,
    });
  }
}

export function registerTools(server: McpServer, env: Env): void {
  // Resolved lazily and memoised: a config error should surface as a tool
  // error the model can report, not as a failure to start the server.
  let cached: OdooConfig | undefined;
  const config = () => (cached ??= loadConfig(env));
  const target = (name?: string) => pickServer(config(), name);

  let cachedPolicy: ModelPolicy | undefined;
  const policy = () => (cachedPolicy ??= loadModelPolicy(env));

  /** Resolve the server and refuse the call if the model is out of scope. */
  const targetFor = (model: string, name?: string) => {
    assertModelAllowed(policy(), model);
    return target(name);
  };

  server.registerTool(
    "odoo_list_servers",
    {
      description: "List all configured Odoo servers.",
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => ({
        servers: Object.keys(config().servers),
        default_server: config().defaultServer,
      })),
  );

  server.registerTool(
    "odoo_search_read",
    {
      description:
        "Search and read records from an Odoo model. " +
        "Returns records matching the search domain with the specified fields.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        domain: Domain.default([]),
        fields: z
          .array(z.string())
          .optional()
          .describe("Field names to return. Omit for all fields."),
        offset: z.number().int().default(0).describe("Number of records to skip"),
        limit: z
          .number()
          .int()
          .default(DEFAULT_LIMIT)
          .describe(
            `Maximum number of records to return. Defaults to ${DEFAULT_LIMIT}; ` +
              "raise it deliberately, since an unbounded read of a large model " +
              "returns everything.",
          ),
        order: z.string().optional().describe("Sort order (e.g. 'name asc, id desc')"),
      }),
    },
    async ({ server: name, model, domain, fields, offset, limit, order }) =>
      run(() => {
        const kwargs: Record<string, unknown> = { offset };
        if (fields?.length) kwargs.fields = fields;
        if (limit !== undefined) kwargs.limit = limit;
        if (order !== undefined) kwargs.order = order;
        const { name: key, server } = targetFor(model, name);
        return execute(key, server, model, "search_read", [domain], kwargs);
      }),
  );

  server.registerTool(
    "odoo_search_count",
    {
      description: "Count records matching a search domain in an Odoo model.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        domain: Domain.default([]),
      }),
    },
    async ({ server: name, model, domain }) =>
      run(() => {
        const { name: key, server } = targetFor(model, name);
        return execute(key, server, model, "search_count", [domain]);
      }),
  );

  server.registerTool(
    "odoo_read",
    {
      description: "Read specific records by their IDs from an Odoo model.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        ids: Ids.describe("Record IDs to read"),
        fields: z.array(z.string()).optional().describe("Field names to return"),
      }),
    },
    async ({ server: name, model, ids, fields }) =>
      run(() => {
        const kwargs: Record<string, unknown> = {};
        if (fields?.length) kwargs.fields = fields;
        const { name: key, server } = targetFor(model, name);
        return execute(key, server, model, "read", [ids], kwargs);
      }),
  );

  server.registerTool(
    "odoo_create",
    {
      description:
        "Create a new record in an Odoo model. Returns the new id along with the " +
        "written fields read back, and lists any field Odoo did not store.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        values: z
          .record(z.string(), z.any())
          .describe(
            "Field values for the new record. " +
              "Example: {'name': 'New Partner', 'email': 'partner@example.com'}",
          ),
      }),
    },
    async ({ server: name, model, values }) =>
      run(async () => {
        const { name: key, server } = targetFor(model, name);
        const id = await execute<number>(key, server, model, "create", [values]);

        const records = await readBack(key, server, model, [id], values);
        const record = records?.[0];
        if (!record) return { id };

        const dropped = fieldsNotApplied(values, record);
        return {
          id,
          record,
          ...(dropped.length > 0
            ? {
                fields_not_applied: dropped,
                warning:
                  "Odoo did not store these fields. They are usually readonly or " +
                  "computed; check odoo_fields_get before writing them again.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "odoo_write",
    {
      description:
        "Update existing records in an Odoo model. Returns the written fields read " +
        "back, and lists any field Odoo did not store.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        ids: Ids.describe("Record IDs to update"),
        values: z.record(z.string(), z.any()).describe("Field values to update"),
      }),
    },
    async ({ server: name, model, ids, values }) =>
      run(async () => {
        const { name: key, server } = targetFor(model, name);
        const written = await execute<boolean>(key, server, model, "write", [ids, values]);

        const records = await readBack(key, server, model, ids, values);
        if (!records) return { written };

        const dropped = [
          ...new Set(records.flatMap((record) => fieldsNotApplied(values, record))),
        ];
        return {
          written,
          records,
          ...(dropped.length > 0
            ? {
                fields_not_applied: dropped,
                warning:
                  "Odoo did not store these fields on at least one record. They " +
                  "are usually readonly or computed; check odoo_fields_get.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "odoo_delete",
    {
      description: "Delete records from an Odoo model.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        ids: Ids.describe("Record IDs to delete"),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ server: name, model, ids }) =>
      run(() => {
        const { name: key, server } = targetFor(model, name);
        return execute(key, server, model, "unlink", [ids]);
      }),
  );

  server.registerTool(
    "odoo_execute",
    {
      description:
        "Execute any method on an Odoo model. " +
        "Use this for custom methods or operations not covered by the other tools.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        method: z.string().describe("Method name to call"),
        args: z.array(z.any()).default([]).describe("Positional arguments for the method"),
        kwargs: z
          .record(z.string(), z.any())
          .default({})
          .describe("Keyword arguments for the method"),
      }),
    },
    async ({ server: name, model, method, args, kwargs }) =>
      run(() => {
        const { name: key, server } = targetFor(model, name);
        return execute(key, server, model, method, args, kwargs);
      }),
  );

  server.registerTool(
    "odoo_fields_get",
    {
      description:
        "Get field definitions for an Odoo model. Useful for understanding model structure.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        attributes: z
          .array(z.string())
          .optional()
          .describe("Field attributes to return (e.g. ['string', 'type', 'required'])"),
      }),
    },
    async ({ server: name, model, attributes }) =>
      run(() => {
        const kwargs: Record<string, unknown> = {};
        if (attributes?.length) kwargs.attributes = attributes;
        const { name: key, server } = targetFor(model, name);
        return execute(key, server, model, "fields_get", [], kwargs);
      }),
  );

  server.registerTool(
    "odoo_read_group",
    {
      description:
        "Group records and aggregate over them — counts, sums, averages per group. " +
        "Far cheaper than reading every record and tallying them yourself.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        domain: Domain.default([]),
        groupby: z
          .array(z.string())
          .describe(
            "Fields to group by. A date field may carry a granularity, e.g. 'date_order:month'.",
          ),
        aggregates: z
          .array(z.string())
          .default(["__count"])
          .describe(
            "What to compute per group: '__count', or 'field:agg' such as " +
              "'amount_total:sum', 'amount_total:avg', 'id:max'.",
          ),
        limit: z.number().int().optional().describe("Maximum number of groups to return"),
        offset: z.number().int().default(0).describe("Number of groups to skip"),
        order: z.string().optional().describe("Sort order over the grouped result"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ server: name, model, domain, groupby, aggregates, limit, offset, order }) =>
      run(() => {
        const kwargs: Record<string, unknown> = { offset };
        if (limit !== undefined) kwargs.limit = limit;
        if (order !== undefined) kwargs.order = order;
        const { name: key, server } = targetFor(model, name);
        return groupBy(key, server, model, domain, groupby, aggregates, kwargs);
      }),
  );

  server.registerTool(
    "odoo_context",
    {
      description:
        "Who this server is connected as: user, company, timezone and language. " +
        "Read this before working with dates — Odoo stores datetimes in UTC.",
      inputSchema: z.object({ server: Server }),
      annotations: { readOnlyHint: true },
    },
    async ({ server: name }) =>
      run(async () => {
        // Deliberately not subject to the model policy: this reads only the
        // identity the connection already has, and blocking it would leave an
        // agent guessing at its own timezone.
        const { name: key, server } = target(name);
        const context = await execute<{ uid: number; tz?: string; lang?: string }>(
          key,
          server,
          "res.users",
          "context_get",
          [],
        );
        const [user] = await execute<Record<string, unknown>[]>(
          key,
          server,
          "res.users",
          "read",
          [[context.uid]],
          { fields: ["name", "login", "company_id", "company_ids"] },
        );

        return {
          server: key,
          uid: context.uid,
          user: user?.name ?? null,
          login: user?.login ?? null,
          company: user?.company_id ?? null,
          companies: user?.company_ids ?? [],
          timezone: context.tz ?? null,
          language: context.lang ?? null,
          note:
            "Datetimes stored in Odoo are UTC. Convert to the timezone above only " +
            "when presenting them to a person, and send UTC back.",
        };
      }),
  );

  server.registerTool(
    "odoo_get_models",
    {
      description:
        "List the models available on this server, with their technical and display names. " +
        "Use it to find the technical name before searching. Transient wizard models and " +
        "anything out of scope for this server are left out.",
      inputSchema: z.object({
        server: Server,
        filter: z
          .string()
          .optional()
          .describe("Only models whose technical or display name contains this text"),
        limit: z.number().int().default(200).describe("Maximum number of models to return"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ server: name, filter, limit }) =>
      run(async () => {
        // Reads ir.model regardless of the policy, then filters the result
        // through it — the point of the tool is to report what is in scope.
        const { name: key, server } = target(name);
        const domain: unknown[] = [
          ["transient", "=", false],
          ["abstract", "=", false],
        ];
        if (filter) {
          domain.unshift("|", ["model", "ilike", filter], ["name", "ilike", filter]);
        }

        const models = await execute<{ model: string; name: string }[]>(
          key,
          server,
          "ir.model",
          "search_read",
          [domain],
          { fields: ["model", "name"], order: "model", limit },
        );

        const inScope = models.filter((entry) => isModelAllowed(policy(), entry.model));
        return {
          count: inScope.length,
          hidden_by_policy: models.length - inScope.length,
          models: inScope.map((entry) => ({ model: entry.model, name: entry.name })),
        };
      }),
  );

  server.registerTool(
    "odoo_version",
    {
      description: "Get Odoo server version information.",
      inputSchema: z.object({ server: Server }),
    },
    async ({ server: name }) => run(() => version(target(name).server)),
  );
}
