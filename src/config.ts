import type { OdooConfig, ServerConfig } from "./odoo";

export interface Env {
  /** Shared secret required in the `Authorization: Bearer` header. */
  MCP_AUTH_TOKEN?: string;
  /**
   * Comma-separated hostnames whose browser `Origin` may call `/mcp`, or `*`
   * to accept any. Unset, only localhost and this Worker's own `workers.dev`
   * hostname are allowed; server-side clients send no Origin and are
   * unaffected either way.
   */
  ALLOWED_ORIGIN_HOSTNAMES?: string;
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
