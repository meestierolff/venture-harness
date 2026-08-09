#!/usr/bin/env node
import { runCli } from "../lib/cli";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const result = await runCli(args);
  process.exitCode = result.exitCode;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
