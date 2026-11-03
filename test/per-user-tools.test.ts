import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditToolCalls, registerTools, type AuditCaller } from "../src/tools";
import type { OdooCredential } from "../src/config";

/**
 * ODOO_AUTH_MODE=per_user ฝั่ง tool — ทุก call ไป Odoo ต้องใช้ credential ของ
 * ผู้เรียกจาก grant เท่านั้น ไม่มีการถอยไปใช้บัญชีใน env
 */

const ODOO_URL = "https://odoo.example.com";
const ENV_LOGIN = "env-admin@example.com";
const ENV_PASSWORD = "env-shared-password";

const PER_USER = {
  ODOO_AUTH_MODE: "per_user",
  CONSENT_MODE: "access",
  ODOO_URL,
  ODOO_DB: "odoo-db",
  // บัญชีกลางตั้งไว้ด้วย เพื่อพิสูจน์ว่าไม่ถูกใช้
  ODOO_USERNAME: ENV_LOGIN,
  ODOO_PASSWORD: ENV_PASSWORD,
};

// uid คนละชุดต่อเทสต์ — uid cache ของ src/odoo.ts อยู่ระดับ module
let nextUid = 100;
const users = new Map<string, { key: string; uid: number }>();

function newUser(login: string, key: string): OdooCredential {
  const uid = nextUid++;
  users.set(login, { key, uid });
  return { login, key, uid };
}

/** Odoo ปลอม: authenticate ตามตาราง users · execute_kw ต้องคู่ uid + key ถูก */
type Body = { params: { service: string; method: string; args: unknown[] } };
let bodies: Body[] = [];

function odooResponse(body: Body): Response {
  const { service, method, args } = body.params;
  if (service === "common" && method === "authenticate") {
    const [, login, key] = args as [string, string, string];
    const user = users.get(login);
    return Response.json({ result: user && user.key === key ? user.uid : false });
  }
  if (service === "object" && method === "execute_kw") {
    const [, uid, key, model, kwMethod] = args as [string, number, string, string, string];
    const owner = [...users.values()].find((user) => user.uid === uid);
    if (!owner || owner.key !== key) {
      return Response.json({
        error: {
          message: "Odoo Server Error",
          data: { name: "odoo.exceptions.AccessDenied", message: "Access Denied" },
        },
      });
    }
    if (model === "res.partner" && kwMethod === "search_read") {
      return Response.json({ result: [{ id: 1, name: "Partner" }] });
    }
    return Response.json({ result: [] });
  }
  if (service === "common" && method === "version") {
    return Response.json({ result: { server_version: "19.0" } });
  }
  throw new Error(`unexpected ${service}.${method}`);
}

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== `${ODOO_URL}/jsonrpc`) throw new Error(`unexpected fetch ${input}`);
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return odooResponse(body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Callback = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text: string }[];
}>;

function tools(env: Record<string, unknown>, odoo: OdooCredential | null, caller?: AuditCaller) {
  const map = new Map<string, Callback>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: Callback) => void map.set(name, cb),
  };
  if (caller) auditToolCalls(server as never, caller);
  registerTools(server as never, env as never, odoo);
  return map;
}

const searchPartners = { model: "res.partner", domain: [], fields: ["name"] };

/** ทุก login/password ที่ถูกส่งไป Odoo */
function sentCredentials() {
  return bodies.map(({ params: { method, args } }) =>
    method === "authenticate" ? { login: args[1], secret: args[2] } : { uid: args[1], secret: args[2] },
  );
}

describe("tool ใช้ credential ของผู้เรียก", () => {
  it("ส่ง login/key ของ user นั้นไป Odoo ไม่ใช่บัญชีใน env", async () => {
    const alice = newUser("alice@example.com", "alice-key-111");
    const result = await tools(PER_USER, alice).get("odoo_search_read")!(searchPartners);
    expect(result.isError).toBeUndefined();

    expect(sentCredentials()).toEqual([
      { login: "alice@example.com", secret: "alice-key-111" },
      { uid: alice.uid, secret: "alice-key-111" },
    ]);
    const raw = JSON.stringify(bodies);
    expect(raw).not.toContain(ENV_LOGIN);
    expect(raw).not.toContain(ENV_PASSWORD);
  });

  it("ผู้ใช้ A กับ B ได้ credential คนละชุด", async () => {
    const a = newUser("a@example.com", "key-of-a");
    const b = newUser("b@example.com", "key-of-b");
    await tools(PER_USER, a).get("odoo_search_read")!(searchPartners);
    const sentByA = sentCredentials();
    bodies = [];
    await tools(PER_USER, b).get("odoo_search_read")!(searchPartners);
    const sentByB = sentCredentials();

    expect(sentByA.every((entry) => entry.secret === "key-of-a")).toBe(true);
    expect(sentByB.every((entry) => entry.secret === "key-of-b")).toBe(true);
    expect(sentByB).toContainEqual({ uid: b.uid, secret: "key-of-b" });
  });

  it("odoo_context รายงาน server ชื่อจริง ไม่ใช่ cache key ภายใน", async () => {
    const carol = newUser("carol@example.com", "carol-key");
    const result = await tools(PER_USER, carol).get("odoo_context")!({});
    expect(result.content[0].text).not.toContain("per_user:");
  });
});

