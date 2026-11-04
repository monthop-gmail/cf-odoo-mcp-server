import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetAccessCache } from "../src/access";

/**
 * วงจรชีวิตของ Odoo API key ในโหมด access + per_user — ผ่าน Worker จริงทั้งสาย
 * (JWT ของ Access → หน้า consent → POST login/key → /token → /mcp)
 *
 * env ตรงกับที่ deploy จริง: ไม่มี MCP_AUTH_TOKEN ไม่มีบัญชี Odoo กลาง DCR ปิด
 */

const ORIGIN = "https://mcp.example.com";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag";
const ODOO_URL = "https://odoo.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const LOGIN = "alice@example.com";
const KEY_OLD = "alice-old-key-0001";
const KEY_NEW = "alice-new-key-0002";
const UID = 77;

const AUDIT_FIELDS = [
  "client_id",
  "client_label",
  "error_code",
  "event",
  "ms",
  "odoo_uid",
  "ok",
  "tool",
  "user",
];

// ---------------------------------------------------------------------------
// Access JWT
// ---------------------------------------------------------------------------

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");

async function accessJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64url(
    JSON.stringify({
      iss: `https://${TEAM}`,
      aud: [AUD],
      sub: "alice-sub",
      email: "owner@example.com",
      iat: now,
      exp: now + 600,
    }),
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Odoo ปลอม + fetch
// ---------------------------------------------------------------------------

/** key ที่ Odoo ยังรับอยู่ของแต่ละ login — เอาออกจาก set = เพิกถอน */
const validKeys = new Map<string, Set<string>>();
let odooDown = false;
let odooBodies: { params: { service: string; method: string; args: unknown[] } }[] = [];

function odooAnswer(body: (typeof odooBodies)[number]): Response {
  const { service, method, args } = body.params;
  if (service === "common" && method === "authenticate") {
    const [, login, key] = args as [string, string, string];
    return Response.json({ result: validKeys.get(login)?.has(key) ? UID : false });
  }
  if (service === "object" && method === "execute_kw") {
    const [, uid, key] = args as [string, number, string];
    if (uid !== UID || !validKeys.get(LOGIN)?.has(key)) {
      return Response.json({
        error: {
          message: "Odoo Server Error",
          data: { name: "odoo.exceptions.AccessDenied", message: "Access Denied" },
        },
      });
    }
    return Response.json({ result: [{ id: 1, name: "Partner A" }] });
  }
  throw new Error(`unexpected ${service}.${method}`);
}

beforeEach(() => {
  resetAccessCache();
  validKeys.clear();
  odooDown = false;
  odooBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [{ ...publicJwk, kid: "k1", alg: "RS256" }] });
      }
      if (url === `${ODOO_URL}/jsonrpc`) {
        if (odooDown) throw new TypeError("fetch failed: ECONNREFUSED");
        const body = JSON.parse(String(init?.body));
        odooBodies.push(body);
        return odooAnswer(body);
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Worker
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

/** env แบบ deploy จริง — ไม่มี MCP_AUTH_TOKEN, ODOO_USERNAME, ODOO_PASSWORD, MCP_DCR_ENABLED */
function deployEnv(): Record<string, unknown> {
  return {
    CONSENT_MODE: "access",
    ODOO_AUTH_MODE: "per_user",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_ALLOWED_EMAILS: "owner@example.com",
    CONSENT_CSRF_SECRET: "csrf-secret",
    ODOO_URL,
    ODOO_DB: "odoo-db",
    OAUTH_KV: fakeKv(),
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const call = (request: Request, env: Record<string, unknown>) =>
  worker.fetch(request, env as never, ctx);

/** สร้าง client ด้วย helper (DCR ปิด) — แวะ /health ก่อนให้ provider แนบ helper ลง env */
async function createClient(env: Record<string, unknown>): Promise<string> {
  await call(new Request(`${ORIGIN}/health`), env);
  const helpers = env.OAUTH_PROVIDER as {
    createClient: (c: unknown) => Promise<{ clientId: string }>;
  };
  const { clientId } = await helpers.createClient({
    redirectUris: [REDIRECT],
    clientName: "Claude",
    tokenEndpointAuthMethod: "none",
  });
  return clientId;
}

/** consent จริงทั้งสาย → access token · คืน response ทุกตัวไว้ตรวจว่าไม่มี key */
async function connect(env: Record<string, unknown>, clientId: string, key: string) {
  const responses: string[] = [];
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const authorize = new URL(`${ORIGIN}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    authorize.searchParams.set(name, value);
  }

  const assertion = await accessJwt();
  const page = await call(
    new Request(authorize, { headers: { "cf-access-jwt-assertion": assertion } }),
    env,
  );
  expect(page.status).toBe(200);
  const pageHtml = await page.text();
  responses.push(pageHtml);
  const csrf = pageHtml.match(/name="csrf" value="([^"]+)"/)![1];

  const approved = await call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": assertion },
      body: new URLSearchParams({ csrf, decision: "approve", odoo_login: LOGIN, odoo_key: key }),
    }),
    env,
  );
  expect(approved.status).toBe(200);
  const approvedHtml = await approved.text();
  responses.push(approvedHtml);
  const redirectTo = approvedHtml.match(/href="([^"]+)"/)![1].replace(/&amp;/g, "&");

  const tokenRes = await call(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }),
    }),
    env,
  );
  expect(tokenRes.status).toBe(200);
  const tokenText = await tokenRes.text();
  responses.push(tokenText);
  return { token: (JSON.parse(tokenText) as { access_token: string }).access_token, responses };
}

/** tools/call ผ่าน /mcp แล้วคืนทั้ง HTTP status, body ดิบ และผลของ tool */
async function searchPartners(env: Record<string, unknown>, token: string) {
  const res = await call(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "x-forwarded-user-agent": "Claude-User",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "odoo_search_read",
          arguments: { model: "res.partner", domain: [], fields: ["name"] },
        },
      }),
    }),
    env,
  );
  const raw = await res.text();
  const data = raw.split("\n").find((line) => line.startsWith("data: "));
  const result = JSON.parse(data ? data.slice(6) : raw).result as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { status: res.status, raw, result, text: result.content[0].text };
}

function spyConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
}

function consoleOutput(spies: ReturnType<typeof spyConsole>): string[] {
  return spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" ")));
}

function auditLines(spies: ReturnType<typeof spyConsole>) {
  return consoleOutput(spies)
    .filter((line) => line.includes('"mcp_call"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------

describe("วงจรชีวิต Odoo API key (access + per_user · env แบบ deploy จริง)", () => {
  it("เพิกถอน key → reconnect_required · เชื่อมใหม่ด้วย key ใหม่ใช้ได้ · grant เดิมยัง reconnect_required", async () => {
    const env = deployEnv();
    const clientId = await createClient(env);
    validKeys.set(LOGIN, new Set([KEY_OLD]));
    const spies = spyConsole();

    // 1. grant ที่ใช้งานได้
    const first = await connect(env, clientId, KEY_OLD);
    const ok = await searchPartners(env, first.token);
    expect(ok.status).toBe(200);
    expect(ok.result.isError).toBeUndefined();
    expect(ok.text).toContain("Partner A");

    // 2. แอดมินเพิกถอน key ใน Odoo
    validKeys.set(LOGIN, new Set());
    odooBodies = [];
    const revoked = await searchPartners(env, first.token);
    expect(revoked.status).toBe(200); // เป็น tool error ไม่ใช่ 500
    expect(revoked.result.isError).toBe(true);
    expect(revoked.text).toContain("reconnect_required");
    // ไม่ fallback: ทุก request ไป Odoo ใช้ login/key ของผู้ใช้คนนี้เท่านั้น
    expect(odooBodies.length).toBeGreaterThan(0);
    // args[2] คือ key ทั้งใน authenticate และ execute_kw
    for (const { params } of odooBodies) expect(params.args[2]).toBe(KEY_OLD);

    // 3. ผู้ใช้สร้าง key ใหม่แล้วเชื่อมใหม่
    validKeys.set(LOGIN, new Set([KEY_NEW]));
    const second = await connect(env, clientId, KEY_NEW);
    const renewed = await searchPartners(env, second.token);
    expect(renewed.result.isError).toBeUndefined();
    expect(renewed.text).toContain("Partner A");

    // 4. grant เดิมผูกกับ key เก่า — ยังใช้ไม่ได้
    const stale = await searchPartners(env, first.token);
    expect(stale.text).toContain("reconnect_required");

    // ไม่มีค่า key หรือ login ใน response ใด ๆ
    const responses = [
      ...first.responses,
      ...second.responses,
      ok.raw,
      revoked.raw,
      renewed.raw,
      stale.raw,
    ].join("\n");
    for (const secret of [KEY_OLD, KEY_NEW, LOGIN]) {
      expect(responses).not.toContain(secret);
    }

    // log: ไม่มี key/login · mcp_call มีแค่ฟิลด์ที่กำหนด
    const output = consoleOutput(spies).join("\n");
    for (const secret of [KEY_OLD, KEY_NEW, LOGIN]) {
      expect(output).not.toContain(secret);
    }
    const audit = auditLines(spies);
    expect(audit.map((line) => line.error_code)).toEqual([
      null,
      "reconnect_required",
      null,
      "reconnect_required",
    ]);
    for (const line of audit) {
      expect(Object.keys(line).sort()).toEqual(AUDIT_FIELDS);
      expect(line).toMatchObject({
        event: "mcp_call",
        user: expect.stringMatching(/^[0-9a-f]{32}$/),
        client_id: clientId,
        client_label: "fwd:Claude-User",
        odoo_uid: UID,
        tool: "odoo_search_read",
      });
    }
  });

  it("key ถูกแต่ติดต่อ Odoo ไม่ได้ → บอกว่าเชื่อม Odoo ไม่ได้ ไม่ใช่ reconnect_required", async () => {
    const env = deployEnv();
    const clientId = await createClient(env);
    validKeys.set(LOGIN, new Set([KEY_OLD]));
    const spies = spyConsole();
    const { token } = await connect(env, clientId, KEY_OLD);

    // ทั้งตอน uid ยังไม่อยู่ใน cache และหลังจาก cache แล้ว
    for (const warm of [false, true]) {
      if (warm) {
        odooDown = false;
        expect((await searchPartners(env, token)).result.isError).toBeUndefined();
      }
      odooDown = true;
      const down = await searchPartners(env, token);
      expect(down.status).toBe(200);
      expect(down.result.isError).toBe(true);
      expect(down.text).toContain("Cannot reach Odoo");
      expect(down.text).not.toContain("reconnect_required");
      expect(down.raw).not.toContain(KEY_OLD);
      expect(down.raw).not.toContain(LOGIN);
    }

    // Odoo กลับมา → grant เดิมใช้ต่อได้ ไม่ต้องสร้าง key ใหม่
    odooDown = false;
    expect((await searchPartners(env, token)).result.isError).toBeUndefined();

    const output = consoleOutput(spies).join("\n");
    expect(output).not.toContain(KEY_OLD);
    expect(output).not.toContain(LOGIN);
    const audit = auditLines(spies);
    expect(audit.filter((line) => line.ok === false).map((line) => line.error_code)).toEqual([
      "tool_error",
      "tool_error",
    ]);
    for (const line of audit) expect(Object.keys(line).sort()).toEqual(AUDIT_FIELDS);
  });
});
