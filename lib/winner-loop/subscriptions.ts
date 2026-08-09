import type { AttributionClass, AttributionLedger } from "./attribution";

/**
 * Subscription lifecycle ingestion and creative cohorts.
 *
 * Webhooks arrive late, twice, and out of order. Subscription state is therefore
 * derived from each event's own occurrence time, never from the order the
 * transport happened to deliver them — a renewal that overtakes its initial
 * purchase must not create a subscriber from nothing, and a redelivered event
 * must not double-count revenue.
 *
 * Sandbox and production are separate universes; a sandbox event that reaches a
 * production ingestor is dropped rather than mixed into real revenue.
 */

export const SUBSCRIPTION_EVENT_TYPES = [
  "INITIAL_PURCHASE",
  "TRIAL_START",
  "TRIAL_CONVERSION",
  "RENEWAL",
  "CANCELLATION",
  "EXPIRATION",
  "REFUND",
  "BILLING_ISSUE",
  "PRODUCT_CHANGE",
] as const;
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];

export type IngestEnvironment = "sandbox" | "production";

export interface SubscriptionEvent {
  providerEventId: string;
  type: SubscriptionEventType;
  environment: IngestEnvironment;
  subscriberId: string;
  productId: string;
  entitlementId: string;
  currency: string;
  /** Negative for refunds. Integer minor units. */
  revenueMinor: number;
  /** When it happened, per the provider. Ordering key. */
  occurredAt: string;
  /** When we received it. Never used for ordering. */
  receivedAt: string;
  rawReference: string | null;
}

export type IngestOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "wrong_environment" }
  | { kind: "rejected"; reason: string };

export interface SubscriberState {
  readonly subscriberId: string;
  readonly status: "none" | "trialing" | "active" | "cancelled" | "expired" | "refunded";
  readonly trialStartedAt: string | null;
  readonly firstPurchaseAt: string | null;
  readonly lastEventAt: string | null;
  readonly renewals: number;
  readonly grossRevenueMinor: number;
  readonly refundedMinor: number;
  readonly currency: string | null;
}

export interface CohortWindow {
  readonly label: string;
  readonly days: number;
}

export const DEFAULT_COHORT_WINDOWS: readonly CohortWindow[] = Object.freeze([
  Object.freeze({ label: "D0", days: 0 }),
  Object.freeze({ label: "D7", days: 7 }),
  Object.freeze({ label: "D30", days: 30 }),
]);

/** Available but not claimed as mature evidence in V1. */
export const D90_WINDOW: CohortWindow = Object.freeze({ label: "D90", days: 90 });

export interface CohortMetrics {
  readonly spendMinor: number | null;
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly installs: number | null;
  readonly trials: number;
  readonly initialSubscribers: number;
  readonly renewals: number;
  readonly cancellations: number;
  readonly refunds: number;
  readonly grossRevenueMinor: number;
  readonly netRevenueMinor: number;
  readonly activeSubscribers: number;
  readonly cacMinor: number | null;
  readonly trialToPaid: number | null;
  readonly roas: number | null;
}

export interface CohortSnapshot {
  readonly creativeId: string;
  readonly creativeFamilyId: string | null;
  readonly window: CohortWindow;
  readonly metrics: CohortMetrics;
  readonly attributionClass: AttributionClass;
  readonly attributionProvider: string | null;
  readonly attributionConfidence: string;
  readonly creativeLevelCertainty: boolean;
  readonly reportingWindowStart: string;
  readonly reportingWindowEnd: string;
  readonly revenueCatProject: string;
  readonly currency: string;
  readonly revenueDefinition: "net_of_refunds_gross_of_store_fees";
  readonly missingData: readonly string[];
  readonly freshnessSeconds: number;
  readonly limitations: readonly string[];
}

export interface SubscriptionIngestorOptions {
  environment: IngestEnvironment;
  revenueCatProject: string;
  now?: () => Date;
}

