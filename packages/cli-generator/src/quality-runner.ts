import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { JsonObject, JsonValue } from "@venture-harness/core";

type QualityProfileId = "fast" | "mvp" | "release";
interface QualityProfileRunResult extends JsonObject {
  profile: QualityProfileId;
  status: "PASS" | "FAIL" | "INCOMPLETE";
  exitCode: number;
  summary: JsonObject;
  command: JsonValue;
  stdout: string;
  stderr: string;
  reportPath: string | null;
}
interface QualityProfileRunner {
  run(profile: QualityProfileId): Promise<QualityProfileRunResult>;
}

export interface ProcessQualityProfileRunnerOptions {
  root: string;
  commands: Readonly<Record<QualityProfileId, readonly string[]>>;
  outputLimitBytes?: number;
  timeoutMs?: number;
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END|$)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}/gi,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}/gi,
];

function redact(value: string): string {
  let redacted = SECRET_PATTERNS.reduce(
    (candidate, pattern) => candidate.replace(pattern, "[REDACTED]"),
    value,
  );
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL)/iu.test(name)) continue;
    if (secret && secret.length >= 8) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function canonicalRoot(root: string): string {
  const declared = resolve(root);
  const details = lstatSync(declared);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("quality runner root must be a regular directory, not a symbolic link");
  }
  return realpathSync(declared);
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function assertNoSymlinkPath(root: string, target: string): void {
  if (!inside(root, target)) throw new Error("quality report path escapes the configured root");
  const child = relative(root, target);
  let cursor = root;
  for (const segment of child.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error("quality report path must not contain symbolic links");
    }
  }
}

function reportPath(root: string, profile: QualityProfileId): string {
  const directory = join(root, ".venture", "reports", "quality");
  assertNoSymlinkPath(root, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = realpathSync(directory);
  if (!inside(root, canonicalDirectory)) throw new Error("quality report directory escapes root");
  return join(canonicalDirectory, `vh-${profile}-${process.pid}-${randomUUID()}.json`);
}

function assertCommand(command: readonly string[]): void {
  if (command.length === 0 || command.some((value) => typeof value !== "string" || !value)) {
    throw new Error("quality profile command must be a non-empty argv array");
  }
  const tokens = command.map((value) => value.toLowerCase());
  const executable = basename(tokens[0]!);
  if (
    (executable === "vh" && tokens[1] === "verify") ||
    tokens.some((token, index) => token === "vh" && tokens[index + 1] === "verify")
  ) {
    throw new Error("quality profile command must not recurse into vh verify");
  }
}

function materializeCommand(
  template: readonly string[],
  profile: QualityProfileId,
  targetReport: string,
): string[] {
  const command = template.map((value) =>
    value.replaceAll("{profile}", profile).replaceAll("{report}", targetReport),
  );
  assertCommand(command);
  return command;
}

function capture(limit: number): {
  append(chunk: Buffer | string): void;
  value(): string;
} {
  let text = "";
  let truncated = false;
  return {
    append(chunk) {
      if (truncated) return;
      const value = chunk.toString();
      const remaining = limit - Buffer.byteLength(text);
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const bytes = Buffer.from(value);
      text += bytes.subarray(0, remaining).toString();
      if (bytes.byteLength > remaining) truncated = true;
    },
    value() {
      return redact(`${text}${truncated ? "\n[OUTPUT TRUNCATED]" : ""}`);
    },
  };
}

function count(summary: Record<string, unknown>, field: string): number {
  const value = summary[field];
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function readReport(
  path: string,
  profile: QualityProfileId,
): { status: "PASS" | "FAIL" | "INCOMPLETE"; summary: JsonObject } | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("quality runner report must be a JSON object");
  }
  const report = raw as Record<string, unknown>;
  if (report.profile !== profile) throw new Error("quality runner report profile mismatch");
  if (!report.summary || typeof report.summary !== "object" || Array.isArray(report.summary)) {
    throw new Error("quality runner report summary is missing");
  }
  const summaryRecord = report.summary as Record<string, unknown>;
  const summary: JsonObject = {
    PASS: count(summaryRecord, "PASS"),
    FAIL: count(summaryRecord, "FAIL"),
    SKIP: count(summaryRecord, "SKIP"),
    NOT_APPLICABLE: count(summaryRecord, "NOT_APPLICABLE"),
  };
  const reportedStatus = report.status;
  if (!(["PASS", "FAIL", "INCOMPLETE"] as unknown[]).includes(reportedStatus)) {
    throw new Error("quality runner report status is invalid");
  }
  return { status: reportedStatus as "PASS" | "FAIL" | "INCOMPLETE", summary };
}

