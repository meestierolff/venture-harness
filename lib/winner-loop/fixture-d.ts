import { createAttributionLedger } from "./attribution";
import { createBaselineEvidence, type BaselineEvidence } from "./baseline";
import { createCreativeLedger } from "./creative-ledger";
import type { CreativeLedgerStore } from "./creative-ledger-store";
import {
  assessCreativeCompliance,
  createMemoryCreativeManifestStore,
  type CreativeManifestStore,
} from "./creative-manifest";
import { createWinnerEvaluator } from "./evaluator";
import type { WinnerLoopEvidenceStore } from "./evidence-store";
import { createIdFactory } from "./ids";
import { buildLearning, type WinnerLoopLearning } from "./learnings";
import {
  createMetricSnapshot,
  recordMetricValue,
  type MetricId,
  type MetricSnapshot,
} from "./metrics";
import { createPaidTestService, PaidTestError } from "./paid-test";
import type { PaidTestStore } from "./paid-test-store";
import { assessReadiness, type ReadinessAssessment } from "./readiness";
import { createSpendLedger } from "./spend";
import type { SpendStore } from "./spend-store";
import type { SubscriptionEventStore } from "./subscription-store";
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

export const FIXTURE_D_STEPS = [
  "create_venture",
  "install_winner_loop",
  "load_growth_contract",
  "connect_synthetic_tiktok",
  "connect_synthetic_creative_provider",
  "connect_synthetic_attribution_provider",
  "connect_synthetic_revenuecat",
  "create_hypothesis",
  "create_family_and_variants",
  "mint_creative_ids",
  "render",
  "reconcile_render_result",
  "approve_rights",
  "create_organic_draft",
  "approve_organic_publication",
  "publish_fixture_post",
  "ingest_metric_snapshots",
  "preserve_missing_metrics",
  "compute_baselines",
  "evaluate_creative",
  "create_paid_proposal",
  "prove_spend_grant_required",
  "approve_exact_proposal",
  "create_spend_grant",
  "reserve_spend_transactionally",
  "create_spark_ad_fixture",
  "reconcile_paid_result",
  "ingest_paid_metrics",
  "ingest_revenuecat_events",
  "compute_cohorts",
  "classify_attribution",
  "generate_final_recommendation",
  "emit_distributionpr_learning",
  "trace_creative_lineage",
] as const;

export type FixtureDStepName = (typeof FIXTURE_D_STEPS)[number];

