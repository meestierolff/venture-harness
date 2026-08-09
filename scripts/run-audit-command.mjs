#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const idIndex = args.indexOf("--id");

if (separator < 0 || idIndex < 0 || !args[idIndex + 1] || separator === args.length - 1) {
  console.error(
    "usage: node scripts/run-audit-command.mjs --id <stable-id> [--cwd <path>] -- <command> [args...]",
  );
  process.exit(1);
}

const id = args[idIndex + 1];
if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
  console.error(
    "audit command id must contain only lowercase letters, digits, dot, underscore, or dash",
  );
  process.exit(1);
}

const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? resolve(args[cwdIndex + 1]) : process.cwd();
const command = args.slice(separator + 1);

const forbiddenArgumentPatterns = [
  /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/u,
  /sk_(?:live|test)_[A-Za-z0-9]{12,}/u,
  /(?:postgres|postgresql):\/\/[^\s@]+@/iu,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u,
];
if (command.some((part) => forbiddenArgumentPatterns.some((pattern) => pattern.test(part)))) {
  console.error("refusing to execute or persist a command containing a credential-shaped argument");
  process.exit(1);
}

function quote(part) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(part) ? part : JSON.stringify(part);
}

function sanitize(value) {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"']+/giu, "$1[REDACTED]")
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/sk_(?:live|test)_[A-Za-z0-9]{12,}/gu, "[REDACTED_PROVIDER_KEY]")
    .replace(/(?:postgres|postgresql):\/\/[^\s@]+@/giu, "postgresql://[REDACTED]@")
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED_JWT]");
}

const reportPath = resolve("reports/audit/commands-run.json");
let initialReport = {
  schemaVersion: 1,
  branch: "sol/vh-core-v0.2-winner-loop",
  records: [],
};
try {
  initialReport = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const initialRecords = Array.isArray(initialReport.records) ? initialReport.records : [];
const attempt = initialRecords.filter((entry) => entry.id === id).length + 1;
const relativeLogPath = `reports/audit/command-logs/${id}.attempt-${attempt}.log`;
const logPath = resolve(relativeLogPath);
mkdirSync(dirname(reportPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });

const startedAt = new Date();
const child = spawn(command[0], command.slice(1), {
  cwd,
  env: process.env,
  shell: false,
  stdio: ["inherit", "pipe", "pipe"],
});

const chunks = [];
let outputBytes = 0;
const maximumBytes = 5 * 1024 * 1024;

function capture(chunk, stream) {
  stream.write(chunk);
  if (outputBytes >= maximumBytes) return;
  const buffer = Buffer.from(chunk);
  const remaining = maximumBytes - outputBytes;
  chunks.push(buffer.subarray(0, remaining));
  outputBytes += Math.min(buffer.length, remaining);
}

child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
child.stderr.on("data", (chunk) => capture(chunk, process.stderr));

child.on("error", (error) => {
  capture(Buffer.from(`\nrunner error: ${error.message}\n`), process.stderr);
});

child.on("close", (code, signal) => {
  const endedAt = new Date();
  const exitCode = typeof code === "number" ? code : 1;
  const truncated = outputBytes >= maximumBytes;
  const log = sanitize(Buffer.concat(chunks).toString("utf8"));
  writeFileSync(logPath, `${log}${truncated ? "\n[AUDIT LOG TRUNCATED AT 5 MiB]\n" : ""}`, "utf8");

  let report = {
    schemaVersion: 1,
    branch: "sol/vh-core-v0.2-winner-loop",
    records: [],
  };
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const record = {
    id,
    attempt,
    command: command.map(quote).join(" "),
    cwd,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    exitCode,
    signal: signal ?? null,
    status: exitCode === 0 ? "PASSED" : "FAILED",
    skipped: false,
    evidencePath: relativeLogPath,
    outputTruncated: truncated,
  };
  const previous = Array.isArray(report.records) ? report.records : [];
  report.records = [...previous, record];
  report.updatedAt = endedAt.toISOString();

  const temporary = `${reportPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporary, reportPath);
  process.exitCode = exitCode;
});
