import { createHash } from "node:crypto";
import type { WinnerLoopEvidenceStore } from "./evidence-store";
import type { CreativeProvider } from "./types";

/**
 * Organic metric ingestion.
 *
 * Two rules drive every decision here:
 *
 *  1. Missing is not zero. A metric a provider did not return is unknown, and
 *     unknown must stay distinguishable from "measured, and it was zero" all
 *     the way into scoring. Coercing one into the other manufactures evidence.
 *  2. Definitions are provider-scoped. "Completion" does not mean the same
 *     thing on two networks, so two values may only be compared or summed when
 *     they carry the same definition.
 */

export const METRIC_IDS = [
  "views",
  "view_velocity",
  "early_hold",
  "longer_hold",
  "average_watch_time",
  "watch_time_ratio",
  "completion",
  "rewatches",
  "likes",
  "shares",
  "saves",
  "comments",
  "profile_visits",
  "outbound_clicks",
  "app_store_visits",
  "installs",
  "trials",
  "purchases",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export type MetricUnit = "count" | "ratio" | "seconds" | "count_per_hour";

/** Why a value is absent. Each is actionable in a different way, so they are
 * never collapsed into a single "no data" state. */
export type MetricAvailability =
  | "available"
  | "not_supported_by_provider"
  | "not_yet_available"
  | "suppressed_below_threshold"
  | "permission_denied"
  | "fetch_failed";

export type MetricConfidence = "high" | "medium" | "low";

/** Standard snapshot offsets after publication. */
export const SNAPSHOT_OFFSETS_MINUTES = [30, 120, 360, 1_440, 4_320, 10_080] as const;

export class MetricError extends Error {
  readonly code:
    | "value_without_availability"
    | "missing_without_reason"
    | "incomparable_definitions"
    | "definition_mismatch"
    | "duplicate_metric"
    | "unknown_metric"
    | "invalid_value"
    | "invalid_time"
    | "invalid_snapshot"
    | "tenant_scope_mismatch";

  constructor(code: MetricError["code"], message: string) {
    super(message);
    this.name = "MetricError";
    this.code = code;
  }
}

export interface MetricDefinition {
  /** Provider-scoped, e.g. "tiktok_content:completion_v1". */
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly metric: MetricId;
  readonly provider: CreativeProvider;
  readonly unit: MetricUnit;
  readonly description: string;
}

export interface MetricValueInput {
  metric: MetricId;
  definition: MetricDefinition;
  provider: CreativeProvider;
  externalAccountId: string;
  sourceObjectId: string;
  availability: MetricAvailability;
  /** Must be null for every availability other than "available". */
  value: number | null;
  missingReason: string | null;
  reportingWindowStart: string;
  reportingWindowEnd: string;
  /** Provider/source occurrence time, distinct from fetch time. */
  sourceTime: string;
  latencySeconds: number;
  fetchedAt: string;
  attributionWindow: string | null;
  confidence: MetricConfidence;
  rawReference: string | null;
}

export interface MetricValue extends Readonly<MetricValueInput> {
  readonly available: boolean;
}

const METRIC_UNITS: readonly MetricUnit[] = ["count", "ratio", "seconds", "count_per_hour"];
const METRIC_AVAILABILITIES: readonly MetricAvailability[] = [
  "available",
  "not_supported_by_provider",
  "not_yet_available",
  "suppressed_below_threshold",
  "permission_denied",
  "fetch_failed",
];
const METRIC_CONFIDENCES: readonly MetricConfidence[] = ["high", "medium", "low"];
const CREATIVE_PROVIDER_IDS: readonly CreativeProvider[] = [
  "tiktok_content",
  "tiktok_ads",
  "meta_ads",
  "postiz",
  "zernio",
  "heygen",
  "higgsfield",
  "local_renderer",
  "revenuecat",
  "appsflyer",
];

function canonicalText(value: string, field: string, maximum = 512): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > maximum ||
    /\s|[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new MetricError("invalid_value", `${field} must be a canonical identifier`);
  }
}

function validTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new MetricError("invalid_time", `${field} must be a valid timestamp`);
  }
  return parsed;
}

