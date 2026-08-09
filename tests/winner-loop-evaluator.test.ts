import { describe, expect, it } from "vitest";
import {
  DEFAULT_READINESS_THRESHOLDS,
  DEFAULT_SCORING_CONFIG,
  assessReadiness,
  createMetricSnapshot,
  createWinnerEvaluator,
  recordMetricValue,
  type AccountBaseline,
  type EvaluationInput,
  type FormatBaseline,
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

function definition(metric: MetricId): MetricDefinition {
  return {
    definitionId: `tiktok_content:${metric}_v1`,
    metric,
    provider: "tiktok_content",
    unit: metric === "completion" || metric === "watch_time_ratio" ? "ratio" : "count",
    description: `TikTok ${metric}`,
  };
}

/** Values omitted from `present` are recorded as genuinely missing. */
function snapshot(
  present: Partial<Record<MetricId, number>>,
  options: { capturedAt?: string; offsetMinutes?: number; absent?: MetricId[] } = {},
): MetricSnapshot {
  const values = Object.entries(present).map(([metric, value]) =>
    recordMetricValue({
      metric: metric as MetricId,
      definition: definition(metric as MetricId),
      provider: "tiktok_content",
      externalAccountId: "tt-1",
      sourceObjectId: "tt-post-1",
      availability: "available",
      value,
      missingReason: null,
      reportingWindowStart: CAPTURED,
      reportingWindowEnd: options.capturedAt ?? CAPTURED,
      latencySeconds: 60,
      fetchedAt: options.capturedAt ?? CAPTURED,
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
        provider: "tiktok_content",
        externalAccountId: "tt-1",
        sourceObjectId: "tt-post-1",
        availability: "not_supported_by_provider",
        value: null,
        missingReason: "not exposed for this account type",
        reportingWindowStart: CAPTURED,
        reportingWindowEnd: options.capturedAt ?? CAPTURED,
        latencySeconds: 60,
        fetchedAt: options.capturedAt ?? CAPTURED,
        attributionWindow: null,
        confidence: "low",
        rawReference: null,
      }),
    );
  }
  return createMetricSnapshot({
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicationId: "pub-1",
    offsetMinutes: options.offsetMinutes ?? 120,
    capturedAt: options.capturedAt ?? CAPTURED,
    values,
  });
}

const baseline: AccountBaseline = {
  medianViewVelocityPerHour: 500,
  medianCompletion: 0.3,
  medianWatchTimeRatio: 0.4,
  accountAgeDays: 200,
  sampleSize: 40,
};

const formatBaseline: FormatBaseline = {
  format: "talking_head_with_screen_recording",
  medianCompletion: 0.3,
  medianWatchTimeRatio: 0.4,
};

function evaluate(overrides: Partial<EvaluationInput> = {}) {
  return createWinnerEvaluator({ now: () => AT }).evaluate({
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    creativeFamilyId: "fam-001",
    snapshots: [snapshot({ views: 20_000, view_velocity: 900, completion: 0.5 })],
    accountBaseline: baseline,
    formatBaseline,
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
      accountBaseline: {
        medianViewVelocityPerHour: null,
        medianCompletion: null,
        medianWatchTimeRatio: null,
        accountAgeDays: 3,
        sampleSize: 0,
      },
      formatBaseline: { format: "x", medianCompletion: null, medianWatchTimeRatio: null },
    });

    expect(result.confidence).not.toBe("high");
    expect(result.features.find((f) => f.feature === "viewVelocityVsBaseline")?.missingReason).toBe(
      "account has no velocity baseline yet",
    );
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
  contract_version: 1,
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
    per_creative_test_budget_minor: 10_000,
    daily_account_cap_minor: 12_000,
    daily_venture_cap_minor: 15_000,
    monthly_venture_cap_minor: 100_000,
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

  it("blocks when economics fall outside the contract guardrails", () => {
    const result = assessReadiness(contract, signals({ refundRate: 0.4, d7Retention: 0.1 }), AT);
    expect(result.blockers).toContain("economics_outside_guardrails");
    expect(result.stage).toBe("VALUE_READY");
    expect(result.vboAllowed).toBe(false);
  });
});
