import { createHash } from "node:crypto";
import type { WinnerLoopEvidenceStore } from "./evidence-store";
import { listMetricSnapshots, type MetricSnapshot } from "./metrics";
import type { CreativeProvider } from "./types";

export interface BaselineDimensionEvidence {
  readonly medianViewVelocityPerHour: number | null;
  readonly medianCompletion: number | null;
  readonly medianWatchTimeRatio: number | null;
  readonly sampleSize: number;
  readonly observationWindowDays: number;
  readonly oldestSourceAt: string | null;
  readonly latestSourceAt: string | null;
  readonly sourceRefs: readonly string[];
}

export interface AccountBaseline extends BaselineDimensionEvidence {
  readonly accountAgeDays: number;
  readonly geography: string;
}

export interface FormatBaseline extends BaselineDimensionEvidence {
  readonly format: string;
}

export interface DurationBaseline extends BaselineDimensionEvidence {
  readonly durationSeconds: number;
}

export interface BaselineEvidence {
  readonly baselineId: string;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly provider: CreativeProvider;
  readonly externalAccountId: string;
  readonly generatedAt: string;
  readonly account: AccountBaseline;
  readonly format: FormatBaseline;
  readonly duration: DurationBaseline;
  readonly sourceRefs: readonly string[];
}

export interface CreateBaselineEvidenceInput {
  organizationId: string;
  ventureId: string;
  provider: CreativeProvider;
  externalAccountId: string;
  format: string;
  durationSeconds: number;
  geography: string;
  accountCreatedAt: string;
  generatedAt: string;
  sourceSnapshots: readonly MetricSnapshot[];
}

export interface BaselineEvidencePersistence {
  organizationId: string;
  ventureId: string;
  store: WinnerLoopEvidenceStore;
}

function sourceRef(snapshot: MetricSnapshot): string {
  return `metric:${snapshot.creativeId}:${snapshot.publicationId}:${snapshot.offsetMinutes}:${snapshot.capturedAt}`;
}

