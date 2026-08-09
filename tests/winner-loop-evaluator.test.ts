import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_READINESS_THRESHOLDS,
  DEFAULT_SCORING_CONFIG,
  assessReadiness,
  createBaselineEvidence,
  createBaselineEvidenceFromStore,
  createAttributionLedger,
  createMemoryWinnerLoopEvidenceStore,
  createMetricSnapshot,
  createSqliteWinnerLoopEvidenceStore,
  createTrustedLegacyTenantAdoptionMapping,
  createWinnerEvaluator,
  listMetricSnapshots,
  listBaselineEvidence,
  listWinnerEvaluations,
  recordMetricValue,
  type BaselineEvidence,
  type EvaluationInput,
  type MetricDefinition,
  type MetricId,
  type MetricSnapshot,
  type ReadinessSignals,
  type ScoringConfig,
} from "@/lib/winner-loop";
import {
  cacIsAffordable,
  netContributionPerSubscriberMinor,
  parseGrowthContract,
  type GrowthContract,
} from "@/lib/config/growth-contract-schema";

const AT = new Date("2026-08-08T12:00:00.000Z");
const CAPTURED = "2026-08-08T11:00:00.000Z";
const ORGANIZATION_ID = "org-payout-rank";

function definition(metric: MetricId): MetricDefinition {
  return {
    definitionId: `tiktok_content:${metric}_v1`,
    definitionVersion: "1",
    metric,
    provider: "tiktok_content",
    unit: metric === "completion" || metric === "watch_time_ratio" ? "ratio" : "count",
    description: `TikTok ${metric}`,
  };
}

/** Values omitted from `present` are recorded as genuinely missing. */
function snapshot(
  present: Partial<Record<MetricId, number>>,
  options: {
    organizationId?: string;
    ventureId?: string;
    creativeId?: string;
    publicationId?: string;
    provider?: "tiktok_content";
    externalAccountId?: string;
    format?: string;
    durationSeconds?: number;
    geography?: string;
    capturedAt?: string;
    offsetMinutes?: number;
    absent?: MetricId[];
  } = {},
): MetricSnapshot {
  const provider = options.provider ?? "tiktok_content";
  const externalAccountId = options.externalAccountId ?? "tt-1";
  const capturedAt = options.capturedAt ?? CAPTURED;
  const values = Object.entries(present).map(([metric, value]) =>
    recordMetricValue({
      metric: metric as MetricId,
      definition: definition(metric as MetricId),
      provider,
      externalAccountId,
      sourceObjectId: options.publicationId ?? "tt-post-1",
      availability: "available",
      value,
      missingReason: null,
      reportingWindowStart: capturedAt,
      reportingWindowEnd: capturedAt,
      sourceTime: capturedAt,
      latencySeconds: 60,
      fetchedAt: capturedAt,
      attributionWindow: null,
      confidence: "high",
      rawReference: null,
    }),
  );
  for (const metric of options.absent ?? []) {
    values.push(
      recordMetricValue({
        metric,
        definition: definition(metric),
        provider,
        externalAccountId,
        sourceObjectId: options.publicationId ?? "tt-post-1",
        availability: "not_supported_by_provider",
        value: null,
        missingReason: "not exposed for this account type",
        reportingWindowStart: CAPTURED,
        reportingWindowEnd: capturedAt,
        sourceTime: capturedAt,
        latencySeconds: 60,
        fetchedAt: capturedAt,
        attributionWindow: null,
        confidence: "low",
        rawReference: null,
      }),
    );
  }
  return createMetricSnapshot({
    organizationId: options.organizationId ?? ORGANIZATION_ID,
    ventureId: options.ventureId ?? "payout-rank",
    provider,
    externalAccountId,
    creativeId: options.creativeId ?? "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicationId: options.publicationId ?? "pub-1",
    format: options.format ?? "talking_head_with_screen_recording",
    durationSeconds: options.durationSeconds ?? 22,
    geography: options.geography ?? "NL",
    offsetMinutes: options.offsetMinutes ?? 120,
    capturedAt: options.capturedAt ?? CAPTURED,
    values,
  });
}

const baselineSources = Array.from({ length: 40 }, (_, index) =>
  snapshot(
    { view_velocity: 500, completion: 0.3, watch_time_ratio: 0.4 },
    {
      creativeId: `baseline-creative-${index}`,
      publicationId: `baseline-publication-${index}`,
      capturedAt: new Date(
        AT.getTime() - 60 * 60_000 - ((39 - index) * 29 * 86_400_000) / 39,
      ).toISOString(),
    },
  ),
);

const baseline = createBaselineEvidence({
  organizationId: ORGANIZATION_ID,
  ventureId: "payout-rank",
  provider: "tiktok_content",
  externalAccountId: "tt-1",
  format: "talking_head_with_screen_recording",
  durationSeconds: 22,
  geography: "NL",
  accountCreatedAt: new Date(AT.getTime() - 200 * 86_400_000).toISOString(),
  generatedAt: AT.toISOString(),
  sourceSnapshots: baselineSources,
});

