import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SpendError,
  createMemorySpendStore,
  createSpendLedger,
  createSqliteSpendStore,
  type ReserveInput,
  type SpendGrantInput,
  type SpendLedger,
  type SpendStore,
} from "@/lib/winner-loop";

const APPROVED_AT = new Date("2026-08-08T09:00:00.000Z");

const openStores: SpendStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openStores.length) openStores.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function sqliteStore(): SpendStore {
  const dir = mkdtempSync(join(tmpdir(), "vh-spend-"));
  tempDirs.push(dir);
  const store = createSqliteSpendStore(join(dir, "spend.db"));
  openStores.push(store);
  return store;
}

/** A second independent client onto the same database file. */
function sameFileStore(path: string): SpendStore {
  const store = createSqliteSpendStore(path);
  openStores.push(store);
  return store;
}

function clock(start = APPROVED_AT) {
  let current = start;
  return {
    now: () => current,
    advanceHours(hours: number) {
      current = new Date(current.getTime() + hours * 3_600_000);
    },
  };
}

function grantInput(overrides: Partial<SpendGrantInput> = {}): SpendGrantInput {
  return {
    ventureId: "payout-rank",
    network: "tiktok_paid",
    externalAccountId: "tt-ads-1",
    currency: "EUR",
    totalMinorUnits: 20_000,
    perCreativeMinorUnits: 10_000,
    dailyAccountMinorUnits: 12_000,
    allowedCreativeIds: ["cr_AAAAAAAAAAAAAAAAAAAAAAAAAA", "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB"],
    approvedBy: "founder@example.com",
    approvalRef: "checkpoint:paid-test-001",
    proposalId: "prop-001",
    notBefore: APPROVED_AT.toISOString(),
    expiresAt: new Date("2026-08-15T09:00:00.000Z").toISOString(),
    ...overrides,
  };
}

let seed = 0;
function ledgerOn(store: SpendStore, now: () => Date = () => APPROVED_AT): SpendLedger {
  seed += 1;
  const local = seed;
  return createSpendLedger({
    store,
    now,
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, i) => (i + local * 13) % 256),
  });
}

function withGrant(overrides: Partial<SpendGrantInput> = {}) {
  const time = clock();
  const store = sqliteStore();
  const ledger = ledgerOn(store, time.now);
  const grant = ledger.registerGrant(grantInput(overrides));
  return { ledger, grant, time, store };
}

let idempotencyCounter = 0;
function reserveInput(overrides: Partial<ReserveInput> & { grantId: string }): ReserveInput {
  idempotencyCounter += 1;
  return {
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    campaignId: "camp-1",
    amountMinorUnits: 1_000,
    idempotencyKey: `key-${idempotencyCounter}`,
    ...overrides,
  };
}

function errorFrom(run: () => unknown): SpendError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SpendError);
    return error as SpendError;
  }
  throw new Error("expected the call to throw");
}

describe("transactional concurrency across independent clients", () => {
  it("prevents two separate database clients from overreserving one cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-spend-"));
    tempDirs.push(dir);
    const path = join(dir, "spend.db");

    const storeA = sameFileStore(path);
    const ledgerA = ledgerOn(storeA);
    const grant = ledgerA.registerGrant(
      grantInput({
        totalMinorUnits: 10_000,
        perCreativeMinorUnits: 10_000,
        dailyAccountMinorUnits: 10_000,
      }),
    );

    // A completely separate connection — the hazard an in-memory ledger cannot see.
    const storeB = sameFileStore(path);
    const ledgerB = ledgerOn(storeB);

    ledgerA.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "a" }),
    );

    const error = errorFrom(() =>
      ledgerB.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "b" }),
      ),
    );

    expect(error.code).toBe("cap_exceeded");
    expect(error.cap).toBe("grantTotal");
    expect(ledgerB.reservedMinorUnits(grant.grantId)).toBe(6_000);
  });

  it("shows why the in-memory store is not production safe", () => {
    const storeA = createMemorySpendStore();
    const storeB = createMemorySpendStore();

    expect(storeA.productionSafe).toBe(false);
    expect(sqliteStore().productionSafe).toBe(true);

    // Two memory stores share nothing, so each would grant the same headroom.
    const ledgerA = ledgerOn(storeA);
    const grant = ledgerA.registerGrant(grantInput({ totalMinorUnits: 10_000 }));
    storeB.putGrant(grant);
    const ledgerB = ledgerOn(storeB);

    ledgerA.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "a" }),
    );
    ledgerB.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "b" }),
    );

    expect(ledgerA.reservedMinorUnits(grant.grantId)).toBe(6_000);
    expect(ledgerB.reservedMinorUnits(grant.grantId)).toBe(6_000);
  });

  it("returns the original reservation when an idempotency key repeats", () => {
    const { ledger, grant } = withGrant();
    const first = ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "retry-1" }),
    );
    const replay = ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "retry-1" }),
    );

    expect(replay.reservationId).toBe(first.reservationId);
    expect(ledger.reservedMinorUnits(grant.grantId)).toBe(5_000);
  });

  it("survives a client restart without losing committed reservations", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-spend-"));
    tempDirs.push(dir);
    const path = join(dir, "spend.db");

    const first = sameFileStore(path);
    const ledger = ledgerOn(first);
    const grant = ledger.registerGrant(grantInput());
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 7_000, idempotencyKey: "k" }),
    );
    first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const reopened = ledgerOn(sameFileStore(path));
    expect(reopened.reservedMinorUnits(grant.grantId)).toBe(7_000);
  });
});

