# cf-odoo-mcp-server

[MCP](https://modelcontextprotocol.io) server สำหรับ Odoo ERP ที่รันบน Cloudflare Workers

ใช้ transport แบบ stateless HTTP — ไม่ต้องใช้ Durable Objects ไม่ต้องมี container
ไม่ต้องมี process รันค้างไว้ อยู่ใน free tier ของ Workers ได้สบาย

พอร์ตมาจาก [odoo-mcp-claude](https://github.com/monthop-gmail/odoo-mcp-claude)
ซึ่งให้ tool ชุดเดียวกัน 10 ตัว แต่รันเป็น Python process คุยผ่าน XML-RPC

## Odoo 19 มี API key 2 ชนิด — เช็คก่อนว่าต้องใช้อันไหน

Odoo 19 ออก API key ได้ 2 scope และใช้แทนกันไม่ได้

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
แถมมันยังปฏิเสธ technical model ให้ด้วย ซึ่งเป็น guardrail ที่ project นี้ไม่มี

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
| `odoo_execute` | method อะไรก็ได้ |
| `odoo_fields_get` | `fields_get` |
| `odoo_read_group` | `formatted_read_group` (ถอยไป `read_group` ถ้าเป็น Odoo รุ่นเก่า) |
| `odoo_context` | ผู้ใช้ บริษัท timezone ภาษา |
| `odoo_get_models` | รายชื่อ model ที่ใช้ได้ |
| `odoo_version` | `common.version` |

## การตั้งค่า

| ตัวแปร | ใช้ทำอะไร |
| --- | --- |
| `MCP_AUTH_TOKEN` | **จำเป็น** bearer token ที่ผู้เรียกต้องแนบมา |
| `ODOO_SERVERS` | JSON รองรับหนึ่งหรือหลาย server ถ้าตั้งไว้จะชนะตัวข้างล่าง |
| `ODOO_URL` `ODOO_DB` `ODOO_USERNAME` `ODOO_PASSWORD` | ทางเลือกสำรองสำหรับ server เดียว |
| `BLOCKED_MODELS` | ไม่บังคับ รายการ model ที่ทุก tool จะปฏิเสธ คั่นด้วย comma ลงท้าย `*` เพื่อจับแบบขึ้นต้น เช่น `ir.*,res.users*` ถ้าไม่ตั้งจะไม่บล็อกอะไรเลย |
| `ALLOWED_MODELS` | ไม่บังคับ ถ้าตั้งไว้ model ต้องตรงรายการนี้ด้วยจึงจะใช้ได้ |
| `ALLOWED_ORIGIN_HOSTNAMES` | ไม่บังคับ รายชื่อ hostname คั่นด้วย comma ที่ยอมให้ browser `Origin` เรียก `/mcp` ได้ หรือใส่ `*` ถ้าไม่ตั้ง จะรับเฉพาะ localhost กับ hostname `workers.dev` ของ Worker เอง — client ฝั่ง server ไม่ส่ง `Origin` มาอยู่แล้วจึงไม่ได้รับผลกระทบ |

ควรใช้ **API key** ของ Odoo แทนรหัสผ่านบัญชี และให้สิทธิ์บัญชีนั้นเท่าที่ tool ต้องใช้จริง —
`odoo_delete` กับ `odoo_write` เข้าถึงได้ทุกอย่างที่บัญชีนั้นเข้าถึงได้

`BLOCKED_MODELS` เป็นรั้วชั้นที่สอง ตั้งได้โดยไม่ต้องไปแก้สิทธิ์ใน Odoo ค่าที่แนะนำ

```
BLOCKED_MODELS="ir.*,res.users*,res.groups*"
```

**ลงท้ายด้วย `*` ด้วย** — `res.users` เฉย ๆ จับได้แค่ตัวมันเอง `res.users.apikeys`
ยังหลุดผ่าน ส่วน `odoo_context` ตั้งใจให้ข้ามรั้วนี้ เพราะมันอ่านแค่ตัวตนของ
connection ที่มีอยู่แล้ว

Odoo กัน private method และซ่อนตาราง ACL ออกจาก RPC ให้อยู่แล้ว รั้วนี้จึงมีไว้
คุมคนละแกน คือ model ที่เข้าถึงผ่าน CRUD ปกติได้ — รายละเอียดที่วัดมาอยู่ใน
[NOTES.md](NOTES.md#odoo-กันอะไรให้แล้วบ้างใน-rpc)

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
```

`.dev.vars` ถูก gitignore ไว้แล้ว อย่า commit รหัสผ่านเด็ดขาด

## Deploy

```bash
npx wrangler login
npx wrangler deploy

npx wrangler secret put MCP_AUTH_TOKEN     # openssl rand -hex 32
npx wrangler secret put ODOO_URL
npx wrangler secret put ODOO_DB
npx wrangler secret put ODOO_USERNAME
npx wrangler secret put ODOO_PASSWORD
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

## ความปลอดภัย

endpoint นี้เป็น public ทุก request ที่เข้า `/mcp` จึงต้องแนบ bearer token มาด้วย
และเทียบแบบ constant time ถ้าไม่ได้ตั้ง `MCP_AUTH_TOKEN` ไว้ Worker จะคืน 500
แทนที่จะเปิดโล่ง

token ตัวเดียวใช้ร่วมกันเหมาะกับ server ส่วนตัวหรือใช้ภายใน ถ้าต้องแยกตัวตนรายคน
ให้เอา [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
มาคั่นข้างหน้าแทน

## บันทึกจากการใช้งานจริง

[NOTES.md](NOTES.md) บันทึกสิ่งที่ทดสอบกับ Odoo ตัวจริงแล้ว และข้อควรระวังที่สำคัญ
เวลาให้ AI agent เป็นคนสั่ง tool เหล่านี้ — โดยเฉพาะเรื่องที่ Odoo ทิ้งค่าที่เขียนลง
readonly field ไปเงียบ ๆ

## License

MIT
