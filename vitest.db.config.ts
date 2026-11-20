import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database tests run against a migrated local Supabase Postgres (scripts/db-test.sh or `supabase db reset`).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
