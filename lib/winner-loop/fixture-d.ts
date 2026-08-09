import { createAttributionLedger } from "./attribution";
import { createCreativeLedger } from "./creative-ledger";
import { createWinnerEvaluator } from "./evaluator";
import { createIdFactory } from "./ids";
import { buildLearning, type WinnerLoopLearning } from "./learnings";
import {
  createMetricSnapshot,
  recordMetricValue,
  type MetricId,
  type MetricSnapshot,
} from "./metrics";
import { createPaidTestService, PaidTestError } from "./paid-test";
import { assessReadiness, type ReadinessAssessment } from "./readiness";
import { createSpendLedger } from "./spend";
import type { SpendStore } from "./spend-store";
import {
  createSubscriptionIngestor,
  DEFAULT_COHORT_WINDOWS,
  type CohortSnapshot,
  type SubscriptionEvent,
} from "./subscriptions";
import type { GrowthContract } from "../config/growth-contract-schema";

/**
 * Fixture D — the synthetic Winner Loop run.
 *
 * Everything here goes through the same production modules a live run uses: the
 * creative ledger, the metric contract, the evaluator, the paid-test gate, the
 * transactional spend ledger, the attribution ledger, and the subscription
 * ingestor. Only the provider adapters are synthetic, and they are labelled as
 * such in the trace. Nothing in this file is evidence about a real provider.
 */

export const FIXTURE_LABEL = "SYNTHETIC_FIXTURE — no provider was contacted";

export interface FixtureDResult {
  readonly label: string;
  readonly ventureId: string;
  readonly creativeId: string;
  readonly deliveryVariantId: string;
  readonly lineage: readonly string[];
  readonly snapshots: number;
  readonly evaluation: ReturnType<ReturnType<typeof createWinnerEvaluator>["evaluate"]>;
  readonly readiness: ReadinessAssessment;
  readonly paidBlockedWithoutApproval: string;
  readonly paidBlockedWithoutGrant: string;
  readonly proposalId: string;
  readonly grantId: string;
  readonly settledSpendMinor: number;
  readonly duplicateEventRejected: boolean;
  readonly outOfOrderHandled: boolean;
  readonly cohorts: readonly CohortSnapshot[];
  readonly learning: WinnerLoopLearning;
  readonly providerObjects: readonly {
    provider: string;
    objectKind: string;
    externalId: string;
  }[];
}

function metric(
  metricId: MetricId,
  value: number | null,
  capturedAt: string,
  missingReason: string | null = null,
) {
  return recordMetricValue({
    metric: metricId,
    definition: {
      definitionId: `tiktok_content:${metricId}_v1`,
      metric: metricId,
      provider: "tiktok_content",
      unit: metricId === "completion" || metricId === "watch_time_ratio" ? "ratio" : "count",
      description: `TikTok ${metricId}`,
    },
    provider: "tiktok_content",
    externalAccountId: "fixture-tt-account",
    sourceObjectId: "fixture-tt-post",
    availability: value === null ? "not_supported_by_provider" : "available",
    value,
    missingReason: value === null ? (missingReason ?? "not exposed for this account type") : null,
    reportingWindowStart: capturedAt,
    reportingWindowEnd: capturedAt,
    latencySeconds: 60,
    fetchedAt: capturedAt,
    attributionWindow: null,
    confidence: value === null ? "low" : "high",
    rawReference: `fixtures/winner-loop/${metricId}.json`,
  });
}

export interface FixtureDOptions {
  contract: GrowthContract;
  store: SpendStore;
  now?: () => Date;
}

