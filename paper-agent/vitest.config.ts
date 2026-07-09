import { defineConfig } from "vitest/config";

// Plain Node environment. Worker handlers are tested by calling `app.fetch`
// with a hand-built mock `Env` (fake VECTORIZE / PAPERS_KV, stubbed fetch),
// which avoids Vectorize local-emulation gaps and keeps unit tests fast.
// Real bindings are exercised via `wrangler dev` / `wrangler deploy`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
