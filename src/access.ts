/**
 * ตรวจ header `Cf-Access-Jwt-Assertion` ที่ Cloudflare Access แนบมาให้
 *
 * ใช้เฉพาะโหมด consent `access` — Access เป็นคนยืนยันตัวตนผู้ใช้ ส่วน Worker แค่
 * เชื่อ JWT ที่ลายเซ็นตรงกับ key ของทีม และ claim ตรงกับ app ของเรา ใช้ WebCrypto
 * อย่างเดียว ไม่ต้องมี library
 */

type AccessJwk = JsonWebKey & { kid?: string };

/** cache key ของทีมไว้นานพอควร — Access หมุน key ไม่บ่อย */
const CERTS_TTL_MS = 10 * 60 * 1000;
/**
 * เจอ `kid` ที่ไม่รู้จัก (key เพิ่งหมุน) จะดึงใหม่ทันทีได้ไม่เกินนาทีละครั้ง
 * ไม่งั้นใครก็ยิง JWT ที่ใส่ kid มั่ว ๆ ให้ Worker ไปดึง certs รัว ๆ ได้
 */
const FORCE_REFRESH_INTERVAL_MS = 60 * 1000;

/** เผื่อนาฬิกาของ Access กับ Worker คลาดกัน ตอนตรวจ `exp` และ `nbf` */
const CLOCK_SKEW_SECONDS = 60;

const certsCache = new Map<string, { keys: AccessJwk[]; fetchedAt: number }>();

/** สำหรับเทสต์: ลืม key ที่ cache ไว้ */
export function resetAccessCache(): void {
  certsCache.clear();
}

export class AccessJwtError extends Error {}

export interface AccessIdentity {
  iss: string;
  sub: string;
  /** ตัวพิมพ์เล็ก ตัดช่องว่างแล้ว — ใช้เทียบ allowlist เท่านั้น ไม่เก็บลง grant */
  email: string;
}

/** `https://team.cloudflareaccess.com/` → `team.cloudflareaccess.com` */
export function normalizeTeamDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AccessJwtError("malformed");
  }
  return value as Record<string, unknown>;
}

async function fetchKeys(teamDomain: string): Promise<AccessJwk[]> {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessJwtError("certs_unavailable");
  const body = (await res.json()) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as AccessJwk[]) : [];
  certsCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

async function findKey(teamDomain: string, kid: string): Promise<AccessJwk | undefined> {
  const cached = certsCache.get(teamDomain);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  const keys = cached && age < CERTS_TTL_MS ? cached.keys : await fetchKeys(teamDomain);
  const hit = keys.find((k) => k.kid === kid);
  if (hit) return hit;

  // kid ไม่อยู่ใน cache — อาจเพิ่งหมุน key ดึงใหม่ได้ถ้าครั้งล่าสุดเก่ากว่าหนึ่งนาที
  const last = certsCache.get(teamDomain)?.fetchedAt ?? 0;
  if (Date.now() - last < FORCE_REFRESH_INTERVAL_MS) return undefined;
  return (await fetchKeys(teamDomain)).find((k) => k.kid === kid);
}

/**
 * คืนตัวตนจาก JWT ของ Access ที่ถูกต้อง หรือโยน AccessJwtError
 *
 * ตรวจ: RS256 · `kid` อยู่ใน certs ของทีม · ลายเซ็น · `iss` · `aud` มี audience
 * ของเรา · `exp` และ `nbf` (เผื่อ 60 วินาที) · มี `sub` และ `email`
 */
export async function verifyAccessJwt(
  token: string,
  teamDomainRaw: string,
  audience: string,
): Promise<AccessIdentity> {
  const teamDomain = normalizeTeamDomain(teamDomainRaw);
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessJwtError("malformed");
  const [h, p, s] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
    signature = base64UrlDecode(s);
  } catch {
    throw new AccessJwtError("malformed");
  }

  if (header.alg !== "RS256") throw new AccessJwtError("invalid_alg");
  if (typeof header.kid !== "string" || !header.kid) throw new AccessJwtError("no_kid");

  const jwk = await findKey(teamDomain, header.kid);
  if (!jwk || jwk.kty !== "RSA") throw new AccessJwtError("no_matching_key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new AccessJwtError("signature_failed");

  const iss = `https://${teamDomain}`;
  if (payload.iss !== iss) throw new AccessJwtError("iss_mismatch");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(audience)) throw new AccessJwtError("aud_mismatch");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= now) {
    throw new AccessJwtError("expired");
  }
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - CLOCK_SKEW_SECONDS > now)) {
    throw new AccessJwtError("not_yet_valid");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new AccessJwtError("no_sub");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) throw new AccessJwtError("no_email");

  return { iss, sub, email };
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * userId ที่เก็บใน grant — ผูกกับ `iss` + `sub` ของ Access ไม่ใช่อีเมล
 *
 * อีเมลเปลี่ยนได้และเป็นข้อมูลส่วนบุคคล ส่วน `sub` คงที่ตลอดอายุผู้ใช้ใน IdP
 * การ hash ทำให้ KV ไม่มีตัวระบุที่ย้อนกลับเป็นคนได้ตรง ๆ
 */
export async function accessUserId(identity: Pick<AccessIdentity, "iss" | "sub">): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`cf-odoo-user:${identity.iss}|${identity.sub}`),
  );
  return toHex(digest).slice(0, 32);
}
