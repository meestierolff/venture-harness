/**
 * Framework health — runs the always-required command suite from
 * config/quality.yaml and reports a single table. `pnpm verify` is this
 * script with --strict (non-zero exit on any failure).
 *
 * Commands that need a running server (verify:raw-html) are CI-additional
 * and not run here; the report says so explicitly.
 */
import { execFileSync } from "node:child_process";
import { loadYaml } from "./lib/util";

const strict = process.argv.includes("--strict");
/**
 * Commands a caller already owns and will run itself.
 *
 * The quality profiles run `typecheck` and `test` as their own checks, so
 * without this the compatibility gate executed the entire unit suite a second
 * time, concurrently, against the same temporary directories and SQLite files.
 * A delegated command is reported as DELEGATED and is never counted as a pass.
 */
const delegated = new Set(
  process.argv.flatMap((value, index) =>
    value === "--delegate" && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  ),
);
const quality = loadYaml<{ required_commands: { always: string[]; ci_additional: string[] } }>(
  "config/quality.yaml",
);

interface Result {
  command: string;
  status: "PASS" | "FAIL" | "DELEGATED";
  detail: string;
}

const results: Result[] = [];
for (const command of quality.required_commands.always) {
  if (delegated.has(command)) {
    console.log(`delegated ${command} (run separately by the caller)`);
    results.push({ command, status: "DELEGATED", detail: "run separately by the caller" });
    continue;
  }
  process.stdout.write(`running ${command} ... `);
  try {
    // Commands come from config/quality.yaml (reviewable contract). Run
    // without a shell: split into argv and execFileSync.
    const [bin, ...args] = command.split(/\s+/);
    execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    console.log("PASS");
    results.push({ command, status: "PASS", detail: "" });
  } catch (e: unknown) {
    console.log("FAIL");
    const err = e as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    const failLines = output
      .split("\n")
      .filter((l) => l.startsWith("FAIL") || l.includes("error"))
      .slice(0, 5)
      .join(" | ");
    results.push({ command, status: "FAIL", detail: failLines || output.slice(-300) });
  }
}

console.log("\n== framework health ==");
for (const res of results) {
  console.log(`${res.status}  ${res.command}${res.detail ? `\n      ${res.detail}` : ""}`);
}
console.log("\nnot run here (needs build/server, CI runs them):");
for (const command of quality.required_commands.ci_additional) console.log(`  -    ${command}`);

const failures = results.filter((res) => res.status === "FAIL");
const delegatedCount = results.filter((res) => res.status === "DELEGATED").length;
const executed = results.length - delegatedCount;
if (delegatedCount > 0) {
  console.log(
    `\n${delegatedCount} command(s) delegated to the caller; they are not counted as passing here.`,
  );
}
if (failures.length > 0) {
  console.log(`\nhealth: ${failures.length}/${executed} executed command(s) failing`);
  if (strict) process.exit(1);
} else {
  console.log(`\nhealth: all ${executed} executed required commands pass`);
}
