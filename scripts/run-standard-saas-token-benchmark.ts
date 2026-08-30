#!/usr/bin/env node
import { resolve } from "node:path";
import { STANDARD_SAAS_EXECUTION_GATE, loadStandardSaasBenchmarkSpec } from "../lib/benchmarks";

function option(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`);
  if (indexes.length === 0) return undefined;
  const value = args[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function validateArgs(args: readonly string[]): void {
  const valueFlags = new Set(["--spec"]);
  const switches = new Set(["--execute", "--acknowledge-model-calls"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (switches.has(value)) continue;
    throw new Error(`Unknown option ${value}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  validateArgs(args);
  const specPath = option(args, "--spec");
  if (!specPath) throw new Error("--spec is required");
  const spec = await loadStandardSaasBenchmarkSpec(resolve(specPath));
  if (!args.includes("--execute")) {
    process.stdout.write(
      [
        `Benchmark spec is valid for ${spec.applications.length} application(s).`,
        "No model call was made and no report was written.",
        STANDARD_SAAS_EXECUTION_GATE,
      ].join("\n") + "\n",
    );
    return;
  }
  if (!args.includes("--acknowledge-model-calls")) {
    throw new Error(
      "--execute also requires --acknowledge-model-calls; no model call or report was created",
    );
  }
  throw new Error(STANDARD_SAAS_EXECUTION_GATE);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
