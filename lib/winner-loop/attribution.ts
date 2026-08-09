import { createIdFactory, type IdFactoryOptions } from "./ids";
import {
  createMemoryWinnerLoopEvidenceStore,
  type WinnerLoopEvidenceStore,
} from "./evidence-store";

/**
 * Attribution.
 *
 * RevenueCat knows a subscription happened. It does not know which campaign
 * caused it. Treating a subscription event as proof that the last campaign we
 * ran worked is how a venture scales a creative that never earned anything, so
 * every attribution record carries the method that produced it and nothing may
 * be presented as exact unless it genuinely is.
 */

export const ATTRIBUTION_CLASSES = [
  "DETERMINISTIC",
  "PROVIDER_ATTRIBUTED",
  "PRIVACY_AGGREGATED",
  "CORRELATED",
  "MODELED",
  "INCREMENTAL_EXPERIMENT",
  "UNKNOWN",
] as const;
export type AttributionClass = (typeof ATTRIBUTION_CLASSES)[number];

/** Classes that may be described to a user as an exact, person-level link. */
const EXACT_CLASSES: readonly AttributionClass[] = ["DETERMINISTIC"];

export type AttributionConfidence = "high" | "medium" | "low" | "none";
export type AttributionFreshnessStatus = "fresh" | "stale" | "unknown";
export type CreativeAttributionReportingStatus =
  "exact" | "provider_claimed" | "coarse" | "stale" | "unattributed";

export interface AttributionFreshness {
  readonly status: AttributionFreshnessStatus;
  readonly sourceAgeSeconds: number | null;
  readonly maxAgeSeconds: number;
}

export interface AttributionEvidence {
  /** A click identifier that survived into the install or purchase. */
  clickId?: string | null;
  deepLinkPayload?: string | null;
  utmCampaign?: string | null;
  /** An MMP or network that claims this conversion. */
  attributionProvider?: string | null;
  /** Apple-style aggregated postback, never person-level. */
  privacyPostbackId?: string | null;
  /** Set only when the user told us where they came from. */
  selfReportedSource?: string | null;
  /** True when the only link is that spend and conversions moved together. */
  temporalCorrelationOnly?: boolean;
  incrementalExperimentId?: string | null;
}

export interface AttributionRecordInput {
  organizationId: string;
  ventureId: string;
  creativeId: string | null;
  creativeFamilyId: string | null;
  deliveryVariantId: string | null;
  organicPostId: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  adId: string | null;
  subscriberRef: string | null;
  transactionRef: string | null;
  evidence: AttributionEvidence;
  reportingWindowStart: string;
  reportingWindowEnd: string;
  conversionWindowHours: number;
  sourceTime: string;
  fetchedAt: string;
  /** Maximum accepted delay from provider occurrence to retrieval. */
  freshnessMaxAgeSeconds: number;
  mappingVersion: string;
}

export interface AttributionRecord extends Readonly<AttributionRecordInput> {
  readonly attributionId: string;
  readonly attributionClass: AttributionClass;
  readonly confidence: AttributionConfidence;
  readonly limitations: readonly string[];
  readonly mayBePresentedAsExact: boolean;
  readonly freshness: AttributionFreshness;
  /** Distinguishes an exact deterministic link from a provider's own claim. */
  readonly creativeReportingStatus: CreativeAttributionReportingStatus;
  /** The narrowest object this evidence actually supports. */
  readonly resolvedGranularity:
    "creative" | "delivery_variant" | "campaign" | "time_window" | "none";
  readonly recordedAt: string;
}

/**
 * Classify from evidence alone. Deliberately conservative: the absence of a
 * stronger signal always falls back to a weaker class rather than assuming.
 */
