#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// Keep this execution boundary at least as strict as the credential classifiers in
// packages/core/src/index.ts, scripts/lib/release-security.ts, and
// lib/materialization/seeds.ts. This script runs in plain Node, so the reviewed
// patterns are repeated here instead of importing a TypeScript runtime module.
const forbiddenArgumentPatterns = [
  /\bwhsec_[A-Za-z0-9_-]{8,}\b/iu,
  /\bxkeysib-[A-Za-z0-9_-]{12,}\b/iu,
  /\b(?:sk|rk|pk|atk)_(?:live|test)?_?[A-Za-z0-9_-]{8,}\b/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/iu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu,
  /(?:postgres|postgresql):\/\/[^\s"']+:[^\s"']+@/iu,
  /[?&](?:access_token|api_key|token|secret)=[^&\s]{6,}/iu,
  /\b(?:(?:vh|credential)[_-])canary[_-][A-Za-z0-9_-]{6,}\b/iu,
];

const environmentSecrets = Object.entries(process.env)
  .filter(
    ([name, secret]) =>
      /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL)/iu.test(name) &&
      typeof secret === "string" &&
      secret.length >= 8,
  )
  .map(([, secret]) => secret);

function containsCredential(value) {
  return (
    forbiddenArgumentPatterns.some((pattern) => pattern.test(value)) ||
    environmentSecrets.some((secret) => value.includes(secret))
  );
}

