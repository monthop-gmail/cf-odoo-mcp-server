import { afterEach, describe, expect, it } from "vitest";
import { isModelAllowed, loadModelPolicy } from "../src/config";

/**
 * The `*` matching here is the one piece of logic in this project that has
 * already bitten us in production: `res.users` was set as a blocked pattern and
 * `res.users.apikeys` walked straight through it, because an exact pattern
 * matches only itself. README now warns about it — these tests keep that
 * warning true.
 */

const env = (vars: Record<string, string>) => vars as never;

afterEach(() => {
  delete process.env.BLOCKED_MODELS;
  delete process.env.ALLOWED_MODELS;
});

describe("ไม่ตั้งอะไรเลย", () => {
  it("ปล่อยผ่านทุก model", () => {
    const policy = loadModelPolicy(env({}));
    expect(isModelAllowed(policy, "res.partner")).toBe(true);
    expect(isModelAllowed(policy, "ir.cron")).toBe(true);
  });
});

describe("BLOCKED_MODELS", () => {
  it("ชื่อเปล่า ๆ จับได้เฉพาะตัวมันเอง", () => {
    const policy = loadModelPolicy(env({ BLOCKED_MODELS: "res.users" }));
    expect(isModelAllowed(policy, "res.users")).toBe(false);
    // นี่คือกับดักที่เจอมาแล้วจริง — ไม่ใช่ทฤษฎี
    expect(isModelAllowed(policy, "res.users.apikeys")).toBe(true);
  });

  it("ลงท้าย * จับแบบขึ้นต้น", () => {
    const policy = loadModelPolicy(env({ BLOCKED_MODELS: "res.users*" }));
    expect(isModelAllowed(policy, "res.users")).toBe(false);
    expect(isModelAllowed(policy, "res.users.apikeys")).toBe(false);
    expect(isModelAllowed(policy, "res.partner")).toBe(true);
  });

  it("ค่าที่ README แนะนำ กันครบทุกเส้นทางที่ทดสอบไว้", () => {
    const policy = loadModelPolicy(
      env({ BLOCKED_MODELS: "ir.*,res.users*,res.groups*" }),
    );
    for (const model of [
      "ir.cron",
      "ir.actions.server",
      "ir.config_parameter",
      "ir.model.access",
      "res.users",
      "res.users.apikeys",
      "res.groups",
    ]) {
      expect(isModelAllowed(policy, model), model).toBe(false);
    }
    expect(isModelAllowed(policy, "res.partner")).toBe(true);
  });

  it("`ir.*` ไม่จับ model ที่มี ir. อยู่ตรงกลาง", () => {
    const policy = loadModelPolicy(env({ BLOCKED_MODELS: "ir.*" }));
    // theme.ir.ui.view มีอยู่จริงบน Odoo ที่ลง website
    expect(isModelAllowed(policy, "theme.ir.ui.view")).toBe(true);
  });

  it("เว้นวรรครอบ comma ไม่ทำให้เพี้ยน", () => {
    const policy = loadModelPolicy(env({ BLOCKED_MODELS: " ir.* , res.users* " }));
    expect(isModelAllowed(policy, "ir.cron")).toBe(false);
    expect(isModelAllowed(policy, "res.users")).toBe(false);
  });

  it("ค่าว่างเท่ากับไม่ได้ตั้ง", () => {
    const policy = loadModelPolicy(env({ BLOCKED_MODELS: "  ,, " }));
    expect(isModelAllowed(policy, "ir.cron")).toBe(true);
  });
});

describe("ALLOWED_MODELS", () => {
  it("ตั้งแล้วต้องอยู่ในรายการจึงผ่าน", () => {
    const policy = loadModelPolicy(env({ ALLOWED_MODELS: "res.partner,sale.*" }));
    expect(isModelAllowed(policy, "res.partner")).toBe(true);
    expect(isModelAllowed(policy, "sale.order")).toBe(true);
    expect(isModelAllowed(policy, "res.users")).toBe(false);
  });

  it("BLOCKED ชนะ ALLOWED เมื่อตรงทั้งคู่", () => {
    const policy = loadModelPolicy(
      env({ ALLOWED_MODELS: "res.*", BLOCKED_MODELS: "res.users*" }),
    );
    expect(isModelAllowed(policy, "res.partner")).toBe(true);
    expect(isModelAllowed(policy, "res.users")).toBe(false);
  });
});