function assertMetricDomain(input: MetricValueInput): void {
  if (input.value === null) return;
  if (!Number.isFinite(input.value)) {
    throw new MetricError("invalid_value", `${input.metric} must carry a finite value`);
  }
  if (input.definition.unit === "count") {
    if (!Number.isSafeInteger(input.value) || input.value < 0) {
      throw new MetricError(
        "invalid_value",
        `${input.metric} count must be a non-negative safe integer`,
      );
    }
    return;
  }
  if (input.definition.unit === "ratio") {
    if (input.value < 0 || input.value > 1) {
      throw new MetricError("invalid_value", `${input.metric} ratio must be between zero and one`);
    }
    return;
  }
  if (input.value < 0) {
    throw new MetricError("invalid_value", `${input.metric} must not be negative`);
  }
}

export function recordMetricValue(input: MetricValueInput): MetricValue {
  if (!(METRIC_IDS as readonly string[]).includes(input.metric)) {
    throw new MetricError("unknown_metric", `unknown metric ${String(input.metric)}`);
  }
  if (!(CREATIVE_PROVIDER_IDS as readonly string[]).includes(input.provider)) {
    throw new MetricError(
      "definition_mismatch",
      `unknown metric provider ${String(input.provider)}`,
    );
  }
  canonicalText(input.definition.definitionId, "definitionId");
  canonicalText(input.definition.definitionVersion, "definitionVersion");
  canonicalText(input.externalAccountId, "externalAccountId");
  canonicalText(input.sourceObjectId, "sourceObjectId");
  if (!input.definition.description.trim()) {
    throw new MetricError("definition_mismatch", "metric definition description is required");
  }
  if (!(METRIC_UNITS as readonly string[]).includes(input.definition.unit)) {
    throw new MetricError(
      "definition_mismatch",
      `unsupported metric unit ${input.definition.unit}`,
    );
  }
  if (!(METRIC_AVAILABILITIES as readonly string[]).includes(input.availability)) {
    throw new MetricError("invalid_value", `unsupported availability ${input.availability}`);
  }
  if (!(METRIC_CONFIDENCES as readonly string[]).includes(input.confidence)) {
    throw new MetricError("invalid_value", `unsupported metric confidence ${input.confidence}`);
  }
  const reportingWindowStart = validTime(input.reportingWindowStart, "reportingWindowStart");
  const reportingWindowEnd = validTime(input.reportingWindowEnd, "reportingWindowEnd");
  const sourceTime = validTime(input.sourceTime, "sourceTime");
  const fetchedAt = validTime(input.fetchedAt, "fetchedAt");
  if (
    reportingWindowEnd < reportingWindowStart ||
    sourceTime < reportingWindowStart ||
    sourceTime > reportingWindowEnd ||
    fetchedAt < sourceTime
  ) {
    throw new MetricError(
      "invalid_time",
      "metric reporting window, source time, and fetch time must be ordered",
    );
  }
  if (!Number.isFinite(input.latencySeconds) || input.latencySeconds < 0) {
    throw new MetricError("invalid_time", "metric latencySeconds must be finite and non-negative");
  }
  if (input.attributionWindow !== null && !input.attributionWindow.trim()) {
    throw new MetricError("invalid_value", "attributionWindow must be null or non-empty");
  }
  if (input.rawReference !== null) {
    canonicalText(input.rawReference, "rawReference", 2_048);
  }
  if (
    input.definition.metric !== input.metric ||
    input.definition.provider !== input.provider ||
    !input.definition.definitionVersion.trim()
  ) {
    throw new MetricError(
      "definition_mismatch",
      `${input.metric} must match its provider-scoped metric definition, version, and source time`,
    );
  }
  const available = input.availability === "available";
  if (available && input.value === null) {
    throw new MetricError(
      "value_without_availability",
      `${input.metric} is marked available but carries no value`,
    );
  }
  if (!available && input.value !== null) {
    throw new MetricError(
      "value_without_availability",
      `${input.metric} is ${input.availability} but carries value ${input.value}; missing is not zero`,
    );
  }
  if (!available && !input.missingReason) {
    throw new MetricError(
      "missing_without_reason",
      `${input.metric} is ${input.availability} and must state why it is missing`,
    );
  }
  if (available && input.missingReason !== null) {
    throw new MetricError(
      "value_without_availability",
      `${input.metric} is available and must not carry a missing reason`,
    );
  }
  if (input.missingReason !== null && input.missingReason !== input.missingReason.trim()) {
    throw new MetricError(
      "missing_without_reason",
      `${input.metric} missing reason is not canonical`,
    );
  }
  assertMetricDomain(input);
  return Object.freeze({ ...input, available });
}

