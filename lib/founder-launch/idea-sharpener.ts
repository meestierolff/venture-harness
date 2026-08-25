import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCredentialMaterial } from "../../packages/core/src/index";
import { Redactor, type CommandRunner } from "../credentials";
import {
  assertLaunchContractSafe,
  launchContractSchema,
  parseLaunchContractSource,
  renderFounderIdea,
  renderProductConstitution,
  type LaunchContract,
} from "./launch-contract";

export const IDEA_SHARPENER_PRIMARY_CALL_LIMIT = 1 as const;
export const IDEA_SHARPENER_REFINEMENT_CALL_LIMIT = 1 as const;
export const IDEA_SHARPENER_TOTAL_CALL_LIMIT = 2 as const;
export const IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT = 24_000 as const;

export interface IdeaSharpenerUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model?: string;
}

export interface IdeaSharpenerModelResult {
  finalText: string;
  usage?: IdeaSharpenerUsage;
}

export interface IdeaSharpenerHost {
  readonly id: string;
  run(input: {
    prompt: string;
    phase: "primary" | "refinement";
    signal?: AbortSignal;
  }): Promise<IdeaSharpenerModelResult>;
}

export interface IdeaSharpenResult {
  schemaVersion: 1;
  status: "already_structured" | "sharpened";
  launchContract: LaunchContract;
  ideaMarkdown: string;
  productConstitutionMarkdown: string;
  accounting: IdeaSharpenAccounting;
}

export interface IdeaSharpenAccounting {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelCalls: number;
  elapsedMs: number;
  assumptionsAdded: readonly string[];
  contradictionsDetected: readonly string[];
  contextCharacters: number;
  host: string | null;
  model: string | null;
}

export class IdeaSharpenError extends Error {
  constructor(
    message: string,
    readonly accounting: IdeaSharpenAccounting,
  ) {
    super(message);
    this.name = "IdeaSharpenError";
  }
}

export interface SharpenIdeaOptions {
  host?: IdeaSharpenerHost;
  now?: () => Date;
  signal?: AbortSignal;
}

const CODEX_IDEA_SHARPENER_ARGS = [
  "exec",
  "--sandbox",
  "read-only",
  "--ephemeral",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--json",
] as const;

const SAFE_ENVIRONMENT_KEYS = [
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

export function ideaSharpenerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    NODE_ENV: source.NODE_ENV ?? "production",
    ...Object.fromEntries(
      SAFE_ENVIRONMENT_KEYS.flatMap((key) =>
        source[key] === undefined ? [] : [[key, source[key]]],
      ),
    ),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assistantText(event: unknown): string | null {
  const record = objectRecord(event);
  if (!record) return null;
  if (record.type === "item.completed") {
    const item = objectRecord(record.item);
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  }
  if (record.type === "turn.completed" && typeof record.final_output === "string") {
    return record.final_output;
  }
  if (record.type === "result" && typeof record.result === "string") return record.result;
  return null;
}

function eventUsage(event: unknown): IdeaSharpenerUsage | undefined {
  const record = objectRecord(event);
  if (record?.type !== "turn.completed") return undefined;
  const usage = objectRecord(record.usage);
  if (!usage) return undefined;
  if (
    typeof usage.input_tokens !== "number" ||
    typeof usage.cached_input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof record.model === "string" && record.model.trim()
      ? { model: record.model.trim() }
      : {}),
  };
}

