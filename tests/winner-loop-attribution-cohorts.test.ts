import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COHORT_WINDOWS,
  classifyAttribution,
  createAttributionLedger,
  createRevenueCatWebhookRouter,
  createSqliteSubscriptionEventStore,
  createSubscriptionIngestor,
  mapRevenueCatWebhookPayload,
  type AttributionEvidence,
  type AttributionLedger,
  type AttributionRecordInput,
  type RevenueCatWebhookPayload,
  type SubscriptionEvent,
  type SubscriptionEventStore,
} from "@/lib/winner-loop";
import { signRevenueCatWebhookFixture } from "@/lib/security";

const AT = new Date("2026-08-09T12:00:00.000Z");
const CREATIVE = "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA";
const ORGANIZATION = "org-payout-rank";
const subscriptionStores: SubscriptionEventStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (subscriptionStores.length) subscriptionStores.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function ledger(): AttributionLedger {
  return createAttributionLedger({
    organizationId: ORGANIZATION,
    ventureId: "payout-rank",
    now: () => AT,
  });
}

function attributionInput(
  evidence: AttributionEvidence,
  overrides: Partial<AttributionRecordInput> = {},
): AttributionRecordInput {
  return {
    organizationId: ORGANIZATION,
    ventureId: "payout-rank",
    creativeId: CREATIVE,
    creativeFamilyId: "fam-001",
    deliveryVariantId: "dv_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    organicPostId: "tt-post-1",
    campaignId: "camp-1",
    adGroupId: "ag-1",
    adId: "ad-1",
    subscriberRef: "sub-1",
    transactionRef: "tx-1",
    evidence,
    reportingWindowStart: "2026-08-01T00:00:00.000Z",
    reportingWindowEnd: "2026-08-09T00:00:00.000Z",
    conversionWindowHours: 168,
    sourceTime: "2026-08-08T00:00:00.000Z",
    fetchedAt: "2026-08-09T00:00:00.000Z",
    freshnessMaxAgeSeconds: 172_800,
    mappingVersion: "map-v1",
    ...overrides,
  };
}

describe("attribution classification", () => {
  it("calls a surviving click id deterministic", () => {
    const result = classifyAttribution({ clickId: "ttclid-123" });
    expect(result.attributionClass).toBe("DETERMINISTIC");
    expect(result.confidence).toBe("high");
  });

  it("never treats a subscription event alone as deterministic", () => {
    const book = ledger();
    // Everything a RevenueCat webhook gives us, and nothing more.
    const record = book.record(
      attributionInput({}, { subscriberRef: "sub-1", transactionRef: "tx-1" }),
    );

    expect(record.attributionClass).toBe("UNKNOWN");
    expect(record.mayBePresentedAsExact).toBe(false);
    expect(record.limitations.join(" ")).toMatch(/No attribution evidence/);
  });

  it("classifies provider-attributed, privacy-aggregated, modeled, and correlated distinctly", () => {
    expect(classifyAttribution({ attributionProvider: "appsflyer" }).attributionClass).toBe(
      "PROVIDER_ATTRIBUTED",
    );
    expect(classifyAttribution({ privacyPostbackId: "skan-1" }).attributionClass).toBe(
      "PRIVACY_AGGREGATED",
    );
    expect(classifyAttribution({ selfReportedSource: "TikTok" }).attributionClass).toBe("MODELED");
    expect(classifyAttribution({ temporalCorrelationOnly: true }).attributionClass).toBe(
      "CORRELATED",
    );
    expect(classifyAttribution({ incrementalExperimentId: "geo-1" }).attributionClass).toBe(
      "INCREMENTAL_EXPERIMENT",
    );
  });

  it("marks only deterministic results as presentable as exact", () => {
    const book = ledger();
    const exact = book.record(attributionInput({ clickId: "ttclid-1" }));
    const postback = book.record(
      attributionInput({ privacyPostbackId: "skan-1" }, { subscriberRef: "sub-2" }),
    );
    const providerClaim = book.record(
      attributionInput(
        { attributionProvider: "appsflyer" },
        { subscriberRef: "sub-3", transactionRef: "tx-3" },
      ),
    );

    expect(exact.mayBePresentedAsExact).toBe(true);
    expect(postback.mayBePresentedAsExact).toBe(false);
    expect(postback.limitations.join(" ")).toMatch(/Not a person-level link/);
    expect(providerClaim.resolvedGranularity).toBe("creative");
    expect(providerClaim.creativeReportingStatus).toBe("provider_claimed");
    expect(providerClaim.mayBePresentedAsExact).toBe(false);
    expect(book.isHealthyForCreativeLevelReporting(CREATIVE)).toBe(false);
  });

  it("persists freshness and refuses to call stale deterministic evidence exact", () => {
    const book = ledger();
    const stale = book.record(
      attributionInput(
        { clickId: "stale-click" },
        {
          sourceTime: "2026-08-01T00:00:00.000Z",
          fetchedAt: "2026-08-09T00:00:00.000Z",
          freshnessMaxAgeSeconds: 3_600,
        },
      ),
    );
    expect(stale.freshness).toEqual({
      status: "stale",
      sourceAgeSeconds: 691_200,
      maxAgeSeconds: 3_600,
    });
    expect(stale.creativeReportingStatus).toBe("stale");
    expect(stale.mayBePresentedAsExact).toBe(false);
    expect(book.isHealthyForCreativeLevelReporting(CREATIVE)).toBe(false);
  });

  it("reports the granularity the evidence actually supports", () => {
    const book = ledger();
    expect(book.record(attributionInput({ clickId: "c-1" })).resolvedGranularity).toBe("creative");

    const coarse = book.record(
      attributionInput({ privacyPostbackId: "skan-2" }, { subscriberRef: "sub-3" }),
    );
    expect(coarse.resolvedGranularity).toBe("campaign");
    expect(coarse.limitations.join(" ")).toMatch(/creative-level certainty is not claimed/);
  });

  it("summarises a creative at its weakest backing class", () => {
    const book = ledger();
    book.record(attributionInput({ clickId: "c-1" }));
    book.record(attributionInput({ temporalCorrelationOnly: true }, { subscriberRef: "sub-9" }));

    expect(book.weakestClassForCreative(CREATIVE)).toBe("CORRELATED");
    expect(book.isHealthyForCreativeLevelReporting(CREATIVE)).toBe(false);
  });

  it("refuses to write attribution for another venture", () => {
    const book = ledger();
    expect(() => book.record(attributionInput({ clickId: "c" }, { ventureId: "other" }))).toThrow();
  });
});

