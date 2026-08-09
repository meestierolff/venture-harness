import { createHash } from "node:crypto";
import {
  assessCreativeCompliance,
  type CreativeCompliancePolicy,
  type CreativeManifestStore,
} from "./creative-manifest";
import { createIdFactory, type IdFactoryOptions } from "./ids";
import {
  createMemoryPaidTestStore,
  type PaidProposalScope,
  type PaidSafetyState,
  type PaidTestStore,
} from "./paid-test-store";
import type { SpendGrant, SpendLedger } from "./spend";

/**
 * Paid tests.
 *
 * A recommendation never creates an ad. It creates a proposal, a human approves
 * that exact proposal, approval mints a Spend Grant, and only a grant authorises
 * the provider mutation. Every step is a separate record so the chain can be
 * audited after the fact:
 *
 *   recommendation -> proposal -> human approval -> Spend Grant
 *     -> reservation -> provider operation -> read-back -> settlement
 *
 * Nothing else confers spend authority: not a Launch Grant, a Customer Service
 * Grant, an Agent Grant, an active subscription, a provider connection, an
 * organic publishing permission, or the Growth Contract.
 */

export type PaidTestErrorCode =
  | "proposal_not_approved"
  | "proposal_expired"
  | "proposal_terms_mutated"
  | "no_spend_grant"
  | "grant_does_not_match_proposal"
  | "budget_differs_from_approved"
  | "account_differs_from_approved"
  | "creative_differs_from_approved"
  | "network_differs_from_approved"
  | "objective_differs_from_approved"
  | "optimization_differs_from_approved"
  | "geography_differs_from_approved"
  | "operation_outside_approved_window"
  | "rights_not_approved"
  | "disclosure_missing"
  | "creative_policy_blocked"
  | "attribution_unhealthy"
  | "tracking_unhealthy"
  | "provider_ineligible"
  | "invalid_proposal"
  | "invalid_decision";

export class PaidTestError extends Error {
  readonly code: PaidTestErrorCode;

  constructor(code: PaidTestErrorCode, message: string) {
    super(message);
    this.name = "PaidTestError";
    this.code = code;
  }
}

export type ProposalStatus =
  "PROPOSED" | "APPROVED" | "REJECTED" | "VARIANTS_REQUESTED" | "EXPIRED";

export type RightsState = "approved_for_paid" | "organic_only" | "blocked" | "expired";
export type DisclosureState = "not_required" | "present" | "missing";

export interface PaidTestProposalInput {
  organizationId: string;
  ventureId: string;
  creativeId: string;
  deliveryVariantId: string;
  organicPostId: string;
  network: "tiktok_paid" | "meta_paid";
  adAccountId: string;
  objective: string;
  optimizationEvent: string;
  geographies: readonly string[];
  audienceConstraints: readonly string[];
  totalBudgetMinor: number;
  dailyCapMinor: number;
  currency: string;
  startAt: string;
  endAt: string;
  targetCacMinor: number;
  hardMaxCacMinor: number;
  paybackTargetDays: number;
  maxSpendWithoutTrialMinor: number;
  maxSpendWithoutPurchaseMinor: number;
  trackingHealthy: boolean;
  attributionHealthy: boolean;
  rightsState: RightsState;
  disclosureState: DisclosureState;
  providerEligible: boolean;
  recommendationId: string;
  evidence: readonly string[];
  createdBy: string;
  expiresAt: string;
}

export interface PaidTestProposal extends Readonly<PaidTestProposalInput> {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly status: ProposalStatus;
  /** Hash over the terms a human approved. Any later change invalidates approval. */
  readonly materialHash: string;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly approvalRef: string | null;
  readonly decisionReason: string | null;
}

/** Exactly the fields a human is agreeing to when they approve. */
function materialTerms(input: PaidTestProposalInput) {
  return {
    organizationId: input.organizationId,
    ventureId: input.ventureId,
    creativeId: input.creativeId,
    deliveryVariantId: input.deliveryVariantId,
    organicPostId: input.organicPostId,
    network: input.network,
    adAccountId: input.adAccountId,
    objective: input.objective,
    optimizationEvent: input.optimizationEvent,
    geographies: [...input.geographies].sort(),
    audienceConstraints: [...input.audienceConstraints].sort(),
    totalBudgetMinor: input.totalBudgetMinor,
    dailyCapMinor: input.dailyCapMinor,
    currency: input.currency,
    startAt: input.startAt,
    endAt: input.endAt,
    targetCacMinor: input.targetCacMinor,
    hardMaxCacMinor: input.hardMaxCacMinor,
    paybackTargetDays: input.paybackTargetDays,
    maxSpendWithoutTrialMinor: input.maxSpendWithoutTrialMinor,
    maxSpendWithoutPurchaseMinor: input.maxSpendWithoutPurchaseMinor,
  };
}