function parseCodexJsonLines(stdout: string): IdeaSharpenerModelResult {
  const finalTexts: string[] = [];
  let usage: IdeaSharpenerUsage | undefined;
  for (const [index, line] of stdout
    .split(/\r?\n/u)
    .filter((candidate) => candidate.trim().length > 0)
    .entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Codex sharpener JSONL line ${index + 1} was invalid`);
    }
    const text = assistantText(event);
    if (text) finalTexts.push(text);
    usage = eventUsage(event) ?? usage;
  }
  const finalText = finalTexts.at(-1);
  if (!finalText) throw new Error("Codex sharpener returned no final Launch Contract");
  return { finalText, usage };
}

export interface CodexCliIdeaSharpenerHostOptions {
  runner: CommandRunner;
  binary?: string;
  redactor?: Redactor;
  /** Pins the same model identity used by a controlled benchmark. */
  model?: string;
}

/** A no-provider, read-only Codex host isolated from the Core and venture trees. */
export class CodexCliIdeaSharpenerHost implements IdeaSharpenerHost {
  readonly id = "codex_cli";
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly redactor: Redactor;
  private readonly model: string | null;

  constructor(options: CodexCliIdeaSharpenerHostOptions) {
    this.runner = options.runner;
    this.binary = options.binary ?? "codex";
    this.redactor = options.redactor ?? new Redactor();
    this.model = options.model?.trim() || process.env.VH_CODEX_MODEL?.trim() || null;
  }

  async run(input: {
    prompt: string;
    phase: "primary" | "refinement";
    signal?: AbortSignal;
  }): Promise<IdeaSharpenerModelResult> {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "vh-idea-sharpen-"));
    try {
      const result = await this.runner.run({
        command: this.binary,
        args: [
          ...CODEX_IDEA_SHARPENER_ARGS,
          ...(this.model ? ["--model", this.model] : []),
          "-C",
          isolatedRoot,
          "-",
        ],
        cwd: isolatedRoot,
        stdin: input.prompt,
        sensitiveStdin: true,
        env: ideaSharpenerEnvironment(process.env),
        signal: input.signal,
      });
      if (result.exitCode !== 0) {
        const detail = this.redactor
          .redactText(result.stderr || result.stdout)
          .trim()
          .slice(0, 2_000);
        throw new Error(
          `Codex idea ${input.phase} call exited ${result.exitCode}${detail ? `: ${detail}` : ""}`,
        );
      }
      const parsed = parseCodexJsonLines(result.stdout);
      return {
        ...parsed,
        usage: parsed.usage
          ? { ...parsed.usage, ...(parsed.usage.model || !this.model ? {} : { model: this.model }) }
          : undefined,
      };
    } finally {
      rmSync(isolatedRoot, { force: true, recursive: true });
    }
  }
}

function schemaSkeleton(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      venture: {
        name: "",
        slug: "",
        oneSentenceThesis: "",
        targetUser: "",
        painfulJob: "",
        desiredOutcome: "",
        differentiation: "",
        founderAdvantage: "",
      },
      product: {
        oneCoreFeature: "",
        primaryJourney: [""],
        primaryCta: "",
        explicitNotBuilding: [""],
        designThesis: "",
        trustRequirements: [],
      },
      business: {
        model: "subscription | one_time | usage | service | take_rate | free",
        priceHypothesis: null,
        currency: "EUR",
        paymentProvider: "stripe | revenuecat | none",
        commercialCommitmentEvent: "",
      },
      distribution: {
        firstChannel: "",
        firstUserHabitat: "",
        initialMessage: "",
        firstValidationAction: "",
      },
      decision: {
        launchMode: "thin_mvp | product_first | validate_first | concierge_first",
        primarySuccessSignal: "snake_case_event",
        reviewDate: "YYYY-MM-DD",
        continueRule: "",
        changeRule: "",
        stopRule: "",
      },
      truth: {
        facts: [],
        assumptions: [],
        inferences: [],
        contradictions: [],
        unknowns: [],
        externalEvidence: [],
      },
      agentNative: {
        customerAgentSurfaceRequired: false,
        serviceBlueprintRequired: false,
        outcomeCommands: [],
      },
    },
    null,
    2,
  );
}

function primaryPrompt(source: string, today: string): string {
  return [
    "Turn one rough founder idea into the smallest credible Launch Contract.",
    "This is one bounded judgement call. Do not browse, use tools, read files, plan provider operations, or write code.",
    "Return exactly one JSON object matching the skeleton below, with no Markdown fence or prose.",
    "Use one user, one painful job, one useful outcome, one core feature, one journey, one CTA, one commitment, one channel, one success signal, one review date, and an explicit not-building list.",
    "Do not invent demand, users, quotes, revenue, metrics, provider state, external evidence, founder credentials, market size, or pricing certainty. Put reversible uncertainty in truth.assumptions, truth.inferences, or truth.unknowns.",
    "Default to thin_mvp. Use product_first only when real usage is indispensable, validate_first only when risk or cost makes a smaller demand test necessary, and concierge_first only when honest manual delivery is materially better.",
    "Default business.model to free and paymentProvider to none unless the founder proposes present commerce. Use Stripe for supported web subscription, one-time, or service commerce and RevenueCat only for native subscription or one-time digital commerce. Preserve usage and take_rate models with paymentProvider none until their automatic rails are implemented. priceHypothesis is one positive numeric amount or null. For usage, record the exact per-unit meter in commercialCommitmentEvent, truth.facts, or truth.assumptions. For take_rate, record the exact percentage-of-transaction basis there.",
    "Do not require auth, persistence, email, analytics, search, agents, or scheduled work unless the primary journey actually needs it. Put material implementation needs in product.trustRequirements using direct terms such as authentication, persisted state, transactional email, analytics, or SEO.",
    `Today is ${today}; choose a concrete reviewDate after today without claiming future evidence.`,
    "Schema skeleton (replace every placeholder and use only the listed keys/enums):",
    schemaSkeleton(),
    "Rough founder idea:",
    source,
  ].join("\n\n");
}

function refinementPrompt(candidate: string, issues: string[], today: string): string {
  return [
    "Repair this candidate into the exact Launch Contract schema. This is the only refinement call.",
    "Return exactly one JSON object with no Markdown fence or prose. Preserve sound venture decisions; change only what is needed for a small, credential-free, internally consistent contract.",
    `Today is ${today}; reviewDate must be a real date after today.`,
    "Schema skeleton:",
    schemaSkeleton(),
    "Validation issues:",
    issues.join("\n"),
    "Candidate:",
    candidate.slice(0, IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT / 2),
  ].join("\n\n");
}

function jsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  return JSON.parse(withoutFence);
}

function validateCandidate(
  text: string,
): { success: true; contract: LaunchContract } | { success: false; issues: string[] } {
  let candidate: unknown;
  try {
    candidate = jsonCandidate(text);
  } catch {
    return { success: false, issues: ["result: expected one valid JSON object"] };
  }
  const parsed = launchContractSchema.safeParse(candidate);
  if (parsed.success) {
    return { success: true, contract: assertLaunchContractSafe(parsed.data) };
  }
  return {
    success: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`,
    ),
  };
}

