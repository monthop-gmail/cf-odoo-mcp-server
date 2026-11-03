import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { oauthDefaultHandler } from "../src/oauth";
import { resetAccessCache } from "../src/access";

/**
 * โหมด consent `access` — หน้า /authorize หลัง Cloudflare Access
 *
 * ทุกเทสต์สร้าง key RSA ของตัวเองแล้ว mock `fetch` ของ certs ให้ตอบ key นั้น
 * จึงตรวจลายเซ็นจริงทุกครั้ง ไม่ได้ข้ามการตรวจ
 */

const TEAM = "team.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "aud-tag-123";
const KID = "k1";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

// Node ไม่มี timingSafeEqual บน crypto.subtle (Workers มี) — secretsMatch ใช้มัน
beforeAll(() => {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  subtle.timingSafeEqual ??= (a, b) =>
    Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer)) === 0;
});

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JsonWebKey;
let certsFetches = 0;

async function rsaPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

beforeAll(async () => {
  const pair = await rsaPair();
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  otherKey = (await rsaPair()).privateKey;
});

const b64url = (data: string | Uint8Array) =>
  Buffer.from(data).toString("base64url");

async function jwt(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: CryptoKey = privateKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT", ...header }));
  const p = b64url(
    JSON.stringify({
      iss: ISS,
      aud: [AUD],
      sub: "user-sub-1",
      email: "Owner@Example.com",
      iat: now,
      nbf: now - 10,
      exp: now + 600,
      ...claims,
    }),
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const completeAuthorization = vi.fn(async (options: { request: { redirectUri: string } }) => ({
    redirectTo: `${options.request.redirectUri}?code=abc&state=s1`,
  }));
  const env = {
    CONSENT_MODE: "access",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_ALLOWED_EMAILS: "owner@example.com, second@example.com",
    CONSENT_CSRF_SECRET: "csrf-secret",
    OAUTH_KV: fakeKv(),
    OAUTH_PROVIDER: {
      parseAuthRequest: async (request: Request) => {
        const url = new URL(request.url);
        return {
          responseType: "code",
          clientId: url.searchParams.get("client_id")!,
          redirectUri: url.searchParams.get("redirect_uri")!,
          scope: ["odoo"],
          state: "s1",
        };
      },
      lookupClient: async (clientId: string) =>
        clientId === "unknown" ? null : { clientId, clientName: "Claude", redirectUris: [REDIRECT] },
      completeAuthorization,
    },
    ...overrides,
  };
  return { env: env as never, completeAuthorization };
}

const authorizeUrl = (redirect = REDIRECT, clientId = "client-1") =>
  `https://mcp.example.com/authorize?response_type=code&client_id=${clientId}` +
  `&redirect_uri=${encodeURIComponent(redirect)}&state=s1`;

async function getConsent(env: never, assertion?: string, url = authorizeUrl()) {
  const headers: Record<string, string> = {};
  if (assertion) headers["cf-access-jwt-assertion"] = assertion;
  return oauthDefaultHandler.fetch(new Request(url, { headers }), env);
}

async function postConsent(env: never, assertion: string, csrf: string, decision = "approve") {
  return oauthDefaultHandler.fetch(
    new Request("https://mcp.example.com/authorize", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": assertion },
      body: new URLSearchParams({ csrf, decision }),
    }),
    env,
  );
}

function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match) throw new Error("no csrf in page");
  return match[1];
}

const expectedUserId = (sub: string) =>
  createHash("sha256").update(`cf-odoo-user:${ISS}|${sub}`).digest("hex").slice(0, 32);

