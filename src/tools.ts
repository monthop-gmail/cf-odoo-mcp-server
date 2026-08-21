import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadConfig, pickServer, type Env } from "./config";
import { execute, version, type OdooConfig } from "./odoo";

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

export function registerTools(server: McpServer, env: Env): void {
  // Resolved lazily and memoised: a config error should surface as a tool
  // error the model can report, not as a failure to start the server.
  let cached: OdooConfig | undefined;
  const config = () => (cached ??= loadConfig(env));
  const target = (name?: string) => pickServer(config(), name);

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
        limit: z.number().int().optional().describe("Maximum number of records to return"),
        order: z.string().optional().describe("Sort order (e.g. 'name asc, id desc')"),
      }),
    },
    async ({ server: name, model, domain, fields, offset, limit, order }) =>
      run(() => {
        const kwargs: Record<string, unknown> = { offset };
        if (fields?.length) kwargs.fields = fields;
        if (limit !== undefined) kwargs.limit = limit;
        if (order !== undefined) kwargs.order = order;
        const { name: key, server } = target(name);
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
        const { name: key, server } = target(name);
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
        const { name: key, server } = target(name);
        return execute(key, server, model, "read", [ids], kwargs);
      }),
  );

  server.registerTool(
    "odoo_create",
    {
      description: "Create a new record in an Odoo model.",
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
      run(() => {
        const { name: key, server } = target(name);
        return execute(key, server, model, "create", [values]);
      }),
  );

  server.registerTool(
    "odoo_write",
    {
      description: "Update existing records in an Odoo model.",
      inputSchema: z.object({
        server: Server,
        model: Model,
        ids: Ids.describe("Record IDs to update"),
        values: z.record(z.string(), z.any()).describe("Field values to update"),
      }),
    },
    async ({ server: name, model, ids, values }) =>
      run(() => {
        const { name: key, server } = target(name);
        return execute(key, server, model, "write", [ids, values]);
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
        const { name: key, server } = target(name);
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
        const { name: key, server } = target(name);
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
        const { name: key, server } = target(name);
        return execute(key, server, model, "fields_get", [], kwargs);
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