export interface FixtureDStepEvidence {
  step: number;
  name: FixtureDStepName;
  occurredAt: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface FixtureDResult {
  readonly label: string;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly creativeId: string;
  readonly deliveryVariantId: string;
  readonly lineage: readonly string[];
  readonly snapshots: number;
  readonly baseline: BaselineEvidence;
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
  readonly steps: readonly FixtureDStepEvidence[];
}

export type FixtureDProviderFeature =
  | "creative_render"
  | "organic_create_draft"
  | "organic_publish_direct"
  | "paid_promote_existing_post_contract"
  | "attribution_read_aggregates"
  | "subscription_read_lifecycle";

export interface FixtureDProviderOperation {
  readonly feature: FixtureDProviderFeature;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface FixtureDProviderOperationResult {
  readonly providerId: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly readBackVerified: true;
}

/**
 * The production-boundary runner supplies this adapter. The lower-level domain
 * fixture keeps a deterministic fallback for focused domain tests, but never
 * uses that fallback as evidence that the package SDK was traversed.
 */
export interface FixtureDProviderBoundary {
  doctor(feature: FixtureDProviderFeature): Promise<"ready">;
  execute(operation: FixtureDProviderOperation): Promise<FixtureDProviderOperationResult>;
}

export interface FixtureDBootstrapEvidence {
  readonly ventureMaterialized: true;
  readonly materializedFiles: number;
  readonly materializationPlanDigest: string;
  readonly packStatus: "installed" | "already_installed";
  readonly packVersion: string;
}

function metric(
  metricId: MetricId,
  value: number | null,
  capturedAt: string,
  missingReason: string | null = null,
  sourceObjectId = "fixture-tt-post",
) {
  return recordMetricValue({
    metric: metricId,
    definition: {
      definitionId: `tiktok_content:${metricId}_v1`,
      definitionVersion: "1",
      metric: metricId,
      provider: "tiktok_content",
      unit: metricId === "completion" || metricId === "watch_time_ratio" ? "ratio" : "count",
      description: `TikTok ${metricId}`,
    },
    provider: "tiktok_content",
    externalAccountId: "fixture-tt-account",
    sourceObjectId,
    availability: value === null ? "not_supported_by_provider" : "available",
    value,
    missingReason: value === null ? (missingReason ?? "not exposed for this account type") : null,
    reportingWindowStart: capturedAt,
    reportingWindowEnd: capturedAt,
    sourceTime: capturedAt,
    latencySeconds: 60,
    fetchedAt: capturedAt,
    attributionWindow: null,
    confidence: value === null ? "low" : "high",
    rawReference: `fixtures/winner-loop/${metricId}.json`,
  });
}

export interface FixtureDOptions {
  organizationId: string;
  contract: GrowthContract;
  store: SpendStore;
  creativeLedgerStore?: CreativeLedgerStore;
  manifestStore?: CreativeManifestStore;
  paidTestStore?: PaidTestStore;
  evidenceStore?: WinnerLoopEvidenceStore;
  subscriptionStore?: SubscriptionEventStore;
  providerBoundary?: FixtureDProviderBoundary;
  bootstrapEvidence?: FixtureDBootstrapEvidence;
  baselineSourceSnapshots?: readonly MetricSnapshot[];
  recordStep?: (evidence: FixtureDStepEvidence) => Promise<void> | void;
  now?: () => Date;
}

function requiredString(
  output: Readonly<Record<string, unknown>>,
  field: string,
  feature: FixtureDProviderFeature,
): string {
  const value = output[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`fixture provider ${feature} returned no verified ${field}`);
  }
  return value;
}

function requiredInteger(
  output: Readonly<Record<string, unknown>>,
  field: string,
  feature: FixtureDProviderFeature,
): number {
  const value = output[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`fixture provider ${feature} returned an invalid ${field}`);
  }
  return value;
}

function domainFallbackProvider(
  operation: FixtureDProviderOperation,
): FixtureDProviderOperationResult {
  const suffix = operation.operationId.replace(/[^a-z0-9-]/giu, "-").toLowerCase();
  const common = { fixture_only: true };
  const output: Readonly<Record<string, unknown>> =
    operation.feature === "creative_render"
      ? { ...common, render_job_id: `${suffix}-render`, asset_ref: `fixture://${suffix}/asset` }
      : operation.feature === "organic_create_draft"
        ? { ...common, publication_id: `${suffix}-draft`, publication_mode: "draft" }
        : operation.feature === "organic_publish_direct"
          ? { ...common, publication_id: `${suffix}-post`, publication_mode: "direct" }
          : operation.feature === "paid_promote_existing_post_contract"
            ? {
                ...common,
                contract_id: `${suffix}-spark`,
                fixture_reported_spend_minor: operation.payload.requested_spend_minor ?? 0,
                external_spend_minor: 0,
              }
            : operation.feature === "attribution_read_aggregates"
              ? { ...common, dataset_id: `${suffix}-attribution` }
              : { ...common, dataset_id: `${suffix}-subscriptions` };
  return { providerId: `domain_fixture_${operation.feature}`, output, readBackVerified: true };
}

