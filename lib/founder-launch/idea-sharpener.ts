import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCredentialMaterial } from "../../packages/core/src/index";
import { looksLikeCredentialLabeledText, looksLikeCredentialValue } from "../config/contracts";
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

/** A no-provider Codex host launched read-only from a disposable non-repository directory. */
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
        proposition: "",
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
      capabilities: {
        frontend: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        backend: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        database: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        authentication: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        authorization: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        payments: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        entitlements: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        transactionalEmail: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        analytics: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        privacyAndConsent: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        seo: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        aeo: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        geo: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        agentSurface: "REQUIRED | DEFERRED | NOT_APPLICABLE",
        scheduledLearning: "REQUIRED | DEFERRED | NOT_APPLICABLE",
      },
    },
    null,
    2,
  );
}

function commercePolicyPrompt(): string {
  return [
    "Default business.model to free, paymentProvider to none, priceHypothesis to null, and capabilities.payments and capabilities.entitlements to NOT_APPLICABLE when generic founder prose does not propose commerce.",
    "For founder alpha, only when the founder describes the product itself as an unqualified web SaaS and supplies no conflicting commercial model, treat that wording as a narrow, reversible present subscription hypothesis even when no price is stated: set business.model to subscription, paymentProvider to stripe, priceHypothesis to one positive numeric monthly EUR amount, capabilities.backend, capabilities.payments, and capabilities.entitlements to REQUIRED, and commercialCommitmentEvent to a non-transactional willingness-to-pay or displayed-price-interest signal for that exact EUR amount per month.",
    "The inferred Stripe scope is test-mode product, exact monthly EUR price, billing portal, and webhook configuration only. The commercial commitment event records interest only: it must not create a customer, collect or attach a payment method, open checkout, activate a subscription, or charge anyone.",
    "For every rough-idea candidate, keep customer creation, payment-method collection, checkout, subscription activation, purchases, and charges out of product.oneCoreFeature, product.primaryJourney, product.primaryCta, and decision.primarySuccessSignal, even when the rough prose explicitly mentions commerce; keep such transactional work as future, non-executed commercial context instead. The primary journey remains the core product outcome. Include indispensable authentication or sign-in, create/edit persistence, and public read-back steps whenever REQUIRED capabilities or the promised artifact imply them; commerce configuration is not a substitute for those steps.",
    "For an owned web artifact that the founder creates, edits, persists, publishes, and reads publicly, use separate ordered journey steps equivalent to: sign in with email; create the artifact; edit its items and persist their state; publish it; then open the public read-only artifact. Do not append a provider, entitlement, billing, plan, payment, or other commercial action to any of those product steps.",
    "Record the subscription model and exact displayed monthly price in truth.assumptions, and record willingness to pay separately in truth.unknowns; never present the model, amount, demand, or provider state as truth.facts or external evidence.",
    "An explicit statement that the whole product is free or needs no payments overrides the web-SaaS hypothesis: preserve business.model free, paymentProvider none, and priceHypothesis null, and classify capabilities.payments and capabilities.entitlements as NOT_APPLICABLE. Explicitly deferred payments or monetization also override it and make both capabilities DEFERRED.",
    "An explicit one-time, service, usage, take-rate, native-commerce, advertising, sponsorship, or donation model takes precedence over the web-SaaS default. A SaaS mention only in the audience, a competitor, a negation, or an explicit not-building boundary does not describe the product itself. A free trial, free tier, freemium offer, or the phrase not free does not by itself make the whole product free.",
    "Use Stripe for supported web subscription, one-time, or service commerce and RevenueCat only for native subscription or one-time digital commerce. Preserve usage and take_rate models with paymentProvider none until their automatic rails are implemented. For usage, record the exact per-unit meter in commercialCommitmentEvent, truth.facts, or truth.assumptions. For take_rate, record the exact percentage-of-transaction basis there.",
  ].join(" ");
}

