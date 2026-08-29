# บันทึกจากการใช้งานจริง

server ตัวนี้ทำอะไรได้ดีและไม่ดีบ้าง จากการทดสอบ tool ทุกตัวกับ Odoo จริง

วัดกับสามเครื่อง เพราะพฤติกรรมหลายอย่างต่างกันตามเวอร์ชันและแพลตฟอร์ม

| | ใช้ทดสอบอะไร |
| --- | --- |
| **SaaS 19.4 Enterprise** | ทุกอย่างที่อ่านได้ ผ่าน Worker ที่ deploy จริง |
| **19.0 Community** (ลงเอง) | สิ่งที่ต้องเขียนหรือลบ บน database ที่ทิ้งได้ |
| **18.0** (self-hosted) | เส้นทาง fallback ของ `odoo_read_group` |

ตรงไหนที่ผลต่างกันระหว่างเครื่อง เขียนกำกับไว้ — อย่าเอาผลจากเครื่องหนึ่งไปสรุป
แทนอีกเครื่อง

นี่คือข้อควรระวังตอนใช้งาน ไม่ใช่ changelog ส่วนใหญ่เป็นพฤติกรรมของ Odoo เองที่โผล่
ออกมา ไม่ใช่บั๊กของ server ตัวนี้ — ซึ่งเป็นเหตุผลว่าทำไมยิ่งต้องจดไว้ เพราะ agent
เดาเองไม่ได้

## สารบัญ

