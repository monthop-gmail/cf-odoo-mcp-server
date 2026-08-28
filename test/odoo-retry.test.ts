import { beforeEach, describe, expect, it, vi } from "vitest";
import { OdooError, execute, version, type ServerConfig } from "../src/odoo";

/**
 * `execute` เก็บ uid ไว้ใน cache ระดับโมดูล แล้วลองใหม่ครั้งเดียวเมื่อ call พัง
 * เพราะ uid ที่ cache ไว้อาจอยู่นานกว่า session ที่มันมา ซึ่งแยกไม่ออกจาก
 * permission error จริงจนกว่าจะลองใหม่
 *
 * cache นั้นอยู่นอก test — จึงตั้งชื่อ server ไม่ซ้ำกันทุก test แทนการ reset
 */

const server = (name: string): ServerConfig => ({
  url: "https://odoo.test",
  db: "db",
  username: "bot",
  password: "pw",
});

/** สร้าง response ของ Odoo แบบ JSON-RPC */
const ok = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
const fail = (message: string, name = "odoo.exceptions.AccessError") =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { data: { name, message } } }),
    { status: 200 },
  );

/** อ่านว่า request นี้เรียก service/method อะไร */
const callOf = (init: RequestInit) => {
  const { params } = JSON.parse(String(init.body));
  return `${params.service}.${params.method}`;
};

let calls: string[];

beforeEach(() => {
  calls = [];
});

function stubFetch(handler: (call: string, n: number) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = callOf(init);
      calls.push(call);
      return handler(call, calls.filter((c) => c === call).length);
    }),
  );
}

describe("execute", () => {
  it("authenticate ครั้งเดียวแล้วใช้ uid ที่ cache ไว้ต่อ", async () => {
    stubFetch((call) => (call === "common.authenticate" ? ok(7) : ok("done")));
    const s = server("cache-hit");

    await execute("cache-hit", s, "res.partner", "search_count", [[]]);
    await execute("cache-hit", s, "res.partner", "search_count", [[]]);

    expect(calls.filter((c) => c === "common.authenticate")).toHaveLength(1);
    expect(calls.filter((c) => c === "object.execute_kw")).toHaveLength(2);
  });

  it("uid ค้าง — ลองใหม่ครั้งเดียวด้วย uid ใหม่แล้วสำเร็จ", async () => {
    stubFetch((call, n) => {
      if (call === "common.authenticate") return ok(n === 1 ? 7 : 9);
      return n === 1 ? fail("Session expired") : ok("done");
    });
    const s = server("stale-uid");

    const result = await execute("stale-uid", s, "res.partner", "read", [[1]]);

    expect(result).toBe("done");
    // authenticate สองครั้ง: ครั้งแรกได้ uid ค้าง ครั้งที่สองได้ uid ใหม่
    expect(calls.filter((c) => c === "common.authenticate")).toHaveLength(2);
    expect(calls.filter((c) => c === "object.execute_kw")).toHaveLength(2);
  });

  it("พังจริง ๆ — ลองใหม่แล้วยังพัง ต้องโยน error ของ Odoo ออกมา ไม่วนซ้ำ", async () => {
    stubFetch((call) =>
      call === "common.authenticate" ? ok(7) : fail("Invalid field 'nope'", "builtins.ValueError"),
    );
    const s = server("always-fails");

    await expect(
      execute("always-fails", s, "res.partner", "read", [[1]]),
    ).rejects.toThrow(/builtins.ValueError: Invalid field 'nope'/);

    // ลองใหม่แค่ครั้งเดียว ไม่ใช่วนไม่จบ
    expect(calls.filter((c) => c === "object.execute_kw")).toHaveLength(2);
  });

  it("authenticate ไม่ผ่านตั้งแต่แรก บอกชื่อ user กับ db", async () => {
    stubFetch(() => ok(false));
    await expect(
      execute("bad-login", server("bad-login"), "res.partner", "read", [[1]]),
    ).rejects.toThrow(/Authentication failed for user 'bot' on database 'db'/);
  });
});

describe("การแปล error ของ Odoo", () => {
  it("หยิบข้อความจาก data.message ไม่ใช่ error.message ชั้นนอก", async () => {
    stubFetch(() => fail("Object res.nope doesn't exist", "odoo.exceptions.UserError"));
    await expect(version(server("err"))).rejects.toThrow(
      "odoo.exceptions.UserError: Object res.nope doesn't exist",
    );
  });

  it("ตอบไม่ใช่ JSON — บอกให้ไปเช็ค URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(version(server("html"))).rejects.toThrow(/non-JSON response/);
  });

  it("HTTP ไม่ใช่ 200 — บอกรหัสสถานะ", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(version(server("bad-status"))).rejects.toThrow(/HTTP 502/);
  });

  it("ต่อไม่ติด — บอก URL ที่ต่อไม่ได้", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connect ECONNREFUSED"); }));
    await expect(version(server("down"))).rejects.toThrow(/Cannot reach Odoo at https:\/\/odoo.test/);
  });

  it("error ที่โยนออกมาเป็น OdooError", async () => {
    stubFetch(() => fail("nope"));
    await expect(version(server("type"))).rejects.toBeInstanceOf(OdooError);
  });
});
