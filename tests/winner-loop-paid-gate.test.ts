import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaidTestError,
  createPaidTestService,
  createSpendLedger,
  createSqliteSpendStore,
  type PaidOperationRequest,
  type PaidTestProposalInput,
  type SpendStore,
} from "@/lib/winner-loop";

const AT = new Date("2026-08-09T09:00:00.000Z");

const stores: SpendStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function store(): SpendStore {
  const dir = mkdtempSync(join(tmpdir(), "vh-gate-"));
  dirs.push(dir);
  const created = createSqliteSpendStore(join(dir, "spend.db"));
  stores.push(created);
  return created;
}

function proposalInput(overrides: Partial<PaidTestProposalInput> = {}): PaidTestProposalInput {
  return {
    ventureId: "payout-rank",
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    deliveryVariantId: "dv_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    organicPostId: "tt-post-1",
    network: "tiktok_paid",
    adAccountId: "tt-ads-1",
    objective: "conversions",
    optimizationEvent: "trial_start",
    geographies: ["NL"],
    audienceConstraints: [],
    totalBudgetMinor: 10_000,
    dailyCapMinor: 5_000,
    currency: "EUR",
    startAt: "2026-08-09T00:00:00.000Z",
    endAt: "2026-08-16T00:00:00.000Z",
    targetCacMinor: 1_500,
    hardMaxCacMinor: 2_500,
    paybackTargetDays: 60,
    maxSpendWithoutTrialMinor: 3_000,
    maxSpendWithoutPurchaseMinor: 8_000,
    trackingHealthy: true,
    attributionHealthy: true,
    rightsState: "approved_for_paid",
    disclosureState: "present",
    providerEligible: true,
    recommendationId: "rec-1",
    evidence: ["baseline-adjusted score 0.71"],
    createdBy: "winner-loop",
    expiresAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<PaidOperationRequest> = {}): PaidOperationRequest {
  return {
    proposalId: "prop-x",
    grantId: "grant-x",
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    network: "tiktok_paid",
    adAccountId: "tt-ads-1",
    objective: "conversions",
    amountMinorUnits: 5_000,
    campaignId: "camp-1",
    idempotencyKey: `k-${Math.random()}`,
    ...overrides,
  };
}

/** Full happy path: propose, approve, mint grant, and return everything wired. */
function approvedChain(overrides: Partial<PaidTestProposalInput> = {}) {
  const service = createPaidTestService({ now: () => AT });
  const ledger = createSpendLedger({ store: store(), now: () => AT });
  const proposal = service.propose(proposalInput(overrides));
  const approved = service.decide(proposal.proposalId, {
    kind: "approve_exact",
    decidedBy: "founder@example.com",
    approvalRef: "checkpoint:paid-001",
  });
  const grant = ledger.registerGrant(service.grantInputFor(approved));
  return { service, ledger, proposal: approved, grant };
}

describe("the first paid euro requires human approval", () => {
  it("never invokes the provider when the proposal is only proposed", async () => {
    const service = createPaidTestService({ now: () => AT });
    const ledger = createSpendLedger({ store: store(), now: () => AT });
    const proposal = service.propose(proposalInput());
    const adapter = vi.fn();

    await expect(
      service.executePaidOperation(
        request({ proposalId: proposal.proposalId, grantId: "none" }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "proposal_not_approved" });

    expect(adapter).not.toHaveBeenCalled();
  });

  it("never invokes the provider when no Spend Grant exists", async () => {
    const service = createPaidTestService({ now: () => AT });
    const ledger = createSpendLedger({ store: store(), now: () => AT });
    const proposal = service.propose(proposalInput());
    service.decide(proposal.proposalId, {
      kind: "approve_exact",
      decidedBy: "founder@example.com",
      approvalRef: "checkpoint:paid-001",
    });
    const adapter = vi.fn();

    // Approved, but nobody minted a grant. Approval alone moves no money.
    await expect(
      service.executePaidOperation(
        request({ proposalId: proposal.proposalId, grantId: "grant_missing" }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "no_spend_grant" });

    expect(adapter).not.toHaveBeenCalled();
  });

  it("invokes the provider exactly once on the approved path and settles real spend", async () => {
    const { service, ledger, proposal, grant } = approvedChain();
    const adapter = vi.fn(async () => ({ actualSpendMinor: 4_800 }));

    const settled = await service.executePaidOperation(
      request({ proposalId: proposal.proposalId, grantId: grant.grantId }),
      ledger,
      adapter,
    );

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(settled.status).toBe("settled");
    expect(ledger.committedMinorUnits(grant.grantId)).toBe(4_800);
  });
});

describe("the gate rejects every mismatch before the provider is reached", () => {
  const cases: Array<{
    name: string;
    overrides?: Partial<PaidTestProposalInput>;
    mutate?: (r: PaidOperationRequest) => PaidOperationRequest;
    code: string;
  }> = [
    {
      name: "rights are organic only",
      overrides: { rightsState: "organic_only" },
      code: "rights_not_approved",
    },
    { name: "rights expired", overrides: { rightsState: "expired" }, code: "rights_not_approved" },
    {
      name: "disclosure missing",
      overrides: { disclosureState: "missing" },
      code: "disclosure_missing",
    },
    {
      name: "tracking unhealthy",
      overrides: { trackingHealthy: false },
      code: "tracking_unhealthy",
    },
    {
      name: "attribution unhealthy",
      overrides: { attributionHealthy: false },
      code: "attribution_unhealthy",
    },
    {
      name: "provider ineligible",
      overrides: { providerEligible: false },
      code: "provider_ineligible",
    },
    {
      name: "creative differs",
      mutate: (r) => ({ ...r, creativeId: "cr_ZZZZZZZZZZZZZZZZZZZZZZZZZZ" }),
      code: "creative_differs_from_approved",
    },
    {
      name: "network differs",
      mutate: (r) => ({ ...r, network: "meta_paid" }),
      code: "network_differs_from_approved",
    },
    {
      name: "ad account differs",
      mutate: (r) => ({ ...r, adAccountId: "tt-ads-999" }),
      code: "account_differs_from_approved",
    },
    {
      name: "objective differs",
      mutate: (r) => ({ ...r, objective: "reach" }),
      code: "objective_differs_from_approved",
    },
    {
      name: "budget exceeds approval",
      mutate: (r) => ({ ...r, amountMinorUnits: 999_999 }),
      code: "budget_differs_from_approved",
    },
  ];

  for (const testCase of cases) {
    it(`does not reach the provider when ${testCase.name}`, async () => {
      const { service, ledger, proposal, grant } = approvedChain(testCase.overrides);
      const adapter = vi.fn();
      const base = request({ proposalId: proposal.proposalId, grantId: grant.grantId });

      await expect(
        service.executePaidOperation(
          testCase.mutate ? testCase.mutate(base) : base,
          ledger,
          adapter,
        ),
      ).rejects.toMatchObject({ code: testCase.code });

      expect(adapter).not.toHaveBeenCalled();
      expect(ledger.committedMinorUnits(grant.grantId)).toBe(0);
    });
  }

  it("does not reach the provider when the grant belongs to another proposal", async () => {
    const first = approvedChain();
    const second = createPaidTestService({ now: () => AT });
    const otherProposal = second.propose(proposalInput());
    second.decide(otherProposal.proposalId, {
      kind: "approve_exact",
      decidedBy: "founder@example.com",
      approvalRef: "checkpoint:paid-002",
    });
    const adapter = vi.fn();

    await expect(
      second.executePaidOperation(
        request({ proposalId: otherProposal.proposalId, grantId: first.grant.grantId }),
        first.ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "grant_does_not_match_proposal" });

    expect(adapter).not.toHaveBeenCalled();
  });

  it("does not reach the provider once the grant is revoked or exhausted", async () => {
    const { service, ledger, proposal, grant } = approvedChain();
    ledger.revokeGrant(grant.grantId, "connection removed");
    const adapter = vi.fn();

    await expect(
      service.executePaidOperation(
        request({ proposalId: proposal.proposalId, grantId: grant.grantId }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "spend_halted" });

    expect(adapter).not.toHaveBeenCalled();
  });
});

describe("proposal immutability", () => {
  it("keeps approved terms frozen and hashed", () => {
    const { proposal } = approvedChain();
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(proposal.materialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => {
      (proposal as { totalBudgetMinor: number }).totalBudgetMinor = 1;
    }).toThrow();
  });

  it("creates a new version with a new hash when the budget is edited", () => {
    const service = createPaidTestService({ now: () => AT });
    const original = service.propose(proposalInput());
    const edited = service.decide(original.proposalId, {
      kind: "approve_edited_budget",
      decidedBy: "founder@example.com",
      approvalRef: "checkpoint:paid-003",
      totalBudgetMinor: 4_000,
      dailyCapMinor: 2_000,
    });

    expect(edited.proposalVersion).toBe(2);
    expect(edited.totalBudgetMinor).toBe(4_000);
    expect(edited.materialHash).not.toBe(original.materialHash);
    expect(original.totalBudgetMinor).toBe(10_000);
  });

  it("refuses to decide a proposal twice or after expiry", () => {
    const service = createPaidTestService({ now: () => AT });
    const proposal = service.propose(proposalInput());
    service.decide(proposal.proposalId, {
      kind: "reject",
      decidedBy: "founder@example.com",
      reason: "weak evidence",
    });

    expect(() =>
      service.decide(proposal.proposalId, {
        kind: "approve_exact",
        decidedBy: "founder@example.com",
        approvalRef: "x",
      }),
    ).toThrowError(PaidTestError);

    const late = createPaidTestService({ now: () => new Date("2026-09-01T00:00:00.000Z") });
    const stale = late.propose(proposalInput());
    expect(() =>
      late.decide(stale.proposalId, {
        kind: "approve_exact",
        decidedBy: "founder@example.com",
        approvalRef: "x",
      }),
    ).toThrowError(expect.objectContaining({ code: "proposal_expired" }) as never);
  });

  it("mints a grant only from an approved proposal", () => {
    const service = createPaidTestService({ now: () => AT });
    const proposal = service.propose(proposalInput());
    expect(() => service.grantInputFor(proposal)).toThrowError(
      expect.objectContaining({ code: "proposal_not_approved" }) as never,
    );
  });

  it("scopes the minted grant to exactly the approved creative and account", () => {
    const { grant, proposal } = approvedChain();
    expect(grant.allowedCreativeIds).toEqual([proposal.creativeId]);
    expect(grant.externalAccountId).toBe(proposal.adAccountId);
    expect(grant.totalMinorUnits).toBe(proposal.totalBudgetMinor);
    expect(grant.proposalId).toBe(proposal.proposalId);
  });
});
