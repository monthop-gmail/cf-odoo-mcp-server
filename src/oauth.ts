/**
 * The consent screen Claude sends a user to before it may call the tools.
 *
 * This server has one shared credential rather than per-user accounts, so
 * "signing in" means proving you hold `MCP_AUTH_TOKEN`. That keeps a single
 * secret to manage: the same value works as a static bearer for clients that
 * can send headers, and as the password here for clients that can only do
 * OAuth.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./config";
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

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
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

/**
 * Everything the OAuth provider does not claim for itself: the consent screen,
 * the health check, and a 404 for the rest.
 */
export const oauthDefaultHandler = {
  async fetch(request: Request, env: OAuthEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/health") {
      return json({ status: "ok", service: "odoo-mcp" }, 200);
    }
    return json({ error: "not_found", detail: "MCP endpoint is /mcp" }, 404);
  },
};
