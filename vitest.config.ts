import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 4,
    testTimeout: 30_000,
    // Fixture hooks materialize ventures and install dependencies, so they need
    // the same budget as the tests they set up. The 10s default made the golden
    // path and scaffold suites fail as "hook timed out" whenever the machine was
    // busy — most reliably inside the MVP profile, which runs many checks at
    // once, and never in isolation.
    hookTimeout: 30_000,
  },
});
