import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools";
import { oauthDefaultHandler, type OAuthEnv } from "./oauth";
import { json, secretsMatch } from "./http";
import type { Env } from "./config";

const MCP_ROUTE = "/mcp";

/**
 * The server factory receives no env, so each handler closes over the env it
 * was built with. Keying the cache on the env object itself keeps that closure
 * honest: a request carrying a different env — the runtime does not promise one
 * shared instance, and the OAuth provider passes its own augmented copy — builds
 * its own handler instead of reusing one bound to the wrong bindings.
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

/** The MCP endpoint itself, reached either through OAuth or a static bearer. */
const mcpApiHandler = {
  fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response> {
    return getHandler(env)(request, env, ctx);
  },
};

/**
 * Two ways in, because the clients differ in what they can send.
 *
 * Claude Code, Codex and anything driven by curl can attach a fixed
 * `Authorization` header, so they use the shared token directly. Claude's web
 * connector cannot set headers outside a beta, so it goes through OAuth. Both
 * end at the same handler; dropping the static path would break the clients
 * already using it.
 */
async function hasStaticBearer(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_AUTH_TOKEN) return false;
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return false;
  return secretsMatch(token, env.MCP_AUTH_TOKEN);
}

let provider: OAuthProvider<OAuthEnv> | undefined;

function getProvider(): OAuthProvider<OAuthEnv> {
  return (provider ??= new OAuthProvider<OAuthEnv>({
    apiRoute: MCP_ROUTE,
    apiHandler: mcpApiHandler,
    defaultHandler: oauthDefaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // Claude registers itself on first connection (RFC 7591).
    clientRegistrationEndpoint: "/register",
  }));
}

export default {
  async fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === MCP_ROUTE) {
      // Refuse to serve rather than fall open when the secret is unset. Without
      // it no OAuth grant can be issued either, since the consent screen needs
      // it — this just fails earlier and more clearly.
      if (!env.MCP_AUTH_TOKEN) {
        return json(
          {
            error: "server_misconfigured",
            detail: "MCP_AUTH_TOKEN is not set. Run: wrangler secret put MCP_AUTH_TOKEN",
          },
          500,
        );
      }
      if (await hasStaticBearer(request, env)) {
        return mcpApiHandler.fetch(request, env, ctx);
      }
    }

    // Everything else — the OAuth endpoints, discovery metadata, the consent
    // screen, /health, and /mcp without a static bearer — belongs to the
    // provider. It answers an unauthenticated /mcp with the 401 and
    // `WWW-Authenticate` header Claude needs to find the metadata.
    return getProvider().fetch(request, env, ctx);
  },
};
