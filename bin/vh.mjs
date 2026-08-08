#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../scripts/vh.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", entrypoint, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`vh could not start: ${result.error.message}`);
  console.error("Next: run pnpm install, then retry vh --help.");
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
