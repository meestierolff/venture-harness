import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { rejectCredentialMaterial } from "../config/contracts";
import {
  founderBriefSchema,
  routeLaunch,
  type CapabilityId,
  type FounderBrief,
  type LaunchDecision,
} from "../launch";

const boundedText = z.string().trim().min(1).max(1_000);
const conciseText = z.string().trim().min(1).max(500);
const textList = (minimum = 0, maximum = 20) =>
  z
    .array(boundedText)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "values must be unique");
const conciseList = (minimum = 0, maximum = 20) =>
  z
    .array(conciseText)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "values must be unique");

export const LAUNCH_CAPABILITY_CLASSIFICATIONS = [
  "REQUIRED",
  "DEFERRED",
  "NOT_APPLICABLE",
] as const;

export const LaunchCapabilityClassification = Object.freeze({
  REQUIRED: "REQUIRED",
  DEFERRED: "DEFERRED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
} as const);

/**
 * REQUIRED is in the present launch, DEFERRED is a reviewed later decision,
 * and NOT_APPLICABLE is deliberately outside this venture's current shape.
 */
export const launchCapabilityClassificationSchema = z.enum(LAUNCH_CAPABILITY_CLASSIFICATIONS);

export const launchContractCapabilityClassificationSchema = launchCapabilityClassificationSchema;

export type LaunchCapabilityClassification =
  (typeof LaunchCapabilityClassification)[keyof typeof LaunchCapabilityClassification];

export const launchContractCapabilitiesSchema = z
  .object({
    frontend: launchCapabilityClassificationSchema,
    backend: launchCapabilityClassificationSchema,
    database: launchCapabilityClassificationSchema,
    authentication: launchCapabilityClassificationSchema,
    authorization: launchCapabilityClassificationSchema,
    payments: launchCapabilityClassificationSchema,
    entitlements: launchCapabilityClassificationSchema,
    transactionalEmail: launchCapabilityClassificationSchema,
    analytics: launchCapabilityClassificationSchema,
    privacyAndConsent: launchCapabilityClassificationSchema,
    seo: launchCapabilityClassificationSchema,
    aeo: launchCapabilityClassificationSchema,
    geo: launchCapabilityClassificationSchema,
    agentSurface: launchCapabilityClassificationSchema,
    scheduledLearning: launchCapabilityClassificationSchema,
  })
  .strict();

export type LaunchContractCapabilities = z.infer<typeof launchContractCapabilitiesSchema>;

const MINOR_UNIT_ROUNDING_ULPS = 8;

/**
 * Converts a validated decimal price to integer cents without treating normal
 * IEEE-754 representation noise (for example 0.29 * 100) as a third decimal.
 */
export function decimalPriceToMinorUnits(amount: number): number {
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  const roundingTolerance =
    Number.EPSILON * Math.max(100, Math.abs(scaled)) * MINOR_UNIT_ROUNDING_ULPS;
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(rounded) ||
    Math.abs(scaled - rounded) > roundingTolerance
  ) {
    throw new Error("price must be a non-negative amount with at most two decimal places");
  }
  return rounded === 0 ? 0 : rounded;
}