export interface MetricSnapshotInput {
  organizationId: string;
  ventureId: string;
  provider: CreativeProvider;
  externalAccountId: string;
  creativeId: string;
  publicationId: string;
  format: string;
  durationSeconds: number;
  geography: string;
  offsetMinutes: number;
  capturedAt: string;
  values: readonly MetricValue[];
}

export interface MetricSnapshot {
  readonly organizationId: string;
  readonly ventureId: string;
  readonly provider: CreativeProvider;
  readonly externalAccountId: string;
  readonly creativeId: string;
  readonly publicationId: string;
  readonly format: string;
  readonly durationSeconds: number;
  readonly geography: string;
  readonly offsetMinutes: number;
  readonly capturedAt: string;
  readonly values: readonly MetricValue[];
  /** The measured value, or null when the provider did not supply one. */
  get(metric: MetricId): MetricValue | undefined;
  valueOf(metric: MetricId): number | null;
  /** Metrics the caller asked about that carry no measurement. */
  missing(metrics: readonly MetricId[]): readonly MetricId[];
  isComplete(metrics: readonly MetricId[]): boolean;
}

export interface MetricSnapshotPersistence {
  organizationId: string;
  ventureId: string;
  store: WinnerLoopEvidenceStore;
}

export function createMetricSnapshot(
  input: MetricSnapshotInput,
  persistence?: MetricSnapshotPersistence,
): MetricSnapshot {
  if (
    !input.organizationId.trim() ||
    input.organizationId !== input.organizationId.trim() ||
    !input.ventureId.trim() ||
    input.ventureId !== input.ventureId.trim() ||
    !(CREATIVE_PROVIDER_IDS as readonly string[]).includes(input.provider) ||
    !input.externalAccountId.trim() ||
    input.externalAccountId !== input.externalAccountId.trim() ||
    !input.creativeId.trim() ||
    input.creativeId !== input.creativeId.trim() ||
    !input.publicationId.trim() ||
    input.publicationId !== input.publicationId.trim() ||
    !input.format.trim() ||
    input.format !== input.format.trim() ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    !input.geography.trim() ||
    input.geography !== input.geography.trim() ||
    !Number.isSafeInteger(input.offsetMinutes) ||
    input.offsetMinutes <= 0 ||
    !Number.isFinite(Date.parse(input.capturedAt))
  ) {
    throw new MetricError(
      "invalid_snapshot",
      "metric snapshot requires canonical identity, dimensions, cadence, and capture time",
    );
  }
  if (
    persistence &&
    (persistence.organizationId !== input.organizationId ||
      persistence.ventureId !== input.ventureId)
  ) {
    throw new MetricError(
      "tenant_scope_mismatch",
      "metric snapshot persistence scope does not match the snapshot scope",
    );
  }
  const values = input.values.map((value) => recordMetricValue(value));
  const byMetric = new Map<MetricId, MetricValue>();
  for (const value of values) {
    if (value.provider !== input.provider || value.externalAccountId !== input.externalAccountId) {
      throw new MetricError(
        "tenant_scope_mismatch",
        "metric value provider/account scope does not match its snapshot",
      );
    }
    if (Date.parse(value.fetchedAt) > Date.parse(input.capturedAt)) {
      throw new MetricError(
        "invalid_time",
        "metric snapshot cannot be captured before its provider value was fetched",
      );
    }
    if (byMetric.has(value.metric)) {
      throw new MetricError(
        "duplicate_metric",
        `snapshot contains more than one ${value.metric} value`,
      );
    }
    byMetric.set(value.metric, value);
  }

  const snapshot = Object.freeze({
    organizationId: input.organizationId,
    ventureId: input.ventureId,
    provider: input.provider,
    externalAccountId: input.externalAccountId,
    creativeId: input.creativeId,
    publicationId: input.publicationId,
    format: input.format,
    durationSeconds: input.durationSeconds,
    geography: input.geography,
    offsetMinutes: input.offsetMinutes,
    capturedAt: input.capturedAt,
    values: Object.freeze([...values]),
    get: (metric: MetricId) => byMetric.get(metric),
    valueOf: (metric: MetricId) => {
      const entry = byMetric.get(metric);
      return entry && entry.available ? entry.value : null;
    },
    missing: (metrics: readonly MetricId[]) =>
      metrics.filter((metric) => {
        const entry = byMetric.get(metric);
        return !entry || !entry.available;
      }),
    isComplete: (metrics: readonly MetricId[]) =>
      metrics.every((metric) => byMetric.get(metric)?.available === true),
  });
  if (persistence) {
    const recordId = createHash("sha256")
      // Exact redeliveries deduplicate, while a provider correction with new
      // values becomes an immutable revision instead of rewriting history.
      .update(JSON.stringify({ ...input, values }))
      .digest("hex");
    persistence.store.put({
      organizationId: persistence.organizationId,
      ventureId: persistence.ventureId,
      kind: "metric_snapshot",
      recordId,
      creativeId: input.creativeId,
      occurredAt: input.capturedAt,
      sourceRefs: Object.freeze(
        values
          .map((value) => value.rawReference)
          .filter((reference): reference is string => reference !== null),
      ),
      payload: {
        organizationId: input.organizationId,
        ventureId: input.ventureId,
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        creativeId: input.creativeId,
        publicationId: input.publicationId,
        format: input.format,
        durationSeconds: input.durationSeconds,
        geography: input.geography,
        offsetMinutes: input.offsetMinutes,
        capturedAt: input.capturedAt,
        values,
      },
    });
  }
  return snapshot;
}

