import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CommandBusError,
  commandFailureEnvelope,
  type AnyCommandContract,
  type CommandBus,
  type CommandInvocationOptions,
} from "@venture-harness/command-bus";
import { stableJson, type JsonObject, type JsonValue } from "@venture-harness/core";
import type { GeneratedCliResult } from "./index.js";

const EMPTY_INPUT_COMMANDS = new Set([
  "system.doctor",
  "org.list",
  "stack.list",
  "pack.list",
  "seed.list",
  "grant.list",
  "provider.list",
  "upgrade.status",
  "data.sync",
  "run.list",
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END|$)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/gi,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]+/gi,
];

function redact(value: string): string {
  return SECRET_PATTERNS.reduce((safe, pattern) => safe.replace(pattern, "[REDACTED]"), value);
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionals(args: readonly string[]): string[] {
  const valuedFlags = new Set([
    "--brief",
    "--cadence",
    "--context",
    "--file",
    "--idempotency-key",
    "--idea",
    "--input",
    "--name",
    "--org-id",
    "--path",
    "--run-id",
    "--runtime-module",
    "--state-dir",
    "--project-root",
    "--provider",
    "--ref",
    "--backend",
    "--kind",
    "--scopes",
    "--release",
    "--release-id",
    "--venture-ids",
    "--batch-size",
    "--venture-id",
  ]);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value.startsWith("-")) {
      if (valuedFlags.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return normalized.length >= 2 ? normalized : "local-venture";
}

interface ResolvedCommand {
  commandId: string;
  tokens: readonly [string, string];
  bootstrap: boolean;
}

function resolveCommand(
  args: readonly string[],
  contracts: readonly AnyCommandContract[],
): ResolvedCommand | null {
  const values = positionals(args);
  const [first, second] = values;
  if (!first) return null;
  if (second) {
    const exact = contracts.find(
      ({ surfaces }) => surfaces.cli.tokens[0] === first && surfaces.cli.tokens[1] === second,
    );
    if (exact) {
      return { commandId: exact.id, tokens: exact.surfaces.cli.tokens, bootstrap: false };
    }
  }
  if (first === "doctor")
    return { commandId: "system.doctor", tokens: ["system", "doctor"], bootstrap: false };
  if (first === "create")
    return {
      commandId: "venture.create",
      tokens: ["venture", "create"],
      bootstrap: Boolean(flag(args, "--brief") || flag(args, "--idea")),
    };
  if (first === "plan")
    return { commandId: "venture.plan", tokens: ["venture", "plan"], bootstrap: false };
  if (first === "launch")
    return { commandId: "venture.launch", tokens: ["venture", "launch"], bootstrap: false };
  if (first === "resume")
    return { commandId: "venture.resume", tokens: ["venture", "resume"], bootstrap: false };
  if (first === "status") {
    if (flag(args, "--venture-id"))
      return { commandId: "venture.status", tokens: ["venture", "status"], bootstrap: false };
    if (second || flag(args, "--run-id"))
      return { commandId: "run.status", tokens: ["run", "status"], bootstrap: false };
    return { commandId: "run.list", tokens: ["run", "list"], bootstrap: false };
  }
  if (first === "learn" && second !== "run")
    return { commandId: "learn.run", tokens: ["learn", "run"], bootstrap: false };
  if (first === "verify" && second !== "run")
    return { commandId: "verify.run", tokens: ["verify", "run"], bootstrap: false };
  if (["org", "stack", "pack", "seed", "grant", "provider", "run"].includes(first) && !second) {
    const action = first === "run" ? "list" : "list";
    return { commandId: `${first}.${action}`, tokens: [first, action], bootstrap: false };
  }
  if (!second) return null;
  return { commandId: `${first}.${second}`, tokens: [first, second], bootstrap: false };
}

function parseJsonObject(raw: string, field: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must contain a JSON object`);
  }
  return value as JsonObject;
}

function ventureId(args: readonly string[], values: readonly string[]): string {
  return flag(args, "--venture-id") ?? values[2] ?? "local-venture";
}

function inputFor(commandId: string, args: readonly string[]): JsonObject {
  const rawInput = flag(args, "--input");
  if (rawInput) return parseJsonObject(rawInput, "--input");
  if (EMPTY_INPUT_COMMANDS.has(commandId)) return {};
  const values = positionals(args);
  if (commandId === "idea.compile") {
    const brief = flag(args, "--brief");
    const idea = flag(args, "--idea") ?? (brief ? readFileSync(brief, "utf8") : values[2]);
    if (!idea) throw new Error("idea compile requires --idea <text> or --brief <file>");
    const name = flag(args, "--name") ?? "Local Venture";
    return { idea, ventureId: flag(args, "--venture-id") ?? slug(name), name };
  }
  if (commandId === "venture.create") {
    const id = ventureId(args, values);
    return { ventureId: id, name: flag(args, "--name") ?? "Local Venture" };
  }
  if (commandId === "venture.plan" || commandId === "venture.status") {
    return { ventureId: ventureId(args, values) };
  }
  if (commandId === "venture.launch") {
    if (args.includes("--apply")) {
      throw new Error("provider apply is unavailable in the packaged local runtime; no effect ran");
    }
    if (!args.includes("--dry-run")) throw new Error("venture launch requires --dry-run");
    const id = ventureId(args, values);
    return { ventureId: id, runId: flag(args, "--run-id") ?? `run-${id}`, dryRun: true };
  }
  if (commandId === "venture.resume" || commandId === "run.status") {
    const runId = flag(args, "--run-id") ?? values[2] ?? values[1];
    if (!runId) throw new Error(`${commandId} requires a run id`);
    return { runId };
  }
  if (commandId === "learn.run") {
    const cadence = flag(args, "--cadence") ?? (values[1] === "run" ? values[2] : values[1]);
    if (!cadence) throw new Error("learn requires daily, weekly, biweekly, or monthly");
    return { cadence };
  }
  if (commandId === "growth.inspect") {
    return { path: flag(args, "--file") ?? flag(args, "--path") ?? "config/growth.yaml" };
  }
  if (commandId === "verify.run") {
    const profile = values[1] === "run" ? values[2] : values[1];
    if (!profile) throw new Error("verify requires fast, mvp, or release");
    return { profile };
  }
  if (commandId.startsWith("auth.")) {
    const providerId = flag(args, "--provider") ?? values[2];
    const credentialRef = flag(args, "--ref");
    if (commandId === "auth.login") {
      if (!providerId) throw new Error("auth login requires a provider identifier");
      return {
        providerId,
        ...(credentialRef ? { credentialRef } : {}),
        ...(flag(args, "--backend") ? { backend: flag(args, "--backend")! } : {}),
        ...(flag(args, "--kind") ? { kind: flag(args, "--kind")! } : {}),
        scopes: (flag(args, "--scopes") ?? "")
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
      };
    }
    return {
      ...(providerId ? { providerId } : {}),
      ...(credentialRef ? { credentialRef } : {}),
    };
  }
  if (
    commandId === "upgrade.plan" ||
    commandId === "upgrade.dry-run" ||
    commandId === "upgrade.apply"
  ) {
    const releaseLocator = flag(args, "--release") ?? values[2];
    if (!releaseLocator) {
      throw new Error(`${commandId} requires --release <trusted-local-release-root>`);
    }
    return { releaseLocator };
  }
  if (commandId === "fleet.plan" || commandId === "fleet.rollout" || commandId === "fleet.resume") {
    const runId = flag(args, "--run-id");
    const releaseId = flag(args, "--release-id");
    const ventureIds = (flag(args, "--venture-ids") ?? flag(args, "--venture-id") ?? "")
      .split(",")
      .map((venture) => venture.trim())
      .filter(Boolean);
    const batchSize = Number(flag(args, "--batch-size") ?? "1");
    if (!runId || !releaseId || ventureIds.length === 0) {
      throw new Error(
        `${commandId} requires --run-id, --release-id, and --venture-ids <comma-separated>`,
      );
    }
    return { runId, releaseId, ventureIds, batchSize };
  }
  if (commandId === "fleet.status") {
    const runId = flag(args, "--run-id") ?? values[2];
    return runId ? { runId } : {};
  }
  return {};
}

function invocation(
  commandId: string,
  input: JsonObject,
  args: readonly string[],
  options: CommandInvocationOptions,
): CommandInvocationOptions {
  const supplied = flag(args, "--idempotency-key");
  const digest = createHash("sha256")
    .update(stableJson({ commandId, input }))
    .digest("hex")
    .slice(0, 24);
  return { context: options.context, idempotencyKey: supplied ?? `vh-local-${digest}` };
}

function rendered(value: JsonValue, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return String(value);
  const heading = typeof value.commandId === "string" ? value.commandId : "command";
  const status = typeof value.status === "string" ? value.status : "completed";
  const mode = typeof value.mode === "string" ? ` (${value.mode})` : "";
  return `${heading}: ${status}${mode}`;
}

export const OPERATIONAL_CLI_HELP = `Packaged Venture Harness operational CLI

Local and read-only commands:
  vh doctor --json
  vh idea compile --idea <text> --venture-id <id> --name <name> --json
  vh create --venture-id <id> --name <name> --json
  vh venture plan --venture-id <id> --json
  vh venture launch --dry-run --venture-id <id> [--run-id <id>] --json
  vh venture status --venture-id <id> --json
  vh run list | status <run-id>
  vh resume <run-id> --json
  vh org|stack|pack|seed|grant|provider [list]
  vh data sync
  vh learn daily|weekly|biweekly|monthly
  vh growth inspect [--file <growth.yaml>] --json
  vh auth login|status|test|revoke [provider] [--ref <cred://...>]
  vh upgrade plan|dry-run|apply --release <trusted-local-root>
  vh upgrade status
  vh fleet status [--run-id <id>]
  vh fleet plan|rollout|resume --run-id <id> --release-id <id>
      --venture-ids <id,...> [--batch-size <positive-integer>]
  vh verify fast|mvp|release

Every packaged command is noninteractive. The default runtime remains local and
unconfigured for provider effects. A production provider/Stack command requires
--runtime-module <compiled-project-module>, exact --context, and an idempotency
key; publishing, sending, spend, upgrade, and fleet effects remain separately
authorization-gated.`;

export async function invokeOperationalCli(
  bus: CommandBus,
  args: readonly string[],
  options: CommandInvocationOptions,
): Promise<GeneratedCliResult> {
  const json = args.includes("--json");
  try {
    const resolved = resolveCommand(args, bus.contracts());
    if (!resolved) throw new Error(`unknown packaged command; run vh --help`);
    const contract = bus.contracts().find((candidate) => candidate.id === resolved.commandId);
    if (!contract) {
      const domain = resolved.tokens[0];
      const next =
        domain === "auth"
          ? "choose vh auth login|status|test|revoke"
          : domain === "upgrade"
            ? "choose vh upgrade plan|dry-run|apply|status"
            : domain === "fleet"
              ? "choose vh fleet status|plan|rollout|resume"
              : "run vh --help";
      throw new Error(`unknown packaged command: ${resolved.commandId}; ${next}`);
    }

    if (resolved.bootstrap) {
      const ideaInput = inputFor("idea.compile", args);
      const compiled = await bus.executeById(
        "idea.compile",
        ideaInput,
        invocation("idea.compile", ideaInput, args, options),
      );
      const createInput = {
        ventureId: ideaInput.ventureId!,
        name: ideaInput.name!,
      } as JsonObject;
      const created = await bus.executeById(
        "venture.create",
        createInput,
        invocation("venture.create", createInput, args, options),
      );
      return {
        exitCode: 0,
        stdout: rendered({ commandId: "venture.bootstrap", compiled, created }, json),
        stderr: "",
      };
    }

    const input = inputFor(resolved.commandId, args);
    const output = await bus.executeById(
      resolved.commandId,
      input,
      invocation(resolved.commandId, input, args, options),
    );
    const verifyPassed =
      resolved.commandId !== "verify.run" ||
      (typeof output === "object" &&
        output !== null &&
        !Array.isArray(output) &&
        output.status === "PASS");
    return { exitCode: verifyPassed ? 0 : 1, stdout: rendered(output, json), stderr: "" };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    const failure =
      error instanceof CommandBusError
        ? commandFailureEnvelope(error)
        : {
            error: "operational_command_failed",
            code: "invalid_invocation",
            message,
          };
    return {
      exitCode: 1,
      stdout: "",
      stderr: json ? JSON.stringify(failure) : message,
    };
  }
}
