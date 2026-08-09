import { createHash } from "node:crypto";
import { createIdFactory, type IdFactoryOptions } from "./ids";
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
  | "rights_not_approved"
  | "disclosure_missing"
  | "attribution_unhealthy"
  | "tracking_unhealthy"
  | "provider_ineligible"
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
}

/** Exactly the fields a human is agreeing to when they approve. */
function materialTerms(input: PaidTestProposalInput) {
  return {
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
  proposalId: string;
  grantId: string;
  creativeId: string;
  network: "tiktok_paid" | "meta_paid";
  adAccountId: string;
  objective: string;
  amountMinorUnits: number;
  campaignId: string;
  idempotencyKey: string;
}

export interface PaidTestOptions extends IdFactoryOptions {}

export function createPaidTestService(options: PaidTestOptions = {}) {
  const now = options.now ?? (() => new Date());
  const mint = createIdFactory(options);
  const proposals = new Map<string, PaidTestProposal>();

  function propose(input: PaidTestProposalInput): PaidTestProposal {
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
    });
    proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  /**
   * Decisions never mutate history. An edited budget produces a new proposal
   * version with its own hash, so the record of what was originally put in front
   * of a human survives.
   */
  function decide(proposalId: string, decision: ProposalDecision): PaidTestProposal {
    const current = proposals.get(proposalId);
    if (!current) throw new PaidTestError("invalid_decision", `unknown proposal ${proposalId}`);
    if (current.status !== "PROPOSED") {
      throw new PaidTestError(
        "invalid_decision",
        `proposal ${proposalId} is already ${current.status}`,
      );
    }
    const at = now();
    if (at > new Date(current.expiresAt)) {
      const expired = Object.freeze({ ...current, status: "EXPIRED" as ProposalStatus });
      proposals.set(proposalId, expired);
      throw new PaidTestError("proposal_expired", `proposal ${proposalId} expired`);
    }

    let next: PaidTestProposal;
    switch (decision.kind) {
      case "approve_exact":
        next = Object.freeze({
          ...current,
          status: "APPROVED" as ProposalStatus,
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
          approvalRef: decision.approvalRef,
        });
        break;
      case "approve_edited_budget": {
        const edited = {
          ...current,
          totalBudgetMinor: decision.totalBudgetMinor,
          dailyCapMinor: decision.dailyCapMinor,
        };
        next = Object.freeze({
          ...edited,
          proposalVersion: current.proposalVersion + 1,
          status: "APPROVED" as ProposalStatus,
          materialHash: hashMaterialTerms(edited),
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
          approvalRef: decision.approvalRef,
        });
        break;
      }
      case "reject":
        next = Object.freeze({
          ...current,
          status: "REJECTED" as ProposalStatus,
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
        });
        break;
      case "request_variants":
        next = Object.freeze({
          ...current,
          status: "VARIANTS_REQUESTED" as ProposalStatus,
          decidedBy: decision.decidedBy,
          decidedAt: at.toISOString(),
        });
        break;
    }
    proposals.set(proposalId, next);
    return next;
  }

  /** Mint the Spend Grant an approved proposal authorises — and only that. */
  function grantInputFor(proposal: PaidTestProposal) {
    if (proposal.status !== "APPROVED") {
      throw new PaidTestError(
        "proposal_not_approved",
        `proposal ${proposal.proposalId} is ${proposal.status}`,
      );
    }
    return {
      ventureId: proposal.ventureId,
      network: proposal.network,
      externalAccountId: proposal.adAccountId,
      currency: proposal.currency,
      totalMinorUnits: proposal.totalBudgetMinor,
      perCreativeMinorUnits: proposal.totalBudgetMinor,
      dailyAccountMinorUnits: proposal.dailyCapMinor,
      perPaidTestMinorUnits: proposal.totalBudgetMinor,
      allowedCreativeIds: [proposal.creativeId],
      approvedBy: proposal.decidedBy!,
      approvalRef: proposal.approvalRef!,
      proposalId: proposal.proposalId,
      notBefore: proposal.startAt,
      expiresAt: proposal.endAt,
    };
  }

  /**
   * The single choke point. Every paid provider mutation passes here first, and
   * anything that fails throws before the adapter is reached.
   */
  function assertAuthorized(request: PaidOperationRequest, grant: SpendGrant | undefined): void {
    const proposal = proposals.get(request.proposalId);
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
    if (proposal.rightsState !== "approved_for_paid") {
      throw new PaidTestError("rights_not_approved", `creative rights are ${proposal.rightsState}`);
    }
    if (proposal.disclosureState === "missing") {
      throw new PaidTestError("disclosure_missing", "a required AI disclosure is missing");
    }
    if (!proposal.trackingHealthy) {
      throw new PaidTestError("tracking_unhealthy", "tracking health check failed");
    }
    if (!proposal.attributionHealthy) {
      throw new PaidTestError("attribution_unhealthy", "attribution mapping is unhealthy");
    }
    if (!proposal.providerEligible) {
      throw new PaidTestError("provider_ineligible", "provider reports the account ineligible");
    }

    if (!grant) {
      throw new PaidTestError(
        "no_spend_grant",
        "no Spend Grant authorises this operation; approval alone does not move money",
      );
    }
    if (grant.proposalId !== proposal.proposalId) {
      throw new PaidTestError(
        "grant_does_not_match_proposal",
        `grant ${grant.grantId} was minted for ${grant.proposalId}`,
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
    if (request.amountMinorUnits > proposal.totalBudgetMinor) {
      throw new PaidTestError(
        "budget_differs_from_approved",
        `${request.amountMinorUnits} exceeds the approved ${proposal.totalBudgetMinor}`,
      );
    }
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
    assertAuthorized(request, ledger.getGrant(request.grantId));
    return ledger.withReservation(
      {
        grantId: request.grantId,
        creativeId: request.creativeId,
        campaignId: request.campaignId,
        amountMinorUnits: request.amountMinorUnits,
        idempotencyKey: request.idempotencyKey,
        network: request.network,
        externalAccountId: request.adAccountId,
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
    getProposal: (proposalId: string): PaidTestProposal | undefined => proposals.get(proposalId),
    listProposals: (): readonly PaidTestProposal[] => [...proposals.values()],
  };
}

export type PaidTestService = ReturnType<typeof createPaidTestService>;
