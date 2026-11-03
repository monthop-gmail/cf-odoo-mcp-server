# cf-odoo-mcp-server

[MCP](https://modelcontextprotocol.io) server สำหรับ Odoo ERP ที่รันบน Cloudflare Workers

ใช้ transport แบบ stateless HTTP — ไม่ต้องใช้ Durable Objects ไม่ต้องมี container
ไม่ต้องมี process รันค้างไว้ อยู่ใน free tier ของ Workers ได้สบาย

พอร์ตมาจาก [odoo-mcp-claude](https://github.com/monthop-gmail/odoo-mcp-claude)
ซึ่งเป็น Python process คุยผ่าน XML-RPC — 10 tools แรกยกมาจากที่นั่น ส่วน
`odoo_read_group` `odoo_context` และ `odoo_get_models` เพิ่มทีหลัง

## แผนที่ POC — ทดลองอะไรไปแล้วบ้าง

โจทย์คือ "ให้ AI ตัวไหนก็ได้คุยกับ Odoo" ซึ่งกลายเป็นการทดลองหลายเส้นทาง เพราะ
แต่ละ client ส่ง credential ได้ไม่เหมือนกัน และ Odoo บางแบบก็เอาออกเน็ตไม่ได้

| client | ต่อกับ | auth | ผล |
| --- | --- | --- | --- |
| Claude Code | repo นี้ (Cloudflare Worker) | bearer header | ✅ 13 tools |
| Claude chat | repo นี้ | **OAuth (DCR)** | ✅ 13 tools |
| ChatGPT | repo นี้ | **OAuth (DCR)** | ✅ 13 tools |
| Gemini | repo นี้ | **OAuth (DCR)** | ✅ 13 tools |
| ChatGPT | [odoo-mcp-chatgpt](https://github.com/monthop-gmail/odoo-mcp-chatgpt) (Docker + ท่อ OpenAI) | ท่อจัดการให้ | ✅ 13 tools |
| Claude chat | `/mcp` ในตัวของ Odoo | — | ❌ Odoo ไม่ได้ทำ OAuth ให้ |
| ChatGPT | `/mcp` ในตัวของ Odoo | — | ❌ เหตุผลเดียวกัน |

**ข้อสรุปที่ไม่ได้คาดไว้: Claude, ChatGPT และ Gemini มีข้อจำกัดเดียวกันเป๊ะ**
ทั้งสามเจ้าตั้ง custom header ไม่ได้ รองรับแค่ OAuth หรือไม่มี auth ทั้งที่เป็นคนละ
บริษัทคนละ implementation — ทั้งสามลงทะเบียนตัวเองผ่าน DCR (RFC 7591) โดยไม่ต้อง
ตั้งค่าอะไรเพิ่มฝั่ง server เลย

แปลว่า **OAuth คือทางเดียวที่ใช้กับ AI chat บนคลาวด์ได้ทุกเจ้า** ส่วน static bearer
ใช้ได้เฉพาะ client ที่รันบนเครื่องเรา (Claude Code, Codex, curl) และ **`/mcp` ในตัว
ของ Odoo จึงต่อกับ AI chat บนคลาวด์ไม่ได้เลยสักเจ้า** ทั้งที่ทำมาให้ AI ใช้ เพราะ
ไม่ได้ทำ OAuth ให้

ฝั่ง Odoo ทดสอบกับสามเครื่อง — **SaaS 19.4 Enterprise**, **19.0 Community** ที่ลงเอง
และ **18.0** สำหรับเส้นทาง fallback ของ `odoo_read_group` พฤติกรรมต่างกันจริงหลายจุด
จนต้องเขียนแยกไว้ทุกครั้งว่าผลไหนมาจากเครื่องไหน

## สาม repo ต่างกันยังไง

| repo | รันที่ไหน | client หลัก | Odoo ต้อง public |
| --- | --- | --- | --- |
| [odoo-mcp-claude](https://github.com/monthop-gmail/odoo-mcp-claude) | Python process | ตัวตั้งต้น (XML-RPC) | ใช่ |
| **cf-odoo-mcp-server** (นี่) | Cloudflare edge | Claude Code · Claude chat | ใช่ |
| [odoo-mcp-chatgpt](https://github.com/monthop-gmail/odoo-mcp-chatgpt) | Docker ข้าง Odoo | ChatGPT · Codex | **ไม่ต้อง** |

สองตัวหลังให้ tool ชุดเดียวกันและตั้งใจให้พฤติกรรมตรงกัน เลือกตามว่า Odoo ของคุณ
ออกอินเทอร์เน็ตได้หรือไม่ ไม่ใช่ตามว่าใช้ AI ตัวไหน

## บทเรียนที่ได้ — "สำเร็จแต่ไม่จริง"

สามในสี่ของบั๊กที่เจอเป็นเรื่องเดียวกัน คือ **งานที่รายงานว่าสำเร็จ แต่ผลไม่ตรงกับ
ที่สั่ง และไม่มีอะไรเตือน** ซึ่งเป็นความล้มเหลวที่แย่ที่สุดสำหรับ agent เพราะมันจะ
รายงานต่อผู้ใช้ว่าเรียบร้อยดี

| อาการ | ทางแก้ |
| --- | --- |
| Odoo ทิ้งค่าที่เขียนลง readonly field เงียบ ๆ | `fields_not_applied` |
| อ่านมาไม่ครบแต่ดูเหมือนครบ | เพดาน 50 ของ `odoo_search_read` |
| นับกลุ่มได้ไม่ครบแล้วสรุปยอดผิด | `has_more` + `total_records` ของ `odoo_read_group` |

ข้อสุดท้ายเจอจากการใช้งานจริงบน Claude chat ไม่ใช่จากการทดสอบเอง — curl ไม่เคยขอ
ให้ใครสรุปยอดจากผลที่ถูกตัด รายละเอียดทั้งหมดอยู่ใน [NOTES.md](NOTES.md)

## Odoo 19 **Enterprise** มี API key 2 ชนิด — เช็คก่อนว่าต้องใช้อันไหน

หัวข้อนี้ใช้กับ **Enterprise เท่านั้น** ถ้าใช้ Community ข้ามไปได้เลย — มีแต่ key
ชนิด `rpc` ซึ่งคือสิ่งที่ project นี้ใช้

บน Odoo 19 Enterprise ออก API key ได้ 2 scope และใช้แทนกันไม่ได้

| ชนิด key | คุยกับ | ได้อะไร |
| --- | --- | --- |
| **`mcp`** | `/mcp` ของ Odoo เอง | MCP server ในตัว 5 tools **อ่านอย่างเดียว** — ไม่มี scope เขียนให้เปิด |
| **`rpc`** | `/jsonrpc` | เข้าถึง ORM ได้เต็ม **project นี้ใช้อันนี้** |

การแบ่ง scope เข้มงวดทั้งสองทาง: key ชนิด `rpc` ยิง `/mcp` จะได้ `401`
ส่วน key ชนิด `mcp` ก็ authenticate ผ่าน JSON-RPC ไม่ได้

MCP server ในตัวมาจาก module `ai_mcp` ซึ่งเป็น **Enterprise** (`OEEL-1`) — ถ้าใช้
Odoo Community จะไม่มี `/mcp` และไม่มี key ชนิด `mcp` ให้เลือก ข้ามหัวข้อนี้ไปได้เลย

**ถ้าใช้ Enterprise และ agent ของคุณอ่านอย่างเดียว คุณอาจไม่ต้องใช้ project นี้เลยก็ได้**
MCP server ในตัวของ Odoo ไม่ต้อง deploy ไม่ต้องหา hosting และไม่ต้องเอารหัส Odoo
ไปวางไว้ที่อื่น — ชี้ client ไปที่ `https://<odoo-ของคุณ>/mcp` พร้อม key ชนิด `mcp` ก็จบ
แถมมันยังปฏิเสธ technical model ให้เองโดยไม่ต้องตั้งค่า ส่วน project นี้ทำได้เหมือนกัน
แต่ต้องตั้ง `BLOCKED_MODELS` เอง ไม่ตั้งก็ไม่กัน

งานที่ต้อง**เขียน**ข้อมูลต้องใช้ key ชนิด `rpc` ซึ่งคือเหตุผลที่ project นี้มีอยู่ —
รวมถึงกรณีต่อ Odoo หลายตัวผ่าน endpoint เดียว และการมีเพดาน default ตอนอ่าน
ทั้งสองตัวรันคู่กันได้

[NOTES.md](NOTES.md#เทียบกับ-mcp-server-ในตัวของ-odoo) มีผลเทียบแบบเต็ม
รวมถึงจุดที่ schema ของ MCP server ในตัวจะทำให้ agent สะดุด

## ทำไมใช้ JSON-RPC ไม่ใช่ XML-RPC

`xmlrpc.client` ของ Python ต้องใช้ raw socket ซึ่ง runtime ของ Workers ไม่มีให้
แต่ Odoo เปิด `execute_kw` ชุดเดียวกันผ่าน JSON-RPC ที่ `/jsonrpc` ซึ่งเป็น HTTP ธรรมดา
ใช้กับ `fetch` ได้ตรง ๆ ไม่ต้องดัดแปลงอะไร

## ข้อกำหนด

Odoo ต้องเข้าถึงได้จากอินเทอร์เน็ตผ่าน HTTPS — Worker วิ่งเข้า LAN ไม่ได้
ถ้า Odoo ยังไม่ public ให้เอา [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
มาคั่นไว้ข้างหน้า

## Tools

| Tool | method ของ Odoo |
| --- | --- |
| `odoo_list_servers` | — (แสดง server ที่ตั้งค่าไว้) |
| `odoo_search_read` | `search_read` |
| `odoo_search_count` | `search_count` |
| `odoo_read` | `read` |
| `odoo_create` | `create` แล้วอ่าน field ที่เขียนไปกลับมา |
| `odoo_write` | `write` แล้วอ่าน field ที่เขียนไปกลับมา |
| `odoo_delete` | `unlink` |
| `odoo_execute` | **public method** ใดก็ได้ (Odoo กัน private method เอง) |
| `odoo_fields_get` | `fields_get` |
| `odoo_read_group` | `formatted_read_group` (ถอยไป `read_group` ถ้าเป็น Odoo รุ่นเก่า) — บอก `has_more` เมื่อผลถูกตัด |
| `odoo_context` | ผู้ใช้ บริษัท timezone ภาษา |
| `odoo_get_models` | รายชื่อ model ที่ใช้ได้ — **ต้องสิทธิ์ Access Rights** ดูหมายเหตุใต้ตาราง |
| `odoo_version` | `common.version` |

`odoo_get_models` อ่าน `ir.model` ซึ่ง Odoo สงวนไว้ให้กลุ่ม Access Rights หรือ
Administrator บัญชีสิทธิ์ต่ำตามที่แนะนำข้างล่างจะเรียกไม่ได้ อีก 12 ตัวใช้ได้ครบ

## การตั้งค่า

| ตัวแปร | ใช้ทำอะไร |
| --- | --- |
| `MCP_AUTH_TOKEN` | **จำเป็นเฉพาะโหมด token** (ค่าเริ่มต้น) — static bearer ที่ผู้เรียกแนบมา และรหัสของหน้า consent · โหมด access ไม่ต้องตั้ง และ**แนะนำไม่ตั้ง** เพราะเป็น credential กลางที่ข้ามตัวตนรายคน (ถ้าตั้ง static bearer ยังใช้ได้ audit เป็น `bearer`) |
| `CONSENT_MODE` | ไม่บังคับ `token` (ค่าเริ่มต้น) หรือ `access` — ดู [โหมด access](#โหมด-access-ใช้กับ-cloudflare-mcp-portal) |
| `ODOO_AUTH_MODE` | ไม่บังคับ `shared` (ค่าเริ่มต้น — บัญชีเดียวใน env) หรือ `per_user` — ดู [โหมด per_user](#โหมด-per_user--แต่ละคนใช้บัญชี-odoo-ของตัวเอง) |
| `ODOO_SERVERS` | JSON รองรับหนึ่งหรือหลาย server ถ้าตั้งไว้จะชนะตัวข้างล่าง |
| `ODOO_URL` `ODOO_DB` `ODOO_USERNAME` `ODOO_PASSWORD` | ทางเลือกสำรองสำหรับ server เดียว |
| `BLOCKED_MODELS` | ไม่บังคับ รายการ model ที่ทุก tool จะปฏิเสธ คั่นด้วย comma ลงท้าย `*` เพื่อจับแบบขึ้นต้น เช่น `ir.*,res.users*` ถ้าไม่ตั้งจะไม่บล็อกอะไรเลย |
| `ALLOWED_MODELS` | ไม่บังคับ ถ้าตั้งไว้ model ต้องตรงรายการนี้ด้วยจึงจะใช้ได้ |
| `OAUTH_KV` | **จำเป็น** KV namespace เก็บ client/grant/token ของ OAuth (ผูกใน `wrangler.jsonc`) |
| `MCP_LIMIT` `AUTH_LIMIT` | Rate limiting binding ผูกใน `wrangler.jsonc` — **อ่านข้อจำกัดที่วัดได้ก่อนพึ่งพา** |
| `ALLOWED_ORIGIN_HOSTNAMES` | ไม่บังคับ รายชื่อ hostname คั่นด้วย comma ที่ยอมให้ browser `Origin` เรียก `/mcp` ได้ หรือใส่ `*` ถ้าไม่ตั้ง จะรับเฉพาะ localhost กับ hostname `workers.dev` ของ Worker เอง — client ฝั่ง server ไม่ส่ง `Origin` มาอยู่แล้วจึงไม่ได้รับผลกระทบ |

ควรใช้ **API key** ของ Odoo แทนรหัสผ่านบัญชี และ **อย่าใช้บัญชี admin** —
`odoo_delete` กับ `odoo_write` เข้าถึงได้ทุกอย่างที่บัญชีนั้นเข้าถึงได้
สูตรบัญชีเฉพาะที่ทดสอบแล้วอยู่ใน
[NOTES.md](NOTES.md#ใช้บัญชีเฉพาะแทน-admin)

`BLOCKED_MODELS` เป็นรั้วชั้นที่สอง ตั้งได้โดยไม่ต้องไปแก้สิทธิ์ใน Odoo ค่าที่แนะนำ

```
BLOCKED_MODELS="ir.*,res.users*,res.groups*"
```

**ลงท้ายด้วย `*` ด้วย** — `res.users` เฉย ๆ จับได้แค่ตัวมันเอง `res.users.apikeys`
ยังหลุดผ่าน ส่วน `odoo_context` ตั้งใจให้ข้ามรั้วนี้ เพราะมันอ่านแค่ตัวตนของ
connection ที่มีอยู่แล้ว

Odoo กัน private method ให้เองทุกแพลตฟอร์ม แต่ **การซ่อนตาราง ACL อย่าง
`ir.model.access` เกิดเฉพาะบน Odoo Online** — บน Community ที่ลงเอง ตารางพวกนี้
อ่านและเขียนได้ตามสิทธิ์บัญชี รั้วนี้จึงยิ่งจำเป็นถ้ารัน Odoo เอง

รายละเอียดที่วัดมาทั้งสองแพลตฟอร์มอยู่ใน
[NOTES.md](NOTES.md#odoo-กันอะไรให้แล้วบ้างใน-rpc)

### Rate limiting — ผูกไว้แล้วแต่ยังกันไม่ได้จริง

`wrangler.jsonc` ผูก Workers Rate Limiting binding ไว้สองตัว — `MCP_LIMIT`
(120/60s ที่ `/mcp`) กับ `AUTH_LIMIT` (10/60s ที่หน้า consent) key เป็น
`CF-Connecting-IP` ซึ่ง Cloudflare เขียนทับเสมอ ปลอมไม่ได้

**แต่ทดสอบแล้วมันไม่ปฏิเสธ request ที่ยิงมาแยกกัน** ยิง `/authorize` 60 ครั้ง
ทั้งที่ลิมิต 10 ก็ไม่เจอ `429` สักครั้ง ขณะที่เรียก `limit()` รวดใน request เดียว
ปฏิเสธหลังครั้งที่ 11 ตามที่ควร ไล่ตัดสาเหตุแล้วไม่ใช่เรื่อง key และ binding
มาถึงโค้ดจริง — เหลือคำอธิบายเดียวคือ counter แยกตาม isolate แล้ว sync ไม่ทัน
ซึ่งตรงกับที่เอกสาร Cloudflare เตือนเองว่า *permissive, eventually consistent*

**อย่าพึ่งมันเป็นด่านเดียว** โค้ดยังอยู่เพราะถูกต้องและไม่มีต้นทุน อาจทำงานตอน
โดนยิงหนักกว่านี้ ถ้าต้องการการกันที่แม่นจริงต้องใช้ Durable Object นับแทน หรือ
ผูกโดเมนของตัวเองแล้วใช้ WAF ของ Cloudflare ซึ่งทำงานระดับ zone จึงใช้กับ
`workers.dev` ไม่ได้

ตัวเลขที่วัดได้อยู่ใน [NOTES.md](NOTES.md#rate-limiting-ที่ผูกไว้แล้วแต่ยังกันไม่ได้จริง)

`ODOO_SERVERS` หน้าตาแบบนี้

```json
{
  "default_server": "prod",
  "servers": {
    "prod": { "url": "https://odoo.example.com", "db": "mydb", "username": "bot@example.com", "password": "api-key" }
  }
}
```

## พัฒนาบนเครื่อง

```bash
npm install
cp .dev.vars.example .dev.vars   # แล้วกรอกค่าให้ครบ
npm run dev

npm run typecheck
npm test                          # ไม่ต้องมี Odoo — mock fetch เอา
```

test ครอบเฉพาะตรรกะที่พังเงียบได้และไม่ต้องพึ่ง Odoo จริง — การจับ `*` ของ
`BLOCKED_MODELS`, การอ่าน `ODOO_SERVERS`, การลองใหม่เมื่อ uid ค้าง และการเทียบ
ค่าที่เขียนกับค่าที่ Odoo เก็บจริง

สามในสี่ชุดนั้นมีบั๊กเกิดขึ้นจริงมาแล้ว (`res.users` ที่ไม่จับ `res.users.apikeys`
และ html field ที่ถูกฟ้องผิดว่าค่าไม่เข้า) test จึงเขียนจากสิ่งที่พลาดมาแล้ว
ไม่ใช่จากการไล่ให้ครบทุกไฟล์

[CI](.github/workflows/ci.yml) รันสามอย่างนี้ทุก push และ PR — typecheck, test
และ `wrangler deploy --dry-run` เพื่อจับกรณีที่ compile ผ่านแต่ bundle ไม่ขึ้น

`.dev.vars` ถูก gitignore ไว้แล้ว อย่า commit รหัสผ่านเด็ดขาด

## Deploy

```bash
npx wrangler login

# OAuth ต้องใช้ KV เก็บ client/grant/token — เอา id ที่ได้ไปใส่ wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

npx wrangler deploy

npx wrangler secret put MCP_AUTH_TOKEN     # openssl rand -hex 32
npx wrangler secret put ODOO_URL
npx wrangler secret put ODOO_DB
npx wrangler secret put ODOO_USERNAME
npx wrangler secret put ODOO_PASSWORD
npx wrangler secret put BLOCKED_MODELS     # ir.*,res.users*,res.groups*
```

secret ถูกเข้ารหัสตอนเก็บ และไม่โผล่ใน `wrangler.jsonc`

## ต่อ client

`.mcp.json` ในโฟลเดอร์นี้เป็นไฟล์ของ **Claude Code** ไม่ใช่ของ Worker — มันแค่บอก
client ว่าจะไปคุยกับ endpoint ไหนด้วย token อะไร ไฟล์นี้อ้างค่าจาก environment
จึงไม่มีความลับอยู่ในตัวและ commit ขึ้น git ได้

```json
{
  "mcpServers": {
    "odoo": {
      "type": "streamable-http",
      "url": "${ODOO_MCP_URL:-https://cf-odoo-mcp-server.<subdomain>.workers.dev/mcp}",
      "headers": { "Authorization": "Bearer ${MCP_AUTH_TOKEN}" }
    }
  }
}
```

Claude Code ไม่ได้โหลด `.env` ให้เอง ต้อง export เข้า environment ก่อนเรียก

```bash
cp .env.example .env    # แล้วกรอก MCP_AUTH_TOKEN
set -a; . ./.env; set +a
claude
```

ถ้าลืม export ตัวแปรจะไม่ถูกแทนค่า `claude mcp list` จะเตือนว่าหาตัวแปรไม่เจอ
และ Worker จะตอบ `401` — พังแบบรู้ตัว ไม่ใช่หลุดเงียบ ๆ

`ODOO_MCP_URL` มีไว้ชี้ไป Worker คนละตัวได้ เช่น staging กับ production โดยไม่ต้อง
แก้ `.mcp.json`

client ตัวอื่นที่ไม่ได้อ่าน `.mcp.json` ให้ตั้ง endpoint กับ header `Authorization:
Bearer <token>` เองตามรูปแบบเดียวกัน

`GET /health` ไม่ต้อง auth คืน `{"status":"ok"}`

### ต่อจาก Claude (claude.ai / Desktop / มือถือ)

connector ของ Claude ตั้ง header เองไม่ได้ (ฟีเจอร์นั้นยัง beta) จึงต้องใช้ OAuth
ซึ่ง server นี้รองรับแล้ว — **Customize → Connectors → Add custom connector**

| ช่อง | ใส่อะไร |
| --- | --- |
| URL | `https://<subdomain>.workers.dev/mcp` |
| Authentication | Always required (Claude ตรวจเจอเอง) |
| OAuth client | No client ID — register one automatically (DCR) |

กด Connect แล้วจะเด้งมาหน้า consent ของ server นี้ **ใส่ `MCP_AUTH_TOKEN` แล้วกดอนุญาต**

ที่ใช้ token เดิมเป็นรหัสยืนยันแทนการสร้างบัญชีใหม่ เพราะ server นี้มีความลับตัวเดียว
อยู่แล้ว การเพิ่มอีกตัวคือเพิ่มของที่ต้องดูแลโดยไม่ได้ปลอดภัยขึ้น — ผลคือ token
เดียวทำสองหน้าที่ เป็น static bearer ของ client ที่ส่ง header ได้ และเป็นรหัสหน้า
consent ของ client ที่ส่งไม่ได้ **เปลี่ยน token เมื่อไหร่ต้องต่อ connector ใหม่ด้วย**

ทั้งสองทางลงเอยที่ handler เดียวกัน request ที่พก static bearer ถูกต้องเข้าตรง ๆ
ไม่แตะ OAuth เลย ส่วนที่เหลือตกเป็นของ OAuth provider

## โหมด access (ใช้กับ Cloudflare MCP Portal)

โหมด token (ค่าเริ่มต้น) มีความลับตัวเดียว ทุก grant จึงเป็นผู้ใช้ `shared` คนเดียวกัน
ตั้ง `CONSENT_MODE=access` แล้วหน้า `/authorize` จะ**ไม่ถามรหัส** แต่เชื่อตัวตนที่
Cloudflare Access ยืนยันมาแล้วใน header `Cf-Access-Jwt-Assertion` แทน

- ตรวจ JWT เองทั้ง GET และ POST: RS256 · `kid` อยู่ใน
  `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cache ไว้ เจอ `kid` ใหม่ดึงซ้ำได้
  ไม่เกินนาทีละครั้ง) · ลายเซ็น · `iss` · `aud` · `exp`/`nbf` เผื่อ 60 วินาที ·
  ต้องมี `sub` และ `email` และอีเมลต้องอยู่ใน `ACCESS_ALLOWED_EMAILS`
- ไม่ผ่าน → `403` · ขาด config → `503` (ไม่ถอยกลับไปโหมด token)
- หน้า consent แสดงชื่อแอป client_id และ redirect_uri เต็ม มีปุ่มอนุญาต/ปฏิเสธ
  CSRF เป็น HMAC + nonce ใน `OAUTH_KV` ใช้ได้ครั้งเดียว อายุ 10 นาที
- `userId` ของ grant = hex 32 ตัวแรกของ SHA-256(`cf-odoo-user:<iss>|<sub>`) ผูกกับ
  `sub` ไม่ใช่อีเมล — เปลี่ยนอีเมลยังเป็นคนเดิม · props เก็บแค่ `{user}` ไม่เก็บอีเมล

การเรียก Odoo ยังใช้บัญชีเดิมตัวเดียว (ดูโหมด per_user ข้างล่าง) · โหมดนี้ไม่ต้องตั้ง
`MCP_AUTH_TOKEN` — ไม่ตั้ง `/mcp` ที่ไม่มี token ได้ `401` + `WWW-Authenticate` จาก
OAuth provider ตามปกติ ถ้าตั้งไว้ static bearer ยังใช้ได้

| ตัวแปร | ค่า |
| --- | --- |
| `CONSENT_MODE` | `access` |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | Application Audience (AUD) tag ของ Access app ข้างล่าง |
| `ACCESS_ALLOWED_EMAILS` | อีเมลที่อนุญาต คั่นด้วย comma เทียบตรงตัว (ไม่สนตัวพิมพ์) |
| `CONSENT_CSRF_SECRET` | secret สุ่ม เช่น `openssl rand -hex 32` |
| `MCP_DCR_ENABLED` | ใส่ `true` (ตรงตัว) **ชั่วคราวตอนเชื่อม connector** แล้วลบออก — ค่าอื่นหรือไม่ตั้ง `/register` ตอบ `403 registration_disabled` |
| `MCP_ALLOWED_REDIRECT_HOSTS` | ไม่บังคับ host ของ redirect_uri ที่ยอมรับ คั่นด้วย comma ค่าเริ่มต้น `chatgpt.com,claude.ai,gemini.google.com,dash.cloudflare.com,oauth-callbacks.cloudflareaccess.com` |

ในโหมด access redirect_uri ต้องเป็น `https:` ไม่มี `user:pass` และ host ตรงกับ
`MCP_ALLOWED_REDIRECT_HOSTS` แบบตรงตัว (`claude.ai.evil.com` ไม่ผ่าน) — ตรวจทุก uri
ตอน `/register` และตรวจซ้ำตอน `/authorize` ทั้ง GET และ POST (ไม่ผ่าน → `400
invalid_redirect_uri`) client ที่ใช้ localhost callback จึงต่อผ่าน OAuth ไม่ได้ในโหมดนี้
ให้ใช้ static bearer แทน · โหมด token ไม่อ่านสองตัวแปรนี้ DCR เปิดและรับ
redirect_uri อะไรก็ได้เหมือนเดิม

**ตั้ง Access app (Self-hosted) ให้ครอบเฉพาะ path `/authorize`** แล้วเอา AUD tag
ไปใส่ `ACCESS_AUD` — ห้ามครอบ `/mcp` `/token` `/register` หรือ `/.well-known/*`
เพราะ client เรียกเส้นทางพวกนี้จากฝั่ง server โดยไม่มีคุกกี้ของ Access ถ้าโดนครอบ
จะได้หน้า login แทน JSON แล้ว connector พัง Access ที่เปิดจากหน้า Worker บน
`workers.dev` ครอบทั้ง hostname ไม่แยก path จึงต้องผูก custom domain ก่อน

### audit ราย call (ทุกโหมด)

ทุก `tools/call` เขียน `console.log` หนึ่งบรรทัด JSON ลง Workers Logs
(เปิด `observability` ไว้แล้วใน `wrangler.jsonc`)

```json
{"event":"mcp_call","user":"<userId|shared|bearer>","client_id":"…","client_label":"fwd:…","tool":"odoo_search_read","ok":true,"error_code":null,"ms":182}
```

- `user` — `props.user` ของ grant โหมด access · `shared` สำหรับ grant โหมด token ·
  `bearer` สำหรับ static bearer
- `client_id` — ของ grant OAuth (`null` สำหรับ static bearer)
- `client_label` — `fwd:` + `X-Forwarded-User-Agent` (MCP Portal ส่งต่อมา) ถ้ามี
  ไม่งั้น `ua:` + `User-Agent` ตัดที่ 120 ตัว อักขระนอก ASCII 0x20–0x7E กลายเป็น `?`
  ว่างเป็น `null` — client ตั้งเองได้ **ใช้แสดงผลอย่างเดียว ไม่ใช้ตัดสินสิทธิ์**
- `ok`/`error_code` — `tool_error` เมื่อ tool คืน error · `internal_error` เมื่อโยน exception
- **ไม่ log** argument ผลลัพธ์ อีเมล หรือ token

## โหมด per_user — แต่ละคนใช้บัญชี Odoo ของตัวเอง

โหมด `shared` (ค่าเริ่มต้น) เรียก Odoo ด้วยบัญชีเดียวใน env ทุก call — Odoo จึงไม่รู้
ว่าใครทำ และทุกคนได้สิทธิ์เท่าบัญชีนั้น ตั้ง `ODOO_AUTH_MODE=per_user` แล้วแต่ละคน
ใส่ **API key ของ Odoo ของตัวเอง** ตอนกดอนุญาต tool จะเรียก Odoo ด้วยบัญชีของคนนั้น
Odoo จึงบังคับ ACL และ record rule ของแต่ละคนเอง และ log ฝั่ง Odoo บอกได้ว่าใครทำ

- ใช้ได้เฉพาะคู่กับ `CONSENT_MODE=access` — ไม่งั้น หรือตั้งค่าอื่นนอก `shared`/`per_user`
  ทั้ง `/authorize` และ `/mcp` ตอบ `503`
- ใช้แค่ `url`/`db` ของ default server · ไม่ต้องตั้ง `ODOO_USERNAME`/`ODOO_PASSWORD`
  และถึงตั้งไว้ก็ไม่ถูกใช้ · server อื่นใน `ODOO_SERVERS` ใช้ไม่ได้ (tool ที่ระบุ `server`
  อื่นได้ error)
- **ไม่มี fallback ไปบัญชีกลาง** — grant ที่ออกก่อนเปิดโหมดนี้ หรือ static bearer
  ได้ error `reconnect_required` ทุก tool โดยไม่มี request ไป Odoo เลย
- audit `mcp_call` มี `odoo_uid` (ตัวเลข ไม่ใช่ login)

### สร้าง API key ใน Odoo

Odoo → มุมขวาบน → **My Profile** (หรือ Preferences) → แท็บ **Account Security** →
**New API Key** → ตั้งชื่อ เช่น `mcp-claude` → คัดลอก key (Odoo แสดงครั้งเดียว)
แล้ววางในหน้า consent คู่กับ login ของคุณ — บน Enterprise ต้องเป็น key ชนิด `rpc`
(ดู[หัวข้อ API key 2 ชนิด](#odoo-19-enterprise-มี-api-key-2-ชนิด--เช็คก่อนว่าต้องใช้อันไหน))

### key ผูกกับ grant

- หน้า consent ตรวจ key ด้วย `common.authenticate` ก่อน — ได้ uid เท่านั้นจึงออก grant
  ผิดก็ได้ฟอร์มใหม่พร้อมข้อความกลาง ๆ ที่ไม่บอกว่า login หรือ key ผิด
- key อยู่ใน props ของ grant ซึ่ง OAuthProvider เข้ารหัสด้วย token ของ client เอง —
  server ไม่เขียน key ลง KV เอง ไม่ log และไม่ส่งกลับใน response ใด ๆ
- **เพิกถอน key ใน Odoo = ตัดสิทธิ์ทันที** call ถัดไปได้ `reconnect_required`
- **เปลี่ยน key ต้องเชื่อม connector ใหม่** (Disconnect แล้ว Connect) เพื่อใส่ key ใหม่

## ความปลอดภัย

endpoint นี้เป็น public ทุก request ที่เข้า `/mcp` จึงต้องแนบ bearer token มาด้วย
และเทียบแบบ constant time ในโหมด token ถ้าไม่ได้ตั้ง `MCP_AUTH_TOKEN` ไว้ Worker
จะคืน 500 แทนที่จะเปิดโล่ง ส่วนโหมด access ไม่มี token กลาง `/mcp` รับเฉพาะ access
token ของ OAuth (ไม่มี → `401`)

token ตัวเดียวใช้ร่วมกันเหมาะกับ server ส่วนตัวหรือใช้ภายใน ถ้าต้องแยกตัวตนรายคน
ให้เอา [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
มาคั่นข้างหน้าแทน

## บันทึกจากการใช้งานจริง

[NOTES.md](NOTES.md) บันทึกสิ่งที่ทดสอบกับ Odoo ตัวจริงแล้ว และข้อควรระวังที่สำคัญ
เวลาให้ AI agent เป็นคนสั่ง tool เหล่านี้ — โดยเฉพาะเรื่องที่ Odoo ทิ้งค่าที่เขียนลง
readonly field ไปเงียบ ๆ

## License

MIT
