import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

const env = (vars: Record<string, string>) => vars as never;

const one = {
  ODOO_URL: "https://odoo.example.com",
  ODOO_DB: "mydb",
  ODOO_USERNAME: "bot@example.com",
  ODOO_PASSWORD: "key",
};

describe("ทางเลือกสำรอง: ตัวแปรเดี่ยว", () => {
  it("ครบทั้งสี่ตัวใช้ได้", () => {
    const { servers, defaultServer } = loadConfig(env(one));
    expect(defaultServer).toBe("default");
    expect(servers.default.url).toBe("https://odoo.example.com");
  });

  it("ตัดสแลชท้าย URL ทิ้ง — ไม่งั้นจะกลายเป็น //jsonrpc", () => {
    const { servers } = loadConfig(env({ ...one, ODOO_URL: "https://x.com///" }));
    expect(servers.default.url).toBe("https://x.com");
  });

  it("ขาดตัวใดตัวหนึ่งแล้วบอกว่าต้องตั้งอะไรบ้าง", () => {
    const { ODOO_PASSWORD: _drop, ...partial } = one;
    expect(() => loadConfig(env(partial))).toThrow(ConfigError);
    expect(() => loadConfig(env(partial))).toThrow(/ODOO_PASSWORD/);
  });
});

describe("ODOO_SERVERS", () => {
  const multi = JSON.stringify({
    default_server: "ee",
    servers: {
      ce: { url: "http://odoo:8069", db: "test19", username: "mcp-bot", password: "x" },
      ee: { url: "https://a.odoo.com", db: "a", username: "bot@a.com", password: "y" },
    },
  });

  it("อ่านหลาย server และเคารพ default_server", () => {
    const { servers, defaultServer } = loadConfig(env({ ODOO_SERVERS: multi }));
    expect(Object.keys(servers).sort()).toEqual(["ce", "ee"]);
    expect(defaultServer).toBe("ee");
  });

  it("ชนะตัวแปรเดี่ยวเมื่อตั้งทั้งคู่", () => {
    const { servers } = loadConfig(env({ ...one, ODOO_SERVERS: multi }));
    expect(Object.keys(servers).sort()).toEqual(["ce", "ee"]);
  });

  it("ไม่ระบุ default_server ใช้ตัวแรก", () => {
    const raw = JSON.stringify({ servers: { ce: JSON.parse(multi).servers.ce } });
    expect(loadConfig(env({ ODOO_SERVERS: raw })).defaultServer).toBe("ce");
  });

  it("JSON พังแล้วบอกว่าพังตรงไหน", () => {
    expect(() => loadConfig(env({ ODOO_SERVERS: "{not json" }))).toThrow(
      /ODOO_SERVERS is not valid JSON/,
    );
  });

  it("ไม่มี server เลย", () => {
    expect(() => loadConfig(env({ ODOO_SERVERS: '{"servers":{}}' }))).toThrow(
      /contains no servers/,
    );
  });

  it("server ขาด field แล้วบอกชื่อ server กับชื่อ field", () => {
    const raw = '{"servers":{"ce":{"url":"http://x","db":"d","username":"u"}}}';
    expect(() => loadConfig(env({ ODOO_SERVERS: raw }))).toThrow(
      /server 'ce' is missing 'password'/,
    );
  });

  it("default_server ที่ไม่มีอยู่จริง แล้วบอกว่ามีอะไรให้เลือก", () => {
    const raw = JSON.stringify({ default_server: "nope", servers: JSON.parse(multi).servers });
    expect(() => loadConfig(env({ ODOO_SERVERS: raw }))).toThrow(/ce, ee/);
  });
});
