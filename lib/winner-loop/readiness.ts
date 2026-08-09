import type { GrowthContract, OptimizationEvent } from "../config/growth-contract-schema";
import { cacIsAffordable } from "../config/growth-contract-schema";

/**
 * Optimization readiness.
 *
 * Value-based optimization is not a default. Handing a network a value signal
 * that is late, deduplicated wrong, or attributed unreliably teaches it to buy
 * the wrong people with real money, and the damage is only visible a cohort
 * later. Each rung requires the rung below it, and unknown provider eligibility
 * fails closed rather than optimistically proceeding.
 */

export const READINESS_STAGES = [
  "NO_SIGNAL",
  "TRACKING_SETUP",
  "HIGH_INTENT_EVENT_READY",
  "PURCHASE_READY",
  "VALUE_READY",
  "SCALE_READY",
] as const;
export type ReadinessStage = (typeof READINESS_STAGES)[number];

export type ProviderEligibility = "eligible" | "ineligible" | "unknown";

export interface ReadinessSignals {
  /** Share of events the provider acknowledged receiving. */
  eventDeliveryRate: number;
  eventDeduplicationCorrect: boolean;
  currencyAndValueValid: boolean;
  medianEventLatencySeconds: number;
  attributionHealthy: boolean;
  recentHighIntentEvents: number;
  recentPurchases: number;
  purchasesWithValue: number;
  refundRate: number;
  d7Retention: number;
  observedCacMinor: number | null;
  /** What the network currently reports about this account. Never hard-coded. */
  providerValueOptimizationEligibility: ProviderEligibility;
  providerEligibilityCheckedAt: string | null;
}

export interface ReadinessThresholds {
  minimumEventDeliveryRate: number;
  maximumEventLatencySeconds: number;
  minimumHighIntentEvents: number;
  minimumPurchases: number;
  minimumPurchasesWithValue: number;
  /** How stale a provider eligibility check may be before it counts as unknown. */
  eligibilityFreshnessHours: number;
}

export const DEFAULT_READINESS_THRESHOLDS: ReadinessThresholds = Object.freeze({
  minimumEventDeliveryRate: 0.95,
  maximumEventLatencySeconds: 900,
  minimumHighIntentEvents: 50,
  minimumPurchases: 30,
  minimumPurchasesWithValue: 30,
  eligibilityFreshnessHours: 168,
});

export interface ReadinessAssessment {
  readonly stage: ReadinessStage;
  readonly recommendedOptimizationEvent: OptimizationEvent | null;
  readonly vboAllowed: boolean;
  readonly scalingIsRecommendationOnly: true;
  readonly blockers: readonly string[];
  readonly evidence: readonly string[];
  readonly assessedAt: string;
}

