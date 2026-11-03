import { afterEach, describe, expect, it, vi } from "vitest";
import { auditToolCalls, clientLabel, registerTools, type AuditCaller } from "../src/tools";

/**
 * audit ราย tools/call — หนึ่งบรรทัด JSON ต่อการเรียก ห้ามมี argument ผลลัพธ์
 * อีเมล หรือ token หลุดลง log
 */

type Callback = (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;

/** server ปลอมที่แค่จดว่าลงทะเบียน tool อะไรไว้ */
function fakeServer() {
  const tools = new Map<string, Callback>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: Callback) => {
      tools.set(name, cb);
    },
  };
  return { server: server as never, tools };
}

const caller = (overrides: Partial<AuditCaller> = {}): AuditCaller => ({
  user: "0123456789abcdef0123456789abcdef",
  clientId: async () => "client-1",
  clientLabel: "fwd:claude.ai",
  ...overrides,
});

const ODOO = {
  ODOO_URL: "https://odoo.example.com",
  ODOO_DB: "db",
  ODOO_USERNAME: "bot@example.com",
  ODOO_PASSWORD: "odoo-api-key-secret",
};

function auditLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('"mcp_call"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("audit line", () => {
  it("สำเร็จ → ฟิลด์ครบ ok=true", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { server, tools } = fakeServer();
    auditToolCalls(server, caller());
    registerTools(server, ODOO as never);

    await tools.get("odoo_list_servers")!({});

    const lines = auditLines(log);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(
      ["client_id", "client_label", "error_code", "event", "ms", "ok", "tool", "user"].sort(),
    );
    expect(lines[0]).toMatchObject({
      event: "mcp_call",
      user: "0123456789abcdef0123456789abcdef",
      client_id: "client-1",
      client_label: "fwd:claude.ai",
      tool: "odoo_list_servers",
      ok: true,
      error_code: null,
    });
    expect(typeof lines[0].ms).toBe("number");
  });

  it("tool error → ok=false และไม่มี argument / ผลลัพธ์ / ความลับใน log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down: secret-result-text");
      }),
    );
    const { server, tools } = fakeServer();
    auditToolCalls(server, caller({ user: "bearer", clientId: async () => null }));
    registerTools(server, ODOO as never);

    const result = await tools.get("odoo_search_read")!({
      model: "res.partner",
      domain: [["email", "=", "victim@example.com"]],
      fields: ["name"],
    });
    expect(result.isError).toBe(true);

    const lines = auditLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      user: "bearer",
      client_id: null,
      tool: "odoo_search_read",
      ok: false,
      error_code: "tool_error",
    });
    const raw = log.mock.calls.map((call) => String(call[0])).join("\n");
    for (const leaked of [
      "victim@example.com",
      "res.partner",
      "secret-result-text",
      "odoo-api-key-secret",
      "bot@example.com",
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });

  it("audit ที่อ่าน client_id ไม่ได้ ไม่ทำให้ tool พัง", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { server, tools } = fakeServer();
    auditToolCalls(
      server,
      caller({
        clientId: async () => {
          throw new Error("kv down");
        },
      }),
    );
    registerTools(server, ODOO as never);

    const result = await tools.get("odoo_list_servers")!({});
    expect(result.isError).toBeUndefined();
    expect(auditLines(log)[0]).toMatchObject({ client_id: null, ok: true });
  });
});

describe("clientLabel", () => {
  it("เลือก X-Forwarded-User-Agent ก่อน User-Agent", () => {
    expect(
      clientLabel(new Headers({ "x-forwarded-user-agent": "Claude-User", "user-agent": "Portal" })),
    ).toBe("fwd:Claude-User");
    expect(clientLabel(new Headers({ "user-agent": "curl/8" }))).toBe("ua:curl/8");
    expect(clientLabel(new Headers())).toBeNull();
  });

  it("ตัด 120 ตัว และแทนอักขระนอก ASCII พิมพ์ได้ด้วย ?", () => {
    const label = clientLabel(new Headers({ "user-agent": "a".repeat(200) }))!;
    expect(label).toBe(`ua:${"a".repeat(120)}`);
    const weird = { get: (name: string) => (name === "user-agent" ? "bot\tไทย\u0001" : null) };
    expect(clientLabel(weird)).toBe("ua:bot?????");
  });
});

// ---------------------------------------------------------------------------
// ผ่าน Worker จริง (src/index.ts) — header จริง, OAuthProvider จริง, KV ใน Map
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

function toolsCall(auth: string, headers: Record<string, string>, args: Record<string, unknown>) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "odoo_list_servers", arguments: args },
    }),
  });
}

describe("audit ผ่าน Worker จริง", () => {
  it("static bearer → user=bearer, client_id=null, client_label จาก User-Agent", async () => {
    const { default: worker } = await import("../src/index");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { ...ODOO, MCP_AUTH_TOKEN: "static-token" } as never;

    const res = await worker.fetch(
      toolsCall("static-token", { "user-agent": "curl/8.5" }, { marker: "arg-value-xyz" }),
      env,
      ctx,
    );
    await res.text();

    const lines = auditLines(log);
    expect(lines).toEqual([
      expect.objectContaining({
        event: "mcp_call",
        user: "bearer",
        client_id: null,
        client_label: "ua:curl/8.5",
        tool: "odoo_list_servers",
        ok: true,
      }),
    ]);
    const raw = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(raw).not.toContain("arg-value-xyz");
    expect(raw).not.toContain("static-token");
  });

  it("OAuth โหมด access → user=props.user, client_id ของ grant, client_label จาก X-Forwarded-User-Agent", async () => {
    const { default: worker } = await import("../src/index");
    const env = {
      ...ODOO,
      MCP_AUTH_TOKEN: "static-token",
      CONSENT_MODE: "access",
      MCP_DCR_ENABLED: "true",
      OAUTH_KV: fakeKv(),
    } as Record<string, unknown>;
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
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    // ข้ามหน้า consent (มีเทสต์ของมันเองแล้ว) — ออก grant ด้วย helper ของ provider ตรง ๆ
    // provider แนบ helper ลง env ตอนส่งต่อให้ handler จึงแวะ /health ก่อน
    await worker.fetch(new Request(`${ORIGIN}/health`), env as never, ctx);
    const userId = "0123456789abcdef0123456789abcdef";
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
      userId,
      metadata: {},
      scope: ["odoo"],
      props: { user: userId },
    });
    const code = new URL(redirectTo).searchParams.get("code")!;

    const tokenRes = await worker.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          client_id: clientId,
          code_verifier: verifier,
        }),
      }),
      env as never,
      ctx,
    );
    expect(tokenRes.status).toBe(200);
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await worker.fetch(
      toolsCall(
        accessToken,
        { "x-forwarded-user-agent": "Claude-User", "user-agent": "MCP-Portal" },
        { marker: "arg-value-xyz" },
      ),
      env as never,
      ctx,
    );
    await res.text();

    expect(auditLines(log)).toEqual([
      expect.objectContaining({
        user: userId,
        client_id: clientId,
        client_label: "fwd:Claude-User",
        tool: "odoo_list_servers",
        ok: true,
      }),
    ]);
    const raw = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(raw).not.toContain("arg-value-xyz");
    expect(raw).not.toContain(accessToken);
  });
});
