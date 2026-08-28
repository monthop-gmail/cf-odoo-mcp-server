/**
 * ตัวช่วยเรียก Workers Rate Limiting binding
 *
 * แยกออกมาเพราะทั้ง entry point และหน้า consent ต้องใช้ และเพราะพฤติกรรมตอน
 * binding ไม่มี ต้องเหมือนกันทั้งสองที่
 */

import { json } from "./http";

/**
 * `CF-Connecting-IP` มาจาก Cloudflare เอง client ปลอมไม่ได้เพราะ Cloudflare
 * เขียนทับเสมอ ตอนรัน `wrangler dev` จะไม่มี header นี้ ทุก request จึงใช้ key
 * เดียวกัน ซึ่งพอสำหรับการทดสอบ
 */
function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

/**
 * คืน Response 429 เมื่อเกินลิมิต หรือ null เมื่อผ่าน
 *
 * ถ้าไม่มี binding จะปล่อยผ่าน — เกิดได้เฉพาะตอนพัฒนาในเครื่อง เพราะ wrangler
 * ตรวจ binding ให้ตั้งแต่ตอน deploy การ fail open ตรงนี้จึงไม่กระทบ production
 */
export async function overLimit(
  limiter: RateLimit | undefined,
  request: Request,
  detail: string,
): Promise<Response | null> {
  if (!limiter) return null;

  const { success } = await limiter.limit({ key: clientKey(request) });
  if (success) return null;

  return json({ error: "rate_limited", detail }, 429, { "retry-after": "60" });
}
