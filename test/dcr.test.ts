import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { DEFAULT_REDIRECT_HOSTS, isAllowedRedirectUri } from "../src/oauth";

/**
 * `/register` ผ่าน OAuthProvider ตัวจริง (ผ่าน `src/index.ts`) — `cloudflare:workers`
 * ถูกแทนด้วย stub ใน vitest.config.ts ส่วน KV เป็น Map ในหน่วยความจำ
 */

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string, options?: string | { type?: string }) => {
      const value = store.get(key);
      if (value === undefined) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [], list_complete: true }),
  };
}

// env ใหม่ทุกครั้ง — provider ถูก cache ตาม env
async function register(vars: Record<string, string | undefined>, redirect_uris: unknown) {
  const env = { OAUTH_KV: fakeKv(), MCP_AUTH_TOKEN: "t", ...vars } as never;
  return worker.fetch(
    new Request("https://mcp.example.com/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "test", redirect_uris }),
    }),
    env,
    {} as never,
  );
}

const ACCESS = { CONSENT_MODE: "access" };
const GOOD = ["https://claude.ai/api/mcp/auth_callback"];

describe("DCR โหมด access", () => {
  for (const [label, value] of [
    ["ไม่ตั้ง", undefined],
    ["ว่าง", ""],
    ["TRUE", "TRUE"],
    ["1", "1"],
    [" true", " true"],
  ] as const) {
    it(`MCP_DCR_ENABLED ${label} → 403 registration_disabled`, async () => {
      const res = await register({ ...ACCESS, MCP_DCR_ENABLED: value }, GOOD);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "registration_disabled" });
    });
  }

  it('"true" + redirect ที่อนุญาต → 201', async () => {
    const res = await register({ ...ACCESS, MCP_DCR_ENABLED: "true" }, GOOD);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ redirect_uris: GOOD });
  });

  for (const uri of [
    "https://evil.example/cb",
    "http://claude.ai/cb",
    "https://user:pw@claude.ai/x",
    "https://claude.ai.evil.com/x",
    "https://evilclaude.ai/x",
    "https://x.claude.ai/x",
  ]) {
    it(`redirect ${uri} → ปฏิเสธ`, async () => {
      const res = await register({ ...ACCESS, MCP_DCR_ENABLED: "true" }, [uri]);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    });
  }

  it("ตัวใดตัวหนึ่งไม่ผ่าน → ปฏิเสธทั้งคำขอ", async () => {
    const res = await register({ ...ACCESS, MCP_DCR_ENABLED: "true" }, [
      ...GOOD,
      "https://evil.example/cb",
    ]);
    expect(res.status).toBe(400);
  });
});

describe("DCR โหมด token — เหมือนเดิม", () => {
  it("เปิดอยู่และรับ localhost ได้", async () => {
    const res = await register({}, ["http://localhost:33418/callback"]);
    expect(res.status).toBe(201);
  });

  it("ไม่อ่าน MCP_DCR_ENABLED", async () => {
    const res = await register({ MCP_DCR_ENABLED: "false" }, GOOD);
    expect(res.status).toBe(201);
  });
});

describe("isAllowedRedirectUri", () => {
  it("host ค่าเริ่มต้นครบทั้งห้า", () => {
    const hosts = DEFAULT_REDIRECT_HOSTS.split(",");
    expect(hosts).toHaveLength(5);
    for (const host of hosts) {
      expect(isAllowedRedirectUri(`https://${host}/cb`, {} as never)).toBe(true);
    }
  });
});