export const launchContractPriceSchema = z
  .number()
  .positive()
  .finite()
  .refine(
    (value) => {
      try {
        decimalPriceToMinorUnits(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "priceHypothesis must use at most two decimal places" },
  );

const MAX_LAUNCH_CONTRACT_BYTES = 32_000;

export interface LaunchContractSafetyIssue {
  path: readonly (string | number)[];
  message: string;
}

interface LaunchContractSafetyCandidate {
  venture: {
    oneSentenceThesis: string;
    targetUser: string;
    painfulJob: string;
    desiredOutcome: string;
    proposition: string;
    differentiation: string;
    founderAdvantage: string;
  };
  product: {
    oneCoreFeature: string;
    primaryJourney: readonly string[];
    primaryCta: string;
    designThesis: string;
    trustRequirements: readonly string[];
  };
  business: { commercialCommitmentEvent: string };
  distribution: {
    firstChannel: string;
    firstUserHabitat: string;
    initialMessage: string;
    firstValidationAction: string;
  };
  decision: { continueRule: string; changeRule: string; stopRule: string };
  truth: {
    facts: readonly string[];
    assumptions: readonly string[];
    inferences: readonly string[];
    contradictions: readonly string[];
    unknowns: readonly string[];
    externalEvidence: readonly string[];
  };
  agentNative: { outcomeCommands: readonly string[] };
}

interface SafetyText {
  path: readonly (string | number)[];
  value: string;
}

function indexedSafetyText(path: readonly string[], values: readonly string[]): SafetyText[] {
  return values.map((value, index) => ({ path: [...path, index], value }));
}

function affirmativeSafetyText(contract: LaunchContractSafetyCandidate): SafetyText[] {
  return [
    { path: ["venture", "oneSentenceThesis"], value: contract.venture.oneSentenceThesis },
    { path: ["venture", "targetUser"], value: contract.venture.targetUser },
    { path: ["venture", "painfulJob"], value: contract.venture.painfulJob },
    { path: ["venture", "desiredOutcome"], value: contract.venture.desiredOutcome },
    { path: ["venture", "proposition"], value: contract.venture.proposition },
    { path: ["venture", "differentiation"], value: contract.venture.differentiation },
    { path: ["venture", "founderAdvantage"], value: contract.venture.founderAdvantage },
    { path: ["product", "oneCoreFeature"], value: contract.product.oneCoreFeature },
    ...indexedSafetyText(["product", "primaryJourney"], contract.product.primaryJourney),
    { path: ["product", "primaryCta"], value: contract.product.primaryCta },
    { path: ["product", "designThesis"], value: contract.product.designThesis },
    ...indexedSafetyText(["product", "trustRequirements"], contract.product.trustRequirements),
    {
      path: ["business", "commercialCommitmentEvent"],
      value: contract.business.commercialCommitmentEvent,
    },
    { path: ["distribution", "firstChannel"], value: contract.distribution.firstChannel },
    {
      path: ["distribution", "firstUserHabitat"],
      value: contract.distribution.firstUserHabitat,
    },
    { path: ["distribution", "initialMessage"], value: contract.distribution.initialMessage },
    {
      path: ["distribution", "firstValidationAction"],
      value: contract.distribution.firstValidationAction,
    },
    { path: ["decision", "continueRule"], value: contract.decision.continueRule },
    { path: ["decision", "changeRule"], value: contract.decision.changeRule },
    { path: ["decision", "stopRule"], value: contract.decision.stopRule },
    ...indexedSafetyText(["truth", "facts"], contract.truth.facts),
    ...indexedSafetyText(["truth", "assumptions"], contract.truth.assumptions),
    ...indexedSafetyText(["truth", "inferences"], contract.truth.inferences),
    ...indexedSafetyText(["truth", "contradictions"], contract.truth.contradictions),
    ...indexedSafetyText(["truth", "unknowns"], contract.truth.unknowns),
    ...indexedSafetyText(["truth", "externalEvidence"], contract.truth.externalEvidence),
    ...indexedSafetyText(["agentNative", "outcomeCommands"], contract.agentNative.outcomeCommands),
  ];
}

function negatesMatchedAction(value: string, matchIndex: number): boolean {
  const prefix = value.slice(Math.max(0, matchIndex - 48), matchIndex);
  return /\b(?:do not|don't|never|must not|avoid|prevent|reject|prohibit)\b[^.!?;:\n]{0,44}$/iu.test(
    prefix,
  );
}

function unsafeMatch(value: string, pattern: RegExp): boolean {
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    if (!negatesMatchedAction(value, match.index)) return true;
    // A negated match may greedily absorb a later affirmative action. Resume
    // one character after its start so overlapping candidates are inspected.
    matcher.lastIndex = match.index + 1;
  }
  return false;
}

/**
 * Pure, credential-free safety validation shared by every Launch Contract path.
 * Scope exclusions are intentionally not scanned as affirmative intent.
 */
export function launchContractSafetyIssues(
  contract: LaunchContractSafetyCandidate,
): LaunchContractSafetyIssue[] {
  const issues: LaunchContractSafetyIssue[] = [];
  const texts = affirmativeSafetyText(contract);
  const deceptivePatterns = [
    /\b(?:fake|fabricat(?:e|ed|ing)|invent(?:ed|ing)?|forge[ds]?|manufactur(?:e|ed|ing))\b.{0,48}\b(?:customers?|users?|reviews?|testimonials?|metrics?|revenue|demand|evidence|results?|provider state)\b/iu,
    /\bimpersonat(?:e|es|ed|ing|ion)\b/iu,
    /\bmislead(?:s|ing|ingly)?\b/iu,
    /\bconceal\b.{0,40}\b(?:price|sponsor|advertis(?:ing|ement)|subscription|renewal|risk|conflict)\b/iu,
  ];
  for (const text of texts) {
    if (deceptivePatterns.some((pattern) => unsafeMatch(text.value, pattern))) {
      issues.push({
        path: text.path,
        message: "Launch Contract requests deceptive or fabricated state",
      });
    }
  }

  const joinedProductIntent = [
    contract.product.oneCoreFeature,
    ...contract.product.primaryJourney,
    ...contract.agentNative.outcomeCommands,
  ].join(" ");
  const trustText = contract.product.trustRequirements.join(" ");
  const medicalAction =
    /\b(?:prescribe|calculate|recommend|determine|administer|adjust)\b.{0,56}\b(?:insulin|medication|medicine|drug|dosage|dose)\b/iu.test(
      joinedProductIntent,
    ) ||
    /\b(?:diagnose|treat)\b.{0,48}\b(?:patient|medical|health condition|disease)\b/iu.test(
      joinedProductIntent,
    );
  const reviewedMedicalSafeguard =
    /\b(?:clinician|doctor|licensed medical professional|medical professional)\b.{0,36}\b(?:review|approval|oversight)\b/iu.test(
      trustText,
    ) &&
    !/\bno\b.{0,24}\b(?:clinician|doctor|medical professional)\b.{0,36}\breview\b/iu.test(
      trustText,
    );
  if (medicalAction && !reviewedMedicalSafeguard) {
    issues.push({
      path: ["product", "oneCoreFeature"],
      message:
        "A medical diagnosis or dosing action requires an explicit licensed-clinician review safeguard",
    });
  }

  const directUnsafePatterns = [
    /\b(?:disable|bypass|remove|evade)\b.{0,48}\b(?:authentication|authorization|consent|encryption|signature verification|safety check|clinician review|human review)\b/iu,
    /\b(?:automatically|autonomously)\b.{0,48}\b(?:send|publish|post|deploy|charge|purchase|delete|replace nameservers?|change dns)\b/iu,
    /\b(?:bulk|cold)\b.{0,24}\b(?:send|email|message|outreach)\b/iu,
    /\b(?:delete|drop|erase|destroy)\b.{0,36}\b(?:production|customer|user|database|records?|data)\b/iu,
  ];
  for (const text of texts) {
    if (directUnsafePatterns.some((pattern) => unsafeMatch(text.value, pattern))) {
      issues.push({
        path: text.path,
        message: "Launch Contract requests an unsafe or non-human-gated external effect",
      });
    }
  }

  for (const [index, contradiction] of contract.truth.contradictions.entries()) {
    if (fundamentalContradiction(contradiction)) {
      issues.push({
        path: ["truth", "contradictions", index],
        message: `Resolve fundamental Launch Contract contradiction: ${contradiction}`,
      });
    }
  }
  return issues;
}

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * The single credential-free business contract accepted by the public founder
 * path. It deliberately contains decisions, not provider implementation state.
 */
export const launchContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Explicit fixture marker; omitted contracts always represent real founder input. */
    synthetic: z.literal(true).optional(),
    venture: z
      .object({
        name: z.string().trim().min(1).max(100),
        slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
        domain: z
          .string()
          .regex(
            /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u,
          )
          .nullable()
          .optional(),
        oneSentenceThesis: conciseText,
        targetUser: conciseText,
        painfulJob: conciseText,
        desiredOutcome: conciseText,
        proposition: conciseText,
        differentiation: conciseText,
        founderAdvantage: conciseText,
      })
      .strict(),
    product: z
      .object({
        oneCoreFeature: conciseText,
        primaryJourney: conciseList(1, 8),
        primaryCta: z.string().trim().min(1).max(120),
        explicitNotBuilding: textList(1, 12),
        designThesis: boundedText,
        trustRequirements: textList(0, 12),
      })
      .strict(),
    business: z
      .object({
        model: z.enum(["subscription", "one_time", "usage", "service", "take_rate", "free"]),
        priceHypothesis: launchContractPriceSchema.nullable(),
        currency: z.literal("EUR"),
        paymentProvider: z.enum(["stripe", "revenuecat", "none"]),
        commercialCommitmentEvent: conciseText,
      })
      .strict(),
    distribution: z
      .object({
        firstChannel: conciseText,
        firstUserHabitat: conciseText,
        initialMessage: boundedText,
        firstValidationAction: boundedText,
      })
      .strict(),
    decision: z
      .object({
        launchMode: z.enum(["thin_mvp", "product_first", "validate_first", "concierge_first"]),
        primarySuccessSignal: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
        reviewDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/u)
          .refine(isRealIsoDate, {
            message: "reviewDate must be a real YYYY-MM-DD date",
          }),
        continueRule: boundedText,
        changeRule: boundedText,
        stopRule: boundedText,
      })
      .strict(),
    truth: z
      .object({
        facts: textList(),
        assumptions: textList(),
        inferences: textList(),
        contradictions: textList(),
        unknowns: textList(),
        externalEvidence: textList(),
      })
      .strict(),
    agentNative: z
      .object({
        customerAgentSurfaceRequired: z.boolean(),
        serviceBlueprintRequired: z.boolean(),
        outcomeCommands: textList(0, 12),
      })
      .strict(),
    capabilities: launchContractCapabilitiesSchema,
  })
  .strict()
  .superRefine((contract, context) => {
    rejectCredentialMaterial(contract, context);
    if (Buffer.byteLength(JSON.stringify(contract), "utf8") > MAX_LAUNCH_CONTRACT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `Launch Contract exceeds the ${MAX_LAUNCH_CONTRACT_BYTES}-byte context bound`,
      });
    }
    if (contract.business.model === "free") {
      if (contract.business.paymentProvider !== "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["business", "paymentProvider"],
          message: "a free launch cannot select a payment provider",
        });
      }
      if (contract.business.priceHypothesis !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["business", "priceHypothesis"],
          message: "a free launch cannot assert a price hypothesis",
        });
      }
    }
    const pricingBasisText = [
      contract.business.commercialCommitmentEvent,
      ...contract.truth.facts,
      ...contract.truth.assumptions,
    ].join(" ");
    if (
      ["usage", "take_rate"].includes(contract.business.model) &&
      contract.business.priceHypothesis === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "priceHypothesis"],
        message:
          "usage and take-rate models require an explicit reviewed amount and meter or percentage basis in the commitment event, fact, or assumption",
      });
    }
    if (
      contract.business.model === "usage" &&
      !/\b(?:per|each)\b.{0,80}\b(?:unit|request|seat|record|receipt|transaction|minute|hour|gigabyte|gb|credit|use|run|item)\b|\b(?:unit|request|seat|record|receipt|transaction|minute|hour|gigabyte|gb|credit|use|run|item)[ -]based\b|\/\s*(?:unit|request|seat|record|receipt|transaction|minute|hour|gigabyte|gb|credit|use|run|item)\b/iu.test(
        pricingBasisText,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "commercialCommitmentEvent"],
        message:
          "a usage contract must identify its reviewed meter in the commitment event, fact, or assumption",
      });
    }
    if (
      contract.business.model === "take_rate" &&
      !/(?:%|\bpercent(?:age)?\b|\btake[- ]?rate\b).{0,80}\b(?:transaction|sale|booking|payment|revenue|gross|order)\b|\b(?:transaction|sale|booking|payment|revenue|gross|order)\b.{0,80}(?:%|\bpercent(?:age)?\b|\btake[- ]?rate\b)/iu.test(
        pricingBasisText,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "commercialCommitmentEvent"],
        message:
          "a take-rate contract must identify its reviewed percentage basis in the commitment event, fact, or assumption",
      });
    }
    if (
      contract.business.paymentProvider !== "none" &&
      contract.business.priceHypothesis === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "priceHypothesis"],
        message: "an automatic payment provider requires a reviewed price hypothesis",
      });
    }
    if (
      contract.business.paymentProvider === "revenuecat" &&
      !["subscription", "one_time"].includes(contract.business.model)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "paymentProvider"],
        message:
          "RevenueCat is supported only for reviewed native subscription or one-time commerce",
      });
    }
    if (
      contract.business.paymentProvider === "stripe" &&
      ["usage", "take_rate"].includes(contract.business.model)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "paymentProvider"],
        message:
          "automatic Stripe configuration does not yet implement usage meters or take-rate settlement; preserve the model with paymentProvider none for the present validation proof",
      });
    }
    if (
      contract.business.paymentProvider === "none" &&
      ["subscription", "one_time"].includes(contract.business.model) &&
      contract.business.priceHypothesis !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "paymentProvider"],
        message:
          "a priced subscription or one-time launch requires a compatible reviewed payment provider",
      });
    }
    if (
      contract.business.paymentProvider === "none" &&
      /\b(?:pay(?:ment|ing)?|checkout|purchase|charge|subscribe|subscription started)\b/iu.test(
        contract.business.commercialCommitmentEvent,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "commercialCommitmentEvent"],
        message: "a payment commitment event requires a compatible reviewed payment provider",
      });
    }
    if (
      contract.business.model === "take_rate" &&
      contract.business.priceHypothesis !== null &&
      contract.business.priceHypothesis > 100
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business", "priceHypothesis"],
        message: "a take-rate percentage cannot exceed 100",
      });
    }
    if (
      contract.capabilities.payments === "REQUIRED" &&
      contract.business.paymentProvider === "none"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "payments"],
        message:
          "payments cannot be REQUIRED without a supported reviewed paymentProvider; classify payments as DEFERRED when the current rail is not implemented",
      });
    }
    if (
      contract.capabilities.authorization === "REQUIRED" &&
      contract.capabilities.authentication !== "REQUIRED"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "authentication"],
        message:
          "authentication must be REQUIRED when authorization is REQUIRED; otherwise defer or exclude authorization too",
      });
    }
    const requiresBackend = [
      "database",
      "authentication",
      "authorization",
      "payments",
      "entitlements",
      "transactionalEmail",
      "agentSurface",
      "scheduledLearning",
    ].some(
      (capability) =>
        contract.capabilities[capability as keyof LaunchContractCapabilities] === "REQUIRED",
    );
    if (requiresBackend && contract.capabilities.backend !== "REQUIRED") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "backend"],
        message:
          "backend must be REQUIRED when a server-side capability is REQUIRED; otherwise defer the dependent capabilities too",
      });
    }
    if (
      contract.capabilities.entitlements === "REQUIRED" &&
      contract.capabilities.payments !== "REQUIRED"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "entitlements"],
        message:
          "entitlements must be DEFERRED when payments are not REQUIRED because the current entitlement source is the selected payment provider",
      });
    }
    if (
      contract.capabilities.analytics === "REQUIRED" &&
      contract.capabilities.privacyAndConsent !== "REQUIRED"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "privacyAndConsent"],
        message: "privacyAndConsent must be REQUIRED when analytics is REQUIRED",
      });
    }
    if (
      ["seo", "aeo", "geo"].some(
        (capability) =>
          contract.capabilities[capability as keyof LaunchContractCapabilities] === "REQUIRED",
      ) &&
      contract.capabilities.frontend !== "REQUIRED"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "frontend"],
        message: "frontend must be REQUIRED when web SEO, AEO, or GEO is REQUIRED",
      });
    }
    if (
      contract.capabilities.frontend !== "REQUIRED" &&
      contract.capabilities.agentSurface !== "REQUIRED"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "frontend"],
        message:
          "the current launch rail requires at least one REQUIRED delivery surface: frontend or agentSurface",
      });
    }
    if (
      (contract.agentNative.customerAgentSurfaceRequired ||
        contract.agentNative.serviceBlueprintRequired ||
        contract.agentNative.outcomeCommands.length > 0) &&
      contract.capabilities.agentSurface !== "REQUIRED"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "agentSurface"],
        message:
          "agentSurface must be REQUIRED when agentNative requests a customer surface, service blueprint, or outcome command",
      });
    }
    for (const issue of launchContractSafetyIssues(contract)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...issue.path],
        message: issue.message,
      });
    }
  });