/** Run the whole loop end to end and return everything needed for the trace. */
export async function runFixtureD(options: FixtureDOptions): Promise<FixtureDResult> {
  const at = options.now ?? (() => new Date("2026-08-09T12:00:00.000Z"));
  const organizationId = options.organizationId;
  if (!organizationId.trim()) throw new Error("fixture organizationId is required");
  const ventureId = options.contract.venture_id;
  const deterministicRandom = (size: number) =>
    Uint8Array.from({ length: size }, (_, index) => (index * 7 + 11) % 256);
  const mint = createIdFactory({ now: at, randomBytes: deterministicRandom });
  const manifests = options.manifestStore ?? createMemoryCreativeManifestStore();
  const executeProvider = async (
    operation: FixtureDProviderOperation,
  ): Promise<FixtureDProviderOperationResult> => {
    const result = options.providerBoundary
      ? await options.providerBoundary.execute(operation)
      : domainFallbackProvider(operation);
    if (result.readBackVerified !== true) {
      throw new Error(`fixture provider ${operation.feature} did not produce verified read-back`);
    }
    return result;
  };
  const steps: FixtureDStepEvidence[] = [];
  const record = async (
    step: number,
    details: FixtureDStepEvidence["details"] = {},
  ): Promise<void> => {
    const name = FIXTURE_D_STEPS[step - 1];
    if (!name) throw new Error(`unknown Fixture D step ${step}`);
    const evidence = Object.freeze({
      step,
      name,
      occurredAt: at().toISOString(),
      details: Object.freeze({ ...details }),
    });
    steps.push(evidence);
    await options.recordStep?.(evidence);
  };

  await record(1, {
    ventureId,
    fixture: true,
    materialized: options.bootstrapEvidence?.ventureMaterialized ?? false,
    materializedFiles: options.bootstrapEvidence?.materializedFiles ?? 0,
    materializationPlanDigest: options.bootstrapEvidence?.materializationPlanDigest ?? null,
  });
  await record(2, {
    installed: options.bootstrapEvidence?.packStatus === "installed",
    pack: "winner-loop",
    packVersion: options.bootstrapEvidence?.packVersion ?? null,
    packStatus: options.bootstrapEvidence?.packStatus ?? "domain_fixture_only",
  });
  await record(3, {
    contractVersion: options.contract.contract_version,
    ventureId: options.contract.venture_id,
  });
  const doctor = async (feature: FixtureDProviderFeature): Promise<"ready"> =>
    options.providerBoundary ? options.providerBoundary.doctor(feature) : "ready";
  await record(4, {
    provider: "synthetic_tiktok",
    connected:
      (await doctor("organic_create_draft")) === "ready" &&
      (await doctor("organic_publish_direct")) === "ready" &&
      (await doctor("paid_promote_existing_post_contract")) === "ready",
  });
  await record(5, {
    provider: "local_renderer",
    connected: (await doctor("creative_render")) === "ready",
  });
  await record(6, {
    provider: "fixture_attribution",
    connected: (await doctor("attribution_read_aggregates")) === "ready",
  });
  await record(7, {
    provider: "fixture_revenuecat",
    connected: (await doctor("subscription_read_lifecycle")) === "ready",
  });

  // 8-10. Hypothesis, family, variant, and a permanent creative id.
  const creatives = createCreativeLedger({
    organizationId,
    ventureId,
    now: at,
    randomBytes: deterministicRandom,
    store: options.creativeLedgerStore,
    authorization: {
      manifestStore: manifests,
      regionByNetwork: {
        tiktok_organic: "NL",
        tiktok_paid: "NL",
        meta_paid: "NL",
      },
      policyByNetwork: {
        tiktok_organic: {
          disclosureRequired: options.contract.organic.ai_disclosure_required,
          allowedRegions: options.contract.compliance.allowed_geographies,
          allowedChannels: ["tiktok_organic"],
          prohibitedClaims: options.contract.compliance.prohibited_claims,
        },
        tiktok_paid: {
          disclosureRequired: options.contract.compliance.ai_disclosure_required,
          allowedRegions: options.contract.compliance.allowed_geographies,
          allowedChannels: ["tiktok_paid"],
          prohibitedClaims: options.contract.compliance.prohibited_claims,
        },
        meta_paid: {
          disclosureRequired: options.contract.compliance.ai_disclosure_required,
          allowedRegions: options.contract.compliance.allowed_geographies,
          allowedChannels: ["meta_paid"],
          prohibitedClaims: options.contract.compliance.prohibited_claims,
        },
      },
    },
  });
  const variant = creatives.registerVariant({
    organizationId,
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
  await record(8, { hypothesisId: variant.hypothesisId });
  await record(9, {
    creativeFamilyId: variant.creativeFamilyId,
    variantCount: 1,
  });
  await record(10, {
    creativeId: variant.creativeId,
    fingerprintVersion: variant.contentFingerprintVersion,
  });

  // 11-12. The provider SDK result is the only source of the render identity.
  const renderExecution = await executeProvider({
    feature: "creative_render",
    operationId: "fixture-render-1",
    idempotencyKey: "fixture-render-1",
    payload: {
      creative_id: variant.creativeId,
      creative_family_id: variant.creativeFamilyId,
      hypothesis_id: variant.hypothesisId,
    },
  });
  const renderJobId = requiredString(renderExecution.output, "render_job_id", "creative_render");
  creatives.mapProviderObject({
    organizationId,
    creativeId: variant.creativeId,
    provider: "local_renderer",
    objectKind: "render_job",
    externalId: renderJobId,
    externalAccountId: "fixture-renderer",
    ventureId,
  });
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "READY_FOR_PRODUCTION");
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "RENDERING");
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "ASSET_READY");
  await record(11, {
    creativeId: variant.creativeId,
    renderJobId,
    provider: renderExecution.providerId,
  });
  await record(12, {
    renderJobId,
    reconciled: renderExecution.readBackVerified,
  });

  // 13-16. Rights review, organic draft, approved publication.
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "READY_FOR_ORGANIC_REVIEW");
  const manifest = manifests.put({
    organizationId,
    ventureId,
    creativeId: variant.creativeId,
    creativeFamilyId: variant.creativeFamilyId,
    hypothesis: "A concrete payout comparison creates qualified intent.",
    scriptVersion: "fixture-script-v1",
    promptVersion: "fixture-prompt-v1",
    storyboardRef: "fixture://storyboard/creative",
    sourceAssetIds: [],
    recordingRefs: [],
    avatarSource: null,
    voiceSource: null,
    mediaLicenses: [],
    testimonialSubjectIds: [],
    testimonialConsents: [],
    creatorIds: [],
    creatorAuthorizations: [],
    aiGenerated: true,
    disclosure: {
      required: true,
      present: true,
      text: "AI-assisted synthetic fixture creative",
      evidenceRef: "fixture://disclosure/creative",
    },
    permittedRegions: ["NL"],
    permittedChannels: ["tiktok_paid", "tiktok_organic"],
    organicApproved: true,
    paidApproved: true,
    expiresAt: "2026-08-20T00:00:00.000Z",
    claims: [],
    prohibitedClaims: [],
    truthReferences: ["fixture://product-truth"],
    reviewedBy: "fixture-rights-reviewer",
    reviewEventId: "fixture-rights-review-1",
    reviewedAt: "2026-08-08T00:00:00.000Z",
  });
  const organicAuthorization = assessCreativeCompliance(
    manifest,
    { mode: "organic", channel: "tiktok_organic", region: "NL", at: at() },
    {
      disclosureRequired: options.contract.organic.ai_disclosure_required,
      allowedRegions: options.contract.compliance.allowed_geographies,
      allowedChannels: ["tiktok_organic"],
      prohibitedClaims: options.contract.compliance.prohibited_claims,
    },
  );
  if (!organicAuthorization.allowed) {
    throw new Error(
      `fixture organic authorization failed: ${organicAuthorization.blockers.join(", ")}`,
    );
  }
  await record(13, {
    creativeId: variant.creativeId,
    manifestVersion: manifest.manifestVersion,
    rightsApproved: true,
  });
  const delivery = creatives.registerDeliveryVariant(variant.creativeId, {
    caption: "Most affiliates never check this.",
    adCopy: "",
    destinationUrl: "https://payoutrank.example/scan?utm_source=tiktok",
    privacy: "public",
    platformSettings: { duet: false, stitch: false },
  });
  const draftExecution = await executeProvider({
    feature: "organic_create_draft",
    operationId: "fixture-organic-draft-1",
    idempotencyKey: "fixture-organic-draft-1",
    payload: {
      creative_id: variant.creativeId,
      delivery_variant_id: delivery.deliveryVariantId,
      reviewed: false,
    },
  });
  const draftId = requiredString(draftExecution.output, "publication_id", "organic_create_draft");
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "ORGANIC_DRAFT");
  await record(14, {
    creativeId: variant.creativeId,
    deliveryVariantId: delivery.deliveryVariantId,
    draft: true,
    draftId,
  });
  await record(15, {
    creativeId: variant.creativeId,
    organicApproved: manifest.organicApproved,
  });
  const publicationExecution = await executeProvider({
    feature: "organic_publish_direct",
    operationId: "fixture-organic-post-1",
    idempotencyKey: "fixture-organic-post-1",
    payload: {
      creative_id: variant.creativeId,
      delivery_variant_id: delivery.deliveryVariantId,
      draft_id: draftId,
      reviewed: true,
    },
  });
  const publicationId = requiredString(
    publicationExecution.output,
    "publication_id",
    "organic_publish_direct",
  );
  creatives.recordStatus(variant.creativeId, "tiktok_organic", "ORGANIC_PUBLISHED");
  creatives.mapProviderObject({
    organizationId,
    creativeId: variant.creativeId,
    deliveryVariantId: delivery.deliveryVariantId,
    provider: "tiktok_content",
    objectKind: "organic_post",
    externalId: publicationId,
    externalAccountId: "fixture-tt-account",
    ventureId,
  });
  await record(16, {
    creativeId: variant.creativeId,
    publicationId,
    fixture: true,
  });

  // 17-18. Several snapshots, one metric genuinely missing throughout.
  const snapshots: MetricSnapshot[] = [
    { offset: 30, at: "2026-08-09T09:30:00.000Z", views: 4_000, velocity: 900, trials: 20 },
    { offset: 120, at: "2026-08-09T11:00:00.000Z", views: 18_000, velocity: 950, trials: 90 },
    { offset: 360, at: "2026-08-09T11:50:00.000Z", views: 31_000, velocity: 1_000, trials: 210 },
  ].map((step) =>
    createMetricSnapshot(
      {
        organizationId,
        ventureId,
        provider: "tiktok_content",
        externalAccountId: "fixture-tt-account",
        creativeId: variant.creativeId,
        publicationId,
        format: variant.media.format,
        durationSeconds: variant.media.durationSeconds,
        geography: "NL",
        offsetMinutes: step.offset,
        capturedAt: step.at,
        values: [
          metric("views", step.views, step.at, null, publicationId),
          metric("view_velocity", step.velocity, step.at, null, publicationId),
          metric("completion", 0.46, step.at, null, publicationId),
          metric("watch_time_ratio", 0.58, step.at, null, publicationId),
          metric("shares", Math.round(step.views * 0.012), step.at, null, publicationId),
          metric("profile_visits", Math.round(step.views * 0.011), step.at, null, publicationId),
          metric("outbound_clicks", Math.round(step.views * 0.017), step.at, null, publicationId),
          metric("trials", step.trials, step.at, null, publicationId),
          // Deliberately absent: proves missing stays missing through scoring.
          metric(
            "saves",
            null,
            step.at,
            "saves are not exposed for this account type",
            publicationId,
          ),
        ],
      },
      options.evidenceStore
        ? { organizationId, ventureId, store: options.evidenceStore }
        : undefined,
    ),
  );
  await record(17, {
    creativeId: variant.creativeId,
    snapshots: snapshots.length,
  });
  await record(18, {
    creativeId: variant.creativeId,
    missingMetric: "saves",
    preservedAsNull: snapshots.every((snapshot) => snapshot.valueOf("saves") === null),
  });

  // 19-20. Baseline-adjusted evaluation. The fixture history remains synthetic,
  // but the baseline is calculated by the production evidence path rather than
  // injected as trusted constants.
  const baselineGeneratedAt = at();
  const baselineSourceSnapshots =
    options.baselineSourceSnapshots ??
    Array.from({ length: 40 }, (_, index) => {
      const capturedAt = new Date(
        baselineGeneratedAt.getTime() - 60 * 60_000 - ((39 - index) * 29 * 86_400_000) / 39,
      ).toISOString();
      const sourceObjectId = `fixture-baseline-post-${index + 1}`;
      return createMetricSnapshot({
        organizationId,
        ventureId,
        provider: "tiktok_content",
        externalAccountId: "fixture-tt-account",
        creativeId: `fixture-baseline-creative-${index + 1}`,
        publicationId: sourceObjectId,
        format: variant.media.format,
        durationSeconds: variant.media.durationSeconds,
        geography: "NL",
        offsetMinutes: 1_440,
        capturedAt,
        values: [
          metric("view_velocity", 500, capturedAt, null, sourceObjectId),
          metric("completion", 0.3, capturedAt, null, sourceObjectId),
          metric("watch_time_ratio", 0.4, capturedAt, null, sourceObjectId),
        ],
      });
    });
  const baseline = createBaselineEvidence(
    {
      organizationId,
      ventureId,
      provider: "tiktok_content",
      externalAccountId: "fixture-tt-account",
      format: variant.media.format,
      durationSeconds: variant.media.durationSeconds,
      geography: "NL",
      accountCreatedAt: new Date(baselineGeneratedAt.getTime() - 200 * 86_400_000).toISOString(),
      generatedAt: baselineGeneratedAt.toISOString(),
      sourceSnapshots: baselineSourceSnapshots,
    },
    options.evidenceStore ? { organizationId, ventureId, store: options.evidenceStore } : undefined,
  );
  await record(19, {
    accountBaselineSampleSize: baseline.account.sampleSize,
    formatBaselineSampleSize: baseline.format.sampleSize,
    durationBaselineSampleSize: baseline.duration.sampleSize,
    format: baseline.format.format,
    durationSeconds: baseline.duration.durationSeconds,
  });
  const evaluation = createWinnerEvaluator({
    organizationId,
    ventureId,
    store: options.evidenceStore,
    now: at,
    randomBytes: deterministicRandom,
  }).evaluate({
    creativeId: variant.creativeId,
    creativeFamilyId: variant.creativeFamilyId,
    provider: "tiktok_content",
    externalAccountId: "fixture-tt-account",
    format: variant.media.format,
    durationSeconds: variant.media.durationSeconds,
    snapshots,
    baseline,
    geography: "NL",
    evaluatedAt: at(),
    rightsApprovedForPaid: true,
    attributionHealthy: true,
  });
  await record(20, {
    creativeId: variant.creativeId,
    recommendation: evaluation.recommendation,
    score: evaluation.score,
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
  const paid = createPaidTestService({
    now: at,
    randomBytes: deterministicRandom,
    store: options.paidTestStore,
    manifestStore: manifests,
    compliancePolicy: {
      disclosureRequired: options.contract.compliance.ai_disclosure_required,
      allowedRegions: options.contract.compliance.allowed_geographies,
      allowedChannels: ["tiktok_paid"],
      prohibitedClaims: options.contract.compliance.prohibited_claims,
    },
  });
  const proposal = paid.propose({
    organizationId,
    ventureId,
    creativeId: variant.creativeId,
    deliveryVariantId: delivery.deliveryVariantId,
    organicPostId: publicationId,
    network: "tiktok_paid",
    adAccountId: "fixture-tt-ads",
    objective: "conversions",
    optimizationEvent: readiness.recommendedOptimizationEvent ?? "trial_start",
    geographies: ["NL"],
    audienceConstraints: [],
    totalBudgetMinor: Math.min(
      options.contract.paid.test_budget_minor,
      options.contract.paid.per_creative_cap_minor,
    ),
    dailyCapMinor: Math.min(
      options.contract.paid.daily_account_cap_minor,
      options.contract.paid.per_creative_cap_minor,
    ),
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
  await record(21, {
    proposalId: proposal.proposalId,
    creativeId: variant.creativeId,
    automaticallyApproved: false,
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
          organizationId,
          ventureId,
          proposalId: proposal.proposalId,
          grantId,
          creativeId: variant.creativeId,
          network: "tiktok_paid",
          adAccountId: "fixture-tt-ads",
          objective: "conversions",
          optimizationEvent: proposal.optimizationEvent,
          geography: "NL",
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
  await record(22, {
    creativeId: variant.creativeId,
    blocked: paidBlockedWithoutApproval !== "unexpectedly_allowed",
    reason: paidBlockedWithoutApproval,
  });

  // 23. Human approval.
  const approved = paid.decide(proposal, {
    kind: "approve_exact",
    decidedBy: "fixture-founder@example.com",
    approvalRef: "fixture:checkpoint:paid-001",
  });
  await record(23, {
    proposalId: approved.proposalId,
    status: approved.status,
    exactTermsApproved: true,
  });

  // (b) Approved, but nobody minted a Spend Grant. Approval alone moves nothing.
  const paidBlockedWithoutGrant = await attemptPaid("grant_missing", "fixture-no-grant");
  if (adapterRan.value) {
    throw new Error("fixture invariant broken: the provider adapter ran without a Spend Grant");
  }

  // 24-25. Spend Grant and transactional reservation.
  const grant = spend.registerGrant(
    paid.grantInputFor(approved, {
      customerId: "fixture-customer",
      dailyVentureMinorUnits: options.contract.paid.daily_venture_cap_minor,
      monthlyVentureMinorUnits: options.contract.paid.monthly_venture_cap_minor,
      dailyCustomerMinorUnits: options.contract.paid.daily_customer_cap_minor,
      monthlyCustomerMinorUnits: options.contract.paid.monthly_customer_cap_minor,
      emergencyPlatformMinorUnits: options.contract.paid.emergency_platform_cap_minor,
    }),
  );
  await record(24, {
    proposalId: approved.proposalId,
    grantId: grant.grantId,
    totalMinorUnits: grant.totalMinorUnits,
  });
  creatives.recordStatus(variant.creativeId, "tiktok_paid", "PAID_TEST_PROPOSED");
  creatives.recordStatus(variant.creativeId, "tiktok_paid", "PAID_TEST_APPROVED");

  // 26-28. Synthetic Spark Ad, read back, settled at reported spend.
  let sparkAdId = "";
  const settled = await paid.executePaidOperation(
    {
      organizationId,
      ventureId,
      proposalId: approved.proposalId,
      grantId: grant.grantId,
      creativeId: variant.creativeId,
      network: "tiktok_paid",
      adAccountId: "fixture-tt-ads",
      objective: "conversions",
      optimizationEvent: approved.optimizationEvent,
      geography: "NL",
      amountMinorUnits: 5_000,
      campaignId: "fixture-campaign",
      idempotencyKey: "fixture-spark-ad-1",
    },
    spend,
    async () => {
      await record(25, {
        grantId: grant.grantId,
        reservationHeld: true,
        amountMinorUnits: 5_000,
      });
      const sparkExecution = await executeProvider({
        feature: "paid_promote_existing_post_contract",
        operationId: "fixture-spark-ad-1",
        idempotencyKey: "fixture-spark-ad-1",
        payload: {
          creative_id: variant.creativeId,
          delivery_variant_id: delivery.deliveryVariantId,
          source_post_ref: publicationId,
          grant_id: grant.grantId,
          requested_spend_minor: 4_650,
        },
      });
      sparkAdId = requiredString(
        sparkExecution.output,
        "contract_id",
        "paid_promote_existing_post_contract",
      );
      const providerReportedSpend = requiredInteger(
        sparkExecution.output,
        "fixture_reported_spend_minor",
        "paid_promote_existing_post_contract",
      );
      creatives.mapProviderObject({
        organizationId,
        creativeId: variant.creativeId,
        deliveryVariantId: delivery.deliveryVariantId,
        provider: "tiktok_ads",
        objectKind: "spark_ad",
        externalId: sparkAdId,
        externalAccountId: "fixture-tt-ads",
        ventureId,
      });
      await record(26, {
        creativeId: variant.creativeId,
        sparkAdId,
        fixture: true,
      });
      return { actualSpendMinor: providerReportedSpend };
    },
  );
  await record(27, {
    sparkAdId,
    reconciled: true,
    settledMinorUnits: settled.settledMinorUnits,
  });
  creatives.recordStatus(variant.creativeId, "tiktok_paid", "PAID_TEST_RUNNING");
  await record(28, {
    creativeId: variant.creativeId,
    paidMetric: "spend_minor",
    value: settled.settledMinorUnits,
  });

  // 29. Duplicate and out-of-order subscription events.
  const subscriptionExecution = await executeProvider({
    feature: "subscription_read_lifecycle",
    operationId: "fixture-subscription-read-1",
    idempotencyKey: "fixture-subscription-read-1",
    payload: {
      environment: "production",
      lifecycle_event_count: 2,
      project_id: "fixture-rc-project",
    },
  });
  const subscriptionDatasetId = requiredString(
    subscriptionExecution.output,
    "dataset_id",
    "subscription_read_lifecycle",
  );
  const subscriptions = createSubscriptionIngestor({
    organizationId,
    ventureId,
    environment: "production",
    revenueCatProject: "fixture-rc-project",
    store: options.subscriptionStore,
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
    rawReference: `fixture://${subscriptionDatasetId}/revenuecat-purchase`,
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
  await record(29, {
    duplicateRejected: duplicate.kind === "duplicate",
    outOfOrderHandled: state.firstPurchaseAt === "2026-08-09T10:00:00.000Z" && state.renewals === 1,
  });

  // 30-31. Attribution and cohorts.
  const attributionExecution = await executeProvider({
    feature: "attribution_read_aggregates",
    operationId: "fixture-attribution-read-1",
    idempotencyKey: "fixture-attribution-read-1",
    payload: {
      creative_id: variant.creativeId,
      campaign_id: "fixture-campaign",
      aggregate_rows: 1,
    },
  });
  const attributionDatasetId = requiredString(
    attributionExecution.output,
    "dataset_id",
    "attribution_read_aggregates",
  );
  const attribution = createAttributionLedger({
    organizationId,
    ventureId,
    store: options.evidenceStore,
    now: at,
    randomBytes: deterministicRandom,
  });
  attribution.record({
    organizationId,
    ventureId,
    creativeId: variant.creativeId,
    creativeFamilyId: variant.creativeFamilyId,
    deliveryVariantId: delivery.deliveryVariantId,
    organicPostId: publicationId,
    campaignId: "fixture-campaign",
    adGroupId: "fixture-adgroup",
    adId: sparkAdId,
    subscriberRef: "fixture-sub-1",
    transactionRef: "fixture-tx-1",
    evidence: {
      clickId: "fixture-ttclid-1",
      attributionProvider: attributionExecution.providerId,
      privacyPostbackId: attributionDatasetId,
    },
    reportingWindowStart: "2026-08-09T00:00:00.000Z",
    reportingWindowEnd: "2026-08-09T12:00:00.000Z",
    conversionWindowHours: 168,
    sourceTime: "2026-08-09T10:00:00.000Z",
    fetchedAt: "2026-08-09T12:00:00.000Z",
    freshnessMaxAgeSeconds: 172_800,
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
      onboardingCompletions: null,
      paywallViews: null,
      currency: options.contract.economics.currency,
    }),
  );
  await record(30, {
    windows: cohorts.map((cohort) => cohort.window.label).join(","),
    cohortCount: cohorts.length,
  });
  await record(31, {
    attributionClass: cohorts[0]?.attributionClass ?? "UNKNOWN",
    creativeLevelCertainty: cohorts[0]?.creativeLevelCertainty ?? "unknown",
  });

  // 32-33. Final recommendation and the DistributionPR learning.
  const learning = buildLearning({
    learningId: mint("learn"),
    organizationId,
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
  await record(32, {
    recommendation: evaluation.recommendation,
    recommendedSurface: learning.recommendedSurface,
  });
  await record(33, {
    learningId: learning.learningId,
    confidence: learning.confidence,
    causalityClaimed: false,
  });
  await record(34, {
    creativeId: variant.creativeId,
    lineageLength: creatives.lineageOf(variant.creativeId).length,
    providerObjectCount: creatives.listProviderObjects(variant.creativeId).length,
  });

  return Object.freeze({
    label: FIXTURE_LABEL,
    organizationId,
    ventureId,
    creativeId: variant.creativeId,
    deliveryVariantId: delivery.deliveryVariantId,
    lineage: creatives.lineageOf(variant.creativeId),
    snapshots: snapshots.length,
    baseline,
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
    steps: Object.freeze([...steps]),
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
      baselineId: result.evaluation.baselineId,
      provider: result.evaluation.provider,
      externalAccountId: result.evaluation.externalAccountId,
      format: result.evaluation.format,
      durationSeconds: result.evaluation.durationSeconds,
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
    productionBoundarySteps: result.steps,
  };
}
