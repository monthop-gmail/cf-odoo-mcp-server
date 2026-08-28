import type { OdooConfig, ServerConfig } from "./odoo";

export interface Env {
  /** จำกัดอัตราของทุก request ที่เข้า /mcp — ไม่มีตอนรัน wrangler dev บางโหมด */
  MCP_LIMIT?: RateLimit;
  /** จำกัดอัตราการส่งฟอร์มหน้า consent ซึ่งเป็นจุดที่เดา token ได้ */
  AUTH_LIMIT?: RateLimit;
  /** Shared secret required in the `Authorization: Bearer` header. */
  MCP_AUTH_TOKEN?: string;
  /**
   * Comma-separated hostnames whose browser `Origin` may call `/mcp`, or `*`
   * to accept any. Unset, only localhost and this Worker's own `workers.dev`
   * hostname are allowed; server-side clients send no Origin and are
   * unaffected either way.
   */
  ALLOWED_ORIGIN_HOSTNAMES?: string;
  /**
   * Comma-separated model patterns the tools refuse to touch, e.g.
   * `ir.*,res.users`. A trailing `*` matches by prefix. Unset, nothing is
   * blocked.
   */
  BLOCKED_MODELS?: string;
  /**
   * Comma-separated model patterns the tools are restricted to. When set, a
   * model must match one of these as well as avoid `BLOCKED_MODELS`.
   */
  ALLOWED_MODELS?: string;
  /** JSON: `{"default_server":"prod","servers":{"prod":{url,db,username,password}}}` */
  ODOO_SERVERS?: string;
  /** Single-server fallback, mirroring the Python original's env vars. */
  ODOO_URL?: string;
  ODOO_DB?: string;
  ODOO_USERNAME?: string;
  ODOO_PASSWORD?: string;
}

export class ConfigError extends Error {}

const REQUIRED: (keyof ServerConfig)[] = ["url", "db", "username", "password"];

function validate(name: string, raw: unknown): ServerConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`ODOO_SERVERS: server '${name}' must be an object`);
  }
  const config = raw as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (typeof config[key] !== "string" || config[key] === "") {
      throw new ConfigError(`ODOO_SERVERS: server '${name}' is missing '${key}'`);
    }
  }
  return {
    // Trailing slashes would produce `https://host//jsonrpc`, which some
    // reverse proxies in front of Odoo reject.
    url: (config.url as string).replace(/\/+$/, ""),
    db: config.db as string,
    username: config.username as string,
    password: config.password as string,
  };
}

export function loadConfig(env: Env): OdooConfig {
  if (env.ODOO_SERVERS) {
    let parsed: { servers?: Record<string, unknown>; default_server?: unknown };
    try {
      parsed = JSON.parse(env.ODOO_SERVERS);
    } catch (cause) {
      throw new ConfigError(
        `ODOO_SERVERS is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const entries = Object.entries(parsed.servers ?? {});
    if (entries.length === 0) {
      throw new ConfigError("ODOO_SERVERS contains no servers");
    }

    const servers: Record<string, ServerConfig> = {};
    for (const [name, raw] of entries) servers[name] = validate(name, raw);

    const requested = parsed.default_server;
    if (requested !== undefined && typeof requested !== "string") {
      throw new ConfigError("ODOO_SERVERS: 'default_server' must be a string");
    }
    if (requested !== undefined && !(requested in servers)) {
      throw new ConfigError(
        `ODOO_SERVERS: default_server '${requested}' is not one of: ${Object.keys(servers).join(", ")}`,
      );
    }

    return { servers, defaultServer: requested ?? entries[0][0] };
  }

  const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = env;
  if (ODOO_URL && ODOO_DB && ODOO_USERNAME && ODOO_PASSWORD) {
    return {
      servers: {
        default: validate("default", {
          url: ODOO_URL,
          db: ODOO_DB,
          username: ODOO_USERNAME,
          password: ODOO_PASSWORD,
        }),
      },
      defaultServer: "default",
    };
  }

  throw new ConfigError(
    "No Odoo server configured. Set ODOO_SERVERS, or all of " +
      "ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_PASSWORD.",
  );
}

/** Resolve a tool's optional `server` argument to a named config. */
export function pickServer(
  config: OdooConfig,
  name?: string,
): { name: string; server: ServerConfig } {
  const resolved = name ?? config.defaultServer;
  const server = config.servers[resolved];
  if (!server) {
    throw new ConfigError(
      `Unknown server '${resolved}'. Available: ${Object.keys(config.servers).join(", ")}`,
    );
  }
  return { name: resolved, server };
}

/**
 * Which models the tools may touch.
 *
 * The configured Odoo account's permissions are the real boundary; this is a
 * second, coarser one that an operator can set without touching Odoo. Useful
 * for keeping an agent out of `ir.*` and `res.users` when the account it runs
 * as is more privileged than the work requires.
 */
export interface ModelPolicy {
  /** Empty means every model is in scope. */
  allow: string[];
  block: string[];
}

function parsePatterns(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadModelPolicy(env: Env): ModelPolicy {
  return {
    allow: parsePatterns(env.ALLOWED_MODELS),
    block: parsePatterns(env.BLOCKED_MODELS),
  };
}

/** `ir.*` matches by prefix; anything else must match exactly. */
function matches(pattern: string, model: string): boolean {
  return pattern.endsWith("*")
    ? model.startsWith(pattern.slice(0, -1))
    : pattern === model;
}

export function isModelAllowed(policy: ModelPolicy, model: string): boolean {
  if (policy.block.some((pattern) => matches(pattern, model))) return false;
  if (policy.allow.length === 0) return true;
  return policy.allow.some((pattern) => matches(pattern, model));
}

/** Throws when a model is out of scope, naming the setting that put it there. */
export function assertModelAllowed(policy: ModelPolicy, model: string): void {
  if (isModelAllowed(policy, model)) return;
  const reason = policy.block.some((pattern) => matches(pattern, model))
    ? "BLOCKED_MODELS"
    : "ALLOWED_MODELS";
  throw new ConfigError(
    `Model '${model}' is out of scope for this server (${reason}).`,
  );
}