beforeEach(() => {
  resetAccessCache();
  certsFetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error(`unexpected fetch ${url}`);
      certsFetches++;
      return Response.json({ keys: [{ ...publicJwk, kid: KID, alg: "RS256" }] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("โหมด token (ค่าเริ่มต้น) — พฤติกรรมเดิม", () => {
  const tokenEnv = () => {
    const { env, completeAuthorization } = makeEnv({
      CONSENT_MODE: undefined,
      MCP_AUTH_TOKEN: "shared-secret",
    });
    return { env, completeAuthorization };
  };

  it("GET แสดงฟอร์มใส่ MCP_AUTH_TOKEN โดยไม่ต้องมี JWT ของ Access", async () => {
    const res = await getConsent(tokenEnv().env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="token"');
  });

  it("token ถูก → 302 และ grant เป็น userId shared", async () => {
    const { env, completeAuthorization } = tokenEnv();
    const authRequest = await (env as { OAUTH_PROVIDER: { parseAuthRequest: (r: Request) => Promise<unknown> } })
      .OAUTH_PROVIDER.parseAuthRequest(new Request(authorizeUrl()));
    const res = await oauthDefaultHandler.fetch(
      new Request("https://mcp.example.com/authorize", {
        method: "POST",
        body: new URLSearchParams({
          auth_request: JSON.stringify(authRequest),
          token: "shared-secret",
        }),
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(completeAuthorization.mock.calls[0][0]).toMatchObject({ userId: "shared", props: {} });
  });

  it("token ผิด → 401", async () => {
    const { env, completeAuthorization } = tokenEnv();
    const res = await oauthDefaultHandler.fetch(
      new Request("https://mcp.example.com/authorize", {
        method: "POST",
        body: new URLSearchParams({ auth_request: "{}", token: "nope" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});

describe("โหมด access — ตรวจ JWT ของ Access", () => {
  it("ไม่มี header → 403", async () => {
    const res = await getConsent(makeEnv().env);
    expect(res.status).toBe(403);
  });

  const bad: [string, () => Promise<string>][] = [
    ["aud ผิด", () => jwt({ aud: ["other-aud"] })],
    ["iss ผิด", () => jwt({ iss: "https://evil.cloudflareaccess.com" })],
    ["หมดอายุเกินช่วงเผื่อ 60 วิ", () => jwt({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ["nbf ในอนาคต", () => jwt({ nbf: Math.floor(Date.now() / 1000) + 600 })],
    ["alg ไม่ใช่ RS256", () => jwt({}, { alg: "HS256" })],
    ["alg none", () => jwt({}, { alg: "none" })],
    ["kid ไม่รู้จัก", () => jwt({}, { kid: "unknown-kid" })],
    ["ลายเซ็นจาก key อื่น", () => jwt({}, {}, otherKey)],
    ["ไม่มี sub", () => jwt({ sub: undefined })],
    ["ไม่มี email", () => jwt({ email: undefined })],
    ["รูปแบบเสีย", async () => "not.a.jwt"],
  ];
  for (const [name, make] of bad) {
    it(`${name} → 403`, async () => {
      const res = await getConsent(makeEnv().env, await make());
      expect(res.status).toBe(403);
    });
  }

  it("payload ถูกแก้หลังเซ็น → 403", async () => {
    const [h, , s] = (await jwt()).split(".");
    const forged = b64url(
      JSON.stringify({ iss: ISS, aud: AUD, sub: "x", email: "owner@example.com", exp: 9e9 }),
    );
    const res = await getConsent(makeEnv().env, `${h}.${forged}.${s}`);
    expect(res.status).toBe(403);
  });

  it("อีเมลนอก allowlist → 403", async () => {
    const res = await getConsent(makeEnv().env, await jwt({ email: "stranger@example.com" }));
    expect(res.status).toBe(403);
  });

  it("allowlist เทียบตรงตัว — subdomain ของอีเมลที่อนุญาตไม่ผ่าน", async () => {
    const res = await getConsent(makeEnv().env, await jwt({ email: "owner@example.com.evil.io" }));
    expect(res.status).toBe(403);
  });

  for (const missing of [
    "ACCESS_TEAM_DOMAIN",
    "ACCESS_AUD",
    "ACCESS_ALLOWED_EMAILS",
    "CONSENT_CSRF_SECRET",
    "OAUTH_KV",
  ]) {
    it(`ขาด ${missing} → 503 (ไม่ถอยไปโหมด token)`, async () => {
      const res = await getConsent(makeEnv({ [missing]: undefined }).env, await jwt());
      expect(res.status).toBe(503);
    });
  }

  it("kid ที่ไม่รู้จักบังคับดึง certs ใหม่ได้ไม่เกินนาทีละครั้ง", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
    const { env } = makeEnv();
    const unknown = await jwt({}, { kid: "rotated" });

    await getConsent(env, unknown);
    await getConsent(env, unknown);
    await getConsent(env, unknown);
    expect(certsFetches).toBe(1);

    vi.setSystemTime(new Date("2026-11-03T00:01:01Z"));
    const later = await jwt({}, { kid: "rotated" });
    await getConsent(env, later);
    expect(certsFetches).toBe(2);
    await getConsent(env, later);
    expect(certsFetches).toBe(2);
  });
});

describe("โหมด access — หน้า consent และการอนุญาต", () => {
  it("หน้า consent แสดงชื่อแอป client_id redirect_uri เต็ม และคำเตือน", async () => {
    const res = await getConsent(makeEnv().env, await jwt());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await res.text();
    expect(html).toContain("Claude");
    expect(html).toContain("client-1");
    expect(html).toContain(REDIRECT);
    expect(html).toContain("อนุญาตเฉพาะเมื่อคุณเพิ่งกดเชื่อมต่อเอง");
  });

  it("escape ชื่อแอปที่มี <script>", async () => {
    const { env } = makeEnv();
    (env as { OAUTH_PROVIDER: { lookupClient: unknown } }).OAUTH_PROVIDER.lookupClient = async (
      clientId: string,
    ) => ({ clientId, clientName: '<script>alert("x")</script>', redirectUris: [REDIRECT] });
    const html = await (await getConsent(env, await jwt())).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("หมดอายุไม่เกิน 60 วิ ยังผ่าน (เผื่อนาฬิกาคลาด)", async () => {
    const res = await getConsent(makeEnv().env, await jwt({ exp: Math.floor(Date.now() / 1000) - 30 }));
    expect(res.status).toBe(200);
  });

  it("อนุญาต → grant ด้วย userId = hash(iss|sub) props ไม่มีอีเมล และกลับด้วย meta refresh", async () => {
    const { env, completeAuthorization } = makeEnv();
    const assertion = await jwt();
    const csrf = csrfFrom(await (await getConsent(env, assertion)).text());

    const res = await postConsent(env, assertion, csrf);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain(`${REDIRECT}?code=abc&amp;state=s1`);

    const options = completeAuthorization.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(options.userId).toBe(expectedUserId("user-sub-1"));
    expect(options.userId).toMatch(/^[0-9a-f]{32}$/);
    expect(options.props).toEqual({ user: expectedUserId("user-sub-1") });
    expect(JSON.stringify(options)).not.toMatch(/example\.com/i);
  });

  it("sub เดียวกัน (อีเมลเปลี่ยน) ได้ userId เดิม · sub ต่างได้ค่าต่าง", async () => {
    const { env, completeAuthorization } = makeEnv();
    for (const claims of [
      { sub: "user-sub-1", email: "owner@example.com" },
      { sub: "user-sub-1", email: "second@example.com" },
      { sub: "user-sub-2", email: "owner@example.com" },
    ]) {
      const assertion = await jwt(claims);
      const csrf = csrfFrom(await (await getConsent(env, assertion)).text());
      expect((await postConsent(env, assertion, csrf)).status).toBe(200);
    }
    const ids = completeAuthorization.mock.calls.map(
      (call) => (call[0] as unknown as { userId: string }).userId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("ใช้ CSRF ซ้ำ → 403", async () => {
    const { env, completeAuthorization } = makeEnv();
    const assertion = await jwt();
    const csrf = csrfFrom(await (await getConsent(env, assertion)).text());
    expect((await postConsent(env, assertion, csrf)).status).toBe(200);
    expect((await postConsent(env, assertion, csrf)).status).toBe(403);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("CSRF ของผู้ใช้อื่น หรือ MAC ถูกแก้ → 403", async () => {
    const { env, completeAuthorization } = makeEnv();
    const csrf = csrfFrom(await (await getConsent(env, await jwt())).text());
    const otherUser = await jwt({ sub: "user-sub-2" });
    expect((await postConsent(env, otherUser, csrf)).status).toBe(403);
    const [nonce] = csrf.split(".");
    expect((await postConsent(env, await jwt(), `${nonce}.deadbeef`)).status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("POST ไม่มี JWT → 403", async () => {
    const res = await oauthDefaultHandler.fetch(
      new Request("https://mcp.example.com/authorize", {
        method: "POST",
        body: new URLSearchParams({ csrf: "a.b", decision: "approve" }),
      }),
      makeEnv().env,
    );
    expect(res.status).toBe(403);
  });

  it("ปฏิเสธ → กลับไปพร้อม error=access_denied โดยไม่ออก grant", async () => {
    const { env, completeAuthorization } = makeEnv();
    const assertion = await jwt();
    const csrf = csrfFrom(await (await getConsent(env, assertion)).text());
    const html = await (await postConsent(env, assertion, csrf, "deny")).text();
    expect(html).toContain("error=access_denied");
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