function finalStatus(
  exitCode: number,
  report: ReturnType<typeof readReport>,
): "PASS" | "FAIL" | "INCOMPLETE" {
  if (exitCode !== 0 || report?.status === "FAIL" || Number(report?.summary.FAIL ?? 0) > 0) {
    return "FAIL";
  }
  if (!report || report.status === "INCOMPLETE" || Number(report.summary.SKIP ?? 0) > 0) {
    return "INCOMPLETE";
  }
  return "PASS";
}

/** Execute a fixed argv command without a shell and validate its fresh report. */
export function createProcessQualityProfileRunner(
  options: ProcessQualityProfileRunnerOptions,
): QualityProfileRunner {
  const root = canonicalRoot(options.root);
  const outputLimit = options.outputLimitBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1024) {
    throw new Error("quality output limit must be at least 1024 bytes");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("quality timeout must be a positive safe integer");
  }
  for (const command of Object.values(options.commands)) assertCommand(command);

  return Object.freeze({
    async run(profile: QualityProfileId): Promise<QualityProfileRunResult> {
      const targetReport = reportPath(root, profile);
      const command = materializeCommand(options.commands[profile], profile, targetReport);
      const stdout = capture(outputLimit);
      const stderr = capture(outputLimit);
      let timedOut = false;
      const exitCode = await new Promise<number>((resolveExit, reject) => {
        const child = spawn(command[0]!, command.slice(1), {
          cwd: root,
          env: process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
        child.once("error", reject);
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolveExit(code ?? 1);
        });
      }).catch((error: unknown) => {
        stderr.append(error instanceof Error ? error.message : String(error));
        return 1;
      });
      let report: ReturnType<typeof readReport> = null;
      try {
        report = readReport(targetReport, profile);
      } catch (error) {
        stderr.append(error instanceof Error ? error.message : String(error));
      }
      const status = timedOut ? "FAIL" : finalStatus(exitCode, report);
      return {
        profile,
        status,
        exitCode: status === "PASS" ? 0 : 1,
        summary: report?.summary ?? { PASS: 0, FAIL: status === "FAIL" ? 1 : 0, SKIP: 0 },
        command: command.map((value) => redact(value)),
        stdout: stdout.value(),
        stderr: `${stderr.value()}${timedOut ? "\nquality profile timed out" : ""}`.trim(),
        reportPath: relative(root, targetReport),
      };
    },
  });
}

/** Bind `vh verify` to this repository's canonical shared profile runner. */
export function createRepositoryQualityProfileRunner(root: string): QualityProfileRunner {
  const canonical = canonicalRoot(root);
  const runnerPath = join(canonical, "scripts", "run-quality-profile.ts");
  const configured =
    existsSync(runnerPath) &&
    !lstatSync(runnerPath).isSymbolicLink() &&
    lstatSync(runnerPath).isFile() &&
    inside(canonical, realpathSync(runnerPath));
  if (!configured) {
    return Object.freeze({
      async run(profile: QualityProfileId): Promise<QualityProfileRunResult> {
        return {
          profile,
          status: "INCOMPLETE",
          exitCode: 1,
          summary: { PASS: 0, FAIL: 0, SKIP: 1, NOT_APPLICABLE: 0 },
          command: [],
          stdout: "",
          stderr: "The project has no trusted scripts/run-quality-profile.ts runner.",
          reportPath: null,
        };
      },
    });
  }
  const command = [
    "pnpm",
    "exec",
    "tsx",
    "scripts/run-quality-profile.ts",
    "{profile}",
    "--report",
    "{report}",
  ] as const;
  return createProcessQualityProfileRunner({
    root: canonical,
    commands: { fast: command, mvp: command, release: command },
  });
}
