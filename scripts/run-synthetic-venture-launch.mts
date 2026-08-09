#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSyntheticFounderGoldenPath } from "../tests/fixtures/synthetic-founder-golden-path.ts";

function option(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`);
  if (indexes.length === 0) return undefined;
  const value = args[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function validateArgs(args: readonly string[]): void {
  const valueFlags = new Set(["--idea", "--output"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--" || value === "--json") continue;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`Unknown option ${value}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  validateArgs(args);
  const configuredOutput = option(args, "--output");
  const rootDir = configuredOutput
    ? resolve(configuredOutput)
    : mkdtempSync(join(tmpdir(), "vh-founder-golden-path-"));
  if (configuredOutput && !existsSync(rootDir))
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const idea = option(args, "--idea");
  const result = await runSyntheticFounderGoldenPath({
    rootDir,
    ...(idea ? { ideaFixture: resolve(idea) } : {}),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Synthetic founder Golden Path: ${result.status}`,
      `Child venture: ${result.childRoot}`,
      `Launch report: ${result.launchReport.markdown}`,
      `Core upgrade: ${result.lifecycle.coreUpgrade}`,
    ].join("\n") + "\n",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