export function classifyAttribution(evidence: AttributionEvidence): {
  attributionClass: AttributionClass;
  confidence: AttributionConfidence;
  limitations: string[];
} {
  const limitations: string[] = [];

  if (evidence.incrementalExperimentId) {
    return {
      attributionClass: "INCREMENTAL_EXPERIMENT",
      confidence: "high",
      limitations: ["Measures lift for the tested population, not for every individual."],
    };
  }
  if (evidence.clickId || evidence.deepLinkPayload) {
    return { attributionClass: "DETERMINISTIC", confidence: "high", limitations };
  }
  if (evidence.attributionProvider) {
    limitations.push(
      "Attributed by the provider's own matching rules, which we cannot independently verify.",
    );
    return { attributionClass: "PROVIDER_ATTRIBUTED", confidence: "medium", limitations };
  }
  if (evidence.privacyPostbackId) {
    limitations.push(
      "Privacy-preserving postback: aggregated, delayed, and coarse. Not a person-level link.",
    );
    return { attributionClass: "PRIVACY_AGGREGATED", confidence: "medium", limitations };
  }
  if (evidence.selfReportedSource) {
    limitations.push("Self-reported by the user and subject to recall bias.");
    return { attributionClass: "MODELED", confidence: "low", limitations };
  }
  if (evidence.temporalCorrelationOnly || evidence.utmCampaign) {
    limitations.push(
      "Only a temporal or campaign-level association; it does not establish that this creative caused this conversion.",
    );
    return { attributionClass: "CORRELATED", confidence: "low", limitations };
  }
  limitations.push("No attribution evidence of any kind was available.");
  return { attributionClass: "UNKNOWN", confidence: "none", limitations };
}

/** How precisely the evidence lets us name a source. */
function granularityFor(
  attributionClass: AttributionClass,
  input: AttributionRecordInput,
): AttributionRecord["resolvedGranularity"] {
  if (attributionClass === "UNKNOWN") return "none";
  if (attributionClass === "DETERMINISTIC" || attributionClass === "PROVIDER_ATTRIBUTED") {
    if (input.creativeId) return "creative";
    if (input.deliveryVariantId) return "delivery_variant";
    return "campaign";
  }
  if (attributionClass === "PRIVACY_AGGREGATED" || attributionClass === "INCREMENTAL_EXPERIMENT") {
    return input.campaignId ? "campaign" : "time_window";
  }
  return "time_window";
}

function freshnessFor(input: AttributionRecordInput): AttributionFreshness {
  const sourceTime = Date.parse(input.sourceTime);
  const fetchedAt = Date.parse(input.fetchedAt);
  if (
    !Number.isFinite(sourceTime) ||
    !Number.isFinite(fetchedAt) ||
    fetchedAt < sourceTime ||
    !Number.isFinite(input.freshnessMaxAgeSeconds) ||
    input.freshnessMaxAgeSeconds <= 0
  ) {
    throw new Error(
      "attribution source/fetch timestamps and freshnessMaxAgeSeconds must form a valid freshness contract",
    );
  }
  const sourceAgeSeconds = Math.round((fetchedAt - sourceTime) / 1_000);
  return Object.freeze({
    status: sourceAgeSeconds <= input.freshnessMaxAgeSeconds ? "fresh" : "stale",
    sourceAgeSeconds,
    maxAgeSeconds: input.freshnessMaxAgeSeconds,
  });
}

function creativeReportingStatusFor(
  attributionClass: AttributionClass,
  granularity: AttributionRecord["resolvedGranularity"],
  freshness: AttributionFreshness,
): CreativeAttributionReportingStatus {
  if (attributionClass === "UNKNOWN" || granularity === "none") return "unattributed";
  if (freshness.status !== "fresh") return "stale";
  if (granularity !== "creative") return "coarse";
  if (attributionClass === "DETERMINISTIC") return "exact";
  if (attributionClass === "PROVIDER_ATTRIBUTED") return "provider_claimed";
  return "coarse";
}

export interface AttributionLedgerOptions extends IdFactoryOptions {
  organizationId: string;
  ventureId: string;
  store?: WinnerLoopEvidenceStore;
}

