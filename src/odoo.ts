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
 * uid cache, keyed by server name. Scoped to the isolate: a warm isolate skips
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
    throw new OdooError(name ? `${name}: ${detail}` : detail, body.error.data);
  }

  return body.result as T;
}

/** Authenticate and return the uid, using the cached value when present. */
async function getUid(name: string, config: ServerConfig): Promise<number> {
  const cached = uidCache.get(name);
  if (cached !== undefined) return cached;

  const uid = await jsonRpc<number | false>(config.url, "common", "authenticate", [
    config.db,
    config.username,
    config.password,
    {},
  ]);

  if (!uid) {
    throw new OdooError(
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
    if (!uidCache.has(name)) throw error;
    uidCache.delete(name);
    return await call(await getUid(name, config));
  }
}

/** Read the Odoo server version. Needs no authentication. */
export function version(config: ServerConfig): Promise<Record<string, unknown>> {
  return jsonRpc<Record<string, unknown>>(config.url, "common", "version", []);
}
