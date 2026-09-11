import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Three suites, deliberately run by separate scripts (see package.json):
//
//   tests/unit     — pure functions, no network, no credentials. `npm test`.
//                    These must always pass, so nothing in here may import a
//                    module that reaches for `env` at load time.
//   tests/db       — real Postgres, skipped without DATABASE_URL.
//   tests/contract — real Pinecone, skipped without PINECONE_API_KEY. Kept
//                    out of the default run so a rate-limited index can't
//                    fail an ordinary `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
