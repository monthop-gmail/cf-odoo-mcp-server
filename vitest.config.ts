import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    // ให้ alias ข้างบนมีผลกับ import ภายใน OAuthProvider ด้วย
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