function baselineWith(overrides: {
  organizationId?: string;
  externalAccountId?: string;
  account?: Partial<BaselineEvidence["account"]>;
  format?: Partial<BaselineEvidence["format"]>;
  duration?: Partial<BaselineEvidence["duration"]>;
}): BaselineEvidence {
  return Object.freeze({
    ...baseline,
    organizationId: overrides.organizationId ?? baseline.organizationId,
    externalAccountId: overrides.externalAccountId ?? baseline.externalAccountId,
    account: Object.freeze({ ...baseline.account, ...overrides.account }),
    format: Object.freeze({ ...baseline.format, ...overrides.format }),
    duration: Object.freeze({ ...baseline.duration, ...overrides.duration }),
  });
}

function scopedBaseline(options: {
  organizationId?: string;
  externalAccountId?: string;
  format?: string;
  durationSeconds?: number;
}): BaselineEvidence {
  const organizationId = options.organizationId ?? ORGANIZATION_ID;
  const externalAccountId = options.externalAccountId ?? "tt-1";
  const format = options.format ?? "talking_head_with_screen_recording";
  const durationSeconds = options.durationSeconds ?? 22;
  return createBaselineEvidence({
    organizationId,
    ventureId: "payout-rank",
    provider: "tiktok_content",
    externalAccountId,
    format,
    durationSeconds,
    geography: "NL",
    accountCreatedAt: new Date(AT.getTime() - 200 * 86_400_000).toISOString(),
    generatedAt: AT.toISOString(),
    sourceSnapshots: [
      snapshot(
        { view_velocity: 500, completion: 0.3, watch_time_ratio: 0.4 },
        {
          organizationId,
          externalAccountId,
          format,
          durationSeconds,
          creativeId: "opponent-baseline-creative",
          publicationId: "opponent-baseline-publication",
        },
      ),
    ],
  });
}

function evaluate(overrides: Partial<EvaluationInput> = {}) {
  return createWinnerEvaluator({
    organizationId: ORGANIZATION_ID,
    ventureId: "payout-rank",
    now: () => AT,
  }).evaluate({
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    creativeFamilyId: "fam-001",
    provider: "tiktok_content",
    externalAccountId: "tt-1",
    format: "talking_head_with_screen_recording",
    durationSeconds: 22,
    snapshots: [snapshot({ views: 20_000, view_velocity: 900, completion: 0.5 })],
    baseline,
    geography: "NL",
    evaluatedAt: AT,
    rightsApprovedForPaid: true,
    attributionHealthy: true,
    ...overrides,
  });
}

