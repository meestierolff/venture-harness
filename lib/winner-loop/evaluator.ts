import type { BaselineEvidence } from "./baseline";
import { createIdFactory, type IdFactoryOptions } from "./ids";
import type { WinnerLoopEvidenceStore } from "./evidence-store";
import type { MetricId, MetricSnapshot } from "./metrics";

/**
 * Baseline-adjusted winner evaluation.
 *
 * Deliberately not a views threshold. Raw reach says how far a creative
 * travelled, not whether the people it reached wanted the product, so reach is
 * one input among several and downstream intent can outweigh it. Every weight is
 * configuration, and every evaluation records the scoring version that produced
 * it so changing weights later cannot silently rewrite past conclusions.
 *
 * A metric the provider never returned stays missing here too: it lowers
 * confidence rather than scoring as zero.
 */

export type WinnerRecommendation =
  | "NO_SIGNAL"
  | "GATHER_MORE_DATA"
  | "CREATE_VARIANTS"
  | "BOOST_CANDIDATE"
  | "PAID_TEST_CANDIDATE"
  | "DO_NOT_BOOST"
  | "FATIGUE_DETECTED";

export type EvaluationConfidence = "none" | "low" | "medium" | "high";

export interface ScoringConfig {
  readonly version: string;
  /** Feature weights. Examples, not permanent truth — tune per venture. */
  readonly weights: Readonly<Record<ScoredFeature, number>>;
  readonly minimumViewsForSignal: number;
  readonly minimumViewsForConfidence: number;
  readonly maximumSnapshotAgeMinutes: number;
  readonly maximumBaselineAgeMinutes: number;
  readonly minimumAccountAgeDays: number;
  readonly minimumBaselineSampleSize: number;
  readonly minimumBaselineObservationDays: number;
  readonly maximumBaselineDisagreementRatio: number;
  /** Score at or above which a creative is worth spending on, given confidence. */
  readonly paidCandidateScore: number;
  readonly boostCandidateScore: number;
  /** Below this, reach without downstream intent means iterate rather than spend. */
  readonly minimumIntentRate: number;
}

export type ScoredFeature =
  | "viewVelocityVsBaseline"
  | "completionVsBaseline"
  | "watchTimeRatioVsBaseline"
  | "shareRate"
  | "saveRate"
  | "profileVisitRate"
  | "outboundClickRate"
  | "trialRate";

export const DEFAULT_SCORING_CONFIG: ScoringConfig = Object.freeze({
  version: "winner-score-v1",
  weights: Object.freeze({
    viewVelocityVsBaseline: 0.15,
    completionVsBaseline: 0.15,
    watchTimeRatioVsBaseline: 0.1,
    shareRate: 0.1,
    saveRate: 0.1,
    profileVisitRate: 0.1,
    outboundClickRate: 0.15,
    trialRate: 0.15,
  }),
  minimumViewsForSignal: 500,
  minimumViewsForConfidence: 5_000,
  maximumSnapshotAgeMinutes: 2_880,
  maximumBaselineAgeMinutes: 2_880,
  minimumAccountAgeDays: 14,
  minimumBaselineSampleSize: 20,
  minimumBaselineObservationDays: 7,
  maximumBaselineDisagreementRatio: 1.5,
  paidCandidateScore: 0.62,
  boostCandidateScore: 0.45,
  minimumIntentRate: 0.004,
});

export interface EvaluationInput {
  creativeId: string;
  creativeFamilyId: string;
  provider: MetricSnapshot["provider"];
  externalAccountId: string;
  format: string;
  durationSeconds: number;
  /** Ordered oldest to newest; fatigue is read from the trend across them. */
  snapshots: readonly MetricSnapshot[];
  baseline: BaselineEvidence;
  geography: string;
  evaluatedAt: Date;
  scoring?: ScoringConfig;
  /** Gates that belong to other subsystems but block spend eligibility. */
  rightsApprovedForPaid?: boolean;
  attributionHealthy?: boolean;
}