export function listMetricSnapshots(
  persistence: MetricSnapshotPersistence,
  creativeId?: string,
): readonly MetricSnapshot[] {
  return persistence.store.list(persistence, "metric_snapshot", creativeId).map((entry) => {
    const input = entry.payload as MetricSnapshotInput;
    if (
      input.organizationId !== persistence.organizationId ||
      input.ventureId !== persistence.ventureId
    ) {
      throw new MetricError(
        "tenant_scope_mismatch",
        "persisted metric snapshot scope does not match its evidence partition",
      );
    }
    return createMetricSnapshot({
      ...input,
      values: input.values.map((value) => Object.freeze({ ...value })),
    });
  });
}

/**
 * Sum values that share one definition. Returns the total alongside the inputs
 * that carried no measurement, so a caller can never mistake a partial sum for
 * a complete one.
 */
export function sumComparable(values: readonly MetricValue[]): {
  total: number | null;
  definitionId: string | null;
  missing: number;
} {
  if (values.length === 0) return { total: null, definitionId: null, missing: 0 };

  const definitionKeys = new Set(
    values.map((entry) =>
      JSON.stringify([
        entry.definition.definitionId,
        entry.definition.definitionVersion,
        entry.definition.provider,
        entry.definition.metric,
        entry.definition.unit,
      ]),
    ),
  );
  if (definitionKeys.size > 1) {
    throw new MetricError(
      "incomparable_definitions",
      "refusing to combine differing provider, metric, unit, or version definitions",
    );
  }

  const measured = values.filter((entry) => entry.available);
  const total =
    measured.length === 0 ? null : measured.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
  if (
    total !== null &&
    (!Number.isFinite(total) ||
      (values[0]!.definition.unit === "count" && !Number.isSafeInteger(total)))
  ) {
    throw new MetricError("invalid_value", "combined metric value exceeds its numeric domain");
  }
  return {
    total,
    definitionId: values[0]!.definition.definitionId,
    missing: values.length - measured.length,
  };
}