describe("winner evaluation is baseline-adjusted, not a views threshold", () => {
  it("does not recommend spend on reach alone when intent is weak", () => {
    const result = evaluate({
      snapshots: [
        snapshot({
          views: 400_000,
          view_velocity: 5_000,
          completion: 0.75,
          watch_time_ratio: 0.8,
          shares: 4_000,
          saves: 3_000,
          profile_visits: 2_000,
          outbound_clicks: 40,
          trials: 1,
        }),
      ],
    });

    expect(result.recommendation).toBe("CREATE_VARIANTS");
    expect(result.spendEligible).toBe(false);
    expect(result.spendBlockedReasons).toContain("reach_without_intent");
    expect(result.interpretation).toMatch(/not converting to intent/i);
  });

  it("recommends a paid test on moderate reach with strong downstream intent", () => {
    const result = evaluate({
      snapshots: [
        snapshot({
          views: 30_000,
          view_velocity: 800,
          completion: 0.45,
          watch_time_ratio: 0.55,
          shares: 300,
          saves: 260,
          profile_visits: 300,
          outbound_clicks: 500,
          trials: 200,
        }),
      ],
    });

    expect(result.recommendation).toBe("PAID_TEST_CANDIDATE");
    expect(result.spendEligible).toBe(true);
    expect(result.spendBlockedReasons).toEqual([]);
  });

  it("proves a 100k-view creative can lose to a 30k-view creative", () => {
    const bigReach = evaluate({
      snapshots: [
        snapshot({
          views: 150_000,
          view_velocity: 4_000,
          completion: 0.7,
          watch_time_ratio: 0.7,
          shares: 1_500,
          saves: 1_200,
          profile_visits: 800,
          outbound_clicks: 60,
          trials: 2,
        }),
      ],
    });
    const smallReach = evaluate({
      snapshots: [
        snapshot({
          views: 30_000,
          view_velocity: 800,
          completion: 0.45,
          watch_time_ratio: 0.55,
          shares: 300,
          saves: 260,
          profile_visits: 300,
          outbound_clicks: 500,
          trials: 200,
        }),
      ],
    });

    expect(bigReach.spendEligible).toBe(false);
    expect(smallReach.spendEligible).toBe(true);
  });

  it("treats missing metrics as unknown rather than zero", () => {
    const result = evaluate({
      snapshots: [
        snapshot(
          { views: 30_000, view_velocity: 900, completion: 0.5 },
          { absent: ["saves", "shares", "trials"] },
        ),
      ],
    });

    expect(result.missingMetrics).toEqual(expect.arrayContaining(["saves", "shares", "trials"]));
    expect(result.features.find((f) => f.feature === "saveRate")?.normalized).toBeNull();
    expect(result.evidence.join(" ")).toMatch(/Treated as unknown, not as zero/);
    expect(result.score).not.toBeNull();
  });

  it("lowers confidence when the account has no baseline yet", () => {
    const result = evaluate({
      baseline: baselineWith({
        account: {
          medianViewVelocityPerHour: null,
          medianCompletion: null,
          medianWatchTimeRatio: null,
          accountAgeDays: 3,
          sampleSize: 0,
          observationWindowDays: 2,
          latestSourceAt: null,
          oldestSourceAt: null,
          sourceRefs: [],
        },
        format: {
          medianCompletion: null,
          medianWatchTimeRatio: null,
          sampleSize: 0,
          observationWindowDays: 2,
          latestSourceAt: null,
          oldestSourceAt: null,
          sourceRefs: [],
        },
        duration: {
          medianCompletion: null,
          medianWatchTimeRatio: null,
          sampleSize: 0,
          observationWindowDays: 2,
          latestSourceAt: null,
          oldestSourceAt: null,
          sourceRefs: [],
        },
      }),
    });

    expect(result.confidence).not.toBe("high");
    expect(result.features.find((f) => f.feature === "viewVelocityVsBaseline")?.missingReason).toBe(
      "account has no velocity baseline yet",
    );
    expect(result.uncertainties.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "new_account",
        "insufficient_baseline_sample",
        "short_baseline_window",
      ]),
    );
    expect(result.spendEligible).toBe(false);
  });

  it("blocks spend when the baseline sample is insufficient", () => {
    const result = evaluate({
      baseline: baselineWith({
        account: { sampleSize: 3 },
        format: { sampleSize: 3 },
        duration: { sampleSize: 3 },
      }),
    });
    expect(result.confidence).toBe("low");
    expect(result.spendBlockedReasons).toContain("insufficient_baseline_sample");
    expect(result.uncertainties).toContainEqual(
      expect.objectContaining({
        code: "insufficient_baseline_sample",
        severity: "spend_blocking",
      }),
    );
  });

  it("rejects a geography-mismatched account baseline", () => {
    expect(() => evaluate({ baseline: baselineWith({ account: { geography: "US" } }) })).toThrow(
      /account geography_scope_mismatch/,
    );
  });

  it("records conflicting account and format baselines as immutable uncertainty", () => {
    const result = evaluate({
      baseline: baselineWith({
        format: { medianCompletion: 0.8, medianWatchTimeRatio: 0.9 },
      }),
    });
    expect(result.spendBlockedReasons).toContain("conflicting_baselines");
    expect(result.uncertainties).toContainEqual(
      expect.objectContaining({ code: "conflicting_baselines" }),
    );
    expect(Object.isFrozen(result.uncertainties)).toBe(true);
    expect(Object.isFrozen(result.uncertainties[0])).toBe(true);
  });

  it("refuses a confident recommendation on stale metrics", () => {
    const result = evaluate({
      snapshots: [
        snapshot(
          { views: 50_000, view_velocity: 2_000, completion: 0.6, trials: 500 },
          { capturedAt: "2026-08-01T00:00:00.000Z" },
        ),
      ],
    });

    expect(result.recommendation).toBe("GATHER_MORE_DATA");
    expect(result.confidence).toBe("low");
    expect(result.spendBlockedReasons).toContain("stale_metrics");
    expect(result.spendEligible).toBe(false);
  });

  it("asks for more data below the minimum sample", () => {
    const result = evaluate({
      snapshots: [snapshot({ views: 120, view_velocity: 40, completion: 0.5 })],
    });

    expect(result.recommendation).toBe("GATHER_MORE_DATA");
    expect(result.spendEligible).toBe(false);
  });

  it("returns NO_SIGNAL when nothing has been ingested", () => {
    const result = evaluate({ snapshots: [] });
    expect(result.recommendation).toBe("NO_SIGNAL");
    expect(result.score).toBeNull();
    expect(result.confidence).toBe("none");
  });

  it("detects fatigue from declining velocity across snapshots", () => {
    const result = evaluate({
      snapshots: [
        snapshot({ views: 20_000, view_velocity: 4_000, completion: 0.5 }, { offsetMinutes: 30 }),
        snapshot({ views: 26_000, view_velocity: 1_800, completion: 0.5 }, { offsetMinutes: 120 }),
        snapshot({ views: 28_000, view_velocity: 400, completion: 0.5 }, { offsetMinutes: 360 }),
      ],
    });

    expect(result.recommendation).toBe("FATIGUE_DETECTED");
    expect(result.proposedNextExperiment).toMatch(/new hook/i);
  });

  it("does not boost a creative performing at or below baseline", () => {
    const result = evaluate({
      snapshots: [
        snapshot({
          views: 20_000,
          view_velocity: 100,
          completion: 0.05,
          watch_time_ratio: 0.05,
          shares: 1,
          saves: 1,
          profile_visits: 1,
          outbound_clicks: 1,
          trials: 0,
        }),
      ],
    });

    expect(result.recommendation).toBe("DO_NOT_BOOST");
    expect(result.spendBlockedReasons).toContain("below_baseline");
  });
});

describe("scoring versions are immutable on historical evaluations", () => {
  it("records the scoring version that produced the result", () => {
    expect(evaluate().scoringVersion).toBe("winner-score-v1");
  });

  it("changing weights does not mutate an evaluation already produced", () => {
    const original = evaluate();
    const originalScore = original.score;

    const reweighted: ScoringConfig = {
      ...DEFAULT_SCORING_CONFIG,
      version: "winner-score-v2",
      weights: { ...DEFAULT_SCORING_CONFIG.weights, trialRate: 0.9, viewVelocityVsBaseline: 0.01 },
    };
    const second = evaluate({ scoring: reweighted });

    expect(original.score).toBe(originalScore);
    expect(original.scoringVersion).toBe("winner-score-v1");
    expect(second.scoringVersion).toBe("winner-score-v2");
    expect(Object.isFrozen(original)).toBe(true);
  });
});