describe("cap hierarchy", () => {
  it("enforces the per-creative cap", () => {
    const { ledger, grant } = withGrant();
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 1, idempotencyKey: "2" }),
      ),
    );
    expect(error.cap).toBe("perCreative");
  });

  it("enforces the daily account cap across creatives", () => {
    const { ledger, grant } = withGrant();
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({
          grantId: grant.grantId,
          creativeId: "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB",
          campaignId: "camp-2",
          amountMinorUnits: 2_001,
          idempotencyKey: "2",
        }),
      ),
    );
    expect(error.cap).toBe("dailyAccount");
  });

  it("enforces the per-campaign cap", () => {
    const { ledger, grant } = withGrant({ perCampaignMinorUnits: 3_000 });

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 3_001, idempotencyKey: "1" }),
      ),
    );
    expect(error.cap).toBe("perCampaign");
  });

  it("enforces the monthly venture cap", () => {
    const { ledger, grant } = withGrant({ monthlyVentureMinorUnits: 2_500 });

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 2_501, idempotencyKey: "1" }),
      ),
    );
    expect(error.cap).toBe("monthlyVenture");
  });

  it("lets the daily cap recover while the grant total still binds", () => {
    const { ledger, grant, time } = withGrant();
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );
    time.advanceHours(24);
    ledger.reserve(
      reserveInput({
        grantId: grant.grantId,
        creativeId: "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB",
        amountMinorUnits: 10_000,
        idempotencyKey: "2",
      }),
    );

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({
          grantId: grant.grantId,
          creativeId: "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB",
          amountMinorUnits: 1,
          idempotencyKey: "3",
        }),
      ),
    );
    expect(error.cap).toBe("grantTotal");
  });

  it("records spend in integer minor units only", () => {
    const { ledger, grant } = withGrant();
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, amountMinorUnits: 10.5 })),
      ).code,
    ).toBe("non_integer_minor_units");
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, amountMinorUnits: -5 })),
      ).code,
    ).toBe("non_positive_amount");
  });
});

describe("grant scope and validity", () => {
  it("refuses a creative the grant does not cover", () => {
    const { ledger, grant } = withGrant();
    expect(
      errorFrom(() =>
        ledger.reserve(
          reserveInput({ grantId: grant.grantId, creativeId: "cr_CCCCCCCCCCCCCCCCCCCCCCCCCC" }),
        ),
      ).code,
    ).toBe("creative_not_in_grant");
  });

  it("refuses a different network, account, or currency", () => {
    const { ledger, grant } = withGrant();
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, network: "meta_paid" })),
      ).code,
    ).toBe("network_mismatch");
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, externalAccountId: "other" })),
      ).code,
    ).toBe("account_mismatch");
    expect(
      errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId, currency: "USD" })))
        .code,
    ).toBe("currency_mismatch");
  });

  it("refuses an unknown, expired, or revoked grant", () => {
    const { ledger, grant, time } = withGrant();
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: "grant_missing" }))).code).toBe(
      "unknown_grant",
    );

    ledger.revokeGrant(grant.grantId, "connection removed");
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );

    const fresh = withGrant();
    fresh.time.advanceHours(24 * 8);
    expect(
      errorFrom(() => fresh.ledger.reserve(reserveInput({ grantId: fresh.grant.grantId }))).code,
    ).toBe("grant_expired");
    void time;
  });
});

