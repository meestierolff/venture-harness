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
    // Fixture hooks materialize ventures and inspect dependency closure, so
    // their bounded setup work can exceed Vitest's 10s default even when the
    // profile owns exactly one full-suite run.
    hookTimeout: 30_000,
  },
});