export function hashMaterialTerms(input: PaidTestProposalInput): string {
  return createHash("sha256")
    .update(JSON.stringify(materialTerms(input)))
    .digest("hex");
}

export type ProposalDecision =
  | { kind: "approve_exact"; decidedBy: string; approvalRef: string }
  | {
      kind: "approve_edited_budget";
      decidedBy: string;
      approvalRef: string;
      totalBudgetMinor: number;
      dailyCapMinor: number;
    }
  | { kind: "reject"; decidedBy: string; reason: string }
  | { kind: "request_variants"; decidedBy: string; reason: string };

export interface PaidOperationRequest {
  organizationId: string;
  ventureId: string;
  proposalId: string;
  grantId: string;
  creativeId: string;
  network: "tiktok_paid" | "meta_paid";
  adAccountId: string;
  objective: string;
  optimizationEvent: string;
  geography: string;
  amountMinorUnits: number;
  campaignId: string;
  idempotencyKey: string;
}

export interface SpendGrantPolicyCaps {
  customerId?: string | null;
  dailyVentureMinorUnits: number;
  monthlyVentureMinorUnits: number;
  dailyCustomerMinorUnits: number;
  monthlyCustomerMinorUnits: number;
  emergencyPlatformMinorUnits: number;
}

export interface PaidTestOptions extends IdFactoryOptions {
  store?: PaidTestStore;
  manifestStore?: CreativeManifestStore;
  compliancePolicy?: CreativeCompliancePolicy;
}

