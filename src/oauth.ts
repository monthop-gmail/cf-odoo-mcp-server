/**
 * The consent screen Claude sends a user to before it may call the tools.
 *
 * Two modes, chosen by `CONSENT_MODE`:
 *
 * - `token` (default): this server has one shared credential rather than
 *   per-user accounts, so "signing in" means proving you hold
 *   `MCP_AUTH_TOKEN`. That keeps a single secret to manage: the same value
 *   works as a static bearer for clients that can send headers, and as the
 *   password here for clients that can only do OAuth.
 * - `access`: Cloudflare Access sits in front of `/authorize` and has already
 *   signed the user in. The grant belongs to that user (Access `iss` + `sub`),
 *   so grants issued through the MCP Portal can be told apart per person.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { consentMode, type Env } from "./config";
import {
  AccessJwtError,
  accessUserId,
  verifyAccessJwt,
  type AccessIdentity,
} from "./access";
import { json, secretsMatch } from "./http";
import { overLimit } from "./rate-limit";

/** Bindings the OAuth provider adds on top of the Worker's own. */
export interface OAuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Scope granted to every approved connection. There is only one. */
const SCOPE = ["odoo"];

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center;
         background: Canvas; color: CanvasText; }
  main { width: min(28rem, 92vw); padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { margin: .25rem 0 1.25rem; opacity: .75; font-size: .9rem; line-height: 1.5; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .35rem .75rem;
       font-size: .85rem; margin: 0 0 1.5rem; }
  dt { opacity: .6; }
  dd { margin: 0; word-break: break-all; }
  label { display: block; font-size: .85rem; margin-bottom: .35rem; }
  input { width: 100%; padding: .6rem .7rem; font: inherit; border-radius: .4rem;
          border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
          background: Canvas; color: inherit; box-sizing: border-box; }
  button { width: 100%; padding: .6rem; margin-top: 1rem; font: inherit;
           font-weight: 600; border: 0; border-radius: .4rem; cursor: pointer;
           background: CanvasText; color: Canvas; }
  .error { color: #d33; font-size: .85rem; margin-top: .75rem; }
`;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * The form carries the authorization request forward in a hidden field.
 *
 * The provider's `parseAuthRequest` reads it from the query string, so the POST
 * has to reproduce the same parameters. Round-tripping the parsed object as JSON
 * is simpler than rebuilding the query and keeps the two requests in step.
 */
function consentPage(
  authRequest: AuthRequest,
  clientName: string,
  error?: string,
): Response {
  const body = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>เชื่อมต่อ Odoo MCP</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>อนุญาตให้เชื่อมต่อ</h1>
    <p>ใส่ <code>MCP_AUTH_TOKEN</code> ของเซิร์ฟเวอร์นี้เพื่อยืนยันว่าคุณมีสิทธิ์
       ให้ไคลเอนต์ด้านล่างเรียกใช้เครื่องมือ Odoo</p>
    <dl>
      <dt>ไคลเอนต์</dt><dd>${escapeHtml(clientName)}</dd>
      <dt>สิทธิ์</dt><dd>${SCOPE.join(", ")}</dd>
    </dl>
    <form method="post">
      <input type="hidden" name="auth_request" value="${escapeHtml(JSON.stringify(authRequest))}">
      <label for="token">MCP_AUTH_TOKEN</label>
      <input id="token" name="token" type="password" autocomplete="off"
             autofocus required>
      <button type="submit">อนุญาต</button>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    </form>
  </main>
</body>
</html>`;

  return new Response(body, {
    status: error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleTokenAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  if (!env.MCP_AUTH_TOKEN) {
    return json(
      {
        error: "server_misconfigured",
        detail: "MCP_AUTH_TOKEN is not set. Run: wrangler secret put MCP_AUTH_TOKEN",
      },
      500,
    );
  }

  if (request.method === "GET") {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    return consentPage(authRequest, client?.clientName ?? authRequest.clientId);
  }

  // การส่งฟอร์มคือจุดเดียวที่เดา MCP_AUTH_TOKEN ได้ จึงจำกัดแน่นกว่า /mcp มาก
  const limited = await overLimit(
    env.AUTH_LIMIT,
    request,
    "Too many authorization attempts. Retry in a minute.",
  );
  if (limited) return limited;

  const form = await request.formData();
  const raw = form.get("auth_request");
  const supplied = form.get("token");
  if (typeof raw !== "string" || typeof supplied !== "string") {
    return json({ error: "invalid_request", detail: "missing form fields" }, 400);
  }

  let authRequest: AuthRequest;
  try {
    authRequest = JSON.parse(raw) as AuthRequest;
  } catch {
    return json({ error: "invalid_request", detail: "malformed auth_request" }, 400);
  }

  if (!(await secretsMatch(supplied, env.MCP_AUTH_TOKEN))) {
    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    return consentPage(
      authRequest,
      client?.clientName ?? authRequest.clientId,
      "token ไม่ถูกต้อง",
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    // One shared credential means one identity. Recorded so grants issued by
    // this server are distinguishable in KV from anything added later.
    userId: "shared",
    metadata: {},
    scope: SCOPE,
    props: {},
  });

  return Response.redirect(redirectTo, 302);
}

// ---------------------------------------------------------------------------
// โหมด access — Cloudflare Access ยืนยันตัวตนให้ก่อนถึงหน้านี้
// ---------------------------------------------------------------------------

const CSRF_TTL_SECONDS = 600;
const CSRF_KV_PREFIX = "consent_csrf:";

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

interface AccessConfig {
  teamDomain: string;
  aud: string;
  emails: string[];
  csrfSecret: string;
  kv: KVNamespace;
}

/** ขาดตัวไหนก็คืน null แล้วตอบ 503 — ไม่ fail open ไปเป็นโหมด token */
function accessConfig(env: OAuthEnv): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  const emails = splitList(env.ACCESS_ALLOWED_EMAILS);
  if (!teamDomain || !aud || emails.length === 0) return null;
  if (!env.CONSENT_CSRF_SECRET || !env.OAUTH_KV || !env.OAUTH_PROVIDER) return null;
  return { teamDomain, aud, emails, csrfSecret: env.CONSENT_CSRF_SECRET, kv: env.OAUTH_KV };
}

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: SECURITY_HEADERS });
}