export function assessReadiness(
  contract: GrowthContract,
  signals: ReadinessSignals,
  at: Date,
  thresholds: ReadinessThresholds = DEFAULT_READINESS_THRESHOLDS,
): ReadinessAssessment {
  const blockers: string[] = [];
  const evidence: string[] = [];

  const trackingHealthy =
    signals.eventDeliveryRate >= thresholds.minimumEventDeliveryRate &&
    signals.eventDeduplicationCorrect &&
    signals.currencyAndValueValid &&
    signals.medianEventLatencySeconds <= thresholds.maximumEventLatencySeconds;

  if (signals.eventDeliveryRate < thresholds.minimumEventDeliveryRate) {
    blockers.push("event_delivery_below_threshold");
  }
  if (!signals.eventDeduplicationCorrect) blockers.push("event_deduplication_incorrect");
  if (!signals.currencyAndValueValid) blockers.push("currency_or_value_invalid");
  if (signals.medianEventLatencySeconds > thresholds.maximumEventLatencySeconds) {
    blockers.push("event_latency_too_high");
  }
  if (!signals.attributionHealthy) blockers.push("attribution_unhealthy");

  // Provider eligibility is only as good as its freshness.
  let eligibility = signals.providerValueOptimizationEligibility;
  if (signals.providerEligibilityCheckedAt === null) {
    eligibility = "unknown";
  } else {
    const ageHours = (at.getTime() - Date.parse(signals.providerEligibilityCheckedAt)) / 3_600_000;
    if (ageHours > thresholds.eligibilityFreshnessHours) {
      eligibility = "unknown";
      evidence.push(
        `Provider eligibility was last checked ${Math.round(ageHours)}h ago; treating as unknown.`,
      );
    }
  }

  const nearestPermittedHighIntent = pickPermitted(contract, [
    "trial_start",
    "paywall_view",
    "onboarding_complete",
    "install",
  ]);

  let stage: ReadinessStage = "NO_SIGNAL";
  let recommended: OptimizationEvent | null = null;

  if (!trackingHealthy) {
    stage = signals.eventDeliveryRate > 0 ? "TRACKING_SETUP" : "NO_SIGNAL";
    recommended = null;
    evidence.push("Tracking is not healthy enough to optimise against any event.");
  } else if (!signals.attributionHealthy) {
    // Tracking works, but we cannot tell which campaign caused what.
    stage = "TRACKING_SETUP";
    recommended = null;
    evidence.push("Attribution is unhealthy, so no paid scaling is recommended.");
  } else if (signals.recentPurchases < thresholds.minimumPurchases) {
    if (signals.recentHighIntentEvents >= thresholds.minimumHighIntentEvents) {
      stage = "HIGH_INTENT_EVENT_READY";
      recommended = nearestPermittedHighIntent;
      evidence.push(
        `Only ${signals.recentPurchases} purchases; optimising toward the nearest permitted high-intent event instead.`,
      );
      if (recommended === null) blockers.push("no_permitted_high_intent_event");
    } else {
      stage = "TRACKING_SETUP";
      recommended = null;
      blockers.push("insufficient_conversion_volume");
    }
  } else if (signals.purchasesWithValue < thresholds.minimumPurchasesWithValue) {
    stage = "PURCHASE_READY";
    recommended = pickPermitted(contract, ["purchase", "subscription_active"]);
    evidence.push("Purchase volume is sufficient but value data is incomplete.");
  } else {
    stage = "VALUE_READY";
    recommended = pickPermitted(contract, ["purchase", "subscription_active"]);
    evidence.push("Purchase and value data are both sufficient.");

    const economicsHealthy =
      signals.refundRate <= contract.economics.refund_rate_ceiling &&
      signals.d7Retention >= contract.economics.d7_retention_floor &&
      (signals.observedCacMinor === null ||
        cacIsAffordable(contract.economics, signals.observedCacMinor));

    if (!economicsHealthy) blockers.push("economics_outside_guardrails");
    if (eligibility === "unknown") blockers.push("provider_eligibility_unknown");
    if (eligibility === "ineligible") blockers.push("provider_ineligible_for_value_optimization");

    if (economicsHealthy && eligibility === "eligible") {
      stage = "SCALE_READY";
      evidence.push("Economics are inside guardrails and the provider reports eligibility.");
    }
  }

  // VBO requires the contract to permit it, the value rung, and a live eligible
  // provider answer. Reaching VALUE_READY does not itself switch it on.
  const vboAllowed =
    contract.paid.vbo_policy !== "forbidden" &&
    (stage === "VALUE_READY" || stage === "SCALE_READY") &&
    eligibility === "eligible" &&
    blockers.length === 0;

  if (!vboAllowed && contract.paid.vbo_policy !== "forbidden") {
    evidence.push("Value-based optimisation stays off until its preconditions all hold.");
  }

  return Object.freeze({
    stage,
    recommendedOptimizationEvent: recommended,
    vboAllowed,
    scalingIsRecommendationOnly: true as const,
    blockers: Object.freeze([...new Set(blockers)]),
    evidence: Object.freeze(evidence),
    assessedAt: at.toISOString(),
  });
}

function pickPermitted(
  contract: GrowthContract,
  preference: readonly OptimizationEvent[],
): OptimizationEvent | null {
  const permitted = new Set<OptimizationEvent>([
    ...contract.paid.allowed_events,
    ...contract.goal.allowed_fallback_events,
  ]);
  return preference.find((event) => permitted.has(event)) ?? null;
}
