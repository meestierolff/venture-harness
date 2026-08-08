import type { DataSourceId, NormalizedDataset, NormalizedRow, NormalizedScalar } from "../data";
import type { LearningActionCandidate, LearningMetric } from "./types";

export interface LearningMetricDefinition {
  id: string;
  source: DataSourceId;
  filter?: Readonly<Record<string, NormalizedScalar>>;
  value: { operation: "sum"; field: string } | { operation: "count_rows" };
  sampleSizeField?: string;
  limitation?: string;
}

export interface DescriptiveCandidateRule {
  id: string;
  metricId: string;
  comparator: "lt" | "lte" | "gt" | "gte" | "eq";
  threshold: number;
  minimumSampleSize: number;
  journey: string;
  title: string;
  confidence: number;
  risk: "low" | "moderate" | "high";
  effectTypes?: string[];
  protectsWinner?: boolean;
}

function latestDataset(
  datasets: readonly NormalizedDataset[],
  source: DataSourceId,
): NormalizedDataset | undefined {
  return datasets
    .filter((dataset) => dataset.provenance.source === source)
    .sort(
      (left, right) =>
        Date.parse(right.provenance.fetchedAt) - Date.parse(left.provenance.fetchedAt),
    )[0];
}

function matches(row: NormalizedRow, filter: LearningMetricDefinition["filter"]): boolean {
  return Object.entries(filter ?? {}).every(([key, value]) => Object.is(row[key], value));
}

function numericSum(rows: readonly NormalizedRow[], field: string): number | null {
  const values = rows.map((row) => row[field]);
  return values.every((value) => typeof value === "number" && Number.isFinite(value))
    ? (values as number[]).reduce((sum, value) => sum + value, 0)
    : null;
}

function uniqueDefinitions(definitions: readonly LearningMetricDefinition[]) {
  return definitions.filter(
    (definition, index, all) => all.findIndex(({ id }) => id === definition.id) === index,
  );
}

export function inferObservedMetricDefinitions(
  datasets: readonly NormalizedDataset[],
): LearningMetricDefinition[] {
  const definitions: LearningMetricDefinition[] = [];
  const neon = latestDataset(datasets, "neon_commercial_evidence");
  for (const row of neon?.rows ?? []) {
    if (typeof row.record_type !== "string" || typeof row.metric_id !== "string") continue;
    const base = `${row.record_type}.${row.metric_id}`;
    definitions.push({
      id: `${base}.count`,
      source: "neon_commercial_evidence",
      filter: { record_type: row.record_type, metric_id: row.metric_id },
      value: { operation: "sum", field: "event_count" },
      sampleSizeField: "sample_size",
    });
    if (row.record_type === "commercial") {
      definitions.push({
        id: `${base}.qualified_count`,
        source: "neon_commercial_evidence",
        filter: { record_type: row.record_type, metric_id: row.metric_id },
        value: { operation: "sum", field: "qualified_count" },
        sampleSizeField: "sample_size",
      });
    }
  }
  if (latestDataset(datasets, "release_log")) {
    definitions.push(
      {
        id: "release.total",
        source: "release_log",
        value: { operation: "count_rows" },
      },
      {
        id: "release.failed",
        source: "release_log",
        filter: { status: "failed" },
        value: { operation: "count_rows" },
      },
      {
        id: "release.rolled_back",
        source: "release_log",
        filter: { status: "rolled_back" },
        value: { operation: "count_rows" },
      },
      {
        id: "release.incident_count",
        source: "release_log",
        value: { operation: "sum", field: "incident_count" },
      },
    );
  }
  return uniqueDefinitions(definitions);
}