function sourceMaterial(snapshot: MetricSnapshot): string {
  return JSON.stringify({
    organizationId: snapshot.organizationId,
    ventureId: snapshot.ventureId,
    provider: snapshot.provider,
    externalAccountId: snapshot.externalAccountId,
    creativeId: snapshot.creativeId,
    publicationId: snapshot.publicationId,
    format: snapshot.format,
    durationSeconds: snapshot.durationSeconds,
    geography: snapshot.geography,
    offsetMinutes: snapshot.offsetMinutes,
    capturedAt: snapshot.capturedAt,
    values: [...snapshot.values].sort((left, right) => left.metric.localeCompare(right.metric)),
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function dimension(snapshots: readonly MetricSnapshot[]): BaselineDimensionEvidence {
  const ordered = [...snapshots].sort(
    (left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
  );
  const refs = Object.freeze(ordered.map(sourceRef));
  const oldestSourceAt = ordered[0]?.capturedAt ?? null;
  const latestSourceAt = ordered[ordered.length - 1]?.capturedAt ?? null;
  const observationWindowDays =
    oldestSourceAt && latestSourceAt
      ? (Date.parse(latestSourceAt) - Date.parse(oldestSourceAt)) / 86_400_000
      : 0;
  const values = (metric: "view_velocity" | "completion" | "watch_time_ratio") =>
    ordered
      .map((snapshot) => snapshot.valueOf(metric))
      .filter((value): value is number => value !== null);
  return Object.freeze({
    medianViewVelocityPerHour: median(values("view_velocity")),
    medianCompletion: median(values("completion")),
    medianWatchTimeRatio: median(values("watch_time_ratio")),
    sampleSize: ordered.length,
    observationWindowDays,
    oldestSourceAt,
    latestSourceAt,
    sourceRefs: refs,
  });
}

function assertCanonical(value: string, field: string): void {
  if (!value.trim() || value !== value.trim()) {
    throw new Error(`baseline evidence requires canonical ${field}`);
  }
}

function freezeBaseline(
  input: Omit<BaselineEvidence, "baselineId"> & { baselineId?: string },
): BaselineEvidence {
  const material = {
    organizationId: input.organizationId,
    ventureId: input.ventureId,
    provider: input.provider,
    externalAccountId: input.externalAccountId,
    generatedAt: input.generatedAt,
    account: input.account,
    format: input.format,
    duration: input.duration,
    sourceRefs: input.sourceRefs,
  };
  const baselineId =
    input.baselineId ??
    `baseline_${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
  return Object.freeze({
    baselineId,
    ...material,
    account: Object.freeze({
      ...material.account,
      sourceRefs: Object.freeze([...material.account.sourceRefs]),
    }),
    format: Object.freeze({
      ...material.format,
      sourceRefs: Object.freeze([...material.format.sourceRefs]),
    }),
    duration: Object.freeze({
      ...material.duration,
      sourceRefs: Object.freeze([...material.duration.sourceRefs]),
    }),
    sourceRefs: Object.freeze([...material.sourceRefs]),
  });
}

export function createBaselineEvidence(
  input: CreateBaselineEvidenceInput,
  persistence?: BaselineEvidencePersistence,
): BaselineEvidence {
  assertCanonical(input.organizationId, "organizationId");
  assertCanonical(input.ventureId, "ventureId");
  assertCanonical(input.externalAccountId, "externalAccountId");
  assertCanonical(input.format, "format");
  assertCanonical(input.geography, "geography");
  const generatedAt = Date.parse(input.generatedAt);
  const accountCreatedAt = Date.parse(input.accountCreatedAt);
  if (
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(accountCreatedAt) ||
    accountCreatedAt > generatedAt ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0
  ) {
    throw new Error("baseline evidence requires valid account, duration, and generation times");
  }
  if (
    persistence &&
    (persistence.organizationId !== input.organizationId ||
      persistence.ventureId !== input.ventureId)
  ) {
    throw new Error("baseline evidence persistence tenant_scope_mismatch");
  }

  const distinct = new Map<string, MetricSnapshot>();
  for (const snapshot of input.sourceSnapshots) {
    if (
      snapshot.organizationId !== input.organizationId ||
      snapshot.ventureId !== input.ventureId
    ) {
      throw new Error("baseline source snapshot tenant_scope_mismatch");
    }
    if (
      snapshot.provider !== input.provider ||
      snapshot.externalAccountId !== input.externalAccountId
    ) {
      throw new Error("baseline source snapshot provider_account_scope_mismatch");
    }
    if (
      !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
      Date.parse(snapshot.capturedAt) > generatedAt
    ) {
      throw new Error("baseline source snapshot has an invalid or future capture time");
    }
    const reference = sourceRef(snapshot);
    const existing = distinct.get(reference);
    if (existing && sourceMaterial(existing) !== sourceMaterial(snapshot)) {
      throw new Error("baseline source snapshots contain conflicting evidence for one sourceRef");
    }
    distinct.set(reference, snapshot);
  }

  const scoped = [...distinct.values()];
  const accountSources = scoped.filter((snapshot) => snapshot.geography === input.geography);
  const formatSources = accountSources.filter((snapshot) => snapshot.format === input.format);
  const durationSources = accountSources.filter(
    (snapshot) => snapshot.durationSeconds === input.durationSeconds,
  );
  const accountDimension = dimension(accountSources);
  const formatDimension = dimension(formatSources);
  const durationDimension = dimension(durationSources);
  const evidence = freezeBaseline({
    organizationId: input.organizationId,
    ventureId: input.ventureId,
    provider: input.provider,
    externalAccountId: input.externalAccountId,
    generatedAt: input.generatedAt,
    account: {
      ...accountDimension,
      accountAgeDays: (generatedAt - accountCreatedAt) / 86_400_000,
      geography: input.geography,
    },
    format: { ...formatDimension, format: input.format },
    duration: { ...durationDimension, durationSeconds: input.durationSeconds },
    sourceRefs: Object.freeze(scoped.map(sourceRef).sort()),
  });

  if (persistence) {
    persistence.store.put({
      organizationId: input.organizationId,
      ventureId: input.ventureId,
      kind: "baseline_evidence",
      recordId: evidence.baselineId,
      creativeId: null,
      occurredAt: evidence.generatedAt,
      sourceRefs: evidence.sourceRefs,
      payload: evidence,
    });
  }
  return evidence;
}

export function createBaselineEvidenceFromStore(
  input: Omit<CreateBaselineEvidenceInput, "sourceSnapshots">,
  persistence: BaselineEvidencePersistence,
): BaselineEvidence {
  return createBaselineEvidence(
    { ...input, sourceSnapshots: listMetricSnapshots(persistence) },
    persistence,
  );
}

export function listBaselineEvidence(
  persistence: BaselineEvidencePersistence,
): readonly BaselineEvidence[] {
  return persistence.store.list(persistence, "baseline_evidence").map((record) => {
    const evidence = record.payload as BaselineEvidence;
    if (
      evidence.organizationId !== persistence.organizationId ||
      evidence.ventureId !== persistence.ventureId
    ) {
      throw new Error("persisted baseline evidence tenant_scope_mismatch");
    }
    return freezeBaseline(evidence);
  });
}
