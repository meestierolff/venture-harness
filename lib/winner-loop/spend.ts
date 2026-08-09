import { createHash } from "node:crypto";
import {
  createWinnerLiveProviderAdapters,
  type WinnerLiveProviderAdapter,
  type WinnerLiveProviderContext,
  type WinnerLiveProviderDiagnostic,
  type WinnerLivePaidAuthorizationStore,
  type WinnerLiveProviderPlan,
} from "../winner-integrations/live-providers";
import { createIdFactory, type IdFactoryOptions } from "./ids";
import {
  createMemorySpendStore,
  type CapUsage,
  type ProviderPauseObligationState,
  type ProviderPauseReadBackState,
  type SpendScope,
  type SpendStore,
  type StoredGrant,
  type StoredIncident,
  type StoredProviderPauseObligation,
  type StoredReservation,
} from "./spend-store";

/**
 * Spend safety.
 *
 * The rule this file enforces: the first paid euro requires its own explicit
 * human approval. A Launch Grant, a Customer Service Grant, an Agent Grant, an
 * active subscription, a provider connection, a winner recommendation, and a
 * Growth Contract authorise none of it — only an active matching Spend Grant
 * does.
 *
 * Atomicity is delegated to the store's transaction, not to JavaScript being
 * single-threaded, because reservations are taken by workers that share nothing
 * but the database.
 */

export type SpendErrorCode =
  | "unknown_grant"
  | "invalid_grant"
  | "unknown_reservation"
  | "unknown_pause_obligation"
  | "spend_halted"
  | "grant_expired"
  | "grant_not_yet_valid"
  | "grant_revoked"
  | "creative_not_in_grant"
  | "currency_mismatch"
  | "network_mismatch"
  | "account_mismatch"
  | "non_integer_minor_units"
  | "non_positive_amount"
  | "idempotency_conflict"
  | "cap_exceeded"
  | "settlement_exceeds_reservation"
  | "reservation_not_held"
  | "release_requires_confirmed_no_write"
  | "provider_outcome_unknown"
  | "provider_replay_blocked"
  | "reconciliation_conflict";

/** Which cap rejected a reservation, when the code is cap_exceeded. */
export type SpendCap = keyof CapUsage;

export class SpendError extends Error {
  readonly code: SpendErrorCode;
  readonly cap?: SpendCap;

  constructor(code: SpendErrorCode, message: string, cap?: SpendCap) {
    super(message);
    this.name = "SpendError";
    this.code = code;
    this.cap = cap;
  }
}

/**
 * The only adapter error that proves headroom can be released immediately.
 * Every untyped error is ambiguous by design: timeouts and connection failures
 * can happen after a provider committed a write.
 */
export class ProviderOperationError extends Error {
  readonly writeDisposition: "confirmed_no_write" | "ambiguous" | "write_may_have_succeeded";

  constructor(writeDisposition: ProviderOperationError["writeDisposition"], message: string) {
    super(message);
    this.name = "ProviderOperationError";
    this.writeDisposition = writeDisposition;
  }
}

export type AutoPauseReason =
  | "tracking_health_failed"
  | "attribution_mapping_broken"
  | "provider_policy_warning"
  | "hard_budget_reached"
  | "stop_condition_triggered"
  | "refund_rate_anomaly"
  | "rights_invalid"
  | "disclosure_violation"
  | "connection_revoked";

export interface AutoPauseSignals {
  trackingHealthy: boolean;
  attributionMappingIntact: boolean;
  providerPolicyWarning: boolean;
  rightsValid: boolean;
  disclosureCompliant: boolean;
  connectionRevoked: boolean;
  refundRateAnomaly: boolean;
  stopConditionTriggered: boolean;
}

export interface AutoPauseDecision {
  readonly paused: boolean;
  readonly reasons: readonly AutoPauseReason[];
}

export interface SpendGrantInput {
  organizationId: string;
  ventureId: string;
  customerId?: string | null;
  network: "tiktok_paid" | "meta_paid";
  externalAccountId: string;
  currency: string;
  totalMinorUnits: number;
  perCreativeMinorUnits: number;
  dailyAccountMinorUnits: number;
  /** Default to the grant total when omitted, i.e. non-binding. */
  perPaidTestMinorUnits?: number;
  perCampaignMinorUnits?: number;
  dailyVentureMinorUnits?: number;
  monthlyVentureMinorUnits?: number;
  dailyCustomerMinorUnits?: number;
  monthlyCustomerMinorUnits?: number;
  emergencyPlatformMinorUnits?: number;
  allowedCreativeIds: readonly string[];
  approvedBy: string;
  approvalRef: string;
  /** The approved PaidTestProposal this grant was minted from. */
  proposalId: string;
  notBefore: string;
  expiresAt: string;
}

type GrantIntegrityMaterial = Required<Omit<SpendGrantInput, "customerId">> & {
  readonly customerId: string | null;
};

