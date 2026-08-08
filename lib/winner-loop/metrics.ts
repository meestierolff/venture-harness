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
    | "unknown_metric";

  constructor(code: MetricError["code"], message: string) {
    super(message);
    this.name = "MetricError";
    this.code = code;
  }
}

export interface MetricDefinition {
  /** Provider-scoped, e.g. "tiktok_content:completion_v1". */
  readonly definitionId: string;
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
  latencySeconds: number;
  fetchedAt: string;
  attributionWindow: string | null;
  confidence: MetricConfidence;
  rawReference: string | null;
}

export interface MetricValue extends Readonly<MetricValueInput> {
  readonly available: boolean;
}

export function recordMetricValue(input: MetricValueInput): MetricValue {
  const available = input.availability === "available";
  if (available && (input.value === null || Number.isNaN(input.value))) {
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
  return Object.freeze({ ...input, available });
}

export interface MetricSnapshotInput {
  creativeId: string;
  publicationId: string;
  offsetMinutes: number;
  capturedAt: string;
  values: readonly MetricValue[];
}

export interface MetricSnapshot {
  readonly creativeId: string;
  readonly publicationId: string;
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

export function createMetricSnapshot(input: MetricSnapshotInput): MetricSnapshot {
  const byMetric = new Map<MetricId, MetricValue>();
  for (const value of input.values) byMetric.set(value.metric, value);

  return Object.freeze({
    creativeId: input.creativeId,
    publicationId: input.publicationId,
    offsetMinutes: input.offsetMinutes,
    capturedAt: input.capturedAt,
    values: Object.freeze([...input.values]),
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

  const definitionIds = new Set(values.map((entry) => entry.definition.definitionId));
  if (definitionIds.size > 1) {
    throw new MetricError(
      "incomparable_definitions",
      `refusing to combine differing metric definitions: ${[...definitionIds].sort().join(", ")}`,
    );
  }

  const measured = values.filter((entry) => entry.available);
  return {
    total: measured.length === 0 ? null : measured.reduce((sum, e) => sum + (e.value ?? 0), 0),
    definitionId: [...definitionIds][0]!,
    missing: values.length - measured.length,
  };
}