// --- Subscription ingestion ------------------------------------------------

function event(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return {
    providerEventId: "evt-1",
    type: "INITIAL_PURCHASE",
    environment: "production",
    subscriberId: "sub-1",
    productId: "monthly",
    entitlementId: "pro",
    currency: "EUR",
    revenueMinor: 999,
    occurredAt: "2026-08-01T10:00:00.000Z",
    receivedAt: "2026-08-01T10:00:05.000Z",
    rawReference: null,
    ...overrides,
  };
}

function ingestor() {
  return createSubscriptionIngestor({
    organizationId: ORGANIZATION,
    ventureId: "payout-rank",
    environment: "production",
    revenueCatProject: "rc-sample",
    now: () => AT,
  });
}

describe("subscription ingestion survives real webhook behaviour", () => {
  it("ignores a redelivered event without double counting", () => {
    const inbox = ingestor();
    expect(inbox.ingest(event()).kind).toBe("accepted");
    expect(inbox.ingest(event()).kind).toBe("duplicate");

    expect(inbox.eventCount()).toBe(1);
    expect(inbox.stateOf("sub-1").grossRevenueMinor).toBe(999);
  });

  it("treats a later transport delivery time as a duplicate, not changed provider content", () => {
    const inbox = ingestor();
    expect(inbox.ingest(event()).kind).toBe("accepted");
    expect(
      inbox.ingest(event({ receivedAt: "2026-08-02T10:00:05.000Z", rawReference: "ref://retry" })),
    ).toEqual({ kind: "duplicate" });
    expect(inbox.eventCount()).toBe(1);
  });

  it("rejects incomplete identity and revenue without currency while preserving non-revenue missingness", () => {
    const inbox = ingestor();
    expect(inbox.ingest(event({ productId: "" }))).toEqual({
      kind: "rejected",
      reason: "subscription event identity is incomplete",
    });
    expect(inbox.ingest(event({ currency: null }))).toEqual({
      kind: "rejected",
      reason: "revenue events require an explicit ISO currency; missing remains missing",
    });
    expect(
      inbox.ingest(
        event({
          providerEventId: "billing-without-currency",
          type: "BILLING_ISSUE",
          currency: null,
          revenueMinor: 0,
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(inbox.stateOf("sub-1")).toMatchObject({ status: "billing_issue", currency: null });
    expect(inbox.eventCount()).toBe(1);
  });

  it("rejects a duplicate event id whose content changed", () => {
    const inbox = ingestor();
    expect(inbox.ingest(event()).kind).toBe("accepted");
    expect(inbox.ingest(event({ revenueMinor: 1_999 }))).toEqual({
      kind: "rejected",
      reason: "provider event id is bound to different content",
    });
    expect(inbox.stateOf("sub-1").grossRevenueMinor).toBe(999);
  });

  it("does not combine subscriber revenue denominated in different currencies", () => {
    const inbox = ingestor();
    inbox.ingest(event());
    expect(
      inbox.ingest(event({ providerEventId: "usd-renewal", type: "RENEWAL", currency: "USD" })),
    ).toEqual({ kind: "rejected", reason: "subscriber revenue currencies cannot be combined" });
    expect(inbox.stateOf("sub-1")).toMatchObject({ currency: "EUR", grossRevenueMinor: 999 });
  });

  it("does not combine currencies when a later event links subscriber aliases", () => {
    const inbox = ingestor();
    expect(
      inbox.ingest(
        event({
          subscriberId: "anonymous-subscriber",
          subscriberAliases: ["anonymous-subscriber"],
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      inbox.ingest(
        event({
          providerEventId: "alias-usd-renewal",
          type: "RENEWAL",
          subscriberId: "restored-subscriber",
          subscriberAliases: ["anonymous-subscriber", "restored-subscriber"],
          currency: "USD",
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "subscriber revenue currencies cannot be combined" });
    expect(inbox.stateOf("anonymous-subscriber")).toMatchObject({
      currency: "EUR",
      grossRevenueMinor: 999,
    });
  });

  it("rejects a non-revenue alias event that would merge two currency histories", () => {
    const inbox = ingestor();
    expect(
      inbox.ingest(
        event({
          providerEventId: "eur-subscriber",
          subscriberId: "subscriber-eur",
          subscriberAliases: ["subscriber-eur"],
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      inbox.ingest(
        event({
          providerEventId: "usd-subscriber",
          subscriberId: "subscriber-usd",
          subscriberAliases: ["subscriber-usd"],
          currency: "USD",
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      inbox.ingest(
        event({
          providerEventId: "currency-bridge",
          type: "BILLING_ISSUE",
          subscriberId: "subscriber-bridge",
          subscriberAliases: ["subscriber-eur", "subscriber-usd"],
          currency: null,
          revenueMinor: 0,
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "subscriber revenue currencies cannot be combined" });
    expect(inbox.eventCount()).toBe(2);
  });

  it("never resolves an amount from another subscriber's colliding transaction", () => {
    const inbox = ingestor();
    expect(
      inbox.ingest(
        event({
          providerEventId: "other-purchase",
          subscriberId: "sub-other",
          transactionId: "tx-collision",
          originalTransactionId: "tx-collision",
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      inbox.ingest(
        event({
          providerEventId: "target-refund",
          type: "REFUND",
          subscriberId: "sub-target",
          revenueMinor: 0,
          transactionId: "tx-collision",
          originalTransactionId: "tx-collision",
          occurredAt: "2026-08-02T10:00:00.000Z",
        }),
      ),
    ).toEqual({ kind: "accepted" });

    const attribution = ledger();
    attribution.record(
      attributionInput(
        { clickId: "target-click" },
        { subscriberRef: "sub-target", transactionRef: "tx-collision" },
      ),
    );
    const cohort = inbox.cohort({
      creativeId: CREATIVE,
      creativeFamilyId: "fam-001",
      subscriberIds: ["sub-target"],
      cohortStart: "2026-08-01T00:00:00.000Z",
      window: DEFAULT_COHORT_WINDOWS[1]!,
      attribution,
      attributionProvider: "fixture-mmp",
      spendMinor: 0,
      impressions: 1,
      clicks: 1,
      installs: 1,
      onboardingCompletions: 1,
      paywallViews: 1,
      currency: "EUR",
    });
    expect(cohort.metrics.refundImpactMinor).toBe(0);
    expect(cohort.metrics.netRevenueMinor).toBe(0);
    expect(cohort.missingData).toContain("refund_amount");
  });

  it("orders by occurrence time when a renewal arrives before its purchase", () => {
    const inbox = ingestor();
    inbox.ingest(
      event({
        providerEventId: "evt-renewal",
        type: "RENEWAL",
        occurredAt: "2026-09-01T10:00:00.000Z",
        receivedAt: "2026-08-01T09:00:00.000Z",
      }),
    );
    inbox.ingest(event({ providerEventId: "evt-initial", occurredAt: "2026-08-01T10:00:00.000Z" }));

    const state = inbox.stateOf("sub-1");
    expect(state.firstPurchaseAt).toBe("2026-08-01T10:00:00.000Z");
    expect(state.renewals).toBe(1);
    expect(state.grossRevenueMinor).toBe(1_998);
    expect(state.status).toBe("active");
  });

  it("handles a refund delivered before the purchase it reverses", () => {
    const inbox = ingestor();
    inbox.ingest(
      event({
        providerEventId: "evt-refund",
        type: "REFUND",
        revenueMinor: -999,
        occurredAt: "2026-08-05T10:00:00.000Z",
        receivedAt: "2026-08-01T09:00:00.000Z",
      }),
    );
    inbox.ingest(event({ providerEventId: "evt-initial" }));

    const state = inbox.stateOf("sub-1");
    expect(state.refundedMinor).toBe(999);
    expect(state.status).toBe("refunded");
  });

  it("keeps a cancellation followed by a later renewal active", () => {
    const inbox = ingestor();
    inbox.ingest(event({ providerEventId: "e1" }));
    inbox.ingest(
      event({
        providerEventId: "e2",
        type: "CANCELLATION",
        occurredAt: "2026-08-10T00:00:00.000Z",
      }),
    );
    inbox.ingest(
      event({ providerEventId: "e3", type: "RENEWAL", occurredAt: "2026-08-20T00:00:00.000Z" }),
    );

    expect(inbox.stateOf("sub-1").status).toBe("active");
  });

  it("drops a sandbox event reaching a production ingestor", () => {
    const inbox = ingestor();
    expect(inbox.ingest(event({ environment: "sandbox" })).kind).toBe("wrong_environment");
    expect(inbox.eventCount()).toBe(0);
  });

  it("reports an unknown subscriber as empty rather than inventing one", () => {
    const state = ingestor().stateOf("sub-unknown");
    expect(state.status).toBe("none");
    expect(state.grossRevenueMinor).toBe(0);
    expect(state.firstPurchaseAt).toBeNull();
  });

  it("replays identically after a crash", () => {
    const events = [
      event({ providerEventId: "a" }),
      event({ providerEventId: "b", type: "RENEWAL", occurredAt: "2026-09-01T00:00:00.000Z" }),
    ];
    const first = ingestor();
    for (const entry of events) first.ingest(entry);

    // Same events, reversed delivery, plus a redelivery of one of them.
    const second = ingestor();
    for (const entry of [...events].reverse()) second.ingest(entry);
    second.ingest(events[0]!);

    expect(second.stateOf("sub-1")).toEqual(first.stateOf("sub-1"));
  });

  it("persists deduplication and subscriber state across a database restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-subscriptions-"));
    tempDirs.push(dir);
    const path = join(dir, "winner-loop.db");
    const firstStore = createSqliteSubscriptionEventStore(path);
    subscriptionStores.push(firstStore);
    const first = createSubscriptionIngestor({
      organizationId: ORGANIZATION,
      ventureId: "payout-rank",
      environment: "production",
      revenueCatProject: "rc-sample",
      store: firstStore,
      now: () => AT,
    });
    expect(first.ingest(event()).kind).toBe("accepted");
    firstStore.close();
    subscriptionStores.splice(subscriptionStores.indexOf(firstStore), 1);

    const reopenedStore = createSqliteSubscriptionEventStore(path);
    subscriptionStores.push(reopenedStore);
    const reopened = createSubscriptionIngestor({
      organizationId: ORGANIZATION,
      ventureId: "payout-rank",
      environment: "production",
      revenueCatProject: "rc-sample",
      store: reopenedStore,
      now: () => AT,
    });
    expect(reopened.ingest(event()).kind).toBe("duplicate");
    expect(reopened.eventCount()).toBe(1);
    expect(reopened.stateOf("sub-1").grossRevenueMinor).toBe(999);
  });

  it("serializes alias and currency invariants across separate SQLite clients", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-subscription-currency-"));
    tempDirs.push(dir);
    const path = join(dir, "winner-loop.db");
    const firstStore = createSqliteSubscriptionEventStore(path);
    const secondStore = createSqliteSubscriptionEventStore(path);
    subscriptionStores.push(firstStore, secondStore);
    const first = createSubscriptionIngestor({
      organizationId: ORGANIZATION,
      ventureId: "payout-rank",
      environment: "production",
      revenueCatProject: "rc-sample",
      store: firstStore,
      now: () => AT,
    });
    const second = createSubscriptionIngestor({
      organizationId: ORGANIZATION,
      ventureId: "payout-rank",
      environment: "production",
      revenueCatProject: "rc-sample",
      store: secondStore,
      now: () => AT,
    });
    expect(
      first.ingest(
        event({
          providerEventId: "sqlite-eur",
          subscriberId: "sqlite-eur-user",
          subscriberAliases: ["sqlite-eur-user"],
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      second.ingest(
        event({
          providerEventId: "sqlite-usd",
          subscriberId: "sqlite-usd-user",
          subscriberAliases: ["sqlite-usd-user"],
          currency: "USD",
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      second.ingest(
        event({
          providerEventId: "sqlite-bridge",
          type: "BILLING_ISSUE",
          subscriberId: "sqlite-bridge-user",
          subscriberAliases: ["sqlite-eur-user", "sqlite-usd-user"],
          currency: null,
          revenueMinor: 0,
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "subscriber revenue currencies cannot be combined" });
    expect(first.eventCount()).toBe(2);
    expect(second.eventCount()).toBe(2);
  });

  it("isolates identical events, aliases, and currencies across canonical organization scopes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-subscription-organizations-"));
    tempDirs.push(dir);
    const path = join(dir, "winner-loop.db");
    const firstStore = createSqliteSubscriptionEventStore(path);
    const secondStore = createSqliteSubscriptionEventStore(path);
    subscriptionStores.push(firstStore, secondStore);
    const first = createSubscriptionIngestor({
      organizationId: "org-boundary",
      ventureId: "venture",
      environment: "production",
      revenueCatProject: "rc\0shared-project",
      store: firstStore,
      now: () => AT,
    });
    const second = createSubscriptionIngestor({
      organizationId: "org",
      ventureId: "boundary-venture",
      environment: "production",
      revenueCatProject: "rc\0shared-project",
      store: secondStore,
      now: () => AT,
    });
    const shared = {
      providerEventId: "shared-event",
      subscriberId: "shared-subscriber",
      subscriberAliases: ["shared-subscriber", "shared-alias"],
    };

    expect(first.ingest(event({ ...shared, currency: "EUR" }))).toEqual({ kind: "accepted" });
    expect(second.ingest(event({ ...shared, currency: "USD" }))).toEqual({ kind: "accepted" });
    expect(first.eventCount()).toBe(1);
    expect(second.eventCount()).toBe(1);
    expect(first.stateOf("shared-alias").currency).toBe("EUR");
    expect(second.stateOf("shared-alias").currency).toBe("USD");
    expect(
      firstStore.has(
        { ...first.scope, organizationId: "unconfigured-organization" },
        "shared-event",
      ),
    ).toBe(false);
    expect(
      first.ingest(
        event({
          providerEventId: "same-org-currency-conflict",
          subscriberId: "shared-alias",
          subscriberAliases: ["shared-subscriber", "shared-alias"],
          currency: "USD",
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "subscriber revenue currencies cannot be combined" });
    expect(second.eventCount()).toBe(1);
  });

  it("rejects assigning one RevenueCat project/environment to two organizations", () => {
    const secondOrganization = createSubscriptionIngestor({
      organizationId: "org-other",
      ventureId: "payout-rank",
      environment: "production",
      revenueCatProject: "rc-sample",
      now: () => AT,
    });
    expect(() =>
      createRevenueCatWebhookRouter([
        {
          organizationId: ORGANIZATION,
          ventureId: "payout-rank",
          revenueCatProject: "rc-sample",
          environment: "production",
          signingSecret: "first-signing-secret",
          subscriberHmacKey: "first-subscriber-key",
          allowedAppIds: ["app-ios"],
          ingestor: ingestor(),
        },
        {
          organizationId: "org-other",
          ventureId: "payout-rank",
          revenueCatProject: "rc-sample",
          environment: "production",
          signingSecret: "second-signing-secret",
          subscriberHmacKey: "second-subscriber-key",
          allowedAppIds: ["app-ios"],
          ingestor: secondOrganization,
        },
      ]),
    ).toThrow(/may belong to only one venture route/);
  });

  it("rejects sign-invalid refunds and recovers from a billing issue on renewal", () => {
    const inbox = ingestor();
    expect(inbox.ingest(event({ providerEventId: "bad-refund", type: "REFUND" }))).toEqual({
      kind: "rejected",
      reason: "refund revenue must be negative or transaction-linked when the amount is absent",
    });
    inbox.ingest(event({ providerEventId: "purchase" }));
    inbox.ingest(
      event({
        providerEventId: "billing",
        type: "BILLING_ISSUE",
        revenueMinor: 0,
        occurredAt: "2026-08-03T00:00:00.000Z",
      }),
    );
    expect(inbox.stateOf("sub-1")).toMatchObject({
      status: "active",
      entitlementActive: true,
      billingIssueAt: "2026-08-03T00:00:00.000Z",
    });
    inbox.ingest(
      event({
        providerEventId: "recovered",
        type: "RENEWAL",
        occurredAt: "2026-08-04T00:00:00.000Z",
      }),
    );
    expect(inbox.stateOf("sub-1")).toMatchObject({ status: "active", billingIssueAt: null });
  });

  it("verifies the raw RevenueCat body before parsing and routes by tenant/project/environment", () => {
    const secret = "test-only-webhook-secret";
    const subscriberHmacKey = "test-only-subscriber-hmac-key";
    const inbox = ingestor();
    const route = {
      organizationId: ORGANIZATION,
      ventureId: "payout-rank",
      revenueCatProject: "rc-sample",
      environment: "production" as const,
      signingSecret: secret,
      subscriberHmacKey,
      allowedAppIds: ["app-ios"],
      authorizationHeader: "Bearer test-only-route",
      ingestor: inbox,
      now: () => AT,
    };
    const router = createRevenueCatWebhookRouter([route]);
    const rawBody = JSON.stringify({
      api_version: "1.0",
      event: {
        id: "webhook-1",
        type: "INITIAL_PURCHASE",
        event_timestamp_ms: Date.parse("2026-08-01T10:00:05.000Z"),
        app_id: "app-ios",
        app_user_id: "sub-webhook",
        product_id: "monthly",
        entitlement_ids: ["pro"],
        environment: "PRODUCTION",
        period_type: "NORMAL",
        purchased_at_ms: Date.parse("2026-08-01T10:00:00.000Z"),
        currency: "EUR",
        price_in_purchased_currency: 9.99,
      },
    });
    const timestamp = Math.floor(AT.getTime() / 1_000) - 5;
    const signature = signRevenueCatWebhookFixture(timestamp, Buffer.from(rawBody), secret);
    expect(
      router.ingest({
        organizationId: ORGANIZATION,
        ventureId: "payout-rank",
        revenueCatProject: "rc-sample",
        environment: "production",
        rawBody,
        signature,
        authorization: "Bearer test-only-route",
        contentType: "application/json; charset=utf-8",
      }),
    ).toEqual({ kind: "accepted" });
    const pseudonymousSubscriber = inbox.store.list(inbox.scope)[0]!.subscriberId;
    expect(pseudonymousSubscriber).toMatch(/^rcsub_[a-f0-9]{64}$/);
    expect(pseudonymousSubscriber).not.toContain("sub-webhook");
    expect(inbox.stateOf(pseudonymousSubscriber).grossRevenueMinor).toBe(999);

    expect(
      router.ingest({
        organizationId: ORGANIZATION,
        ventureId: "payout-rank",
        revenueCatProject: "rc-sample",
        environment: "production",
        rawBody: `${rawBody} `,
        signature,
        authorization: "Bearer test-only-route",
        contentType: "application/json",
      }),
    ).toEqual({ kind: "invalid_signature" });
    expect(
      router.ingest({
        organizationId: ORGANIZATION,
        ventureId: "another-venture",
        revenueCatProject: "rc-sample",
        environment: "production",
        rawBody,
        signature,
        authorization: "Bearer test-only-route",
        contentType: "application/json",
      }),
    ).toEqual({ kind: "wrong_route" });
    expect(inbox.eventCount()).toBe(1);
  });

  it("does not parse or persist an unauthenticated malformed body", () => {
    const inbox = ingestor();
    const router = createRevenueCatWebhookRouter([
      {
        organizationId: ORGANIZATION,
        ventureId: "payout-rank",
        revenueCatProject: "rc-sample",
        environment: "production",
        signingSecret: "test-only-signing-secret",
        subscriberHmacKey: "test-only-subscriber-key",
        allowedAppIds: ["app-ios"],
        ingestor: inbox,
        now: () => AT,
      },
    ]);
    expect(
      router.ingest({
        organizationId: ORGANIZATION,
        ventureId: "payout-rank",
        revenueCatProject: "rc-sample",
        environment: "production",
        rawBody: "{not-json",
        signature: `t=${Math.floor(AT.getTime() / 1_000)},v1=${"0".repeat(64)}`,
        contentType: "application/json",
      }),
    ).toEqual({ kind: "invalid_signature" });
    expect(inbox.eventCount()).toBe(0);
  });

  it("maps official trial, delayed conversion, and refund shapes idempotently out of order", () => {
    const inbox = ingestor();
    const common = {
      api_version: "1.0",
      event: {
        event_timestamp_ms: Date.parse("2026-08-09T10:00:00.000Z"),
        app_id: "app-ios",
        app_user_id: "official-user-1",
        product_id: "monthly",
        entitlement_ids: ["pro"],
        environment: "PRODUCTION" as const,
        currency: "EUR",
      },
    };
    const map = (
      eventPayload: Pick<RevenueCatWebhookPayload["event"], "id" | "type"> &
        Partial<RevenueCatWebhookPayload["event"]>,
    ) =>
      mapRevenueCatWebhookPayload(
        {
          ...common,
          event: { ...common.event, ...eventPayload },
        },
        {
          environment: "production",
          allowedAppIds: ["app-ios"],
          subscriberHmacKey: "test-only-subscriber-key",
          receivedAt: AT.toISOString(),
          rawReference: `fixture:${String(eventPayload.id)}`,
        },
      );
    const trial = map({
      id: "official-trial",
      type: "INITIAL_PURCHASE",
      period_type: "TRIAL",
      purchased_at_ms: Date.parse("2026-08-01T10:00:00.000Z"),
      price_in_purchased_currency: 0,
    });
    const conversion = map({
      id: "official-conversion",
      type: "RENEWAL",
      period_type: "NORMAL",
      is_trial_conversion: true,
      purchased_at_ms: Date.parse("2026-08-08T10:00:00.000Z"),
      price_in_purchased_currency: 9.99,
      transaction_id: "tx-conversion",
      original_transaction_id: "tx-original",
    });
    const refund = map({
      id: "official-refund",
      type: "CANCELLATION",
      cancel_reason: "CUSTOMER_SUPPORT",
      price_in_purchased_currency: 0,
      transaction_id: "tx-conversion",
      original_transaction_id: "tx-original",
    });

    expect(inbox.ingest(conversion)).toEqual({ kind: "accepted" });
    expect(inbox.ingest(conversion)).toEqual({ kind: "duplicate" });
    expect(inbox.ingest(trial)).toEqual({ kind: "accepted" });
    expect(inbox.ingest(refund)).toEqual({ kind: "accepted" });
    expect(inbox.stateOf(trial.subscriberId)).toMatchObject({
      trialStartedAt: "2026-08-01T10:00:00.000Z",
      firstPurchaseAt: "2026-08-08T10:00:00.000Z",
      grossRevenueMinor: 999,
      refundedMinor: 999,
      status: "refunded",
      entitlementActive: true,
      willRenew: false,
    });
  });

  it("keeps entitlement active through cancellation and billing grace until expiration", () => {
    const inbox = ingestor();
    const common = {
      api_version: "1.0",
      event: {
        event_timestamp_ms: Date.parse("2026-08-09T10:00:00.000Z"),
        app_id: "app-ios",
        app_user_id: "lifecycle-user",
        original_app_user_id: "lifecycle-user",
        product_id: "monthly",
        entitlement_ids: ["pro"],
        environment: "PRODUCTION" as const,
        currency: "EUR",
        transaction_id: "tx-lifecycle",
        original_transaction_id: "tx-lifecycle",
      },
    };
    const map = (event: RevenueCatWebhookPayload["event"]) =>
      mapRevenueCatWebhookPayload(
        { api_version: "1.0", event },
        {
          environment: "production",
          allowedAppIds: ["app-ios"],
          subscriberHmacKey: "test-only-subscriber-key",
          receivedAt: AT.toISOString(),
          rawReference: `fixture:${event.id}`,
        },
      );
    const purchase = map({
      ...common.event,
      id: "lifecycle-purchase",
      type: "INITIAL_PURCHASE",
      purchased_at_ms: Date.parse("2026-08-01T10:00:00.000Z"),
      expiration_at_ms: Date.parse("2026-08-20T10:00:00.000Z"),
      price_in_purchased_currency: 9.99,
    });
    const cancellation = map({
      ...common.event,
      id: "lifecycle-cancel",
      type: "CANCELLATION",
      cancel_reason: "UNSUBSCRIBE",
      expiration_at_ms: Date.parse("2026-08-20T10:00:00.000Z"),
      price_in_purchased_currency: 0,
    });
    const billing = map({
      ...common.event,
      id: "lifecycle-billing",
      type: "BILLING_ISSUE",
      expiration_at_ms: Date.parse("2026-08-20T10:00:00.000Z"),
      grace_period_expiration_at_ms: Date.parse("2026-08-21T10:00:00.000Z"),
      price_in_purchased_currency: null,
      currency: null,
    });
    expect(inbox.ingest(purchase)).toEqual({ kind: "accepted" });
    expect(inbox.ingest(cancellation)).toEqual({ kind: "accepted" });
    expect(inbox.ingest(billing)).toEqual({ kind: "accepted" });
    expect(inbox.stateOf(purchase.subscriberId)).toMatchObject({
      status: "active",
      entitlementActive: true,
      willRenew: false,
      cancellationReason: "UNSUBSCRIBE",
      billingIssueAt: "2026-08-09T10:00:00.000Z",
      gracePeriodExpiresAt: "2026-08-21T10:00:00.000Z",
    });
    const attribution = ledger();
    attribution.record(
      attributionInput({ clickId: "lifecycle-click" }, { subscriberRef: purchase.subscriberId }),
    );
    expect(
      inbox.cohort({
        creativeId: CREATIVE,
        creativeFamilyId: "fam-001",
        subscriberIds: [purchase.subscriberId],
        cohortStart: "2026-08-09T00:00:00.000Z",
        window: DEFAULT_COHORT_WINDOWS[0]!,
        attribution,
        attributionProvider: "fixture-mmp",
        spendMinor: 0,
        impressions: 1,
        clicks: 1,
        installs: 1,
        onboardingCompletions: 1,
        paywallViews: 1,
        currency: "EUR",
      }).metrics.activeSubscribers,
    ).toBe(1);

    const expiration = map({
      ...common.event,
      id: "lifecycle-expiration",
      type: "EXPIRATION",
      event_timestamp_ms: Date.parse("2026-08-09T11:00:00.000Z"),
      expiration_at_ms: Date.parse("2026-08-09T11:00:00.000Z"),
      price_in_purchased_currency: null,
      currency: null,
    });
    expect(inbox.ingest(expiration)).toEqual({ kind: "accepted" });
    expect(inbox.stateOf(purchase.subscriberId)).toMatchObject({
      status: "expired",
      entitlementActive: false,
      willRenew: false,
    });
  });

  it("maps a valid non-revenue RevenueCat lifecycle event without inventing currency", () => {
    const mapped = mapRevenueCatWebhookPayload(
      {
        api_version: "1.0",
        event: {
          id: "official-billing-issue",
          type: "BILLING_ISSUE",
          event_timestamp_ms: Date.parse("2026-08-09T10:00:00.000Z"),
          app_id: "app-ios",
          app_user_id: "official-user-2",
          product_id: "monthly",
          entitlement_ids: ["pro"],
          environment: "PRODUCTION",
          period_type: "NORMAL",
          purchased_at_ms: Date.parse("2026-08-01T10:00:00.000Z"),
          currency: null,
          price_in_purchased_currency: null,
        },
      },
      {
        environment: "production",
        allowedAppIds: ["app-ios"],
        subscriberHmacKey: "test-only-subscriber-key",
        receivedAt: AT.toISOString(),
        rawReference: "fixture:official-billing-issue",
      },
    );
    expect(mapped).toMatchObject({
      type: "BILLING_ISSUE",
      currency: null,
      revenueMinor: 0,
      occurredAt: "2026-08-09T10:00:00.000Z",
    });
    const inbox = ingestor();
    expect(inbox.ingest(mapped)).toEqual({ kind: "accepted" });
    expect(inbox.stateOf(mapped.subscriberId)).toMatchObject({
      status: "billing_issue",
      currency: null,
    });
  });

  it("normalizes RevenueCat aliases even when the first event lacks an original App User ID", () => {
    const map = (
      id: string,
      appUserId: string,
      originalAppUserId?: string,
      aliases: readonly string[] = [],
    ) =>
      mapRevenueCatWebhookPayload(
        {
          api_version: "1.0",
          event: {
            id,
            type: "RENEWAL",
            event_timestamp_ms: Date.parse("2026-08-09T10:00:00.000Z"),
            app_id: "app-ios",
            app_user_id: appUserId,
            original_app_user_id: originalAppUserId,
            aliases,
            product_id: "monthly",
            entitlement_ids: ["pro"],
            environment: "PRODUCTION",
            period_type: "NORMAL",
            purchased_at_ms: Date.parse("2026-08-09T10:00:00.000Z"),
            currency: "EUR",
            price_in_purchased_currency: 9.99,
            is_trial_conversion: false,
          },
        },
        {
          environment: "production",
          allowedAppIds: ["app-ios"],
          subscriberHmacKey: "test-only-subscriber-key",
          receivedAt: AT.toISOString(),
          rawReference: `fixture:${id}`,
        },
      );
    const beforeAlias = map("alias-before", "anonymous-user");
    const afterAlias = map("alias-after", "restored-user", "restored-user", [
      "anonymous-user",
      "restored-user",
    ]);
    expect(afterAlias.subscriberId).not.toBe(beforeAlias.subscriberId);
    expect(afterAlias.subscriberId).not.toContain("stable-original-user");
    const inbox = ingestor();
    expect(inbox.ingest(beforeAlias)).toEqual({ kind: "accepted" });
    expect(inbox.ingest(afterAlias)).toEqual({ kind: "accepted" });
    expect(inbox.stateOf(beforeAlias.subscriberId)).toMatchObject({
      renewals: 2,
      grossRevenueMinor: 1_998,
    });
    expect(inbox.stateOf(afterAlias.subscriberId).grossRevenueMinor).toBe(1_998);
  });
});

describe("creative cohorts", () => {
  function cohortFixture(evidence: AttributionEvidence) {
    const inbox = ingestor();
    const book = ledger();
    book.record(attributionInput(evidence));

    inbox.ingest(event({ providerEventId: "t1", type: "TRIAL_START", revenueMinor: 0 }));
    inbox.ingest(
      event({ providerEventId: "p1", occurredAt: "2026-08-03T10:00:00.000Z", revenueMinor: 999 }),
    );
    inbox.ingest(
      event({
        providerEventId: "r1",
        type: "RENEWAL",
        occurredAt: "2026-08-06T10:00:00.000Z",
        revenueMinor: 999,
      }),
    );

    return inbox.cohort({
      creativeId: CREATIVE,
      creativeFamilyId: "fam-001",
      subscriberIds: ["sub-1"],
      cohortStart: "2026-08-01T00:00:00.000Z",
      window: DEFAULT_COHORT_WINDOWS[1]!,
      attribution: book,
      attributionProvider: "appsflyer",
      spendMinor: 5_000,
      impressions: 100_000,
      clicks: 900,
      installs: null,
      onboardingCompletions: 10,
      paywallViews: 4,
      currency: "EUR",
    });
  }

  it("rejects a same-venture attribution ledger owned by another organization", () => {
    const inbox = ingestor();
    const foreignAttribution = createAttributionLedger({
      organizationId: "org-foreign",
      ventureId: inbox.scope.ventureId,
      now: () => AT,
    });
    expect(() =>
      inbox.cohort({
        creativeId: CREATIVE,
        creativeFamilyId: "fam-001",
        subscriberIds: [],
        cohortStart: "2026-08-01T00:00:00.000Z",
        window: DEFAULT_COHORT_WINDOWS[0]!,
        attribution: foreignAttribution,
        attributionProvider: null,
        spendMinor: 0,
        impressions: 0,
        clicks: 0,
        installs: 0,
        onboardingCompletions: 0,
        paywallViews: 0,
        currency: "EUR",
      }),
    ).toThrow(/tenant_scope_mismatch/);
  });

  it("rejects attribution evidence from a different creative family", () => {
    const inbox = ingestor();
    const book = ledger();
    book.record(attributionInput({ clickId: "family-bound-click" }));

    expect(() =>
      inbox.cohort({
        creativeId: CREATIVE,
        creativeFamilyId: "different-family",
        subscriberIds: [],
        cohortStart: "2026-08-01T00:00:00.000Z",
        window: DEFAULT_COHORT_WINDOWS[0]!,
        attribution: book,
        attributionProvider: "appsflyer",
        spendMinor: 0,
        impressions: 0,
        clicks: 0,
        installs: 0,
        onboardingCompletions: 0,
        paywallViews: 0,
        currency: "EUR",
      }),
    ).toThrow(/creative_lineage_mismatch/);
  });

  it("computes D7 metrics and labels its revenue definition", () => {
    const snapshot = cohortFixture({ clickId: "c-1" });

    expect(snapshot.window.label).toBe("D7");
    expect(snapshot.metrics.trials).toBe(1);
    expect(snapshot.metrics.initialSubscribers).toBe(1);
    expect(snapshot.metrics.renewals).toBe(1);
    expect(snapshot.metrics.grossRevenueMinor).toBe(1_998);
    expect(snapshot.metrics.cacMinor).toBe(5_000);
    expect(snapshot.metrics.onboardingToTrial).toBe(0.1);
    expect(snapshot.metrics.paywallViewToPaid).toBe(0.25);
    expect(snapshot.metrics.delayedConversions).toBe(0);
    expect(snapshot.metrics.retentionRate).toBe(1);
    expect(snapshot.metrics.refundImpactMinor).toBe(0);
    expect(snapshot.metrics.paybackAchieved).toBe(false);
    expect(snapshot.windowMature).toBe(true);
    expect(snapshot.revenueDefinition).toBe("net_of_refunds_gross_of_store_fees");
    expect(snapshot.revenueCatProject).toBe("rc-sample");
  });

  it("reports missing inputs rather than defaulting them to zero", () => {
    const snapshot = cohortFixture({ clickId: "c-1" });
    expect(snapshot.missingData).toContain("installs");
    expect(snapshot.metrics.installs).toBeNull();
  });

  it("claims creative-level certainty only when attribution supports it", () => {
    const exact = cohortFixture({ clickId: "c-1" });
    expect(exact.creativeLevelCertainty).toBe(true);
    expect(exact.attributionClass).toBe("DETERMINISTIC");

    const coarse = cohortFixture({ temporalCorrelationOnly: true });
    expect(coarse.creativeLevelCertainty).toBe(false);
    expect(coarse.attributionClass).toBe("CORRELATED");
    expect(coarse.limitations.join(" ")).toMatch(/does not support creative-level certainty/);

    const providerClaimed = cohortFixture({ attributionProvider: "appsflyer" });
    expect(providerClaimed.creativeLevelCertainty).toBe(false);
    expect(providerClaimed.attributionClass).toBe("PROVIDER_ATTRIBUTED");
    expect(providerClaimed.attributionGranularity).toBe("creative");
    expect(providerClaimed.attributionReportingStatus).toBe("provider_claimed");
    expect(providerClaimed.attributionFreshness).toBe("fresh");
  });

  it("offers D0, D7 and D30 by default without claiming D90 maturity", () => {
    expect(DEFAULT_COHORT_WINDOWS.map((w) => w.label)).toEqual(["D0", "D7", "D30"]);
  });

  it("treats D0 as the first 24-hour half-open window", () => {
    const inbox = ingestor();
    const book = ledger();
    book.record(attributionInput({ clickId: "d0-click" }));
    inbox.ingest(event({ providerEventId: "d0-purchase" }));
    inbox.ingest(
      event({
        providerEventId: "d0-boundary-renewal",
        type: "RENEWAL",
        occurredAt: "2026-08-02T00:00:00.000Z",
      }),
    );

    const snapshot = inbox.cohort({
      creativeId: CREATIVE,
      creativeFamilyId: "fam-001",
      subscriberIds: ["sub-1"],
      cohortStart: "2026-08-01T00:00:00.000Z",
      window: DEFAULT_COHORT_WINDOWS[0]!,
      attribution: book,
      attributionProvider: "appsflyer",
      spendMinor: 500,
      impressions: 100,
      clicks: 10,
      installs: 1,
      onboardingCompletions: 1,
      paywallViews: 1,
      currency: "EUR",
    });

    expect(snapshot.reportingWindowEnd).toBe("2026-08-02T00:00:00.000Z");
    expect(snapshot.metrics.initialSubscribers).toBe(1);
    expect(snapshot.metrics.renewals).toBe(0);
    expect(snapshot.metrics.grossRevenueMinor).toBe(999);
  });

  it("counts one linked subscriber identity only once when aliases are both supplied", () => {
    const inbox = ingestor();
    const book = ledger();
    book.record(attributionInput({ clickId: "alias-cohort-click" }));
    inbox.ingest(
      event({
        providerEventId: "alias-trial",
        type: "TRIAL_START",
        subscriberId: "anonymous-user",
        subscriberAliases: ["anonymous-user", "restored-user"],
        revenueMinor: 0,
        currency: null,
      }),
    );

    const snapshot = inbox.cohort({
      creativeId: CREATIVE,
      creativeFamilyId: "fam-001",
      subscriberIds: ["anonymous-user", "restored-user"],
      cohortStart: "2026-08-01T00:00:00.000Z",
      window: DEFAULT_COHORT_WINDOWS[1]!,
      attribution: book,
      attributionProvider: "appsflyer",
      spendMinor: 500,
      impressions: 100,
      clicks: 10,
      installs: 1,
      onboardingCompletions: 1,
      paywallViews: 1,
      currency: "EUR",
    });

    expect(snapshot.metrics.trials).toBe(1);
    expect(snapshot.metrics.activeSubscribers).toBe(1);
  });

  it("refuses to relabel or combine cohort revenue currencies", () => {
    const inbox = ingestor();
    const book = ledger();
    book.record(attributionInput({ clickId: "currency-click" }));
    inbox.ingest(event());

    expect(() =>
      inbox.cohort({
        creativeId: CREATIVE,
        creativeFamilyId: "fam-001",
        subscriberIds: ["sub-1"],
        cohortStart: "2026-08-01T00:00:00.000Z",
        window: DEFAULT_COHORT_WINDOWS[0]!,
        attribution: book,
        attributionProvider: "appsflyer",
        spendMinor: 500,
        impressions: 100,
        clicks: 10,
        installs: 1,
        onboardingCompletions: null,
        paywallViews: null,
        currency: "USD",
      }),
    ).toThrow(/currencies cannot be silently combined or relabelled/);
  });
});