function grantIntegrityMaterial(input: SpendGrantInput | SpendGrant): GrantIntegrityMaterial {
  return {
    organizationId: input.organizationId,
    ventureId: input.ventureId,
    customerId: input.customerId ?? null,
    network: input.network,
    externalAccountId: input.externalAccountId,
    currency: input.currency,
    totalMinorUnits: input.totalMinorUnits,
    perCreativeMinorUnits: input.perCreativeMinorUnits,
    dailyAccountMinorUnits: input.dailyAccountMinorUnits,
    perPaidTestMinorUnits: input.perPaidTestMinorUnits ?? input.totalMinorUnits,
    perCampaignMinorUnits: input.perCampaignMinorUnits ?? input.totalMinorUnits,
    dailyVentureMinorUnits: input.dailyVentureMinorUnits ?? input.totalMinorUnits,
    monthlyVentureMinorUnits: input.monthlyVentureMinorUnits ?? input.totalMinorUnits,
    dailyCustomerMinorUnits: input.dailyCustomerMinorUnits ?? input.totalMinorUnits,
    monthlyCustomerMinorUnits: input.monthlyCustomerMinorUnits ?? input.totalMinorUnits,
    emergencyPlatformMinorUnits: input.emergencyPlatformMinorUnits ?? input.totalMinorUnits,
    allowedCreativeIds: Object.freeze([...input.allowedCreativeIds]),
    approvedBy: input.approvedBy,
    approvalRef: input.approvalRef,
    proposalId: input.proposalId,
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
  };
}

function spendGrantHash(input: SpendGrantInput | SpendGrant): string {
  return createHash("sha256")
    .update(JSON.stringify(grantIntegrityMaterial(input)))
    .digest("hex");
}

export type SpendGrant = Readonly<StoredGrant>;
export type Reservation = Readonly<StoredReservation>;
export type ReservationStatus = StoredReservation["status"];
export type ProviderPauseObligation = Readonly<StoredProviderPauseObligation>;

export interface ProviderPauseProcessResult {
  readonly obligation: ProviderPauseObligation;
  readonly state: ProviderPauseObligationState;
  /** True only after a provider read-back satisfies the pause invariant. */
  readonly complete: boolean;
  /** The adapter apply path was entered during this call; never true on reconciliation replay. */
  readonly applyAttempted: boolean;
  readonly reconciled: boolean;
  readonly providerInvoked: boolean;
  readonly diagnosticCode: string | null;
}

export interface ReserveInput {
  organizationId: string;
  ventureId: string;
  grantId: string;
  creativeId: string;
  campaignId: string;
  amountMinorUnits: number;
  /** Repeating a key returns the original reservation instead of a second one. */
  idempotencyKey: string;
  paidTestId?: string;
  network?: "tiktok_paid" | "meta_paid";
  externalAccountId?: string;
  currency?: string;
}

export interface SpendGrantRef extends SpendScope {
  grantId: string;
}

export interface SpendReservationRef extends SpendScope {
  reservationId: string;
}

export interface ProviderPauseObligationRef extends SpendScope {
  obligationId: string;
}

export interface ScaleProposal {
  readonly grantId: string;
  readonly creativeId: string;
  readonly suggestedTotalMinorUnits: number;
  readonly rationale: string;
  readonly automaticallyApplied: false;
  readonly requiresNewSpendGrant: true;
  readonly proposedAt: string;
}

export interface SpendLedgerOptions extends IdFactoryOptions {
  store?: SpendStore;
  /** No provider calls exist unless this injected adapter is supplied. */
  providerPauseAdapter?: WinnerLiveProviderAdapter;
}

type ProviderPauseReason = AutoPauseReason | "provider_overspend";

function assertMinorUnits(amount: number): void {
  if (!Number.isSafeInteger(amount)) {
    throw new SpendError(
      "non_integer_minor_units",
      `spend must be recorded in integer minor units; received ${amount}`,
    );
  }
  if (amount <= 0) {
    throw new SpendError("non_positive_amount", `spend must be positive; received ${amount}`);
  }
}