export function createSubscriptionIngestor(options: SubscriptionIngestorOptions) {
  const now = options.now ?? (() => new Date());
  const seen = new Set<string>();
  const events: SubscriptionEvent[] = [];

  function ingest(event: SubscriptionEvent): IngestOutcome {
    if (event.environment !== options.environment) {
      return { kind: "wrong_environment" };
    }
    if (seen.has(event.providerEventId)) {
      return { kind: "duplicate" };
    }
    if (!Number.isInteger(event.revenueMinor)) {
      return { kind: "rejected", reason: "revenue must be integer minor units" };
    }
    seen.add(event.providerEventId);
    events.push(event);
    return { kind: "accepted" };
  }

  /**
   * Rebuild state by occurrence time. Replaying the same events in any delivery
   * order yields the same result, which is what makes crash recovery safe.
   */
  function stateOf(subscriberId: string): SubscriberState {
    const ordered = events
      .filter((event) => event.subscriberId === subscriberId)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

    let status: SubscriberState["status"] = "none";
    let trialStartedAt: string | null = null;
    let firstPurchaseAt: string | null = null;
    let renewals = 0;
    let gross = 0;
    let refunded = 0;
    let currency: string | null = null;

    for (const event of ordered) {
      currency ??= event.currency;
      switch (event.type) {
        case "TRIAL_START":
          trialStartedAt ??= event.occurredAt;
          status = "trialing";
          break;
        case "INITIAL_PURCHASE":
        case "TRIAL_CONVERSION":
          firstPurchaseAt ??= event.occurredAt;
          status = "active";
          gross += event.revenueMinor;
          break;
        case "RENEWAL":
          // A renewal implies a subscription existed, even if its purchase
          // event has not been delivered yet.
          firstPurchaseAt ??= event.occurredAt;
          renewals += 1;
          status = "active";
          gross += event.revenueMinor;
          break;
        case "CANCELLATION":
          status = "cancelled";
          break;
        case "EXPIRATION":
          status = "expired";
          break;
        case "REFUND":
          refunded += Math.abs(event.revenueMinor);
          status = "refunded";
          break;
        case "BILLING_ISSUE":
        case "PRODUCT_CHANGE":
          break;
      }
    }

    return Object.freeze({
      subscriberId,
      status,
      trialStartedAt,
      firstPurchaseAt,
      lastEventAt: ordered[ordered.length - 1]?.occurredAt ?? null,
      renewals,
      grossRevenueMinor: gross,
      refundedMinor: refunded,
      currency,
    });
  }

  /**
   * Cohort a creative's subscribers. Creative-level certainty is only claimed
   * when every backing attribution record genuinely supports it; otherwise the
   * numbers are reported with their real granularity and an explicit limitation.
   */
  function cohort(input: {
    creativeId: string;
    creativeFamilyId: string | null;
    subscriberIds: readonly string[];
    cohortStart: string;
    window: CohortWindow;
    attribution: AttributionLedger;
    attributionProvider: string | null;
    spendMinor: number | null;
    impressions: number | null;
    clicks: number | null;
    installs: number | null;
    currency: string;
  }): CohortSnapshot {
    const start = Date.parse(input.cohortStart);
    const end = start + input.window.days * 86_400_000;
    const missingData: string[] = [];
    if (input.spendMinor === null) missingData.push("spend");
    if (input.impressions === null) missingData.push("impressions");
    if (input.clicks === null) missingData.push("clicks");
    if (input.installs === null) missingData.push("installs");

    const inWindow = (iso: string | null) =>
      iso !== null && Date.parse(iso) >= start && Date.parse(iso) <= end;

    const states = input.subscriberIds.map(stateOf);
    const trials = states.filter((s) => inWindow(s.trialStartedAt)).length;
    const initialSubscribers = states.filter((s) => inWindow(s.firstPurchaseAt)).length;
    const cohortEvents = events.filter(
      (event) =>
        input.subscriberIds.includes(event.subscriberId) &&
        Date.parse(event.occurredAt) >= start &&
        Date.parse(event.occurredAt) <= end,
    );
    const renewals = cohortEvents.filter((e) => e.type === "RENEWAL").length;
    const cancellations = cohortEvents.filter((e) => e.type === "CANCELLATION").length;
    const refunds = cohortEvents.filter((e) => e.type === "REFUND").length;
    const gross = cohortEvents
      .filter((e) => e.revenueMinor > 0)
      .reduce((sum, e) => sum + e.revenueMinor, 0);
    const refunded = cohortEvents
      .filter((e) => e.type === "REFUND")
      .reduce((sum, e) => sum + Math.abs(e.revenueMinor), 0);
    const net = gross - refunded;
    const active = states.filter((s) => s.status === "active" || s.status === "trialing").length;

    const creativeLevelCertainty = input.attribution.isHealthyForCreativeLevelReporting(
      input.creativeId,
    );
    const attributionClass = input.attribution.weakestClassForCreative(input.creativeId);
    const records = input.attribution.listForCreative(input.creativeId);
    const limitations = [...new Set(records.flatMap((r) => r.limitations))];
    if (!creativeLevelCertainty) {
      limitations.push(
        "Attribution does not support creative-level certainty; these figures describe the associated campaign or time window.",
      );
    }

    return Object.freeze({
      creativeId: input.creativeId,
      creativeFamilyId: input.creativeFamilyId,
      window: input.window,
      metrics: Object.freeze({
        spendMinor: input.spendMinor,
        impressions: input.impressions,
        clicks: input.clicks,
        installs: input.installs,
        trials,
        initialSubscribers,
        renewals,
        cancellations,
        refunds,
        grossRevenueMinor: gross,
        netRevenueMinor: net,
        activeSubscribers: active,
        cacMinor:
          input.spendMinor !== null && initialSubscribers > 0
            ? Math.round(input.spendMinor / initialSubscribers)
            : null,
        trialToPaid: trials > 0 ? initialSubscribers / trials : null,
        roas: input.spendMinor !== null && input.spendMinor > 0 ? net / input.spendMinor : null,
      }),
      attributionClass,
      attributionProvider: input.attributionProvider,
      attributionConfidence: records[0]?.confidence ?? "none",
      creativeLevelCertainty,
      reportingWindowStart: new Date(start).toISOString(),
      reportingWindowEnd: new Date(end).toISOString(),
      revenueCatProject: options.revenueCatProject,
      currency: input.currency,
      revenueDefinition: "net_of_refunds_gross_of_store_fees" as const,
      missingData: Object.freeze(missingData),
      freshnessSeconds: Math.max(
        0,
        Math.round(
          (now().getTime() - (Date.parse(events.at(-1)?.receivedAt ?? "") || now().getTime())) /
            1000,
        ),
      ),
      limitations: Object.freeze(limitations),
    });
  }

  return {
    ingest,
    stateOf,
    cohort,
    eventCount: () => events.length,
    hasSeen: (providerEventId: string) => seen.has(providerEventId),
  };
}

export type SubscriptionIngestor = ReturnType<typeof createSubscriptionIngestor>;