const SHARPENER_TRANSACTIONAL_PRODUCT_PATTERNS = [
  /\b(?:autopay|billing|check[ -]?out|entitlements?|iban|paddle|revenuecat|stripe)\b/iu,
  /\b(?:bought|buy|charge|charged|charges|charging|invoice|invoices|membership|memberships|paid|pay|paying|payment|payments|premium|purchase|purchased|purchases|purchasing|recurring|sepa|subscribe|subscribed|subscribes|subscribing|subscription|subscriptions|trial|trials)\b/iu,
  /\b(?:direct\s+debit|sepa\s+mandate)\b/iu,
  /\b(?:bank|card|credit|debit|payment)\s+(?:account|card|details?|method)\b/iu,
  /\b(?:add|attach|collect|enter|provide|save|store)\w*\b.{0,30}\b(?:bank|card|cvv|iban|payment)\b/iu,
  /\bactivat(?:e|es|ed|ing|ion)\b.{0,40}(?:\beur\b|€).{0,30}\bplans?\b|(?:\beur\b|€).{0,30}\bplans?\b.{0,40}\bactivat(?:e|es|ed|ing|ion)\b/iu,
  /\b(?:collect|collects|collected|collecting)\b.{0,30}\bfunds?\b|\bfunds?\b.{0,30}\b(?:collect|collects|collected|collecting)\b/iu,
  /\b(?:creat(?:e|es|ed|ing)|open(?:s|ed|ing)?|provision(?:s|ed|ing)?|register(?:s|ed|ing)?|set(?:s|ting)? up)\b.{0,40}\b(?:stripe\s+)?customers?\b/iu,
  /\bcustomers?\b.{0,30}\b(?:creat(?:e|es|ed|ing)|creation|provision(?:s|ed|ing)?|provisioning|register(?:s|ed|ing)?|registration)\b/iu,
  /\b(?:confirm|place|submit)\w*\b.{0,30}\border\b/iu,
] as const;

