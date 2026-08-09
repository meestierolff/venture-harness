import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  AttributionClass,
  AttributionFreshnessStatus,
  AttributionLedger,
  AttributionRecord,
  CreativeAttributionReportingStatus,
} from "./attribution";
import { verifyRevenueCatSignedWebhook, type WebhookSecretVersion } from "../security";
import {
  createMemorySubscriptionEventStore,
  type SubscriptionEventStore,
  type SubscriptionScope,
} from "./subscription-store";

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
  /** HMAC-pseudonymized aliases only; raw App User IDs are never persisted. */
  subscriberAliases?: readonly string[];
  productId: string;
  entitlementId: string;
  /** Missing for non-revenue lifecycle notifications; never invented. */
  currency: string | null;
  /** Negative for refunds. Integer minor units. */
  revenueMinor: number;
  transactionId?: string | null;
  originalTransactionId?: string | null;
  entitlementExpiresAt?: string | null;
  gracePeriodExpiresAt?: string | null;
  cancellationReason?: string | null;
  willRenew?: boolean | null;
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
  readonly status:
    "none" | "trialing" | "active" | "cancelled" | "expired" | "refunded" | "billing_issue";
  readonly trialStartedAt: string | null;
  readonly firstPurchaseAt: string | null;
  readonly lastEventAt: string | null;
  readonly renewals: number;
  readonly grossRevenueMinor: number;
  readonly refundedMinor: number;
  readonly currency: string | null;
  readonly productId: string | null;
  readonly entitlementId: string | null;
  readonly billingIssueAt: string | null;
  readonly entitlementActive: boolean;
  readonly willRenew: boolean | null;
  readonly entitlementExpiresAt: string | null;
  readonly gracePeriodExpiresAt: string | null;
  readonly cancellationReason: string | null;
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
  readonly onboardingCompletions: number | null;
  readonly paywallViews: number | null;
  readonly trials: number;
  readonly initialSubscribers: number;
  readonly delayedConversions: number;
  readonly renewals: number;
  readonly cancellations: number;
  readonly refunds: number;
  readonly grossRevenueMinor: number;
  readonly netRevenueMinor: number;
  readonly activeSubscribers: number;
  readonly cacMinor: number | null;
  readonly trialToPaid: number | null;
  readonly installToTrial: number | null;
  readonly onboardingToTrial: number | null;
  readonly paywallViewToPaid: number | null;
  readonly delayedConversionRate: number | null;
  readonly retentionRate: number | null;
  readonly refundImpactMinor: number;
  readonly refundRate: number | null;
  readonly roas: number | null;
  readonly paybackRatio: number | null;
  readonly paybackAchieved: boolean | null;
  readonly paybackDays: number | null;
}

export interface CohortSnapshot {
  readonly organizationId: string;
  readonly ventureId: string;
  readonly creativeId: string;
  readonly creativeFamilyId: string | null;
  readonly window: CohortWindow;
  readonly metrics: CohortMetrics;
  readonly attributionClass: AttributionClass;
  readonly attributionProvider: string | null;
  readonly attributionConfidence: string;
  readonly attributionGranularity: AttributionRecord["resolvedGranularity"] | "mixed";
  readonly attributionFreshness: AttributionFreshnessStatus | "mixed";
  readonly attributionReportingStatus: CreativeAttributionReportingStatus | "mixed";
  readonly creativeLevelCertainty: boolean;
  readonly reportingWindowStart: string;
  readonly reportingWindowEnd: string;
  readonly windowMature: boolean;
  readonly revenueCatProject: string;
  readonly currency: string;
  readonly revenueDefinition: "net_of_refunds_gross_of_store_fees";
  readonly missingData: readonly string[];
  readonly freshnessSeconds: number;
  readonly limitations: readonly string[];
}

export interface SubscriptionIngestorOptions {
  organizationId: string;
  ventureId: string;
  environment: IngestEnvironment;
  revenueCatProject: string;
  store?: SubscriptionEventStore;
  now?: () => Date;
}

