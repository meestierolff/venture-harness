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
const quality = loadYaml<{ required_commands: { always: string[]; ci_additional: string[] } }>(
  "config/quality.yaml",
);

interface Result {
  command: string;
  status: "PASS" | "FAIL";
  detail: string;
}

const results: Result[] = [];
for (const command of quality.required_commands.always) {
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
if (failures.length > 0) {
  console.log(`\nhealth: ${failures.length}/${results.length} required command(s) failing`);
  if (strict) process.exit(1);
} else {
  console.log(`\nhealth: all ${results.length} required commands pass`);
}