function normalizedSharpenerText(value: string): string {
  return value.normalize("NFKC").replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function sharpenerTransactionalProductIssues(contract: LaunchContract): string[] {
  const surfaces: ReadonlyArray<{ path: string; surface: string; value: string }> = [
    {
      path: "product.oneCoreFeature",
      surface: "core feature",
      value: contract.product.oneCoreFeature,
    },
    ...contract.product.primaryJourney.map((value, index) => ({
      path: `product.primaryJourney.${index}`,
      surface: "executed primary journey",
      value,
    })),
    {
      path: "product.primaryCta",
      surface: "primary CTA",
      value: contract.product.primaryCta,
    },
    {
      path: "decision.primarySuccessSignal",
      surface: "primary success signal",
      value: contract.decision.primarySuccessSignal,
    },
  ];
  return surfaces.flatMap(({ path, surface, value }) =>
    SHARPENER_TRANSACTIONAL_PRODUCT_PATTERNS.some((pattern) =>
      pattern.test(normalizedSharpenerText(value)),
    )
      ? [
          `${path}: rough-idea sharpening cannot put checkout, customer creation, payment-method collection, subscription activation, purchases, or charges in the ${surface}; preserve reviewed commerce configuration in business and keep the product outcome non-transactional`,
        ]
      : [],
  );
}

type OwnedPublishedJourneyCategory =
  "authentication" | "create" | "progress" | "persistence" | "evidence" | "publish" | "publicRead";

const OWNED_AUTHENTICATION_STEP_PATTERN =
  /^(?:(?:the\s+)?(?:founder|user)\s+)?(?:signs?\s+(?:in(?:\s+(?:to\s+(?:the\s+)?app|(?:with|using)\s+(?:an?\s+)?(?:email|(?:email|magic)\s+link)))?|into(?:\s+(?:the\s+)?app)?(?:\s+(?:with|using)\s+(?:an?\s+)?(?:email|(?:email|magic)\s+link))?)|logs?\s+(?:in(?:\s+(?:to\s+(?:the\s+)?app|(?:with|using)\s+(?:an?\s+)?(?:email|(?:email|magic)\s+link)))?|into(?:\s+(?:the\s+)?app)?(?:\s+(?:with|using)\s+(?:an?\s+)?(?:email|(?:email|magic)\s+link))?)|authenticates?\s+(?:(?:the\s+)?(?:founder|user)(?:\s+(?:with|using)\s+(?:an?\s+)?(?:email|(?:email|magic)\s+link))?|(?:with|using)\s+(?:an?\s+)?(?:email|(?:email|magic)\s+link))|access(?:es)?\s+(?:the\s+)?app\s+(?:with|using|via)\s+(?:an?\s+)?(?:email|magic)\s+link)[.!]?$/iu;
const OWNED_CREATE_STEP_PATTERN =
  /^(?:(?:the\s+)?(?:founder|user)\s+)?(?:creates?|drafts?|makes?|starts?)\s+(?:(?:a|one|new|the|their|its)\s+){0,2}(?:(?:focused|launch)\s+){0,2}(?:checklist|launch)[.!]?$/iu;
const OWNED_PROGRESS_STEP_PATTERN =
  /^(?:(?:the\s+)?(?:founder|user)\s+)?(?:checks?\s+off|completes?|edits?|finish(?:es)?|marks?|toggles?|updates?)\s+(?:(?:all|each|every|one|the|their|its)\s+)?(?:launch\s+)?(?:checklist\s+)?(?:items?|requirements?)(?:\s+(?:as\s+)?complete)?(?:(?:\s*,?\s+and\s+)(?:(?:adds?|attach(?:es)?|records?|uploads?)\s+(?:(?:concise|supporting|the|their)\s+){0,3}evidence|(?:keeps?|persists?|remembers?|retains?|saves?|stores?)\s+(?:(?:the|their|its)\s+)?(?:changes?|checklist\s+state|state)(?:\s+across\s+sessions?)?)){0,2}[.!]?$/iu;
const OWNED_PERSISTENCE_STEP_PATTERN =
  /^(?:(?:the\s+)?(?:founder|user)\s+)?(?:(?:keeps?|persists?|remembers?|retains?|saves?|stores?)\s+(?:(?:all|each|every|one|the|their|its)\s+)?(?:changes?|checklist\s+state|checklist|draft|items?|launch|state)(?:\s+across\s+sessions?)?|(?:checklist\s+)?(?:changes?|state)\s+(?:is|are)\s+(?:persisted|retained|saved|stored))[.!]?$/iu;
const OWNED_PERSISTENCE_ACTION_PATTERN =
  /\b(?:keeps?|persists?|remembers?|retains?|saves?|stores?)\s+(?:(?:the|their|its)\s+)?(?:changes?|state)\b|\b(?:changes?|state)\s+(?:is|are)\s+(?:persisted|retained|saved|stored)\b/iu;
const OWNED_EVIDENCE_STEP_PATTERN =
  /^(?:(?:the\s+)?(?:founder|user)\s+)?(?:adds?|attach(?:es)?|records?|uploads?)\s+(?:(?:concise|supporting|the|their)\s+){0,3}evidence(?:\s+to\s+(?:(?:the|their)\s+)?(?:checklist|items?|requirements?))?[.!]?$/iu;
const OWNED_PUBLISH_STEP_PATTERN =
  /^(?:(?:the\s+)?(?:founder|user)\s+)?(?:publish(?:es)?\s+(?:(?:a|one|the|their|its)\s+)?(?:(?:clean|finished|launch|public|read\s+only|shareable)\s+){0,3}receipt(?:\s*,?\s+and\s+cop(?:y|ies)\s+(?:(?:a|the|its)\s+)?(?:public|shareable)\s+link)?|shares?\s+(?:(?:a|one|the|their|its)\s+)?(?:(?:clean|finished|published|read\s+only|shareable)\s+){0,2}receipt\s+publicly|makes?\s+(?:(?:a|one|the|their|its)\s+)?(?:(?:clean|finished|read\s+only|shareable)\s+){0,2}receipt\s+public)[.!]?$/iu;
const OWNED_PUBLIC_READ_STEP_PATTERN =
  /^(?:(?:the\s+)?(?:founder|user)\s+)?(?:(?:inspects?|loads?|opens?|reads?|visits?|views?)\s+(?:(?:a|one|the|their|its)\s+)?(?:(?:clean|resulting)\s+)?(?:(?:public|published|read\s+only|shared)\s+){1,2}receipt(?:\s+(?:link|url))?|follows?\s+(?:(?:a|one|the|their|its)\s+)?(?:public|shareable|shared)\s+link\s+to\s+(?:inspect|load|open|read|visit|view)\s+(?:(?:a|one|the)\s+)?(?:(?:clean|resulting)\s+)?(?:(?:public|published|read\s+only|shared)\s+){1,2}receipt)[.!]?$/iu;

function ownedPublishedJourneyCategories(step: string): OwnedPublishedJourneyCategory[] {
  if (OWNED_AUTHENTICATION_STEP_PATTERN.test(step)) return ["authentication"];
  if (OWNED_CREATE_STEP_PATTERN.test(step)) return ["create"];
  if (OWNED_PROGRESS_STEP_PATTERN.test(step)) {
    return OWNED_PERSISTENCE_ACTION_PATTERN.test(step) ? ["progress", "persistence"] : ["progress"];
  }
  if (OWNED_PERSISTENCE_STEP_PATTERN.test(step)) return ["persistence"];
  if (OWNED_EVIDENCE_STEP_PATTERN.test(step)) return ["evidence"];
  if (OWNED_PUBLISH_STEP_PATTERN.test(step)) return ["publish"];
  if (OWNED_PUBLIC_READ_STEP_PATTERN.test(step)) return ["publicRead"];
  return [];
}

function sharpenerRequiredJourneyIssues(source: string, contract: LaunchContract): string[] {
  const normalizedSource = normalizedSharpenerText(source);
  const steps = contract.product.primaryJourney.map(normalizedSharpenerText);
  const sourcePromisesCreate = /\bcreat(?:e|es|ed|ing)\b/iu.test(normalizedSource);
  const sourcePromisesProgress = /\b(?:complete|edit|mark|update)\w*\b/iu.test(normalizedSource);
  const sourcePromisesPublish = /\bpublish\w*\b/iu.test(normalizedSource);
  const sourcePromisesReadableArtifact = /\b(?:public|read only|shareable)\b/iu.test(
    normalizedSource,
  );
  const ownedPublishedWebArtifact =
    /\bweb\s+saas\b/iu.test(normalizedSource) &&
    sourcePromisesCreate &&
    sourcePromisesPublish &&
    sourcePromisesReadableArtifact;
  const needsAuthentication =
    ownedPublishedWebArtifact ||
    contract.capabilities.authentication === "REQUIRED" ||
    contract.capabilities.authorization === "REQUIRED";
  const needsPersistence =
    ownedPublishedWebArtifact ||
    (contract.capabilities.database === "REQUIRED" &&
      (sourcePromisesCreate || sourcePromisesProgress));
  const issues: string[] = [];
  const categoriesByStep = steps.map(ownedPublishedJourneyCategories);
  const firstCategory = (category: OwnedPublishedJourneyCategory): number =>
    categoriesByStep.findIndex((categories) => categories.includes(category));
  if (ownedPublishedWebArtifact) {
    for (const [index, categories] of categoriesByStep.entries()) {
      if (categories.length === 0) {
        issues.push(
          `product.primaryJourney.${index}: the complete step is not one allowed source-promised owned publishing action`,
        );
      }
    }
    for (const capability of ["backend", "database", "authentication", "authorization"] as const) {
      if (contract.capabilities[capability] !== "REQUIRED") {
        issues.push(
          `capabilities.${capability}: an owned published web artifact requires ${capability} to be REQUIRED`,
        );
      }
    }
  }
  const genericAuthenticationPattern =
    /\b(?:authenticat(?:e|es|ed|ing)|log\s*in|sign\s*in)\b|\baccess\w*\b.{0,30}\b(?:email|magic)\s+link\b/iu;
  const genericCreatePattern = /\b(?:creat|draft|make|start)\w*\b/iu;
  const genericProgressPattern = /\b(?:check\s+off|complete|edit|mark|toggle|update)\w*\b/iu;
  const genericPersistencePattern = /\b(?:keep|persist|remember|retain|save|store)\w*\b/iu;
  const genericPublishPattern = /\bpublish\w*\b/iu;
  const genericPublicReadPattern = /\b(?:inspect|load|open|read|visit|view)\w*\b/iu;
  const indexes = {
    authentication: needsAuthentication
      ? ownedPublishedWebArtifact
        ? firstCategory("authentication")
        : steps.findIndex((step) => genericAuthenticationPattern.test(step))
      : -1,
    create: sourcePromisesCreate
      ? ownedPublishedWebArtifact
        ? firstCategory("create")
        : steps.findIndex((step) => genericCreatePattern.test(step))
      : -1,
    progress: sourcePromisesProgress
      ? ownedPublishedWebArtifact
        ? firstCategory("progress")
        : steps.findIndex((step) => genericProgressPattern.test(step))
      : -1,
    persistence: needsPersistence
      ? ownedPublishedWebArtifact
        ? firstCategory("persistence")
        : steps.findIndex((step) => genericPersistencePattern.test(step))
      : -1,
    publish: sourcePromisesPublish
      ? ownedPublishedWebArtifact
        ? firstCategory("publish")
        : steps.findIndex((step) => genericPublishPattern.test(step))
      : -1,
    publicRead:
      sourcePromisesPublish && sourcePromisesReadableArtifact
        ? ownedPublishedWebArtifact
          ? firstCategory("publicRead")
          : steps.findIndex((step) => genericPublicReadPattern.test(step))
        : -1,
  };
  const required: Array<[keyof typeof indexes, boolean, string]> = [
    ["authentication", needsAuthentication, "an authentication or sign-in step"],
    ["create", sourcePromisesCreate, "the source-promised create step"],
    ["progress", sourcePromisesProgress, "the source-promised edit or completion step"],
    ["persistence", needsPersistence, "an explicit save or persistence step"],
    ["publish", sourcePromisesPublish, "the source-promised publish step"],
    [
      "publicRead",
      sourcePromisesPublish && sourcePromisesReadableArtifact,
      "a distinct open, view, read, or visit step for the published artifact",
    ],
  ];
  for (const [key, isRequired, description] of required) {
    if (isRequired && indexes[key] < 0) {
      issues.push(`product.primaryJourney: rough-idea sharpening requires ${description}`);
    }
  }
  if (
    indexes.authentication >= 0 &&
    indexes.create >= 0 &&
    indexes.authentication >= indexes.create
  ) {
    issues.push("product.primaryJourney: authentication must precede the create step");
  }
  if (indexes.create >= 0 && indexes.progress >= 0 && indexes.create >= indexes.progress) {
    issues.push("product.primaryJourney: creation must precede editing or completion");
  }
  if (indexes.progress >= 0 && indexes.persistence >= 0 && indexes.progress > indexes.persistence) {
    issues.push(
      "product.primaryJourney: persistence must accompany or follow editing or completion",
    );
  }
  if (indexes.persistence >= 0 && indexes.publish >= 0 && indexes.persistence >= indexes.publish) {
    issues.push("product.primaryJourney: persistence must precede publication");
  }
  if (indexes.publish >= 0 && indexes.publicRead >= 0 && indexes.publish >= indexes.publicRead) {
    issues.push(
      "product.primaryJourney: the published artifact must be opened or read in a later step",
    );
  }
  if (ownedPublishedWebArtifact) {
    for (const [index, categories] of categoriesByStep.entries()) {
      if (!categories.includes("evidence")) continue;
      if (indexes.create < 0 || index <= indexes.create) {
        issues.push("product.primaryJourney: evidence must follow launch or checklist creation");
      }
      if (indexes.publish < 0 || index >= indexes.publish) {
        issues.push("product.primaryJourney: evidence must precede receipt publication");
      }
    }
  }
  return issues;
}

function primaryPrompt(source: string, today: string): string {
  return [
    "Turn one rough founder idea into the smallest credible Launch Contract.",
    "This is one bounded judgement call. Do not browse, use tools, read files, plan provider operations, or write code.",
    "Return exactly one JSON object matching the skeleton below, with no Markdown fence or prose.",
    "Use one user, one painful job, one useful outcome, one concise reviewable proposition hypothesis, one core feature, one journey, one CTA, one commitment, one channel, one success signal, one review date, and an explicit not-building list. Keep venture.proposition distinct from the one-sentence category thesis and do not present it as validated demand or a completed founder review.",
    "Do not invent demand, users, quotes, revenue, metrics, provider state, external evidence, founder credentials, market size, or pricing certainty. Put reversible uncertainty in truth.assumptions, truth.inferences, or truth.unknowns.",
    "Default to thin_mvp. Use product_first only when real usage is indispensable, validate_first only when risk or cost makes a smaller demand test necessary, and concierge_first only when honest manual delivery is materially better.",
    commercePolicyPrompt(),
    "Classify every capabilities field explicitly. REQUIRED means indispensable to this launch and its acceptance criteria; DEFERRED means a reviewed later possibility excluded from the present build; NOT_APPLICABLE means it does not fit this venture. Do not install generic SaaS infrastructure by default.",
    "Derive the classification from the primary journey, trust boundary, current commercial proof, and first channel. Authentication and authorization are separate decisions; authorization REQUIRED also requires authentication REQUIRED. Payments REQUIRED needs the supported selected provider. An agentNative customer surface, service blueprint, or outcome command requires agentSurface REQUIRED.",
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
    commercePolicyPrompt(),
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

function assertSharpenerOutputCredentialFree(text: string): void {
  if (looksLikeCredentialValue(text) || looksLikeCredentialLabeledText(text)) {
    throw new Error(
      "Idea sharpener returned credential-like material; the candidate was rejected before reuse",
    );
  }
}

function validateCandidate(
  text: string,
  source: string,
): { success: true; contract: LaunchContract } | { success: false; issues: string[] } {
  let candidate: unknown;
  try {
    candidate = jsonCandidate(text);
  } catch {
    return { success: false, issues: ["result: expected one valid JSON object"] };
  }
  const parsed = launchContractSchema.safeParse(candidate);
  if (parsed.success) {
    const contract = assertLaunchContractSafe(parsed.data);
    const issues = [
      ...sharpenerTransactionalProductIssues(contract),
      ...sharpenerRequiredJourneyIssues(source, contract),
    ];
    return issues.length > 0 ? { success: false, issues } : { success: true, contract };
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
  if (
    /^\s*(?:[-*]\s*)?(?:[^:\n]{0,80}\b)?(?:api[ _-]?key|token|password|secret|credential|authorization(?:\s+header)?)\s*:/imu.test(
      source,
    )
  ) {
    throw new Error("Rough idea contains a credential-labeled field; remove it before sharpening");
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
    assertSharpenerOutputCredentialFree(finalText);
    let parsed = validateCandidate(finalText, source);
    if (!parsed.success) {
      finalText = await run(refinementPrompt(finalText, parsed.issues, today), "refinement");
      assertSharpenerOutputCredentialFree(finalText);
      parsed = validateCandidate(finalText, source);
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
