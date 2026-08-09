import { describe, expect, it } from "vitest";
import {
  DEFAULT_COHORT_WINDOWS,
  classifyAttribution,
  createAttributionLedger,
  createSubscriptionIngestor,
  type AttributionEvidence,
  type AttributionLedger,
  type AttributionRecordInput,
  type SubscriptionEvent,
} from "@/lib/winner-loop";

const AT = new Date("2026-08-09T12:00:00.000Z");
const CREATIVE = "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA";

function ledger(): AttributionLedger {
  return createAttributionLedger({ ventureId: "payout-rank", now: () => AT });
}

function attributionInput(
  evidence: AttributionEvidence,
  overrides: Partial<AttributionRecordInput> = {},
): AttributionRecordInput {
  return {
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

    expect(exact.mayBePresentedAsExact).toBe(true);
    expect(postback.mayBePresentedAsExact).toBe(false);
    expect(postback.limitations.join(" ")).toMatch(/Not a person-level link/);
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
      currency: "EUR",
    });
  }

  it("computes D7 metrics and labels its revenue definition", () => {
    const snapshot = cohortFixture({ clickId: "c-1" });

    expect(snapshot.window.label).toBe("D7");
    expect(snapshot.metrics.trials).toBe(1);
    expect(snapshot.metrics.initialSubscribers).toBe(1);
    expect(snapshot.metrics.renewals).toBe(1);
    expect(snapshot.metrics.grossRevenueMinor).toBe(1_998);
    expect(snapshot.metrics.cacMinor).toBe(5_000);
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
  });

  it("offers D0, D7 and D30 by default without claiming D90 maturity", () => {
    expect(DEFAULT_COHORT_WINDOWS.map((w) => w.label)).toEqual(["D0", "D7", "D30"]);
  });
});