export function deriveLearningMetrics(
  datasets: readonly NormalizedDataset[],
  definitions: readonly LearningMetricDefinition[] = inferObservedMetricDefinitions(datasets),
): LearningMetric[] {
  return uniqueDefinitions(definitions).flatMap((definition) => {
    const dataset = latestDataset(datasets, definition.source);
    if (!dataset) return [];
    const rows = dataset.rows.filter((row) => matches(row, definition.filter));
    const value =
      definition.value.operation === "count_rows"
        ? rows.length
        : numericSum(rows, definition.value.field);
    const sampleSize = definition.sampleSizeField
      ? numericSum(rows, definition.sampleSizeField)
      : rows.length;
    const invalidValue =
      value === null
        ? `Field ${definition.value.operation === "sum" ? definition.value.field : "rows"} was not consistently numeric.`
        : null;
    const limitations = [
      ...dataset.provenance.limitations,
      ...(definition.limitation ? [definition.limitation] : []),
      ...(rows.length === 0
        ? [
            "The source query completed for this window and returned no matching rows; zero is observed, not imputed from missing data.",
          ]
        : []),
      ...(invalidValue ? [invalidValue] : []),
    ];
    return [
      {
        id: definition.id,
        value,
        sampleSize,
        source: definition.source,
        window: { ...dataset.provenance.reportingWindow },
        limitation: limitations.length > 0 ? [...new Set(limitations)].join(" ") : undefined,
        evidenceRefs: [dataset.id],
      },
    ];
  });
}

function thresholdMatches(
  value: number,
  comparator: DescriptiveCandidateRule["comparator"],
  threshold: number,
): boolean {
  if (comparator === "lt") return value < threshold;
  if (comparator === "lte") return value <= threshold;
  if (comparator === "gt") return value > threshold;
  if (comparator === "gte") return value >= threshold;
  return value === threshold;
}

export function deriveDescriptiveCandidates(args: {
  metrics: readonly LearningMetric[];
  rules: readonly DescriptiveCandidateRule[];
  maximumCandidates?: number;
}): LearningActionCandidate[] {
  const maximum = args.maximumCandidates ?? 3;
  if (!Number.isInteger(maximum) || maximum < 0) {
    throw new Error("maximumCandidates must be a non-negative integer.");
  }
  for (const rule of args.rules) {
    if (!Number.isFinite(rule.threshold)) {
      throw new Error(`Candidate rule ${rule.id} has a non-finite threshold.`);
    }
    if (!Number.isInteger(rule.minimumSampleSize) || rule.minimumSampleSize < 0) {
      throw new Error(`Candidate rule ${rule.id} has an invalid minimumSampleSize.`);
    }
    if (!Number.isFinite(rule.confidence) || rule.confidence < 0 || rule.confidence > 1) {
      throw new Error(`Candidate rule ${rule.id} confidence must be between 0 and 1.`);
    }
  }
  return args.rules
    .flatMap((rule) => {
      const metric = args.metrics.find(({ id }) => id === rule.metricId);
      if (
        !metric ||
        metric.value === null ||
        !Number.isFinite(metric.value) ||
        metric.sampleSize === null ||
        metric.sampleSize < rule.minimumSampleSize ||
        !thresholdMatches(metric.value, rule.comparator, rule.threshold)
      ) {
        return [];
      }
      const comparator = {
        lt: "<",
        lte: "<=",
        gt: ">",
        gte: ">=",
        eq: "=",
      }[rule.comparator];
      return [
        {
          id: rule.id,
          journey: rule.journey,
          kind: "conceptual_hypothesis" as const,
          title: rule.title,
          rationale: `Observed ${rule.metricId}=${metric.value} with sample size ${metric.sampleSize} for ${metric.window.start}..${metric.window.end}; the predeclared threshold was ${comparator} ${rule.threshold}. This descriptive signal does not establish cause.`,
          evidenceRefs: [...(metric.evidenceRefs ?? [])],
          confidence: rule.confidence,
          risk: rule.risk,
          effectTypes: [...(rule.effectTypes ?? ["local_write"])],
          protectsWinner: rule.protectsWinner ?? false,
        },
      ];
    })
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
    .slice(0, maximum);
}