export function createSubscriptionIngestor(options: SubscriptionIngestorOptions) {
  if (
    !options.organizationId.trim() ||
    !options.ventureId.trim() ||
    !options.revenueCatProject.trim()
  ) {
    throw new Error("subscription organization, venture, and RevenueCat project are required");
  }
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createMemorySubscriptionEventStore();
  const scope: SubscriptionScope = {
    organizationId: options.organizationId,
    ventureId: options.ventureId,
    revenueCatProject: options.revenueCatProject,
    environment: options.environment,
  };

  const currentEvents = (): readonly SubscriptionEvent[] => store.list(scope);

  function linkedSubscriberIds(seed: string): ReadonlySet<string> {
    const linked = new Set([seed]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const event of currentEvents()) {
        const identities = new Set([event.subscriberId, ...(event.subscriberAliases ?? [])]);
        if (![...identities].some((identity) => linked.has(identity))) continue;
        for (const identity of identities) {
          if (!linked.has(identity)) {
            linked.add(identity);
            changed = true;
          }
        }
      }
    }
    return linked;
  }

  function resolvedRefundMinor(
    refund: SubscriptionEvent,
    events: readonly SubscriptionEvent[],
  ): number | null {
    if (refund.type !== "REFUND") return 0;
    if (refund.revenueMinor < 0) return Math.abs(refund.revenueMinor);
    const linkedSubscribers = linkedSubscriberIds(refund.subscriberId);
    const candidates = events
      .filter(
        (candidate) =>
          linkedSubscribers.has(candidate.subscriberId) &&
          candidate.revenueMinor > 0 &&
          Date.parse(candidate.occurredAt) <= Date.parse(refund.occurredAt) &&
          (refund.currency === null || candidate.currency === refund.currency),
      )
      .sort(
        (left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
          right.providerEventId.localeCompare(left.providerEventId),
      );
    const transactionId = refund.transactionId?.trim();
    if (transactionId) {
      const exact = candidates.filter((candidate) => candidate.transactionId === transactionId);
      if (exact.length === 1) return exact[0]!.revenueMinor;
      if (exact.length > 1) return null;
    }
    const originalTransactionId = refund.originalTransactionId?.trim();
    if (!originalTransactionId) return null;
    const original = candidates.filter(
      (candidate) => candidate.originalTransactionId === originalTransactionId,
    );
    return original.length === 1 ? original[0]!.revenueMinor : null;
  }

  function ingest(event: SubscriptionEvent): IngestOutcome {
    if (event.environment !== options.environment) {
      return { kind: "wrong_environment" };
    }
    if (
      !SUBSCRIPTION_EVENT_TYPES.includes(event.type) ||
      !event.providerEventId.trim() ||
      !event.subscriberId.trim() ||
      !event.productId.trim() ||
      !event.entitlementId.trim()
    ) {
      return { kind: "rejected", reason: "subscription event identity is incomplete" };
    }
    if (!Number.isSafeInteger(event.revenueMinor)) {
      return { kind: "rejected", reason: "revenue must be integer minor units" };
    }
    if (event.type === "REFUND" && event.revenueMinor > 0) {
      return {
        kind: "rejected",
        reason: "refund revenue must be negative or transaction-linked when the amount is absent",
      };
    }
    if (event.type !== "REFUND" && event.revenueMinor < 0) {
      return { kind: "rejected", reason: "only refund events may carry negative revenue" };
    }
    if (
      (event.currency !== null && !/^[A-Z]{3}$/.test(event.currency)) ||
      (event.revenueMinor !== 0 && event.currency === null)
    ) {
      return {
        kind: "rejected",
        reason: "revenue events require an explicit ISO currency; missing remains missing",
      };
    }
    if (
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      !Number.isFinite(Date.parse(event.receivedAt))
    ) {
      return { kind: "rejected", reason: "event timestamps must be valid ISO dates" };
    }
    const incomingIdentities = [event.subscriberId, ...(event.subscriberAliases ?? [])];
    const linkedIncomingIdentities = new Set(
      incomingIdentities.flatMap((identity) => [...linkedSubscriberIds(identity)]),
    );
    if (
      event.revenueMinor !== 0 &&
      currentEvents().some(
        (existing) =>
          linkedIncomingIdentities.has(existing.subscriberId) &&
          existing.revenueMinor !== 0 &&
          existing.currency !== event.currency,
      )
    ) {
      return { kind: "rejected", reason: "subscriber revenue currencies cannot be combined" };
    }
    const appended = store.append(scope, event);
    if (appended === "currency_conflict") {
      return { kind: "rejected", reason: "subscriber revenue currencies cannot be combined" };
    }
    return appended === "idempotency_conflict"
      ? { kind: "rejected", reason: "provider event id is bound to different content" }
      : { kind: appended };
  }

  /**
   * Rebuild state by occurrence time. Replaying the same events in any delivery
   * order yields the same result, which is what makes crash recovery safe.
   */
  function stateOfAt(subscriberId: string, beforeExclusive?: number): SubscriberState {
    const linkedSubscribers = linkedSubscriberIds(subscriberId);
    const ordered = currentEvents()
      .filter(
        (event) =>
          linkedSubscribers.has(event.subscriberId) &&
          (beforeExclusive === undefined || Date.parse(event.occurredAt) < beforeExclusive),
      )
      .sort(
        (a, b) =>
          Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
          a.providerEventId.localeCompare(b.providerEventId),
      );

    let status: SubscriberState["status"] = "none";
    let trialStartedAt: string | null = null;
    let firstPurchaseAt: string | null = null;
    let renewals = 0;
    let gross = 0;
    let refunded = 0;
    let productId: string | null = null;
    let entitlementId: string | null = null;
    let billingIssueAt: string | null = null;
    let entitlementActive = false;
    let willRenew: boolean | null = null;
    let entitlementExpiresAt: string | null = null;
    let gracePeriodExpiresAt: string | null = null;
    let cancellationReason: string | null = null;

    for (const event of ordered) {
      productId = event.productId || productId;
      entitlementId = event.entitlementId || entitlementId;
      entitlementExpiresAt = event.entitlementExpiresAt ?? entitlementExpiresAt;
      gracePeriodExpiresAt = event.gracePeriodExpiresAt ?? gracePeriodExpiresAt;
      cancellationReason = event.cancellationReason ?? cancellationReason;
      switch (event.type) {
        case "TRIAL_START":
          trialStartedAt ??= event.occurredAt;
          status = "trialing";
          entitlementActive = true;
          willRenew = event.willRenew ?? true;
          break;
        case "INITIAL_PURCHASE":
        case "TRIAL_CONVERSION":
          firstPurchaseAt ??= event.occurredAt;
          status = "active";
          entitlementActive = true;
          willRenew = event.willRenew ?? true;
          billingIssueAt = null;
          gracePeriodExpiresAt = null;
          gross += event.revenueMinor;
          break;
        case "RENEWAL":
          // A renewal implies a subscription existed, even if its purchase
          // event has not been delivered yet.
          firstPurchaseAt ??= event.occurredAt;
          renewals += 1;
          status = "active";
          entitlementActive = true;
          willRenew = event.willRenew ?? true;
          billingIssueAt = null;
          gracePeriodExpiresAt = null;
          gross += event.revenueMinor;
          break;
        case "CANCELLATION":
          willRenew = false;
          if (!entitlementActive) status = "cancelled";
          break;
        case "EXPIRATION":
          status = "expired";
          entitlementActive = false;
          willRenew = false;
          break;
        case "REFUND":
          refunded += resolvedRefundMinor(event, ordered) ?? 0;
          status = "refunded";
          willRenew = false;
          break;
        case "BILLING_ISSUE":
          if (!entitlementActive) status = "billing_issue";
          billingIssueAt = event.occurredAt;
          break;
        case "PRODUCT_CHANGE":
          break;
      }
    }

    const revenueCurrency = ordered.find((event) => event.revenueMinor !== 0)?.currency;
    const currency =
      revenueCurrency ?? ordered.find((event) => event.currency !== null)?.currency ?? null;
    const cutoff = beforeExclusive ?? now().getTime();
    const graceExpiry = gracePeriodExpiresAt === null ? null : Date.parse(gracePeriodExpiresAt);
    const entitlementExpiry =
      entitlementExpiresAt === null ? null : Date.parse(entitlementExpiresAt);
    if (
      entitlementActive &&
      ((graceExpiry !== null && Number.isFinite(graceExpiry) && graceExpiry <= cutoff) ||
        (graceExpiry === null &&
          entitlementExpiry !== null &&
          Number.isFinite(entitlementExpiry) &&
          entitlementExpiry <= cutoff))
    ) {
      entitlementActive = false;
      status = "expired";
      willRenew = false;
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
      productId,
      entitlementId,
      billingIssueAt,
      entitlementActive,
      willRenew,
      entitlementExpiresAt,
      gracePeriodExpiresAt,
      cancellationReason,
    });
  }

  function stateOf(subscriberId: string): SubscriberState {
    return stateOfAt(subscriberId);
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
    onboardingCompletions: number | null;
    paywallViews: number | null;
    currency: string;
  }): CohortSnapshot {
    if (
      input.attribution.scope.organizationId !== options.organizationId ||
      input.attribution.scope.ventureId !== options.ventureId
    ) {
      throw new Error("tenant_scope_mismatch: attribution ledger and cohort ingestor differ");
    }
    const start = Date.parse(input.cohortStart);
    if (
      !Number.isFinite(start) ||
      !Number.isSafeInteger(input.window.days) ||
      input.window.days < 0 ||
      !input.window.label.trim() ||
      !input.currency.trim()
    ) {
      throw new Error("cohort window and currency are invalid");
    }
    for (const value of [
      input.spendMinor,
      input.impressions,
      input.clicks,
      input.installs,
      input.onboardingCompletions,
      input.paywallViews,
    ]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error("cohort count and spend inputs must be non-negative integers or missing");
      }
    }
    // D0 is the first calendar-sized 24-hour bucket, not a zero-width instant.
    // All windows are half-open so an event on the boundary belongs to exactly
    // one window and cannot be double-counted.
    const end = start + Math.max(1, input.window.days + 1) * 86_400_000;
    const observationCutoff = Math.min(end, now().getTime() + 1);
    const missingData: string[] = [];
    if (input.spendMinor === null) missingData.push("spend");
    if (input.impressions === null) missingData.push("impressions");
    if (input.clicks === null) missingData.push("clicks");
    if (input.installs === null) missingData.push("installs");
    if (input.onboardingCompletions === null) missingData.push("onboarding_completions");
    if (input.paywallViews === null) missingData.push("paywall_views");

    const inWindow = (iso: string | null) =>
      iso !== null && Date.parse(iso) >= start && Date.parse(iso) < end;

    const subscriberIds = [...new Set(input.subscriberIds)];
    const subscriberGroups = new Map<string, string>();
    for (const subscriberId of subscriberIds) {
      const linked = [...linkedSubscriberIds(subscriberId)].sort();
      const identityKey = linked.join("\u0000");
      if (!subscriberGroups.has(identityKey)) subscriberGroups.set(identityKey, subscriberId);
    }
    const uniqueSubscriberIds = [...subscriberGroups.values()];
    const linkedCohortSubscriberIds = new Set(
      uniqueSubscriberIds.flatMap((subscriberId) => [...linkedSubscriberIds(subscriberId)]),
    );
    const states = uniqueSubscriberIds.map((subscriberId) =>
      stateOfAt(subscriberId, observationCutoff),
    );
    const trials = states.filter((s) => inWindow(s.trialStartedAt)).length;
    const initialSubscribers = states.filter((s) => inWindow(s.firstPurchaseAt)).length;
    const events = currentEvents();
    const cohortEvents = events.filter(
      (event) =>
        linkedCohortSubscriberIds.has(event.subscriberId) &&
        Date.parse(event.occurredAt) >= start &&
        Date.parse(event.occurredAt) < observationCutoff,
    );
    const revenueCurrencies = new Set(
      cohortEvents.flatMap((event) =>
        event.revenueMinor !== 0 && event.currency !== null ? [event.currency] : [],
      ),
    );
    if (
      revenueCurrencies.size > 1 ||
      (revenueCurrencies.size === 1 && !revenueCurrencies.has(input.currency))
    ) {
      throw new Error("cohort revenue currencies cannot be silently combined or relabelled");
    }
    const renewals = cohortEvents.filter((e) => e.type === "RENEWAL").length;
    const delayedConversions = cohortEvents.filter((e) => e.type === "TRIAL_CONVERSION").length;
    const cancellations = cohortEvents.filter((e) => e.type === "CANCELLATION").length;
    const refunds = cohortEvents.filter((e) => e.type === "REFUND").length;
    const gross = cohortEvents
      .filter((e) => e.revenueMinor > 0)
      .reduce((sum, e) => sum + e.revenueMinor, 0);
    const resolvedRefunds = cohortEvents
      .filter((event) => event.type === "REFUND")
      .map((event) => resolvedRefundMinor(event, events));
    if (resolvedRefunds.some((amount) => amount === null)) missingData.push("refund_amount");
    const refunded = resolvedRefunds.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
    const net = gross - refunded;
    const active = states.filter((state) => state.entitlementActive).length;
    const orderedRevenue = cohortEvents
      .filter((entry) => entry.revenueMinor !== 0 || entry.type === "REFUND")
      .sort(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          left.providerEventId.localeCompare(right.providerEventId),
      );
    let runningNet = 0;
    let firstPaybackAt: number | null = null;
    for (const event of orderedRevenue) {
      runningNet +=
        event.type === "REFUND" ? -(resolvedRefundMinor(event, events) ?? 0) : event.revenueMinor;
      if (
        firstPaybackAt === null &&
        input.spendMinor !== null &&
        input.spendMinor > 0 &&
        runningNet >= input.spendMinor
      ) {
        firstPaybackAt = Date.parse(event.occurredAt);
      }
    }
    const paybackAchieved =
      input.spendMinor === null ? null : input.spendMinor === 0 ? true : net >= input.spendMinor;

    const attributionClass = input.attribution.weakestClassForCreative(input.creativeId);
    const records = input.attribution.listForCreative(input.creativeId);
    if (records.some((record) => record.creativeFamilyId !== input.creativeFamilyId)) {
      throw new Error("creative_lineage_mismatch: attribution and cohort creative families differ");
    }
    const limitations = [...new Set(records.flatMap((r) => r.limitations))];
    const attributedSubscribers = new Set(
      records
        .map((record) => record.subscriberRef)
        .filter((subscriberId): subscriberId is string => subscriberId !== null),
    );
    const missingSubscriberAttribution = subscriberIds.filter(
      (subscriberId) => !attributedSubscribers.has(subscriberId),
    );
    const creativeLevelCertainty =
      input.attribution.isHealthyForCreativeLevelReporting(input.creativeId) &&
      missingSubscriberAttribution.length === 0;
    const granularity = new Set(records.map((record) => record.resolvedGranularity));
    const attributionFreshness = new Set(records.map((record) => record.freshness.status));
    const reportingStatuses = new Set(records.map((record) => record.creativeReportingStatus));
    if (missingSubscriberAttribution.length > 0) {
      limitations.push(
        `${missingSubscriberAttribution.length} cohort subscriber(s) lack a creative-linked attribution record.`,
      );
    }
    if (!creativeLevelCertainty) {
      limitations.push(
        "Attribution does not support creative-level certainty; these figures describe the associated campaign or time window.",
      );
    }
    if (now().getTime() < end) {
      limitations.push("Cohort window is not mature; later events may change this snapshot.");
    }

    return Object.freeze({
      organizationId: options.organizationId,
      ventureId: options.ventureId,
      creativeId: input.creativeId,
      creativeFamilyId: input.creativeFamilyId,
      window: input.window,
      metrics: Object.freeze({
        spendMinor: input.spendMinor,
        impressions: input.impressions,
        clicks: input.clicks,
        installs: input.installs,
        onboardingCompletions: input.onboardingCompletions,
        paywallViews: input.paywallViews,
        trials,
        initialSubscribers,
        delayedConversions,
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
        installToTrial:
          input.installs !== null && input.installs > 0 ? trials / input.installs : null,
        onboardingToTrial:
          input.onboardingCompletions !== null && input.onboardingCompletions > 0
            ? trials / input.onboardingCompletions
            : null,
        paywallViewToPaid:
          input.paywallViews !== null && input.paywallViews > 0
            ? initialSubscribers / input.paywallViews
            : null,
        delayedConversionRate: trials > 0 ? delayedConversions / trials : null,
        retentionRate: initialSubscribers > 0 ? active / initialSubscribers : null,
        refundImpactMinor: refunded,
        refundRate: gross > 0 ? refunded / gross : null,
        roas: input.spendMinor !== null && input.spendMinor > 0 ? net / input.spendMinor : null,
        paybackRatio:
          input.spendMinor !== null && input.spendMinor > 0 ? net / input.spendMinor : null,
        paybackAchieved,
        paybackDays:
          paybackAchieved === true
            ? input.spendMinor === 0
              ? 0
              : firstPaybackAt === null
                ? null
                : (firstPaybackAt - start) / 86_400_000
            : null,
      }),
      attributionClass,
      attributionProvider: input.attributionProvider,
      attributionConfidence: records.reduce<string>((weakest, record) => {
        const order = ["high", "medium", "low", "none"];
        return order.indexOf(record.confidence) > order.indexOf(weakest)
          ? record.confidence
          : weakest;
      }, records[0]?.confidence ?? "none"),
      attributionGranularity:
        granularity.size === 0 ? "none" : granularity.size === 1 ? [...granularity][0]! : "mixed",
      attributionFreshness:
        attributionFreshness.size === 0
          ? "unknown"
          : attributionFreshness.size === 1
            ? [...attributionFreshness][0]!
            : "mixed",
      attributionReportingStatus:
        reportingStatuses.size === 0
          ? "unattributed"
          : reportingStatuses.size === 1
            ? [...reportingStatuses][0]!
            : "mixed",
      creativeLevelCertainty,
      reportingWindowStart: new Date(start).toISOString(),
      reportingWindowEnd: new Date(end).toISOString(),
      windowMature: now().getTime() >= end,
      revenueCatProject: options.revenueCatProject,
      currency: input.currency,
      revenueDefinition: "net_of_refunds_gross_of_store_fees" as const,
      missingData: Object.freeze(missingData),
      freshnessSeconds: Math.max(
        0,
        Math.round(
          (now().getTime() -
            (Math.max(...cohortEvents.map((event) => Date.parse(event.receivedAt)), 0) ||
              now().getTime())) /
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
    eventCount: () => currentEvents().length,
    hasSeen: (providerEventId: string) => store.has(scope, providerEventId),
    scope: Object.freeze({ ...scope }),
    store,
  };
}

export type SubscriptionIngestor = ReturnType<typeof createSubscriptionIngestor>;

/** RevenueCat webhook API v1 payload (provider field names preserved at the boundary). */
export interface RevenueCatWebhookPayload {
  api_version: string;
  event: {
    id: string;
    type: string;
    event_timestamp_ms: number;
    app_id?: string | null;
    app_user_id: string;
    original_app_user_id?: string | null;
    aliases?: readonly string[];
    product_id: string;
    new_product_id?: string | null;
    entitlement_id?: string | null;
    entitlement_ids?: readonly string[] | null;
    environment: "SANDBOX" | "PRODUCTION";
    period_type?: "TRIAL" | "INTRO" | "NORMAL" | "PROMOTIONAL" | "PREPAID" | null;
    purchased_at_ms?: number | null;
    currency?: string | null;
    price_in_purchased_currency?: number | null;
    is_trial_conversion?: boolean | null;
    cancel_reason?: string | null;
    transaction_id?: string | null;
    original_transaction_id?: string | null;
    expiration_at_ms?: number | null;
    grace_period_expiration_at_ms?: number | null;
  };
}

export interface RevenueCatWebhookRoute {
  organizationId: string;
  ventureId: string;
  revenueCatProject: string;
  environment: IngestEnvironment;
  /** Runtime signing secret only. It is never written to an event store or error. */
  signingSecret: string;
  previousSigningSecrets?: readonly WebhookSecretVersion[];
  signingSecretValidFrom?: string;
  signingSecretValidUntil?: string;
  /** Optional dashboard-configured Authorization header, compared byte-for-byte. */
  authorizationHeader?: string;
  /** Dashboard app IDs permitted to feed this project/venture route. */
  allowedAppIds: readonly string[];
  /** Separate runtime HMAC key used to pseudonymize App User IDs before persistence. */
  subscriberHmacKey: string;
  maxAgeSeconds?: number;
  maxBodyBytes?: number;
  now?: () => Date;
  ingestor: SubscriptionIngestor;
}

export type RevenueCatWebhookOutcome =
  | IngestOutcome
  | { kind: "wrong_route" }
  | { kind: "invalid_signature" }
  | { kind: "stale_delivery" }
  | { kind: "payload_too_large" }
  | { kind: "invalid_payload"; reason: string };

export function revenueCatWebhookRouteId(
  route: Pick<
    RevenueCatWebhookRoute,
    "organizationId" | "ventureId" | "revenueCatProject" | "environment"
  >,
): string {
  return [route.organizationId, route.ventureId, route.revenueCatProject, route.environment]
    .map((value) => encodeURIComponent(value))
    .join("/");
}

function secureStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function revenueCatSubscriberRef(appUserId: string, hmacKey: string): string {
  return `rcsub_${createHmac("sha256", hmacKey).update(appUserId, "utf8").digest("hex")}`;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

function priceToMinor(price: number, currency: string): number {
  const exponent = ZERO_DECIMAL_CURRENCIES.has(currency)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(currency)
      ? 3
      : 2;
  const minor = Math.round(price * 10 ** exponent);
  if (!Number.isSafeInteger(minor)) throw new Error("RevenueCat price is outside minor-unit range");
  return minor;
}

function optionalProviderTimestamp(value: number | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`RevenueCat ${field} is invalid`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`RevenueCat ${field} is invalid`);
  return timestamp.toISOString();
}

export function mapRevenueCatWebhookPayload(
  payload: RevenueCatWebhookPayload,
  options: {
    environment: IngestEnvironment;
    allowedAppIds: readonly string[];
    subscriberHmacKey: string;
    receivedAt: string;
    rawReference: string;
  },
): SubscriptionEvent {
  if (payload.api_version !== "1.0" || !payload.event || typeof payload.event !== "object") {
    throw new Error("unsupported RevenueCat webhook API version or event shape");
  }
  const event = payload.event;
  const expectedEnvironment = options.environment === "production" ? "PRODUCTION" : "SANDBOX";
  if (event.environment !== expectedEnvironment) throw new Error("RevenueCat route mismatch");
  if (!event.app_id || !options.allowedAppIds.includes(event.app_id)) {
    throw new Error("RevenueCat route mismatch");
  }
  if (
    !event.id?.trim() ||
    !event.app_user_id?.trim() ||
    !event.product_id?.trim() ||
    !Number.isSafeInteger(event.event_timestamp_ms) ||
    options.subscriberHmacKey.length < 16
  ) {
    throw new Error("RevenueCat event identity is incomplete");
  }
  const entitlementId =
    event.entitlement_ids?.find((candidate) => candidate.trim()) ?? event.entitlement_id;
  if (!entitlementId?.trim()) throw new Error("RevenueCat entitlement identity is incomplete");

  let type: SubscriptionEventType;
  if (event.type === "INITIAL_PURCHASE") {
    type = event.period_type === "TRIAL" ? "TRIAL_START" : "INITIAL_PURCHASE";
  } else if (event.type === "RENEWAL") {
    type = event.is_trial_conversion ? "TRIAL_CONVERSION" : "RENEWAL";
  } else if (event.type === "CANCELLATION") {
    type =
      event.cancel_reason === "CUSTOMER_SUPPORT" || (event.price_in_purchased_currency ?? 0) < 0
        ? "REFUND"
        : "CANCELLATION";
  } else if (
    event.type === "EXPIRATION" ||
    event.type === "BILLING_ISSUE" ||
    event.type === "PRODUCT_CHANGE"
  ) {
    type = event.type;
  } else {
    throw new Error(`unsupported RevenueCat subscription event type: ${event.type}`);
  }

  const hasRevenue =
    type === "INITIAL_PURCHASE" ||
    type === "TRIAL_CONVERSION" ||
    type === "RENEWAL" ||
    type === "REFUND";
  const suppliedCurrency = event.currency?.trim().toUpperCase() || null;
  if (suppliedCurrency !== null && !/^[A-Z]{3}$/.test(suppliedCurrency)) {
    throw new Error("RevenueCat purchase currency is invalid");
  }
  const transactionLinkedRefund =
    type === "REFUND" &&
    event.cancel_reason === "CUSTOMER_SUPPORT" &&
    (event.price_in_purchased_currency ?? 0) === 0 &&
    Boolean(event.transaction_id?.trim() || event.original_transaction_id?.trim());
  if (
    hasRevenue &&
    !transactionLinkedRefund &&
    !Number.isFinite(event.price_in_purchased_currency)
  ) {
    throw new Error("RevenueCat revenue is missing; missing is not zero");
  }
  if (hasRevenue && suppliedCurrency === null) {
    throw new Error("RevenueCat revenue currency is missing; missing is not inferred");
  }
  const providerRevenueMinor = hasRevenue
    ? priceToMinor(event.price_in_purchased_currency ?? 0, suppliedCurrency!)
    : 0;
  const revenueMinor =
    type === "REFUND"
      ? providerRevenueMinor < 0
        ? providerRevenueMinor
        : 0
      : providerRevenueMinor;
  const occurredAtMs =
    type === "INITIAL_PURCHASE" ||
    type === "TRIAL_START" ||
    type === "TRIAL_CONVERSION" ||
    type === "RENEWAL"
      ? event.purchased_at_ms
      : event.event_timestamp_ms;
  if (typeof occurredAtMs !== "number" || !Number.isSafeInteger(occurredAtMs)) {
    throw new Error("RevenueCat event occurrence time is missing or invalid");
  }
  return Object.freeze({
    providerEventId: event.id,
    type,
    environment: options.environment,
    subscriberId: revenueCatSubscriberRef(
      event.original_app_user_id?.trim() || event.app_user_id,
      options.subscriberHmacKey,
    ),
    subscriberAliases: Object.freeze(
      [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => revenueCatSubscriberRef(value.trim(), options.subscriberHmacKey))
        .filter((value, index, values) => values.indexOf(value) === index),
    ),
    productId:
      type === "PRODUCT_CHANGE" ? (event.new_product_id ?? event.product_id) : event.product_id,
    entitlementId,
    currency: suppliedCurrency,
    revenueMinor,
    transactionId: event.transaction_id?.trim() || null,
    originalTransactionId: event.original_transaction_id?.trim() || null,
    entitlementExpiresAt: optionalProviderTimestamp(event.expiration_at_ms, "expiration_at_ms"),
    gracePeriodExpiresAt: optionalProviderTimestamp(
      event.grace_period_expiration_at_ms,
      "grace_period_expiration_at_ms",
    ),
    cancellationReason: event.cancel_reason?.trim() || null,
    willRenew:
      type === "CANCELLATION" || type === "REFUND" || type === "EXPIRATION"
        ? false
        : type === "INITIAL_PURCHASE" ||
            type === "TRIAL_START" ||
            type === "TRIAL_CONVERSION" ||
            type === "RENEWAL"
          ? true
          : null,
    occurredAt: new Date(occurredAtMs).toISOString(),
    receivedAt: options.receivedAt,
    rawReference: options.rawReference,
  });
}

/**
 * Verify the exact bytes before JSON parsing, then route by all three isolation
 * dimensions. No route metadata is trusted from the payload alone.
 */
export function createRevenueCatWebhookRouter(routes: readonly RevenueCatWebhookRoute[]) {
  const configuredRoutes = Object.freeze([...routes]);
  const routeKeys = new Set<string>();
  const providerScopes = new Set<string>();
  for (const route of configuredRoutes) {
    if (
      !route.organizationId.trim() ||
      !route.ventureId.trim() ||
      !route.revenueCatProject.trim() ||
      route.signingSecret.length < 16 ||
      route.subscriberHmacKey.length < 16 ||
      route.allowedAppIds.length === 0
    ) {
      throw new Error("RevenueCat route signing, subscriber, and app bindings are required");
    }
    const key = JSON.stringify([
      route.organizationId,
      route.ventureId,
      route.revenueCatProject,
      route.environment,
    ]);
    if (routeKeys.has(key)) throw new Error("duplicate RevenueCat webhook route");
    routeKeys.add(key);
    const providerScope = JSON.stringify([route.revenueCatProject, route.environment]);
    if (providerScopes.has(providerScope)) {
      throw new Error("a RevenueCat project/environment may belong to only one venture route");
    }
    providerScopes.add(providerScope);
  }
  return Object.freeze({
    ingest(input: {
      organizationId: string;
      ventureId: string;
      revenueCatProject: string;
      environment: IngestEnvironment;
      rawBody: string | Uint8Array;
      signature: string;
      authorization?: string;
      contentType: string;
    }): RevenueCatWebhookOutcome {
      const route = configuredRoutes.find(
        (candidate) =>
          candidate.organizationId === input.organizationId &&
          candidate.ventureId === input.ventureId &&
          candidate.revenueCatProject === input.revenueCatProject &&
          candidate.environment === input.environment,
      );
      if (!route) return { kind: "wrong_route" };
      if (
        route.ingestor.scope.organizationId !== route.organizationId ||
        route.ingestor.scope.ventureId !== route.ventureId ||
        route.ingestor.scope.revenueCatProject !== route.revenueCatProject ||
        route.ingestor.scope.environment !== route.environment
      ) {
        return { kind: "wrong_route" };
      }
      const raw =
        typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
      if (input.contentType.toLowerCase().split(";", 1)[0]?.trim() !== "application/json") {
        return { kind: "invalid_payload", reason: "content type must be application/json" };
      }
      const receivedAt = route.now?.() ?? new Date();
      if (
        route.authorizationHeader !== undefined &&
        !secureStringEqual(input.authorization ?? "", route.authorizationHeader)
      ) {
        return { kind: "invalid_signature" };
      }
      try {
        verifyRevenueCatSignedWebhook(raw, input.signature, {
          secrets: [
            {
              secret: route.signingSecret,
              validFrom: route.signingSecretValidFrom ?? "1970-01-01T00:00:00.000Z",
              validUntil: route.signingSecretValidUntil ?? "9999-12-31T23:59:59.999Z",
            },
            ...(route.previousSigningSecrets ?? []),
          ],
          maxAgeSeconds: route.maxAgeSeconds,
          maxBodyBytes: route.maxBodyBytes,
          now: receivedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("freshness")) return { kind: "stale_delivery" };
        if (message.includes("body")) return { kind: "payload_too_large" };
        return { kind: "invalid_signature" };
      }

      let payload: RevenueCatWebhookPayload;
      try {
        payload = JSON.parse(Buffer.from(raw).toString("utf8")) as RevenueCatWebhookPayload;
      } catch {
        return { kind: "invalid_payload", reason: "body is not valid JSON" };
      }
      try {
        const mapped = mapRevenueCatWebhookPayload(payload, {
          environment: route.environment,
          allowedAppIds: route.allowedAppIds,
          subscriberHmacKey: route.subscriberHmacKey,
          receivedAt: receivedAt.toISOString(),
          rawReference: `revenuecat:webhook:${createHash("sha256").update(raw).digest("hex")}`,
        });
        return route.ingestor.ingest(mapped);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "event shape is invalid";
        return reason.includes("route mismatch")
          ? { kind: "wrong_route" }
          : { kind: "invalid_payload", reason };
      }
    },
  });
}