export function createPaidTestService(options: PaidTestOptions = {}) {
  const now = options.now ?? (() => new Date());
  const mint = createIdFactory(options);
  const store = options.store ?? createMemoryPaidTestStore();

  function assertProposalInput(input: PaidTestProposalInput): void {
    if (
      !input.organizationId.trim() ||
      !input.ventureId.trim() ||
      !input.creativeId.trim() ||
      !input.deliveryVariantId.trim() ||
      !input.organicPostId.trim() ||
      !input.adAccountId.trim() ||
      !input.objective.trim() ||
      !input.optimizationEvent.trim() ||
      !input.currency.trim() ||
      !input.recommendationId.trim() ||
      !input.createdBy.trim() ||
      input.geographies.length === 0 ||
      input.geographies.some((geography) => !geography.trim()) ||
      input.audienceConstraints.some((constraint) => !constraint.trim()) ||
      input.evidence.length === 0 ||
      input.evidence.some((reference) => !reference.trim())
    ) {
      throw new PaidTestError("invalid_proposal", "paid proposal scope is incomplete");
    }
    if (
      !["approved_for_paid", "organic_only", "blocked", "expired"].includes(input.rightsState) ||
      !["not_required", "present", "missing"].includes(input.disclosureState) ||
      typeof input.trackingHealthy !== "boolean" ||
      typeof input.attributionHealthy !== "boolean" ||
      typeof input.providerEligible !== "boolean"
    ) {
      throw new PaidTestError("invalid_proposal", "paid proposal safety state is invalid");
    }
    const amounts = [
      input.totalBudgetMinor,
      input.dailyCapMinor,
      input.targetCacMinor,
      input.hardMaxCacMinor,
      input.maxSpendWithoutTrialMinor,
      input.maxSpendWithoutPurchaseMinor,
    ];
    if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
      throw new PaidTestError(
        "invalid_proposal",
        "paid proposal money fields must be non-negative integer minor units",
      );
    }
    if (
      input.totalBudgetMinor === 0 ||
      input.dailyCapMinor === 0 ||
      input.dailyCapMinor > input.totalBudgetMinor ||
      input.hardMaxCacMinor < input.targetCacMinor ||
      !Number.isSafeInteger(input.paybackTargetDays) ||
      input.paybackTargetDays <= 0
    ) {
      throw new PaidTestError("invalid_proposal", "paid proposal budget or CAC limits are invalid");
    }
    const start = Date.parse(input.startAt);
    const end = Date.parse(input.endAt);
    const expires = Date.parse(input.expiresAt);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(expires) ||
      start >= end
    ) {
      throw new PaidTestError("invalid_proposal", "paid proposal dates are invalid");
    }
  }

  function propose(input: PaidTestProposalInput): PaidTestProposal {
    assertProposalInput(input);
    const proposal: PaidTestProposal = Object.freeze({
      ...input,
      geographies: Object.freeze([...input.geographies]),
      audienceConstraints: Object.freeze([...input.audienceConstraints]),
      evidence: Object.freeze([...input.evidence]),
      proposalId: mint("prop"),
      proposalVersion: 1,
      status: "PROPOSED" as ProposalStatus,
      materialHash: hashMaterialTerms(input),
      createdAt: now().toISOString(),
      decidedBy: null,
      decidedAt: null,
      approvalRef: null,
      decisionReason: null,
    });
    store.putProposal(proposal);
    store.putSafetyState({
      organizationId: proposal.organizationId,
      ventureId: proposal.ventureId,
      proposalId: proposal.proposalId,
      trackingHealthy: proposal.trackingHealthy,
      attributionHealthy: proposal.attributionHealthy,
      providerEligible: proposal.providerEligible,
      recordedAt: now().toISOString(),
    });
    return proposal;
  }

  /**
   * Decisions never mutate history. An edited budget produces a new proposal
   * version with its own hash, so the record of what was originally put in front
   * of a human survives.
   */
  function decide(
    ref: PaidProposalScope & { proposalId: string },
    decision: ProposalDecision,
  ): PaidTestProposal {
    const current = store.getProposal(ref, ref.proposalId);
    if (!current) throw new PaidTestError("invalid_decision", "unknown proposal");
    if (current.status !== "PROPOSED") {
      throw new PaidTestError(
        "invalid_decision",
        `proposal ${ref.proposalId} is already ${current.status}`,
      );
    }
    const at = now();
    if (at >= new Date(current.expiresAt)) {
      const expired = Object.freeze({ ...current, status: "EXPIRED" as ProposalStatus });
      store.putProposal(expired);
      throw new PaidTestError("proposal_expired", `proposal ${ref.proposalId} expired`);
    }

    let next: PaidTestProposal;
    switch (decision.kind) {
      case "approve_exact":
        if (!decision.decidedBy.trim() || !decision.approvalRef.trim()) {
          throw new PaidTestError(
            "invalid_decision",
            "paid approval requires a human actor and approval reference",
          );
        }
        next = Object.freeze({
          ...current,
          status: "APPROVED" as ProposalStatus,
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
          approvalRef: decision.approvalRef,
          decisionReason: null,
        });
        break;
      case "approve_edited_budget": {
        if (!decision.decidedBy.trim() || !decision.approvalRef.trim()) {
          throw new PaidTestError(
            "invalid_decision",
            "paid approval requires a human actor and approval reference",
          );
        }
        const edited = {
          ...current,
          totalBudgetMinor: decision.totalBudgetMinor,
          dailyCapMinor: decision.dailyCapMinor,
        };
        assertProposalInput(edited);
        next = Object.freeze({
          ...edited,
          proposalVersion: current.proposalVersion + 1,
          status: "APPROVED" as ProposalStatus,
          materialHash: hashMaterialTerms(edited),
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
          approvalRef: decision.approvalRef,
          decisionReason: null,
        });
        break;
      }
      case "reject":
        if (!decision.decidedBy.trim() || !decision.reason.trim()) {
          throw new PaidTestError(
            "invalid_decision",
            "proposal rejection requires a human actor and reason",
          );
        }
        next = Object.freeze({
          ...current,
          status: "REJECTED" as ProposalStatus,
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
          decisionReason: decision.reason,
        });
        break;
      case "request_variants":
        if (!decision.decidedBy.trim() || !decision.reason.trim()) {
          throw new PaidTestError(
            "invalid_decision",
            "variant requests require a human actor and reason",
          );
        }
        next = Object.freeze({
          ...current,
          status: "VARIANTS_REQUESTED" as ProposalStatus,
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
          decisionReason: decision.reason,
        });
        break;
    }
    store.putProposal(next);
    return next;
  }

  /** Mint the Spend Grant an approved proposal authorises — and only that. */
  function grantInputFor(proposal: PaidTestProposal, policyCaps?: SpendGrantPolicyCaps) {
    const current = store.getProposal(proposal, proposal.proposalId);
    if (!current || current.status !== "APPROVED") {
      throw new PaidTestError(
        "proposal_not_approved",
        `proposal ${proposal.proposalId} is ${current?.status ?? "unknown"}`,
      );
    }
    if (
      current.materialHash !== hashMaterialTerms(current) ||
      proposal.materialHash !== current.materialHash ||
      hashMaterialTerms(proposal) !== current.materialHash
    ) {
      throw new PaidTestError(
        "proposal_terms_mutated",
        "the grant request does not match the current approved proposal",
      );
    }
    return {
      organizationId: current.organizationId,
      ventureId: current.ventureId,
      customerId: policyCaps?.customerId,
      network: current.network,
      externalAccountId: current.adAccountId,
      currency: current.currency,
      totalMinorUnits: current.totalBudgetMinor,
      perCreativeMinorUnits: current.totalBudgetMinor,
      dailyAccountMinorUnits: current.dailyCapMinor,
      perPaidTestMinorUnits: current.totalBudgetMinor,
      dailyVentureMinorUnits: policyCaps?.dailyVentureMinorUnits,
      monthlyVentureMinorUnits: policyCaps?.monthlyVentureMinorUnits,
      dailyCustomerMinorUnits: policyCaps?.dailyCustomerMinorUnits,
      monthlyCustomerMinorUnits: policyCaps?.monthlyCustomerMinorUnits,
      emergencyPlatformMinorUnits: policyCaps?.emergencyPlatformMinorUnits,
      allowedCreativeIds: [current.creativeId],
      approvedBy: current.decidedBy!,
      approvalRef: current.approvalRef!,
      proposalId: current.proposalId,
      notBefore: current.startAt,
      expiresAt: current.endAt,
    };
  }

  /**
   * The single choke point. Every paid provider mutation passes here first, and
   * anything that fails throws before the adapter is reached.
   */
  function assertAuthorized(
    request: PaidOperationRequest,
    grant: SpendGrant | undefined,
  ): PaidTestProposal {
    const proposal = store.getProposal(request, request.proposalId);
    if (!proposal) {
      throw new PaidTestError("proposal_not_approved", `unknown proposal ${request.proposalId}`);
    }
    if (proposal.status !== "APPROVED") {
      throw new PaidTestError(
        "proposal_not_approved",
        `proposal ${proposal.proposalId} is ${proposal.status}`,
      );
    }
    if (proposal.materialHash !== hashMaterialTerms(proposal)) {
      throw new PaidTestError(
        "proposal_terms_mutated",
        `proposal ${proposal.proposalId} no longer matches the approved terms`,
      );
    }
    const currentSafety = store.getSafetyState(request, proposal.proposalId);
    if (!currentSafety?.trackingHealthy) {
      throw new PaidTestError("tracking_unhealthy", "tracking health check failed");
    }
    if (!currentSafety.attributionHealthy) {
      throw new PaidTestError("attribution_unhealthy", "attribution mapping is unhealthy");
    }
    if (!currentSafety.providerEligible) {
      throw new PaidTestError("provider_ineligible", "provider reports the account ineligible");
    }

    const at = now();
    if (at < new Date(proposal.startAt) || at >= new Date(proposal.endAt)) {
      throw new PaidTestError(
        "operation_outside_approved_window",
        "paid operation falls outside the approved start/end window",
      );
    }

    if (!grant) {
      throw new PaidTestError(
        "no_spend_grant",
        "no Spend Grant authorises this operation; approval alone does not move money",
      );
    }
    const grantMatchesProposal =
      grant.proposalId === proposal.proposalId &&
      grant.organizationId === proposal.organizationId &&
      grant.ventureId === proposal.ventureId &&
      grant.network === proposal.network &&
      grant.externalAccountId === proposal.adAccountId &&
      grant.currency === proposal.currency &&
      grant.totalMinorUnits === proposal.totalBudgetMinor &&
      grant.perCreativeMinorUnits === proposal.totalBudgetMinor &&
      grant.perPaidTestMinorUnits === proposal.totalBudgetMinor &&
      grant.perCampaignMinorUnits === proposal.totalBudgetMinor &&
      grant.dailyAccountMinorUnits === proposal.dailyCapMinor &&
      grant.allowedCreativeIds.length === 1 &&
      grant.allowedCreativeIds[0] === proposal.creativeId &&
      grant.approvedBy === proposal.decidedBy &&
      grant.approvalRef === proposal.approvalRef &&
      grant.notBefore === proposal.startAt &&
      grant.expiresAt === proposal.endAt;
    if (!grantMatchesProposal) {
      throw new PaidTestError(
        "grant_does_not_match_proposal",
        `grant ${grant.grantId} does not match the current exact approved proposal`,
      );
    }
    if (request.creativeId !== proposal.creativeId) {
      throw new PaidTestError("creative_differs_from_approved", "creative differs from approved");
    }
    if (request.network !== proposal.network) {
      throw new PaidTestError("network_differs_from_approved", "network differs from approved");
    }
    if (request.adAccountId !== proposal.adAccountId) {
      throw new PaidTestError("account_differs_from_approved", "ad account differs from approved");
    }
    if (request.objective !== proposal.objective) {
      throw new PaidTestError("objective_differs_from_approved", "objective differs from approved");
    }
    if (request.optimizationEvent !== proposal.optimizationEvent) {
      throw new PaidTestError(
        "optimization_differs_from_approved",
        "optimisation event differs from approved",
      );
    }
    if (!proposal.geographies.includes(request.geography)) {
      throw new PaidTestError("geography_differs_from_approved", "geography differs from approved");
    }
    if (request.amountMinorUnits > proposal.totalBudgetMinor) {
      throw new PaidTestError(
        "budget_differs_from_approved",
        `${request.amountMinorUnits} exceeds the approved ${proposal.totalBudgetMinor}`,
      );
    }

    const manifest = options.manifestStore?.getCurrent(
      { organizationId: proposal.organizationId, ventureId: proposal.ventureId },
      proposal.creativeId,
    );
    if (!manifest) {
      throw new PaidTestError(
        "rights_not_approved",
        "no current creative manifest authorises paid use",
      );
    }
    if (!options.compliancePolicy) {
      throw new PaidTestError(
        "creative_policy_blocked",
        "no current compliance policy authorises paid use",
      );
    }
    const compliance = assessCreativeCompliance(
      manifest,
      {
        mode: "paid",
        channel: request.network,
        region: request.geography,
        at,
      },
      options.compliancePolicy,
    );
    if (!compliance.allowed) {
      if (compliance.blockers.includes("disclosure_missing")) {
        throw new PaidTestError("disclosure_missing", "a required disclosure is missing");
      }
      if (
        compliance.blockers.some(
          (blocker) =>
            blocker.includes("approval") ||
            blocker.includes("license") ||
            blocker.includes("authorization") ||
            blocker.includes("consent") ||
            blocker.includes("revoked") ||
            blocker.includes("expired"),
        )
      ) {
        throw new PaidTestError(
          "rights_not_approved",
          `current creative rights do not authorise paid use: ${compliance.blockers.join(", ")}`,
        );
      }
      throw new PaidTestError(
        "creative_policy_blocked",
        `current creative policy blocks the operation: ${compliance.blockers.join(", ")}`,
      );
    }
    return proposal;
  }

  function recordSafetyState(
    ref: PaidProposalScope & { proposalId: string },
    state: Omit<PaidSafetyState, "organizationId" | "ventureId" | "proposalId" | "recordedAt">,
  ): PaidSafetyState {
    if (!store.getProposal(ref, ref.proposalId)) {
      throw new PaidTestError("invalid_decision", "unknown proposal");
    }
    const recorded = Object.freeze({
      organizationId: ref.organizationId,
      ventureId: ref.ventureId,
      proposalId: ref.proposalId,
      ...state,
      recordedAt: now().toISOString(),
    });
    store.putSafetyState(recorded);
    return recorded;
  }

  /**
   * Run a paid provider operation. Authorisation is checked, then budget is
   * reserved, and only then is the adapter invoked. The adapter returns the
   * spend the provider actually reports, which settles the reservation.
   */
  async function executePaidOperation(
    request: PaidOperationRequest,
    ledger: SpendLedger,
    adapter: (request: PaidOperationRequest) => Promise<{ actualSpendMinor: number }>,
  ) {
    const proposal = assertAuthorized(
      request,
      ledger.getGrant({ ...request, grantId: request.grantId }),
    );
    return ledger.withReservation(
      {
        organizationId: request.organizationId,
        ventureId: request.ventureId,
        grantId: request.grantId,
        creativeId: request.creativeId,
        campaignId: request.campaignId,
        amountMinorUnits: request.amountMinorUnits,
        idempotencyKey: request.idempotencyKey,
        network: request.network,
        externalAccountId: request.adAccountId,
        currency: proposal.currency,
      },
      async () => (await adapter(request)).actualSpendMinor,
    );
  }

  return {
    propose,
    decide,
    grantInputFor,
    assertAuthorized,
    executePaidOperation,
    recordSafetyState,
    getProposal: (ref: PaidProposalScope & { proposalId: string }): PaidTestProposal | undefined =>
      store.getProposal(ref, ref.proposalId),
    listProposals: (scope: PaidProposalScope): readonly PaidTestProposal[] =>
      store.listProposals(scope),
    listProposalHistory: (
      ref: PaidProposalScope & { proposalId: string },
    ): readonly PaidTestProposal[] => store.listProposalHistory(ref, ref.proposalId),
    store,
  };
}

export type PaidTestService = ReturnType<typeof createPaidTestService>;
