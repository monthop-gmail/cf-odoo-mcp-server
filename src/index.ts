import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools";
import type { Env } from "./config";

const MCP_ROUTE = "/mcp";

/**
 * The server factory receives no env, so each handler closes over the env it
 * was built with. Keying the cache on the env object itself keeps that closure
 * honest: a request carrying a different env — the runtime does not promise one
 * shared instance, and a stale closure silently loses every binding added since
 * — builds its own handler instead of reusing one bound to the wrong bindings.
 */
const handlers = new WeakMap<object, StatelessMcpHandler>();

function getHandler(env: Env): StatelessMcpHandler {
  let handler = handlers.get(env as object);
  if (!handler) {
    handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "odoo-mcp", version: "0.1.0" });
        registerTools(server, env);
        return server;
      },
      { route: MCP_ROUTE, ...originOptions(env) },
    );
    handlers.set(env as object, handler);
  }
  return handler;
}

/**
 * Browser clients are refused by default: the handler only trusts localhost and
 * this Worker's own `workers.dev` hostname. Returning nothing keeps that
 * default rather than widening it to `*` by accident.
 */
function originOptions(env: Env): { allowedOriginHostnames?: string[] | "*" } {
  const raw = env.ALLOWED_ORIGIN_HOSTNAMES?.trim();
  if (!raw) return {};
  if (raw === "*") return { allowedOriginHostnames: "*" };

  const hostnames = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return hostnames.length > 0 ? { allowedOriginHostnames: hostnames } : {};
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so that `timingSafeEqual` always sees equal
 * lengths — it throws otherwise, and the throw itself would leak the token
 * length.
 */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function unauthorized(detail: string): Response {
  return json({ error: "unauthorized", detail }, 401, {
    "www-authenticate": 'Bearer realm="odoo-mcp"',
  });
}

/** Returns a rejection Response, or null when the request may proceed. */
async function authorize(request: Request, env: Env): Promise<Response | null> {
  // Browsers never attach Authorization to a preflight; let the handler
  // answer CORS itself.
  if (request.method === "OPTIONS") return null;

  // Refuse to serve rather than fall open when the secret is unset — this
  // endpoint is public and fronts a live ERP.
  if (!env.MCP_AUTH_TOKEN) {
    return json(
      {
        error: "server_misconfigured",
        detail: "MCP_AUTH_TOKEN is not set. Run: wrangler secret put MCP_AUTH_TOKEN",
      },
      500,
    );
  }

  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return unauthorized("Missing 'Authorization: Bearer <token>' header");
  if (!(await secretsMatch(token, env.MCP_AUTH_TOKEN))) return unauthorized("Invalid token");
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return json({ status: "ok", service: "odoo-mcp" }, 200);
    }
    if (pathname !== MCP_ROUTE) {
      return json({ error: "not_found", detail: `MCP endpoint is ${MCP_ROUTE}` }, 404);
    }

    const rejection = await authorize(request, env);
    if (rejection) return rejection;

    return getHandler(env)(request, env, ctx);
  },
};
