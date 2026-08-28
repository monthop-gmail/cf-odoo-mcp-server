import { describe, expect, it } from "vitest";
import { fieldsNotApplied } from "../src/tools";

/**
 * ฟังก์ชันนี้เคยรายงานผิดมาแล้วตอนใช้งานจริง: เขียน "ok" ลง comment ซึ่งเป็น
 * html field แล้ว Odoo เก็บเป็น "<p>ok</p>" มันจึงฟ้องว่าค่าไม่เข้า ทั้งที่เข้าแล้ว
 *
 * false positive แย่กว่าการเงียบ เพราะส่ง agent ไปไล่แก้สิ่งที่สำเร็จอยู่แล้ว
 */

describe("จับ field ที่ Odoo ไม่เก็บ", () => {
  it("readonly field ที่ถูกทิ้ง", () => {
    expect(
      fieldsNotApplied({ name: "A", is_company: true }, { name: "A", is_company: false }),
    ).toEqual(["is_company"]);
  });

  it("computed field ที่ Odoo คำนวณทับ", () => {
    expect(
      fieldsNotApplied({ complete_name: "x" }, { complete_name: "ทดสอบ" }),
    ).toEqual(["complete_name"]);
  });

  it("ค่าที่เข้าปกติ ไม่ฟ้อง", () => {
    expect(fieldsNotApplied({ name: "A", city: "ภูเก็ต" }, { name: "A", city: "ภูเก็ต" })).toEqual([]);
  });
});

describe("ไม่ฟ้องผิด (false positive)", () => {
  it("html field ที่ Odoo ห่อ <p> ให้ ถือว่าเข้าแล้ว", () => {
    expect(fieldsNotApplied({ comment: "ok" }, { comment: "<p>ok</p>" })).toEqual([]);
  });

  it("html ที่มีช่องว่างหรือ entity ต่างกัน ก็ยังถือว่าเข้า", () => {
    expect(
      fieldsNotApplied({ comment: "a & b" }, { comment: "<p>a &amp;&nbsp;b</p>" }),
    ).toEqual([]);
  });

  it("many2one ส่งเป็น id แต่อ่านกลับเป็น [id, ชื่อ]", () => {
    expect(fieldsNotApplied({ country_id: 217 }, { country_id: [217, "Thailand"] })).toEqual([]);
  });

  it("สตริงว่างที่ Odoo เก็บเป็น false", () => {
    expect(fieldsNotApplied({ comment: "" }, { comment: false })).toEqual([]);
  });

  it("field ที่ไม่ได้อ่านกลับมา ไม่เอามาตัดสิน", () => {
    expect(fieldsNotApplied({ name: "A", city: "x" }, { name: "A" })).toEqual([]);
  });
});

describe("กรณีที่จงใจไม่ตัดสิน", () => {
  it("x2many command list เทียบไม่ได้ จึงเงียบ", () => {
    expect(fieldsNotApplied({ child_ids: [[6, 0, [1, 2]]] }, { child_ids: [1, 2] })).toEqual([]);
  });

  it("nested write เทียบไม่ได้ จึงเงียบ", () => {
    expect(fieldsNotApplied({ meta: { a: 1 } }, { meta: false })).toEqual([]);
  });
});

describe("many2one ที่ถูกทิ้งจริง ยังต้องจับได้", () => {
  it("ส่ง id หนึ่ง แต่เก็บอีก id", () => {
    expect(fieldsNotApplied({ country_id: 217 }, { country_id: [1, "Andorra"] })).toEqual([
      "country_id",
    ]);
  });
});