function sanitize(value) {
  let output = value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/giu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"']+/giu, "$1[REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [REDACTED_BEARER_TOKEN]")
    .replace(/\bwhsec_[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_WEBHOOK_SECRET]")
    .replace(/\bxkeysib-[A-Za-z0-9_-]{12,}\b/giu, "[REDACTED_BREVO_KEY]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/giu,
      "[REDACTED_GITHUB_TOKEN]",
    )
    .replace(/\b(?:sk|rk|pk|atk)_(?:live|test)?_?[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_PROVIDER_KEY]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu, "[REDACTED_SLACK_TOKEN]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/gu, "[REDACTED_GOOGLE_API_KEY]")
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/gu, "[REDACTED_API_SECRET_KEY]")
    .replace(/(?:postgres|postgresql):\/\/[^\s"']+:[^\s"']+@/giu, "postgresql://[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_JWT]")
    .replace(
      /([?&](?:access_token|api_key|token|secret)=)[^&\s]{6,}/giu,
      "$1[REDACTED_QUERY_CREDENTIAL]",
    )
    .replace(
      /\b(?:(?:vh|credential)[_-])canary[_-][A-Za-z0-9_-]{6,}\b/giu,
      "[REDACTED_CREDENTIAL_CANARY]",
    );
  for (const secret of environmentSecrets) {
    output = output.split(secret).join("[REDACTED_ENV_SECRET]");
  }
  return output;
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  console.error(
    "usage: node scripts/run-audit-command.mjs --id <stable-id> [--cwd <path>] [--artifact <repository-relative-path>]... -- <command> [args...]",
  );
  process.exit(1);
}

if (args.some(containsCredential)) {
  console.error("refusing to execute or persist a command containing a credential-shaped argument");
  process.exit(1);
}

const runnerArgs = args.slice(0, separator);
let id;
let cwdArgument;
const declaredArtifactPaths = [];
for (let index = 0; index < runnerArgs.length; index += 2) {
  const flag = runnerArgs[index];
  const value = runnerArgs[index + 1];
  if (!value || !["--id", "--cwd", "--artifact"].includes(flag)) {
    console.error(sanitize(`invalid audit-runner option near ${flag ?? "<missing>"}`));
    process.exit(1);
  }
  if (flag === "--id") {
    if (id !== undefined) {
      console.error("audit command id may be supplied only once");
      process.exit(1);
    }
    id = value;
  } else if (flag === "--cwd") {
    if (cwdArgument !== undefined) {
      console.error("audit command cwd may be supplied only once");
      process.exit(1);
    }
    cwdArgument = value;
  } else {
    declaredArtifactPaths.push(value);
  }
}

if (!id) {
  console.error("audit command id is required");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
  console.error(
    "audit command id must contain only lowercase letters, digits, dot, underscore, or dash",
  );
  process.exit(1);
}

const repositoryRoot = realpathSync(process.cwd());
const command = args.slice(separator + 1);

function repositoryLocation(path, label, allowRoot = false) {
  const absolutePath = realpathSync(resolve(repositoryRoot, path));
  const fromRoot = relative(repositoryRoot, absolutePath);
  if (
    (!allowRoot && !fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} must resolve inside the repository: ${path}`);
  }
  return { absolutePath, relativePath: fromRoot ? fromRoot.replaceAll("\\", "/") : "." };
}

let cwdLocation;
try {
  cwdLocation = repositoryLocation(cwdArgument ?? ".", "audit command cwd", true);
  if (!statSync(cwdLocation.absolutePath).isDirectory()) {
    throw new Error(`audit command cwd is not a directory: ${cwdArgument}`);
  }
} catch (error) {
  console.error(sanitize(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
const cwd = cwdLocation.absolutePath;
const relativeCwd = cwdLocation.relativePath;

function assertRepositoryRelativePath(path, label) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`${label} must be a repository-relative path: ${path}`);
  }
  const absolutePath = resolve(repositoryRoot, path);
  const fromRoot = relative(repositoryRoot, absolutePath);
  if (
    !fromRoot ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} must resolve inside the repository: ${path}`);
  }
  return absolutePath;
}

if (new Set(declaredArtifactPaths).size !== declaredArtifactPaths.length) {
  console.error("declared audit artifacts must be unique");
  process.exit(1);
}
try {
  for (const path of declaredArtifactPaths) {
    assertRepositoryRelativePath(path, "declared audit artifact");
    if (path === "reports/audit/commands-run.json") {
      throw new Error("reports/audit/commands-run.json cannot hash itself as a command artifact");
    }
  }
} catch (error) {
  console.error(sanitize(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

function quote(part) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(part) ? part : JSON.stringify(part);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactSnapshot(path) {
  const absolutePath = assertRepositoryRelativePath(path, "declared audit artifact");
  if (!existsSync(absolutePath)) return null;
  const stats = lstatSync(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`declared audit artifact is not a regular file: ${path}`);
  }
  const bytes = readFileSync(absolutePath);
  return {
    sha256: digest(bytes),
    bytes: bytes.byteLength,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

const artifactBefore = new Map();
try {
  for (const path of declaredArtifactPaths) artifactBefore.set(path, artifactSnapshot(path));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const reportPath = resolve(repositoryRoot, "reports/audit/commands-run.json");
let initialReport = {
  schemaVersion: 2,
  branch: "sol/vh-core-v0.2-winner-loop",
  records: [],
};
try {
  initialReport = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (![1, 2].includes(initialReport.schemaVersion) || !Array.isArray(initialReport.records)) {
  throw new Error("commands-run ledger has an unsupported schema or malformed records");
}
const initialRecords = Array.isArray(initialReport.records) ? initialReport.records : [];
const attempt =
  Math.max(
    0,
    ...initialRecords
      .filter((entry) => entry.id === id)
      .map((entry) =>
        Number.isSafeInteger(entry.attempt) && entry.attempt > 0 ? entry.attempt : 1,
      ),
  ) + 1;
const relativeLogPath = `reports/audit/command-logs/${id}.attempt-${attempt}.log`;
const logPath = resolve(repositoryRoot, relativeLogPath);
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
let outputTruncated = false;
const maximumBytes = 5 * 1024 * 1024;

function capture(chunk) {
  if (outputBytes >= maximumBytes) {
    outputTruncated = true;
    return;
  }
  const buffer = Buffer.from(chunk);
  const remaining = maximumBytes - outputBytes;
  chunks.push(buffer.subarray(0, remaining));
  outputBytes += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) outputTruncated = true;
}

child.stdout.on("data", capture);
child.stderr.on("data", capture);

child.on("error", (error) => {
  capture(Buffer.from(`\nrunner error: ${error.message}\n`));
});

child.on("close", (code, signal) => {
  const commandExitCode = typeof code === "number" ? code : 1;
  const truncated = outputTruncated;
  const artifacts = [];
  const artifactErrors = [];
  for (const path of declaredArtifactPaths) {
    try {
      const absolutePath = assertRepositoryRelativePath(path, "declared audit artifact");
      const stats = lstatSync(absolutePath);
      if (!stats.isFile()) {
        throw new Error(`declared audit artifact is not a regular file: ${path}`);
      }
      const bytes = readFileSync(absolutePath);
      const sha256 = digest(bytes);
      const before = artifactBefore.get(path);
      const observedAt = Date.now();
      const toleranceMs = 1_000;
      const refreshedDuringCommand =
        stats.mtimeMs >= startedAt.getTime() - toleranceMs &&
        stats.mtimeMs <= observedAt + toleranceMs &&
        stats.ctimeMs >= startedAt.getTime() - toleranceMs &&
        stats.ctimeMs <= observedAt + toleranceMs &&
        (before === null ||
          before === undefined ||
          before.sha256 !== sha256 ||
          before.bytes !== bytes.byteLength ||
          before.mtimeMs !== stats.mtimeMs ||
          before.ctimeMs !== stats.ctimeMs);
      if (!refreshedDuringCommand) {
        throw new Error(
          `declared audit artifact was not generated or refreshed during command: ${path}`,
        );
      }
      artifacts.push({
        path,
        sha256,
        bytes: bytes.byteLength,
        generatedDuringCommand: true,
      });
    } catch (error) {
      artifactErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const endedAt = new Date();
  const auditFailure = artifactErrors.length > 0;
  const exitCode = auditFailure && commandExitCode === 0 ? 1 : commandExitCode;
  const runnerError = artifactErrors.map((message) => `audit runner error: ${message}`).join("\n");
  if (runnerError) process.stderr.write(`${sanitize(runnerError)}\n`);
  const capturedLog = truncated ? "" : sanitize(Buffer.concat(chunks).toString("utf8"));
  const finalLog = `${capturedLog}${runnerError ? `\n${sanitize(runnerError)}\n` : ""}${truncated ? "\n[AUDIT LOG CONTENT OMITTED AFTER EXCEEDING 5 MiB]\n" : ""}`;
  const logBytes = Buffer.from(finalLog, "utf8");
  if (capturedLog) process.stdout.write(capturedLog);
  writeFileSync(logPath, logBytes);

  let report = {
    schemaVersion: 2,
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
    cwd: relativeCwd,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    exitCode,
    signal: signal ?? null,
    status: exitCode === 0 ? "PASSED" : "FAILED",
    skipped: false,
    evidencePath: relativeLogPath,
    integrityVersion: 1,
    evidenceSha256: digest(logBytes),
    evidenceBytes: logBytes.byteLength,
    artifacts,
    outputTruncated: truncated,
  };
  const previous = Array.isArray(report.records) ? report.records : [];
  report.schemaVersion = 2;
  report.records = [...previous, record];
  report.updatedAt = endedAt.toISOString();

  const temporary = `${reportPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporary, reportPath);
  process.exitCode = exitCode;
});