export function createSpendLedger(options: SpendLedgerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createMemorySpendStore();
  const mint = createIdFactory(options);
  const pausePlanner = createWinnerLiveProviderAdapters().tiktok_spark_ads;
  const pauseExecutor = options.providerPauseAdapter;

  function pauseHash(parts: readonly unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  function buildProviderPauseObligation(
    grant: SpendGrant,
    campaignId: string | null,
    reasons: readonly ProviderPauseReason[],
    incidentIds: readonly string[],
    observedSpendMinor: number,
    at: string,
  ): StoredProviderPauseObligation {
    const normalizedCampaignId = campaignId?.trim() || null;
    const target = normalizedCampaignId ?? "missing-campaign";
    const binding = pauseHash([
      grant.organizationId,
      grant.ventureId,
      grant.grantId,
      grant.externalAccountId,
      target,
    ]);
    const base = {
      obligationId: `ppo_${binding.slice(0, 26)}`,
      grantId: grant.grantId,
      organizationId: grant.organizationId,
      ventureId: grant.ventureId,
      network: grant.network,
      externalAccountId: grant.externalAccountId,
      campaignId: normalizedCampaignId,
      reasons: [...reasons],
      incidentIds: [...incidentIds],
      attemptCount: 0,
      providerOperationId: null,
      evidenceJson: null,
      createdAt: at,
      updatedAt: at,
      lastAttemptedAt: null,
      lastApplyState: null,
      lastReadBackState: null,
      lastReadBackAt: null,
      lastReconciledAt: null,
      verifiedAt: null,
    } as const;
    if (grant.network !== "tiktok_paid") {
      return {
        ...base,
        providerAdapterId: null,
        operationId: null,
        idempotencyKey: null,
        requestHash: null,
        payloadJson: null,
        state: "blocked",
        lastDiagnosticCode: "feature_unavailable",
        lastDiagnosticMessage:
          "No typed provider campaign-pause adapter is configured for this network",
      };
    }
    if (!normalizedCampaignId || reasons.length === 0 || incidentIds.length === 0) {
      return {
        ...base,
        providerAdapterId: "tiktok_spark_ads",
        operationId: null,
        idempotencyKey: null,
        requestHash: null,
        payloadJson: null,
        state: "blocked",
        lastDiagnosticCode: "invalid_request",
        lastDiagnosticMessage:
          "A campaign identity, pause reason, and incident binding are required",
      };
    }

    try {
      const operationId = `pause_${binding.slice(0, 26)}`;
      const idempotencyKey = `winner-pause:${binding}`;
      const plan = pausePlanner.plan({
        organizationId: grant.organizationId,
        ventureId: grant.ventureId,
        providerAccountId: grant.externalAccountId,
        operationId,
        idempotencyKey,
        feature: "ads.campaign.pause",
        payload: {
          operation: "pause_campaign",
          campaign_id: normalizedCampaignId,
          advertiser_id: grant.externalAccountId,
          pause_reason: reasons[0],
          incident_ref: incidentIds[0],
          observed_spend_minor: observedSpendMinor,
          currency: grant.currency,
          requested_at: at,
        },
      });
      return {
        ...base,
        providerAdapterId: "tiktok_spark_ads",
        operationId,
        idempotencyKey,
        requestHash: plan.requestHash,
        payloadJson: JSON.stringify(plan.payload),
        state: "pending",
        lastDiagnosticCode: null,
        lastDiagnosticMessage: null,
      };
    } catch {
      // Invalid provider identifiers must never prevent the local fail-closed halt.
      return {
        ...base,
        providerAdapterId: "tiktok_spark_ads",
        operationId: null,
        idempotencyKey: null,
        requestHash: null,
        payloadJson: null,
        state: "blocked",
        lastDiagnosticCode: "invalid_request",
        lastDiagnosticMessage: "The campaign identity could not form a safe pause request",
      };
    }
  }

  function pauseIncident(
    grant: SpendGrant,
    reason: AutoPauseReason,
    recordedAt: string,
  ): StoredIncident {
    return {
      incidentId: `inc_pause_${pauseHash([grant.organizationId, grant.ventureId, grant.grantId, reason]).slice(0, 24)}`,
      grantId: grant.grantId,
      organizationId: grant.organizationId,
      ventureId: grant.ventureId,
      kind: "auto_pause",
      detail: `${reason}; provider campaign pause requires read-back verification`,
      recordedAt,
    };
  }

  function mustGetGrant(ref: SpendGrantRef): SpendGrant {
    const grant = store.getGrant(ref, ref.grantId);
    if (!grant) throw new SpendError("unknown_grant", `unknown spend grant ${ref.grantId}`);
    return grant;
  }

  function consumed(grant: SpendGrant): number {
    return store
      .listReservations(grant, grant.grantId)
      .filter((entry) => entry.status !== "released")
      .reduce(
        (sum, entry) =>
          sum +
          (entry.status === "settled" ? (entry.settledMinorUnits ?? 0) : entry.heldMinorUnits),
        0,
      );
  }

  function registerGrant(input: SpendGrantInput): SpendGrant {
    if (
      !input.organizationId.trim() ||
      !input.ventureId.trim() ||
      !input.externalAccountId.trim() ||
      !input.currency.trim() ||
      input.allowedCreativeIds.length === 0 ||
      !input.approvedBy.trim() ||
      !input.approvalRef.trim() ||
      !input.proposalId.trim()
    ) {
      throw new SpendError("invalid_grant", "spend grant scope and approval evidence are required");
    }
    const notBefore = Date.parse(input.notBefore);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || notBefore >= expiresAt) {
      throw new SpendError("invalid_grant", "spend grant validity dates are invalid");
    }
    assertMinorUnits(input.totalMinorUnits);
    assertMinorUnits(input.perCreativeMinorUnits);
    assertMinorUnits(input.dailyAccountMinorUnits);
    for (const amount of [
      input.perPaidTestMinorUnits,
      input.perCampaignMinorUnits,
      input.dailyVentureMinorUnits,
      input.monthlyVentureMinorUnits,
      input.dailyCustomerMinorUnits,
      input.monthlyCustomerMinorUnits,
      input.emergencyPlatformMinorUnits,
    ]) {
      if (amount !== undefined) assertMinorUnits(amount);
    }
    const material = grantIntegrityMaterial(input);
    const grantHash = spendGrantHash(material);
    const grant: StoredGrant = {
      grantId: mint("grant"),
      ...material,
      grantHash,
      issuedAt: now().toISOString(),
    };
    store.putGrant(grant);
    return Object.freeze(grant);
  }

  function reserveWithReplay(input: ReserveInput): {
    reservation: Reservation;
    replay: boolean;
  } {
    const grant = mustGetGrant(input);
    const at = now();

    if (at < new Date(grant.notBefore)) {
      throw new SpendError("grant_not_yet_valid", `${grant.grantId} is not valid yet`);
    }
    if (at >= new Date(grant.expiresAt)) {
      throw new SpendError("grant_expired", `${grant.grantId} expired at ${grant.expiresAt}`);
    }
    if (!grant.allowedCreativeIds.includes(input.creativeId)) {
      throw new SpendError(
        "creative_not_in_grant",
        `${input.creativeId} is not covered by ${grant.grantId}`,
      );
    }
    if (input.network && input.network !== grant.network) {
      throw new SpendError(
        "network_mismatch",
        `${grant.grantId} authorises ${grant.network}, not ${input.network}`,
      );
    }
    if (input.externalAccountId && input.externalAccountId !== grant.externalAccountId) {
      throw new SpendError(
        "account_mismatch",
        `${grant.grantId} authorises account ${grant.externalAccountId}`,
      );
    }
    if (input.currency && input.currency !== grant.currency) {
      throw new SpendError(
        "currency_mismatch",
        `${grant.grantId} is denominated in ${grant.currency}`,
      );
    }
    assertMinorUnits(input.amountMinorUnits);

    const outcome = store.reserveAtomically({
      reservationId: mint("res"),
      idempotencyKey: input.idempotencyKey,
      grantId: input.grantId,
      organizationId: input.organizationId,
      ventureId: input.ventureId,
      creativeId: input.creativeId,
      paidTestId: input.paidTestId ?? grant.proposalId,
      campaignId: input.campaignId,
      amountMinorUnits: input.amountMinorUnits,
      dayKey: at.toISOString().slice(0, 10),
      monthKey: at.toISOString().slice(0, 7),
      createdAt: at.toISOString(),
    });

    switch (outcome.kind) {
      case "created":
        return { reservation: Object.freeze(outcome.reservation), replay: false };
      case "idempotent_replay":
        return { reservation: Object.freeze(outcome.reservation), replay: true };
      case "idempotency_conflict":
        throw new SpendError(
          "idempotency_conflict",
          "idempotency key is already bound to a different reservation request",
        );
      case "halted":
        throw new SpendError(
          "spend_halted",
          `spend is halted for ${grant.grantId}: ${outcome.reason}`,
        );
      case "cap_exceeded":
        throw new SpendError(
          "cap_exceeded",
          `${outcome.attempted} exceeds the ${outcome.limit} ${outcome.cap} cap on ${grant.grantId}`,
          outcome.cap,
        );
    }
  }

  function reserve(input: ReserveInput): Reservation {
    return reserveWithReplay(input).reservation;
  }

  function release(ref: SpendReservationRef, confirmation: ProviderOperationError): Reservation {
    if (
      !(confirmation instanceof ProviderOperationError) ||
      confirmation.writeDisposition !== "confirmed_no_write"
    ) {
      throw new SpendError(
        "release_requires_confirmed_no_write",
        "a reservation may be released only after a typed confirmed-no-write provider result",
      );
    }
    const released = store.release(ref, ref.reservationId);
    if (!released) {
      throw new SpendError("unknown_reservation", `unknown reservation ${ref.reservationId}`);
    }
    if (released.status !== "released") {
      throw new SpendError(
        "reservation_not_held",
        `${ref.reservationId} is already ${released.status}`,
      );
    }
    return Object.freeze(released);
  }

  /**
   * Reconcile against what the provider actually charged. An overspend is
   * recorded at its real value, raises an incident, and freezes the grant.
   * Understating real money to keep a cap looking intact is the worse failure.
   */
  function settleInternal(
    ref: SpendReservationRef,
    actualMinorUnits: number,
    allowPendingReconciliation: boolean,
  ): Reservation {
    const held = store.getReservation(ref, ref.reservationId);
    if (!held) {
      throw new SpendError("unknown_reservation", `unknown reservation ${ref.reservationId}`);
    }
    if (
      held.status !== "held" &&
      !(allowPendingReconciliation && held.status === "pending_reconciliation")
    ) {
      throw new SpendError(
        "reservation_not_held",
        `${ref.reservationId} is already ${held.status}`,
      );
    }
    if (!Number.isSafeInteger(actualMinorUnits) || actualMinorUnits < 0) {
      throw new SpendError(
        "non_integer_minor_units",
        `settlement must be a non-negative integer; received ${actualMinorUnits}`,
      );
    }

    const at = now().toISOString();
    const detail = `provider reported ${actualMinorUnits} against a ${held.heldMinorUnits} reservation`;
    const incident =
      actualMinorUnits > held.heldMinorUnits
        ? {
            incidentId: mint("inc"),
            grantId: held.grantId,
            organizationId: held.organizationId,
            ventureId: held.ventureId,
            kind: "provider_overspend",
            detail,
            recordedAt: at,
          }
        : null;
    const pauseObligation = incident
      ? buildProviderPauseObligation(
          mustGetGrant(held),
          held.campaignId,
          ["provider_overspend"],
          [incident.incidentId],
          actualMinorUnits,
          at,
        )
      : null;
    const settled = store.settleAtomically(
      ref,
      ref.reservationId,
      actualMinorUnits,
      incident,
      allowPendingReconciliation ? at : undefined,
      pauseObligation,
    )!;
    if (settled.status !== "settled" || settled.settledMinorUnits !== actualMinorUnits) {
      throw new SpendError(
        "reconciliation_conflict",
        "reservation reached a different terminal reconciliation outcome",
      );
    }
    if (incident) {
      throw new SpendError(
        "settlement_exceeds_reservation",
        `${detail}; spend halted for reconciliation`,
      );
    }
    return Object.freeze(settled);
  }

  function settle(ref: SpendReservationRef, actualMinorUnits: number): Reservation {
    return settleInternal(ref, actualMinorUnits, false);
  }

  async function withReservation(
    input: ReserveInput,
    run: (reservation: Reservation) => Promise<number>,
  ): Promise<Reservation> {
    const { reservation, replay } = reserveWithReplay(input);
    if (replay) {
      if (reservation.status === "settled") return reservation;
      throw new SpendError(
        "provider_replay_blocked",
        `provider invocation is blocked for an existing ${reservation.status} reservation`,
      );
    }
    let actual: number;
    try {
      actual = await run(reservation);
    } catch (error) {
      if (
        error instanceof ProviderOperationError &&
        error.writeDisposition === "confirmed_no_write"
      ) {
        release(reservation, error);
        throw error;
      }
      const reason =
        error instanceof ProviderOperationError
          ? error.writeDisposition
          : "untyped adapter error; provider write outcome is unknown";
      store.markPendingReconciliation(
        reservation,
        reservation.reservationId,
        reason,
        now().toISOString(),
      );
      const pending = new SpendError(
        "provider_outcome_unknown",
        `provider outcome is unknown; reservation ${reservation.reservationId} awaits reconciliation`,
      );
      Object.defineProperty(pending, "cause", { value: error, enumerable: false });
      throw pending;
    }
    try {
      return settle(reservation, actual);
    } catch (error) {
      const current = store.getReservation(reservation, reservation.reservationId);
      if (current?.status === "held") {
        store.markPendingReconciliation(
          reservation,
          reservation.reservationId,
          "provider returned but settlement could not be durably confirmed",
          now().toISOString(),
        );
        const pending = new SpendError(
          "provider_outcome_unknown",
          `provider outcome is unknown; reservation ${reservation.reservationId} awaits reconciliation`,
        );
        Object.defineProperty(pending, "cause", { value: error, enumerable: false });
        throw pending;
      }
      throw error;
    }
  }

  function reconcileProviderOutcome(
    ref: SpendReservationRef,
    outcome: { kind: "absent" } | { kind: "present"; actualSpendMinor: number },
  ): Reservation {
    const current = store.getReservation(ref, ref.reservationId);
    if (!current) {
      throw new SpendError("unknown_reservation", `unknown reservation ${ref.reservationId}`);
    }
    if (current.status === "settled") {
      if (
        outcome.kind === "present" &&
        current.reconciliationOutcome === "present" &&
        current.settledMinorUnits === outcome.actualSpendMinor
      ) {
        return Object.freeze(current);
      }
      throw new SpendError("reconciliation_conflict", "reservation is already settled");
    }
    if (current.status === "released") {
      if (outcome.kind === "absent" && current.reconciliationOutcome === "absent") {
        return Object.freeze(current);
      }
      throw new SpendError("reconciliation_conflict", "reservation is already released");
    }
    if (current.status !== "pending_reconciliation") {
      throw new SpendError(
        "reconciliation_conflict",
        `reservation ${ref.reservationId} is ${current.status}, not pending reconciliation`,
      );
    }
    if (outcome.kind === "absent") {
      const reconciled = store.reconcileAbsent(ref, ref.reservationId, now().toISOString())!;
      if (reconciled.status !== "released" || reconciled.reconciliationOutcome !== "absent") {
        throw new SpendError(
          "reconciliation_conflict",
          "reservation reached a different terminal reconciliation outcome",
        );
      }
      return Object.freeze(reconciled);
    }
    return settleInternal(ref, outcome.actualSpendMinor, true);
  }

  function evaluateAutoPause(ref: SpendGrantRef, signals: AutoPauseSignals): AutoPauseDecision {
    const grant = mustGetGrant(ref);
    const reasons: AutoPauseReason[] = [];
    if (!signals.trackingHealthy) reasons.push("tracking_health_failed");
    if (!signals.attributionMappingIntact) reasons.push("attribution_mapping_broken");
    if (signals.providerPolicyWarning) reasons.push("provider_policy_warning");
    if (signals.stopConditionTriggered) reasons.push("stop_condition_triggered");
    if (signals.refundRateAnomaly) reasons.push("refund_rate_anomaly");
    if (!signals.rightsValid) reasons.push("rights_invalid");
    if (!signals.disclosureCompliant) reasons.push("disclosure_violation");
    if (signals.connectionRevoked) reasons.push("connection_revoked");
    if (consumed(grant) >= grant.totalMinorUnits) reasons.push("hard_budget_reached");
    return Object.freeze({ paused: reasons.length > 0, reasons: Object.freeze(reasons) });
  }

  function queueAutoPause(
    ref: SpendGrantRef,
    reasons: readonly AutoPauseReason[],
  ): readonly ProviderPauseObligation[] {
    const grant = mustGetGrant(ref);
    const at = now().toISOString();
    const incidents = reasons.map((reason) => pauseIncident(grant, reason, at));
    const campaigns = [
      ...new Set(
        store
          .listReservations(grant, grant.grantId)
          .filter((entry) => entry.status !== "released" && entry.campaignId.trim())
          .map((entry) => entry.campaignId),
      ),
    ];
    const targets: readonly (string | null)[] = campaigns.length > 0 ? campaigns : [null];
    const obligations = targets.map((campaignId) =>
      buildProviderPauseObligation(
        grant,
        campaignId,
        reasons,
        incidents.map(({ incidentId }) => incidentId),
        consumed(grant),
        at,
      ),
    );
    return store.haltAndQueueProviderPauses(
      grant,
      grant.grantId,
      `auto-pause: ${reasons.join(", ")}`,
      obligations,
      incidents,
    );
  }

  function planForProviderPause(
    adapter: WinnerLiveProviderAdapter,
    obligation: StoredProviderPauseObligation,
  ): WinnerLiveProviderPlan {
    if (
      obligation.providerAdapterId !== "tiktok_spark_ads" ||
      adapter.descriptor.id !== obligation.providerAdapterId ||
      !obligation.operationId ||
      !obligation.idempotencyKey ||
      !obligation.requestHash ||
      !obligation.payloadJson
    ) {
      throw new Error("provider pause obligation has no executable immutable plan");
    }
    const plan = adapter.plan({
      organizationId: obligation.organizationId,
      ventureId: obligation.ventureId,
      providerAccountId: obligation.externalAccountId,
      operationId: obligation.operationId,
      idempotencyKey: obligation.idempotencyKey,
      feature: "ads.campaign.pause",
      payload: JSON.parse(obligation.payloadJson) as unknown,
    });
    if (plan.requestHash !== obligation.requestHash) {
      throw new Error("provider pause request hash no longer matches its durable binding");
    }
    return plan;
  }

  function recordProviderPauseIncident(
    obligation: StoredProviderPauseObligation,
    state: ProviderPauseObligationState,
    diagnosticCode: string | null,
    recordedAt: string,
  ): void {
    if (state === "verified") return;
    const code = diagnosticCode ?? "verification_pending";
    store.recordIncident({
      incidentId: `inc_pause_result_${pauseHash([obligation.obligationId, state, code]).slice(
        0,
        22,
      )}`,
      grantId: obligation.grantId,
      organizationId: obligation.organizationId,
      ventureId: obligation.ventureId,
      kind: `provider_pause_${state}`,
      detail: `provider pause obligation ${obligation.obligationId} is ${state} (${code}); completion is not verified`,
      recordedAt,
    });
  }

  function persistProviderPause(
    obligation: StoredProviderPauseObligation,
    state: ProviderPauseObligationState,
    input: {
      providerOperationId?: string | null;
      diagnostic?: WinnerLiveProviderDiagnostic | null;
      diagnosticCode?: string | null;
      diagnosticMessage?: string | null;
      evidence?: unknown;
      applyState?: StoredProviderPauseObligation["lastApplyState"];
      readBackState?: ProviderPauseReadBackState;
      readBackAt?: string;
      reconciledAt?: string;
    } = {},
  ): StoredProviderPauseObligation {
    const at = now().toISOString();
    const rawMessage = input.diagnostic?.message ?? input.diagnosticMessage ?? null;
    const redactedMessage =
      rawMessage === null
        ? null
        : String(pauseExecutor ? pauseExecutor.redact(rawMessage) : rawMessage);
    const redactedEvidence =
      input.evidence === undefined || input.evidence === null
        ? null
        : (JSON.stringify(pauseExecutor ? pauseExecutor.redact(input.evidence) : input.evidence) ??
          null);
    const updated = store.updateProviderPauseObligation(obligation, obligation.obligationId, {
      state,
      providerOperationId:
        input.providerOperationId === undefined
          ? obligation.providerOperationId
          : input.providerOperationId,
      lastDiagnosticCode: input.diagnostic?.code ?? input.diagnosticCode ?? null,
      lastDiagnosticMessage: redactedMessage,
      evidenceJson: redactedEvidence,
      updatedAt: at,
      lastApplyState: input.applyState,
      lastReadBackState: input.readBackState,
      lastReadBackAt: input.readBackAt,
      lastReconciledAt: input.reconciledAt,
      verifiedAt: state === "verified" ? at : null,
    });
    if (!updated) {
      throw new SpendError(
        "unknown_pause_obligation",
        `unknown provider pause obligation ${obligation.obligationId}`,
      );
    }
    recordProviderPauseIncident(updated, updated.state, updated.lastDiagnosticCode, at);
    return updated;
  }

  function pauseProcessResult(
    obligation: StoredProviderPauseObligation,
    input: {
      applyAttempted: boolean;
      reconciled: boolean;
      providerInvoked: boolean;
    },
  ): ProviderPauseProcessResult {
    return Object.freeze({
      obligation: Object.freeze(obligation),
      state: obligation.state,
      complete: obligation.state === "verified",
      applyAttempted: input.applyAttempted,
      reconciled: input.reconciled,
      providerInvoked: input.providerInvoked,
      diagnosticCode: obligation.lastDiagnosticCode,
    });
  }

  async function processProviderPause(
    ref: ProviderPauseObligationRef,
    context: WinnerLiveProviderContext,
  ): Promise<ProviderPauseProcessResult> {
    let obligation = store.getProviderPauseObligation(ref, ref.obligationId);
    if (!obligation) {
      throw new SpendError(
        "unknown_pause_obligation",
        `unknown provider pause obligation ${ref.obligationId}`,
      );
    }
    if (obligation.state === "verified") {
      return pauseProcessResult(obligation, {
        applyAttempted: false,
        reconciled: false,
        providerInvoked: false,
      });
    }
    if (
      obligation.providerAdapterId !== "tiktok_spark_ads" ||
      !obligation.operationId ||
      !obligation.idempotencyKey ||
      !obligation.requestHash ||
      !obligation.payloadJson
    ) {
      recordProviderPauseIncident(
        obligation,
        "blocked",
        obligation.lastDiagnosticCode ?? "feature_unavailable",
        now().toISOString(),
      );
      return pauseProcessResult(obligation, {
        applyAttempted: false,
        reconciled: false,
        providerInvoked: false,
      });
    }
    if (!pauseExecutor) {
      obligation = persistProviderPause(obligation, "pending", {
        diagnosticCode: "transport_missing",
        diagnosticMessage: "No injected provider pause adapter is configured",
      });
      return pauseProcessResult(obligation, {
        applyAttempted: false,
        reconciled: false,
        providerInvoked: false,
      });
    }

    let plan: WinnerLiveProviderPlan;
    try {
      plan = planForProviderPause(pauseExecutor, obligation);
    } catch (error) {
      obligation = persistProviderPause(obligation, "failed", {
        diagnosticCode: "idempotency_conflict",
        diagnosticMessage:
          error instanceof Error ? error.message : "Provider pause plan reconstruction failed",
      });
      return pauseProcessResult(obligation, {
        applyAttempted: false,
        reconciled: false,
        providerInvoked: false,
      });
    }

    let providerInvoked = false;
    if (obligation.attemptCount === 0) {
      try {
        const doctor = await pauseExecutor.doctor(
          {
            organizationId: obligation.organizationId,
            ventureId: obligation.ventureId,
            providerAccountId: obligation.externalAccountId,
            features: ["ads.campaign.pause"],
          },
          context,
        );
        providerInvoked = providerInvoked || doctor.providerInvoked;
        if (doctor.status !== "ready") {
          obligation = persistProviderPause(obligation, "pending", {
            diagnostic: doctor.diagnostics[0] ?? null,
            diagnosticCode: doctor.status,
            diagnosticMessage: "Provider pause preflight is not ready",
          });
          return pauseProcessResult(obligation, {
            applyAttempted: false,
            reconciled: false,
            providerInvoked,
          });
        }
      } catch (error) {
        obligation = persistProviderPause(obligation, "pending", {
          diagnosticCode: "provider_unavailable",
          diagnosticMessage:
            error instanceof Error ? error.message : "Provider pause preflight failed",
        });
        return pauseProcessResult(obligation, {
          applyAttempted: false,
          reconciled: false,
          providerInvoked,
        });
      }
    }

    const claim = store.claimProviderPauseAttempt(
      obligation,
      obligation.obligationId,
      now().toISOString(),
    );
    obligation = claim.obligation;
    if (claim.kind === "complete") {
      return pauseProcessResult(obligation, {
        applyAttempted: false,
        reconciled: false,
        providerInvoked,
      });
    }

    let applyAttempted = false;
    let initialState = obligation.state;
    let initialDiagnostic: WinnerLiveProviderDiagnostic | null = null;
    if (claim.kind === "claimed") {
      applyAttempted = true;
      try {
        const execution = await pauseExecutor.apply(plan, context);
        providerInvoked = providerInvoked || execution.providerInvoked;
        initialDiagnostic = execution.diagnostic;
        initialState =
          execution.state === "accepted_unverified"
            ? "accepted_unverified"
            : execution.state === "unknown"
              ? "unknown"
              : execution.state === "blocked" || execution.state === "planned"
                ? "blocked"
                : "failed";
        obligation = persistProviderPause(obligation, initialState, {
          providerOperationId: execution.providerOperationId,
          diagnostic: execution.diagnostic,
          evidence: execution.output,
          applyState:
            initialState === "accepted_unverified" ||
            initialState === "unknown" ||
            initialState === "failed" ||
            initialState === "blocked"
              ? initialState
              : null,
        });
      } catch (error) {
        initialState = "unknown";
        obligation = persistProviderPause(obligation, "unknown", {
          diagnosticCode: "outcome_ambiguous",
          diagnosticMessage:
            error instanceof Error ? error.message : "Provider pause outcome is ambiguous",
          applyState: "unknown",
        });
      }
    }

    const reconciled = claim.kind === "reconcile" || initialState !== "accepted_unverified";
    try {
      const readBack = reconciled
        ? await pauseExecutor.reconcile(plan, context)
        : await pauseExecutor.readBack(plan, context);
      providerInvoked = providerInvoked || readBack.providerInvoked;
      const nextState: ProviderPauseObligationState =
        readBack.state === "matched"
          ? "verified"
          : readBack.state === "conflict"
            ? "failed"
            : readBack.state === "blocked"
              ? "blocked"
              : readBack.state === "missing" && ["failed", "blocked"].includes(initialState)
                ? initialState
                : "unknown";
      obligation = persistProviderPause(obligation, nextState, {
        diagnostic:
          readBack.state === "matched" ? null : (readBack.diagnostic ?? initialDiagnostic),
        diagnosticCode: readBack.state === "matched" ? null : readBack.state,
        diagnosticMessage:
          readBack.state === "matched"
            ? null
            : `Provider pause read-back returned ${readBack.state}`,
        evidence: readBack.evidence,
        readBackState: readBack.state,
        readBackAt: now().toISOString(),
        reconciledAt: reconciled ? now().toISOString() : undefined,
      });
    } catch (error) {
      obligation = persistProviderPause(obligation, "unknown", {
        diagnosticCode: "outcome_ambiguous",
        diagnosticMessage:
          error instanceof Error ? error.message : "Provider pause reconciliation failed",
        readBackState: "unknown",
        readBackAt: now().toISOString(),
        reconciledAt: reconciled ? now().toISOString() : undefined,
      });
    }

    return pauseProcessResult(obligation, {
      applyAttempted,
      reconciled,
      providerInvoked,
    });
  }

  return {
    store,
    registerGrant,
    reserve,
    release,
    settle,
    withReservation,
    reconcileProviderOutcome,
    evaluateAutoPause,
    applyAutoPause(
      ref: SpendGrantRef,
      reasons: readonly AutoPauseReason[],
    ): readonly ProviderPauseObligation[] {
      return queueAutoPause(ref, reasons);
    },
    processProviderPause,
    getProviderPauseObligation: (
      ref: ProviderPauseObligationRef,
    ): ProviderPauseObligation | undefined =>
      store.getProviderPauseObligation(ref, ref.obligationId),
    listProviderPauseObligations: (ref: SpendGrantRef): readonly ProviderPauseObligation[] =>
      store.listProviderPauseObligations(ref, ref.grantId),
    activateKillSwitch(ref: SpendGrantRef, reason: string): void {
      mustGetGrant(ref);
      store.halt(ref, ref.grantId, reason);
    },
    revokeGrant(ref: SpendGrantRef, reason: string): void {
      mustGetGrant(ref);
      store.halt(ref, ref.grantId, `revoked: ${reason}`);
    },
    isHalted: (ref: SpendGrantRef): boolean => store.haltReason(ref, ref.grantId) !== undefined,
    haltReason: (ref: SpendGrantRef): string | undefined => store.haltReason(ref, ref.grantId),
    listIncidents: (ref: SpendGrantRef) => store.listIncidents(ref, ref.grantId),
    getGrant: (ref: SpendGrantRef): SpendGrant | undefined => store.getGrant(ref, ref.grantId),
    getReservation: (ref: SpendReservationRef): Reservation | undefined =>
      store.getReservation(ref, ref.reservationId),
    committedMinorUnits: (ref: SpendGrantRef): number =>
      store
        .listReservations(ref, ref.grantId)
        .filter((entry) => entry.status === "settled")
        .reduce((sum, entry) => sum + (entry.settledMinorUnits ?? 0), 0),
    reservedMinorUnits: (ref: SpendGrantRef): number =>
      store
        .listReservations(ref, ref.grantId)
        .filter((entry) => entry.status === "held" || entry.status === "pending_reconciliation")
        .reduce((sum, entry) => sum + entry.heldMinorUnits, 0),
    /**
     * Scaling is a recommendation, never an action. There is no code path in V1
     * that raises a cap on an approved grant; more budget means a new approval.
     */
    proposeScale(
      ref: SpendGrantRef,
      input: { creativeId: string; suggestedTotalMinorUnits: number; rationale: string },
    ): ScaleProposal {
      mustGetGrant(ref);
      return Object.freeze({
        grantId: ref.grantId,
        creativeId: input.creativeId,
        suggestedTotalMinorUnits: input.suggestedTotalMinorUnits,
        rationale: input.rationale,
        automaticallyApplied: false as const,
        requiresNewSpendGrant: true as const,
        proposedAt: now().toISOString(),
      });
    },
  };
}