// --- Growth Contract -------------------------------------------------------

const contractInput = {
  contract_version: 2,
  venture_id: "payout-rank",
  goal: {
    primary_event: "purchase",
    secondary_events: ["trial_start"],
    current_optimization_event: "trial_start",
    allowed_fallback_events: ["paywall_view", "onboarding_complete"],
  },
  economics: {
    currency: "EUR",
    subscription_price_minor: 999,
    billing_period: "monthly",
    store_fee_rate: 0.15,
    tax_rate: 0.21,
    refund_rate: 0.05,
    variable_serving_cost_minor: 40,
    creative_generation_cost_minor: 300,
    expected_subscriber_lifetime_months: 6,
    target_cac_minor: 1_500,
    hard_max_cac_minor: 2_500,
    payback_target_days: 60,
    minimum_contribution_margin_minor: 500,
    d7_retention_floor: 0.35,
    d30_retention_floor: 0.2,
    d90_retention_floor: 0.1,
    refund_rate_ceiling: 0.08,
  },
  organic: {
    allowed_providers: ["tiktok_content"],
    allowed_accounts: ["tt-account-1"],
    max_accounts: 2,
    max_posts_per_account_per_day: 3,
    duplicate_content_policy: "forbid",
    default_review_mode: "REVIEW_BEFORE_PUBLISH",
    snapshot_cadence_minutes: [30, 120, 1440],
    ai_disclosure_required: true,
  },
  paid: {
    allowed_networks: ["tiktok_paid"],
    allowed_accounts: ["tt-ads-1"],
    allowed_objectives: ["conversions"],
    allowed_events: ["trial_start", "purchase"],
    test_budget_minor: 20_000,
    per_creative_cap_minor: 10_000,
    daily_account_cap_minor: 12_000,
    daily_venture_cap_minor: 15_000,
    monthly_venture_cap_minor: 100_000,
    daily_customer_cap_minor: 12_000,
    monthly_customer_cap_minor: 80_000,
    emergency_platform_cap_minor: 250_000,
    approval_threshold_minor: 0,
    auto_pause_allowed: true,
    auto_scale_allowed: false,
    vbo_policy: "requires_value_ready",
    stop_conditions: {
      max_spend_without_trial_minor: 3_000,
      max_spend_without_purchase_minor: 8_000,
      max_cac_breach_count: 2,
    },
  },
  compliance: {
    rights_required: true,
    ai_disclosure_required: true,
    prohibited_claims: ["guaranteed income"],
    allowed_geographies: ["NL", "BE"],
    restricted_audiences: [],
    restricted_categories: [],
    provider_policy_state: "clear",
  },
  extensions: {},
};

const contract: GrowthContract = parseGrowthContract(contractInput);

describe("growth contract economics", () => {
  it("computes net contribution rather than trusting the gross price", () => {
    const net = netContributionPerSubscriberMinor(contract.economics);
    const gross = contract.economics.subscription_price_minor * 6;

    expect(net).toBeLessThan(gross);
    expect(net).toBeGreaterThan(0);
  });

  it("rejects a CAC the net contribution cannot carry", () => {
    expect(cacIsAffordable(contract.economics, 1_200)).toBe(true);
    expect(cacIsAffordable(contract.economics, 3_000)).toBe(false);
  });

  it("refuses a hard maximum CAC below the target", () => {
    expect(() =>
      parseGrowthContract({
        ...contractInput,
        economics: { ...contractInput.economics, hard_max_cac_minor: 100 },
      }),
    ).toThrow();
  });

  it("cannot express auto_scale_allowed as true", () => {
    expect(() =>
      parseGrowthContract({
        ...contractInput,
        paid: { ...contractInput.paid, auto_scale_allowed: true },
      }),
    ).toThrow();
  });

  it("keeps the total test envelope distinct from the per-creative cap", () => {
    expect(contract.paid.test_budget_minor).toBe(20_000);
    expect(contract.paid.per_creative_cap_minor).toBe(10_000);
    expect(() =>
      parseGrowthContract({
        ...contractInput,
        paid: {
          ...contractInput.paid,
          test_budget_minor: 5_000,
          per_creative_cap_minor: 10_000,
        },
      }),
    ).toThrow(/test_budget_minor/);
  });

  it("migrates the legacy conflated budget conservatively and deterministically", () => {
    const {
      test_budget_minor: _test,
      per_creative_cap_minor: _creative,
      ...legacyPaid
    } = contractInput.paid;
    void _test;
    void _creative;
    const migrated = parseGrowthContract({
      ...contractInput,
      contract_version: 1,
      paid: { ...legacyPaid, per_creative_test_budget_minor: 7_500 },
    });
    expect(migrated.contract_version).toBe(2);
    expect(migrated.paid.test_budget_minor).toBe(7_500);
    expect(migrated.paid.per_creative_cap_minor).toBe(7_500);
  });
});

// --- Readiness ladder ------------------------------------------------------

