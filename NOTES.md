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

## ทดสอบแล้ว

ยิง tool ครบทั้ง 13 ตัวกับ database จริง

| Tool | ผล |
| --- | --- |
| `odoo_version` | `saas~19.4+e` |
| `odoo_list_servers` | หา default ที่ตั้งไว้เจอ |
| `odoo_search_count` | นับถูก |
| `odoo_search_read` | `fields` `limit` `order` และ domain ที่มี `'\|'` ใช้ได้หมด |
| `odoo_read` | คืน field ที่ขอ |
| `odoo_fields_get` | 120 fields บน `res.partner` |
| `odoo_create` | คืน id ใหม่พร้อม record ตามที่เก็บจริง |
| `odoo_write` | คืน record ตามที่เก็บจริง |
| `odoo_delete` | คืน `true` record หายไปจริง จำนวนกลับเป็นเท่าเดิม |
| `odoo_execute` | `name_search` คืนคู่ค่าตามที่คาด |
| `odoo_read_group` | จัดกลุ่ม นับ และ `id:max` ถูกต้อง รวมถึง `create_date:month` |
| `odoo_context` | คืน uid บริษัท `Asia/Bangkok` และภาษา |
| `odoo_get_models` | กรองตามคำค้นและตัดตัวที่ policy บล็อกออก |

ข้อความที่ไม่ใช่ ASCII ผ่านไปกลับได้ถูกต้อง — ชื่อบริษัทภาษาไทยผ่าน create → read
โดยไม่เพี้ยน

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

| | `create` ด้วย `is_company: true` |
| --- | --- |
| SaaS 19.4 | ถูกทิ้ง — อ่านกลับได้ `false` |
| 19.0 Community | เก็บ — อ่านกลับได้ `true` |

และบน SaaS ตัวเดียวกัน `write` เก็บค่าให้ ทั้งที่ `create` ทิ้ง ทำซ้ำได้ทุกครั้ง

เหตุผลจะเป็นอะไรก็ตาม มันไม่ใช่สิ่งที่ agent เดาได้จาก schema — `fields_get` บอกว่า
`readonly: true` เหมือนกันหมด ซึ่งคือเหตุผลทั้งหมดที่ต้องอ่านกลับแทนการเชื่อค่าที่
return มา และเป็นเหตุผลที่ห้ามเอาผลทดสอบจากเวอร์ชันหนึ่งไปสรุปแทนอีกเวอร์ชัน

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

`fields_not_applied` รายงานเฉพาะ field ที่มันมั่นใจ นอกนั้นเงียบ — เพราะการเตือนผิด
จะส่ง agent ไปไล่แก้สิ่งที่เขียนสำเร็จอยู่แล้ว ถ้าค่าไหนสำคัญจริง ให้อ่านจาก `record`
ที่คืนมา

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
ที่มีสิทธิ์เท่าที่งานต้องใช้ แทนบัญชี admin

## เทียบกับ MCP server ในตัวของ Odoo

Odoo 19 มี MCP server ของตัวเองที่ `/mcp` เข้าถึงด้วย API key ชนิด `mcp`
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

## เรื่อง deploy

หลัง deploy ให้รอสัก 10 วินาทีก่อนทดสอบ request ที่ยิงทันทีหลัง `wrangler deploy`
ยังอาจไปตกที่ isolate ที่รันเวอร์ชันเก่าอยู่ — มีครั้งหนึ่ง `search_read` แบบไม่จำกัด
คืนมา 4,517 record ด้วยเหตุผลนี้เป๊ะ ๆ แล้วได้ 50 ทุกครั้งหลังจาก rollout นิ่งแล้ว
