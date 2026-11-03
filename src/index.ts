import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { auditToolCalls, clientLabel, registerTools, type AuditCaller } from "./tools";
import { checkClientRegistration, oauthDefaultHandler, type OAuthEnv } from "./oauth";
import { json, secretsMatch } from "./http";
import { overLimit } from "./rate-limit";
import { consentMode, odooAuthConfigError, type Env, type OdooCredential } from "./config";

const MCP_ROUTE = "/mcp";

/**
 * Built per request because the audit context — who is calling — differs per
 * request while the server factory receives neither env nor request. The
 * factory already builds a fresh `McpServer` for every request, so this only
 * adds the thin wrapper around it.
 */
function buildHandler(
  env: Env,
  caller: AuditCaller,
  odoo: OdooCredential | null,
): StatelessMcpHandler {
  return createMcpHandler(
    () => {
      const server = new McpServer({ name: "odoo-mcp", version: "0.1.0" });
      auditToolCalls(server, caller);
      registerTools(server, env, odoo);
      return server;
    },
    { route: MCP_ROUTE, ...originOptions(env) },
  );
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
 * The MCP endpoint reached through OAuth. The provider has already checked the
 * access token and put the grant's props on `ctx`: grants issued in access mode
 * carry `{user}`, older token-mode grants carry `{}` and so read as "shared".
 */
const mcpApiHandler = {
  fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: { user?: unknown; odoo?: unknown } })
      .props;
    const odoo = odooCredential(props?.odoo);
    const caller: AuditCaller = {
      user: typeof props?.user === "string" ? props.user : "shared",
      clientId: async () => {
        const token = bearerToken(request);
        if (!token) return null;
        return (await env.OAUTH_PROVIDER.unwrapToken(token))?.grant.clientId ?? null;
      },
      clientLabel: clientLabel(request.headers),
      odooUid: odoo?.uid ?? null,
    };
    return buildHandler(env, caller, odoo)(request, env, ctx);
  },
};

/** props.odoo ของ grant โหมด per_user — รูปไม่ครบถือว่าไม่มี (tool จะขอให้เชื่อมใหม่) */
function odooCredential(raw: unknown): OdooCredential | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { login, key, uid } = raw as Record<string, unknown>;
  if (typeof login !== "string" || !login) return null;
  if (typeof key !== "string" || !key) return null;
  if (typeof uid !== "number" || !(uid > 0)) return null;
  return { login, key, uid };
}

/** The MCP endpoint reached with the shared static bearer. */
function serveStaticBearer(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const caller: AuditCaller = {
    user: "bearer",
    clientId: async () => null,
    clientLabel: clientLabel(request.headers),
    odooUid: null,
  };
  // static bearer ไม่มีตัวตนผู้ใช้ — โหมด per_user จึงได้ reconnect_required ทุก tool
  return buildHandler(env, caller, null)(request, env, ctx);
}

function bearerToken(request: Request): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

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
  const token = bearerToken(request);
  if (!token) return false;
  return secretsMatch(token, env.MCP_AUTH_TOKEN);
}

/**
 * Keyed on env because the DCR policy reads it and the registration callback
 * receives no env of its own.
 */
const providers = new WeakMap<object, OAuthProvider<OAuthEnv>>();

function getProvider(env: OAuthEnv): OAuthProvider<OAuthEnv> {
  let provider = providers.get(env as object);
  if (provider) return provider;
  provider = new OAuthProvider<OAuthEnv>({
    apiRoute: MCP_ROUTE,
    apiHandler: mcpApiHandler,
    defaultHandler: oauthDefaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // Claude registers itself on first connection (RFC 7591).
    clientRegistrationEndpoint: "/register",
    clientRegistrationCallback: (options) => checkClientRegistration(env, options),
  });
  providers.set(env as object, provider);
  return provider;
}

export default {
  async fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === MCP_ROUTE) {
      // ก่อนแตะ auth หรือ Odoo — จำกัดอัตราไว้ก่อน ทั้ง request ที่ผ่านและไม่ผ่าน
      // นับรวมกัน เพราะทั้งการเดา token และ agent ที่วนลูปต่างก็คือ "ยิงถี่เกินไป"
      const limited = await overLimit(
        env.MCP_LIMIT,
        request,
        "Too many requests to /mcp. Slow down and retry in a minute.",
      );
      if (limited) return limited;

      const misconfigured = odooAuthConfigError(env);
      if (misconfigured) {
        return json({ error: "server_misconfigured", detail: misconfigured }, 503);
      }

      // Token mode: refuse to serve rather than fall open when the secret is
      // unset. Without it no OAuth grant can be issued either, since the
      // consent screen needs it — this just fails earlier and more clearly.
      //
      // Access mode issues grants through Cloudflare Access and needs no shared
      // secret. Unset, there is simply no static bearer and the request goes
      // to the provider, which answers 401 + `WWW-Authenticate` so the client
      // can find the OAuth metadata. Set, the static bearer still works.
      if (!env.MCP_AUTH_TOKEN && consentMode(env) === "token") {
        return json(
          {
            error: "server_misconfigured",
            detail: "MCP_AUTH_TOKEN is not set. Run: wrangler secret put MCP_AUTH_TOKEN",
          },
          500,
        );
      }
      if (await hasStaticBearer(request, env)) {
        return serveStaticBearer(request, env, ctx);
      }
    }

    // Everything else — the OAuth endpoints, discovery metadata, the consent
    // screen, /health, and /mcp without a static bearer — belongs to the
    // provider. It answers an unauthenticated /mcp with the 401 and
    // `WWW-Authenticate` header Claude needs to find the metadata.
    return getProvider(env).fetch(request, env, ctx);
  },
};
