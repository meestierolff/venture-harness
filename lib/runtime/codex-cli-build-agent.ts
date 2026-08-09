import { resolve } from "node:path";
import { z } from "zod";
import { artifactReferenceSchema, looksLikeCredentialValue } from "../config/contracts";
import { Redactor, type CommandRunner } from "../credentials";
import {
  BuildAgentHostError,
  type BuildAgentHost,
  type BuildAgentHostInspection,
  type BuildAgentRequest,
  type BuildAgentResult,
  type BuildAgentUsage,
} from "./build-agent-host";

const buildAgentCheckSchema = z
  .object({
    command: z.string().min(1).max(500),
    status: z.enum(["passed", "failed", "skipped"]),
    evidence: z.string().max(2_000).nullable(),
  })
  .strict();

const buildAgentArtifactRoleSchema = z.enum([
  "repository_scaffold",
  "managed_manifest",
  "design_record",
  "design_implementation",
  "core_journey",
  "affected_test",
  "event_contract",
  "event_instrumentation",
  "validation_record",
  "concierge_operations",
  "usage_proof",
]);

const buildAgentCompletionSchema = z
  .object({
    outcome: z.enum(["changed", "already_compliant"]),
    artifacts: z
      .array(
        z
          .object({
            path: artifactReferenceSchema,
            role: buildAgentArtifactRoleSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (artifacts) =>
          new Set(artifacts.map(({ path, role }) => `${role}:${path}`)).size === artifacts.length,
        "completion artifacts must be unique by role and path",
      ),
    validator: z
      .object({
        check_command: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

const buildAgentFinalResultSchema = z
  .object({
    status: z.enum(["completed", "blocked"]),
    summary: z.string().min(1).max(4_000),
    changed_files: z.array(artifactReferenceSchema).max(500),
    checks: z.array(buildAgentCheckSchema).max(100),
    limitations: z.array(z.string().min(1).max(2_000)).max(100),
    completion: buildAgentCompletionSchema.nullable(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "blocked") return;
    if (!result.completion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completion"],
        message: "completed tasks require typed completion evidence",
      });
      return;
    }
    if (result.completion.outcome === "changed" && result.changed_files.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_files"],
        message: "changed completion requires at least one reported file",
      });
    }
    if (result.completion.outcome === "already_compliant" && result.changed_files.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_files"],
        message: "already_compliant completion cannot report changed files",
      });
    }
    const validator = result.checks.find(
      ({ command }) => command === result.completion?.validator.check_command,
    );
    if (validator?.status !== "passed" || !validator.evidence?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completion", "validator", "check_command"],
        message: "completion validator must reference a passed check with non-empty evidence",
      });
    }
  });

const FORBIDDEN_CONTEXT_KEY =
  /^(access_token|refresh_token|id_token|api_key|secret|client_secret|private_key|password|credential_value)$/i;

export const CODEX_EXEC_ARGS = [
  "exec",
  "--sandbox",
  "workspace-write",
  "--ephemeral",
  "--ignore-user-config",
  "--json",
] as const;

export interface CodexCliBuildAgentHostOptions {
  rootDir: string;
  runner: CommandRunner;
  redactor?: Redactor;
  binary?: string;
}

const CODEX_ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "PATH",
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "CI",
  "SystemRoot",
  "PATHEXT",
] as const;

const PRODUCT_COMMAND_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "CI",
  "SystemRoot",
  "PATHEXT",
] as const;

/**
 * Deliberately excludes venture/provider credential environment variables.
 * The Codex CLI must use its own authenticated CLI session.
 */
export function codexBuildAgentEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    NODE_ENV: source.NODE_ENV ?? "production",
    ...Object.fromEntries(
      CODEX_ENVIRONMENT_KEYS.flatMap((key) =>
        source[key] === undefined ? [] : [[key, source[key]]],
      ),
    ),
  };
}

/**
 * Environment for deterministic commands executed inside a generated child.
 * Provider credentials, the founder's Codex auth directory, and user package
 * configuration are deliberately excluded. HOME/XDG/npm configuration are
 * redirected into the child-owned private runtime directory.
 */