function accounting(
  status: IdeaSharpenResult["status"],
  contract: LaunchContract,
  usages: readonly IdeaSharpenerUsage[],
  calls: number,
  elapsedMs: number,
  contextCharacters: number,
  host: string | null,
): IdeaSharpenResult["accounting"] {
  const known = usages.length === calls;
  const inputTokens = known ? usages.reduce((sum, item) => sum + item.inputTokens, 0) : null;
  const cachedInputTokens = known
    ? usages.reduce((sum, item) => sum + item.cachedInputTokens, 0)
    : null;
  const outputTokens = known ? usages.reduce((sum, item) => sum + item.outputTokens, 0) : null;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    modelCalls: calls,
    elapsedMs,
    assumptionsAdded:
      status === "already_structured"
        ? []
        : [...contract.truth.assumptions, ...contract.truth.inferences],
    contradictionsDetected: [...contract.truth.contradictions],
    contextCharacters,
    host: status === "already_structured" ? null : host,
    model:
      status === "already_structured"
        ? null
        : [...new Set(usages.map(({ model }) => model).filter(Boolean))].join(", ") || null,
  };
}

function failedAccounting(
  usages: readonly IdeaSharpenerUsage[],
  calls: number,
  elapsedMs: number,
  contextCharacters: number,
  host: string,
): IdeaSharpenAccounting {
  const known = usages.length === calls;
  const inputTokens = known ? usages.reduce((sum, item) => sum + item.inputTokens, 0) : null;
  const cachedInputTokens = known
    ? usages.reduce((sum, item) => sum + item.cachedInputTokens, 0)
    : null;
  const outputTokens = known ? usages.reduce((sum, item) => sum + item.outputTokens, 0) : null;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    modelCalls: calls,
    elapsedMs,
    assumptionsAdded: [],
    contradictionsDetected: [],
    contextCharacters,
    host,
    model: [...new Set(usages.map(({ model }) => model).filter(Boolean))].join(", ") || null,
  };
}

