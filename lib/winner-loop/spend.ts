import { createHash } from "node:crypto";
import { createIdFactory, type IdFactoryOptions } from "./ids";
import {
  createMemorySpendStore,
  type CapUsage,
  type SpendStore,
  type StoredGrant,
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
  | "unknown_reservation"
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
  | "cap_exceeded"
  | "settlement_exceeds_reservation"
  | "reservation_not_held";

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

export type AutoPauseReason =
  | "tracking_health_failed"
  | "attribution_mapping_broken"
  | "provider_policy_warning"
  | "hard_budget_reached"
  | "stop_condition_triggered"
  | "refund_rate_anomaly"
  | "rights_invalid"
  | "connection_revoked";

export interface AutoPauseSignals {
  trackingHealthy: boolean;
  attributionMappingIntact: boolean;
  providerPolicyWarning: boolean;
  rightsValid: boolean;
  connectionRevoked: boolean;
  refundRateAnomaly: boolean;
  stopConditionTriggered: boolean;
}

export interface AutoPauseDecision {
  readonly paused: boolean;
  readonly reasons: readonly AutoPauseReason[];
}

export interface SpendGrantInput {
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
  allowedCreativeIds: readonly string[];
  approvedBy: string;
  approvalRef: string;
  /** The approved PaidTestProposal this grant was minted from. */
  proposalId: string;
  notBefore: string;
  expiresAt: string;
}

export type SpendGrant = Readonly<StoredGrant>;
export type Reservation = Readonly<StoredReservation>;
export type ReservationStatus = StoredReservation["status"];

export interface ReserveInput {
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
}

function assertMinorUnits(amount: number): void {
  if (!Number.isInteger(amount)) {
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

  function mustGetGrant(grantId: string): SpendGrant {
    const grant = store.getGrant(grantId);
    if (!grant) throw new SpendError("unknown_grant", `unknown spend grant ${grantId}`);
    return grant;
  }

  function consumed(grantId: string): number {
    return store
      .listReservations(grantId)
      .filter((entry) => entry.status !== "released")
      .reduce(
        (sum, entry) =>
          sum +
          (entry.status === "settled" ? (entry.settledMinorUnits ?? 0) : entry.heldMinorUnits),
        0,
      );
  }

  function registerGrant(input: SpendGrantInput): SpendGrant {
    assertMinorUnits(input.totalMinorUnits);
    assertMinorUnits(input.perCreativeMinorUnits);
    assertMinorUnits(input.dailyAccountMinorUnits);
    const grantHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const grant: StoredGrant = {
      grantId: mint("grant"),
      ventureId: input.ventureId,
      customerId: input.customerId ?? null,
      network: input.network,
      externalAccountId: input.externalAccountId,
      currency: input.currency,
      totalMinorUnits: input.totalMinorUnits,
      perCreativeMinorUnits: input.perCreativeMinorUnits,
      perPaidTestMinorUnits: input.perPaidTestMinorUnits ?? input.totalMinorUnits,
      perCampaignMinorUnits: input.perCampaignMinorUnits ?? input.totalMinorUnits,
      dailyAccountMinorUnits: input.dailyAccountMinorUnits,
      dailyVentureMinorUnits: input.dailyVentureMinorUnits ?? input.totalMinorUnits,
      monthlyVentureMinorUnits: input.monthlyVentureMinorUnits ?? input.totalMinorUnits,
      allowedCreativeIds: Object.freeze([...input.allowedCreativeIds]),
      approvedBy: input.approvedBy,
      approvalRef: input.approvalRef,
      proposalId: input.proposalId,
      notBefore: input.notBefore,
      expiresAt: input.expiresAt,
      grantHash,
      issuedAt: now().toISOString(),
    };
    store.putGrant(grant);
    return Object.freeze(grant);
  }

  function reserve(input: ReserveInput): Reservation {
    const grant = mustGetGrant(input.grantId);
    const at = now();

    if (at < new Date(grant.notBefore)) {
      throw new SpendError("grant_not_yet_valid", `${grant.grantId} is not valid yet`);
    }
    if (at > new Date(grant.expiresAt)) {
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
      case "idempotent_replay":
        return Object.freeze(outcome.reservation);
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

  function release(reservationId: string): Reservation {
    const released = store.release(reservationId);
    if (!released) {
      throw new SpendError("unknown_reservation", `unknown reservation ${reservationId}`);
    }
    return Object.freeze(released);
  }

  /**
   * Reconcile against what the provider actually charged. An overspend is
   * recorded at its real value, raises an incident, and freezes the grant.
   * Understating real money to keep a cap looking intact is the worse failure.
   */
  function settle(reservationId: string, actualMinorUnits: number): Reservation {
    const held = store.getReservation(reservationId);
    if (!held) {
      throw new SpendError("unknown_reservation", `unknown reservation ${reservationId}`);
    }
    if (held.status !== "held") {
      throw new SpendError("reservation_not_held", `${reservationId} is already ${held.status}`);
    }
    if (!Number.isInteger(actualMinorUnits) || actualMinorUnits < 0) {
      throw new SpendError(
        "non_integer_minor_units",
        `settlement must be a non-negative integer; received ${actualMinorUnits}`,
      );
    }

    const settled = store.settle(reservationId, actualMinorUnits)!;
    if (actualMinorUnits > held.heldMinorUnits) {
      const detail = `provider reported ${actualMinorUnits} against a ${held.heldMinorUnits} reservation`;
      store.recordIncident({
        incidentId: mint("inc"),
        grantId: held.grantId,
        kind: "provider_overspend",
        detail,
        recordedAt: now().toISOString(),
      });
      store.halt(held.grantId, detail);
      throw new SpendError(
        "settlement_exceeds_reservation",
        `${detail}; spend halted for reconciliation`,
      );
    }
    return Object.freeze(settled);
  }

  async function withReservation(
    input: ReserveInput,
    run: (reservation: Reservation) => Promise<number>,
  ): Promise<Reservation> {
    const reservation = reserve(input);
    let actual: number;
    try {
      actual = await run(reservation);
    } catch (error) {
      release(reservation.reservationId);
      throw error;
    }
    return settle(reservation.reservationId, actual);
  }

  function evaluateAutoPause(grantId: string, signals: AutoPauseSignals): AutoPauseDecision {
    const grant = mustGetGrant(grantId);
    const reasons: AutoPauseReason[] = [];
    if (!signals.trackingHealthy) reasons.push("tracking_health_failed");
    if (!signals.attributionMappingIntact) reasons.push("attribution_mapping_broken");
    if (signals.providerPolicyWarning) reasons.push("provider_policy_warning");
    if (signals.stopConditionTriggered) reasons.push("stop_condition_triggered");
    if (signals.refundRateAnomaly) reasons.push("refund_rate_anomaly");
    if (!signals.rightsValid) reasons.push("rights_invalid");
    if (signals.connectionRevoked) reasons.push("connection_revoked");
    if (consumed(grantId) >= grant.totalMinorUnits) reasons.push("hard_budget_reached");
    return Object.freeze({ paused: reasons.length > 0, reasons: Object.freeze(reasons) });
  }

  return {
    store,
    registerGrant,
    reserve,
    release,
    settle,
    withReservation,
    evaluateAutoPause,
    applyAutoPause(grantId: string, reasons: readonly AutoPauseReason[]): void {
      mustGetGrant(grantId);
      store.halt(grantId, `auto-pause: ${reasons.join(", ")}`);
    },
    activateKillSwitch(grantId: string, reason: string): void {
      mustGetGrant(grantId);
      store.halt(grantId, reason);
    },
    revokeGrant(grantId: string, reason: string): void {
      mustGetGrant(grantId);
      store.halt(grantId, `revoked: ${reason}`);
    },
    isHalted: (grantId: string): boolean => store.haltReason(grantId) !== undefined,
    haltReason: (grantId: string): string | undefined => store.haltReason(grantId),
    listIncidents: (grantId: string) => store.listIncidents(grantId),
    getGrant: (grantId: string): SpendGrant | undefined => store.getGrant(grantId),
    getReservation: (reservationId: string): Reservation | undefined =>
      store.getReservation(reservationId),
    committedMinorUnits: (grantId: string): number =>
      store
        .listReservations(grantId)
        .filter((entry) => entry.status === "settled")
        .reduce((sum, entry) => sum + (entry.settledMinorUnits ?? 0), 0),
    reservedMinorUnits: (grantId: string): number =>
      store
        .listReservations(grantId)
        .filter((entry) => entry.status === "held")
        .reduce((sum, entry) => sum + entry.heldMinorUnits, 0),
    /**
     * Scaling is a recommendation, never an action. There is no code path in V1
     * that raises a cap on an approved grant; more budget means a new approval.
     */
    proposeScale(
      grantId: string,
      input: { creativeId: string; suggestedTotalMinorUnits: number; rationale: string },
    ): ScaleProposal {
      mustGetGrant(grantId);
      return Object.freeze({
        grantId,
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
