import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only — pure logic under src/lib and src/db (no DOM, no server).
// Playwright drives the e2e suite separately from tests/e2e.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