describe("settlement and reconciliation", () => {
  it("settles to what the provider actually reported", async () => {
    const { ledger, grant } = withGrant();
    await ledger.withReservation(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "1" }),
      async () => 4_237,
    );

    expect(ledger.committedMinorUnits(grant.grantId)).toBe(4_237);
    expect(ledger.reservedMinorUnits(grant.grantId)).toBe(0);
  });

  it("releases the hold when the provider call fails", async () => {
    const { ledger, grant } = withGrant();
    await expect(
      ledger.withReservation(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "1" }),
        async () => {
          throw new Error("provider rejected the campaign");
        },
      ),
    ).rejects.toThrow("provider rejected the campaign");

    expect(ledger.committedMinorUnits(grant.grantId)).toBe(0);
    expect(ledger.reservedMinorUnits(grant.grantId)).toBe(0);
  });

  it("records an overspend at its real value, raises an incident, and freezes the grant", async () => {
    const { ledger, grant } = withGrant();

    await expect(
      ledger.withReservation(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "1" }),
        async () => 9_999,
      ),
    ).rejects.toMatchObject({ code: "settlement_exceeds_reservation" });

    expect(ledger.committedMinorUnits(grant.grantId)).toBe(9_999);
    expect(ledger.isHalted(grant.grantId)).toBe(true);
    expect(ledger.listIncidents(grant.grantId)).toHaveLength(1);
    expect(ledger.listIncidents(grant.grantId)[0]!.kind).toBe("provider_overspend");
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );
  });
});

describe("kill switch and automatic pause", () => {
  it("halts all further reservations once the kill switch is active", () => {
    const { ledger, grant } = withGrant();
    ledger.activateKillSwitch(grant.grantId, "founder stopped all spend");
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );
  });

  it("pauses on tracking, attribution, rights, or revocation failures", () => {
    const { ledger, grant } = withGrant();
    const decision = ledger.evaluateAutoPause(grant.grantId, {
      trackingHealthy: false,
      attributionMappingIntact: false,
      providerPolicyWarning: false,
      rightsValid: false,
      connectionRevoked: true,
      refundRateAnomaly: false,
      stopConditionTriggered: false,
    });

    expect(decision.paused).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "tracking_health_failed",
        "attribution_mapping_broken",
        "rights_invalid",
        "connection_revoked",
      ]),
    );
  });

  it("does not pause when every guardrail is healthy", () => {
    const { ledger, grant } = withGrant();
    const decision = ledger.evaluateAutoPause(grant.grantId, {
      trackingHealthy: true,
      attributionMappingIntact: true,
      providerPolicyWarning: false,
      rightsValid: true,
      connectionRevoked: false,
      refundRateAnomaly: false,
      stopConditionTriggered: false,
    });

    expect(decision.paused).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("halts spend once an auto-pause is applied", () => {
    const { ledger, grant } = withGrant();
    ledger.applyAutoPause(grant.grantId, ["tracking_health_failed"]);
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );
  });
});

describe("no automatic scaling in V1", () => {
  it("returns a recommendation that was not applied and needs a new grant", () => {
    const { ledger, grant } = withGrant();
    const proposal = ledger.proposeScale(grant.grantId, {
      creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      suggestedTotalMinorUnits: 50_000,
      rationale: "CAC is below target across a full D7 cohort",
    });

    expect(proposal.automaticallyApplied).toBe(false);
    expect(proposal.requiresNewSpendGrant).toBe(true);
    expect(ledger.getGrant(grant.grantId)?.totalMinorUnits).toBe(20_000);
  });

  it("exposes no path that raises a cap on an existing grant", () => {
    const { ledger } = withGrant();
    for (const forbidden of ["increaseBudget", "raiseCap", "updateBudget", "setTotal"]) {
      expect(ledger).not.toHaveProperty(forbidden);
    }
  });

  it("cross-venture isolation: a second venture's grant is a separate budget", () => {
    const { ledger, grant } = withGrant();
    const other = ledger.registerGrant(
      grantInput({ ventureId: "ship-to-users", externalAccountId: "tt-ads-2" }),
    );

    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );

    expect(ledger.reservedMinorUnits(other.grantId)).toBe(0);
    expect(other.grantId).not.toBe(grant.grantId);
  });
});