export type LaunchContract = z.infer<typeof launchContractSchema>;

const LAUNCH_CONTRACT_SECTION_KEYS = Object.freeze([
  "venture",
  "product",
  "business",
  "distribution",
  "decision",
  "truth",
  "agentNative",
  "capabilities",
] as const);
const LAUNCH_CONTRACT_SENTINEL_KEYS = Object.freeze([
  "schemaVersion",
  ...LAUNCH_CONTRACT_SECTION_KEYS,
] as const);
const LAUNCH_CONTRACT_EXPECTED_SHAPE =
  "schemaVersion: 1 with required venture, product, business, distribution, decision, truth, agentNative, and complete capabilities mappings";

export class LaunchContractSourceError extends Error {
  readonly code = "LAUNCH_CONTRACT_SOURCE_INVALID";

  constructor(
    readonly schemaVersion: string,
    readonly invalidPath: string,
    readonly validationProblem: string,
    readonly expectedShape: string,
    readonly remediation: string,
  ) {
    super(
      `Malformed structured Launch Contract; schema version: ${schemaVersion}; invalid path: ${invalidPath}; validation problem: ${validationProblem}; expected v1 shape: ${expectedShape}; exact remediation: ${remediation}`,
    );
    this.name = "LaunchContractSourceError";
  }
}

