import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

/**
 * โหมด access ไม่ต้องมี MCP_AUTH_TOKEN — env ชุดนี้ตรงกับที่ deploy จริง
 * (access + per_user · ไม่มี token กลาง · ไม่มีบัญชี Odoo ใน env · DCR ปิด)
 *
 * บั๊กเดิม: /mcp ที่ไม่มี token ได้ 500 แทน 401 เพราะ guard ของโหมด token
 * รันทุกโหมด client จึงหา OAuth metadata ไม่เจอ เทสต์เดิมใส่ token ทุกตัวจึงไม่เห็น
 */

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

/** env แบบ deploy จริง — ไม่มี MCP_AUTH_TOKEN, ODOO_USERNAME, ODOO_PASSWORD */
const deployEnv = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  CONSENT_MODE: "access",
  ODOO_AUTH_MODE: "per_user",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "aud-tag",
  ACCESS_ALLOWED_EMAILS: "owner@example.com",
  CONSENT_CSRF_SECRET: "csrf-secret",
  ODOO_URL: "https://odoo.example.com",
  ODOO_DB: "odoo-db",
  OAUTH_KV: fakeKv(),
  ...overrides,
});

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const ORIGIN = "https://mcp.example.com";

function rpc(method: string, params: Record<string, unknown>, auth?: string) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      ...(auth ? { authorization: auth } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** คำตอบ MCP มาเป็น SSE (`data: {...}`) หรือ JSON ตรง ๆ */
async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text).result;
}

/**
 * ออก access token ผ่าน OAuthProvider จริง โดยไม่ใช้ DCR (ปิดอยู่ใน env นี้)
 * — สร้าง client ด้วย helper แล้วแลก code ที่ /token ตามปกติ
 */
async function issueToken(env: Record<string, unknown>, props: Record<string, unknown>) {
  // provider แนบ helper ลง env ตอนส่งต่อให้ handler จึงแวะ /health ก่อน
  await worker.fetch(new Request(`${ORIGIN}/health`), env as never, ctx);
  const helpers = env.OAUTH_PROVIDER as {
    createClient: (c: unknown) => Promise<{ clientId: string }>;
    completeAuthorization: (o: unknown) => Promise<{ redirectTo: string }>;
  };
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const { clientId } = await helpers.createClient({
    redirectUris: [redirect],
    clientName: "test",
    tokenEndpointAuthMethod: "none",
  });

  const verifier = "v".repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
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
  expect(tokenRes.status).toBe(200);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("โหมด access ไม่มี MCP_AUTH_TOKEN (env แบบ deploy จริง)", () => {
  it("POST /mcp ไม่มี Authorization → 401 + WWW-Authenticate ชี้ resource metadata", async () => {
    const res = await worker.fetch(rpc("tools/list", {}), deployEnv() as never, ctx);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource`,
    );
  });

  it("Bearer มั่ว → 401 ไม่ใช่ 500", async () => {
    const res = await worker.fetch(
      rpc("tools/list", {}, "Bearer not-a-real-token"),
      deployEnv() as never,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("/.well-known/oauth-authorization-server → 200", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      deployEnv() as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize` });
  });

  it("/.well-known/oauth-protected-resource → 200", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
      deployEnv() as never,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("OAuth access token ที่ถูก → ถึง MCP handler · tools/list ได้ 13 tools", async () => {
    const env = deployEnv();
    const token = await issueToken(env, {
      user: "0123456789abcdef0123456789abcdef",
      odoo: { login: "alice@example.com", key: "alice-key", uid: 7 },
    });
    const res = await worker.fetch(rpc("tools/list", {}, `Bearer ${token}`), env as never, ctx);
    expect(res.status).toBe(200);
    const { tools } = (await rpcResult(res)) as { tools: { name: string }[] };
    expect(tools).toHaveLength(13);
    expect(tools.map((tool) => tool.name)).toContain("odoo_search_read");
  });
});

describe("static bearer — ไม่เปลี่ยนจากเดิม", () => {
  it("โหมด token ไม่มี MCP_AUTH_TOKEN → ยัง 500 server_misconfigured", async () => {
    const env = deployEnv({ CONSENT_MODE: undefined, ODOO_AUTH_MODE: undefined });
    const res = await worker.fetch(rpc("tools/list", {}), env as never, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "server_misconfigured" });
  });

  it("โหมด access + มี token → static bearer ยังผ่าน · per_user ได้ reconnect_required · audit user=bearer", async () => {
    const env = deployEnv({ MCP_AUTH_TOKEN: "static-token" });
    const odoo = vi.fn(async () => {
      throw new Error("must not call Odoo");
    });
    vi.stubGlobal("fetch", odoo);

    const listed = await worker.fetch(
      rpc("tools/list", {}, "Bearer static-token"),
      env as never,
      ctx,
    );
    expect(listed.status).toBe(200);
    expect(((await rpcResult(listed)) as { tools: unknown[] }).tools).toHaveLength(13);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const called = await worker.fetch(
      rpc(
        "tools/call",
        { name: "odoo_search_read", arguments: { model: "res.partner", domain: [] } },
        "Bearer static-token",
      ),
      env as never,
      ctx,
    );
    const result = (await rpcResult(called)) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reconnect_required");
    expect(odoo).not.toHaveBeenCalled();

    const audit = log.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.event === "mcp_call");
    expect(audit).toMatchObject({ user: "bearer", error_code: "reconnect_required" });
  });
});