export interface FeatureValue {
  readonly feature: ScoredFeature;
  readonly raw: number | null;
  readonly normalized: number | null;
  readonly baseline: number | null;
  readonly missingReason: string | null;
}

export interface WinnerEvaluation {
  readonly recommendationId: string;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly creativeId: string;
  readonly creativeFamilyId: string;
  readonly provider: MetricSnapshot["provider"];
  readonly externalAccountId: string;
  readonly format: string;
  readonly durationSeconds: number;
  readonly baselineId: string;
  readonly scoringVersion: string;
  readonly score: number | null;
  readonly features: readonly FeatureValue[];
  readonly confidence: EvaluationConfidence;
  readonly uncertainties: readonly EvaluationUncertainty[];
  readonly missingMetrics: readonly MetricId[];
  readonly evidence: readonly string[];
  readonly interpretation: string;
  readonly recommendation: WinnerRecommendation;
  readonly proposedNextExperiment: string | null;
  readonly spendEligible: boolean;
  readonly spendBlockedReasons: readonly string[];
  readonly evaluatedAt: string;
}

export interface EvaluationUncertainty {
  readonly code:
    | "new_account"
    | "insufficient_baseline_sample"
    | "short_baseline_window"
    | "baseline_geography_unknown"
    | "baseline_geography_mismatch"
    | "stale_baseline"
    | "conflicting_baselines";
  readonly severity: "confidence_reduction" | "spend_blocking";
  readonly detail: string;
}

/** Squash a ratio-to-baseline into 0..1 so no single feature can dominate. */
function normalizeRatio(value: number): number {
  return Math.max(0, Math.min(1, value / 2));
}

function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function normalizeRate(value: number | null, target: number): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(1, value / target));
}

export interface EvaluatorOptions extends IdFactoryOptions {
  organizationId: string;
  ventureId: string;
  store?: WinnerLoopEvidenceStore;
}