export function productCommandEnvironment(
  source: NodeJS.ProcessEnv,
  isolatedHome: string,
): NodeJS.ProcessEnv {
  const home = resolve(isolatedHome);
  return {
    NODE_ENV: source.NODE_ENV ?? "production",
    ...Object.fromEntries(
      PRODUCT_COMMAND_ENVIRONMENT_KEYS.flatMap((key) =>
        source[key] === undefined ? [] : [[key, source[key]]],
      ),
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: resolve(home, ".config"),
    npm_config_userconfig: resolve(home, ".npmrc"),
    NPM_CONFIG_USERCONFIG: resolve(home, ".npmrc"),
  };
}

function assertCredentialFree(value: unknown, path = "context"): void {
  if (typeof value === "string") {
    if (looksLikeCredentialValue(value)) {
      throw new BuildAgentHostError(
        "credential_material",
        `${path} contains credential material; the build-agent boundary accepts no secret values.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCredentialFree(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_CONTEXT_KEY.test(key)) {
      throw new BuildAgentHostError(
        "credential_material",
        `${path}.${key} is a forbidden credential field; pass no secret values to a build agent.`,
      );
    }
    assertCredentialFree(entry, `${path}.${key}`);
  }
}

function promptFor(request: BuildAgentRequest, redactor: Redactor): string {
  assertCredentialFree(request.context);
  const context = redactor.redact(request.context);
  return [
    "Execute one bounded Venture Harness product-build task in the current repository.",
    "Read AGENTS.md, PROJECT.md, docs/product/PRODUCT_TRUTH.md, the typed config, and only the skill/docs needed for this task.",
    "Work only inside the repository. Do not deploy, publish, send, charge, change DNS, create provider resources, commit, push, or expose credentials.",
    "Use deterministic code and existing scripts when they are sufficient. Preserve venture-owned work and label samples, prototypes, and unverified state honestly.",
    "Never read or print credential values. Repository config may contain only cred:// references.",
    `Run ID: ${request.runId}`,
    `Node ID: ${request.nodeId}`,
    `Purpose: ${request.purpose}`,
    "Task instructions:",
    request.instructions,
    "Bounded JSON context:",
    JSON.stringify(context, null, 2),
    "When finished, return exactly one JSON object as the final response, with no Markdown fence or surrounding prose:",
    '{"status":"completed|blocked","summary":"concise factual result","changed_files":["repo/relative/path"],"checks":[{"command":"literal direct command","status":"passed|failed|skipped","evidence":"concise observed evidence or null"}],"limitations":["genuine limitation"],"completion":{"outcome":"changed|already_compliant","artifacts":[{"path":"repo/relative/path","role":"repository_scaffold|managed_manifest|design_record|design_implementation|core_journey|affected_test|event_contract|event_instrumentation|validation_record|concierge_operations|usage_proof"}],"validator":{"check_command":"exact command from checks"}}}',
    "Use status=blocked and completion=null when the task is not actually complete. Use outcome=changed only for files whose content changed during this task. Use outcome=already_compliant only when no repository file changed and the named direct validator proves the requested completion condition. List only repository-relative files and artifacts that exist at the end. Do not include raw file contents, secrets, tokens, personal data, or provider response bodies.",
  ].join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assistantText(event: unknown): string | null {
  const record = asRecord(event);
  if (!record) return null;

  if (record.type === "item.completed") {
    const item = asRecord(record.item);
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  }
  if (record.type === "turn.completed" && typeof record.final_output === "string") {
    return record.final_output;
  }
  if (record.type === "result" && typeof record.result === "string") return record.result;
  return null;
}

function usageFrom(event: unknown): BuildAgentUsage | undefined {
  const record = asRecord(event);
  if (record?.type !== "turn.completed") return undefined;
  const usage = asRecord(record.usage);
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cached_input_tokens;
  const outputTokens = usage.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof cachedInputTokens !== "number" ||
    typeof outputTokens !== "number"
  ) {
    return undefined;
  }
  return { inputTokens, cachedInputTokens, outputTokens };
}

function parseJsonLines(stdout: string): {
  finalText: string;
  eventTypes: string[];
  usage?: BuildAgentUsage;
} {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const finalTexts: string[] = [];
  const eventTypes = new Set<string>();
  let usage: BuildAgentUsage | undefined;

  for (const [index, line] of lines.entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new BuildAgentHostError(
        "invalid_jsonl",
        `Codex JSONL line ${index + 1} was not valid JSON; no result was accepted.`,
      );
    }
    const type = asRecord(event)?.type;
    if (typeof type === "string") eventTypes.add(type);
    const text = assistantText(event);
    if (text) finalTexts.push(text);
    usage = usageFrom(event) ?? usage;
  }

  const finalText = finalTexts.at(-1);
  if (!finalText) {
    throw new BuildAgentHostError(
      "missing_final_result",
      "Codex JSONL contained no final structured agent result; no task result was accepted.",
    );
  }
  return { finalText, eventTypes: [...eventTypes].sort(), usage };
}

function compactVersion(value: string, redactor: Redactor): string | null {
  const line = redactor
    .redactText(value)
    .split(/\r?\n/)
    .find((entry) => entry.trim().length > 0);
  return line ? line.trim().slice(0, 200) : null;
}

export class CodexCliBuildAgentHost implements BuildAgentHost {
  readonly id = "codex_cli";
  private readonly rootDir: string;
  private readonly runner: CommandRunner;
  private readonly redactor: Redactor;
  private readonly binary: string;
  private inspection?: Promise<BuildAgentHostInspection>;

  constructor(options: CodexCliBuildAgentHostOptions) {
    this.rootDir = resolve(options.rootDir);
    this.runner = options.runner;
    this.redactor = options.redactor ?? new Redactor();
    this.binary = options.binary ?? "codex";
  }

  inspect(): Promise<BuildAgentHostInspection> {
    this.inspection ??= this.inspectOnce();
    return this.inspection;
  }

  private async inspectOnce(): Promise<BuildAgentHostInspection> {
    try {
      const result = await this.runner.run({
        command: this.binary,
        args: ["--version"],
        cwd: this.rootDir,
      });
      if (result.exitCode === 0) {
        const login = await this.runner.run({
          command: this.binary,
          args: ["login", "status"],
          cwd: this.rootDir,
        });
        const loginStatus = this.redactor.redactText(`${login.stdout}\n${login.stderr}`);
        const billingMode =
          login.exitCode !== 0
            ? "unknown"
            : /logged in using chatgpt|chatgpt (?:account|subscription)/iu.test(loginStatus)
              ? "chatgpt_subscription"
              : /api[ -]?key|openai_api_key/iu.test(loginStatus)
                ? "api_key_metered"
                : "unknown";
        return {
          host: this.id,
          status: "available",
          version: compactVersion(result.stdout || result.stderr, this.redactor),
          billingMode,
          billingEvidence: "codex_login_status",
          nextAction:
            billingMode === "chatgpt_subscription"
              ? null
              : "Run codex login with a ChatGPT subscription account; API-key or unknown billing cannot satisfy the founder non-metered build policy.",
        };
      }
      return {
        host: this.id,
        status: "unavailable",
        version: null,
        billingMode: "unknown",
        billingEvidence: null,
        nextAction: `codex exists but its version check exited ${result.exitCode}; authenticate or repair the Codex CLI before launch apply.`,
      };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return {
        host: this.id,
        status: missing ? "missing" : "unavailable",
        version: null,
        billingMode: "unknown",
        billingEvidence: null,
        nextAction: missing
          ? "Install and authenticate the Codex CLI, then rerun the same launch command."
          : `Codex CLI inspection failed: ${this.redactor.redactText(
              error instanceof Error ? error.message : String(error),
            )}`,
      };
    }
  }

  async run(request: BuildAgentRequest): Promise<BuildAgentResult> {
    const inspection = await this.inspect();
    if (inspection.status !== "available") {
      throw new BuildAgentHostError(
        "host_unavailable",
        inspection.nextAction ?? "Codex CLI is unavailable; no product task was run.",
      );
    }
    const prompt = promptFor(request, this.redactor);
    const result = await this.runner.run({
      command: this.binary,
      args: [...CODEX_EXEC_ARGS, "-C", this.rootDir, "-"],
      cwd: this.rootDir,
      stdin: prompt,
      sensitiveStdin: true,
      signal: request.signal,
    });
    if (result.exitCode !== 0) {
      const detail = this.redactor
        .redactText(result.stderr || result.stdout)
        .trim()
        .slice(0, 2_000);
      throw new BuildAgentHostError(
        "process_failed",
        `Codex build task exited ${result.exitCode}${detail ? `: ${detail}` : ""}`,
      );
    }

    const parsedJsonLines = parseJsonLines(result.stdout);
    let finalValue: unknown;
    try {
      finalValue = JSON.parse(parsedJsonLines.finalText);
    } catch {
      throw new BuildAgentHostError(
        "invalid_final_result",
        "Codex final agent message was not the required JSON object; no task result was accepted.",
      );
    }
    const parsed = buildAgentFinalResultSchema.safeParse(this.redactor.redact(finalValue));
    if (!parsed.success) {
      throw new BuildAgentHostError(
        "invalid_final_result",
        `Codex final result did not match the build-agent contract: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return {
      status: parsed.data.status,
      summary: parsed.data.summary,
      changedFiles: parsed.data.changed_files,
      checks: parsed.data.checks,
      limitations: parsed.data.limitations,
      eventTypes: parsedJsonLines.eventTypes,
      completion: parsed.data.completion
        ? {
            outcome: parsed.data.completion.outcome,
            artifacts: parsed.data.completion.artifacts,
            validator: {
              checkCommand: parsed.data.completion.validator.check_command,
            },
          }
        : null,
      usage: parsedJsonLines.usage,
    };
  }
}