describe("ไม่มี fallback ไปบัญชีใน env", () => {
  for (const tool of ["odoo_search_read", "odoo_list_servers", "odoo_version"]) {
    it(`grant ไม่มี odoo → ${tool} ได้ reconnect_required และไม่มี request ไป Odoo`, async () => {
      const result = await tools(PER_USER, null).get(tool)!(
        tool === "odoo_search_read" ? searchPartners : {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("reconnect_required");
      expect(bodies).toHaveLength(0);
    });
  }

  it("Odoo ไม่รับ key แล้ว (เพิกถอน) → reconnect_required ไม่ลองบัญชี env", async () => {
    const dave = newUser("dave@example.com", "dave-key");
    const toolset = tools(PER_USER, dave);
    expect((await toolset.get("odoo_search_read")!(searchPartners)).isError).toBeUndefined();

    users.set("dave@example.com", { key: "rotated-key", uid: dave.uid });
    bodies = [];
    const result = await tools(PER_USER, dave).get("odoo_search_read")!(searchPartners);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reconnect_required");
    expect(result.content[0].text).not.toContain("dave-key");
    expect(JSON.stringify(bodies)).not.toContain(ENV_PASSWORD);
  });

  it("key ผิดตั้งแต่แรก (authenticate คืน false) → reconnect_required", async () => {
    const eve = { login: "eve@example.com", key: "never-valid", uid: nextUid++ };
    const result = await tools(PER_USER, eve).get("odoo_search_read")!(searchPartners);
    expect(result.content[0].text).toContain("reconnect_required");
    expect(result.content[0].text).not.toContain("eve@example.com");
  });

  it("ระบุ server อื่น → error และไม่เรียก Odoo", async () => {
    const env = {
      ...PER_USER,
      ODOO_SERVERS: JSON.stringify({
        default_server: "main",
        servers: {
          main: { url: ODOO_URL, db: "odoo-db" },
          other: { url: "https://other.example.com", db: "x", username: "u", password: "p" },
        },
      }),
    };
    const frank = newUser("frank@example.com", "frank-key");
    const result = await tools(env, frank).get("odoo_search_read")!({
      ...searchPartners,
      server: "other",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not available in per_user mode");
    expect(bodies).toHaveLength(0);

    const listed = await tools(env, frank).get("odoo_list_servers")!({});
    expect(JSON.parse(listed.content[0].text)).toEqual({ servers: ["main"], default_server: "main" });
  });
});

describe("audit โหมด per_user", () => {
  it("มี odoo_uid เป็นตัวเลข · error_code reconnect_required · ไม่มี login/key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const gina = newUser("gina@example.com", "gina-key");
    const caller = (odooUid: number | null): AuditCaller => ({
      user: "0123456789abcdef0123456789abcdef",
      clientId: async () => "client-1",
      clientLabel: "fwd:claude.ai",
      odooUid,
    });

    await tools(PER_USER, gina, caller(gina.uid)).get("odoo_search_read")!(searchPartners);
    await tools(PER_USER, null, caller(null)).get("odoo_search_read")!(searchPartners);

    const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(lines[0]).toMatchObject({ odoo_uid: gina.uid, ok: true, error_code: null });
    expect(lines[1]).toMatchObject({ odoo_uid: null, ok: false, error_code: "reconnect_required" });
    const raw = JSON.stringify(log.mock.calls);
    expect(raw).not.toContain("gina@example.com");
    expect(raw).not.toContain("gina-key");
  });
});

// ---------------------------------------------------------------------------
// ผ่าน Worker จริง (/mcp)
// ---------------------------------------------------------------------------

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string, options?: string | { type?: string }) => {
      const value = store.get(key);
      if (value === undefined) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [], list_complete: true }),
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const ORIGIN = "https://mcp.example.com";

function toolsCall(token: string, args: Record<string, unknown> = searchPartners) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "odoo_search_read", arguments: args },
    }),
  });
}