export function createAttributionLedger(options: AttributionLedgerOptions) {
  const now = options.now ?? (() => new Date());
  const mint = createIdFactory(options);
  const store = options.store ?? createMemoryWinnerLoopEvidenceStore();
  if (
    !options.organizationId.trim() ||
    options.organizationId !== options.organizationId.trim() ||
    !options.ventureId.trim() ||
    options.ventureId !== options.ventureId.trim()
  ) {
    throw new Error("attribution ledger requires a canonical organization and venture scope");
  }
  const scope = Object.freeze({
    organizationId: options.organizationId,
    ventureId: options.ventureId,
  });
  const hydrate = (payload: unknown): AttributionRecord => {
    const entry = payload as AttributionRecord;
    if (entry.organizationId !== scope.organizationId || entry.ventureId !== scope.ventureId) {
      throw new Error("persisted attribution tenant_scope_mismatch");
    }
    return Object.freeze({
      ...entry,
      evidence: Object.freeze({ ...entry.evidence }),
      limitations: Object.freeze([...entry.limitations]),
    });
  };
  const records = (): readonly AttributionRecord[] =>
    store.list(scope, "attribution").map((entry) => hydrate(entry.payload));

  function record(input: AttributionRecordInput): AttributionRecord {
    if (input.organizationId !== options.organizationId || input.ventureId !== options.ventureId) {
      throw new Error(
        "attribution cannot be written outside the configured organization and venture",
      );
    }
    const { attributionClass, confidence, limitations } = classifyAttribution(input.evidence);
    const granularity = granularityFor(attributionClass, input);
    const freshness = freshnessFor(input);
    const creativeReportingStatus = creativeReportingStatusFor(
      attributionClass,
      granularity,
      freshness,
    );

    const allLimitations = [...limitations];
    if (granularity !== "creative" && input.creativeId) {
      allLimitations.push(
        `Evidence supports ${granularity} granularity; creative-level certainty is not claimed.`,
      );
    }
    if (freshness.status !== "fresh") {
      allLimitations.push(
        `Attribution evidence is stale (${freshness.sourceAgeSeconds}s old; maximum ${freshness.maxAgeSeconds}s).`,
      );
    }

    const entry: AttributionRecord = Object.freeze({
      ...input,
      evidence: Object.freeze({ ...input.evidence }),
      attributionId: mint("attr"),
      attributionClass,
      confidence,
      limitations: Object.freeze(allLimitations),
      mayBePresentedAsExact:
        EXACT_CLASSES.includes(attributionClass) && freshness.status === "fresh",
      freshness,
      creativeReportingStatus,
      resolvedGranularity: granularity,
      recordedAt: now().toISOString(),
    });
    store.put({
      organizationId: options.organizationId,
      ventureId: options.ventureId,
      kind: "attribution",
      recordId: entry.attributionId,
      creativeId: entry.creativeId,
      occurredAt: entry.recordedAt,
      sourceRefs: Object.freeze([entry.mappingVersion]),
      payload: entry,
    });
    return entry;
  }

  return {
    scope,
    record,
    get: (attributionId: string) => {
      const entry = store.get(scope, "attribution", attributionId);
      return entry ? hydrate(entry.payload) : undefined;
    },
    listForCreative: (creativeId: string): readonly AttributionRecord[] =>
      store.list(scope, "attribution", creativeId).map((entry) => hydrate(entry.payload)),
    /** True only when every record backing a claim is genuinely exact. */
    isHealthyForCreativeLevelReporting(creativeId: string): boolean {
      const entries = records().filter((e) => e.creativeId === creativeId);
      if (entries.length === 0) return false;
      return entries.every(
        (entry) =>
          entry.resolvedGranularity === "creative" &&
          entry.attributionClass === "DETERMINISTIC" &&
          entry.mayBePresentedAsExact &&
          entry.creativeReportingStatus === "exact",
      );
    },
    /** The weakest class present, which is the strongest a summary may claim. */
    weakestClassForCreative(creativeId: string): AttributionClass {
      const entries = records().filter((e) => e.creativeId === creativeId);
      if (entries.length === 0) return "UNKNOWN";
      const order = ATTRIBUTION_CLASSES;
      return entries.reduce<AttributionClass>((weakest, entry) => {
        return order.indexOf(entry.attributionClass) > order.indexOf(weakest)
          ? entry.attributionClass
          : weakest;
      }, entries[0]!.attributionClass);
    },
    store,
  };
}

export type AttributionLedger = ReturnType<typeof createAttributionLedger>;