function accessConsentPage(
  clientName: string,
  clientId: string,
  redirectUri: string,
  csrf: string,
): string {
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>เชื่อมต่อ Odoo MCP</title>
  <style>${STYLE}
  .warn { opacity: 1; border: 2px solid #b45309; padding: .75rem; border-radius: .4rem; }
  .deny { background: transparent; color: inherit;
          border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
  </style>
</head>
<body>
  <main>
    <h1>อนุญาตให้เชื่อมต่อ</h1>
    <p class="warn"><strong>อนุญาตเฉพาะเมื่อคุณเพิ่งกดเชื่อมต่อเอง</strong>
       ถ้าได้ลิงก์นี้มาจากคนอื่น ให้กดปฏิเสธ</p>
    <dl>
      <dt>แอป</dt><dd>${escapeHtml(clientName)}</dd>
      <dt>client_id</dt><dd><code>${escapeHtml(clientId)}</code></dd>
      <dt>ส่งกลับไปที่</dt><dd><code>${escapeHtml(redirectUri)}</code></dd>
      <dt>สิทธิ์</dt><dd>${escapeHtml(SCOPE.join(", "))}</dd>
    </dl>
    <form method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" name="decision" value="approve">อนุญาต</button>
      <button type="submit" name="decision" value="deny" class="deny">ปฏิเสธ</button>
    </form>
  </main>
</body>
</html>`;
}

/**
 * หน้าที่พาเบราว์เซอร์กลับไปหา client หลัง POST
 *
 * 302 ข้าม origin หลังส่งฟอร์มจะโดน CSP `form-action 'self'` บล็อก จึงใช้
 * meta refresh กับลิงก์ให้กดเองแทน
 */
function returnPage(title: string, redirectTo: string): Response {
  const target = escapeHtml(redirectTo);
  return html(`<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${target}">
  <title>${escapeHtml(title)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>กำลังกลับไปยังแอป ถ้าหน้าไม่เปลี่ยน <a href="${target}" rel="noreferrer">กดที่นี่</a></p>
  </main>
</body>
</html>`);
}

/** ทุกกรณีที่ตรวจตัวตนไม่ผ่านตอบเหมือนกันหมด ไม่บอกว่าพลาดตรงไหน */
const forbidden = () => json({ error: "forbidden" }, 403);

async function handleAccessAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  const cfg = accessConfig(env);
  if (!cfg) {
    return json(
      {
        error: "server_misconfigured",
        detail:
          "CONSENT_MODE=access needs ACCESS_TEAM_DOMAIN, ACCESS_AUD, " +
          "ACCESS_ALLOWED_EMAILS, CONSENT_CSRF_SECRET and OAUTH_KV",
      },
      503,
    );
  }

  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return forbidden();
  let identity: AccessIdentity;
  try {
    identity = await verifyAccessJwt(assertion, cfg.teamDomain, cfg.aud);
  } catch (error) {
    if (error instanceof AccessJwtError) return forbidden();
    throw error;
  }
  if (!cfg.emails.includes(identity.email)) return forbidden();
  const userId = await accessUserId(identity);

  const helpers = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    let authRequest: AuthRequest;
    try {
      authRequest = await helpers.parseAuthRequest(request);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const client = await helpers.lookupClient(authRequest.clientId);
    if (!client) return json({ error: "invalid_client" }, 400);

    // nonce ผูกกับผู้ใช้และคำขอนี้ ใช้ได้ครั้งเดียว — POST อ่านคำขอจาก KV
    // ไม่เชื่อสิ่งที่ฟอร์มส่งกลับมา
    const nonce = crypto.randomUUID();
    await cfg.kv.put(
      `${CSRF_KV_PREFIX}${nonce}`,
      JSON.stringify({ user: userId, request: authRequest }),
      { expirationTtl: CSRF_TTL_SECONDS },
    );
    const csrf = `${nonce}.${await hmacHex(cfg.csrfSecret, `${nonce}|${identity.sub}`)}`;
    return html(
      accessConsentPage(
        client.clientName || authRequest.clientId,
        authRequest.clientId,
        authRequest.redirectUri,
        csrf,
      ),
    );
  }

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  }

  const limited = await overLimit(
    env.AUTH_LIMIT,
    request,
    "Too many authorization attempts. Retry in a minute.",
  );
  if (limited) return limited;

  const form = await request.formData();
  const csrf = form.get("csrf");
  const [nonce, mac, extra] = typeof csrf === "string" ? csrf.split(".") : [];
  if (!nonce || !mac || extra !== undefined) return forbidden();
  if (!(await secretsMatch(mac, await hmacHex(cfg.csrfSecret, `${nonce}|${identity.sub}`)))) {
    return forbidden();
  }
  const kvKey = `${CSRF_KV_PREFIX}${nonce}`;
  const stored = await cfg.kv.get(kvKey);
  if (!stored) return forbidden();
  await cfg.kv.delete(kvKey);
  const { user, request: authRequest } = JSON.parse(stored) as {
    user: string;
    request: AuthRequest;
  };
  if (user !== userId) return forbidden();

  if (!(await helpers.lookupClient(authRequest.clientId))) {
    return json({ error: "invalid_client" }, 400);
  }

  if (form.get("decision") !== "approve") {
    const url = new URL(authRequest.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (authRequest.state) url.searchParams.set("state", authRequest.state);
    return returnPage("ปฏิเสธแล้ว", url.toString());
  }

  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId,
    metadata: {},
    scope: SCOPE,
    // ไม่เก็บอีเมล — userId ระบุคนได้พอ และไม่ใช่ข้อมูลส่วนบุคคลตรง ๆ
    props: { user: userId },
  });
  return returnPage("อนุญาตแล้ว", redirectTo);
}

/**
 * Everything the OAuth provider does not claim for itself: the consent screen,
 * the health check, and a 404 for the rest.
 */
export const oauthDefaultHandler = {
  async fetch(request: Request, env: OAuthEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/authorize") {
      return consentMode(env) === "access"
        ? handleAccessAuthorize(request, env)
        : handleTokenAuthorize(request, env);
    }
    if (pathname === "/health") {
      return json({ status: "ok", service: "odoo-mcp" }, 200);
    }
    return json({ error: "not_found", detail: "MCP endpoint is /mcp" }, 404);
  },
};