/** Run the whole loop end to end and return everything needed for the trace. */
export async function runFixtureD(options: FixtureDOptions): Promise<FixtureDResult> {
  const at = options.now ?? (() => new Date("2026-08-09T12:00:00.000Z"));
  const ventureId = options.contract.venture_id;
  const deterministicRandom = (size: number) =>
    Uint8Array.from({ length: size }, (_, index) => (index * 7 + 11) % 256);
  const mint = createIdFactory({ now: at, randomBytes: deterministicRandom });

  // 8-10. Hypothesis, family, variant, and a permanent creative id.
  const creatives = createCreativeLedger({
    ventureId,
    now: at,
    randomBytes: deterministicRandom,
  });
  const variant = creatives.registerVariant({
    ventureId,
    hypothesisId: "hyp-fixture-001",
    creativeFamilyId: "fam-fixture-001",
    media: {
      hook: "You are losing payouts you already earned",
      openingFrame: "close_up_face",
      format: "talking_head_with_screen_recording",
      speaker: "founder",
      visualSequence: "face_then_dashboard",
      audioTrack: "voice_only",
      onScreenProof: "dashboard_recording",
      embeddedCta: "Check your rank free",
      durationSeconds: 22,
      aspectRatio: "9:16",
    },
    assetContentHash: "sha256:fixture-asset",
  });

  // 11-12. Render job, reconciled by provider job id.
  creatives.mapProviderObject({
    creativeId: variant.creativeId,
    provider: "local_renderer",
    objectKind: "render_job",
    externalId: "fixture-render-1",
    externalAccountId: "fixture-renderer",
    ventureId,
  });
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "READY_FOR_PRODUCTION");
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "RENDERING");
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "ASSET_READY");

  // 13-16. Rights review, organic draft, approved publication.
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "READY_FOR_ORGANIC_REVIEW");
  const delivery = creatives.registerDeliveryVariant(variant.creativeId, {
    caption: "Most affiliates never check this.",
    adCopy: "",
    destinationUrl: "https://payoutrank.example/scan?utm_source=tiktok",
    privacy: "public",
    platformSettings: { duet: false, stitch: false },
  });
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "ORGANIC_DRAFT");
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "ORGANIC_PUBLISHED");
  creatives.mapProviderObject({
    creativeId: variant.creativeId,
    deliveryVariantId: delivery.deliveryVariantId,
    provider: "tiktok_content",
    objectKind: "organic_post",
    externalId: "fixture-tt-post",
    externalAccountId: "fixture-tt-account",
    ventureId,
  });

  // 17-18. Several snapshots, one metric genuinely missing throughout.
  const snapshots: MetricSnapshot[] = [
    { offset: 30, at: "2026-08-09T09:30:00.000Z", views: 4_000, velocity: 900, trials: 20 },
    { offset: 120, at: "2026-08-09T11:00:00.000Z", views: 18_000, velocity: 950, trials: 90 },
    { offset: 360, at: "2026-08-09T11:50:00.000Z", views: 31_000, velocity: 1_000, trials: 210 },
  ].map((step) =>
    createMetricSnapshot({
      creativeId: variant.creativeId,
      publicationId: "fixture-tt-post",
      offsetMinutes: step.offset,
      capturedAt: step.at,
      values: [
        metric("views", step.views, step.at),
        metric("view_velocity", step.velocity, step.at),
        metric("completion", 0.46, step.at),
        metric("watch_time_ratio", 0.58, step.at),
        metric("shares", Math.round(step.views * 0.012), step.at),
        metric("profile_visits", Math.round(step.views * 0.011), step.at),
        metric("outbound_clicks", Math.round(step.views * 0.017), step.at),
        metric("trials", step.trials, step.at),
        // Deliberately absent: proves missing stays missing through scoring.
        metric("saves", null, step.at, "saves are not exposed for this account type"),
      ],
    }),
  );

  // 19-20. Baseline-adjusted evaluation.
  const evaluation = createWinnerEvaluator({ now: at, randomBytes: deterministicRandom }).evaluate({
    creativeId: variant.creativeId,
    creativeFamilyId: variant.creativeFamilyId,
    snapshots,
    accountBaseline: {
      medianViewVelocityPerHour: 500,
      medianCompletion: 0.3,
      medianWatchTimeRatio: 0.4,
      accountAgeDays: 200,
      sampleSize: 40,
    },
    formatBaseline: {
      format: "talking_head_with_screen_recording",
      medianCompletion: 0.3,
      medianWatchTimeRatio: 0.4,
    },
    geography: "NL",
    evaluatedAt: at(),
    rightsApprovedForPaid: true,
    attributionHealthy: true,
  });

  const readiness = assessReadiness(
    options.contract,
    {
      eventDeliveryRate: 0.99,
      eventDeduplicationCorrect: true,
      currencyAndValueValid: true,
      medianEventLatencySeconds: 120,
      attributionHealthy: true,
      recentHighIntentEvents: 320,
      recentPurchases: 12,
      purchasesWithValue: 12,
      refundRate: 0.02,
      d7Retention: 0.5,
      observedCacMinor: 1_200,
      providerValueOptimizationEligibility: "unknown",
      providerEligibilityCheckedAt: null,
    },
    at(),
  );

  // 21. Proposal.
  const paid = createPaidTestService({ now: at, randomBytes: deterministicRandom });
  const proposal = paid.propose({
    ventureId,
    creativeId: variant.creativeId,
    deliveryVariantId: delivery.deliveryVariantId,
    organicPostId: "fixture-tt-post",
    network: "tiktok_paid",
    adAccountId: "fixture-tt-ads",
    objective: "conversions",
    optimizationEvent: readiness.recommendedOptimizationEvent ?? "trial_start",
    geographies: ["NL"],
    audienceConstraints: [],
    totalBudgetMinor: options.contract.paid.per_creative_test_budget_minor,
    dailyCapMinor: options.contract.paid.daily_account_cap_minor,
    currency: options.contract.economics.currency,
    startAt: "2026-08-09T00:00:00.000Z",
    endAt: "2026-08-16T00:00:00.000Z",
    targetCacMinor: options.contract.economics.target_cac_minor,
    hardMaxCacMinor: options.contract.economics.hard_max_cac_minor,
    paybackTargetDays: options.contract.economics.payback_target_days,
    maxSpendWithoutTrialMinor: options.contract.paid.stop_conditions.max_spend_without_trial_minor,
    maxSpendWithoutPurchaseMinor:
      options.contract.paid.stop_conditions.max_spend_without_purchase_minor,
    trackingHealthy: true,
    attributionHealthy: true,
    rightsState: "approved_for_paid",
    disclosureState: "present",
    providerEligible: true,
    recommendationId: evaluation.recommendationId,
    evidence: [...evaluation.evidence],
    createdBy: "winner-loop-fixture",
    expiresAt: "2026-08-12T00:00:00.000Z",
  });

  const spend = createSpendLedger({
    store: options.store,
    now: at,
    randomBytes: deterministicRandom,
  });

  // 22. Two separate gates, proven separately. The adapter must not run in
  // either case, so it flips a flag we check rather than being trusted.
  const adapterRan = { value: false };
  const attemptPaid = async (grantId: string, idempotencyKey: string): Promise<string> => {
    try {
      await paid.executePaidOperation(
        {
          proposalId: proposal.proposalId,
          grantId,
          creativeId: variant.creativeId,
          network: "tiktok_paid",
          adAccountId: "fixture-tt-ads",
          objective: "conversions",
          amountMinorUnits: 5_000,
          campaignId: "fixture-campaign",
          idempotencyKey,
        },
        spend,
        async () => {
          adapterRan.value = true;
          return { actualSpendMinor: 5_000 };
        },
      );
      return "unexpectedly_allowed";
    } catch (error) {
      return error instanceof PaidTestError ? error.code : "unknown_error";
    }
  };

  // (a) Not yet approved by a human.
  const paidBlockedWithoutApproval = await attemptPaid("grant_missing", "fixture-unapproved");

  // 23. Human approval.
  const approved = paid.decide(proposal.proposalId, {
    kind: "approve_exact",
    decidedBy: "fixture-founder@example.com",
    approvalRef: "fixture:checkpoint:paid-001",
  });

  // (b) Approved, but nobody minted a Spend Grant. Approval alone moves nothing.
  const paidBlockedWithoutGrant = await attemptPaid("grant_missing", "fixture-no-grant");
  if (adapterRan.value) {
    throw new Error("fixture invariant broken: the provider adapter ran without a Spend Grant");
  }

  // 24-25. Spend Grant and transactional reservation.
  const grant = spend.registerGrant(paid.grantInputFor(approved));
  creatives.recordStatus(variant.creativeId, "tiktok_paid", "PAID_TEST_PROPOSED");
  creatives.recordStatus(variant.creativeId, "tiktok_paid", "PAID_TEST_APPROVED");

  // 26-28. Synthetic Spark Ad, read back, settled at reported spend.
  const settled = await paid.executePaidOperation(
    {
      proposalId: approved.proposalId,
      grantId: grant.grantId,
      creativeId: variant.creativeId,
      network: "tiktok_paid",
      adAccountId: "fixture-tt-ads",
      objective: "conversions",
      amountMinorUnits: 5_000,
      campaignId: "fixture-campaign",
      idempotencyKey: "fixture-spark-ad-1",
    },
    spend,
    async () => {
      creatives.mapProviderObject({
        creativeId: variant.creativeId,
        deliveryVariantId: delivery.deliveryVariantId,
        provider: "tiktok_ads",
        objectKind: "spark_ad",
        externalId: "fixture-spark-ad",
        externalAccountId: "fixture-tt-ads",
        ventureId,
      });
      return { actualSpendMinor: 4_650 };
    },
  );
  creatives.recordStatus(variant.creativeId, "tiktok_paid", "PAID_TEST_RUNNING");

  // 29. Duplicate and out-of-order subscription events.
  const subscriptions = createSubscriptionIngestor({
    environment: "production",
    revenueCatProject: "fixture-rc-project",
    now: at,
  });
  const base: SubscriptionEvent = {
    providerEventId: "fixture-purchase",
    type: "INITIAL_PURCHASE",
    environment: "production",
    subscriberId: "fixture-sub-1",
    productId: "monthly",
    entitlementId: "pro",
    currency: options.contract.economics.currency,
    revenueMinor: options.contract.economics.subscription_price_minor,
    occurredAt: "2026-08-09T10:00:00.000Z",
    receivedAt: "2026-08-09T10:00:10.000Z",
    rawReference: "fixtures/winner-loop/revenuecat-purchase.json",
  };
  // The renewal is delivered first, before the purchase it depends on.
  subscriptions.ingest({
    ...base,
    providerEventId: "fixture-renewal",
    type: "RENEWAL",
    occurredAt: "2026-08-09T11:30:00.000Z",
    receivedAt: "2026-08-09T10:00:00.000Z",
  });
  subscriptions.ingest(base);
  const duplicate = subscriptions.ingest(base);
  const state = subscriptions.stateOf("fixture-sub-1");

  // 30-31. Attribution and cohorts.
  const attribution = createAttributionLedger({
    ventureId,
    now: at,
    randomBytes: deterministicRandom,
  });
  attribution.record({
    ventureId,
    creativeId: variant.creativeId,
    creativeFamilyId: variant.creativeFamilyId,
    deliveryVariantId: delivery.deliveryVariantId,
    organicPostId: "fixture-tt-post",
    campaignId: "fixture-campaign",
    adGroupId: "fixture-adgroup",
    adId: "fixture-spark-ad",
    subscriberRef: "fixture-sub-1",
    transactionRef: "fixture-tx-1",
    evidence: { clickId: "fixture-ttclid-1", attributionProvider: "fixture-mmp" },
    reportingWindowStart: "2026-08-09T00:00:00.000Z",
    reportingWindowEnd: "2026-08-09T12:00:00.000Z",
    conversionWindowHours: 168,
    sourceTime: "2026-08-09T10:00:00.000Z",
    fetchedAt: "2026-08-09T12:00:00.000Z",
    mappingVersion: "fixture-map-v1",
  });

  const cohorts = DEFAULT_COHORT_WINDOWS.map((window) =>
    subscriptions.cohort({
      creativeId: variant.creativeId,
      creativeFamilyId: variant.creativeFamilyId,
      subscriberIds: ["fixture-sub-1"],
      cohortStart: "2026-08-09T00:00:00.000Z",
      window,
      attribution,
      attributionProvider: "fixture-mmp",
      spendMinor: settled.settledMinorUnits,
      impressions: 120_000,
      clicks: 900,
      installs: null,
      currency: options.contract.economics.currency,
    }),
  );

  // 32-33. Final recommendation and the DistributionPR learning.
  const learning = buildLearning({
    learningId: mint("learn"),
    ventureId,
    evaluation,
    cohorts,
    hypothesis: "A founder-led proof hook converts affiliates who distrust dashboards.",
    provider: "tiktok_content",
    externalAccountId: "fixture-tt-account",
    organicWindow: { start: "2026-08-09T09:00:00.000Z", end: "2026-08-09T12:00:00.000Z" },
    paidWindow: { start: "2026-08-09T12:00:00.000Z", end: "2026-08-16T00:00:00.000Z" },
    createdAt: at().toISOString(),
  });

  return Object.freeze({
    label: FIXTURE_LABEL,
    ventureId,
    creativeId: variant.creativeId,
    deliveryVariantId: delivery.deliveryVariantId,
    lineage: creatives.lineageOf(variant.creativeId),
    snapshots: snapshots.length,
    evaluation,
    readiness,
    paidBlockedWithoutApproval,
    paidBlockedWithoutGrant,
    proposalId: approved.proposalId,
    grantId: grant.grantId,
    settledSpendMinor: settled.settledMinorUnits ?? 0,
    duplicateEventRejected: duplicate.kind === "duplicate",
    outOfOrderHandled: state.firstPurchaseAt === "2026-08-09T10:00:00.000Z" && state.renewals === 1,
    cohorts,
    learning,
    providerObjects: creatives.listProviderObjects(variant.creativeId).map((entry) => ({
      provider: entry.provider,
      objectKind: entry.objectKind,
      externalId: entry.externalId,
    })),
  });
}

