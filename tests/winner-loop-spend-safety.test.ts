import { describe, expect, it } from "vitest";
import { SpendError, createSpendLedger, type SpendGrantInput } from "@/lib/winner-loop";

const APPROVED_AT = new Date("2026-08-08T09:00:00.000Z");

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
    allowedCreativeIds: ["cr_aaaaaaaaaaaaaaaa", "cr_bbbbbbbbbbbbbbbb"],
    approvedBy: "founder@example.com",
    approvalRef: "checkpoint:paid-test-001",
    notBefore: APPROVED_AT.toISOString(),
    expiresAt: new Date("2026-08-15T09:00:00.000Z").toISOString(),
    ...overrides,
  };
}

function ledgerWithGrant(overrides: Partial<SpendGrantInput> = {}) {
  const time = clock();
  const ledger = createSpendLedger({ now: time.now });
  const grant = ledger.registerGrant(grantInput(overrides));
  return { ledger, grant, time };
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SpendError);
    return (error as SpendError).code;
  }
  throw new Error("expected the call to throw");
}

describe("spend grants", () => {
  it("refuses any reservation when no grant authorises the creative", () => {
    const { ledger, grant } = ledgerWithGrant();

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_cccccccccccccccc",
          campaignId: "camp-1",
          amountMinorUnits: 1_000,
        }),
      ),
    ).toBe("creative_not_in_grant");
  });

  it("refuses a reservation against an unknown grant", () => {
    const { ledger } = ledgerWithGrant();

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: "grant_missing",
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 1_000,
        }),
      ),
    ).toBe("unknown_grant");
  });

  it("records spend in integer minor units only", () => {
    const { ledger, grant } = ledgerWithGrant();

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 10.5,
        }),
      ),
    ).toBe("non_integer_minor_units");
  });

  it("is immutable once approved", () => {
    const { grant } = ledgerWithGrant();

    expect(Object.isFrozen(grant)).toBe(true);
    expect(() => {
      (grant as { totalMinorUnits: number }).totalMinorUnits = 1_000_000;
    }).toThrow();
  });

  it("refuses a reservation outside the validity window", () => {
    const { ledger, grant, time } = ledgerWithGrant();
    time.advanceHours(24 * 8);

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 1_000,
        }),
      ),
    ).toBe("grant_expired");
  });
});

describe("hard caps", () => {
  it("enforces the per-creative cap", () => {
    const { ledger, grant } = ledgerWithGrant();
    ledger.reserve({
      grantId: grant.grantId,
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      campaignId: "camp-1",
      amountMinorUnits: 10_000,
    });

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 1,
        }),
      ),
    ).toBe("per_creative_cap_exceeded");
  });

  it("enforces the daily account cap across different creatives", () => {
    const { ledger, grant } = ledgerWithGrant();
    ledger.reserve({
      grantId: grant.grantId,
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      campaignId: "camp-1",
      amountMinorUnits: 10_000,
    });

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_bbbbbbbbbbbbbbbb",
          campaignId: "camp-2",
          amountMinorUnits: 2_001,
        }),
      ),
    ).toBe("daily_account_cap_exceeded");
  });

  it("lets the daily cap recover on the next day while the total cap still binds", () => {
    const { ledger, grant, time } = ledgerWithGrant();
    ledger.reserve({
      grantId: grant.grantId,
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      campaignId: "camp-1",
      amountMinorUnits: 10_000,
    });
    time.advanceHours(24);

    ledger.reserve({
      grantId: grant.grantId,
      creativeId: "cr_bbbbbbbbbbbbbbbb",
      campaignId: "camp-2",
      amountMinorUnits: 10_000,
    });

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_bbbbbbbbbbbbbbbb",
          campaignId: "camp-2",
          amountMinorUnits: 1,
        }),
      ),
    ).toBe("total_cap_exceeded");
  });
});