export type SpendLedger = ReturnType<typeof createSpendLedger>;

/** Recompute the immutable v2 Spend Grant authorization material. */
export function verifySpendGrantHash(grant: SpendGrant): boolean {
  return /^[a-f0-9]{64}$/u.test(grant.grantHash) && spendGrantHash(grant) === grant.grantHash;
}

/**
 * Canonical production bridge used by live paid-provider adapters. It refuses
 * fixture-only stores, validates the stored grant rather than a caller-supplied
 * object, and converges repeated provider read-backs without duplicating
 * incidents or pause obligations.
 */
export function createWinnerLivePaidAuthorizationStore(
  ledger: SpendLedger,
): WinnerLivePaidAuthorizationStore {
  if (!ledger.store.productionSafe) {
    throw new Error("authoritative paid-provider execution requires a production-safe spend store");
  }
  return Object.freeze({
    authoritative: true as const,
    getGrant: async (scope: SpendScope, grantId: string) => ledger.getGrant({ ...scope, grantId }),
    getReservation: async (scope: SpendScope, reservationId: string) =>
      ledger.getReservation({ ...scope, reservationId }),
    verifyGrantHash: async (scope: SpendScope, candidate: SpendGrant) => {
      const stored = ledger.getGrant({ ...scope, grantId: candidate.grantId });
      return (
        stored !== undefined &&
        stored.organizationId === scope.organizationId &&
        stored.ventureId === scope.ventureId &&
        stored.grantHash === candidate.grantHash &&
        verifySpendGrantHash(stored) &&
        verifySpendGrantHash(candidate)
      );
    },
    isGrantHalted: async (scope: SpendScope, grantId: string) =>
      ledger.isHalted({ ...scope, grantId }),
    recordProviderSpend: async (
      scope: SpendScope,
      reservationId: string,
      actualSpendMinor: number,
    ) => {
      const ref = { ...scope, reservationId };
      const before = ledger.getReservation(ref);
      if (!before) throw new SpendError("unknown_reservation", "provider reservation unavailable");
      if (before.status === "held") {
        try {
          ledger.settle(ref, actualSpendMinor);
        } catch (error) {
          if (!(error instanceof SpendError) || error.code !== "settlement_exceeds_reservation") {
            throw error;
          }
        }
      } else if (before.status === "pending_reconciliation") {
        try {
          ledger.reconcileProviderOutcome(ref, {
            kind: "present",
            actualSpendMinor,
          });
        } catch (error) {
          if (!(error instanceof SpendError) || error.code !== "settlement_exceeds_reservation") {
            throw error;
          }
        }
      } else if (before.status !== "settled" || before.settledMinorUnits !== actualSpendMinor) {
        throw new SpendError(
          "reconciliation_conflict",
          "provider spend conflicts with the reservation terminal state",
        );
      }
      const reservation = ledger.getReservation(ref);
      if (
        !reservation ||
        reservation.status !== "settled" ||
        reservation.settledMinorUnits !== actualSpendMinor
      ) {
        throw new SpendError("reconciliation_conflict", "provider spend was not durably settled");
      }
      const grantRef = { ...scope, grantId: reservation.grantId };
      const overspendRecorded = ledger
        .listIncidents(grantRef)
        .some((incident) => incident.kind === "provider_overspend");
      return Object.freeze({
        reservation,
        overspendRecorded,
        grantHalted: ledger.isHalted(grantRef),
        providerPauseQueued: ledger.listProviderPauseObligations(grantRef).length > 0,
      });
    },
  });
}
