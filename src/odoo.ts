/**
 * Odoo JSON-RPC client built on `fetch`.
 *
 * The Python original used `xmlrpc.client`, which needs raw sockets and so
 * cannot run on Workers. Odoo exposes the same `execute_kw` surface over
 * JSON-RPC at `/jsonrpc`, which is plain HTTP and works here unchanged.
 */

export interface ServerConfig {
  url: string;
  db: string;
  username: string;
  password: string;
  /**
   * uid cache key when it must differ from the server name — per-user
   * credentials share a server name but not an account.
   */
  cacheKey?: string;
}

export interface OdooConfig {
  servers: Record<string, ServerConfig>;
  defaultServer: string;
}

/** Raised for errors reported by Odoo itself, as opposed to transport failures. */
export class OdooError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "OdooError";
  }
}

/**
 * Odoo refused the credentials themselves: `authenticate` returned no uid, or
 * a call raised `AccessDenied` (a revoked API key, a changed password). Not
 * raised for ACL or record-rule denials, which Odoo reports as `AccessError`.
 */
export class OdooAuthError extends OdooError {
  constructor(message: string, data?: unknown) {
    super(message, data);
    this.name = "OdooAuthError";
  }
}

/**
 * uid cache, keyed by server name (or `cacheKey`). Scoped to the isolate: a warm isolate skips
 * re-authenticating, a cold one pays one extra round trip. Never persisted, so
 * a rotated password can never authenticate off a stale entry.
 */
const uidCache = new Map<string, number>();

interface JsonRpcResponse<T> {
  result?: T;
  error?: {
    message?: string;
    data?: { message?: string; name?: string; debug?: string };
  };
}

async function jsonRpc<T>(
  baseUrl: string,
  service: "common" | "object",
  method: string,
  args: unknown[],
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: 1,
        params: { service, method, args },
      }),
    });
  } catch (cause) {
    throw new OdooError(
      `Cannot reach Odoo at ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!response.ok) {
    throw new OdooError(
      `Odoo returned HTTP ${response.status} ${response.statusText} for ${baseUrl}/jsonrpc`,
    );
  }

  let body: JsonRpcResponse<T>;
  try {
    body = (await response.json()) as JsonRpcResponse<T>;
  } catch {
    throw new OdooError(
      `Odoo returned a non-JSON response from ${baseUrl}/jsonrpc. ` +
        `Check that the URL points at an Odoo instance.`,
    );
  }

  if (body.error) {
    // Odoo nests the useful message under data; the outer one is usually
    // just "Odoo Server Error".
    const detail = body.error.data?.message ?? body.error.message ?? "Unknown error";
    const name = body.error.data?.name;
    const message = name ? `${name}: ${detail}` : detail;
    if (name === "odoo.exceptions.AccessDenied") throw new OdooAuthError(message, body.error.data);
    throw new OdooError(message, body.error.data);
  }

  return body.result as T;
}

/** Authenticate and return the uid, using the cached value when present. */
async function getUid(name: string, config: ServerConfig): Promise<number> {
  name = config.cacheKey ?? name;
  const cached = uidCache.get(name);
  if (cached !== undefined) return cached;

  const uid = await jsonRpc<number | false>(config.url, "common", "authenticate", [
    config.db,
    config.username,
    config.password,
    {},
  ]);

  if (!uid) {
    throw new OdooAuthError(
      `Authentication failed for user '${config.username}' on database '${config.db}'`,
    );
  }

  uidCache.set(name, uid);
  return uid;
}

/**
 * Call a method on an Odoo model.
 *
 * Retries once on failure with a fresh uid: a cached uid can outlive the
 * session it came from, and that failure is indistinguishable from a genuine
 * permission error until we retry.
 */
export async function execute<T = unknown>(
  name: string,
  config: ServerConfig,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const call = (uid: number) =>
    jsonRpc<T>(config.url, "object", "execute_kw", [
      config.db,
      uid,
      config.password,
      model,
      method,
      args,
      kwargs,
    ]);

  const uid = await getUid(name, config);
  try {
    return await call(uid);
  } catch (error) {
    const cacheKey = config.cacheKey ?? name;
    if (!uidCache.has(cacheKey)) throw error;
    uidCache.delete(cacheKey);
    return await call(await getUid(name, config));
  }
}

/**
 * Check a login and API key without caching anything. Returns the uid, or 0
 * when Odoo refuses them. Transport failures still throw.
 */
export async function authenticate(
  url: string,
  db: string,
  login: string,
  key: string,
): Promise<number> {
  try {
    const uid = await jsonRpc<number | false>(url, "common", "authenticate", [db, login, key, {}]);
    return typeof uid === "number" && uid > 0 ? uid : 0;
  } catch (error) {
    if (error instanceof OdooAuthError) return 0;
    throw error;
  }
}

/** Read the Odoo server version. Needs no authentication. */
export function version(config: ServerConfig): Promise<Record<string, unknown>> {
  return jsonRpc<Record<string, unknown>>(config.url, "common", "version", []);
}