describe("reservation concurrency", () => {
  it("never lets interleaved provider calls exceed one cap", async () => {
    const { ledger, grant } = ledgerWithGrant({
      totalMinorUnits: 10_000,
      perCreativeMinorUnits: 10_000,
      dailyAccountMinorUnits: 10_000,
    });

    // Each task holds a reservation across an await, which is exactly the
    // window in which a check-then-call design would double-spend.
    const attempt = () =>
      ledger.withReservation(
        {
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 6_000,
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 6_000;
        },
      );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(ledger.committedMinorUnits(grant.grantId)).toBe(6_000);
    expect(ledger.committedMinorUnits(grant.grantId)).toBeLessThanOrEqual(10_000);
  });

  it("releases a reservation when the provider call fails, without spending it", async () => {
    const { ledger, grant } = ledgerWithGrant();

    await expect(
      ledger.withReservation(
        {
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 5_000,
        },
        async () => {
          throw new Error("provider rejected the campaign");
        },
      ),
    ).rejects.toThrow("provider rejected the campaign");

    expect(ledger.committedMinorUnits(grant.grantId)).toBe(0);
    expect(ledger.reservedMinorUnits(grant.grantId)).toBe(0);
  });

  it("settles to the amount the provider actually reports, not the amount requested", async () => {
    const { ledger, grant } = ledgerWithGrant();

    await ledger.withReservation(
      {
        grantId: grant.grantId,
        creativeId: "cr_aaaaaaaaaaaaaaaa",
        campaignId: "camp-1",
        amountMinorUnits: 5_000,
      },
      async () => 4_237,
    );

    expect(ledger.committedMinorUnits(grant.grantId)).toBe(4_237);
    expect(ledger.reservedMinorUnits(grant.grantId)).toBe(0);
  });

  it("refuses a settlement that exceeds what the reservation held", async () => {
    const { ledger, grant } = ledgerWithGrant();

    await expect(
      ledger.withReservation(
        {
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 5_000,
        },
        async () => 9_999,
      ),
    ).rejects.toMatchObject({ code: "settlement_exceeds_reservation" });
  });
});

describe("kill switch and automatic pause", () => {
  it("blocks all further reservations once the kill switch is active", () => {
    const { ledger, grant } = ledgerWithGrant();
    ledger.activateKillSwitch(grant.grantId, "founder stopped all spend");

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 1,
        }),
      ),
    ).toBe("spend_halted");
  });

  it("pauses automatically when tracking health fails", () => {
    const { ledger, grant } = ledgerWithGrant();

    const decision = ledger.evaluateAutoPause(grant.grantId, {
      trackingHealthy: false,
      attributionMappingIntact: true,
      providerPolicyWarning: false,
      rightsValid: true,
      connectionRevoked: false,
      refundRateAnomaly: false,
      stopConditionTriggered: false,
    });

    expect(decision.paused).toBe(true);
    expect(decision.reasons).toContain("tracking_health_failed");
  });

  it("pauses on a broken attribution mapping, revoked connection, or invalid rights", () => {
    const { ledger, grant } = ledgerWithGrant();

    const decision = ledger.evaluateAutoPause(grant.grantId, {
      trackingHealthy: true,
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
        "attribution_mapping_broken",
        "rights_invalid",
        "connection_revoked",
      ]),
    );
  });

  it("does not pause when every guardrail is healthy", () => {
    const { ledger, grant } = ledgerWithGrant();

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

  it("halts spend once the pause is applied", () => {
    const { ledger, grant } = ledgerWithGrant();
    ledger.applyAutoPause(grant.grantId, ["tracking_health_failed"]);

    expect(
      errorCode(() =>
        ledger.reserve({
          grantId: grant.grantId,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          campaignId: "camp-1",
          amountMinorUnits: 1,
        }),
      ),
    ).toBe("spend_halted");
  });
});

describe("no automatic scaling in V1", () => {
  it("returns a recommendation that was not applied and needs a new grant", () => {
    const { ledger, grant } = ledgerWithGrant();

    const proposal = ledger.proposeScale(grant.grantId, {
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      suggestedTotalMinorUnits: 50_000,
      rationale: "CAC is below target across a full D7 cohort",
    });

    expect(proposal.automaticallyApplied).toBe(false);
    expect(proposal.requiresNewSpendGrant).toBe(true);
    expect(ledger.getGrant(grant.grantId)?.totalMinorUnits).toBe(20_000);
  });

  it("has no path that raises a cap on an existing grant", () => {
    const { ledger } = ledgerWithGrant();

    expect(ledger).not.toHaveProperty("increaseBudget");
    expect(ledger).not.toHaveProperty("raiseCap");
  });
});