/** The canonical assertion used by zero-call, model, and decision paths. */
export function assertLaunchContractSafe(contractInput: LaunchContract): LaunchContract {
  return launchContractSchema.parse(contractInput);
}

interface FrontMatterCandidate {
  body: string;
  closed: boolean;
}

function frontMatterCandidate(source: string): FrontMatterCandidate | undefined {
  const opener = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!opener) return undefined;
  const bodyStart = opener[0].length;
  const remainder = source.slice(bodyStart);
  const closer = /^---[ \t]*\r?$/mu.exec(remainder);
  if (!closer) return { body: remainder, closed: false };
  return { body: remainder.slice(0, closer.index), closed: true };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawRootKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const matcher = /^(?:["']?([A-Za-z][A-Za-z0-9 _-]*)["']?)[ \t]*:/gmu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    if (match[1]) keys.add(match[1].trim());
  }
  return keys;
}

function parsedRootKeys(value: unknown): Set<string> {
  const record = recordValue(value);
  return new Set(record ? Object.keys(record) : []);
}

function normalizedRootKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function editDistanceAtMost(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const next = Math.min(
        (current[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[rightIndex] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + cost,
      );
      current.push(next);
      rowMinimum = Math.min(rowMinimum, next);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return (previous[right.length] ?? Number.POSITIVE_INFINITY) <= limit;
}

function launchContractLikeRootKey(value: string): boolean {
  const normalized = normalizedRootKey(value);
  if (normalized === "launchcontract") return true;
  return LAUNCH_CONTRACT_SENTINEL_KEYS.some((key) => {
    const expected = normalizedRootKey(key);
    if (normalized === expected) return true;
    const limit = expected.length >= 8 ? 2 : 1;
    return normalized.length >= 4 && editDistanceAtMost(normalized, expected, limit);
  });
}

function hasLaunchContractIntent(source: string, value?: unknown): boolean {
  const keys = new Set([...rawRootKeys(source), ...parsedRootKeys(value)]);
  return [...keys].some(launchContractLikeRootKey);
}

function sourceSchemaVersion(source: string, value?: unknown): string {
  const parsed = recordValue(value)?.schemaVersion;
  if (parsed !== undefined) return JSON.stringify(parsed) ?? String(parsed);
  const raw = /^schemaVersion[ \t]*:[ \t]*([^#\r\n]*)/mu.exec(source)?.[1]?.trim();
  return raw ? raw : "missing";
}

function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$";
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

function exactRemediation(path: string): string {
  return `correct ${path} in the YAML Launch Contract so it satisfies schemaVersion 1, preserve every reviewed contract field, and rerun the same command; if the input is genuinely prose, remove every root Launch Contract sentinel key`;
}

function invalidSource(input: {
  source: string;
  value?: unknown;
  path: string;
  problem: string;
}): LaunchContractSourceError {
  return new LaunchContractSourceError(
    sourceSchemaVersion(input.source, input.value),
    input.path,
    input.problem,
    LAUNCH_CONTRACT_EXPECTED_SHAPE,
    exactRemediation(input.path),
  );
}

function parseStructuredCandidate(
  source: string,
  options: { explicitFrontMatter?: boolean } = {},
): LaunchContract | undefined {
  let value: unknown;
  try {
    value = parseYaml(source);
  } catch (error) {
    if (!options.explicitFrontMatter && !hasLaunchContractIntent(source)) return undefined;
    const position = recordValue(error)?.linePos;
    const firstPosition = Array.isArray(position) ? recordValue(position[0]) : undefined;
    const line = typeof firstPosition?.line === "number" ? firstPosition.line : undefined;
    const column = typeof firstPosition?.col === "number" ? firstPosition.col : undefined;
    const path = line === undefined ? "$" : `$ (YAML line ${line}, column ${column ?? "unknown"})`;
    throw invalidSource({ source, path, problem: "invalid YAML syntax" });
  }

  if (!hasLaunchContractIntent(source, value)) return undefined;
  const parsed = launchContractSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issuePath(issue?.path ?? []);
  throw invalidSource({
    source,
    value,
    path,
    problem: issue?.message ?? "input does not satisfy the Launch Contract v1 schema",
  });
}

export function parseLaunchContractSource(source: string): LaunchContract | undefined {
  const frontMatter = frontMatterCandidate(source);
  if (frontMatter) {
    if (!frontMatter.closed) {
      throw invalidSource({
        source: frontMatter.body,
        path: "$frontMatter",
        problem: "front matter is not closed with a standalone --- delimiter",
      });
    }
    return parseStructuredCandidate(frontMatter.body, { explicitFrontMatter: true });
  }
  return parseStructuredCandidate(source);
}

function fundamentalContradiction(value: string): boolean {
  return /\b(?:fundamental|indispensable|impossible|cannot both|mutually exclusive|unsafe|illegal|unlawful|no safe default)\b/iu.test(
    value,
  );
}

function monetizationModel(contract: LaunchContract): FounderBrief["monetization_model"] {
  switch (contract.business.model) {
    case "free":
      return "none";
    case "one_time":
      return "one_time";
    case "usage":
      return "usage_based";
    case "service":
      return "services";
    case "take_rate":
      return "transaction_fee";
    case "subscription":
      return "subscription";
  }
}

/** Deterministically projects the Launch Contract into the existing router contract. */
export function founderBriefFromLaunchContract(contractInput: LaunchContract): FounderBrief {
  const contract = assertLaunchContractSafe(contractInput);
  const required = (capability: keyof LaunchContractCapabilities) =>
    contract.capabilities[capability] === "REQUIRED";
  const mobile = required("payments") && contract.business.paymentProvider === "revenuecat";
  const capabilityClassification = Object.entries(contract.capabilities)
    .map(([capability, classification]) => `${capability}=${classification}`)
    .join("; ");
  const knownTruths = contract.truth.facts.map((fact) => `FACT: ${fact}`);
  const assumptions = [
    ...contract.truth.assumptions.map((item) => `FOUNDER_ASSUMPTION: ${item}`),
    ...contract.truth.inferences.map((item) => `MODEL_INFERENCE: ${item}`),
    ...contract.truth.unknowns.map((item) => `UNKNOWN: ${item}`),
    ...contract.truth.contradictions.map((item) => `CONTRADICTORY: ${item}`),
    ...contract.truth.externalEvidence.map(
      (item) =>
        `UNKNOWN: Founder-supplied external evidence is not independently verified: ${item}`,
    ),
  ];
  return founderBriefSchema.parse({
    id: contract.venture.slug,
    name: contract.venture.name,
    specific_user_or_audience: contract.venture.targetUser,
    problem_or_job: contract.venture.painfulJob,
    intended_outcome: contract.venture.desiredOutcome,
    smallest_core_journey: contract.product.primaryJourney.join(" -> "),
    primary_success_signal: contract.decision.primarySuccessSignal,
    material_constraints: [
      `Canonical Launch Contract capability classifications: ${capabilityClassification}`,
      `Build and present this reviewable proposition hypothesis without implying demand: ${contract.venture.proposition}`,
      ...contract.product.trustRequirements,
      ...contract.product.explicitNotBuilding.map((item) => `Not building: ${item}`),
      "Do not fabricate provider, user, demand, metric, revenue, or verification state.",
      "Keep credentials outside Git and model context.",
    ],
    known_truths: knownTruths,
    assumptions,
    // Agent Surfaces are an optional service capability, not a mobile rail.
    // Seed selection consumes the Launch Contract directly so a web service
    // does not accidentally activate App Store tooling.
    app_kind: mobile ? "mobile_ios" : "web",
    requested_mobile_stack: mobile ? "auto" : "none",
    business_model: "b2b",
    monetization_model: required("payments") ? monetizationModel(contract) : "none",
    native_digital_goods: mobile,
    target_market: null,
    domain: contract.venture.domain ?? null,
    locale: "en-US",
    currency: contract.business.currency,
    timezone: "Europe/Amsterdam",
    repository_visibility: "private",
    bundle_identifier: null,
    app_scheme: null,
    factors: {
      smallest_useful_build_cost: "low",
      smallest_useful_build_time: "low",
      reversibility: "high",
      regulatory_or_safety_risk: contract.product.trustRequirements.some((item) =>
        /\b(?:regulated|medical|health|legal|financial|safety-critical)\b/iu.test(item),
      )
        ? "high"
        : "low",
      real_usage_required: "high",
      marketplace_cold_start: contract.business.model === "take_rate" ? "high" : "low",
      operational_burden: contract.decision.launchMode === "concierge_first" ? "high" : "moderate",
      founder_evidence: "low",
      concierge_delivery_fit: contract.decision.launchMode === "concierge_first" ? "high" : "low",
      app_store_required: mobile ? "high" : "low",
      deep_native_requirements: "low",
      on_device_requirements: "low",
    },
    needs: {
      // The legacy routed capability is the implementation bundle for both
      // authentication and any REQUIRED authorization rules. The complete
      // tri-state map remains distinct in build context and acceptance.
      authenticated_product: required("authentication") || required("authorization"),
      database: required("database"),
      file_storage: false,
      transactional_email: required("transactionalEmail"),
      lifecycle_email: false,
      feedback: false,
      analytics: required("analytics"),
      search_discovery: required("seo"),
      scheduled_learning: required("scheduledLearning"),
    },
    preferred_dns_provider: "manual",
    ...(contract.synthetic ? { synthetic: true as const } : {}),
    deceptive_request: false,
    unsafe_non_defaultable_choice: null,
    indispensable_missing_credential: null,
  });
}

/**
 * Expands only present-tense REQUIRED classifications that have executable
 * launch capability IDs. The complete tri-state map is projected separately
 * into the build context instead of inventing provider/runtime capabilities.
 */
function routedCapabilitiesFromContract(
  contract: LaunchContract,
  rail: LaunchDecision["rail"],
  payment: LaunchDecision["payment"],
): CapabilityId[] {
  const required = (capability: keyof LaunchContractCapabilities) =>
    contract.capabilities[capability] === "REQUIRED";
  const active = new Set<CapabilityId>();
  if (required("frontend")) active.add("public_website");
  if (required("database")) active.add("database");
  if (required("authentication") || required("authorization")) {
    active.add("authenticated_product");
  }
  if (required("transactionalEmail")) active.add("transactional_email");
  if (required("analytics")) {
    active.add("ga4");
    active.add("vercel_analytics");
  }
  if (required("seo")) {
    active.add("gsc");
    active.add("bing_webmaster");
  }
  if (required("seo") || required("aeo") || required("geo")) {
    active.add("web_seo_aeo_geo");
  }
  if (required("scheduledLearning")) active.add("scheduled_learning_loops");
  if (payment.provider === "stripe") active.add("stripe");
  if (payment.provider === "revenuecat") active.add("revenuecat");
  if (rail.appKind !== "web") {
    active.add("app_store_connect");
    active.add("ios_aso");
    if (rail.mobileStack === "expo_react_native") active.add("eas");
  }
  return [...active].sort();
}

/** Honors the reviewed mode/payment fields without creating a second router. */
export function launchDecisionFromContract(contractInput: LaunchContract): LaunchDecision {
  const contract = assertLaunchContractSafe(contractInput);
  const brief = founderBriefFromLaunchContract(contract);
  const base = routeLaunch(brief);
  const selectedMode = contract.decision.launchMode;
  const paymentsRequired = contract.capabilities.payments === "REQUIRED";
  const entitlementsRequired = contract.capabilities.entitlements === "REQUIRED";
  const selectedPaymentProvider = paymentsRequired
    ? contract.business.paymentProvider
    : ("none" as const);
  const payment = {
    provider: selectedPaymentProvider,
    entitlementSource:
      entitlementsRequired && selectedPaymentProvider !== "none"
        ? selectedPaymentProvider
        : ("none" as const),
    rationale: paymentsRequired
      ? `The reviewed Launch Contract classifies payments as REQUIRED and selected ${selectedPaymentProvider} for ${contract.business.model}.`
      : `The reviewed Launch Contract classifies payments as ${contract.capabilities.payments}; no payment provider is routed for this launch.`,
  } satisfies LaunchDecision["payment"];
  return {
    ...base,
    mode: {
      ...base.mode,
      selectedMode,
      confidence: 1,
      rationale: `The reviewed Launch Contract explicitly selected ${selectedMode}.`,
      rejectedAlternatives: (
        ["thin_mvp", "product_first", "validate_first", "concierge_first"] as const
      )
        .filter((mode) => mode !== selectedMode)
        .map((mode) => ({
          mode,
          reason: `The reviewed Launch Contract selected ${selectedMode}; change the contract to select ${mode}.`,
        })),
      assumptions: [...brief.assumptions],
      evidenceThatCouldChangeChoice: [contract.decision.changeRule, contract.decision.stopRule],
    },
    payment,
    capabilities: routedCapabilitiesFromContract(contract, base.rail, payment),
  };
}

export function renderLaunchContractYaml(contractInput: LaunchContract): string {
  const contract = launchContractSchema.parse(contractInput);
  return stringifyYaml(contract, { lineWidth: 0 }).trimEnd() + "\n";
}

export function renderFounderIdea(contractInput: LaunchContract): string {
  const contract = launchContractSchema.parse(contractInput);
  return [
    "---",
    renderLaunchContractYaml(contract).trimEnd(),
    "---",
    "",
    `# ${contract.venture.name}`,
    "",
    contract.venture.oneSentenceThesis,
    "",
    "## Smallest credible launch",
    "",
    `- First user: ${contract.venture.targetUser}`,
    `- Painful job: ${contract.venture.painfulJob}`,
    `- Useful outcome: ${contract.venture.desiredOutcome}`,
    `- Proposition hypothesis: ${contract.venture.proposition}`,
    `- Core feature: ${contract.product.oneCoreFeature}`,
    `- Price hypothesis: ${contract.business.priceHypothesis === null ? "none" : `${contract.business.currency} ${contract.business.priceHypothesis}`}`,
    `- Commitment: ${contract.business.commercialCommitmentEvent}`,
    `- Success signal: ${contract.decision.primarySuccessSignal}`,
    `- Review date: ${contract.decision.reviewDate}`,
    "",
    "## Primary journey",
    "",
    ...contract.product.primaryJourney.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Explicitly not building",
    "",
    ...contract.product.explicitNotBuilding.map((item) => `- ${item}`),
    "",
    "The YAML front matter is the canonical Launch Contract. This prose is a human review surface.",
    "",
  ].join("\n");
}

export function renderProductConstitution(contractInput: LaunchContract): string {
  const contract = launchContractSchema.parse(contractInput);
  const truthLines = [
    ...contract.truth.facts.map((item) => `- FACT — ${item}`),
    ...contract.truth.assumptions.map((item) => `- FOUNDER_ASSUMPTION — ${item}`),
    ...contract.truth.inferences.map((item) => `- MODEL_INFERENCE — ${item}`),
    ...contract.truth.contradictions.map((item) => `- CONTRADICTORY — ${item}`),
    ...contract.truth.unknowns.map((item) => `- UNKNOWN — ${item}`),
    ...contract.truth.externalEvidence.map(
      (item) =>
        `- UNKNOWN — Founder-supplied external evidence awaits provenance and read-back: ${item}`,
    ),
  ];
  return [
    `# ${contract.venture.name} Product Constitution`,
    "",
    `- Category: ${contract.venture.oneSentenceThesis}`,
    `- Promise: ${contract.venture.desiredOutcome}`,
    `- Proposition hypothesis: ${contract.venture.proposition}`,
    `- First user: ${contract.venture.targetUser}`,
    `- Job to be done: ${contract.venture.painfulJob}`,
    `- Native product object: ${contract.product.oneCoreFeature}`,
    `- Primary journey: ${contract.product.primaryJourney.join(" -> ")}`,
    ...(contract.venture.domain ? [`- Reviewed custom domain: ${contract.venture.domain}`] : []),
    `- Business-model boundary: ${contract.business.model}; ${contract.business.paymentProvider}; price ${contract.business.priceHypothesis === null ? "not asserted" : `${contract.business.currency} ${contract.business.priceHypothesis}`}; one commitment event (${contract.business.commercialCommitmentEvent}).`,
    `- First learning question: Will the target user produce ${contract.decision.primarySuccessSignal} before ${contract.decision.reviewDate}?`,
    "",
    "## Truth register",
    "",
    ...(truthLines.length > 0 ? truthLines : ["- UNKNOWN — No external evidence is recorded yet."]),
    "- FIXTURE — Any sample or synthetic data must be visibly labeled at its public surface.",
    "",
    "Truth classes are FACT, FOUNDER_ASSUMPTION, MODEL_INFERENCE, FIXTURE, EXTERNALLY_VERIFIED, UNKNOWN, and CONTRADICTORY.",
    "",
    "Models may improve framing, prioritization, language, design, and implementation. Models may not invent provider state, users, demand, metrics, results, customers, revenue, reviews, source URLs, or testimonials.",
    "",
    "## Capability scope",
    "",
    ...Object.entries(contract.capabilities).map(
      ([capability, classification]) => `- ${capability} — ${classification}`,
    ),
    "",
    "## Scope exclusions",
    "",
    ...contract.product.explicitNotBuilding.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

export function launchContractDigest(contractInput: LaunchContract): string {
  return createHash("sha256")
    .update(renderLaunchContractYaml(launchContractSchema.parse(contractInput)))
    .digest("hex");
}