/** ออก access token ผ่าน OAuthProvider จริง ด้วย props ที่กำหนด (ข้ามหน้า consent) */
async function issueToken(env: Record<string, unknown>, props: Record<string, unknown>) {
  const { default: worker } = await import("../src/index");
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const registered = await worker.fetch(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "test",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
      }),
    }),
    env as never,
    ctx,
  );
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  await worker.fetch(new Request(`${ORIGIN}/health`), env as never, ctx);

  const verifier = "v".repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const helpers = env.OAUTH_PROVIDER as {
    completeAuthorization: (o: unknown) => Promise<{ redirectTo: string }>;
  };
  const { redirectTo } = await helpers.completeAuthorization({
    request: {
      responseType: "code",
      clientId,
      redirectUri: redirect,
      scope: ["odoo"],
      state: "s",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    },
    userId: String(props.user),
    metadata: {},
    scope: ["odoo"],
    props,
  });
  const tokenRes = await worker.fetch(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code")!,
        redirect_uri: redirect,
        client_id: clientId,
        code_verifier: verifier,
      }),
    }),
    env as never,
    ctx,
  );
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

describe("/mcp ผ่าน Worker จริง", () => {
  const workerEnv = (overrides: Record<string, unknown> = {}) => ({
    ...PER_USER,
    MCP_AUTH_TOKEN: "static-token",
    MCP_DCR_ENABLED: "true",
    OAUTH_KV: fakeKv(),
    ...overrides,
  });

  it("per_user + CONSENT_MODE=token → 503", async () => {
    const { default: worker } = await import("../src/index");
    const res = await worker.fetch(
      toolsCall("static-token"),
      workerEnv({ CONSENT_MODE: undefined }) as never,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(bodies).toHaveLength(0);
  });

  it("ODOO_AUTH_MODE ค่าอื่น → 503", async () => {
    const { default: worker } = await import("../src/index");
    const res = await worker.fetch(
      toolsCall("static-token"),
      workerEnv({ ODOO_AUTH_MODE: "shared_please" }) as never,
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it("grant ที่มี odoo → เรียก Odoo ด้วยบัญชีนั้น · audit มี odoo_uid · ไม่มี key ใน log/response", async () => {
    const { default: worker } = await import("../src/index");
    const env = workerEnv();
    const holly = newUser("holly@example.com", "holly-secret-key");
    const token = await issueToken(env, { user: "u-holly", odoo: holly });

    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const res = await worker.fetch(toolsCall(token), env as never, ctx);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("Partner");
    expect(body).not.toContain("holly-secret-key");
    expect(sentCredentials()).toContainEqual({ uid: holly.uid, secret: "holly-secret-key" });
    expect(JSON.stringify(bodies)).not.toContain(ENV_PASSWORD);

    const logged = spies.flatMap((spy) => spy.mock.calls).map((call) => String(call[0]));
    const audit = logged.map((line) => JSON.parse(line)).find((entry) => entry.event === "mcp_call");
    expect(audit).toMatchObject({ user: "u-holly", odoo_uid: holly.uid, ok: true });
    expect(logged.join("\n")).not.toContain("holly-secret-key");
    expect(logged.join("\n")).not.toContain("holly@example.com");
  });

  it("grant เก่าไม่มี odoo → reconnect_required และไม่มี request ไป Odoo ด้วยบัญชี env", async () => {
    const { default: worker } = await import("../src/index");
    const env = workerEnv();
    const token = await issueToken(env, { user: "u-old" });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const body = await (await worker.fetch(toolsCall(token), env as never, ctx)).text();
    expect(body).toContain("reconnect_required");
    expect(bodies).toHaveLength(0);
  });

  it("static bearer ในโหมด per_user → reconnect_required ไม่ใช้บัญชี env", async () => {
    const { default: worker } = await import("../src/index");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const body = await (
      await worker.fetch(toolsCall("static-token"), workerEnv() as never, ctx)
    ).text();
    expect(body).toContain("reconnect_required");
    expect(bodies).toHaveLength(0);
  });
});