/** The trace artifact: everything connected to one creative id. */
export function buildCreativeTrace(result: FixtureDResult) {
  return {
    label: result.label,
    generatedFor: result.creativeId,
    venture: result.ventureId,
    identity: {
      creativeId: result.creativeId,
      deliveryVariantId: result.deliveryVariantId,
      lineage: result.lineage,
    },
    providerObjects: result.providerObjects,
    organic: {
      snapshotsIngested: result.snapshots,
      missingMetrics: result.evaluation.missingMetrics,
    },
    evaluation: {
      recommendationId: result.evaluation.recommendationId,
      scoringVersion: result.evaluation.scoringVersion,
      score: result.evaluation.score,
      confidence: result.evaluation.confidence,
      recommendation: result.evaluation.recommendation,
      spendEligible: result.evaluation.spendEligible,
    },
    readiness: {
      stage: result.readiness.stage,
      recommendedOptimizationEvent: result.readiness.recommendedOptimizationEvent,
      vboAllowed: result.readiness.vboAllowed,
      blockers: result.readiness.blockers,
    },
    paid: {
      blockedWithoutApproval: result.paidBlockedWithoutApproval,
      blockedWithoutGrant: result.paidBlockedWithoutGrant,
      proposalId: result.proposalId,
      grantId: result.grantId,
      settledSpendMinor: result.settledSpendMinor,
    },
    subscriptions: {
      duplicateEventRejected: result.duplicateEventRejected,
      outOfOrderHandled: result.outOfOrderHandled,
    },
    cohorts: result.cohorts.map((cohort) => ({
      window: cohort.window.label,
      attributionClass: cohort.attributionClass,
      creativeLevelCertainty: cohort.creativeLevelCertainty,
      cacMinor: cohort.metrics.cacMinor,
      netRevenueMinor: cohort.metrics.netRevenueMinor,
      missingData: cohort.missingData,
    })),
    learning: {
      learningId: result.learning.learningId,
      recommendedSurface: result.learning.recommendedSurface,
      confidence: result.learning.confidence,
      limitations: result.learning.limitations,
    },
  };
}