function signals(overrides: Partial<ReadinessSignals> = {}): ReadinessSignals {
  return {
    eventDeliveryRate: 0.99,
    eventDeduplicationCorrect: true,
    currencyAndValueValid: true,
    medianEventLatencySeconds: 120,
    attributionHealthy: true,
    recentHighIntentEvents: 400,
    recentPurchases: 120,
    purchasesWithValue: 120,
    refundRate: 0.02,
    d7Retention: 0.5,
    observedCacMinor: 1_200,
    providerValueOptimizationEligibility: "eligible",
    providerEligibilityCheckedAt: "2026-08-08T06:00:00.000Z",
    ...overrides,
  };
}

describe("optimization readiness ladder", () => {
  it("reaches SCALE_READY only when everything holds", () => {
    const result = assessReadiness(contract, signals(), AT);
    expect(result.stage).toBe("SCALE_READY");
    expect(result.blockers).toEqual([]);
    expect(result.scalingIsRecommendationOnly).toBe(true);
  });

  it("blocks paid scaling when attribution is unhealthy", () => {
    const result = assessReadiness(contract, signals({ attributionHealthy: false }), AT);
    expect(result.stage).toBe("TRACKING_SETUP");
    expect(result.vboAllowed).toBe(false);
    expect(result.blockers).toContain("attribution_unhealthy");
    expect(result.recommendedOptimizationEvent).toBeNull();
  });

  it("falls back to the nearest permitted high-intent event when purchases are thin", () => {
    const result = assessReadiness(contract, signals({ recentPurchases: 4 }), AT);
    expect(result.stage).toBe("HIGH_INTENT_EVENT_READY");
    expect(result.recommendedOptimizationEvent).toBe("trial_start");
    expect(result.vboAllowed).toBe(false);
  });

  it("stops at PURCHASE_READY when value data is incomplete", () => {
    const result = assessReadiness(contract, signals({ purchasesWithValue: 2 }), AT);
    expect(result.stage).toBe("PURCHASE_READY");
    expect(result.recommendedOptimizationEvent).toBe("purchase");
    expect(result.vboAllowed).toBe(false);
  });

  it("fails closed when provider eligibility is unknown or stale", () => {
    const unknown = assessReadiness(
      contract,
      signals({ providerValueOptimizationEligibility: "unknown" }),
      AT,
    );
    expect(unknown.blockers).toContain("provider_eligibility_unknown");
    expect(unknown.vboAllowed).toBe(false);
    expect(unknown.stage).toBe("VALUE_READY");

    const stale = assessReadiness(
      contract,
      signals({ providerEligibilityCheckedAt: "2026-01-01T00:00:00.000Z" }),
      AT,
      DEFAULT_READINESS_THRESHOLDS,
    );
    expect(stale.blockers).toContain("provider_eligibility_unknown");
    expect(stale.vboAllowed).toBe(false);
  });

  it("keeps VBO off when the contract forbids it, even at SCALE_READY", () => {
    const forbidding: GrowthContract = {
      ...contract,
      paid: { ...contract.paid, vbo_policy: "forbidden" },
    };
    const result = assessReadiness(forbidding, signals(), AT);
    expect(result.stage).toBe("SCALE_READY");
    expect(result.vboAllowed).toBe(false);
  });

  it("does not let an allowed policy bypass signal, tracking, attribution, or eligibility", () => {
    const allowing: GrowthContract = {
      ...contract,
      paid: { ...contract.paid, vbo_policy: "allowed" },
    };
    const result = assessReadiness(
      allowing,
      signals({
        eventDeliveryRate: 0,
        eventDeduplicationCorrect: false,
        currencyAndValueValid: false,
        medianEventLatencySeconds: 99_999,
        attributionHealthy: false,
        recentHighIntentEvents: 0,
        recentPurchases: 0,
        purchasesWithValue: 0,
        refundRate: 1,
        d7Retention: 0,
        observedCacMinor: null,
        providerValueOptimizationEligibility: "unknown",
        providerEligibilityCheckedAt: null,
      }),
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(result.stage).toBe("NO_SIGNAL");
    expect(result.vboAllowed).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "event_delivery_below_threshold",
        "event_deduplication_incorrect",
        "currency_or_value_invalid",
        "event_latency_too_high",
        "attribution_unhealthy",
      ]),
    );
  });

  it.each(["allowed", "requires_value_ready"] as const)(
    "requires fresh provider eligibility and a clean value rung for %s policy",
    (vboPolicy) => {
      const policyContract: GrowthContract = {
        ...contract,
        paid: { ...contract.paid, vbo_policy: vboPolicy },
      };

      expect(assessReadiness(policyContract, signals(), AT).vboAllowed).toBe(true);
      expect(
        assessReadiness(
          policyContract,
          signals({ providerValueOptimizationEligibility: "unknown" }),
          AT,
        ).vboAllowed,
      ).toBe(false);
      expect(
        assessReadiness(policyContract, signals({ purchasesWithValue: 2 }), AT).vboAllowed,
      ).toBe(false);
      expect(assessReadiness(policyContract, signals({ refundRate: 0.4 }), AT).vboAllowed).toBe(
        false,
      );
    },
  );

  it("blocks when economics fall outside the contract guardrails", () => {
    const result = assessReadiness(contract, signals({ refundRate: 0.4, d7Retention: 0.1 }), AT);
    expect(result.blockers).toContain("economics_outside_guardrails");
    expect(result.stage).toBe("VALUE_READY");
    expect(result.vboAllowed).toBe(false);
  });
});

