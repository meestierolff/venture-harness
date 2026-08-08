import { createHash } from "node:crypto";
import type { CreativeNetwork } from "./types";

/**
 * Spend safety.
 *
 * The rule this file enforces: the first paid euro requires its own explicit
 * human approval. A Launch Grant, a Customer Service Grant, and an
 * organic-publishing policy authorise none of it — only a Spend Grant does.
 *
 * All amounts are integer minor units (cents). Floating point is refused at the
 * boundary because a budget ledger that drifts by rounding is a ledger that
 * cannot prove a cap held.
 */

export type SpendErrorCode =
  | "unknown_grant"
  | "unknown_reservation"
  | "spend_halted"
  | "grant_expired"
  | "grant_not_yet_valid"
  | "creative_not_in_grant"
  | "currency_mismatch"
  | "non_integer_minor_units"
  | "non_positive_amount"
  | "total_cap_exceeded"
  | "daily_account_cap_exceeded"
  | "per_creative_cap_exceeded"
  | "settlement_exceeds_reservation"
  | "reservation_not_held";

export class SpendError extends Error {
  readonly code: SpendErrorCode;

  constructor(code: SpendErrorCode, message: string) {
    super(message);
    this.name = "SpendError";
    this.code = code;
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
  network: Extract<CreativeNetwork, "tiktok_paid" | "meta_paid">;
  externalAccountId: string;
  /** ISO 4217, uppercase. */
  currency: string;
  totalMinorUnits: number;
  perCreativeMinorUnits: number;
  dailyAccountMinorUnits: number;
  allowedCreativeIds: readonly string[];
  approvedBy: string;
  /** The checkpoint or approval event that authorised this spend. */
  approvalRef: string;
  notBefore: string;
  expiresAt: string;
}

export interface SpendGrant extends Readonly<SpendGrantInput> {
  readonly grantId: string;
  readonly allowedCreativeIds: readonly string[];
  /** Tamper evidence over the approved terms. */
  readonly grantHash: string;
  readonly issuedAt: string;
}

export interface ReserveInput {
  grantId: string;
  creativeId: string;
  campaignId: string;
  amountMinorUnits: number;
}

export type ReservationStatus = "held" | "settled" | "released";

export interface Reservation {
  readonly reservationId: string;
  readonly grantId: string;
  readonly creativeId: string;
  readonly campaignId: string;
  readonly heldMinorUnits: number;
  readonly settledMinorUnits: number | null;
  readonly status: ReservationStatus;
  readonly dayKey: string;
  readonly createdAt: string;
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

export interface SpendLedgerOptions {
  now?: () => Date;
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

function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createSpendLedger(options: SpendLedgerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const grants = new Map<string, SpendGrant>();
  const halted = new Map<string, string>();
  const reservations = new Map<string, Reservation>();
  let ordinal = 0;

  function mustGetGrant(grantId: string): SpendGrant {
    const grant = grants.get(grantId);
    if (!grant) throw new SpendError("unknown_grant", `unknown spend grant ${grantId}`);
    return grant;
  }

  /** Held plus settled: money that is promised counts against a cap exactly as
   * hard as money already spent, which is what makes the caps safe to hold
   * across an await. */
  function consumed(predicate: (entry: Reservation) => boolean): number {
    let total = 0;
    for (const entry of reservations.values()) {
      if (entry.status === "released") continue;
      if (!predicate(entry)) continue;
      total += entry.status === "settled" ? (entry.settledMinorUnits ?? 0) : entry.heldMinorUnits;
    }
    return total;
  }

  function registerGrant(input: SpendGrantInput): SpendGrant {
    assertMinorUnits(input.totalMinorUnits);
    assertMinorUnits(input.perCreativeMinorUnits);
    assertMinorUnits(input.dailyAccountMinorUnits);
    ordinal += 1;
    const grantHash = createHash("sha256")
      .update(JSON.stringify([ordinal, input]))
      .digest("hex");
    const grant: SpendGrant = Object.freeze({
      ...input,
      allowedCreativeIds: Object.freeze([...input.allowedCreativeIds]),
      grantId: `grant_${grantHash.slice(0, 16)}`,
      grantHash,
      issuedAt: now().toISOString(),
    });
    grants.set(grant.grantId, grant);
    return grant;
  }

  /**
   * Synchronous by design. Every cap is checked and the reservation committed
   * in one uninterrupted block, so no `await` can open a window in which two
   * callers each see enough headroom for the same money.
   */
  function reserve(input: ReserveInput): Reservation {
    const grant = mustGetGrant(input.grantId);
    const haltReason = halted.get(grant.grantId);
    if (haltReason) {
      throw new SpendError("spend_halted", `spend is halted for ${grant.grantId}: ${haltReason}`);
    }

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
    assertMinorUnits(input.amountMinorUnits);

    const dayKey = dayKeyOf(at);
    const total = consumed((entry) => entry.grantId === grant.grantId) + input.amountMinorUnits;
    if (total > grant.totalMinorUnits) {
      throw new SpendError(
        "total_cap_exceeded",
        `${total} exceeds the ${grant.totalMinorUnits} total cap on ${grant.grantId}`,
      );
    }

    const accountGrantIds = new Set(
      [...grants.values()]
        .filter(
          (entry) =>
            entry.externalAccountId === grant.externalAccountId && entry.network === grant.network,
        )
        .map((entry) => entry.grantId),
    );
    const daily =
      consumed((entry) => accountGrantIds.has(entry.grantId) && entry.dayKey === dayKey) +
      input.amountMinorUnits;
    if (daily > grant.dailyAccountMinorUnits) {
      throw new SpendError(
        "daily_account_cap_exceeded",
        `${daily} exceeds the ${grant.dailyAccountMinorUnits} daily cap on account ${grant.externalAccountId}`,
      );
    }

    const perCreative =
      consumed(
        (entry) => entry.grantId === grant.grantId && entry.creativeId === input.creativeId,
      ) + input.amountMinorUnits;
    if (perCreative > grant.perCreativeMinorUnits) {
      throw new SpendError(
        "per_creative_cap_exceeded",
        `${perCreative} exceeds the ${grant.perCreativeMinorUnits} per-creative cap for ${input.creativeId}`,
      );
    }

    ordinal += 1;
    const reservation: Reservation = Object.freeze({
      reservationId: `res_${ordinal.toString().padStart(8, "0")}`,
      grantId: grant.grantId,
      creativeId: input.creativeId,
      campaignId: input.campaignId,
      heldMinorUnits: input.amountMinorUnits,
      settledMinorUnits: null,
      status: "held",
      dayKey,
      createdAt: at.toISOString(),
    });
    reservations.set(reservation.reservationId, reservation);
    return reservation;
  }

  function replace(reservation: Reservation, patch: Partial<Reservation>): Reservation {
    const next = Object.freeze({ ...reservation, ...patch });
    reservations.set(next.reservationId, next);
    return next;
  }

  function mustGetHeld(reservationId: string): Reservation {
    const reservation = reservations.get(reservationId);
    if (!reservation) {
      throw new SpendError("unknown_reservation", `unknown reservation ${reservationId}`);
    }
    if (reservation.status !== "held") {
      throw new SpendError(
        "reservation_not_held",
        `${reservationId} is already ${reservation.status}`,
      );
    }
    return reservation;
  }

  function release(reservationId: string): Reservation {
    return replace(mustGetHeld(reservationId), { status: "released" });
  }

  /**
   * Reconcile against what the provider actually charged. An overspend is
   * recorded at its real value and halts the grant — understating real money to
   * keep a cap looking intact would be the more dangerous lie.
   */
  function settle(reservationId: string, actualMinorUnits: number): Reservation {
    const reservation = mustGetHeld(reservationId);
    if (!Number.isInteger(actualMinorUnits) || actualMinorUnits < 0) {
      throw new SpendError(
        "non_integer_minor_units",
        `settlement must be a non-negative integer; received ${actualMinorUnits}`,
      );
    }
    const settled = replace(reservation, {
      status: "settled",
      settledMinorUnits: actualMinorUnits,
    });
    if (actualMinorUnits > reservation.heldMinorUnits) {
      halted.set(
        reservation.grantId,
        `provider reported ${actualMinorUnits} against a ${reservation.heldMinorUnits} reservation`,
      );
      throw new SpendError(
        "settlement_exceeds_reservation",
        `provider reported ${actualMinorUnits} minor units against reservation ${reservationId} holding ${reservation.heldMinorUnits}; spend halted for reconciliation`,
      );
    }
    return settled;
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
    if (consumed((entry) => entry.grantId === grantId) >= grant.totalMinorUnits) {
      reasons.push("hard_budget_reached");
    }
    return Object.freeze({ paused: reasons.length > 0, reasons: Object.freeze(reasons) });
  }

  function applyAutoPause(grantId: string, reasons: readonly AutoPauseReason[]): void {
    mustGetGrant(grantId);
    halted.set(grantId, `auto-pause: ${reasons.join(", ")}`);
  }

  return {
    registerGrant,
    reserve,
    release,
    settle,
    withReservation,
    evaluateAutoPause,
    applyAutoPause,
    activateKillSwitch(grantId: string, reason: string): void {
      mustGetGrant(grantId);
      halted.set(grantId, reason);
    },
    isHalted: (grantId: string): boolean => halted.has(grantId),
    haltReason: (grantId: string): string | undefined => halted.get(grantId),
    getGrant: (grantId: string): SpendGrant | undefined => grants.get(grantId),
    getReservation: (reservationId: string): Reservation | undefined =>
      reservations.get(reservationId),
    committedMinorUnits: (grantId: string): number => {
      let total = 0;
      for (const entry of reservations.values()) {
        if (entry.grantId === grantId && entry.status === "settled") {
          total += entry.settledMinorUnits ?? 0;
        }
      }
      return total;
    },
    reservedMinorUnits: (grantId: string): number => {
      let total = 0;
      for (const entry of reservations.values()) {
        if (entry.grantId === grantId && entry.status === "held") total += entry.heldMinorUnits;
      }
      return total;
    },
    /**
     * Scaling is a recommendation, never an action. V1 has no code path that
     * raises a cap on an approved grant; more budget means a new human approval.
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
