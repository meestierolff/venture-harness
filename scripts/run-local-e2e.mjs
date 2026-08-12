#!/usr/bin/env node

import { resolve } from "node:path";
import {
  runInherited,
  startOwnedProductionServer,
  stopProductionServer,
} from "./lib/local-production-server.mjs";

const root = resolve(import.meta.dirname, "..");
const forwarded = process.argv.slice(2);
// pnpm inserts a separator for `pnpm test:e2e -- <playwright args>`; it is not
// itself a Playwright argument, because passing it through disables option
// parsing and silently broadens a focused quality check to the whole suite.
if (forwarded[0] === "--") forwarded.shift();
const configuredBaseUrl = process.env.PLAYWRIGHT_BASE_URL?.trim();

if (configuredBaseUrl) {
  process.exitCode = await runInherited("pnpm", ["exec", "playwright", "test", ...forwarded], {
    cwd: root,
    env: process.env,
  });
} else {
  let owned;
  try {
    owned = await startOwnedProductionServer(root);
    process.exitCode = await runInherited("pnpm", ["exec", "playwright", "test", ...forwarded], {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_BASE_URL: owned.baseUrl },
    });
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  } finally {
    if (owned) await stopProductionServer(owned.server);
  }
}
