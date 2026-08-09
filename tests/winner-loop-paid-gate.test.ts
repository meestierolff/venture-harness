import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaidTestError,
  assessCreativeCompliance,
  createMemoryCreativeManifestStore,
  createPaidTestService,
  createSpendLedger,
  createSqliteCreativeManifestStore,
  createSqlitePaidTestStore,
  createSqliteSpendStore,
  type CreativeManifestInput,
  type CreativeManifestStore,
  type PaidOperationRequest,
  type PaidTestStore,
  type PaidTestProposalInput,
  type SpendStore,
} from "@/lib/winner-loop";

const AT = new Date("2026-08-09T09:00:00.000Z");
const ORGANIZATION = "org-payout-rank";
const PAID_COMPLIANCE_POLICY = {
  disclosureRequired: true,
  allowedRegions: ["NL"],
  allowedChannels: ["tiktok_paid"] as const,
  prohibitedClaims: ["guaranteed income", "risk-free returns"],
};

const stores: SpendStore[] = [];
const manifestStores: CreativeManifestStore[] = [];
const paidStores: PaidTestStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (manifestStores.length) manifestStores.pop()!.close();
  while (paidStores.length) paidStores.pop()!.close();
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

function manifestInput(
  proposal: PaidTestProposalInput,
  overrides: Partial<CreativeManifestInput> = {},
): CreativeManifestInput {
  return {
    organizationId: proposal.organizationId,
    ventureId: proposal.ventureId,
    creativeId: proposal.creativeId,
    creativeFamilyId: "fam-001",
    hypothesis: "A concrete payout comparison creates qualified intent.",
    scriptVersion: "script-v1",
    promptVersion: "prompt-v1",
    storyboardRef: "asset://storyboard/1",
    sourceAssetIds: [],
    recordingRefs: [],
    avatarSource: null,
    voiceSource: null,
    mediaLicenses: [],
    testimonialSubjectIds: [],
    testimonialConsents: [],
    creatorIds: [],
    creatorAuthorizations: [],
    aiGenerated: true,
    disclosure: {
      required: true,
      present: proposal.disclosureState !== "missing",
      text: proposal.disclosureState === "missing" ? null : "AI-assisted creative",
      evidenceRef: proposal.disclosureState === "missing" ? null : "audit://disclosure/1",
    },
    permittedRegions: ["NL"],
    permittedChannels: ["tiktok_paid"],
    organicApproved: true,
    paidApproved: proposal.rightsState === "approved_for_paid",
    expiresAt:
      proposal.rightsState === "expired" ? "2026-08-08T12:00:00.000Z" : "2026-08-20T00:00:00.000Z",
    claims: [],
    prohibitedClaims: [],
    truthReferences: ["truth://creative/1"],
    reviewedBy: "rights-reviewer@example.com",
    reviewEventId: "rights-review-1",
    reviewedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function proposalInput(overrides: Partial<PaidTestProposalInput> = {}): PaidTestProposalInput {
  return {
    organizationId: ORGANIZATION,
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
    organizationId: ORGANIZATION,
    ventureId: "payout-rank",
    proposalId: "prop-x",
    grantId: "grant-x",
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    network: "tiktok_paid",
    adAccountId: "tt-ads-1",
    objective: "conversions",
    optimizationEvent: "trial_start",
    geography: "NL",
    amountMinorUnits: 5_000,
    campaignId: "camp-1",
    idempotencyKey: `k-${Math.random()}`,
    ...overrides,
  };
}

/** Full happy path: propose, approve, mint grant, and return everything wired. */
function approvedChain(overrides: Partial<PaidTestProposalInput> = {}) {
  const manifests = createMemoryCreativeManifestStore();
  const service = createPaidTestService({
    now: () => AT,
    manifestStore: manifests,
    compliancePolicy: PAID_COMPLIANCE_POLICY,
  });
  const ledger = createSpendLedger({ store: store(), now: () => AT });
  const proposal = service.propose(proposalInput(overrides));
  manifests.put(manifestInput(proposal));
  const approved = service.decide(proposal, {
    kind: "approve_exact",
    decidedBy: "founder@example.com",
    approvalRef: "checkpoint:paid-001",
  });
  const grant = ledger.registerGrant(service.grantInputFor(approved));
  return { service, ledger, proposal: approved, grant, manifests };
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
    service.decide(proposal, {
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
    expect(ledger.committedMinorUnits(grant)).toBe(4_800);
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
      name: "optimisation event differs",
      mutate: (r) => ({ ...r, optimizationEvent: "purchase" }),
      code: "optimization_differs_from_approved",
    },
    {
      name: "geography differs",
      mutate: (r) => ({ ...r, geography: "US" }),
      code: "geography_differs_from_approved",
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
      expect(ledger.committedMinorUnits(grant)).toBe(0);
    });
  }

  it("does not reach the provider when the grant belongs to another proposal", async () => {
    const first = approvedChain();
    const second = createPaidTestService({ now: () => AT });
    const otherProposal = second.propose(proposalInput());
    second.decide(otherProposal, {
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
    ledger.revokeGrant(grant, "connection removed");
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

  it("cannot mint a larger grant from a forged clone of an approved proposal", () => {
    const { service, proposal } = approvedChain();
    expect(() => service.grantInputFor({ ...proposal, totalBudgetMinor: 999_999 })).toThrowError(
      expect.objectContaining({ code: "proposal_terms_mutated" }) as never,
    );
  });

  it("rejects invalid budget, CAC, and date terms before persistence", () => {
    const service = createPaidTestService({ now: () => AT });
    expect(() => service.propose(proposalInput({ dailyCapMinor: 20_000 }))).toThrowError(
      expect.objectContaining({ code: "invalid_proposal" }) as never,
    );
    expect(() => service.propose(proposalInput({ hardMaxCacMinor: 1_000 }))).toThrowError(
      expect.objectContaining({ code: "invalid_proposal" }) as never,
    );
    expect(() =>
      service.propose(
        proposalInput({
          startAt: "2026-08-16T00:00:00.000Z",
          endAt: "2026-08-09T00:00:00.000Z",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_proposal" }) as never);
  });

  it("rejects incomplete proposal evidence and empty human approval evidence", () => {
    const service = createPaidTestService({ now: () => AT });
    expect(() => service.propose(proposalInput({ organicPostId: "" }))).toThrowError(
      expect.objectContaining({ code: "invalid_proposal" }) as never,
    );
    expect(() => service.propose(proposalInput({ evidence: [] }))).toThrowError(
      expect.objectContaining({ code: "invalid_proposal" }) as never,
    );
    const proposal = service.propose(proposalInput());
    expect(() =>
      service.decide(proposal, {
        kind: "approve_exact",
        decidedBy: "",
        approvalRef: "",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_decision" }) as never);
  });

  it("creates a new version with a new hash when the budget is edited", () => {
    const service = createPaidTestService({ now: () => AT });
    const original = service.propose(proposalInput());
    const edited = service.decide(original, {
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
    service.decide(proposal, {
      kind: "reject",
      decidedBy: "founder@example.com",
      reason: "weak evidence",
    });

    expect(() =>
      service.decide(proposal, {
        kind: "approve_exact",
        decidedBy: "founder@example.com",
        approvalRef: "x",
      }),
    ).toThrowError(PaidTestError);

    const late = createPaidTestService({ now: () => new Date("2026-09-01T00:00:00.000Z") });
    const stale = late.propose(proposalInput());
    expect(() =>
      late.decide(stale, {
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

  it("rejects a forged larger grant even when it names the approved proposal", async () => {
    const { service, ledger, proposal } = approvedChain();
    const forged = ledger.registerGrant({
      ...service.grantInputFor(proposal),
      totalMinorUnits: proposal.totalBudgetMinor * 2,
      perCreativeMinorUnits: proposal.totalBudgetMinor * 2,
      perPaidTestMinorUnits: proposal.totalBudgetMinor * 2,
      perCampaignMinorUnits: proposal.totalBudgetMinor * 2,
    });
    const adapter = vi.fn();

    await expect(
      service.executePaidOperation(
        request({ proposalId: proposal.proposalId, grantId: forged.grantId }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "grant_does_not_match_proposal" });
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe("durable creative rights and current-state authorization", () => {
  it("persists a complete rights manifest with licence, consent, creator, and review evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-manifest-"));
    dirs.push(dir);
    const path = join(dir, "winner-loop.db");
    const first = createSqliteCreativeManifestStore(path);
    manifestStores.push(first);
    const proposal = proposalInput();
    const permissions = {
      evidenceRef: "audit://rights/evidence-1",
      permitsOrganic: true,
      permitsPaid: true,
      permittedRegions: ["NL"],
      permittedChannels: ["tiktok_paid"] as const,
      expiresAt: "2026-08-20T00:00:00.000Z",
      revokedAt: null,
    };
    first.put(
      manifestInput(proposal, {
        sourceAssetIds: ["asset-1"],
        mediaLicenses: [
          {
            ...permissions,
            subjectId: "licensor-1",
            assetId: "asset-1",
            licenseType: "commercial-paid-social",
          },
        ],
        testimonialSubjectIds: ["testimonial-1"],
        testimonialConsents: [{ ...permissions, subjectId: "testimonial-1" }],
        creatorIds: ["creator-1"],
        creatorAuthorizations: [{ ...permissions, subjectId: "creator-1" }],
      }),
    );
    first.close();
    manifestStores.splice(manifestStores.indexOf(first), 1);

    const reopened = createSqliteCreativeManifestStore(path);
    manifestStores.push(reopened);
    const current = reopened.getCurrent(
      { organizationId: proposal.organizationId, ventureId: proposal.ventureId },
      proposal.creativeId,
    )!;
    expect(current.manifestVersion).toBe(1);
    expect(current.reviewEventId).toBe("rights-review-1");
    expect(
      assessCreativeCompliance(current, {
        mode: "paid",
        channel: "tiktok_paid",
        region: "NL",
        at: AT,
      }),
    ).toMatchObject({ allowed: true, blockers: [] });
  });

  it("fails closed across every required rights and compliance dimension", () => {
    const manifests = createMemoryCreativeManifestStore();
    const proposal = proposalInput();
    const invalid = manifests.put(
      manifestInput(proposal, {
        sourceAssetIds: ["asset-unlicensed"],
        mediaLicenses: [],
        testimonialSubjectIds: ["testimonial-without-consent"],
        testimonialConsents: [],
        creatorIds: ["creator-without-authorization"],
        creatorAuthorizations: [],
        disclosure: { required: true, present: false, text: null, evidenceRef: null },
        permittedRegions: ["US"],
        permittedChannels: ["meta_paid"],
        paidApproved: false,
        expiresAt: "2026-08-08T00:00:00.000Z",
        claims: ["guaranteed income"],
        prohibitedClaims: ["guaranteed income"],
        reviewedBy: "",
        reviewEventId: "",
      }),
    );
    const assessment = assessCreativeCompliance(invalid, {
      mode: "paid",
      channel: "tiktok_paid",
      region: "NL",
      at: AT,
    });
    expect(assessment.allowed).toBe(false);
    expect(assessment.blockers).toEqual(
      expect.arrayContaining([
        "reviewer_missing",
        "review_event_missing",
        "manifest_expired",
        "region_not_permitted",
        "channel_not_permitted",
        "paid_approval_missing",
        "license_missing:asset-unlicensed",
        "testimonial_consent_missing:testimonial-without-consent",
        "creator_authorization_missing:creator-without-authorization",
        "disclosure_missing",
        "prohibited_claim_present",
      ]),
    );
  });

  it("fails closed on malformed expiry and empty rights evidence references", () => {
    const proposal = proposalInput();
    const base = manifestInput(proposal);
    const malformed = {
      ...base,
      expiresAt: "not-a-date",
      sourceAssetIds: ["asset-1"],
      mediaLicenses: [
        {
          subjectId: "licensor-1",
          assetId: "asset-1",
          licenseType: "commercial",
          evidenceRef: "",
          permitsOrganic: true,
          permitsPaid: true,
          permittedRegions: ["NL"],
          permittedChannels: ["tiktok_paid" as const],
          expiresAt: null,
          revokedAt: null,
        },
      ],
      manifestVersion: 1,
      revokedAt: null,
      revocationReason: null,
    };

    expect(
      assessCreativeCompliance(malformed, {
        mode: "paid",
        channel: "tiktok_paid",
        region: "NL",
        at: AT,
      }),
    ).toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining(["manifest_expiry_invalid", "license_invalid:asset-1"]),
    });
  });

  it("re-reads revocation immediately before the paid provider operation", async () => {
    const { service, ledger, proposal, grant, manifests } = approvedChain();
    manifests.revoke({
      organizationId: proposal.organizationId,
      ventureId: proposal.ventureId,
      creativeId: proposal.creativeId,
      reason: "creator withdrew paid authorization",
      reviewedBy: "rights-reviewer@example.com",
      reviewEventId: "rights-revocation-2",
      revokedAt: AT.toISOString(),
    });
    expect(() =>
      manifests.put(manifestInput(proposal, { reviewEventId: "attempted-reactivation" })),
    ).toThrow(/cannot be silently reactivated/);
    const adapter = vi.fn();
    await expect(
      service.executePaidOperation(
        request({ proposalId: proposal.proposalId, grantId: grant.grantId }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "rights_not_approved" });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("re-reads prohibited claims and disclosure policy from the latest manifest version", async () => {
    const { service, ledger, proposal, grant, manifests } = approvedChain();
    manifests.put(
      manifestInput(proposal, {
        reviewEventId: "rights-review-2",
        claims: ["guaranteed income"],
        prohibitedClaims: [],
      }),
    );
    const adapter = vi.fn();
    await expect(
      service.executePaidOperation(
        request({ proposalId: proposal.proposalId, grantId: grant.grantId }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "creative_policy_blocked" });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("re-reads durable tracking and attribution health before every operation", async () => {
    const { service, ledger, proposal, grant } = approvedChain();
    service.recordSafetyState(proposal, {
      trackingHealthy: false,
      attributionHealthy: true,
      providerEligible: true,
    });
    const adapter = vi.fn();
    await expect(
      service.executePaidOperation(
        request({ proposalId: proposal.proposalId, grantId: grant.grantId }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "tracking_unhealthy" });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("reloads an approved proposal after restart and enforces its operation window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-proposal-"));
    dirs.push(dir);
    const path = join(dir, "winner-loop.db");
    const manifests = createMemoryCreativeManifestStore();
    const firstStore = createSqlitePaidTestStore(path);
    paidStores.push(firstStore);
    const first = createPaidTestService({
      now: () => AT,
      store: firstStore,
      manifestStore: manifests,
      compliancePolicy: PAID_COMPLIANCE_POLICY,
    });
    const proposed = first.propose(proposalInput());
    manifests.put(manifestInput(proposed));
    const approved = first.decide(proposed, {
      kind: "approve_exact",
      decidedBy: "founder@example.com",
      approvalRef: "checkpoint:durable-proposal",
    });
    const ledger = createSpendLedger({ store: store(), now: () => AT });
    const grant = ledger.registerGrant(first.grantInputFor(approved));
    firstStore.close();
    paidStores.splice(paidStores.indexOf(firstStore), 1);

    const reopenedStore = createSqlitePaidTestStore(path);
    paidStores.push(reopenedStore);
    const late = createPaidTestService({
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      store: reopenedStore,
      manifestStore: manifests,
      compliancePolicy: PAID_COMPLIANCE_POLICY,
    });
    expect(late.getProposal(approved)?.status).toBe("APPROVED");
    const adapter = vi.fn();
    await expect(
      late.executePaidOperation(
        request({ proposalId: approved.proposalId, grantId: grant.grantId }),
        ledger,
        adapter,
      ),
    ).rejects.toMatchObject({ code: "operation_outside_approved_window" });
    expect(adapter).not.toHaveBeenCalled();
    expect(late.listProposalHistory(approved)).toHaveLength(2);
  });

  it("isolates identical proposal IDs and histories across independent organization clients", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-proposal-organizations-"));
    dirs.push(dir);
    const path = join(dir, "winner-loop.db");
    const firstStore = createSqlitePaidTestStore(path);
    const secondStore = createSqlitePaidTestStore(path);
    paidStores.push(firstStore, secondStore);
    const fixedRandom = (size: number) =>
      Uint8Array.from({ length: size }, (_, index) => (index * 5 + 3) % 256);
    const first = createPaidTestService({
      store: firstStore,
      now: () => AT,
      randomBytes: fixedRandom,
    });
    const second = createPaidTestService({
      store: secondStore,
      now: () => AT,
      randomBytes: fixedRandom,
    });
    const firstProposal = first.propose(
      proposalInput({ organizationId: "org-boundary", ventureId: "venture" }),
    );
    const secondProposal = second.propose(
      proposalInput({ organizationId: "org", ventureId: "boundary-venture" }),
    );

    expect(secondProposal.proposalId).toBe(firstProposal.proposalId);
    expect(secondProposal.materialHash).not.toBe(firstProposal.materialHash);
    first.decide(firstProposal, {
      kind: "approve_exact",
      decidedBy: "founder@example.com",
      approvalRef: "checkpoint:first-organization",
    });
    expect(first.getProposal(firstProposal)?.status).toBe("APPROVED");
    expect(second.getProposal(secondProposal)?.status).toBe("PROPOSED");
    expect(first.listProposalHistory(firstProposal)).toHaveLength(2);
    expect(second.listProposalHistory(secondProposal)).toHaveLength(1);
    expect(
      first.getProposal({
        organizationId: "unconfigured-organization",
        ventureId: firstProposal.ventureId,
        proposalId: firstProposal.proposalId,
      }),
    ).toBeUndefined();
  });
});