- [อ่านเลขเวอร์ชันยังไง](#อ่านเลขเวอร์ชันยังไง) — 19.0 กับ saas~19.4 ต่างกันยังไง ดู edition จากไหน
- [ทดสอบแล้ว](#ทดสอบแล้ว) — tool ไหนวัดกับเครื่องไหนแล้วบ้าง
- [ข้อควรระวังสำหรับ AI agent](#ข้อควรระวังสำหรับ-ai-agent) — พฤติกรรมที่ agent เดาจาก schema ไม่ได้
- [ความเข้ากันได้กับ client](#ความเข้ากันได้กับ-client) — CORS · accept header · เวอร์ชัน protocol
- [ขอบเขตที่รู้อยู่](#ขอบเขตที่รู้อยู่) — สิ่งที่ tool ชุดนี้ไม่ได้ทำให้
- [Odoo กันอะไรให้แล้วบ้างใน RPC](#odoo-กันอะไรให้แล้วบ้างใน-rpc) — รั้วในตัวของ Odoo และสิ่งที่มันไม่กัน
- [ใช้บัญชีเฉพาะแทน admin](#ใช้บัญชีเฉพาะแทน-admin) — สูตรบัญชีสิทธิ์ต่ำที่ทดสอบแล้ว
- [เทียบกับ MCP server ในตัวของ Odoo](#เทียบกับ-mcp-server-ในตัวของ-odoo) — ของ Odoo เองทำอะไรได้ (Enterprise เท่านั้น)
- [`read_group` หายไปใน saas~19.4 แต่ยังอยู่ใน 19.0](#read_group-หายไปใน-saas194-แต่ยังอยู่ใน-190) — ต่างกันระหว่างเวอร์ชัน และเส้นทาง fallback
- [ทำไม Claude chat ต้องใช้ OAuth](#ทำไม-claude-chat-ต้องใช้-oauth) — connector ตั้ง header ไม่ได้ จึงต้องมี OAuth
- [Gemini ต่อผ่าน OAuth ได้ และตอบถูกทุกข้อตั้งแต่ครั้งแรก](#gemini-ต่อผ่าน-oauth-ได้-และตอบถูกทุกข้อตั้งแต่ครั้งแรก) — client เจ้าที่สาม ยืนยัน `has_more` ข้าม vendor
- [Rate limiting ที่ผูกไว้แล้วแต่ยังกันไม่ได้จริง](#rate-limiting-ที่ผูกไว้แล้วแต่ยังกันไม่ได้จริง) — วัดแล้วไม่ปฏิเสธ request ที่แยกกัน
- [เรื่อง deploy](#เรื่อง-deploy) — ข้อควรระวังตอนยิงทดสอบหลัง deploy

## อ่านเลขเวอร์ชันยังไง

มีสองแกนที่คนละเรื่องกัน และสับสนกันบ่อย

**แกนที่หนึ่ง คือช่องทางที่รัน** `19.0` คือ release ที่โหลดไปลงเอง ส่วน `saas~19.4`
คือ Odoo Online ซึ่งเดินเลขไปไกลกว่า release ที่ลงเองได้ พฤติกรรมบางอย่างจึงต่างกัน
ทั้งที่ขึ้นต้นด้วย 19 เหมือนกัน — `read_group` ที่หายไปใน `saas~19.4` แต่ยังอยู่ใน
`19.0` เป็นตัวอย่างตรง ๆ

**แกนที่สอง คือ edition** Community หรือ Enterprise ซึ่งกำหนดว่ามีโมดูลอะไรบ้าง
ดูจากท้ายเลขเวอร์ชันได้ `saas~19.4+e` มี `+e` คือ Enterprise ส่วน `19.0-20260817`
ไม่มี คือ Community

เอกสารนี้จึงเขียนแยกเสมอว่าอันไหนวัดจาก **SaaS 19.4 Enterprise** และอันไหนจาก
**19.0 Community** เพราะรู้แค่ "Odoo 19" ไม่พอที่จะบอกว่าจะเจอพฤติกรรมแบบไหน

## ทดสอบแล้ว

ยิง tool ครบทั้ง 13 ตัวกับ database จริง ทั้งบน SaaS 19.4 Enterprise และ 19.0
Community ที่ลงเอง

| Tool | SaaS 19.4 | 19.0 CE |
| --- | --- | --- |
| `odoo_version` | `saas~19.4+e` | `19.0-20260817` |
| `odoo_list_servers` | ✅ | ✅ |
| `odoo_context` | `Asia/Bangkok` | `Europe/Brussels` |
| `odoo_get_models` | ✅ | ✅ |
| `odoo_fields_get` | 120 fields | ✅ |
| `odoo_search_count` | ✅ | 39 |
| `odoo_search_read` | `fields` `limit` `order` และ domain `'\|'` ✅ | ✅ |
| `odoo_read` | ✅ | ✅ |
| `odoo_read_group` | `__count` `id:max` `create_date:month` ✅ | ✅ |
| `odoo_execute` | `name_search` ✅ | ✅ |
| `odoo_create` | ✅ พร้อม record ที่เก็บจริง | ✅ |
| `odoo_write` | ✅ | ✅ |
| `odoo_delete` | ✅ จำนวนกลับเท่าเดิม | ✅ |

`fields_not_applied` จับได้ทั้งสองเครื่อง แต่คนละ field เพราะแต่ละรุ่นทิ้งคนละตัว —
SaaS ทิ้ง `is_company` ตอน `create` ส่วน CE ทิ้ง `complete_name` ซึ่งเป็น computed
field กลไกเดียวกันทำงานทั้งคู่โดยไม่ต้องรู้ล่วงหน้าว่า field ไหนจะโดน

ข้อความที่ไม่ใช่ ASCII ผ่านไปกลับได้ถูกต้องทั้งสองเครื่อง — ชื่อบริษัทและชื่อจังหวัด
ภาษาไทยผ่าน create → read → write โดยไม่เพี้ยน

ความล้มเหลวเด้งกลับมาเป็น tool error ที่พก exception ของ Odoo มาด้วย ไม่ใช่
transport error ทำให้ model อ่านแล้วแก้เองได้

```
Error: builtins.ValueError: Invalid field 'login_date' on 'res.partner'
Error: odoo.exceptions.UserError: Object res.nope doesn't exist
```

## ข้อควรระวังสำหรับ AI agent

### Odoo ทิ้งค่าที่เขียนลง readonly field ไปเงียบ ๆ

สร้าง partner ด้วย `is_company: true` จะได้ id ใหม่กลับมาและดูเหมือนสำเร็จทุกอย่าง
แต่พออ่าน record ที่เก็บจริงกลับมาได้ `is_company: false` — Odoo ไม่ error ไม่เตือน
มันทิ้งค่านั้นไปเฉย ๆ

ตอนนี้ `odoo_create` กับ `odoo_write` อ่าน field ที่เขียนไปกลับมาคืนให้ด้วย และ
ระบุ field ที่ Odoo ไม่ได้เก็บไว้ใต้ `fields_not_applied`

```json
{
  "id": 12,
  "record": { "id": 12, "name": "Prod ReadBack", "is_company": false },
  "fields_not_applied": ["is_company"],
  "warning": "Odoo did not store these fields..."
}
```

มี 2 อย่างที่มันไม่ทำ อย่างแรกการเทียบเป็นแบบ best-effort: มันข้าม x2many command
list กับ nested write ซึ่งไม่มีรูปแบบที่เก็บไว้ให้เทียบได้ และถือว่าการ normalise ของ
html field คือค่าเข้าแล้ว — เขียน `"ok"` ลง `comment` แล้ว Odoo เก็บเป็น `"<p>ok</p>"`
นั่นคือค่าเข้าไม่ใช่ถูกทิ้ง อย่างที่สองมันข้ามการอ่านกลับเมื่อเขียนเกิน 50 record
เพื่อไม่ให้ call เดียวกลายเป็น unbounded read

ที่น่ารู้คือ field เดียวกันให้ผลต่างกันได้ทั้งระหว่าง call และระหว่างเวอร์ชัน

| | `create` ด้วย `is_company: true` | field `company_type` |
| --- | --- | --- |
| SaaS 19.4 | ถูกทิ้ง — อ่านกลับได้ `false` | ไม่มี (`Invalid field`) |
| 19.0 Community | เก็บ — อ่านกลับได้ `true` | มี |

และบน SaaS ตัวเดียวกัน `write` เก็บค่าให้ ทั้งที่ `create` ทิ้ง ทำซ้ำได้ทุกครั้ง

เหตุผลจะเป็นอะไรก็ตาม มันไม่ใช่สิ่งที่ agent เดาได้จาก schema — `fields_get` บอกว่า
`readonly: true` เหมือนกันหมด ซึ่งคือเหตุผลทั้งหมดที่ต้องอ่านกลับแทนการเชื่อค่าที่
return มา และเป็นเหตุผลที่ห้ามเอาผลทดสอบจากเวอร์ชันหนึ่งไปสรุปแทนอีกเวอร์ชัน

### `odoo_read_group` ที่ใส่ `limit` เคยนับได้ไม่ครบเงียบ ๆ

จับได้จากการใช้งานจริงบน Claude chat ไม่ใช่จากการทดสอบเอง เพราะการทดสอบด้วย
curl ตลอดมาไม่เคยขอให้ใครสรุปยอดจากผลที่ถูกตัด

ถามว่า "ประเทศที่บังคับกรอก zip มีกี่ประเทศ แยกตามสกุลเงิน" แล้วได้ตารางสกุลเงิน
**ถูกทุกแถว** รวมถึงรายละเอียดปลีกย่อยอย่าง "4 สกุลที่มี 2 ประเทศ" แต่ยอดรวมผิด

| | ที่รายงาน | ของจริง |
| --- | --- | --- |
| ประเทศที่บังคับ zip | 195 | **241** |
| สกุลที่มี 1 ประเทศ | 86 | **132** |

ทั้งสองตัวขาดไป 46 เท่ากัน ซึ่งตรงกับจำนวนกลุ่มที่มองไม่เห็น สาเหตุคือ tool คืน
เฉพาะกลุ่มที่ขอมาโดยไม่บอกว่ายังมีอีก ผลที่ถูกตัดจึงหน้าตาเหมือนผลที่ครบ

ตอนนี้ถ้า `limit` ทำให้ผลถูกตัด จะได้ `has_more` กับ `total_records` มาด้วย

```json
{
  "groups": [ ... 11 แถว ... ],
  "has_more": true,
  "total_records": 241,
  "warning": "Showing 11 of more groups. Summing the rows above does not give the total — 241 records match this domain."
}
```

วิธีรู้ว่าถูกตัดคือขอมา `limit + 1` กลุ่ม ถ้าได้เกินที่ขอแปลว่ายังมีอีก แล้วค่อยยิง
`search_count` เพิ่มอีกครั้ง — **เฉพาะตอนถูกตัดเท่านั้น** กรณีปกติจึงไม่มีต้นทุนเพิ่ม

`groups` เป็น key เสมอไม่ว่าจะถูกตัดหรือไม่ เพราะ shape ที่เปลี่ยนตามข้อมูลคือสิ่งที่
agent ตีความพลาดได้ง่ายที่สุด

**นี่คือบั๊กตระกูลเดียวกับที่เจอมาทั้ง project** — `fields_not_applied` (เขียนสำเร็จ
แต่ค่าไม่เข้า), `search_read` default 50 (ดึงมาไม่ครบแต่ดูเหมือนครบ) และอันนี้
ทุกตัวคือ "สำเร็จแต่ไม่จริง โดยไม่มีสัญญาณเตือน"

**ยืนยันแล้วว่าการแก้ได้ผล** ถามคำถามเดิมกับ ChatGPT หลัง deploy ได้ **241** ถูกต้อง
พร้อม **147 สกุลเงิน** และ **132 สกุลที่มีประเทศเดียว** ตรงทุกตัว ต่างจาก Claude
ตอนก่อนแก้ที่ได้ 195 กับ 86

ที่น่าสนใจกว่านั้นคือมันไม่ได้แค่รายงาน `total_records` ที่ tool ยื่นให้ แต่**ไล่ดึง
กลุ่มที่เหลือมาด้วย** จึงตอบจำนวนสกุลเงินได้ ทั้งที่ไม่ได้อยู่ใน 11 แถวแรก — `has_more`
ทำหน้าที่เป็นสัญญาณให้ตามต่อ ไม่ใช่แค่คำเตือน

### `odoo_read` กับ id ที่ไม่มี คืน `[]` ไม่ใช่ error

ถูกลบไปแล้ว ไม่เคยมี และมองไม่เห็นเพราะไม่มีสิทธิ์ — สามอย่างนี้แยกกันไม่ออก
ใช้ `odoo_search_count` เพื่อแยก "หายไปแล้ว" ออกจาก "ไม่มีสิทธิ์"

### `odoo_search_read` คืน 50 record ถ้าไม่ได้สั่งเป็นอย่างอื่น

Odoo ไม่มีเพดานของตัวเอง เมื่อก่อนไม่ใส่ `limit` จึงคืนทุก record ที่ตรงเงื่อนไข
ตอนนี้ default เป็น 50 ถ้าต้องการมากกว่านั้นให้ระบุเองอย่างตั้งใจ — `ir.model.fields`
บน database มาตรฐานมีเกิน 4,500 แถว การอ่าน model ขนาดนั้นแบบไม่จำกัดจะกิน
context ของผู้เรียกจนหมดก่อนที่ Odoo จะบ่นเสียอีก

## ความเข้ากันได้กับ client

**connector ฝั่ง server ใช้ได้** request ที่ไม่มี header `Origin` ซึ่งก็คือ MCP client
ฝั่ง server ทุกตัว ผ่านได้หมด

**client ที่รันบน browser ถูกปฏิเสธถ้าไม่ได้ตั้งค่า** preflight จาก browser origin
จะได้ `403` เป็นค่าเริ่มต้น เพราะ handler เชื่อแค่ localhost กับ hostname `workers.dev`
ของ endpoint เอง ตั้ง `ALLOWED_ORIGIN_HOSTNAMES` เป็นรายชื่อ hostname คั่นด้วย comma
หรือ `*` เพื่อขยาย origin ที่อยู่นอกรายชื่อยังได้ `403` อยู่ดี และต้องมี bearer token
ทั้งสองกรณี

**ต้องส่ง accept ทั้งสองแบบ** client ต้องส่ง `Accept: application/json, text/event-stream`
ถ้าส่งแค่อันแรกหรือไม่ส่ง header เลยจะได้ `406` ตาม spec ของ streamable-HTTP

**เวอร์ชัน protocol** `initialize` negotiate ลงมาที่ `2025-11-25` แม้ client จะเสนอ
`2026-07-28` มาก็ตาม

## ขอบเขตที่รู้อยู่

`odoo_execute` เรียกได้เฉพาะ **public method** เท่านั้น ไม่ใช่ "method อะไรก็ได้"
อย่างที่เข้าใจกันบ่อย ๆ เพราะ Odoo กัน private method ไว้เองแล้ว (ดูหัวข้อข้างล่าง)
แต่ public method ก็รวม `write` และ `unlink` บนทุก model ที่บัญชีนั้นเข้าถึงได้ ซึ่ง
กว้างพอที่จะต้องคุมด้วย `BLOCKED_MODELS`

Worker ที่ deploy แล้ววิ่งเข้า Odoo ที่ผูก `127.0.0.1` ไม่ได้ การทดสอบกับ 19.0 CE
ทั้งหมดจึงรันผ่าน `wrangler dev --local` ซึ่งอยู่เครื่องเดียวกับ Odoo ถ้าจะใช้ Worker
ตัวจริงกับ Odoo ที่ลงเอง ต้องทำให้เข้าถึงได้จากอินเทอร์เน็ตก่อน นี่เป็นข้อจำกัดของ
เครือข่าย ไม่ใช่ความเข้ากันได้ของ tool

`fields_not_applied` รายงานเฉพาะ field ที่มันมั่นใจ นอกนั้นเงียบ — เพราะการเตือนผิด
จะส่ง agent ไปไล่แก้สิ่งที่เขียนสำเร็จอยู่แล้ว ถ้าค่าไหนสำคัญจริง ให้อ่านจาก `record`
ที่คืนมา

คำถามที่ค้างมาตั้งแต่ทำ feature นี้คือ agent จะรายงานตามจริงหรือจะปัดเศษว่าสำเร็จ
หมด **ตอบได้แล้วว่ารายงานตามจริง** ChatGPT สร้าง contact พร้อมส่ง `complete_name`
ที่เขียนไม่ได้เข้าไปด้วย แล้วแยกรายงานว่า name เข้า ส่วน `complete_name` ไม่เข้า
พร้อมอธิบายสาเหตุถูกว่า Odoo คำนวณเอง ตรวจกับ Odoo แล้วว่าตรงจริง

## Odoo กันอะไรให้แล้วบ้างใน RPC

วัดกับ SaaS 19.4 ด้วยบัญชีที่เป็น `base.group_system` (ยืนยันด้วย
`has_group(2, 'base.group_system')` → `true`) เพื่อดูว่าเหลืออะไรให้ต้องกันเอง

### กันให้แล้ว 2 อย่าง

**private method เรียกจากภายนอกไม่ได้**

```
_read        → AccessError: Private methods (such as 'res.partner._read')
               cannot be called remotely.
check_access → ถูกกันด้วยเหตุผลเดียวกัน
```

ปิด internal API ทั้งชุด ไม่ว่าผู้เรียกจะมีสิทธิ์แค่ไหน

**ตาราง ACL ไม่ถูก expose — เฉพาะบน SaaS**

```
SaaS 19.4:      ir.model.access → Object ir.model.access doesn't exist
                ir.rule         → Object ir.rule doesn't exist
19.0 Community: ir.model.access → 171 แถว
                ir.rule         → 42 แถว
```

สังเกตว่าฝั่ง SaaS ไม่ใช่ "ไม่มีสิทธิ์" แต่เป็น "ไม่มี object นี้" คือถูกตัดออกจาก
registry ฝั่ง RPC ไปเลย

**แต่นี่ไม่ใช่พฤติกรรมของ Odoo 19 ทั่วไป** — บน 19.0 Community ที่ลงเอง ทั้งสอง
ตารางอ่านได้ตามปกติ เป็นข้อจำกัดของแพลตฟอร์ม SaaS ไม่ใช่ของตัว Odoo เพราะฉะนั้น
ถ้ารัน Odoo เอง อย่าไปคาดหวังชั้นป้องกันนี้

### ที่ยังเปิดอยู่

| model | อ่านได้ |
| --- | --- |
| `ir.cron` | 22 แถว |
| `ir.actions.server` | 70 แถว รวมถึง field `code` ที่เก็บ Python |
| `res.users` | 1 |
| `res.groups` | 21 |
| `ir.config_parameter` | 31 |

ทั้งหมดนี้เข้าถึงผ่าน `search_read` / `write` ซึ่งเป็น public method ปกติ — Odoo
ตั้งใจปล่อยให้ระบบสิทธิ์เป็นตัวตัดสิน และเมื่อบัญชีเป็น admin ก็คือผ่านหมด

**สิทธิ์เขียนวัดแล้วบน 19.0 Community** (ทดสอบบน database ที่ทิ้งได้ ไม่ได้แตะ ERP จริง)
โดยใช้บัญชี admin ผ่าน RPC

```
odoo_write  ir.cron           → written: true   แก้ชื่องานตามตารางเวลาได้
odoo_create ir.actions.server → id 90 สร้างได้ พร้อม field code ที่เก็บ Python
```

สองอย่างนี้ต่อกันได้เป็นการรันโค้ดบนเครื่อง Odoo: สร้าง server action ที่มีโค้ด
แล้วตั้ง cron ให้เรียก ทั้งคู่เป็น public method บน model ที่ expose อยู่ ไม่มีอะไร
ใน Odoo ขวางนอกจากสิทธิ์ของบัญชี นี่คือเหตุผลที่เป็นรูปธรรมที่สุดของ `BLOCKED_MODELS`

(ลบ record ที่สร้างทดสอบและคืนชื่อ cron เดิมเรียบร้อยแล้ว)

### ทำไม `BLOCKED_MODELS` ไม่ซ้ำซ้อน

สองอย่างนี้คุมคนละแกน

| | คุมอะไร |
| --- | --- |
| ของ Odoo | **แกน method** — ห้ามเรียก internal API |
| `BLOCKED_MODELS` | **แกน model** — ห้ามแตะ model นี้ แม้ใช้ method ที่ public ตามปกติ |

Odoo ไม่ได้จำกัดว่า model ไหนที่ผู้ใช้ที่ authenticate แล้วเข้าถึงได้ผ่าน CRUD ปกติ
`odoo_write` ลง `ir.config_parameter` หรือ `ir.cron` จึงเป็นการเรียก public method
บน model ที่ expose อยู่ ไม่มีอะไรใน Odoo ขวาง นอกจากสิทธิ์ของบัญชี

`BLOCKED_MODELS` เป็นรั้วที่ตั้งได้โดยไม่ต้องไปรื้อสิทธิ์ใน Odoo ซึ่งกระทบผู้ใช้จริง
แต่มันเป็นรั้วชั้นที่สอง ไม่ใช่ชั้นแรก — ทางแก้ที่ต้นเหตุคือให้ MCP ใช้บัญชีเฉพาะ
ที่มีสิทธิ์เท่าที่งานต้องใช้ แทนบัญชี admin ดูสูตรที่ใช้จริงในหัวข้อ
[ใช้บัญชีเฉพาะแทน admin](#ใช้บัญชีเฉพาะแทน-admin)

### บน Community มีรั้วชั้นเดียว

ทดสอบเส้นทางยกระดับสิทธิ์ทั้งหมดบน 19.0 Community ด้วยบัญชี admin ผ่าน RPC
(database ที่ทิ้งได้ ลบ record ที่สร้างทุกตัวแล้ว)

| ทำอะไร | ผล |
| --- | --- |
| `create ir.model.access` | **สำเร็จ** — เขียนสิทธิ์ให้ตัวเองได้ |
| `create res.users` | **สำเร็จ** |
| `write res.users` | **สำเร็จ** |
| `create ir.config_parameter` | **สำเร็จ** |
| `write ir.cron` | **สำเร็จ** |
| `create ir.actions.server` (มี Python) | **สำเร็จ** |
| อ่าน `res.users.apikeys` | **สำเร็จ** |
| อ่าน `ir.attachment` | **สำเร็จ** |

สิ่งเดียวที่ Odoo กันเองคือ private method ที่เหลือขึ้นกับสิทธิ์ของบัญชีล้วน ๆ
และ admin ก็ผ่านหมด

**เทียบกับ SaaS แล้ว Community เปิดกว้างกว่า** เพราะ SaaS ยังซ่อน `ir.model.access`
กับ `ir.rule` ออกจาก RPC ให้ ส่วน Community ไม่ซ่อน ใครรัน Odoo เองด้วยบัญชี admin
จึงยิ่งต้องตั้ง `BLOCKED_MODELS` ไม่ใช่ตั้งก็ได้ไม่ตั้งก็ได้

### รั้วของ project นี้บน Community

ตั้ง `BLOCKED_MODELS="ir.*,res.users*,res.groups*"` ตามที่ README แนะนำ แล้ววัดซ้ำ

```
ir.model.access ir.rule ir.cron ir.actions.server ir.config_parameter
res.users res.users.apikeys res.groups ir.attachment   → ปฏิเสธทั้งหมด
res.partner                                            → 39 แถว ใช้ได้ตามปกติ
```

พฤติกรรมพิเศษสองอย่างทำงานตามที่ออกแบบ

- `odoo_execute` โดนรั้วด้วย ลองเรียก `create` บน `ir.model.access` ผ่านมันก็ถูก
  ปฏิเสธ ปิดช่องหลบที่กว้างที่สุด
- `odoo_context` ข้ามรั้วตามตั้งใจ ยังคืน uid บริษัท timezone ได้แม้ `res.users*`
  ถูกบล็อก
- `odoo_get_models` กรองผลลัพธ์ตามรั้ว — ค้น `ir.` ได้ `count: 0` กับ
  `hidden_by_policy: 42`

## ใช้บัญชีเฉพาะแทน admin

`BLOCKED_MODELS` กันได้เฉพาะทางเข้า `/mcp` ส่วนสิทธิ์ของบัญชี Odoo เป็นรั้วที่
เลี่ยงไม่ได้ไม่ว่าจะเข้าทางไหน ทำอันนี้แล้วอันแรกจะกลายเป็นของแถม

### สูตรที่ใช้จริง

```
name       MCP Bot
login      ต้องเป็นรูปแบบอีเมลบน Odoo Online (บน Community ใช้ชื่อธรรมดาได้)
group_ids  [base.group_user, base.group_partner_manager]
           ห้ามมี base.group_system
tz         ตั้งด้วย — ไม่ตั้งจะเป็น false แล้ว odoo_context จะบอก agent ว่าไม่มี
           timezone ซึ่งพาไปคำนวณเวลาผิด
```

**ชื่อ field เปลี่ยนใน Odoo 19** จาก `groups_id` เป็น `group_ids` — ตรวจแล้วทั้ง
19.0 Community และ SaaS 19.4 Enterprise เหมือนกันทั้งคู่ ไม่ใช่เรื่องเฉพาะรุ่นใด
ตัวอย่างโค้ดเก่าเกือบทั้งหมดยังเป็นชื่อเดิม

`base.group_user` อย่างเดียวไม่พอ — สร้าง `res.partner` ไม่ได้ ต้องเติม
`base.group_partner_manager` (กลุ่ม "Contact / Creation") กลับเข้าไป นี่คือ
ลักษณะของ least privilege ที่ต้องไล่เติมสิ่งที่ใช้จริงทีละอย่าง ไม่ใช่ตั้งครั้งเดียวจบ

### วัดผลแล้ว

เส้นทางที่ admin ทำได้ทั้งหมด bot ทำไม่ได้ และ Odoo เป็นคนปฏิเสธเอง

| | admin | bot |
| --- | --- | --- |
| `create ir.model.access` | ✅ | ❌ |
| `read/write/create ir.cron` | ✅ | ❌ |
| `create ir.actions.server` | ✅ | ❌ |
| `create res.users` | ✅ | ❌ |
| `create ir.config_parameter` | ✅ | ❌ |
| CRUD `res.partner` | ✅ | ✅ |

### tool ที่ใช้ไม่ได้กับบัญชีสิทธิ์ต่ำ

**`odoo_get_models`** อ่าน `ir.model` ซึ่ง Odoo สงวนไว้ให้กลุ่ม Access Rights
(`base.group_erp_manager`) หรือ Administrator เท่านั้น bot จึงเรียกไม่ได้

```
admin → ir.model  300 models
bot   → ir.model  AccessError
```

**อย่าให้กลุ่มนั้นเพื่อแก้** — Access Rights คือกลุ่มที่จัดการ ACL ได้ ให้ไปเท่ากับ
คืนสิทธิ์ที่เพิ่งอุดไปทั้งหมด ยอมเสีย tool ตัวเดียวคุ้มกว่า อีก 12 ตัวใช้ได้ครบ
รวมทั้ง create write และ delete

### API key

bot สร้าง key ของตัวเองได้ ไม่ต้องพึ่ง admin — ตรวจแล้วว่ามีสิทธิ์ใช้ wizard
`res.users.apikeys.description` และเห็น scope ทั้ง `rpc` กับ `mcp`

ในหน้าเว็บอยู่ที่ avatar มุมขวาบน → My Profile → แท็บ Account Security

ระหว่างที่ยังไม่มี key ใช้รหัสผ่านของ bot แทนได้ ทำงานเหมือนกัน API key ดีกว่า
ตรงที่ revoke แยกได้โดยไม่กระทบการล็อกอิน

## เทียบกับ MCP server ในตัวของ Odoo

Odoo 19 **Enterprise** มี MCP server ของตัวเองที่ `/mcp` เข้าถึงด้วย API key ชนิด
`mcp` — **Community ไม่มี** ทั้งหัวข้อนี้จึงใช้กับ Enterprise เท่านั้น

ทุกอย่างข้างล่างนี้วัดกับ instance เดียวกับที่ใช้ทดสอบ project นี้ (SaaS 19.4
Enterprise) จึงเทียบกันได้ตรง ๆ

มันบอกตัวเองว่า `{"name": "Odoo", "version": "1.0.0"}` และ negotiate protocol
`2025-11-25`

**มันมาจาก module `ai_mcp` ซึ่งเป็น Enterprise** — ตรวจจาก `ir.module.module` บน
instance ที่ใช้ทดสอบ

| module | license |
| --- | --- |
| `ai_mcp` ("AI MCP Server") | `OEEL-1` |
| `ai`, `ai_fields`, `ai_server_actions`, `ai_website` | `OEEL-1` |

`OEEL-1` คือ Odoo Enterprise Edition License แปลว่า **ทางเลือกทั้งหมดในหัวข้อนี้
ใช้ได้เฉพาะบน Enterprise**

ยืนยันกับ 19.0 Community ที่ลงเองแล้ว

```
POST /mcp                      → 404
module ที่ขึ้นต้นด้วย ai        → ไม่มีสักตัว
```

เรื่อง API key มีรายละเอียดที่เดาจากข้างนอกไม่ได้ field `scope` บน
`res.users.apikeys` เป็น `char` และมีอยู่ใน `base` **ทั้งสองรุ่นเหมือนกัน** สิ่งที่
`ai_mcp` เติมเข้ามาคือ field `scope` **ใน wizard ตอนสร้าง key**

| wizard `res.users.apikeys.description` | field `scope` |
| --- | --- |
| 19.0 Community | ไม่มี |
| SaaS 19.4 Enterprise | `selection: [["rpc","RPC"], ["mcp","MCP"]]` |

ผลคือบน Community ตารางรองรับ scope อยู่แล้ว แต่หน้าจอไม่มีที่ให้เลือก key ที่
สร้างจาก UI จึงเป็น `rpc` เสมอ ซึ่งพอสำหรับ project นี้เพราะใช้ `/jsonrpc`

### มันให้อะไรมา

5 tools อ่านอย่างเดียวทั้งหมด

| Tool | ทำอะไร |
| --- | --- |
| `ai_tool_mcp_retrieve_initial_context` | timezone ผู้ใช้ และบริษัทที่ active |
| `ai_tool_get_models` | model ที่ agent แตะได้ |
| `ai_tool_get_fields` | นิยาม field ของ model |
| `ai_tool_search` | ค้นหาและอ่าน |
| `ai_tool_read_group` | aggregate แบบจัดกลุ่ม |

ไม่มี tool สำหรับเขียนเลย `ai_tool_create` `ai_tool_write` และ `ai_tool_unlink`
คืน `The tool '...' doesn't exist` เหมือนกับตอนที่ใส่ชื่อ tool มั่ว ๆ เข้าไป

การอ่านอย่างเดียวไม่ใช่ค่าที่ปรับได้ ตอนสร้าง key ชนิด `mcp` บน 19.4 ไม่มี scope
ให้เลือกเลย — ต่างจากบทความภายนอกที่เขียนว่ามีระดับ read-only กับ read-write
ในหน้าจอสร้าง key มี `mcp` แบบเดียว และได้ 5 tools นี้เท่านั้น การเขียนลง Odoo
ต้องใช้ key ชนิด `rpc` ไม่ว่าจะผ่าน project นี้หรืออย่างอื่น

### จุดที่มันดีกว่า

**ไม่ต้องรันอะไรเลย** ไม่ต้อง deploy ไม่ต้องมี hosting และไม่ต้องมีสำเนารหัส Odoo
อยู่นอก Odoo — ข้อนี้ project นี้เทียบไม่ได้ตามธรรมชาติ

สองข้อที่เคยเป็นข้อได้เปรียบของมัน ตอนนี้ปิดช่องไปแล้ว

- **บอกบริบทให้ agent** ของมันคือ `retrieve_initial_context` ของเราคือ
  `odoo_context` ซึ่งคืนผู้ใช้ บริษัท timezone ภาษา พร้อมกำชับเรื่อง UTC เหมือนกัน
- **กันไม่ให้แตะ technical model** ของมันเป็น allowlist ตายตัว 116 models
  ของเราเป็น `BLOCKED_MODELS` ที่ตั้งเองได้ ต่างกันตรงที่ของมันปลอดภัยโดยไม่ต้อง
  ตั้งอะไร ส่วนของเราต้องตั้งเอง ถ้าไม่ตั้งก็ไม่กันอะไรเลย

### จุดที่จะทำให้ agent สะดุด

**`domain` เป็น string ที่บรรจุ Python ไม่ใช่ JSON** schema ระบุชนิดเป็น `string`
ขณะที่ description เขียนว่า "Use an empty list" และเนื้อในถูก eval เป็น Python literal

```
[["is_company","=",true]]                    -> "should be 'string'"
"[\"|\",(\"is_company\",\"=\",true),...]"  -> malformed: Name(id='true')
"[\"|\",(\"is_company\",\"=\",True),...]"  -> ใช้ได้
```

`true` ของ JSON พัง ต้องเป็น `True` แบบ Python — agent ที่เห็น `"type": "string"`
จะเดาเป็น JSON ก่อนแทบทุกครั้ง ส่วน project นี้รับ domain เป็น array จริง ๆ

**output เป็น Python `repr` ไม่ใช่ JSON** `read_group` คืน `"[(False, 2)]"`
ส่วน `odoo_read_group` ของเราคืน JSON ปกติ

**`limit` default เป็นทั้งหมด** ตาม schema ของมัน ถ้าไม่ใส่ limit จะคืนทุกอย่าง —
เป็นความเสี่ยงเดียวกับที่ project นี้เพิ่งแก้ด้วยการตั้ง default 50 ยังไม่ได้ยืนยันบน
database ที่มีข้อมูลเยอะ

### client ไหนต่อ `/mcp` ของ Odoo ได้บ้าง

Odoo ทำ `/mcp` มาให้ใช้กับ client ที่ตั้ง header ได้เท่านั้น ไม่ได้ทำ OAuth ให้เลย
ตรวจกับ SaaS 19.4 Enterprise

```
POST /mcp  →  401
              www-authenticate: Bearer        ← มีแค่คำว่า Bearer เปล่า ๆ
              content-type: text/html         ← ตอบเป็น HTML ไม่ใช่ JSON

/.well-known/oauth-protected-resource/mcp    404
/.well-known/oauth-protected-resource        404
/.well-known/oauth-authorization-server      404
/.well-known/openid-configuration            404
```

**เป็นอาการเดียวกับที่ project นี้เคยเป็นก่อนใส่ OAuth เป๊ะ** — 401 ที่ไม่มี
`resource_metadata` ชี้ทาง แล้ว well-known ก็ 404 ทุกเส้น ผลคือ Claude หา
authorization server ไม่เจอ ต่างกันตรงที่ของเราแก้ได้เพราะเป็นโค้ดเรา ส่วน
`/mcp` ของ Odoo อยู่ในโมดูล `ai_mcp` ที่เป็น Enterprise

| client | ต่อ `/mcp` ของ Odoo ตรง ๆ |
| --- | --- |
| Claude Code | ได้ — ตั้ง header ใน `.mcp.json` |
| ChatGPT (custom connector) | น่าจะได้ ถ้าตั้ง header ได้ — ยังไม่ได้ทดสอบ |
| **Claude chat** | **ไม่ได้** จนกว่า `static_headers` จะออกจาก beta |

ทางอ้อมคือเขียน Worker บาง ๆ ที่รับ OAuth จาก Claude แล้ว proxy ไป `/mcp` ของ Odoo
พร้อมแนบ key ให้ แต่ได้แค่ 5 tools อ่านอย่างเดียวของ Odoo เอง และยังต้องเจอกับดัก
`domain` ที่เป็น Python ในสตริง — เทียบกับ 13 tools ของ project นี้ที่ Claude chat
ต่อได้อยู่แล้ว จึงไม่คุ้ม

### เลือกยังไง

**ถ้าเป็น Community ก็ไม่มีอะไรให้เลือกตั้งแต่แรก** — `ai_mcp` เป็น Enterprise
project นี้จึงเป็นทางเดียวในสองทางที่ใช้ได้

บน Enterprise งานที่อ่านอย่างเดียว MCP server ในตัวยังเหมาะกว่าถ้าไม่อยากดูแลอะไรเลย
— ไม่ต้อง deploy ไม่ต้องมีที่เก็บ credential เพิ่ม และปลอดภัยตั้งแต่แกะกล่องโดยไม่
ต้องตั้งค่า

งานที่ต้องเขียนต้องใช้ key ชนิด `rpc` ซึ่งคือสิ่งที่ project นี้มีไว้ให้ — รวมถึงกรณี
ต่อ Odoo หลายตัวผ่าน endpoint เดียว การอ่านที่มีเพดาน และ domain ที่เป็น JSON ปกติ
ทั้งสองอยู่ด้วยกันได้ เพราะ key ทั้งสองชนิดแบ่ง scope กันเข้มงวด — key `rpc` ยิง `/mcp`
ได้ `401` ส่วน key `mcp` ก็ authenticate ผ่าน JSON-RPC ไม่ได้ การต่อ client เข้าทั้งสอง
ตัวจึงเป็นการจัดวางที่สมเหตุสมผล

## `read_group` หายไปใน saas~19.4 แต่ยังอยู่ใน 19.0

เรียก `read_group` ตรง ๆ บน saas~19.4 จะได้

```
builtins.AttributeError: The method 'res.partner.read_group' does not exist
```

**แต่บน 19.0 Community มันยังอยู่** และ `formatted_read_group` ก็มีด้วย ทั้งสองชื่อ
ใช้ได้ เพราะฉะนั้นการหายไปเกิดขึ้นระหว่าง 19.0 กับ saas~19.4 ไม่ใช่ "หายไปใน
Odoo 19" อย่างที่สรุปกันง่าย ๆ — เลขเวอร์ชันของ SaaS เดินไปไกลกว่า release ที่ลงเอง

ตัวที่ใช้แทนคือ `formatted_read_group` แต่เอกสารและตัวอย่าง Odoo เกือบทั้งหมด
บนอินเทอร์เน็ตยังเป็นชื่อเดิม agent ที่เรียก method เองผ่าน `odoo_execute` จึงเลือก
ชื่อที่ไม่มีอยู่แล้วบ่อยครั้ง

`odoo_read_group` ห่อเรื่องนี้ไว้ — ลองชื่อใหม่ก่อน ถ้าเซิร์ฟเวอร์เป็นรุ่นเก่าจึงถอยไป
ใช้ชื่อเดิมพร้อมแปลง `aggregates` เป็น `fields` ให้ agent ไม่ต้องรู้ว่าคุยกับ Odoo
เวอร์ชันอะไร

### ทดสอบ fallback กับ Odoo 18 จริงแล้ว

ยิง `read_group` ผ่าน RPC ไปที่ Odoo 18.0 (self-hosted) เทียบกับ SaaS 19.4 ตัวเดียวกับ
ที่ใช้ทดสอบทั้งเอกสารนี้

| | `read_group` | `formatted_read_group` |
| --- | --- | --- |
| Odoo 18.0 | ใช้ได้ — `is_company_count`, `__domain` | ไม่มี |
| **19.0 Community** | **ใช้ได้** — `is_company_count`, `__domain` | **ใช้ได้** — `__count`, `__extra_domain` |
| SaaS 19.4 | ไม่มีแล้ว | ใช้ได้ — `__count`, `__extra_domain` |

เส้นทาง fallback จึงไม่ใช่การเผื่อไว้ลอย ๆ — มันวิ่งจริงเมื่อปลายทางเป็น 18

ชื่อ key ที่คืนมาต่างกันด้วย ไม่ใช่แค่ชื่อ method: 18 คืนชื่อนับเป็น
`<field>_count` และ domain ของกลุ่มเป็น `__domain` ส่วน 19 เป็น `__count` กับ
`__extra_domain` ตัว tool ส่งผ่านตามที่ Odoo คืนมาโดยไม่แปลงให้เหมือนกัน ผู้เรียก
ที่ต้องรองรับทั้งสองรุ่นจึงต้องอ่านทั้งสองแบบ

`__extra_domain` (และ `__domain` บน 18) เอาไปใช้เป็น domain ต่อได้เลยถ้าจะเจาะดู
รายละเอียดในกลุ่มนั้น

## ทำไม Claude chat ต้องใช้ OAuth

Claude Code ตั้ง header ใน `.mcp.json` ได้ จึงใช้ static bearer ตรง ๆ แต่ connector
บน claude.ai ตั้งไม่ได้ ในหน้า Add custom connector มีแค่ OAuth กับ None ไม่มีช่อง
ใส่ token

เอกสารระบุว่า `static_headers` (ใส่ API key เป็น request header) **มีแล้วแต่ยัง
beta** ต้องขอ early access ถ้าบัญชีไหนมี ก็ข้ามเรื่อง OAuth ทั้งหมดนี้ไปได้เลย

### อาการตอนที่ยังไม่มี OAuth

หน้าจอ Claude ขึ้น "Detected" ข้าง *Always required* เพราะยิงมาแล้วเจอ 401 ของเรา
แต่ต่อไม่ได้ เพราะ 401 เดิมมีแค่

```
WWW-Authenticate: Bearer realm="odoo-mcp"
```

Claude จึงไปเดาต่อที่ `/.well-known/oauth-protected-resource/mcp` แล้ว
`/.well-known/oauth-protected-resource` ซึ่ง **404 ทั้งคู่** พอหา authorization
server ไม่เจอก็จบด้วย "Couldn't reach the MCP server"

หลังใส่ `@cloudflare/workers-oauth-provider` 401 กลายเป็น

```
WWW-Authenticate: Bearer realm="OAuth",
  resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"
```

`resource_metadata` คือชิ้นที่ขาดไป

### เก็บสองทางไว้ ไม่แทนที่

request ที่พก static bearer ถูกต้องเข้า MCP handler ตรง ๆ ไม่แตะ OAuth เลย ที่เหลือ
ตกเป็นของ provider ถ้าตัด static ทิ้งจะพัง `.mcp.json` ของ Claude Code และ client
อื่นที่ใช้อยู่ ทั้งที่สองทางลงเอยที่ handler เดียวกันและใช้ความลับตัวเดียวกัน

หน้า consent ยืนยันตัวด้วย `MCP_AUTH_TOKEN` แทนการทำระบบบัญชี เพราะ server นี้มี
ความลับตัวเดียวอยู่แล้ว **ผลข้างเคียงที่ต้องรู้: เปลี่ยน token เมื่อไหร่ต้องต่อ
connector ใหม่ด้วย** ไม่ใช่แค่แก้ secret

### ทดสอบแล้ว

ยิง OAuth flow เต็มวงจรด้วย script ก่อน แล้วค่อยลองจาก Claude จริง

| ขั้น | ผล |
| --- | --- |
| DCR `POST /register` | ได้ `client_id` |
| `GET /authorize` | ได้หน้า consent |
| POST ด้วย token ผิด | `401` ไม่ออก code |
| POST ด้วย token ถูก | redirect พร้อม `code` |
| `POST /token` (PKCE S256) | ได้ `access_token` |
| `POST /mcp` ด้วย access token | 13 tools |

### ChatGPT ก็ตั้ง header ไม่ได้เหมือนกัน

ตั้งใจจะให้ ChatGPT ต่อ Worker ด้วย bearer header แต่ค้นเอกสารแล้วพบว่า developer
mode ของ ChatGPT รองรับแค่ **OAuth หรือไม่มี auth** เหมือน Claude เป๊ะ

งาน OAuth ที่ทำเพื่อ Claude จึงกลายเป็นทางออกให้ ChatGPT ด้วยโดยไม่ได้ตั้งใจ — ต่อ
ผ่าน DCR ได้เลยไม่ต้องแก้อะไรเพิ่ม ยืนยันจาก KV ว่ามี client สองตัวลงทะเบียนไว้

```
ChatGPT   redirect: https://chatgpt.com/connector_platform_oauth_redirect
Claude    redirect: https://claude.ai/api/mcp/auth_callback
```

ผลที่ตามมาคือ `/mcp` ในตัวของ Odoo ต่อกับ AI chat บนคลาวด์ไม่ได้เลยสักเจ้า ไม่ใช่
แค่ Claude เพราะไม่ได้ทำ OAuth ให้

### ความต่างที่ควรรู้เวลาเขียน prompt

คำถามเดียวกันเป๊ะ Claude ลงมือเรียก tool เลย ส่วน ChatGPT ตอบกลับมาว่าจะสำรวจให้
พร้อมตารางเปล่าที่ยังไม่มีตัวเลข ต้องสั่งซ้ำว่า "ทำเลย" ถึงจะเรียกจริง ไม่ใช่เรื่อง
ผิดแต่กระทบวิธีเขียน prompt — ถ้าจะวัดผล tool ให้สั่งตรง ๆ ว่าให้ดึงข้อมูลจริง

### ผลทดสอบจาก Claude chat

ต่อผ่าน DCR ได้ หน้า consent แสดงชื่อ client ว่า `Claude` ถามเป็นภาษาไทย 4 คำถาม

| ถามอะไร | ผล |
| --- | --- |
| เชื่อมต่อได้ไหม เป็นใคร | ✅ `MCP Bot` · `eliteservicesthai-www` · `Asia/Bangkok` |
| สกุลเงินที่ประเทศใช้เยอะสุด 6 อันดับ | ✅ ตรงทุกแถว |
| ประเทศที่บังคับ zip แยกตามสกุลเงิน | ⚠️ ตารางถูก **ยอดรวมผิด** |
| partner สร้างเดือนไหนบ้าง | ✅ `August 2026` 3 ราย |

หยิบ `note` เรื่อง UTC ไปเตือนผู้ใช้เองเหมือนที่เจอบน ChatGPT

ข้อสองบอกได้ว่ามันใช้ `odoo_read_group` จริง ไม่ใช่ `odoo_search_read` — ถ้าใช้
ตัวหลังจะชนเพดาน 50 แล้วนับ 251 ประเทศไม่ได้ และมันยัง**ดึงเกินที่ขอเพื่อจัดการ
tie เอง** ผมขอ 6 อันดับ มันเห็นว่า GBP กับ XAF เท่ากันที่ 6 เลยแสดงคู่กันพร้อม
หมายเหตุ ตรวจแล้วว่า XAF 6 ถูกจริง

ข้อสามคือข้อที่มีค่าที่สุด เพราะเปิดบั๊กที่ curl ไม่มีวันเจอ — ดู
[หัวข้อ read_group ที่ใส่ limit](#odoo_read_group-ที่ใส่-limit-เคยนับได้ไม่ครบเงียบ-ๆ)

## Gemini ต่อผ่าน OAuth ได้ และตอบถูกทุกข้อตั้งแต่ครั้งแรก

client เจ้าที่สามที่ทดสอบ ต่อผ่าน OAuth เส้นทางเดียวกับ Claude chat และ ChatGPT
โดยไม่ต้องแก้อะไรฝั่ง server เลย ลงทะเบียนตัวเองผ่าน DCR เหมือนอีกสองเจ้า —
ใน `OAUTH_KV` เห็น client ชื่อ `Google` redirect ไป `oauth-redirect.googleusercontent.com`

### ตัวเลขที่ตอบ เทียบกับที่ยิงตรงเข้า Odoo

| ถาม | ที่ตอบ | ที่วัดได้ | |
| --- | --- | --- | --- |
| contact ในระบบ | 3 | 3 | ✅ |
| partner รวม archived | 9 | 9 | ✅ |
| ประเทศทั้งหมด | 251 | 251 | ✅ |
| บังคับ zip | 241 | 241 | ✅ |
| ไม่บังคับ zip | 10 | 10 | ✅ |
| สกุลที่มีประเทศเดียว | 132 | 132 | ✅ |
| สกุลหลายประเทศ | 15 สกุล | 15 สกุล | ✅ |
| partner แยกตามเดือน | ส.ค. 2026 = 9 | ส.ค. 2026 = 9 | ✅ |

ตาราง 6 อันดับแรกตรงทุกแถวรวมถึงอันดับ 6 ร่วม (`GBP` กับ `XAF` ที่ 6 เท่ากัน) และ
ตารางสกุลหลายประเทศตรงทั้ง 15 แถวเรียงลำดับเดียวกัน

### สองจุดที่น่าสนใจกว่าตัวเลข

**หนึ่ง — คำถามที่เคยทำให้ Claude ตอบผิด คราวนี้ถูกตั้งแต่ครั้งแรก** คำถาม
zip_required เป็นคำถามเดียวกับที่เคยได้ 195 กับ 86 ก่อนจะแก้ `has_more` คราวนี้ได้
241 กับ 132 ถูกต้อง นี่คือการยืนยันครั้งที่สามว่า `has_more` + `total_records`
ทำงานข้าม client ได้จริง ไม่ใช่แค่กับเจ้าที่เราแก้ให้

**สอง — แยก active กับ archived ได้เอง** ตอบว่ามี contact 3 ราย แล้วพอถามเรื่อง
เดือนที่สร้างกลับตอบ 9 ราย พร้อมแยกให้เองว่า 3 active กับ 6 archived/system ซึ่ง
ถูกตามพฤติกรรมของ Odoo ที่ตัด `active = False` ออกจาก domain ให้อัตโนมัติ
เลขสองตัวที่ดูขัดกันจึงถูกทั้งคู่ และมันอธิบายเองโดยไม่ต้องถาม — เป็นจุดที่ไม่ได้
ทดสอบกับอีกสองเจ้า

### ฝั่งเขียนก็รายงานตรง และเลือก field ถูกด้วย

สั่งให้สร้าง contact ชื่อ `ทดสอบท่อ OpenAI` อยู่**จังหวัด**สุราษฎร์ธานี แล้วแกล้งสั่ง
ให้ตั้ง `complete_name` ซึ่งเป็น computed field ที่เขียนไม่ได้

| field | ที่รายงาน | ที่เก็บจริง | |
| --- | --- | --- | --- |
| `name` | เข้า | `ทดสอบท่อ OpenAI` | ✅ |
| `state_id` | เข้า | `[1534, "สุราษฎร์ธานี (TH)"]` | ✅ |
| `country_id` | เข้า | `[217, "Thailand"]` | ✅ |
| `complete_name` | **ไม่เข้า** | `ทดสอบท่อ OpenAI` (Odoo คำนวณเอง) | ✅ |

`fields_not_applied` ทำงานตามที่ควร และมันอธิบายสาเหตุถูกด้วยว่าเป็น computed field

**เลือก field ถูก** "จังหวัด" ในไทยตรงกับ `state_id` ไม่ใช่ `city` ซึ่งเป็นจุดที่
ตีความผิดได้ง่าย

**เติม `country_id` เองโดยไม่ได้สั่ง** ทดสอบแยกแล้วว่า Odoo ไม่ได้เติมให้ — สร้าง
record ที่ส่งแค่ `state_id` ได้ `country_id` เป็น `false` แปลว่า Gemini อนุมานเอง
จากชื่อจังหวัด

การเติม field ที่ไม่ได้สั่งคือพฤติกรรมตระกูลเดียวกับที่ ChatGPT เคยตั้ง `country_id`
แทน `city` แล้วรายงานว่าสำเร็จ ต่างกันที่**ครั้งนี้มันบอกออกมาว่าเติมอะไรไปบ้าง**
ผู้ใช้จึงเห็นและปฏิเสธได้ ส่วนครั้งนั้นไม่บอก

และนี่คือจุดที่ server ช่วยได้จริงกับชั้นที่สามของ "สำเร็จแต่ไม่จริง" ซึ่งเดิมเขียนไว้ว่า
อยู่นอกขอบเขต — `odoo_create` คืน `record` ที่อ่านกลับมาจริง agent จึงมีของจริงให้
รายงาน ไม่ต้องเดาจากสิ่งที่ตัวเองส่งไป กันไม่ได้ว่า agent จะส่งอะไร แต่ทำให้มันโกหก
โดยไม่ตั้งใจได้ยากขึ้น

## Rate limiting ที่ผูกไว้แล้วแต่ยังกันไม่ได้จริง

`/mcp` เป็น public endpoint ที่ไม่มีอะไรจำกัดอัตราเลย ทั้งการเดา `MCP_AUTH_TOKEN`
และ agent ที่วนลูปจนยิง Odoo รัว ๆ จึงผูก Workers Rate Limiting binding ไว้สองตัว

| binding | ใช้ที่ | ลิมิต |
| --- | --- | --- |
| `MCP_LIMIT` | ทุก request เข้า `/mcp` | 120/60s |
| `AUTH_LIMIT` | POST หน้า consent | 10/60s |

WAF rate limiting ของ Cloudflare ใช้แทนไม่ได้ เพราะทำงานระดับ zone ต้องเป็น
เจ้าของโดเมน ส่วน endpoint นี้อยู่บน `workers.dev`

### สิ่งที่วัดได้

| ทดสอบ | ผล |
| --- | --- |
| เรียก `limit()` 15 ครั้งรวดใน request เดียว (ลิมิต 10) | `true` × 11 แล้ว `false` × 4 |
| ยิง `/mcp` 150 ครั้งพร้อมกัน (ลิมิต 120) | `200` ทั้งหมด |
| ยิง `/mcp` 160 ครั้งเรียงกัน | ไม่เจอ `429` |
| ยิง `/authorize` 60 ครั้ง (ลิมิต 10) | ไม่เจอ `429` |
| ยิง `/authorize` 40 ครั้ง ด้วย key คงที่ | ไม่เจอ `429` |

ไล่ตัดสาเหตุทีละอย่าง binding มาถึงโค้ดจริง (`typeof env.MCP_LIMIT === "object"`)
limiter ปฏิเสธได้จริงเมื่อเรียกรวดใน isolate เดียว และไม่ใช่เรื่อง key เพราะเปลี่ยน
เป็นค่าคงที่แล้วก็ยังไม่กัน

เหลือคำอธิบายเดียวคือ counter แยกตาม isolate แล้ว sync ไม่ทันที่อัตราระดับนี้ ซึ่ง
[เอกสารของ Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
เตือนไว้เองว่า *permissive, eventually consistent, intentionally designed to not be
used as an accurate accounting system* และลิมิตเป็น "ต่อ location" ไม่ใช่ทั่วโลก

### ทำไมยังเก็บโค้ดไว้

โค้ดถูกต้องและไม่มีต้นทุน อาจทำงานตอนโดนยิงหนักกว่าที่ทดสอบ แต่**เขียนไว้ตรงนี้ว่า
อย่าพึ่งเป็นด่านเดียว** ถ้าเคลมว่า "มี rate limiting แล้ว" ทั้งที่วัดแล้วไม่กัน ก็เป็น
"สำเร็จแต่ไม่จริง" แบบเดียวกับบั๊กสามตัวที่ไล่แก้มาในเอกสารนี้ — คนอ่านจะนึกว่ามี
ชั้นป้องกันที่ไม่มีอยู่จริง

ถ้าต้องการการกันที่แม่น ทางที่ถูกคือใช้ Durable Object นับ เพราะ DO เป็น
single-threaded ต่อ key จึงไม่มีปัญหา counter แตกกระจาย หรือผูกโดเมนของตัวเอง
แล้วใช้ WAF

## เรื่อง deploy

หลัง deploy ให้รอสัก 10 วินาทีก่อนทดสอบ request ที่ยิงทันทีหลัง `wrangler deploy`
ยังอาจไปตกที่ isolate ที่รันเวอร์ชันเก่าอยู่ — มีครั้งหนึ่ง `search_read` แบบไม่จำกัด
คืนมา 4,517 record ด้วยเหตุผลนี้เป๊ะ ๆ แล้วได้ 50 ทุกครั้งหลังจาก rollout นิ่งแล้ว
