import type { DataFreshnessEntry } from "../data";
import type {
  LearningAction,
  LearningActionCandidate,
  LearningLoopDefinition,
  LearningMetric,
  LearningReport,
  OperatingCadence,
} from "./types";

const FORBIDDEN_AUTOFIX_EFFECTS = new Set([
  "price_change",
  "material_claim_change",
  "bulk_communication",
  "cold_outreach",
  "spend_increase",
  "privacy_expansion",
  "destructive_data_change",
  "app_store_publication",
  "nameserver_change",
]);

function sourceKey(entry: DataFreshnessEntry): string {
  return `${entry.source}:${entry.status}`;
}

function actionSort(a: LearningActionCandidate, b: LearningActionCandidate): number {
  const kindPriority = (candidate: LearningActionCandidate) =>
    candidate.kind === "verified_bug_fix" ? 0 : candidate.kind === "config_drift" ? 1 : 2;
  return (
    kindPriority(a) - kindPriority(b) || b.confidence - a.confidence || a.id.localeCompare(b.id)
  );
}

function disposition(
  candidate: LearningActionCandidate,
  definition: LearningLoopDefinition,
): LearningAction["disposition"] {
  if (definition.autonomy !== "autofix_low_risk") return definition.autonomy;
  const eligibleKind = ["verified_bug_fix", "metadata_repair", "config_drift"].includes(
    candidate.kind,
  );
  const forbidden = candidate.effectTypes.some((effect) => FORBIDDEN_AUTOFIX_EFFECTS.has(effect));
  const unauthorized = candidate.effectTypes.some(
    (effect) => !definition.authorizedEffectTypes.includes(effect),
  );
  return eligibleKind && candidate.risk === "low" && !forbidden && !unauthorized
    ? "autofix_low_risk"
    : "propose";
}

export function runLearningLoop(args: {
  definition: LearningLoopDefinition;
  freshness: DataFreshnessEntry[];
  metrics: LearningMetric[];
  candidates: LearningActionCandidate[];
  now?: Date;
}): LearningReport {
  const { definition, freshness, metrics } = args;
  const now = args.now ?? new Date();
  const freshnessBySource = new Map(freshness.map((entry) => [entry.source, entry]));
  const requiredGaps = definition.requiredSources.flatMap((requirement) => {
    const entry = freshnessBySource.get(requirement.source);
    if (!entry || entry.status !== "fresh") {
      return [
        `Required source ${requirement.source} is ${entry?.status ?? "missing"}; missing is not zero.`,
      ];
    }
    return [];
  });
  const invalidMetrics = metrics.flatMap((metric) => {
    if (metric.value !== null && !Number.isFinite(metric.value))
      return [`Metric ${metric.id} is non-finite.`];
    if (metric.sampleSize !== null && metric.sampleSize < 0)
      return [`Metric ${metric.id} has a negative sample size.`];
    return [];
  });
  const missingPrimary = definition.primaryMetrics.filter(
    (id) => !metrics.some((metric) => metric.id === id && metric.value !== null),
  );
  const limitations = [
    ...requiredGaps,
    ...invalidMetrics,
    ...missingPrimary.map((id) => `Primary metric ${id} is unavailable.`),
    ...metrics.flatMap((metric) =>
      metric.limitation ? [`${metric.id}: ${metric.limitation}`] : [],
    ),
  ];
  if (requiredGaps.length > 0 || invalidMetrics.length > 0 || missingPrimary.length > 0) {
    return {
      loopId: definition.id,
      cadence: definition.cadence,
      generatedAt: now.toISOString(),
      status: "insufficient_evidence",
      freshness,
      metrics,
      protectedWinners: [],
      actions: [],
      rejectedActions: args.candidates.map((candidate) => ({
        id: candidate.id,
        reason: "Required decision evidence is missing, stale, or invalid.",
      })),
      limitations,
      nextRunAt: definition.nextRunAt,
      stopCondition: definition.stopCondition,
    };
  }

  const actions: LearningAction[] = [];
  const rejectedActions: { id: string; reason: string }[] = [];
  const conceptualJourneys = new Set<string>();
  let boundedActions = 0;
  for (const candidate of [...args.candidates].sort(actionSort)) {
    if (candidate.confidence < 0.7) {
      rejectedActions.push({
        id: candidate.id,
        reason: "Confidence is below the 0.70 action threshold.",
      });
      continue;
    }
    if (candidate.protectsWinner && candidate.kind === "conceptual_hypothesis") {
      rejectedActions.push({
        id: candidate.id,
        reason: "The proposal risks a protected winner without stronger evidence.",
      });
      continue;
    }
    if (candidate.kind === "conceptual_hypothesis" && conceptualJourneys.has(candidate.journey)) {
      rejectedActions.push({
        id: candidate.id,
        reason: "Only one conceptual hypothesis may be active per journey.",
      });
      continue;
    }
    const unboundedBugFix = candidate.kind === "verified_bug_fix";
    if (!unboundedBugFix && boundedActions >= definition.maximumActions) {
      rejectedActions.push({
        id: candidate.id,
        reason: `Loop action cap ${definition.maximumActions} reached.`,
      });
      continue;
    }
    if (candidate.kind === "conceptual_hypothesis") conceptualJourneys.add(candidate.journey);
    if (!unboundedBugFix) boundedActions += 1;
    actions.push({ ...candidate, disposition: disposition(candidate, definition) });
  }

  return {
    loopId: definition.id,
    cadence: definition.cadence,
    generatedAt: now.toISOString(),
    status: "complete",
    freshness,
    metrics,
    protectedWinners: args.candidates
      .filter((candidate) => candidate.protectsWinner)
      .map((candidate) => candidate.journey)
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort(),
    actions,
    rejectedActions,
    limitations,
    nextRunAt: definition.nextRunAt,
    stopCondition: definition.stopCondition,
  };
}

export function buildOperatingCadence(args: {
  loops: LearningLoopDefinition[];
  freshness: DataFreshnessEntry[];
  activeHypotheses?: string[];
  activeExperiments?: string[];
  activeBlockers?: string[];
  now?: Date;
}): OperatingCadence {
  const next = (cadence: LearningLoopDefinition["cadence"]) =>
    args.loops
      .filter((loop) => loop.cadence === cadence && loop.nextRunAt)
      .map((loop) => loop.nextRunAt!)
      .sort()[0] ?? null;
  return {
    generatedAt: (args.now ?? new Date()).toISOString(),
    nextDailyReview: next("daily"),
    nextWeeklyReview: next("weekly"),
    nextBiweeklyReview: next("biweekly"),
    nextMonthlyReview: next("monthly"),
    missingDataSources: args.freshness
      .filter((entry) => entry.required && entry.status !== "fresh")
      .map((entry) => entry.source)
      .sort(),
    activeHypotheses: [...new Set(args.activeHypotheses ?? [])].sort(),
    activeExperiments: [...new Set(args.activeExperiments ?? [])].sort(),
    activeBlockers: [...new Set(args.activeBlockers ?? [])].sort(),
  };
}

export function freshnessFingerprint(entries: DataFreshnessEntry[]): string {
  return entries.map(sourceKey).sort().join("|");
}