export function createWinnerEvaluator(options: EvaluatorOptions) {
  if (
    !options.organizationId.trim() ||
    options.organizationId !== options.organizationId.trim() ||
    !options.ventureId.trim() ||
    options.ventureId !== options.ventureId.trim()
  ) {
    throw new Error("winner evaluator requires a canonical organization and venture scope");
  }
  const scope = Object.freeze({
    organizationId: options.organizationId,
    ventureId: options.ventureId,
  });
  const mint = createIdFactory(options);

  function evaluate(input: EvaluationInput): WinnerEvaluation {
    const baselineGeneratedAt = Date.parse(input.baseline.generatedAt);
    if (
      !Number.isFinite(baselineGeneratedAt) ||
      baselineGeneratedAt > input.evaluatedAt.getTime()
    ) {
      throw new Error("winner evaluation baseline freshness_scope_mismatch");
    }
    if (
      input.baseline.organizationId !== scope.organizationId ||
      input.baseline.ventureId !== scope.ventureId
    ) {
      throw new Error("winner evaluation baseline tenant_scope_mismatch");
    }
    if (
      input.baseline.provider !== input.provider ||
      input.baseline.externalAccountId !== input.externalAccountId
    ) {
      throw new Error("winner evaluation baseline provider_account_scope_mismatch");
    }
    if (input.baseline.account.geography !== input.geography) {
      throw new Error("winner evaluation baseline account geography_scope_mismatch");
    }
    if (input.baseline.format.format !== input.format) {
      throw new Error("winner evaluation baseline format_scope_mismatch");
    }
    if (input.baseline.duration.durationSeconds !== input.durationSeconds) {
      throw new Error("winner evaluation baseline duration_scope_mismatch");
    }
    if (
      input.snapshots.some(
        (snapshot) =>
          snapshot.organizationId !== scope.organizationId ||
          snapshot.ventureId !== scope.ventureId ||
          snapshot.provider !== input.provider ||
          snapshot.externalAccountId !== input.externalAccountId ||
          snapshot.format !== input.format ||
          snapshot.durationSeconds !== input.durationSeconds ||
          snapshot.geography !== input.geography,
      )
    ) {
      throw new Error("winner evaluation snapshot tenant_scope_mismatch");
    }
    if (input.snapshots.some((snapshot) => snapshot.creativeId !== input.creativeId)) {
      throw new Error("winner evaluation snapshots must belong to the evaluated creative");
    }
    const scoring = input.scoring ?? DEFAULT_SCORING_CONFIG;
    const accountBaseline = input.baseline.account;
    const formatBaseline = input.baseline.format;
    const durationBaseline = input.baseline.duration;
    const latest = input.snapshots[input.snapshots.length - 1];
    const evidence: string[] = [];
    const spendBlockedReasons: string[] = [];
    const uncertainties: EvaluationUncertainty[] = [];

    if (!latest) {
      return finish({
        recommendation: "NO_SIGNAL",
        interpretation: "No metric snapshot has been ingested for this creative yet.",
        score: null,
        confidence: "none",
        features: [],
        missing: [],
        next: "Ingest the first scheduled snapshot before evaluating.",
        blocked: ["no_metrics"],
      });
    }

    const views = latest.valueOf("views");
    const tracked: MetricId[] = [
      "views",
      "view_velocity",
      "completion",
      "watch_time_ratio",
      "shares",
      "saves",
      "profile_visits",
      "outbound_clicks",
      "trials",
    ];
    const missing = latest.missing(tracked);

    const ageMinutes = (input.evaluatedAt.getTime() - Date.parse(latest.capturedAt)) / 60_000;
    const stale = ageMinutes > scoring.maximumSnapshotAgeMinutes;

    function uncertainty(
      code: EvaluationUncertainty["code"],
      detail: string,
      severity: EvaluationUncertainty["severity"] = "spend_blocking",
    ) {
      uncertainties.push(Object.freeze({ code, detail, severity }));
      evidence.push(detail);
      if (severity === "spend_blocking") spendBlockedReasons.push(code);
    }

    if (accountBaseline.accountAgeDays < scoring.minimumAccountAgeDays) {
      uncertainty(
        "new_account",
        `Account age ${accountBaseline.accountAgeDays}d is below the ${scoring.minimumAccountAgeDays}d maturity threshold.`,
      );
    }
    const baselineSamples = [
      ["account", accountBaseline.sampleSize],
      ["format", formatBaseline.sampleSize],
      ["duration", durationBaseline.sampleSize],
    ] as const;
    const insufficientSamples = baselineSamples.filter(
      ([, sampleSize]) => sampleSize < scoring.minimumBaselineSampleSize,
    );
    if (insufficientSamples.length > 0) {
      uncertainty(
        "insufficient_baseline_sample",
        `${insufficientSamples.map(([name, count]) => `${name} baseline has ${count}`).join(", ")} observations; ${scoring.minimumBaselineSampleSize} are required per dimension.`,
      );
    }
    const baselineWindows: ReadonlyArray<readonly [string, number]> = [
      ["account", accountBaseline.observationWindowDays],
      ["format", formatBaseline.observationWindowDays],
      ["duration", durationBaseline.observationWindowDays],
    ];
    const shortWindows = baselineWindows.filter(
      ([, days]) => days < scoring.minimumBaselineObservationDays,
    );
    if (shortWindows.length > 0) {
      uncertainty(
        "short_baseline_window",
        `${shortWindows.map(([name, days]) => `${name} baseline covers ${days}d`).join(", ")}; ${scoring.minimumBaselineObservationDays}d are required per dimension.`,
      );
    }
    const latestBaselineSource = Math.min(
      ...[accountBaseline, formatBaseline, durationBaseline].map((dimension) =>
        dimension.latestSourceAt ? Date.parse(dimension.latestSourceAt) : Number.NEGATIVE_INFINITY,
      ),
    );
    const baselineAgeMinutes = (input.evaluatedAt.getTime() - latestBaselineSource) / 60_000;
    if (
      !Number.isFinite(baselineAgeMinutes) ||
      baselineAgeMinutes > scoring.maximumBaselineAgeMinutes
    ) {
      uncertainty(
        "stale_baseline",
        `Baseline evidence is older than the ${scoring.maximumBaselineAgeMinutes} minute freshness limit.`,
      );
    }

    const conflictingBaselineNames: string[] = [];
    for (const [name, values] of [
      [
        "completion",
        [
          accountBaseline.medianCompletion,
          formatBaseline.medianCompletion,
          durationBaseline.medianCompletion,
        ],
      ],
      [
        "watch_time_ratio",
        [
          accountBaseline.medianWatchTimeRatio,
          formatBaseline.medianWatchTimeRatio,
          durationBaseline.medianWatchTimeRatio,
        ],
      ],
    ] as const) {
      const comparable = values.filter((value): value is number => value !== null && value > 0);
      if (
        comparable.length > 1 &&
        Math.max(...comparable) / Math.min(...comparable) > scoring.maximumBaselineDisagreementRatio
      ) {
        conflictingBaselineNames.push(name);
      }
    }
    if (conflictingBaselineNames.length > 0) {
      uncertainty(
        "conflicting_baselines",
        `Account, format, and duration baselines conflict for ${conflictingBaselineNames.join(", ")}; no spend conclusion is safe until reconciled.`,
      );
    }

    // Features. Each is null when its metric or its baseline is unavailable.
    const features: FeatureValue[] = [
      feature(
        "viewVelocityVsBaseline",
        latest.valueOf("view_velocity"),
        accountBaseline.medianViewVelocityPerHour,
        accountBaseline.medianViewVelocityPerHour === null
          ? "account has no velocity baseline yet"
          : null,
      ),
      feature(
        "completionVsBaseline",
        latest.valueOf("completion"),
        durationBaseline.medianCompletion ??
          formatBaseline.medianCompletion ??
          accountBaseline.medianCompletion,
        durationBaseline.medianCompletion === null &&
          formatBaseline.medianCompletion === null &&
          accountBaseline.medianCompletion === null
          ? "no completion baseline for this duration, format, or account"
          : null,
      ),
      feature(
        "watchTimeRatioVsBaseline",
        latest.valueOf("watch_time_ratio"),
        durationBaseline.medianWatchTimeRatio ??
          formatBaseline.medianWatchTimeRatio ??
          accountBaseline.medianWatchTimeRatio,
        null,
      ),
      rateFeature("shareRate", latest.valueOf("shares"), views, 0.01),
      rateFeature("saveRate", latest.valueOf("saves"), views, 0.01),
      rateFeature("profileVisitRate", latest.valueOf("profile_visits"), views, 0.01),
      rateFeature("outboundClickRate", latest.valueOf("outbound_clicks"), views, 0.01),
      rateFeature("trialRate", latest.valueOf("trials"), views, scoring.minimumIntentRate * 2),
    ];

    // Renormalize over the weight actually available, so a missing metric
    // reduces certainty instead of dragging the score toward zero.
    let weighted = 0;
    let availableWeight = 0;
    for (const entry of features) {
      if (entry.normalized === null) continue;
      const weight = scoring.weights[entry.feature];
      weighted += entry.normalized * weight;
      availableWeight += weight;
    }
    const score = availableWeight > 0 ? weighted / availableWeight : null;

    const intentRate =
      rate(latest.valueOf("trials"), views) ?? rate(latest.valueOf("outbound_clicks"), views);

    // Confidence is about how much we know, not how good the number looks.
    let confidence: EvaluationConfidence = "high";
    if (score === null) confidence = "none";
    else if (stale) confidence = "low";
    else if (views === null || views < scoring.minimumViewsForConfidence) confidence = "low";
    else if (missing.length > 2 || availableWeight < 0.5) confidence = "medium";
    if (accountBaseline.medianViewVelocityPerHour === null && confidence === "high") {
      confidence = "medium";
      evidence.push("Account has no velocity baseline; comparison is against format only.");
    }
    if (uncertainties.some((entry) => entry.severity === "spend_blocking")) {
      confidence = "low";
    } else if (uncertainties.length > 0 && confidence === "high") {
      confidence = "medium";
    }

    if (stale) {
      evidence.push(
        `Latest snapshot is ${Math.round(ageMinutes)} minutes old, beyond the ${scoring.maximumSnapshotAgeMinutes} minute freshness limit.`,
      );
      spendBlockedReasons.push("stale_metrics");
    }
    if (missing.length > 0) {
      evidence.push(`Missing metrics: ${missing.join(", ")}. Treated as unknown, not as zero.`);
    }
    if (views !== null) evidence.push(`Views: ${views}.`);
    if (intentRate !== null) evidence.push(`Downstream intent rate: ${intentRate.toFixed(4)}.`);
    if (score !== null) evidence.push(`Baseline-adjusted score: ${score.toFixed(3)}.`);

    // Fatigue: velocity falling across consecutive snapshots.
    const velocities = input.snapshots
      .map((snapshot) => snapshot.valueOf("view_velocity"))
      .filter((value): value is number => value !== null);
    const fatigued =
      velocities.length >= 3 &&
      velocities.every((value, index) => index === 0 || value < velocities[index - 1]!) &&
      velocities[velocities.length - 1]! < velocities[0]! * 0.5;

    if (input.rightsApprovedForPaid === false) spendBlockedReasons.push("rights_not_approved");
    if (input.attributionHealthy === false) spendBlockedReasons.push("attribution_unhealthy");
    if (confidence === "low" || confidence === "none") spendBlockedReasons.push("low_confidence");

    let recommendation: WinnerRecommendation;
    let interpretation: string;
    let next: string | null = null;

    if (score === null) {
      recommendation = "NO_SIGNAL";
      interpretation = "No scoreable metric was available on the latest snapshot.";
      next = "Confirm the provider connection is returning metrics for this post.";
    } else if (fatigued) {
      recommendation = "FATIGUE_DETECTED";
      interpretation =
        "View velocity has fallen across consecutive snapshots to under half its opening rate.";
      next = "Retire this creative from rotation and test a new hook in the same family.";
    } else if (views !== null && views < scoring.minimumViewsForSignal) {
      recommendation = "GATHER_MORE_DATA";
      interpretation = `Only ${views} views so far, below the ${scoring.minimumViewsForSignal} needed for a first read.`;
      next = "Wait for the next scheduled snapshot.";
    } else if (stale || confidence === "low") {
      recommendation = "GATHER_MORE_DATA";
      interpretation = "The evidence is too thin or too old to support a confident decision.";
      next = "Refresh metrics before deciding.";
    } else if (score >= scoring.paidCandidateScore) {
      if (intentRate !== null && intentRate < scoring.minimumIntentRate) {
        recommendation = "CREATE_VARIANTS";
        interpretation =
          "Strong reach and retention, but the audience is not converting to intent. This is a targeting or CTA problem, not a spend opportunity.";
        next = "Hold the hook and test CTA and destination variants before spending.";
        spendBlockedReasons.push("reach_without_intent");
      } else {
        recommendation = "PAID_TEST_CANDIDATE";
        interpretation =
          "Baseline-adjusted performance and downstream intent both clear their thresholds.";
        next = "Propose a bounded paid test for human approval.";
      }
    } else if (score >= scoring.boostCandidateScore) {
      recommendation = "BOOST_CANDIDATE";
      interpretation = "Above baseline but short of the paid-test threshold.";
      next = "Gather one more snapshot, or test a sharper hook in the same family.";
    } else {
      recommendation = "DO_NOT_BOOST";
      interpretation =
        "Performance is at or below account baseline; spending would buy reach the creative has not earned.";
      next = "Retire and iterate on the hook.";
      spendBlockedReasons.push("below_baseline");
    }

    return finish({
      recommendation,
      interpretation,
      score,
      confidence,
      features,
      missing,
      next,
      blocked: spendBlockedReasons,
    });

    function feature(
      name: ScoredFeature,
      raw: number | null,
      baseline: number | null,
      missingReason: string | null,
    ): FeatureValue {
      if (raw === null) {
        return {
          feature: name,
          raw: null,
          normalized: null,
          baseline,
          missingReason: missingReason ?? "metric not reported by provider",
        };
      }
      if (baseline === null || baseline <= 0) {
        return { feature: name, raw, normalized: null, baseline, missingReason };
      }
      return {
        feature: name,
        raw,
        normalized: normalizeRatio(raw / baseline),
        baseline,
        missingReason: null,
      };
    }

    function rateFeature(
      name: ScoredFeature,
      numerator: number | null,
      denominator: number | null,
      target: number,
    ): FeatureValue {
      const value = rate(numerator, denominator);
      return {
        feature: name,
        raw: value,
        normalized: normalizeRate(value, target),
        baseline: target,
        missingReason: value === null ? "metric not reported by provider" : null,
      };
    }

    function finish(args: {
      recommendation: WinnerRecommendation;
      interpretation: string;
      score: number | null;
      confidence: EvaluationConfidence;
      features: readonly FeatureValue[];
      missing: readonly MetricId[];
      next: string | null;
      blocked: readonly string[];
    }): WinnerEvaluation {
      const eligible =
        args.blocked.length === 0 &&
        (args.recommendation === "PAID_TEST_CANDIDATE" ||
          args.recommendation === "BOOST_CANDIDATE");
      const evaluation: WinnerEvaluation = Object.freeze({
        recommendationId: mint("rec"),
        organizationId: scope.organizationId,
        ventureId: scope.ventureId,
        creativeId: input.creativeId,
        creativeFamilyId: input.creativeFamilyId,
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        format: input.format,
        durationSeconds: input.durationSeconds,
        baselineId: input.baseline.baselineId,
        scoringVersion: scoring.version,
        score: args.score,
        features: Object.freeze([...args.features]),
        confidence: args.confidence,
        uncertainties: Object.freeze([...uncertainties]),
        missingMetrics: Object.freeze([...args.missing]),
        evidence: Object.freeze([...evidence]),
        interpretation: args.interpretation,
        recommendation: args.recommendation,
        proposedNextExperiment: args.next,
        spendEligible: eligible,
        spendBlockedReasons: Object.freeze([...args.blocked]),
        evaluatedAt: input.evaluatedAt.toISOString(),
      });
      if (options.store) {
        options.store.put({
          organizationId: scope.organizationId,
          ventureId: scope.ventureId,
          kind: "winner_evaluation",
          recordId: evaluation.recommendationId,
          creativeId: evaluation.creativeId,
          occurredAt: evaluation.evaluatedAt,
          sourceRefs: Object.freeze([
            `baseline:${input.baseline.baselineId}`,
            ...input.snapshots.map(
              (snapshot) =>
                `metric:${snapshot.publicationId}:${snapshot.offsetMinutes}:${snapshot.capturedAt}`,
            ),
          ]),
          payload: evaluation,
        });
      }
      return evaluation;
    }
  }

  return { evaluate, scope };
}

export type WinnerEvaluator = ReturnType<typeof createWinnerEvaluator>;

export function listWinnerEvaluations(
  store: WinnerLoopEvidenceStore,
  scope: { organizationId: string; ventureId: string },
  creativeId: string,
): readonly WinnerEvaluation[] {
  return store.list(scope, "winner_evaluation", creativeId).map((entry) => {
    const evaluation = entry.payload as WinnerEvaluation;
    if (
      evaluation.organizationId !== scope.organizationId ||
      evaluation.ventureId !== scope.ventureId
    ) {
      throw new Error("persisted winner evaluation tenant_scope_mismatch");
    }
    return Object.freeze({
      ...evaluation,
      features: Object.freeze([...evaluation.features]),
      uncertainties: Object.freeze([...(evaluation.uncertainties ?? [])]),
      missingMetrics: Object.freeze([...evaluation.missingMetrics]),
      evidence: Object.freeze([...evaluation.evidence]),
      spendBlockedReasons: Object.freeze([...evaluation.spendBlockedReasons]),
    });
  });
}