export async function sharpenIdea(
  source: string,
  options: SharpenIdeaOptions = {},
): Promise<IdeaSharpenResult> {
  if (source.trim().length < 12) {
    throw new Error("Rough idea must contain at least 12 non-whitespace characters");
  }
  if (source.length > IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT) {
    throw new Error(
      `Rough idea exceeds the ${IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT}-character sharpener context limit`,
    );
  }
  const credential = findCredentialMaterial(source);
  if (credential) {
    throw new Error(
      `Rough idea contains forbidden credential-like material (${credential.kind}); remove it before sharpening`,
    );
  }
  if (
    /^\s*(?:[-*]\s*)?(?:[^:\n]{0,80}\b)?(?:api[ _-]?key|token|password|secret|credential|authorization(?:\s+header)?)\s*:/imu.test(
      source,
    )
  ) {
    throw new Error("Rough idea contains a credential-labeled field; remove it before sharpening");
  }
  const startedAt = (options.now ?? (() => new Date()))().getTime();
  const structured = parseLaunchContractSource(source);
  if (structured) {
    const contract = assertLaunchContractSafe(structured);
    return {
      schemaVersion: 1,
      status: "already_structured",
      launchContract: contract,
      ideaMarkdown: renderFounderIdea(contract),
      productConstitutionMarkdown: renderProductConstitution(contract),
      accounting: accounting(
        "already_structured",
        contract,
        [],
        0,
        Math.max(0, (options.now ?? (() => new Date()))().getTime() - startedAt),
        source.length,
        null,
      ),
    };
  }
  if (!options.host) {
    throw new Error("Unstructured ideas require the authenticated Codex CLI sharpener host");
  }
  const now = options.now ?? (() => new Date());
  const today = new Date(startedAt).toISOString().slice(0, 10);
  const usages: IdeaSharpenerUsage[] = [];
  let calls = 0;
  const run = async (prompt: string, phase: "primary" | "refinement") => {
    if (calls >= IDEA_SHARPENER_TOTAL_CALL_LIMIT) {
      throw new Error(`Idea sharpener exceeded its ${IDEA_SHARPENER_TOTAL_CALL_LIMIT}-call limit`);
    }
    calls += 1;
    const result = await options.host!.run({ prompt, phase, signal: options.signal });
    if (result.usage) usages.push(result.usage);
    return result.finalText;
  };
  try {
    let finalText = await run(primaryPrompt(source, today), "primary");
    let parsed = validateCandidate(finalText);
    if (!parsed.success) {
      finalText = await run(refinementPrompt(finalText, parsed.issues, today), "refinement");
      parsed = validateCandidate(finalText);
    }
    if (!parsed.success) {
      throw new Error(
        `Idea sharpener exhausted its ${IDEA_SHARPENER_TOTAL_CALL_LIMIT}-call limit: ${parsed.issues.join("; ")}`,
      );
    }
    const contract = parsed.contract;
    if (Date.parse(`${contract.decision.reviewDate}T00:00:00.000Z`) <= startedAt) {
      throw new Error("Idea sharpener returned a reviewDate that is not after the sharpening date");
    }
    return {
      schemaVersion: 1,
      status: "sharpened",
      launchContract: contract,
      ideaMarkdown: renderFounderIdea(contract),
      productConstitutionMarkdown: renderProductConstitution(contract),
      accounting: accounting(
        "sharpened",
        contract,
        usages,
        calls,
        Math.max(0, now().getTime() - startedAt),
        source.length,
        options.host.id,
      ),
    };
  } catch (error) {
    if (error instanceof IdeaSharpenError) throw error;
    throw new IdeaSharpenError(
      error instanceof Error ? error.message : String(error),
      failedAccounting(
        usages,
        calls,
        Math.max(0, now().getTime() - startedAt),
        source.length,
        options.host.id,
      ),
    );
  }
}
