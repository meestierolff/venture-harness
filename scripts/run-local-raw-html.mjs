#!/usr/bin/env node

import { resolve } from "node:path";
import {
  runInherited,
  startOwnedProductionServer,
  stopProductionServer,
} from "./lib/local-production-server.mjs";

const root = resolve(import.meta.dirname, "..");
let owned;

try {
  owned = await startOwnedProductionServer(root);
  process.exitCode = await runInherited(
    "pnpm",
    ["verify:raw-html", "--", "--url", owned.baseUrl, "--allow-loopback"],
    { cwd: root, env: process.env },
  );
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  if (owned) await stopProductionServer(owned.server);
}