describe("durable Winner Loop evidence", () => {
  it("rejects snapshots from a different organization before evaluating", () => {
    const foreignEvaluator = createWinnerEvaluator({
      organizationId: "org-foreign",
      ventureId: "payout-rank",
    });
    expect(() =>
      foreignEvaluator.evaluate({
        creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
        creativeFamilyId: "fam-001",
        provider: "tiktok_content",
        externalAccountId: "tt-1",
        format: "talking_head_with_screen_recording",
        durationSeconds: 22,
        snapshots: [snapshot({ views: 1_000 })],
        baseline,
        geography: "NL",
        evaluatedAt: AT,
      }),
    ).toThrow(/tenant_scope_mismatch/);
  });

  it("rejects tenant, account, format, and duration baseline swaps before scoring", () => {
    const opponent = scopedBaseline({
      organizationId: "org-opponent",
      externalAccountId: "tt-opponent",
    });
    expect(() => evaluate({ baseline: opponent })).toThrow(/tenant_scope_mismatch/);
    expect(() =>
      evaluate({ baseline: scopedBaseline({ externalAccountId: "tt-opponent" }) }),
    ).toThrow(/provider_account_scope_mismatch/);
    expect(() => evaluate({ baseline: scopedBaseline({ format: "opponent_format" }) })).toThrow(
      /format_scope_mismatch/,
    );
    expect(() => evaluate({ baseline: scopedBaseline({ durationSeconds: 23 }) })).toThrow(
      /duration_scope_mismatch/,
    );
  });

  it("rejects conflicting revisions for one baseline source reference", () => {
    const sourceOptions = {
      creativeId: "baseline-conflict-creative",
      publicationId: "baseline-conflict-publication",
      capturedAt: CAPTURED,
      offsetMinutes: 120,
    } as const;
    const first = snapshot({ views: 100 }, sourceOptions);
    const conflicting = snapshot({ views: 101 }, sourceOptions);
    expect(() =>
      createBaselineEvidence({
        organizationId: ORGANIZATION_ID,
        ventureId: "payout-rank",
        provider: "tiktok_content",
        externalAccountId: "tt-1",
        format: "talking_head_with_screen_recording",
        durationSeconds: 22,
        geography: "NL",
        accountCreatedAt: new Date(AT.getTime() - 200 * 86_400_000).toISOString(),
        generatedAt: AT.toISOString(),
        sourceSnapshots: [first, conflicting],
      }),
    ).toThrow(/conflicting evidence for one sourceRef/);
  });

  it("isolates identical evidence ids across organizations in memory", () => {
    const store = createMemoryWinnerLoopEvidenceStore();
    const common = {
      ventureId: "shared-venture",
      kind: "metric_snapshot" as const,
      recordId: "shared-record",
      creativeId: "shared-creative",
      occurredAt: CAPTURED,
      sourceRefs: ["provider://shared-source"],
    };
    store.put({ organizationId: "org-alpha", ...common, payload: { owner: "alpha" } });
    store.put({ organizationId: "org-bravo", ...common, payload: { owner: "bravo" } });
    expect(
      store.get(
        { organizationId: "org-alpha", ventureId: common.ventureId },
        common.kind,
        common.recordId,
      )?.payload,
    ).toEqual({ owner: "alpha" });
    expect(
      store.get(
        { organizationId: "org-bravo", ventureId: common.ventureId },
        common.kind,
        common.recordId,
      )?.payload,
    ).toEqual({ owner: "bravo" });
    store.close();
  });

  it("restores metric snapshots, evaluations, attribution, and their source lineage", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-winner-evidence-"));
    const path = join(dir, "winner-loop.db");
    const first = createSqliteWinnerLoopEvidenceStore(path);
    try {
      const original = snapshot({
        views: 30_000,
        view_velocity: 800,
        completion: 0.45,
        watch_time_ratio: 0.55,
        shares: 300,
        saves: 260,
        profile_visits: 300,
        outbound_clicks: 500,
        trials: 200,
      });
      const persisted = createMetricSnapshot(
        {
          organizationId: original.organizationId,
          ventureId: original.ventureId,
          provider: original.provider,
          externalAccountId: original.externalAccountId,
          creativeId: original.creativeId,
          publicationId: original.publicationId,
          format: original.format,
          durationSeconds: original.durationSeconds,
          geography: original.geography,
          offsetMinutes: original.offsetMinutes,
          capturedAt: original.capturedAt,
          values: original.values,
        },
        { organizationId: ORGANIZATION_ID, ventureId: "payout-rank", store: first },
      );
      const persistedBaseline = createBaselineEvidenceFromStore(
        {
          organizationId: ORGANIZATION_ID,
          ventureId: "payout-rank",
          provider: persisted.provider,
          externalAccountId: persisted.externalAccountId,
          format: persisted.format,
          durationSeconds: persisted.durationSeconds,
          geography: persisted.geography,
          accountCreatedAt: new Date(AT.getTime() - 200 * 86_400_000).toISOString(),
          generatedAt: AT.toISOString(),
        },
        { organizationId: ORGANIZATION_ID, ventureId: "payout-rank", store: first },
      );
      const evaluation = createWinnerEvaluator({
        organizationId: ORGANIZATION_ID,
        ventureId: "payout-rank",
        store: first,
      }).evaluate({
        creativeId: persisted.creativeId,
        creativeFamilyId: "fam-001",
        provider: persisted.provider,
        externalAccountId: persisted.externalAccountId,
        format: persisted.format,
        durationSeconds: persisted.durationSeconds,
        snapshots: [persisted],
        baseline: persistedBaseline,
        geography: "NL",
        evaluatedAt: AT,
        rightsApprovedForPaid: true,
        attributionHealthy: true,
      });
      const attribution = createAttributionLedger({
        organizationId: ORGANIZATION_ID,
        ventureId: "payout-rank",
        store: first,
      });
      const attributed = attribution.record({
        organizationId: ORGANIZATION_ID,
        ventureId: "payout-rank",
        creativeId: persisted.creativeId,
        creativeFamilyId: "fam-001",
        deliveryVariantId: "dv-1",
        organicPostId: "post-1",
        campaignId: "campaign-1",
        adGroupId: "group-1",
        adId: "ad-1",
        subscriberRef: "sub-opaque-1",
        transactionRef: "txn-opaque-1",
        evidence: { clickId: "click-1" },
        reportingWindowStart: CAPTURED,
        reportingWindowEnd: AT.toISOString(),
        conversionWindowHours: 24,
        sourceTime: AT.toISOString(),
        fetchedAt: AT.toISOString(),
        freshnessMaxAgeSeconds: 172_800,
        mappingVersion: "mapping-v1",
      });
      first.close();

      const reopened = createSqliteWinnerLoopEvidenceStore(path);
      try {
        const metrics = listMetricSnapshots(
          { organizationId: ORGANIZATION_ID, ventureId: "payout-rank", store: reopened },
          persisted.creativeId,
        );
        expect(metrics).toHaveLength(1);
        expect(metrics[0]!.valueOf("trials")).toBe(200);
        expect(
          listBaselineEvidence({
            organizationId: ORGANIZATION_ID,
            ventureId: "payout-rank",
            store: reopened,
          }),
        ).toEqual([persistedBaseline]);
        expect(
          listWinnerEvaluations(
            reopened,
            { organizationId: ORGANIZATION_ID, ventureId: "payout-rank" },
            persisted.creativeId,
          ),
        ).toEqual([evaluation]);
        const restoredAttribution = createAttributionLedger({
          organizationId: ORGANIZATION_ID,
          ventureId: "payout-rank",
          store: reopened,
        });
        expect(restoredAttribution.get(attributed.attributionId)).toEqual(attributed);
        expect(
          reopened.get(
            { organizationId: ORGANIZATION_ID, ventureId: "payout-rank" },
            "winner_evaluation",
            evaluation.recommendationId,
          )?.sourceRefs,
        ).toEqual([
          `baseline:${persistedBaseline.baselineId}`,
          `metric:${persisted.publicationId}:${persisted.offsetMinutes}:${persisted.capturedAt}`,
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      try {
        first.close();
      } catch {
        /* already closed before the durability read-back */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates identical evidence and creative ids across organizations in one SQLite file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-winner-evidence-tenants-"));
    const path = join(dir, "winner-loop.db");
    const alpha = createSqliteWinnerLoopEvidenceStore(path);
    const bravo = createSqliteWinnerLoopEvidenceStore(path);
    const common = {
      ventureId: "shared-venture",
      kind: "metric_snapshot" as const,
      recordId: "shared-record",
      creativeId: "shared-creative",
      occurredAt: CAPTURED,
      sourceRefs: ["provider://shared-source"],
    };
    try {
      alpha.put({ organizationId: "org-alpha", ...common, payload: { owner: "alpha" } });
      bravo.put({ organizationId: "org-bravo", ...common, payload: { owner: "bravo" } });

      const alphaScope = { organizationId: "org-alpha", ventureId: common.ventureId };
      const bravoScope = { organizationId: "org-bravo", ventureId: common.ventureId };
      expect(alpha.get(alphaScope, common.kind, common.recordId)?.payload).toEqual({
        owner: "alpha",
      });
      expect(alpha.get(bravoScope, common.kind, common.recordId)?.payload).toEqual({
        owner: "bravo",
      });
      expect(alpha.list(alphaScope, common.kind, common.creativeId)).toHaveLength(1);
      expect(bravo.list(bravoScope, common.kind, common.creativeId)).toHaveLength(1);
      expect(alpha.list(alphaScope, common.kind)[0]?.organizationId).toBe("org-alpha");
      expect(bravo.list(bravoScope, common.kind)[0]?.organizationId).toBe("org-bravo");
    } finally {
      alpha.close();
      bravo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires trusted adoption for venture-only evidence and preserves adopted replay after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-winner-evidence-legacy-"));
    const path = join(dir, "winner-loop.db");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE winner_loop_evidence (
        venture_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        creative_id TEXT,
        occurred_at TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (venture_id, kind, record_id)
      );
    `);
    raw
      .prepare("INSERT INTO winner_loop_evidence VALUES (?,?,?,?,?,?,?,?)")
      .run(
        "legacy-venture",
        "metric_snapshot",
        "legacy-record",
        "legacy-creative",
        CAPTURED,
        JSON.stringify(["legacy://source"]),
        JSON.stringify({ owner: "legacy" }),
        "pre-organization-hash",
      );
    raw.close();

    const sentinelScope = {
      organizationId: "__legacy_unscoped__",
      ventureId: "legacy-venture",
    };
    expect(() => createSqliteWinnerLoopEvidenceStore(path)).toThrowError(
      expect.objectContaining({ code: "legacy_tenant_mapping_required" }) as never,
    );
    const unchanged = new DatabaseSync(path);
    expect(
      unchanged
        .prepare("PRAGMA table_info(winner_loop_evidence)")
        .all()
        .some((column) => (column as { name: string }).name === "organization_id"),
    ).toBe(false);
    unchanged.close();

    const adoptedScope = {
      organizationId: "org-adopted",
      ventureId: "adopted-venture",
    };
    const legacyAdoption = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: AT.toISOString(),
      mappings: [{ legacyVentureId: "legacy-venture", ...adoptedScope }],
    });
    const migrated = createSqliteWinnerLoopEvidenceStore(path, { legacyAdoption });
    const record = migrated.get(adoptedScope, "metric_snapshot", "legacy-record");
    expect(record).toMatchObject({
      organizationId: adoptedScope.organizationId,
      ventureId: adoptedScope.ventureId,
      creativeId: "legacy-creative",
      payload: {
        owner: "legacy",
        organizationId: adoptedScope.organizationId,
        ventureId: adoptedScope.ventureId,
      },
    });
    expect(
      migrated.get(
        { organizationId: ORGANIZATION_ID, ventureId: "legacy-venture" },
        "metric_snapshot",
        "legacy-record",
      ),
    ).toBeUndefined();
    expect(() => migrated.get(sentinelScope, "metric_snapshot", "legacy-record")).toThrowError(
      expect.objectContaining({ code: "legacy_sentinel_scope_forbidden" }) as never,
    );
    expect(() => migrated.put(record!)).not.toThrow();
    migrated.close();

    const reopened = createSqliteWinnerLoopEvidenceStore(path);
    try {
      expect(reopened.get(adoptedScope, "metric_snapshot", "legacy-record")).toEqual(record);
      const adoptedRaw = new DatabaseSync(path);
      expect(
        adoptedRaw
          .prepare(
            `SELECT COUNT(*) AS count FROM winner_loop_evidence
             WHERE organization_id = '__legacy_unscoped__'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      adoptedRaw.close();
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts only mapped sentinel evidence into isolated organizations with idempotent restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-winner-evidence-sentinel-"));
    const path = join(dir, "winner-loop.db");
    createSqliteWinnerLoopEvidenceStore(path).close();
    const raw = new DatabaseSync(path);
    const insert = raw.prepare(
      `INSERT INTO winner_loop_evidence
       (organization_id, venture_id, kind, record_id, creative_id, occurred_at,
        source_refs_json, payload_json, content_hash)
       VALUES ('__legacy_unscoped__', ?, 'metric_snapshot', 'same-record',
        'same-creative', ?, '[]', ?, ?)`,
    );
    insert.run(
      "legacy-alpha",
      CAPTURED,
      JSON.stringify({ owner: "alpha", ventureId: "legacy-alpha" }),
      "legacy-alpha-hash",
    );
    insert.run(
      "legacy-bravo",
      CAPTURED,
      JSON.stringify({ owner: "bravo", ventureId: "legacy-bravo" }),
      "legacy-bravo-hash",
    );
    raw.close();

    expect(() => createSqliteWinnerLoopEvidenceStore(path)).toThrowError(
      expect.objectContaining({ code: "legacy_tenant_mapping_required" }) as never,
    );
    const legacyAdoption = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: AT.toISOString(),
      mappings: [
        {
          legacyVentureId: "legacy-alpha",
          organizationId: "org-alpha",
          ventureId: "shared-venture",
        },
        {
          legacyVentureId: "legacy-bravo",
          organizationId: "org-bravo",
          ventureId: "shared-venture",
        },
      ],
    });
    const adopted = createSqliteWinnerLoopEvidenceStore(path, { legacyAdoption });
    const alpha = adopted.get(
      { organizationId: "org-alpha", ventureId: "shared-venture" },
      "metric_snapshot",
      "same-record",
    );
    const bravo = adopted.get(
      { organizationId: "org-bravo", ventureId: "shared-venture" },
      "metric_snapshot",
      "same-record",
    );
    expect(alpha?.payload).toMatchObject({
      owner: "alpha",
      organizationId: "org-alpha",
      ventureId: "shared-venture",
    });
    expect(bravo?.payload).toMatchObject({
      owner: "bravo",
      organizationId: "org-bravo",
      ventureId: "shared-venture",
    });
    expect(() => adopted.put(alpha!)).not.toThrow();
    expect(() => adopted.put(bravo!)).not.toThrow();
    adopted.close();

    const restarted = createSqliteWinnerLoopEvidenceStore(path);
    try {
      expect(
        restarted.get(
          { organizationId: "org-alpha", ventureId: "shared-venture" },
          "metric_snapshot",
          "same-record",
        )?.payload,
      ).toMatchObject({ owner: "alpha" });
      expect(
        restarted.get(
          { organizationId: "org-bravo", ventureId: "shared-venture" },
          "metric_snapshot",
          "same-record",
        )?.payload,
      ).toMatchObject({ owner: "bravo" });
      const inspected = new DatabaseSync(path);
      expect(
        inspected
          .prepare(
            `SELECT COUNT(*) AS count FROM winner_loop_evidence
             WHERE organization_id = '__legacy_unscoped__'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      inspected.close();
    } finally {
      restarted.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
