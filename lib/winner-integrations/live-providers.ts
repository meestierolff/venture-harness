import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { initializeSqliteWal } from "@venture-harness/core";
import { z } from "zod";
import { OrganicPolicyError } from "../winner-loop/organic-policy";
import type {
  OrganicPolicyExecutionAuthority,
  OrganicPolicyFailure,
  OrganicPolicyOperation,
  OrganicPolicyService,
} from "../winner-loop/organic-policy";
import type { Reservation, SpendGrant } from "../winner-loop/spend";
import type { SpendScope } from "../winner-loop/spend-store";

/**
 * Production-capable Winner Loop provider contracts.
 *
 * This module deliberately contains no network client. A provider implementation
 * must inject an official transport, and every call remains behind credential,
 * authorization, review, idempotency, and read-back gates. Contract fixtures can
 * exercise the same lifecycle without implying live provider verification.
 */

export const WINNER_LIVE_PROVIDER_IDS = [
  "creative_generation",
  "tiktok_content_posting",
  "tiktok_spark_ads",
  "aggregated_attribution",
  "revenuecat",
] as const;
export type WinnerLiveProviderId = (typeof WINNER_LIVE_PROVIDER_IDS)[number];

export const WINNER_LIVE_PROVIDER_FEATURES = [
  "creative.video.generate",
  "distribution.content.draft",
  "distribution.content.publish",
  "ads.organic_post.boost",
  "ads.campaign.pause",
  "attribution.campaign.read",
  "subscription.lifecycle.read",
] as const;
export type WinnerLiveProviderFeature = (typeof WINNER_LIVE_PROVIDER_FEATURES)[number];

export type WinnerLiveProviderEffect =
  "external_read" | "reversible_external_write" | "public_communication" | "financial";

export type WinnerLiveJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly WinnerLiveJsonValue[]
  | { readonly [key: string]: WinnerLiveJsonValue };
export type WinnerLiveJsonObject = Readonly<Record<string, WinnerLiveJsonValue>>;

export interface WinnerLiveProviderFeatureDeclaration {
  readonly feature: WinnerLiveProviderFeature;
  readonly effect: WinnerLiveProviderEffect;
  readonly credentialKind: string;
  readonly requiredScopes: readonly string[];
  readonly requiredAccountChecks: readonly string[];
  readonly distinctReview: "organic.direct_publish" | "paid.spark_contract" | null;
  readonly readBackRequired: true;
}

export interface WinnerLiveProviderDescriptor {
  readonly id: WinnerLiveProviderId;
  readonly displayName: string;
  readonly category:
    | "creative_generation"
    | "organic_publication"
    | "paid_acquisition"
    | "attribution"
    | "subscription_lifecycle";
  readonly implementation: "injected_official_transport";
  readonly liveVerification: "pending";
  readonly documentation: readonly string[];
  readonly features: readonly WinnerLiveProviderFeatureDeclaration[];
  readonly limitations: readonly string[];
  readonly idempotencyStrategy: "atomic_harness_claim_and_provider_key_when_supported";
}

export interface WinnerLiveProviderAuthorization {
  /** Launch and service grants can authorize provider access; neither authorizes ad spend. */
  readonly sourceGrantKind: "launch_grant" | "customer_service_grant";
  readonly sourceGrantId: string;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly providerId: WinnerLiveProviderId;
  readonly externalAccountIds: readonly string[];
  readonly allowedFeatures: readonly WinnerLiveProviderFeature[];
  readonly allowedEffects: readonly WinnerLiveProviderEffect[];
  readonly maxExternalCostMinor: number;
  readonly currency: string;
  readonly approvedBy: string;
  readonly approvalRef: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface WinnerLiveProviderReviewApproval {
  readonly kind: "organic.direct_publish" | "paid.spark_contract";
  readonly requestHash: string;
  readonly operationId: string;
  readonly approvedBy: string;
  readonly approvalRef: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface WinnerLiveProviderContext {
  /** Trusted tenant identity resolved by the host, never inferred from provider input. */
  readonly organizationId: string;
  /** A broker reference only. Credential material is rejected. */
  readonly credentialRef?: string;
  readonly authorization?: WinnerLiveProviderAuthorization;
  /** A current external-read grant used only to inspect or reconcile an earlier write. */
  readonly reconciliationAuthorization?: WinnerLiveProviderAuthorization;
  readonly reviewApproval?: WinnerLiveProviderReviewApproval;
  /** Identities only; the adapter resolves both from its authoritative spend store. */
  readonly spendAuthorityRefs?: {
    readonly grantId: string;
    readonly reservationId: string;
  };
  /** Signed durable policy/account/review binding for TikTok organic effects. */
  readonly organicAuthority?: OrganicPolicyExecutionAuthority;
  readonly executionMode: "dry_run" | "authorized_transport";
  readonly environment: "test" | "production";
  readonly now?: () => Date;
}

export interface WinnerLiveProviderDoctorRequest {
  readonly organizationId: string;
  readonly ventureId: string;
  readonly providerAccountId: string;
  readonly features?: readonly WinnerLiveProviderFeature[];
}

export interface WinnerLiveProviderPlanRequest {
  readonly organizationId: string;
  readonly ventureId: string;
  readonly providerAccountId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly feature: WinnerLiveProviderFeature;
  readonly payload: unknown;
}

export interface WinnerLiveProviderPlan {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly providerAccountId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly feature: WinnerLiveProviderFeature;
  readonly effect: WinnerLiveProviderEffect;
  readonly requestHash: string;
  readonly payload: WinnerLiveJsonObject;
  readonly schemaVersion: 1;
  readonly externalExecutionAllowedByPlan: false;
  readonly liveVerification: "pending";
}

export interface WinnerLiveProviderDiagnostic {
  readonly code:
    | "transport_missing"
    | "transport_mismatch"
    | "credential_missing"
    | "credential_invalid"
    | "authorization_missing"
    | "authorization_invalid"
    | "review_missing"
    | "review_invalid"
    | "spend_grant_missing"
    | "spend_grant_invalid"
    | "reservation_missing"
    | "reservation_invalid"
    | "operation_store_missing"
    | "operation_store_unsafe"
    | "organic_policy_missing"
    | "organic_policy_invalid"
    | "organic_policy_stale"
    | "organic_policy_limit"
    | "organic_policy_duplicate"
    | "organic_policy_review_invalid"
    | "organic_policy_rights_invalid"
    | "organic_policy_provider_unavailable"
    | "spend_authority_store_missing"
    | "grant_hash_invalid"
    | "spend_halted"
    | "provider_overspend"
    | "feature_unavailable"
    | "scope_missing"
    | "provider_rejected"
    | "provider_unavailable"
    | "rate_limited"
    | "outcome_ambiguous"
    | "idempotency_conflict"
    | "response_invalid"
    | "verification_pending"
    | "verification_mismatch";
  readonly category:
    | "configuration"
    | "authentication"
    | "authorization"
    | "provider"
    | "idempotency"
    | "verification";
  readonly retryable: boolean;
  readonly message: string;
  readonly nextAction: string;
  readonly providerCode: string | null;
}

export interface WinnerLiveProviderDoctorResult {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly status:
    | "ready"
    | "transport_missing"
    | "auth_required"
    | "authorization_required"
    | "degraded"
    | "unavailable";
  readonly providerInvoked: boolean;
  readonly liveVerified: boolean;
  readonly providerAccountId: string;
  readonly requestedFeatures: readonly WinnerLiveProviderFeature[];
  readonly availableFeatures: readonly WinnerLiveProviderFeature[];
  readonly grantedScopes: readonly string[];
  readonly diagnostics: readonly WinnerLiveProviderDiagnostic[];
  readonly checkedAt: string;
}

export interface WinnerLiveProviderExecutionResult {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly state: "planned" | "blocked" | "accepted_unverified" | "unknown" | "failed" | "conflict";
  readonly reused: boolean;
  readonly providerInvoked: boolean;
  readonly externalEffectOccurred: boolean | "unknown";
  readonly liveVerified: false;
  readonly providerOperationId: string | null;
  readonly output: WinnerLiveJsonObject | null;
  readonly diagnostic: WinnerLiveProviderDiagnostic | null;
}

export interface WinnerLiveProviderReadBackResult {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly state: "matched" | "missing" | "conflict" | "unknown" | "blocked";
  readonly providerInvoked: boolean;
  readonly liveVerified: boolean;
  readonly evidence: WinnerLiveJsonObject | null;
  readonly diagnostic: WinnerLiveProviderDiagnostic | null;
}

export interface WinnerLiveProviderVerificationResult {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly operationId: string;
  readonly state: "verified" | "pending" | "failed" | "blocked";
  readonly providerInvoked: boolean;
  readonly liveVerified: boolean;
  readonly evidence: WinnerLiveJsonObject | null;
  readonly diagnostic: WinnerLiveProviderDiagnostic | null;
}

export interface WinnerLiveProviderReconciliationResult {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly operationId: string;
  readonly state: "matched" | "missing" | "conflict" | "unknown" | "blocked";
  readonly providerInvoked: boolean;
  readonly reapplied: false;
  readonly liveVerified: boolean;
  readonly evidence: WinnerLiveJsonObject | null;
  readonly diagnostic: WinnerLiveProviderDiagnostic | null;
}

export interface WinnerLiveTransportDoctorRequest {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly providerAccountId: string;
  readonly credentialRef: string;
  readonly requestedFeatures: readonly WinnerLiveProviderFeature[];
  readonly requiredScopes: readonly string[];
}

export interface WinnerLiveTransportOperationRequest {
  readonly plan: WinnerLiveProviderPlan;
  readonly credentialRef: string;
}

export interface WinnerLiveTransportDoctorResult {
  readonly state: "ready" | "degraded" | "unavailable";
  readonly observedAccountId: string;
  readonly availableFeatures: readonly WinnerLiveProviderFeature[];
  readonly grantedScopes: readonly string[];
  readonly providerInvoked: boolean;
  readonly liveVerified: boolean;
  readonly diagnostic?: Partial<WinnerLiveProviderDiagnostic> | null;
}

export interface WinnerLiveTransportApplyResult {
  readonly state: "accepted" | "rejected" | "unknown";
  readonly providerOperationId?: string | null;
  readonly providerInvoked: boolean;
  readonly externalEffectOccurred: boolean | "unknown";
  readonly output?: WinnerLiveJsonObject | null;
  readonly diagnostic?: Partial<WinnerLiveProviderDiagnostic> | null;
}

export interface WinnerLiveTransportReadBackResult {
  readonly state: "matched" | "missing" | "conflict" | "unknown";
  readonly providerOperationId?: string | null;
  readonly providerInvoked: boolean;
  readonly liveVerified: boolean;
  readonly evidence?: WinnerLiveJsonObject | null;
  readonly diagnostic?: Partial<WinnerLiveProviderDiagnostic> | null;
}

export interface WinnerLiveProviderTransport {
  readonly adapterId: WinnerLiveProviderId;
  readonly kind: "official_api" | "official_sdk" | "contract_fixture";
  doctor(request: WinnerLiveTransportDoctorRequest): Promise<WinnerLiveTransportDoctorResult>;
  apply(request: WinnerLiveTransportOperationRequest): Promise<WinnerLiveTransportApplyResult>;
  readBack(
    request: WinnerLiveTransportOperationRequest,
  ): Promise<WinnerLiveTransportReadBackResult>;
  reconcile(
    request: WinnerLiveTransportOperationRequest,
  ): Promise<WinnerLiveTransportReadBackResult>;
}

export class WinnerLiveTransportError extends Error {
  constructor(
    readonly providerCode: string,
    readonly writeDisposition: "confirmed_no_effect" | "ambiguous" | "effect_may_have_occurred",
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "WinnerLiveTransportError";
  }
}

export class WinnerLiveProviderContractError extends Error {
  constructor(
    readonly code:
      "invalid_request" | "unsupported_feature" | "unsafe_payload" | "plan_adapter_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "WinnerLiveProviderContractError";
  }
}

export interface WinnerLiveProviderStoredOperation {
  readonly adapterId: WinnerLiveProviderId;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  /** Immutable authorization identities captured before the paid provider write. */
  readonly paidSpendBinding: {
    readonly grantId: string;
    readonly reservationId: string;
  } | null;
  readonly state:
    | "pending"
    | "accepted_unverified"
    | "ambiguous"
    | "failed"
    | "verified"
    | "confirmed_absent"
    | "conflict";
  readonly providerOperationId: string | null;
  readonly output: WinnerLiveJsonObject | null;
  readonly evidence: WinnerLiveJsonObject | null;
  readonly updatedAt: string;
}

export interface WinnerLiveProviderOperationClaimInput {
  readonly ownerToken: string;
  readonly now: string;
}

export type WinnerLiveProviderOperationClaim =
  | {
      readonly kind: "owner";
      readonly ownerToken: string;
      readonly claimedAt: string;
      readonly pendingExpiresAt: string;
    }
  | { readonly kind: "replay"; readonly record: WinnerLiveProviderStoredOperation }
  | { readonly kind: "conflict"; readonly existingRequestHash: string }
  | {
      readonly kind: "pending";
      readonly claimedAt: string;
      readonly pendingExpiresAt: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly claimedAt: string;
      readonly ambiguousAt: string;
    };

export interface WinnerLiveProviderOperationCompletion {
  readonly ownerToken: string;
  readonly record: WinnerLiveProviderStoredOperation & {
    readonly state: "accepted_unverified" | "failed";
  };
}

export interface WinnerLiveProviderOperationAmbiguousFailure {
  readonly ownerToken: string;
  readonly record: WinnerLiveProviderStoredOperation & { readonly state: "ambiguous" };
}

export interface WinnerLiveProviderOperationStore {
  readonly durability: "durable_atomic" | "ephemeral_fixture";
  readonly atomicClaims: true;
  get(
    organizationId: string,
    ventureId: string,
    adapterId: WinnerLiveProviderId,
    idempotencyKey: string,
  ): Promise<WinnerLiveProviderStoredOperation | undefined>;
  claim(
    record: WinnerLiveProviderStoredOperation & { readonly state: "pending" },
    input: WinnerLiveProviderOperationClaimInput,
  ): Promise<WinnerLiveProviderOperationClaim>;
  complete(input: WinnerLiveProviderOperationCompletion): Promise<void>;
  markAmbiguous(input: WinnerLiveProviderOperationAmbiguousFailure): Promise<void>;
  /** Hash-bound read-back transition. This must never invoke or replay provider apply. */
  reconcile(record: WinnerLiveProviderStoredOperation): Promise<void>;
}

const sqliteWinnerOperationStores = new WeakSet<WinnerLiveProviderOperationStore>();

/** Authoritative bridge to the transactional Winner Loop spend store. */
export interface WinnerLivePaidAuthorizationStore {
  readonly authoritative: true;
  getGrant(scope: SpendScope, grantId: string): Promise<SpendGrant | undefined>;
  getReservation(scope: SpendScope, reservationId: string): Promise<Reservation | undefined>;
  verifyGrantHash(scope: SpendScope, grant: SpendGrant): Promise<boolean>;
  isGrantHalted(scope: SpendScope, grantId: string): Promise<boolean>;
  /**
   * Commit provider-observed spend through the same transactional ledger that
   * reserved the budget. Implementations must be idempotent for an identical
   * reservation/value pair and must atomically record the real amount, halt the
   * grant, raise an incident, and queue a provider-pause obligation on
   * overspend. Read-back is not allowed to hide an over-cap amount as a generic
   * verification mismatch.
   */
  recordProviderSpend(
    scope: SpendScope,
    reservationId: string,
    actualSpendMinor: number,
  ): Promise<WinnerLivePaidSpendRecord>;
}

export interface WinnerLivePaidSpendRecord {
  readonly reservation: Reservation;
  readonly overspendRecorded: boolean;
  readonly grantHalted: boolean;
  readonly providerPauseQueued: boolean;
}

interface MemoryWinnerLiveProviderOperationEntry {
  record: WinnerLiveProviderStoredOperation;
  ownerToken: string | null;
  claimedAt: string;
  pendingExpiresAt: string;
  ambiguousAt: string | null;
}

function operationTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function operationStoreIdentity(
  organizationId: string,
  ventureId: string,
  adapterId: WinnerLiveProviderId,
  idempotencyKey: string,
): string {
  const values = { organizationId, ventureId, adapterId, idempotencyKey };
  for (const [label, value] of Object.entries(values)) {
    if (!value.trim()) throw new Error(`${label} must not be empty`);
  }
  // JSON string escaping makes this tuple injective even for direct callers
  // whose tenant identifiers contain delimiters or control characters.
  return JSON.stringify([organizationId, ventureId, adapterId, idempotencyKey]);
}

function validateStoredOperation(record: WinnerLiveProviderStoredOperation): void {
  operationStoreIdentity(
    record.organizationId,
    record.ventureId,
    record.adapterId,
    record.idempotencyKey,
  );
  if (!record.operationId.trim()) throw new Error("operationId must not be empty");
  if (!/^[a-f0-9]{64}$/u.test(record.requestHash)) {
    throw new Error("requestHash must be a lowercase SHA-256 digest");
  }
  if (record.providerOperationId !== null && !IDENTIFIER.test(record.providerOperationId)) {
    throw new Error("providerOperationId must be a provider-safe identifier");
  }
  if (
    record.paidSpendBinding &&
    (!IDENTIFIER.test(record.paidSpendBinding.grantId) ||
      !IDENTIFIER.test(record.paidSpendBinding.reservationId))
  ) {
    throw new Error("paid spend binding must contain provider-safe grant and reservation IDs");
  }
  operationTimestamp(record.updatedAt, "operation updatedAt");
  if (record.output) assertSafeJson(record.output, "operation.output");
  if (record.evidence) assertSafeJson(record.evidence, "operation.evidence");
}

function cloneStoredOperation(
  record: WinnerLiveProviderStoredOperation,
): WinnerLiveProviderStoredOperation {
  validateStoredOperation(record);
  return Object.freeze({
    ...record,
    paidSpendBinding: record.paidSpendBinding
      ? Object.freeze({ ...record.paidSpendBinding })
      : null,
    output: record.output
      ? Object.freeze(structuredClone(record.output) as WinnerLiveJsonObject)
      : null,
    evidence: record.evidence
      ? Object.freeze(structuredClone(record.evidence) as WinnerLiveJsonObject)
      : null,
  });
}

function sameStoredOperation(
  left: WinnerLiveProviderStoredOperation,
  right: WinnerLiveProviderStoredOperation,
): boolean {
  return (
    JSON.stringify(stableValue(left as unknown as WinnerLiveJsonValue)) ===
    JSON.stringify(stableValue(right as unknown as WinnerLiveJsonValue))
  );
}

function samePaidSpendBinding(
  left: WinnerLiveProviderStoredOperation["paidSpendBinding"],
  right: WinnerLiveProviderStoredOperation["paidSpendBinding"],
): boolean {
  return left?.grantId === right?.grantId && left?.reservationId === right?.reservationId;
}

export function createMemoryWinnerLiveProviderOperationStore(
  options: { readonly pendingTimeoutMs?: number } = {},
): WinnerLiveProviderOperationStore {
  const pendingTimeoutMs = options.pendingTimeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(pendingTimeoutMs) || pendingTimeoutMs < 1) {
    throw new Error("pendingTimeoutMs must be a positive safe integer");
  }
  const records = new Map<string, MemoryWinnerLiveProviderOperationEntry>();
  const keyOf = (
    organizationId: string,
    ventureId: string,
    adapterId: WinnerLiveProviderId,
    idempotencyKey: string,
  ) => operationStoreIdentity(organizationId, ventureId, adapterId, idempotencyKey);
  const store: WinnerLiveProviderOperationStore = {
    durability: "ephemeral_fixture",
    atomicClaims: true,
    get: async (
      organizationId: string,
      ventureId: string,
      adapterId: WinnerLiveProviderId,
      idempotencyKey: string,
    ) => records.get(keyOf(organizationId, ventureId, adapterId, idempotencyKey))?.record,
    async claim(
      record: WinnerLiveProviderStoredOperation & { readonly state: "pending" },
      input: WinnerLiveProviderOperationClaimInput,
    ): Promise<WinnerLiveProviderOperationClaim> {
      validateStoredOperation(record);
      if (!input.ownerToken.trim()) throw new Error("ownerToken must not be empty");
      const nowMs = operationTimestamp(input.now, "claim now");
      const key = keyOf(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      const current = records.get(key);
      if (!current) {
        const pendingExpiresAt = new Date(nowMs + pendingTimeoutMs).toISOString();
        records.set(key, {
          record: cloneStoredOperation(record),
          ownerToken: input.ownerToken,
          claimedAt: input.now,
          pendingExpiresAt,
          ambiguousAt: null,
        });
        return {
          kind: "owner",
          ownerToken: input.ownerToken,
          claimedAt: input.now,
          pendingExpiresAt,
        };
      }
      if (current.record.requestHash !== record.requestHash) {
        return { kind: "conflict", existingRequestHash: current.record.requestHash };
      }
      if (!samePaidSpendBinding(current.record.paidSpendBinding, record.paidSpendBinding)) {
        return { kind: "conflict", existingRequestHash: current.record.requestHash };
      }
      if (current.record.state === "ambiguous") {
        return {
          kind: "ambiguous",
          claimedAt: current.claimedAt,
          ambiguousAt: current.ambiguousAt ?? current.record.updatedAt,
        };
      }
      if (current.record.state !== "pending") {
        return { kind: "replay", record: cloneStoredOperation(current.record) };
      }
      if (nowMs >= operationTimestamp(current.pendingExpiresAt, "pending expiry")) {
        const ambiguous = cloneStoredOperation({
          ...current.record,
          state: "ambiguous",
          updatedAt: input.now,
        });
        records.set(key, {
          ...current,
          record: ambiguous,
          ownerToken: null,
          ambiguousAt: input.now,
        });
        return { kind: "ambiguous", claimedAt: current.claimedAt, ambiguousAt: input.now };
      }
      return {
        kind: "pending",
        claimedAt: current.claimedAt,
        pendingExpiresAt: current.pendingExpiresAt,
      };
    },
    async complete(input: WinnerLiveProviderOperationCompletion): Promise<void> {
      const { record, ownerToken } = input;
      validateStoredOperation(record);
      const key = keyOf(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      const current = records.get(key);
      if (!current) throw new Error("cannot complete an operation claim that does not exist");
      if (current.record.requestHash !== record.requestHash) {
        throw new Error("cannot complete an operation claim bound to different input");
      }
      if (current.record.state !== "pending") {
        if (sameStoredOperation(current.record, record)) return;
        throw new Error("completed operation outcome is immutable");
      }
      if (current.ownerToken !== ownerToken) {
        throw new Error("only the operation claim owner may complete it");
      }
      records.set(key, {
        ...current,
        record: cloneStoredOperation(record),
        ownerToken: null,
      });
    },
    async markAmbiguous(input: WinnerLiveProviderOperationAmbiguousFailure): Promise<void> {
      const { record, ownerToken } = input;
      validateStoredOperation(record);
      const key = keyOf(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      const current = records.get(key);
      if (!current) throw new Error("cannot mark an operation claim that does not exist");
      if (current.record.requestHash !== record.requestHash) {
        throw new Error("cannot mark an operation claim bound to different input");
      }
      if (current.record.state === "ambiguous") return;
      if (current.record.state !== "pending" || current.ownerToken !== ownerToken) {
        throw new Error("only the operation claim owner may mark it ambiguous");
      }
      records.set(key, {
        ...current,
        record: cloneStoredOperation(record),
        ownerToken: null,
        ambiguousAt: record.updatedAt,
      });
    },
    async reconcile(record: WinnerLiveProviderStoredOperation): Promise<void> {
      validateStoredOperation(record);
      if (record.state === "pending" || record.state === "accepted_unverified") {
        throw new Error("reconciliation must record an observed terminal or ambiguous state");
      }
      const key = keyOf(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      const current = records.get(key);
      if (!current) throw new Error("cannot reconcile an operation claim that does not exist");
      if (current.record.requestHash !== record.requestHash) {
        throw new Error("cannot reconcile an operation claim bound to different input");
      }
      if (current.record.state === "verified" && record.state !== "verified") return;
      if (
        current.record.state === "confirmed_absent" &&
        record.state !== "confirmed_absent" &&
        record.state !== "verified"
      ) {
        return;
      }
      records.set(key, {
        ...current,
        record: cloneStoredOperation(record),
        ownerToken: null,
        ambiguousAt: record.state === "ambiguous" ? record.updatedAt : current.ambiguousAt,
      });
    },
  };
  return Object.freeze(store);
}

interface WinnerLiveSqliteStatement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): unknown;
}

interface WinnerLiveSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): WinnerLiveSqliteStatement;
  close(): void;
}

interface WinnerLiveSqliteOperationRow {
  organization_id: string;
  venture_id: string;
  adapter_id: WinnerLiveProviderId;
  operation_id: string;
  idempotency_key: string;
  request_hash: string;
  paid_grant_id: string | null;
  paid_reservation_id: string | null;
  state: WinnerLiveProviderStoredOperation["state"];
  owner_token: string | null;
  claimed_at: string;
  pending_expires_at: string;
  ambiguous_at: string | null;
  provider_operation_id: string | null;
  output_json: string | null;
  evidence_json: string | null;
  updated_at: string;
}

function winnerLiveSqliteDatabase(path: string): WinnerLiveSqliteDatabase {
  try {
    const moduleLocation = typeof __filename === "string" ? __filename : import.meta.url;
    const { DatabaseSync } = createRequire(moduleLocation)("node:sqlite") as {
      DatabaseSync: new (filename: string) => WinnerLiveSqliteDatabase;
    };
    return new DatabaseSync(path);
  } catch (error) {
    throw new Error(
      `the durable Winner provider operation store requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

function storedJson(value: WinnerLiveJsonObject | null): string | null {
  return value === null ? null : JSON.stringify(stableValue(value));
}

function parseStoredJson(value: string | null, label: string): WinnerLiveJsonObject | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must contain a JSON object`);
  }
  assertSafeJson(parsed, label);
  return Object.freeze(parsed as WinnerLiveJsonObject);
}

function ensureWinnerOperationColumn(
  database: WinnerLiveSqliteDatabase,
  column: string,
  declaration: string,
): void {
  const columns = database.prepare("PRAGMA table_info(winner_live_provider_operations)").all() as {
    name: string;
  }[];
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(
      `ALTER TABLE winner_live_provider_operations ADD COLUMN ${column} ${declaration}`,
    );
  }
}

/** Cross-process atomic, tenant-scoped journal for authorized Winner provider effects. */
export class SqliteWinnerLiveProviderOperationStore implements WinnerLiveProviderOperationStore {
  readonly durability = "durable_atomic" as const;
  readonly atomicClaims = true as const;
  readonly #database: WinnerLiveSqliteDatabase;
  readonly #pendingTimeoutMs: number;

  constructor(path: string, options: { readonly pendingTimeoutMs?: number } = {}) {
    if (path === ":memory:") {
      throw new Error("the durable Winner provider operation store requires a filesystem path");
    }
    if (!path.trim()) throw new Error("SQLite operation-store path must not be empty");
    this.#pendingTimeoutMs = options.pendingTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#pendingTimeoutMs) || this.#pendingTimeoutMs < 1) {
      throw new Error("pendingTimeoutMs must be a positive safe integer");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = winnerLiveSqliteDatabase(path);
    initializeSqliteWal(this.#database, { label: "Winner provider operation store" });
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS winner_live_provider_operations (
        organization_id TEXT NOT NULL,
        venture_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        paid_grant_id TEXT,
        paid_reservation_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN (
            'pending', 'accepted_unverified', 'ambiguous', 'failed', 'verified',
            'confirmed_absent', 'conflict'
          )
        ),
        owner_token TEXT,
        claimed_at TEXT NOT NULL,
        pending_expires_at TEXT NOT NULL,
        ambiguous_at TEXT,
        provider_operation_id TEXT,
        output_json TEXT,
        evidence_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, venture_id, adapter_id, idempotency_key),
        CHECK (
          (state = 'pending' AND owner_token IS NOT NULL AND ambiguous_at IS NULL)
          OR (state = 'ambiguous' AND owner_token IS NULL AND ambiguous_at IS NOT NULL)
          OR (state NOT IN ('pending', 'ambiguous') AND owner_token IS NULL)
        )
      )
    `);
    ensureWinnerOperationColumn(this.#database, "paid_grant_id", "TEXT");
    ensureWinnerOperationColumn(this.#database, "paid_reservation_id", "TEXT");
    chmodSync(path, 0o600);
    sqliteWinnerOperationStores.add(this);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original transactional failure.
      }
      throw error;
    }
  }

  #read(
    organizationId: string,
    ventureId: string,
    adapterId: WinnerLiveProviderId,
    idempotencyKey: string,
  ): WinnerLiveSqliteOperationRow | undefined {
    operationStoreIdentity(organizationId, ventureId, adapterId, idempotencyKey);
    return this.#database
      .prepare(
        `SELECT organization_id, venture_id, adapter_id, operation_id, idempotency_key,
                request_hash, paid_grant_id, paid_reservation_id,
                state, owner_token, claimed_at, pending_expires_at,
                ambiguous_at, provider_operation_id, output_json, evidence_json, updated_at
           FROM winner_live_provider_operations
          WHERE organization_id = ? AND venture_id = ? AND adapter_id = ?
            AND idempotency_key = ?`,
      )
      .get(organizationId, ventureId, adapterId, idempotencyKey) as
      WinnerLiveSqliteOperationRow | undefined;
  }

  #record(row: WinnerLiveSqliteOperationRow): WinnerLiveProviderStoredOperation {
    if ((row.paid_grant_id === null) !== (row.paid_reservation_id === null)) {
      throw new Error("stored paid spend binding is incomplete");
    }
    return cloneStoredOperation({
      adapterId: row.adapter_id,
      organizationId: row.organization_id,
      ventureId: row.venture_id,
      operationId: row.operation_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      paidSpendBinding:
        row.paid_grant_id !== null && row.paid_reservation_id !== null
          ? Object.freeze({
              grantId: row.paid_grant_id,
              reservationId: row.paid_reservation_id,
            })
          : null,
      state: row.state,
      providerOperationId: row.provider_operation_id,
      output: parseStoredJson(row.output_json, "stored provider output"),
      evidence: parseStoredJson(row.evidence_json, "stored provider evidence"),
      updatedAt: row.updated_at,
    });
  }

  async get(
    organizationId: string,
    ventureId: string,
    adapterId: WinnerLiveProviderId,
    idempotencyKey: string,
  ): Promise<WinnerLiveProviderStoredOperation | undefined> {
    const row = this.#read(organizationId, ventureId, adapterId, idempotencyKey);
    return row ? this.#record(row) : undefined;
  }

  async claim(
    record: WinnerLiveProviderStoredOperation & { readonly state: "pending" },
    input: WinnerLiveProviderOperationClaimInput,
  ): Promise<WinnerLiveProviderOperationClaim> {
    validateStoredOperation(record);
    if (!input.ownerToken.trim()) throw new Error("ownerToken must not be empty");
    const nowMs = operationTimestamp(input.now, "claim now");
    return this.#transaction(() => {
      const existing = this.#read(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      if (!existing) {
        const pendingExpiresAt = new Date(nowMs + this.#pendingTimeoutMs).toISOString();
        this.#database
          .prepare(
            `INSERT INTO winner_live_provider_operations
              (organization_id, venture_id, adapter_id, operation_id, idempotency_key,
               request_hash, paid_grant_id, paid_reservation_id,
               state, owner_token, claimed_at, pending_expires_at,
               ambiguous_at, provider_operation_id, output_json, evidence_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
          )
          .run(
            record.organizationId,
            record.ventureId,
            record.adapterId,
            record.operationId,
            record.idempotencyKey,
            record.requestHash,
            record.paidSpendBinding?.grantId ?? null,
            record.paidSpendBinding?.reservationId ?? null,
            input.ownerToken,
            input.now,
            pendingExpiresAt,
            record.updatedAt,
          );
        return {
          kind: "owner",
          ownerToken: input.ownerToken,
          claimedAt: input.now,
          pendingExpiresAt,
        };
      }
      if (existing.request_hash !== record.requestHash) {
        return { kind: "conflict", existingRequestHash: existing.request_hash };
      }
      const existingBinding =
        existing.paid_grant_id !== null && existing.paid_reservation_id !== null
          ? {
              grantId: existing.paid_grant_id,
              reservationId: existing.paid_reservation_id,
            }
          : null;
      if (!samePaidSpendBinding(existingBinding, record.paidSpendBinding)) {
        return { kind: "conflict", existingRequestHash: existing.request_hash };
      }
      if (existing.state === "ambiguous") {
        if (!existing.ambiguous_at) throw new Error("ambiguous operation row is corrupt");
        return {
          kind: "ambiguous",
          claimedAt: existing.claimed_at,
          ambiguousAt: existing.ambiguous_at,
        };
      }
      if (existing.state !== "pending") {
        return { kind: "replay", record: this.#record(existing) };
      }
      if (nowMs >= operationTimestamp(existing.pending_expires_at, "pending expiry")) {
        this.#database
          .prepare(
            `UPDATE winner_live_provider_operations
                SET state = 'ambiguous', owner_token = NULL, ambiguous_at = ?, updated_at = ?
              WHERE organization_id = ? AND venture_id = ? AND adapter_id = ?
                AND idempotency_key = ? AND state = 'pending'`,
          )
          .run(
            input.now,
            input.now,
            record.organizationId,
            record.ventureId,
            record.adapterId,
            record.idempotencyKey,
          );
        return { kind: "ambiguous", claimedAt: existing.claimed_at, ambiguousAt: input.now };
      }
      return {
        kind: "pending",
        claimedAt: existing.claimed_at,
        pendingExpiresAt: existing.pending_expires_at,
      };
    });
  }

  async complete(input: WinnerLiveProviderOperationCompletion): Promise<void> {
    const { record, ownerToken } = input;
    validateStoredOperation(record);
    if (!ownerToken.trim()) throw new Error("ownerToken must not be empty");
    this.#transaction(() => {
      const existing = this.#read(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      if (!existing) throw new Error("cannot complete an operation claim that does not exist");
      if (existing.request_hash !== record.requestHash) {
        throw new Error("cannot complete an operation claim bound to different input");
      }
      if (existing.state !== "pending") {
        if (sameStoredOperation(this.#record(existing), record)) return;
        throw new Error("completed operation outcome is immutable");
      }
      if (existing.owner_token !== ownerToken) {
        throw new Error("only the operation claim owner may complete it");
      }
      this.#database
        .prepare(
          `UPDATE winner_live_provider_operations
              SET state = ?, owner_token = NULL, ambiguous_at = NULL,
                  provider_operation_id = ?, output_json = ?, evidence_json = ?, updated_at = ?
            WHERE organization_id = ? AND venture_id = ? AND adapter_id = ?
              AND idempotency_key = ? AND state = 'pending' AND owner_token = ?`,
        )
        .run(
          record.state,
          record.providerOperationId,
          storedJson(record.output),
          storedJson(record.evidence),
          record.updatedAt,
          record.organizationId,
          record.ventureId,
          record.adapterId,
          record.idempotencyKey,
          ownerToken,
        );
    });
  }

  async markAmbiguous(input: WinnerLiveProviderOperationAmbiguousFailure): Promise<void> {
    const { record, ownerToken } = input;
    validateStoredOperation(record);
    if (!ownerToken.trim()) throw new Error("ownerToken must not be empty");
    this.#transaction(() => {
      const existing = this.#read(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      if (!existing) throw new Error("cannot mark an operation claim that does not exist");
      if (existing.request_hash !== record.requestHash) {
        throw new Error("cannot mark an operation claim bound to different input");
      }
      if (existing.state === "ambiguous") return;
      if (existing.state !== "pending" || existing.owner_token !== ownerToken) {
        throw new Error("only the operation claim owner may mark it ambiguous");
      }
      this.#database
        .prepare(
          `UPDATE winner_live_provider_operations
              SET state = 'ambiguous', owner_token = NULL, ambiguous_at = ?,
                  provider_operation_id = ?, output_json = ?, evidence_json = ?, updated_at = ?
            WHERE organization_id = ? AND venture_id = ? AND adapter_id = ?
              AND idempotency_key = ? AND state = 'pending' AND owner_token = ?`,
        )
        .run(
          record.updatedAt,
          record.providerOperationId,
          storedJson(record.output),
          storedJson(record.evidence),
          record.updatedAt,
          record.organizationId,
          record.ventureId,
          record.adapterId,
          record.idempotencyKey,
          ownerToken,
        );
    });
  }

  async reconcile(record: WinnerLiveProviderStoredOperation): Promise<void> {
    validateStoredOperation(record);
    if (record.state === "pending" || record.state === "accepted_unverified") {
      throw new Error("reconciliation must record an observed terminal or ambiguous state");
    }
    this.#transaction(() => {
      const existing = this.#read(
        record.organizationId,
        record.ventureId,
        record.adapterId,
        record.idempotencyKey,
      );
      if (!existing) throw new Error("cannot reconcile an operation claim that does not exist");
      if (existing.request_hash !== record.requestHash) {
        throw new Error("cannot reconcile an operation claim bound to different input");
      }
      if (existing.state === "verified" && record.state !== "verified") return;
      if (
        existing.state === "confirmed_absent" &&
        record.state !== "confirmed_absent" &&
        record.state !== "verified"
      )
        return;
      this.#database
        .prepare(
          `UPDATE winner_live_provider_operations
              SET state = ?, owner_token = NULL, ambiguous_at = ?,
                  provider_operation_id = ?, output_json = ?, evidence_json = ?, updated_at = ?
            WHERE organization_id = ? AND venture_id = ? AND adapter_id = ?
              AND idempotency_key = ? AND request_hash = ?`,
        )
        .run(
          record.state,
          record.state === "ambiguous" ? record.updatedAt : null,
          record.providerOperationId,
          storedJson(record.output),
          storedJson(record.evidence),
          record.updatedAt,
          record.organizationId,
          record.ventureId,
          record.adapterId,
          record.idempotencyKey,
          record.requestHash,
        );
    });
  }

  close(): void {
    this.#database.close();
  }
}

const CREDENTIAL_REF = /^cred:\/\/[a-z0-9][a-z0-9/_:.-]*$/iu;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:~-]{0,254}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SECRET_KEY =
  /(?:authorization|api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|upload[-_]?url)/iu;
const SECRET_VALUE =
  /(?:bearer\s+[a-z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;

const id = z.string().trim().min(1).max(255).regex(IDENTIFIER);
const reference = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !SECRET_VALUE.test(value), "reference resembles credential material");
const date = z.string().datetime({ offset: true });
const currency = z.string().regex(CURRENCY);
const positiveMinor = z.number().int().positive().safe();
const nonnegativeMinor = z.number().int().nonnegative().safe();

const creativePayloadSchema = z
  .object({
    operation: z.literal("generate_video"),
    creative_id: id,
    provider_model: z.string().trim().min(1).max(200),
    prompt_ref: reference,
    asset_manifest_ref: reference,
    rights_manifest_ref: reference,
    output_destination_ref: reference,
    aspect_ratio: z.enum(["9:16", "1:1", "16:9"]),
    max_cost_minor: nonnegativeMinor,
    currency,
  })
  .strict();

const mediaSchema = z
  .object({
    method: z.enum(["brokered_file_upload", "verified_domain_pull"]),
    media_ref: reference,
    size_bytes: z.number().int().positive().safe(),
    mime_type: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  })
  .strict();

const tiktokDraftPayloadSchema = z
  .object({
    operation: z.literal("upload_draft"),
    creative_id: id,
    creator_info_ref: reference,
    user_consent_ref: reference,
    policy_snapshot_ref: reference,
    media: mediaSchema,
  })
  .strict();

const tiktokDirectPayloadSchema = z
  .object({
    operation: z.literal("publish_direct"),
    creative_id: id,
    creator_info_ref: reference,
    user_consent_ref: reference,
    policy_snapshot_ref: reference,
    media: mediaSchema,
    title: z.string().max(2_200),
    privacy_level: z.enum([
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ]),
    disable_duet: z.boolean(),
    disable_stitch: z.boolean(),
    disable_comment: z.boolean(),
    brand_content_toggle: z.boolean(),
    brand_organic_toggle: z.boolean(),
    is_aigc: z.boolean(),
  })
  .strict();

const sparkPayloadSchema = z
  .object({
    operation: z.literal("create_spark_paid_test"),
    proposal_id: id,
    creative_id: id,
    source_post_id: id,
    spark_authorization_ref: reference,
    advertiser_id: id,
    campaign_key: id,
    objective: z.string().trim().min(1).max(100),
    optimization_event: z.string().trim().min(1).max(100),
    geographies: z.array(z.string().trim().min(2).max(100)).min(1).max(100),
    total_budget_minor: positiveMinor,
    daily_cap_minor: positiveMinor,
    reserved_minor: positiveMinor,
    currency,
    start_at: date,
    end_at: date,
    auto_scale: z.literal(false),
    scale_mode: z.literal("manual_recommendation_only"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.daily_cap_minor > value.total_budget_minor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daily_cap_minor"],
        message: "daily cap cannot exceed the total budget",
      });
    }
    if (value.reserved_minor !== value.total_budget_minor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reserved_minor"],
        message: "the held reservation must equal the bounded paid-test budget",
      });
    }
    if (Date.parse(value.start_at) >= Date.parse(value.end_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_at"],
        message: "paid test end must be after its start",
      });
    }
  });

const sparkPausePayloadSchema = z
  .object({
    operation: z.literal("pause_campaign"),
    campaign_id: id,
    advertiser_id: id,
    pause_reason: z.enum([
      "tracking_health_failed",
      "attribution_mapping_broken",
      "provider_policy_warning",
      "hard_budget_reached",
      "provider_overspend",
      "stop_condition_triggered",
      "refund_rate_anomaly",
      "rights_invalid",
      "disclosure_violation",
      "connection_revoked",
      "manual_kill_switch",
    ]),
    incident_ref: reference,
    observed_spend_minor: nonnegativeMinor,
    currency,
    requested_at: date,
  })
  .strict();

const attributionClass = z.enum([
  "PROVIDER_ATTRIBUTED",
  "PRIVACY_AGGREGATED",
  "CORRELATED",
  "MODELED",
  "INCREMENTAL_EXPERIMENT",
  "UNKNOWN",
]);

const attributionPayloadSchema = z
  .object({
    operation: z.literal("read_aggregates"),
    provider_kind: z.string().trim().min(1).max(100),
    dataset_ref: reference,
    creative_ids: z.array(id).min(1).max(1_000),
    window_start: date,
    window_end: date,
    allowed_attribution_classes: z.array(attributionClass).min(1),
    aggregate_only: z.literal(true),
    include_person_level_rows: z.literal(false),
  })
  .strict()
  .refine((value) => Date.parse(value.window_start) < Date.parse(value.window_end), {
    path: ["window_end"],
    message: "attribution window end must be after its start",
  });

const revenueCatPayloadSchema = z
  .object({
    operation: z.literal("read_lifecycle_aggregates"),
    project_id: id,
    environment: z.enum(["sandbox", "production"]),
    window_start: date,
    window_end: date,
    currency,
    cohort_periods: z.array(z.enum(["D0", "D7", "D30", "D90"])).min(1),
    lifecycle_event_types: z
      .array(
        z.enum([
          "INITIAL_PURCHASE",
          "RENEWAL",
          "CANCELLATION",
          "UNCANCELLATION",
          "NON_RENEWING_PURCHASE",
          "SUBSCRIPTION_PAUSED",
          "EXPIRATION",
          "BILLING_ISSUE",
          "PRODUCT_CHANGE",
          "TRANSFER",
          "REFUND_REVERSED",
        ]),
      )
      .min(1),
    aggregate_only: z.literal(true),
    include_subscriber_payload: z.literal(false),
  })
  .strict()
  .refine((value) => Date.parse(value.window_start) < Date.parse(value.window_end), {
    path: ["window_end"],
    message: "RevenueCat window end must be after its start",
  });

type PayloadSchema = z.ZodType<WinnerLiveJsonObject>;

function stableValue(value: WinnerLiveJsonValue): WinnerLiveJsonValue {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function hashRequest(value: WinnerLiveJsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function assertSafeJson(value: unknown, path = "value"): asserts value is WinnerLiveJsonValue {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJson(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const referenceKey = /(?:^|_)(?:ref|reference)$/iu.test(key);
      if (SECRET_KEY.test(key) && !referenceKey) {
        throw new WinnerLiveProviderContractError(
          "unsafe_payload",
          `Secret-bearing field ${path}.${key} is forbidden; pass only broker references`,
        );
      }
      assertSafeJson(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    throw new WinnerLiveProviderContractError(
      "unsafe_payload",
      `Credential-like value is forbidden at ${path}`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new WinnerLiveProviderContractError("unsafe_payload", `Non-finite value at ${path}`);
  }
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
    throw new WinnerLiveProviderContractError("unsafe_payload", `Non-JSON value at ${path}`);
  }
}

function redactString(value: string, key: string): string {
  if (SECRET_VALUE.test(value)) return "[REDACTED]";
  if (/url/iu.test(key)) {
    try {
      const url = new URL(value);
      if (
        [...url.searchParams.keys()].some((name) =>
          /(?:token|signature|secret|key|authorization)/iu.test(name),
        )
      ) {
        return `${url.origin}${url.pathname}?[REDACTED]`;
      }
    } catch {
      // A non-URL string needs no URL-specific redaction.
    }
  }
  return value;
}

function redactValue(value: unknown, key = ""): unknown {
  const referenceKey = /(?:^|_)(?:ref|reference)$/iu.test(key);
  if (SECRET_KEY.test(key) && !referenceKey) return "[REDACTED]";
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, entry]) => [
        childKey,
        redactValue(entry, childKey),
      ]),
    );
  }
  return value;
}

function safeJsonObject(value: unknown): WinnerLiveJsonObject | null {
  if (value === null || value === undefined) return null;
  const redacted = redactValue(value);
  assertSafeJson(redacted);
  if (redacted === null || Array.isArray(redacted) || typeof redacted !== "object") {
    throw new WinnerLiveProviderContractError(
      "unsafe_payload",
      "Provider output must be a JSON object",
    );
  }
  return Object.freeze({ ...(redacted as WinnerLiveJsonObject) });
}

function safeProviderOperationId(value: string | null | undefined): string | null {
  const normalized = value?.trim() || null;
  if (normalized !== null && !IDENTIFIER.test(normalized)) {
    throw new WinnerLiveProviderContractError(
      "unsafe_payload",
      "Provider operation identity was not a safe opaque identifier",
    );
  }
  return normalized;
}

function descriptor(
  input: Omit<
    WinnerLiveProviderDescriptor,
    "implementation" | "liveVerification" | "idempotencyStrategy"
  >,
): WinnerLiveProviderDescriptor {
  return Object.freeze({
    ...input,
    implementation: "injected_official_transport",
    liveVerification: "pending",
    idempotencyStrategy: "atomic_harness_claim_and_provider_key_when_supported",
    documentation: Object.freeze([...input.documentation]),
    features: Object.freeze(input.features.map((feature) => Object.freeze({ ...feature }))),
    limitations: Object.freeze([...input.limitations]),
  });
}

export const WINNER_LIVE_PROVIDER_DESCRIPTORS: Readonly<
  Record<WinnerLiveProviderId, WinnerLiveProviderDescriptor>
> = Object.freeze({
  creative_generation: descriptor({
    id: "creative_generation",
    displayName: "Creative generation provider contract",
    category: "creative_generation",
    documentation: [],
    features: [
      {
        feature: "creative.video.generate",
        effect: "reversible_external_write",
        credentialKind: "provider API token or delegated OAuth credential",
        requiredScopes: ["creative.video.generate"],
        requiredAccountChecks: [
          "selected model is available",
          "output destination is customer- or venture-owned",
          "rights manifest remains valid",
          "maximum generation cost is known and authorized",
        ],
        distinctReview: null,
        readBackRequired: true,
      },
    ],
    limitations: [
      "A concrete creative vendor must supply an official transport and current vendor documentation.",
      "The contract stores references and hashes, never prompt secrets or private media bytes.",
    ],
  }),
  tiktok_content_posting: descriptor({
    id: "tiktok_content_posting",
    displayName: "TikTok Content Posting API",
    category: "organic_publication",
    documentation: [
      "https://developers.tiktok.com/doc/content-posting-api-reference-upload-video",
      "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
      "https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status",
      "https://developers.tiktok.com/doc/content-sharing-guidelines/",
    ],
    features: [
      {
        feature: "distribution.content.draft",
        effect: "reversible_external_write",
        credentialKind: "TikTok OAuth user access token broker reference",
        requiredScopes: ["video.upload"],
        requiredAccountChecks: [
          "creator info queried before upload",
          "user consent recorded",
          "media transfer method and verified-domain requirements checked",
        ],
        distinctReview: null,
        readBackRequired: true,
      },
      {
        feature: "distribution.content.publish",
        effect: "public_communication",
        credentialKind: "TikTok OAuth user access token broker reference",
        requiredScopes: ["video.publish"],
        requiredAccountChecks: [
          "creator privacy choices read and honored",
          "client audit and account publication state checked",
          "explicit user consent and human publication review recorded",
        ],
        distinctReview: "organic.direct_publish",
        readBackRequired: true,
      },
    ],
    limitations: [
      "Unaudited TikTok clients may be restricted to private visibility.",
      "Provider moderation can delay the final post identifier, so acceptance is not publication proof.",
    ],
  }),
  tiktok_spark_ads: descriptor({
    id: "tiktok_spark_ads",
    displayName: "TikTok Marketing API Spark Ads",
    category: "paid_acquisition",
    documentation: [
      "https://ads.tiktok.com/help/article/marketing-api?lang=en",
      "https://ads.tiktok.com/help/article/spark-ads?lang=en",
    ],
    features: [
      {
        feature: "ads.organic_post.boost",
        effect: "financial",
        credentialKind: "TikTok for Business access token broker reference",
        requiredScopes: [],
        requiredAccountChecks: [
          "advertiser account campaign-management permission",
          "source organic post identity and Spark authorization",
          "current account, geography, objective, event, and policy eligibility",
          "separate exact Spend Grant and held reservation",
        ],
        distinctReview: "paid.spark_contract",
        readBackRequired: true,
      },
      {
        feature: "ads.campaign.pause",
        effect: "reversible_external_write",
        credentialKind: "TikTok for Business access token broker reference",
        requiredScopes: [],
        requiredAccountChecks: [
          "advertiser account campaign-management permission",
          "campaign identity belongs to the authorized advertiser",
          "pause reason is backed by a durable incident or kill-switch record",
        ],
        distinctReview: null,
        readBackRequired: true,
      },
    ],
    limitations: [
      "Current API-for-Business permissions and account eligibility must be discovered at execution time.",
      "The contract can create only a bounded paid test; automatic scaling is structurally forbidden.",
      "A local halt is not a provider pause; pause completion requires provider read-back.",
    ],
  }),
  aggregated_attribution: descriptor({
    id: "aggregated_attribution",
    displayName: "Aggregated attribution provider contract",
    category: "attribution",
    documentation: [],
    features: [
      {
        feature: "attribution.campaign.read",
        effect: "external_read",
        credentialKind:
          "attribution provider read-only API credential or delegated OAuth reference",
        requiredScopes: ["attribution.campaign.read"],
        requiredAccountChecks: [
          "aggregate-report access",
          "mapping version and data freshness",
          "privacy threshold and attribution classification",
        ],
        distinctReview: null,
        readBackRequired: true,
      },
    ],
    limitations: [
      "A concrete MMP or privacy-preserving attribution source must supply an official transport.",
      "Aggregate, correlated, or modeled evidence is never promoted to deterministic attribution.",
    ],
  }),
  revenuecat: descriptor({
    id: "revenuecat",
    displayName: "RevenueCat REST API v2 lifecycle evidence",
    category: "subscription_lifecycle",
    documentation: [
      "https://www.revenuecat.com/docs/api-v2",
      "https://www.revenuecat.com/docs/projects/authentication",
      "https://www.revenuecat.com/docs/integrations/webhooks",
      "https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields",
    ],
    features: [
      {
        feature: "subscription.lifecycle.read",
        effect: "external_read",
        credentialKind: "RevenueCat v2 secret API key or OAuth access-token broker reference",
        requiredScopes: ["charts_metrics:overview:read"],
        requiredAccountChecks: [
          "project identity and environment separation",
          "read-only API v2 permission",
          "webhook authorization and HMAC verification configured on ingestion path",
        ],
        distinctReview: null,
        readBackRequired: true,
      },
    ],
    limitations: [
      "RevenueCat is lifecycle and revenue evidence, not a campaign attribution engine.",
      "Live project access, webhook delivery, and provider state remain unverified until read back.",
    ],
  }),
});

function declarationFor(
  descriptorValue: WinnerLiveProviderDescriptor,
  feature: WinnerLiveProviderFeature,
): WinnerLiveProviderFeatureDeclaration {
  const declaration = descriptorValue.features.find((candidate) => candidate.feature === feature);
  if (!declaration) {
    throw new WinnerLiveProviderContractError(
      "unsupported_feature",
      `${descriptorValue.id} does not support ${feature}`,
    );
  }
  return declaration;
}

function payloadSchemaFor(
  adapterId: WinnerLiveProviderId,
  feature: WinnerLiveProviderFeature,
): PayloadSchema {
  switch (adapterId) {
    case "creative_generation":
      if (feature === "creative.video.generate") return creativePayloadSchema as PayloadSchema;
      break;
    case "tiktok_content_posting":
      if (feature === "distribution.content.draft")
        return tiktokDraftPayloadSchema as PayloadSchema;
      if (feature === "distribution.content.publish") {
        return tiktokDirectPayloadSchema as PayloadSchema;
      }
      break;
    case "tiktok_spark_ads":
      if (feature === "ads.organic_post.boost") return sparkPayloadSchema as PayloadSchema;
      if (feature === "ads.campaign.pause") return sparkPausePayloadSchema as PayloadSchema;
      break;
    case "aggregated_attribution":
      if (feature === "attribution.campaign.read") {
        return attributionPayloadSchema as PayloadSchema;
      }
      break;
    case "revenuecat":
      if (feature === "subscription.lifecycle.read") {
        return revenueCatPayloadSchema as PayloadSchema;
      }
      break;
  }
  throw new WinnerLiveProviderContractError(
    "unsupported_feature",
    `${adapterId} does not support ${feature}`,
  );
}

function normalizeDiagnostic(
  fallback: Pick<
    WinnerLiveProviderDiagnostic,
    "code" | "category" | "retryable" | "message" | "nextAction"
  >,
  input?: Partial<WinnerLiveProviderDiagnostic> | null,
): WinnerLiveProviderDiagnostic {
  const providerCode =
    typeof input?.providerCode === "string" && /^[a-zA-Z0-9._:-]{1,100}$/u.test(input.providerCode)
      ? input.providerCode
      : null;
  return Object.freeze({
    code: input?.code ?? fallback.code,
    category: input?.category ?? fallback.category,
    retryable: input?.retryable ?? fallback.retryable,
    message: String(redactValue(input?.message ?? fallback.message)),
    nextAction: String(redactValue(input?.nextAction ?? fallback.nextAction)),
    providerCode,
  });
}

function transportErrorDiagnostic(error: unknown): WinnerLiveProviderDiagnostic {
  if (error instanceof WinnerLiveTransportError) {
    const lower = `${error.providerCode} ${error.message}`.toLowerCase();
    const rateLimited = /rate|429/u.test(lower);
    return normalizeDiagnostic(
      {
        code:
          error.writeDisposition === "confirmed_no_effect"
            ? rateLimited
              ? "rate_limited"
              : "provider_rejected"
            : "outcome_ambiguous",
        category: "provider",
        retryable: error.retryable,
        message: error.message,
        nextAction:
          error.writeDisposition === "confirmed_no_effect"
            ? "Correct the provider condition before creating a deliberate new attempt"
            : "Reconcile provider state by request hash before any retry",
      },
      { providerCode: error.providerCode },
    );
  }
  return normalizeDiagnostic({
    code: "outcome_ambiguous",
    category: "provider",
    retryable: false,
    message: error instanceof Error ? error.message : "Provider transport failed ambiguously",
    nextAction: "Reconcile provider state by request hash before any retry",
  });
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function localGates(
  descriptorValue: WinnerLiveProviderDescriptor,
  planOrRequest: {
    organizationId: string;
    ventureId: string;
    providerAccountId: string;
    feature: WinnerLiveProviderFeature;
    requestHash?: string;
    operationId?: string;
    payload?: WinnerLiveJsonObject;
  },
  context: WinnerLiveProviderContext,
  requireExecution: boolean,
  organicPolicyManagesReview = false,
): readonly WinnerLiveProviderDiagnostic[] {
  const diagnostics: WinnerLiveProviderDiagnostic[] = [];
  const now = (context.now ?? (() => new Date()))();
  const declaration = declarationFor(descriptorValue, planOrRequest.feature);
  if (requireExecution && context.executionMode !== "authorized_transport") {
    diagnostics.push(
      normalizeDiagnostic({
        code: "authorization_missing",
        category: "authorization",
        retryable: false,
        message: "Provider execution requires executionMode=authorized_transport",
        nextAction: "Use dryRun or supply an explicitly authorized execution context",
      }),
    );
  }
  if (!context.credentialRef) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "credential_missing",
        category: "authentication",
        retryable: false,
        message: `${descriptorValue.displayName} requires a credential broker reference`,
        nextAction: "Register provider auth and supply its cred:// reference",
      }),
    );
  } else if (!CREDENTIAL_REF.test(context.credentialRef)) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "credential_invalid",
        category: "authentication",
        retryable: false,
        message: "Credential input must be a cred:// reference, never credential material",
        nextAction: "Move the credential to the broker and pass only the reference",
      }),
    );
  }
  const authorization = context.authorization;
  if (!authorization) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "authorization_missing",
        category: "authorization",
        retryable: false,
        message: "A bounded Launch Grant or Customer Service Grant is required",
        nextAction: "Obtain a grant covering this provider, account, capability, and effect",
      }),
    );
  } else {
    const invalid =
      !authorization.sourceGrantId.trim() ||
      !planOrRequest.organizationId.trim() ||
      context.organizationId !== planOrRequest.organizationId ||
      authorization.organizationId !== planOrRequest.organizationId ||
      authorization.ventureId !== planOrRequest.ventureId ||
      authorization.providerId !== descriptorValue.id ||
      !authorization.externalAccountIds.includes(planOrRequest.providerAccountId) ||
      !authorization.allowedFeatures.includes(planOrRequest.feature) ||
      !authorization.allowedEffects.includes(declaration.effect) ||
      !authorization.approvedBy.trim() ||
      !authorization.approvalRef.trim() ||
      !validDate(authorization.issuedAt) ||
      !validDate(authorization.expiresAt) ||
      now < new Date(authorization.issuedAt) ||
      now >= new Date(authorization.expiresAt) ||
      !Number.isSafeInteger(authorization.maxExternalCostMinor) ||
      authorization.maxExternalCostMinor < 0 ||
      !CURRENCY.test(authorization.currency);
    if (invalid) {
      diagnostics.push(
        normalizeDiagnostic({
          code: "authorization_invalid",
          category: "authorization",
          retryable: false,
          message: "The grant does not cover the current provider operation or is inactive",
          nextAction: "Issue a current grant with the exact provider, account, feature, and effect",
        }),
      );
    }
  }
  if (planOrRequest.payload && descriptorValue.id === "creative_generation" && authorization) {
    const payload = planOrRequest.payload as z.infer<typeof creativePayloadSchema>;
    if (
      payload.max_cost_minor > authorization.maxExternalCostMinor ||
      payload.currency !== authorization.currency
    ) {
      diagnostics.push(
        normalizeDiagnostic({
          code: "authorization_invalid",
          category: "authorization",
          retryable: false,
          message: "Creative generation cost exceeds or differs from the authorized envelope",
          nextAction: "Reduce the generation cap or obtain a matching cost authorization",
        }),
      );
    }
  }
  if (
    declaration.distinctReview &&
    planOrRequest.requestHash &&
    planOrRequest.operationId &&
    !organicPolicyManagesReview
  ) {
    const approval = context.reviewApproval;
    if (!approval) {
      diagnostics.push(
        normalizeDiagnostic({
          code: "review_missing",
          category: "authorization",
          retryable: false,
          message: `${declaration.distinctReview} review is required`,
          nextAction: "Record explicit human approval bound to this request hash",
        }),
      );
    } else if (
      approval.kind !== declaration.distinctReview ||
      approval.requestHash !== planOrRequest.requestHash ||
      approval.operationId !== planOrRequest.operationId ||
      !approval.approvedBy.trim() ||
      !approval.approvalRef.trim() ||
      !validDate(approval.approvedAt) ||
      !validDate(approval.expiresAt) ||
      now < new Date(approval.approvedAt) ||
      now >= new Date(approval.expiresAt)
    ) {
      diagnostics.push(
        normalizeDiagnostic({
          code: "review_invalid",
          category: "authorization",
          retryable: false,
          message: "Human review is expired, mismatched, or not bound to this operation",
          nextAction: "Approve the exact immutable request again",
        }),
      );
    }
  }
  if (
    descriptorValue.id === "tiktok_spark_ads" &&
    planOrRequest.feature === "ads.organic_post.boost" &&
    planOrRequest.payload
  ) {
    if (!context.spendAuthorityRefs?.grantId) {
      diagnostics.push(
        normalizeDiagnostic({
          code: "spend_grant_missing",
          category: "authorization",
          retryable: false,
          message: "A Launch Grant or service authorization does not authorize ad spend",
          nextAction: "Approve the exact PaidTestProposal and mint a separate Spend Grant",
        }),
      );
    }
    if (!context.spendAuthorityRefs?.reservationId) {
      diagnostics.push(
        normalizeDiagnostic({
          code: "reservation_missing",
          category: "authorization",
          retryable: false,
          message: "Paid provider mutation requires a held spend reservation",
          nextAction: "Atomically reserve the approved amount before provider execution",
        }),
      );
    }
  }
  return Object.freeze(diagnostics);
}

async function authoritativePaidGates(
  plan: WinnerLiveProviderPlan,
  context: WinnerLiveProviderContext,
  store: WinnerLivePaidAuthorizationStore | undefined,
): Promise<readonly WinnerLiveProviderDiagnostic[]> {
  if (plan.adapterId !== "tiktok_spark_ads" || plan.feature !== "ads.organic_post.boost") {
    return Object.freeze([]);
  }
  if (!store?.authoritative) {
    return Object.freeze([
      normalizeDiagnostic({
        code: "spend_authority_store_missing",
        category: "configuration",
        retryable: false,
        message: "Paid execution requires an injected authoritative spend store",
        nextAction: "Bind the adapter to the transactional Winner Loop spend ledger",
      }),
    ]);
  }
  const refs = context.spendAuthorityRefs;
  if (!refs?.grantId || !refs.reservationId) return Object.freeze([]);
  let grant: SpendGrant | undefined;
  let reservation: Reservation | undefined;
  const scope: SpendScope = {
    organizationId: plan.organizationId,
    ventureId: plan.ventureId,
  };
  try {
    [grant, reservation] = await Promise.all([
      store.getGrant(scope, refs.grantId),
      store.getReservation(scope, refs.reservationId),
    ]);
  } catch (error) {
    return Object.freeze([
      normalizeDiagnostic({
        code: "response_invalid",
        category: "authorization",
        retryable: false,
        message: error instanceof Error ? error.message : "Authoritative spend lookup failed",
        nextAction: "Restore the transactional spend store before any paid provider mutation",
      }),
    ]);
  }
  const diagnostics: WinnerLiveProviderDiagnostic[] = [];
  if (!grant) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "spend_grant_missing",
        category: "authorization",
        retryable: false,
        message: "The referenced Spend Grant does not exist in the authoritative store",
        nextAction: "Use the grant minted from the exact approved PaidTestProposal",
      }),
    );
    return Object.freeze(diagnostics);
  }
  let hashVerified = false;
  let halted = true;
  try {
    [hashVerified, halted] = await Promise.all([
      store.verifyGrantHash(scope, grant),
      store.isGrantHalted(scope, grant.grantId),
    ]);
  } catch (error) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "response_invalid",
        category: "authorization",
        retryable: false,
        message:
          error instanceof Error ? error.message : "Spend integrity verification failed closed",
        nextAction: "Restore grant integrity and halt-state verification before paid execution",
      }),
    );
    return Object.freeze(diagnostics);
  }
  if (!hashVerified) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "grant_hash_invalid",
        category: "authorization",
        retryable: false,
        message: "The stored Spend Grant failed immutable hash verification",
        nextAction: "Freeze paid execution and investigate the corrupted grant record",
      }),
    );
  }
  if (halted) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "spend_halted",
        category: "authorization",
        retryable: false,
        message: "The authoritative spend controller has halted this grant",
        nextAction: "Do not create or resume paid activity; resolve the recorded incident",
      }),
    );
  }
  const payload = plan.payload as z.infer<typeof sparkPayloadSchema>;
  const at = (context.now ?? (() => new Date()))();
  if (
    grant.organizationId !== plan.organizationId ||
    grant.ventureId !== plan.ventureId ||
    grant.network !== "tiktok_paid" ||
    grant.externalAccountId !== payload.advertiser_id ||
    grant.currency !== payload.currency ||
    grant.proposalId !== payload.proposal_id ||
    !grant.allowedCreativeIds.includes(payload.creative_id) ||
    grant.totalMinorUnits < payload.total_budget_minor ||
    grant.perCreativeMinorUnits < payload.total_budget_minor ||
    grant.perPaidTestMinorUnits < payload.total_budget_minor ||
    grant.perCampaignMinorUnits < payload.total_budget_minor ||
    grant.dailyAccountMinorUnits < payload.daily_cap_minor ||
    at < new Date(grant.notBefore) ||
    at >= new Date(grant.expiresAt) ||
    !grant.approvedBy.trim() ||
    !grant.approvalRef.trim()
  ) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "spend_grant_invalid",
        category: "authorization",
        retryable: false,
        message: "The authoritative Spend Grant does not cover the exact paid test terms",
        nextAction: "Use the unmodified grant minted from the approved PaidTestProposal",
      }),
    );
  }
  if (!reservation) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "reservation_missing",
        category: "authorization",
        retryable: false,
        message: "The referenced spend reservation does not exist in the authoritative store",
        nextAction: "Atomically reserve the exact approved amount before provider execution",
      }),
    );
  } else if (
    reservation.organizationId !== plan.organizationId ||
    reservation.grantId !== grant.grantId ||
    reservation.ventureId !== plan.ventureId ||
    reservation.creativeId !== payload.creative_id ||
    reservation.externalAccountId !== payload.advertiser_id ||
    reservation.campaignId !== payload.campaign_key ||
    reservation.heldMinorUnits !== payload.reserved_minor ||
    reservation.status !== "held"
  ) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "reservation_invalid",
        category: "authorization",
        retryable: false,
        message: "The authoritative reservation is stale, released, or scope-mismatched",
        nextAction:
          "Use the active held reservation for this grant, creative, account, and campaign",
      }),
    );
  }
  return Object.freeze(diagnostics);
}

function reconciliationGates(
  descriptorValue: WinnerLiveProviderDescriptor,
  plan: WinnerLiveProviderPlan,
  context: WinnerLiveProviderContext,
): readonly WinnerLiveProviderDiagnostic[] {
  const diagnostics: WinnerLiveProviderDiagnostic[] = [];
  if (context.executionMode !== "authorized_transport") {
    diagnostics.push(
      normalizeDiagnostic({
        code: "authorization_missing",
        category: "authorization",
        retryable: false,
        message: "Provider read-back requires executionMode=authorized_transport",
        nextAction: "Supply a bounded provider-read execution context",
      }),
    );
  }
  if (!context.credentialRef) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "credential_missing",
        category: "authentication",
        retryable: false,
        message: `${descriptorValue.displayName} read-back requires a credential reference`,
        nextAction: "Supply the active provider connection cred:// reference",
      }),
    );
  } else if (!CREDENTIAL_REF.test(context.credentialRef)) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "credential_invalid",
        category: "authentication",
        retryable: false,
        message: "Credential input must be a cred:// reference",
        nextAction: "Pass only the credential broker reference",
      }),
    );
  }
  const authorization = context.reconciliationAuthorization ?? context.authorization;
  const now = (context.now ?? (() => new Date()))();
  const effectAllowed =
    authorization?.allowedEffects.includes("external_read") ||
    (authorization === context.authorization &&
      authorization?.allowedEffects.includes(plan.effect));
  if (!authorization) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "authorization_missing",
        category: "authorization",
        retryable: false,
        message: "A current provider-read authorization is required for reconciliation",
        nextAction: "Issue an external-read grant for the affected provider account",
      }),
    );
  } else if (
    !authorization.sourceGrantId.trim() ||
    !plan.organizationId.trim() ||
    context.organizationId !== plan.organizationId ||
    authorization.organizationId !== plan.organizationId ||
    authorization.ventureId !== plan.ventureId ||
    authorization.providerId !== plan.adapterId ||
    !authorization.externalAccountIds.includes(plan.providerAccountId) ||
    !authorization.allowedFeatures.includes(plan.feature) ||
    !effectAllowed ||
    !validDate(authorization.issuedAt) ||
    !validDate(authorization.expiresAt) ||
    now < new Date(authorization.issuedAt) ||
    now >= new Date(authorization.expiresAt)
  ) {
    diagnostics.push(
      normalizeDiagnostic({
        code: "authorization_invalid",
        category: "authorization",
        retryable: false,
        message: "The provider-read grant is inactive or scope-mismatched",
        nextAction: "Issue a current external-read grant for this provider, account, and feature",
      }),
    );
  }
  return Object.freeze(diagnostics);
}

function expectedHash(plan: WinnerLiveProviderPlan): string {
  return hashRequest({
    adapter_id: plan.adapterId,
    organization_id: plan.organizationId,
    venture_id: plan.ventureId,
    provider_account_id: plan.providerAccountId,
    operation_id: plan.operationId,
    feature: plan.feature,
    effect: plan.effect,
    payload: plan.payload,
    schema_version: plan.schemaVersion,
  });
}

function assertPlanFor(
  descriptorValue: WinnerLiveProviderDescriptor,
  plan: WinnerLiveProviderPlan,
): void {
  if (
    plan.adapterId !== descriptorValue.id ||
    plan.externalExecutionAllowedByPlan !== false ||
    plan.schemaVersion !== 1 ||
    plan.liveVerification !== "pending"
  ) {
    throw new WinnerLiveProviderContractError(
      "plan_adapter_mismatch",
      `Plan for ${plan.adapterId} cannot execute through ${descriptorValue.id}`,
    );
  }
  const declaration = declarationFor(descriptorValue, plan.feature);
  if (plan.effect !== declaration.effect || plan.requestHash !== expectedHash(plan)) {
    throw new WinnerLiveProviderContractError(
      "plan_adapter_mismatch",
      "Plan effect or request hash does not match its immutable operation content",
    );
  }
  const parsed = payloadSchemaFor(descriptorValue.id, plan.feature).safeParse(plan.payload);
  if (!parsed.success) {
    throw new WinnerLiveProviderContractError(
      "plan_adapter_mismatch",
      "Plan payload no longer matches its operation schema",
    );
  }
}

function evidenceInvariant(plan: WinnerLiveProviderPlan, evidence: WinnerLiveJsonObject): boolean {
  switch (plan.adapterId) {
    case "creative_generation":
      return (
        evidence.creative_id === plan.payload.creative_id &&
        typeof evidence.asset_ref === "string" &&
        ["PROCESSING", "COMPLETED"].includes(String(evidence.status))
      );
    case "tiktok_content_posting":
      return (
        evidence.creative_id === plan.payload.creative_id &&
        typeof evidence.publish_id === "string" &&
        (plan.feature === "distribution.content.publish"
          ? evidence.status === "PUBLISH_COMPLETE" && typeof evidence.post_id === "string"
          : ["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"].includes(String(evidence.status)))
      );
    case "tiktok_spark_ads":
      if (plan.feature === "ads.campaign.pause") {
        return (
          evidence.campaign_id === plan.payload.campaign_id &&
          evidence.pause_applied === true &&
          ["PAUSED", "DISABLED"].includes(String(evidence.status))
        );
      }
      return (
        evidence.creative_id === plan.payload.creative_id &&
        evidence.source_post_id === plan.payload.source_post_id &&
        evidence.auto_scale === false &&
        evidence.configured_budget_minor === plan.payload.total_budget_minor &&
        typeof evidence.spend_minor === "number" &&
        Number.isSafeInteger(evidence.spend_minor) &&
        evidence.spend_minor >= 0
      );
    case "aggregated_attribution":
      return (
        evidence.aggregate_only === true &&
        evidence.person_level_rows === 0 &&
        typeof evidence.attribution_class === "string" &&
        attributionClass.safeParse(evidence.attribution_class).success &&
        evidence.attribution_class !== "DETERMINISTIC"
      );
    case "revenuecat":
      return (
        evidence.project_id === plan.payload.project_id &&
        evidence.environment === plan.payload.environment &&
        evidence.attribution_engine === false &&
        evidence.subscriber_payload_persisted === false
      );
  }
}

interface PaidSpendReadBackDisposition {
  readonly acceptedAsInBudget: boolean;
  readonly preserveEvidence: boolean;
  readonly diagnostic: WinnerLiveProviderDiagnostic | null;
}

async function recordPaidSpendReadBack(
  plan: WinnerLiveProviderPlan,
  paidSpendBinding: WinnerLiveProviderStoredOperation["paidSpendBinding"],
  store: WinnerLivePaidAuthorizationStore | undefined,
  evidence: WinnerLiveJsonObject,
): Promise<PaidSpendReadBackDisposition> {
  if (plan.adapterId !== "tiktok_spark_ads" || plan.feature !== "ads.organic_post.boost") {
    return Object.freeze({ acceptedAsInBudget: true, preserveEvidence: false, diagnostic: null });
  }
  const actualSpendMinor = evidence.spend_minor;
  const totalBudgetMinor = plan.payload.total_budget_minor;
  if (
    typeof actualSpendMinor !== "number" ||
    !Number.isSafeInteger(actualSpendMinor) ||
    actualSpendMinor < 0 ||
    typeof totalBudgetMinor !== "number" ||
    !Number.isSafeInteger(totalBudgetMinor)
  ) {
    return Object.freeze({
      acceptedAsInBudget: false,
      preserveEvidence: false,
      diagnostic: normalizeDiagnostic({
        code: "verification_mismatch",
        category: "verification",
        retryable: false,
        message: "Provider spend evidence is not a valid integer-minor amount",
        nextAction: "Inspect provider billing state and reconcile the exact charged amount",
      }),
    });
  }
  const overspend = actualSpendMinor > totalBudgetMinor;
  const refs = paidSpendBinding;
  if (!store?.authoritative || !refs?.grantId || !refs.reservationId) {
    return Object.freeze({
      acceptedAsInBudget: false,
      preserveEvidence: overspend,
      diagnostic: normalizeDiagnostic({
        code: overspend ? "provider_overspend" : "spend_authority_store_missing",
        category: "verification",
        retryable: false,
        message: overspend
          ? "Provider reported spend above the approved cap, but the transactional spend ledger is unavailable"
          : "Provider spend cannot be verified without its authoritative reservation ledger",
        nextAction: overspend
          ? "Restore the spend ledger, record the real charge, keep spend halted, and reconcile provider pause"
          : "Restore the spend ledger and reconcile this reservation before reporting completion",
      }),
    });
  }
  const scope: SpendScope = {
    organizationId: plan.organizationId,
    ventureId: plan.ventureId,
  };
  try {
    const recorded = await store.recordProviderSpend(scope, refs.reservationId, actualSpendMinor);
    const reservation = recorded.reservation;
    const bindingValid =
      reservation.organizationId === scope.organizationId &&
      reservation.ventureId === scope.ventureId &&
      reservation.reservationId === refs.reservationId &&
      reservation.grantId === refs.grantId &&
      reservation.status === "settled" &&
      reservation.settledMinorUnits === actualSpendMinor;
    const safetyStateValid = overspend
      ? recorded.overspendRecorded && recorded.grantHalted && recorded.providerPauseQueued
      : !recorded.overspendRecorded;
    if (!bindingValid || !safetyStateValid) {
      return Object.freeze({
        acceptedAsInBudget: false,
        preserveEvidence: overspend,
        diagnostic: normalizeDiagnostic({
          code: overspend ? "provider_overspend" : "response_invalid",
          category: "verification",
          retryable: false,
          message: overspend
            ? "Provider overspend was observed, but the required incident, halt, and pause obligation were not durably confirmed"
            : "The spend ledger did not confirm the exact provider-observed settlement",
          nextAction: overspend
            ? "Keep spend halted and reconcile the incident and provider pause from durable state"
            : "Reconcile the reservation and provider billing record before reporting completion",
        }),
      });
    }
    if (overspend) {
      return Object.freeze({
        acceptedAsInBudget: false,
        preserveEvidence: true,
        diagnostic: normalizeDiagnostic({
          code: "provider_overspend",
          category: "verification",
          retryable: false,
          message:
            "Provider spend exceeded the approved cap and was durably recorded with the grant halted",
          nextAction: "Reconcile the queued provider pause and review the overspend incident",
        }),
      });
    }
    return Object.freeze({ acceptedAsInBudget: true, preserveEvidence: false, diagnostic: null });
  } catch {
    return Object.freeze({
      acceptedAsInBudget: false,
      preserveEvidence: overspend,
      diagnostic: normalizeDiagnostic({
        code: overspend ? "provider_overspend" : "response_invalid",
        category: "verification",
        retryable: false,
        message: overspend
          ? "Provider spend exceeded the approved cap, but durable ledger reconciliation could not be confirmed"
          : "Provider spend could not be durably reconciled with its reservation",
        nextAction: overspend
          ? "Keep spend halted and retry read-only ledger/provider reconciliation"
          : "Restore the transactional spend ledger and reconcile before reporting completion",
      }),
    });
  }
}

export interface WinnerLiveProviderAdapter {
  readonly descriptor: WinnerLiveProviderDescriptor;
  readonly transportKind: WinnerLiveProviderTransport["kind"] | null;
  doctor(
    request: WinnerLiveProviderDoctorRequest,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderDoctorResult>;
  plan(request: WinnerLiveProviderPlanRequest): WinnerLiveProviderPlan;
  dryRun(plan: WinnerLiveProviderPlan): Promise<WinnerLiveProviderExecutionResult>;
  apply(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderExecutionResult>;
  readBack(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderReadBackResult>;
  verify(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderVerificationResult>;
  reconcile(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderReconciliationResult>;
  redact(value: unknown): unknown;
}

class InjectedWinnerLiveProviderAdapter implements WinnerLiveProviderAdapter {
  constructor(
    readonly descriptor: WinnerLiveProviderDescriptor,
    private readonly transport: WinnerLiveProviderTransport | undefined,
    private readonly store: WinnerLiveProviderOperationStore | undefined,
    private readonly paidAuthorizationStore: WinnerLivePaidAuthorizationStore | undefined,
    private readonly organicPolicyService: OrganicPolicyService | undefined,
  ) {}

  get transportKind(): WinnerLiveProviderTransport["kind"] | null {
    return this.transport?.kind ?? null;
  }

  plan(request: WinnerLiveProviderPlanRequest): WinnerLiveProviderPlan {
    if (
      !request.organizationId.trim() ||
      !request.ventureId.trim() ||
      !request.providerAccountId.trim() ||
      !request.operationId.trim() ||
      !request.idempotencyKey.trim()
    ) {
      throw new WinnerLiveProviderContractError(
        "invalid_request",
        "organizationId, ventureId, providerAccountId, operationId, and idempotencyKey are required",
      );
    }
    assertSafeJson(request.payload);
    const declaration = declarationFor(this.descriptor, request.feature);
    const parsed = payloadSchemaFor(this.descriptor.id, request.feature).safeParse(request.payload);
    if (!parsed.success) {
      throw new WinnerLiveProviderContractError(
        "invalid_request",
        `Invalid ${request.feature} payload: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const payload = Object.freeze({ ...(parsed.data as WinnerLiveJsonObject) });
    const partial = {
      adapterId: this.descriptor.id,
      organizationId: request.organizationId,
      ventureId: request.ventureId,
      providerAccountId: request.providerAccountId,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      feature: request.feature,
      effect: declaration.effect,
      payload,
      schemaVersion: 1 as const,
    };
    const requestHash = hashRequest({
      adapter_id: partial.adapterId,
      organization_id: partial.organizationId,
      venture_id: partial.ventureId,
      provider_account_id: partial.providerAccountId,
      operation_id: partial.operationId,
      feature: partial.feature,
      effect: partial.effect,
      payload,
      schema_version: partial.schemaVersion,
    });
    return Object.freeze({
      ...partial,
      requestHash,
      externalExecutionAllowedByPlan: false,
      liveVerification: "pending",
    });
  }

  async doctor(
    request: WinnerLiveProviderDoctorRequest,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderDoctorResult> {
    const checkedAt = (context.now ?? (() => new Date()))().toISOString();
    const requestedFeatures = Object.freeze([
      ...(request.features ?? this.descriptor.features.map(({ feature }) => feature)),
    ]);
    for (const feature of requestedFeatures) declarationFor(this.descriptor, feature);
    const local = requestedFeatures.flatMap((feature) =>
      localGates(
        this.descriptor,
        {
          organizationId: request.organizationId,
          ventureId: request.ventureId,
          providerAccountId: request.providerAccountId,
          feature,
        },
        context,
        true,
      ),
    );
    if (!this.transport) {
      const diagnostics = Object.freeze([
        ...local,
        normalizeDiagnostic({
          code: "transport_missing",
          category: "configuration",
          retryable: false,
          message: `${this.descriptor.displayName} has no injected official transport`,
          nextAction: "Install and configure an official API or SDK transport",
        }),
      ]);
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: request.organizationId,
        status: "transport_missing",
        providerInvoked: false,
        liveVerified: false,
        providerAccountId: request.providerAccountId,
        requestedFeatures,
        availableFeatures: Object.freeze([]),
        grantedScopes: Object.freeze([]),
        diagnostics,
        checkedAt,
      });
    }
    if (this.transport.adapterId !== this.descriptor.id) {
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: request.organizationId,
        status: "unavailable",
        providerInvoked: false,
        liveVerified: false,
        providerAccountId: request.providerAccountId,
        requestedFeatures,
        availableFeatures: Object.freeze([]),
        grantedScopes: Object.freeze([]),
        diagnostics: Object.freeze([
          normalizeDiagnostic({
            code: "transport_mismatch",
            category: "configuration",
            retryable: false,
            message: `Transport for ${this.transport.adapterId} cannot serve ${this.descriptor.id}`,
            nextAction: "Inject the transport under its matching provider contract",
          }),
        ]),
        checkedAt,
      });
    }
    if (context.environment === "production" && this.transport.kind === "contract_fixture") {
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: request.organizationId,
        status: "unavailable",
        providerInvoked: false,
        liveVerified: false,
        providerAccountId: request.providerAccountId,
        requestedFeatures,
        availableFeatures: Object.freeze([]),
        grantedScopes: Object.freeze([]),
        diagnostics: Object.freeze([
          normalizeDiagnostic({
            code: "transport_mismatch",
            category: "configuration",
            retryable: false,
            message: "A contract-fixture transport cannot run in a production environment",
            nextAction: "Inject the configured official API or SDK transport",
          }),
        ]),
        checkedAt,
      });
    }
    if (local.length > 0 || !context.credentialRef) {
      const authMissing = local.some((item) =>
        ["credential_missing", "credential_invalid"].includes(item.code),
      );
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: request.organizationId,
        status: authMissing ? "auth_required" : "authorization_required",
        providerInvoked: false,
        liveVerified: false,
        providerAccountId: request.providerAccountId,
        requestedFeatures,
        availableFeatures: Object.freeze([]),
        grantedScopes: Object.freeze([]),
        diagnostics: Object.freeze([...local]),
        checkedAt,
      });
    }
    const requiredScopes = Object.freeze([
      ...new Set(
        requestedFeatures.flatMap(
          (feature) => declarationFor(this.descriptor, feature).requiredScopes,
        ),
      ),
    ]);
    try {
      const result = await this.transport.doctor({
        adapterId: this.descriptor.id,
        organizationId: request.organizationId,
        providerAccountId: request.providerAccountId,
        credentialRef: context.credentialRef,
        requestedFeatures,
        requiredScopes,
      });
      const missingScopes = requiredScopes.filter((scope) => !result.grantedScopes.includes(scope));
      const missingFeatures = requestedFeatures.filter(
        (feature) => !result.availableFeatures.includes(feature),
      );
      const diagnostics: WinnerLiveProviderDiagnostic[] = [];
      if (result.observedAccountId !== request.providerAccountId) {
        diagnostics.push(
          normalizeDiagnostic({
            code: "authorization_invalid",
            category: "authorization",
            retryable: false,
            message: "Provider read-back returned a different external account",
            nextAction: "Select or authorize the intended account before execution",
          }),
        );
      }
      if (missingScopes.length > 0) {
        diagnostics.push(
          normalizeDiagnostic({
            code: "scope_missing",
            category: "authentication",
            retryable: false,
            message: `Credential lacks required scopes: ${missingScopes.join(", ")}`,
            nextAction: "Reauthorize the provider connection with only the required scopes",
          }),
        );
      }
      if (missingFeatures.length > 0) {
        diagnostics.push(
          normalizeDiagnostic({
            code: "feature_unavailable",
            category: "provider",
            retryable: false,
            message: `Provider account has not verified: ${missingFeatures.join(", ")}`,
            nextAction: "Resolve provider eligibility or select an available adapter",
          }),
        );
      }
      if (result.diagnostic) {
        diagnostics.push(
          normalizeDiagnostic(
            {
              code: "provider_unavailable",
              category: "provider",
              retryable: false,
              message: "Provider doctor returned a diagnostic",
              nextAction: "Follow the normalized provider remediation",
            },
            result.diagnostic,
          ),
        );
      }
      const status: WinnerLiveProviderDoctorResult["status"] =
        result.state === "unavailable"
          ? "unavailable"
          : diagnostics.length > 0 || result.state === "degraded"
            ? "degraded"
            : "ready";
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: request.organizationId,
        status,
        providerInvoked: result.providerInvoked,
        liveVerified: result.liveVerified && this.transport.kind !== "contract_fixture",
        providerAccountId: request.providerAccountId,
        requestedFeatures,
        availableFeatures: Object.freeze([...result.availableFeatures]),
        grantedScopes: Object.freeze([...result.grantedScopes]),
        diagnostics: Object.freeze(diagnostics),
        checkedAt,
      });
    } catch (error) {
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: request.organizationId,
        status: "unavailable",
        providerInvoked: true,
        liveVerified: false,
        providerAccountId: request.providerAccountId,
        requestedFeatures,
        availableFeatures: Object.freeze([]),
        grantedScopes: Object.freeze([]),
        diagnostics: Object.freeze([transportErrorDiagnostic(error)]),
        checkedAt,
      });
    }
  }

  async dryRun(plan: WinnerLiveProviderPlan): Promise<WinnerLiveProviderExecutionResult> {
    assertPlanFor(this.descriptor, plan);
    return Object.freeze({
      adapterId: this.descriptor.id,
      organizationId: plan.organizationId,
      operationId: plan.operationId,
      requestHash: plan.requestHash,
      state: "planned",
      reused: false,
      providerInvoked: false,
      externalEffectOccurred: false,
      liveVerified: false,
      providerOperationId: null,
      output: Object.freeze({
        dry_run: true,
        adapter_id: plan.adapterId,
        feature: plan.feature,
        effect: plan.effect,
        request_hash: plan.requestHash,
        provider_invoked: false,
        live_verification: "pending",
      }),
      diagnostic: null,
    });
  }

  async apply(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderExecutionResult> {
    assertPlanFor(this.descriptor, plan);
    const gates = localGates(
      this.descriptor,
      plan,
      context,
      true,
      this.isOrganicPlan(plan) && this.organicPolicyService !== undefined,
    );
    const paidGates = await authoritativePaidGates(plan, context, this.paidAuthorizationStore);
    const transportDiagnostic = this.transportGate(context);
    const storeDiagnostic = this.operationStoreGate(context);
    const organicServiceDiagnostic = this.organicPolicyServiceGate(plan);
    const firstBlocker =
      gates[0] ??
      paidGates[0] ??
      transportDiagnostic ??
      storeDiagnostic ??
      organicServiceDiagnostic;
    if (firstBlocker || !this.transport || !this.store || !context.credentialRef) {
      return this.execution(plan, "blocked", false, false, false, null, null, firstBlocker!);
    }
    const now = (context.now ?? (() => new Date()))();
    if (this.isOrganicPlan(plan)) {
      const organic = this.organicPolicyService!.authorizeAndReserve(
        this.organicOperation(plan),
        context.organicAuthority,
        now,
      );
      if (organic.kind === "blocked") {
        return this.execution(
          plan,
          organic.failure.code === "idempotency_conflict" ? "conflict" : "blocked",
          false,
          false,
          false,
          null,
          null,
          this.organicDiagnostic(organic.failure),
        );
      }
    }
    const at = now.toISOString();
    const claim: WinnerLiveProviderStoredOperation & { readonly state: "pending" } = Object.freeze({
      adapterId: this.descriptor.id,
      organizationId: plan.organizationId,
      ventureId: plan.ventureId,
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      requestHash: plan.requestHash,
      paidSpendBinding:
        plan.adapterId === "tiktok_spark_ads" &&
        plan.feature === "ads.organic_post.boost" &&
        context.spendAuthorityRefs
          ? Object.freeze({ ...context.spendAuthorityRefs })
          : null,
      state: "pending",
      providerOperationId: null,
      output: null,
      evidence: null,
      updatedAt: at,
    });
    const ownerToken = randomUUID();
    let claimResult: WinnerLiveProviderOperationClaim;
    try {
      claimResult = await this.store.claim(claim, { ownerToken, now: at });
    } catch (error) {
      // Organic policy reserves quota and a dedupe slot before the generic
      // operation claim. A pre-provider claim failure is confirmed no-effect,
      // so release that reservation instead of leaking capacity indefinitely.
      const organicDiagnostic = this.recordOrganicApplyOutcome(
        plan,
        context,
        {
          state: "failed",
          providerOperationId: null,
          externalEffectOccurred: false,
        },
        now,
      );
      return this.execution(
        plan,
        "blocked",
        false,
        false,
        false,
        null,
        null,
        organicDiagnostic ??
          normalizeDiagnostic({
            code: "response_invalid",
            category: "idempotency",
            retryable: false,
            message: error instanceof Error ? error.message : "Atomic operation claim failed",
            nextAction: "Restore the durable idempotency store before provider execution",
          }),
      );
    }
    if (claimResult.kind === "conflict") {
      const organicDiagnostic = this.recordOrganicApplyOutcome(
        plan,
        context,
        {
          state: "conflict",
          providerOperationId: null,
          externalEffectOccurred: false,
        },
        now,
      );
      return this.execution(
        plan,
        "conflict",
        false,
        false,
        false,
        null,
        null,
        organicDiagnostic ??
          normalizeDiagnostic({
            code: "idempotency_conflict",
            category: "idempotency",
            retryable: false,
            message: "Idempotency key is already bound to different immutable input",
            nextAction: "Use the original input or choose a new intentional idempotency key",
          }),
      );
    }
    if (claimResult.kind === "pending" || claimResult.kind === "ambiguous") {
      return this.execution(
        plan,
        "unknown",
        true,
        false,
        false,
        null,
        null,
        normalizeDiagnostic({
          code: "outcome_ambiguous",
          category: "idempotency",
          retryable: false,
          message:
            claimResult.kind === "pending"
              ? "The same provider operation is already owned by another execution"
              : "An earlier provider execution expired without a durable outcome",
          nextAction: "Reconcile the immutable request; never replay apply",
        }),
      );
    }
    if (claimResult.kind === "replay") {
      const current = claimResult.record;
      const state: WinnerLiveProviderExecutionResult["state"] =
        current.state === "accepted_unverified" || current.state === "verified"
          ? "accepted_unverified"
          : current.state === "failed" || current.state === "confirmed_absent"
            ? "failed"
            : current.state === "conflict"
              ? "conflict"
              : "unknown";
      return this.execution(
        plan,
        state,
        true,
        false,
        false,
        current.providerOperationId,
        current.output,
        state === "unknown"
          ? normalizeDiagnostic({
              code: "outcome_ambiguous",
              category: "verification",
              retryable: false,
              message: "Existing operation outcome is unresolved; apply was not replayed",
              nextAction: "Call reconcile before considering any new attempt",
            })
          : null,
      );
    }
    const ownedToken = claimResult.ownerToken;
    let result: WinnerLiveTransportApplyResult;
    try {
      result = await this.transport.apply({ plan, credentialRef: context.credentialRef });
    } catch (error) {
      const diagnostic = transportErrorDiagnostic(error);
      const confirmedNoEffect =
        error instanceof WinnerLiveTransportError &&
        error.writeDisposition === "confirmed_no_effect";
      try {
        if (confirmedNoEffect) {
          await this.store.complete({
            ownerToken: ownedToken,
            record: {
              ...claim,
              state: "failed",
              updatedAt: at,
            },
          });
        } else {
          await this.store.markAmbiguous({
            ownerToken: ownedToken,
            record: {
              ...claim,
              state: "ambiguous",
              updatedAt: at,
            },
          });
        }
      } catch {
        // The pending claim is still a replay barrier and ages into ambiguity.
      }
      const organicDiagnostic = this.recordOrganicApplyOutcome(
        plan,
        context,
        {
          state: confirmedNoEffect ? "failed" : "unknown",
          providerOperationId: null,
          externalEffectOccurred: confirmedNoEffect ? false : "unknown",
        },
        now,
      );
      return this.execution(
        plan,
        confirmedNoEffect ? "failed" : "unknown",
        false,
        true,
        confirmedNoEffect ? false : "unknown",
        null,
        null,
        organicDiagnostic ?? diagnostic,
      );
    }

    let output: WinnerLiveJsonObject | null;
    let providerOperationId: string | null;
    try {
      output = safeJsonObject(result.output ?? null);
      providerOperationId = safeProviderOperationId(result.providerOperationId);
    } catch (error) {
      try {
        await this.store.markAmbiguous({
          ownerToken: ownedToken,
          record: {
            ...claim,
            state: "ambiguous",
            updatedAt: at,
          },
        });
      } catch {
        // The pending claim remains a replay barrier until reconciliation.
      }
      return this.execution(
        plan,
        "unknown",
        false,
        result.providerInvoked,
        "unknown",
        null,
        null,
        normalizeDiagnostic({
          code: "response_invalid",
          category: "provider",
          retryable: false,
          message: error instanceof Error ? error.message : "Provider response was invalid",
          nextAction: "Reconcile the immutable request before any new attempt",
        }),
      );
    }

    try {
      if (result.state === "unknown") {
        await this.store.markAmbiguous({
          ownerToken: ownedToken,
          record: {
            ...claim,
            state: "ambiguous",
            providerOperationId,
            output,
            updatedAt: at,
          },
        });
        const organicDiagnostic = this.recordOrganicApplyOutcome(
          plan,
          context,
          {
            state: "unknown",
            providerOperationId,
            externalEffectOccurred: "unknown",
          },
          now,
        );
        return this.execution(
          plan,
          "unknown",
          false,
          result.providerInvoked,
          "unknown",
          providerOperationId,
          output,
          organicDiagnostic ??
            normalizeDiagnostic(
              {
                code: "outcome_ambiguous",
                category: "verification",
                retryable: false,
                message: "Provider outcome is ambiguous",
                nextAction: "Reconcile provider state by request hash before any retry",
              },
              result.diagnostic,
            ),
        );
      }
      if (result.state === "rejected") {
        await this.store.complete({
          ownerToken: ownedToken,
          record: {
            ...claim,
            state: "failed",
            providerOperationId,
            output,
            updatedAt: at,
          },
        });
        const organicDiagnostic = this.recordOrganicApplyOutcome(
          plan,
          context,
          {
            state: "failed",
            providerOperationId,
            externalEffectOccurred: result.externalEffectOccurred,
          },
          now,
        );
        return this.execution(
          plan,
          "failed",
          false,
          result.providerInvoked,
          result.externalEffectOccurred,
          providerOperationId,
          output,
          organicDiagnostic ??
            normalizeDiagnostic(
              {
                code: "provider_rejected",
                category: "provider",
                retryable: false,
                message: "Provider rejected the operation",
                nextAction: "Correct the provider condition before a deliberate new attempt",
              },
              result.diagnostic,
            ),
        );
      }
      await this.store.complete({
        ownerToken: ownedToken,
        record: {
          ...claim,
          state: "accepted_unverified",
          providerOperationId,
          output,
          updatedAt: at,
        },
      });
      const organicDiagnostic = this.recordOrganicApplyOutcome(
        plan,
        context,
        {
          state: "accepted_unverified",
          providerOperationId,
          externalEffectOccurred: result.externalEffectOccurred,
        },
        now,
      );
      return this.execution(
        plan,
        organicDiagnostic ? "unknown" : "accepted_unverified",
        false,
        result.providerInvoked,
        result.externalEffectOccurred,
        providerOperationId,
        output,
        organicDiagnostic ??
          normalizeDiagnostic({
            code: "verification_pending",
            category: "verification",
            retryable: false,
            message: "Provider accepted the request, but completion is not yet verified",
            nextAction: "Read provider state back and validate the operation invariants",
          }),
      );
    } catch (error) {
      // The provider returned, but its outcome could not be durably committed.
      // Keep the claim as a replay barrier and force read-back reconciliation.
      try {
        await this.store.markAmbiguous({
          ownerToken: ownedToken,
          record: {
            ...claim,
            state: "ambiguous",
            providerOperationId,
            output,
            updatedAt: at,
          },
        });
      } catch {
        // The original pending claim remains a replay barrier and expires ambiguous.
      }
      const organicDiagnostic = this.recordOrganicApplyOutcome(
        plan,
        context,
        {
          state: "unknown",
          providerOperationId,
          externalEffectOccurred: "unknown",
        },
        now,
      );
      return this.execution(
        plan,
        "unknown",
        false,
        result.providerInvoked,
        "unknown",
        providerOperationId,
        output,
        organicDiagnostic ??
          normalizeDiagnostic({
            code: "response_invalid",
            category: "idempotency",
            retryable: false,
            message:
              error instanceof Error
                ? String(redactValue(error.message))
                : "Provider outcome could not be committed",
            nextAction: "Restore the operation store and reconcile before any apply attempt",
          }),
      );
    }
  }

  async readBack(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderReadBackResult> {
    return this.readBackWith("readBack", plan, context);
  }

  async verify(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderVerificationResult> {
    const result = await this.readBack(plan, context);
    return Object.freeze({
      adapterId: this.descriptor.id,
      organizationId: plan.organizationId,
      operationId: plan.operationId,
      state:
        result.state === "matched"
          ? "verified"
          : result.state === "conflict"
            ? "failed"
            : result.state === "blocked"
              ? "blocked"
              : "pending",
      providerInvoked: result.providerInvoked,
      liveVerified: result.state === "matched" && result.liveVerified,
      evidence: result.state === "matched" ? result.evidence : null,
      diagnostic: result.diagnostic,
    });
  }

  async reconcile(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderReconciliationResult> {
    const result = await this.readBackWith("reconcile", plan, context);
    return Object.freeze({
      adapterId: this.descriptor.id,
      organizationId: plan.organizationId,
      operationId: plan.operationId,
      state: result.state,
      providerInvoked: result.providerInvoked,
      reapplied: false,
      liveVerified: result.liveVerified,
      evidence: result.evidence,
      diagnostic: result.diagnostic,
    });
  }

  redact(value: unknown): unknown {
    return redactValue(value);
  }

  private async readBackWith(
    method: "readBack" | "reconcile",
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
  ): Promise<WinnerLiveProviderReadBackResult> {
    assertPlanFor(this.descriptor, plan);
    const gates = reconciliationGates(this.descriptor, plan, context);
    const transportDiagnostic = this.transportGate(context);
    const storeDiagnostic = this.operationStoreGate(context);
    const organicServiceDiagnostic = this.organicPolicyServiceGate(plan);
    const firstBlocker =
      gates[0] ?? transportDiagnostic ?? storeDiagnostic ?? organicServiceDiagnostic;
    if (firstBlocker || !this.transport || !this.store || !context.credentialRef) {
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: plan.organizationId,
        operationId: plan.operationId,
        requestHash: plan.requestHash,
        state: "blocked",
        providerInvoked: false,
        liveVerified: false,
        evidence: null,
        diagnostic: firstBlocker!,
      });
    }
    if (this.isOrganicPlan(plan)) {
      const organic = this.organicPolicyService!.authorizeReconciliation(
        this.organicOperation(plan),
        context.organicAuthority,
      );
      if (organic.kind === "blocked") {
        return Object.freeze({
          adapterId: this.descriptor.id,
          organizationId: plan.organizationId,
          operationId: plan.operationId,
          requestHash: plan.requestHash,
          state: "blocked",
          providerInvoked: false,
          liveVerified: false,
          evidence: null,
          diagnostic: this.organicDiagnostic(organic.failure),
        });
      }
    }
    const current = await this.current(plan);
    if (!current) {
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: plan.organizationId,
        operationId: plan.operationId,
        requestHash: plan.requestHash,
        state: "missing",
        providerInvoked: false,
        liveVerified: false,
        evidence: null,
        diagnostic: normalizeDiagnostic({
          code: "verification_pending",
          category: "verification",
          retryable: false,
          message: "No local operation claim exists for this request",
          nextAction: "Apply the authorized operation before reading it back",
        }),
      });
    }
    if (current.requestHash !== plan.requestHash) {
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: plan.organizationId,
        operationId: plan.operationId,
        requestHash: plan.requestHash,
        state: "conflict",
        providerInvoked: false,
        liveVerified: false,
        evidence: null,
        diagnostic: normalizeDiagnostic({
          code: "idempotency_conflict",
          category: "idempotency",
          retryable: false,
          message: "Stored operation belongs to different immutable input",
          nextAction: "Investigate the conflicting idempotency binding",
        }),
      });
    }
    try {
      const result = await this.transport[method]({ plan, credentialRef: context.credentialRef });
      const evidence = safeJsonObject(result.evidence ?? null);
      let state = result.state;
      let diagnostic = result.diagnostic
        ? normalizeDiagnostic(
            {
              code: "verification_pending",
              category: "verification",
              retryable: false,
              message: "Provider read-back returned a diagnostic",
              nextAction: "Follow the normalized provider remediation",
            },
            result.diagnostic,
          )
        : null;
      let preserveConflictEvidence = false;
      let conflictEvidence = evidence;
      if (state === "matched" && (!evidence || !evidenceInvariant(plan, evidence))) {
        state = "conflict";
        diagnostic = normalizeDiagnostic({
          code: "verification_mismatch",
          category: "verification",
          retryable: false,
          message: "Provider evidence did not satisfy the operation invariants",
          nextAction: "Inspect provider state and do not report the operation as complete",
        });
      } else if (state === "matched" && evidence) {
        const paidSpend = await recordPaidSpendReadBack(
          plan,
          current.paidSpendBinding,
          this.paidAuthorizationStore,
          evidence,
        );
        if (!paidSpend.acceptedAsInBudget) {
          state = "conflict";
          diagnostic = paidSpend.diagnostic;
          preserveConflictEvidence = paidSpend.preserveEvidence;
        }
      }
      if (current.state === "verified" && state !== "matched") {
        state = "conflict";
        diagnostic = normalizeDiagnostic({
          code: "verification_mismatch",
          category: "verification",
          retryable: false,
          message: "Provider state no longer matches the previously verified operation",
          nextAction:
            "Keep the immutable operation key closed and investigate provider deletion or eventual-consistency drift",
        });
        preserveConflictEvidence = current.evidence !== null;
        conflictEvidence = current.evidence;
      }
      const checkedAt = (context.now ?? (() => new Date()))();
      const organicDiagnostic = this.recordOrganicReadBackOutcome(
        method,
        plan,
        context,
        {
          state,
          providerOperationId: safeProviderOperationId(result.providerOperationId),
          evidence,
        },
        checkedAt,
      );
      if (organicDiagnostic) {
        state = "conflict";
        diagnostic = organicDiagnostic;
      }
      const storedState: WinnerLiveProviderStoredOperation["state"] =
        state === "matched"
          ? "verified"
          : state === "conflict"
            ? "conflict"
            : state === "missing" && method === "reconcile"
              ? "confirmed_absent"
              : "ambiguous";
      await this.store.reconcile({
        ...current,
        state: storedState,
        providerOperationId:
          safeProviderOperationId(result.providerOperationId) ?? current.providerOperationId,
        evidence:
          state === "matched"
            ? evidence
            : preserveConflictEvidence
              ? conflictEvidence
              : current.evidence,
        updatedAt: checkedAt.toISOString(),
      });
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: plan.organizationId,
        operationId: plan.operationId,
        requestHash: plan.requestHash,
        state,
        providerInvoked: result.providerInvoked,
        liveVerified:
          state === "matched" && result.liveVerified && this.transport.kind !== "contract_fixture",
        evidence:
          state === "matched" ? evidence : preserveConflictEvidence ? conflictEvidence : null,
        diagnostic:
          diagnostic ??
          (state === "matched"
            ? null
            : normalizeDiagnostic({
                code: state === "conflict" ? "verification_mismatch" : "verification_pending",
                category: "verification",
                retryable: false,
                message: `Provider read-back state is ${state}`,
                nextAction:
                  state === "missing"
                    ? "Confirm absence before making a deliberate new attempt"
                    : "Continue bounded reconciliation without replaying apply",
              })),
      });
    } catch (error) {
      const organicDiagnostic = this.recordOrganicReadBackOutcome(
        method,
        plan,
        context,
        { state: "unknown", providerOperationId: null, evidence: null },
        (context.now ?? (() => new Date()))(),
      );
      return Object.freeze({
        adapterId: this.descriptor.id,
        organizationId: plan.organizationId,
        operationId: plan.operationId,
        requestHash: plan.requestHash,
        state: "unknown",
        providerInvoked: true,
        liveVerified: false,
        evidence: null,
        diagnostic: organicDiagnostic ?? transportErrorDiagnostic(error),
      });
    }
  }

  private isOrganicPlan(plan: WinnerLiveProviderPlan): boolean {
    return (
      plan.adapterId === "tiktok_content_posting" &&
      (plan.feature === "distribution.content.draft" ||
        plan.feature === "distribution.content.publish")
    );
  }

  private organicOperation(plan: WinnerLiveProviderPlan): OrganicPolicyOperation {
    if (!this.isOrganicPlan(plan)) {
      throw new WinnerLiveProviderContractError(
        "plan_adapter_mismatch",
        "Only a TikTok Content Posting plan can enter organic policy evaluation",
      );
    }
    return Object.freeze({
      adapterId: "tiktok_content_posting",
      organizationId: plan.organizationId,
      ventureId: plan.ventureId,
      providerAccountId: plan.providerAccountId,
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      requestHash: plan.requestHash,
      feature: plan.feature as "distribution.content.draft" | "distribution.content.publish",
      payload: plan.payload,
    });
  }

  private organicPolicyServiceGate(
    plan: WinnerLiveProviderPlan,
  ): WinnerLiveProviderDiagnostic | null {
    if (!this.isOrganicPlan(plan)) return null;
    if (
      this.organicPolicyService?.durability === "durable" &&
      this.organicPolicyService.transactionalReservations
    ) {
      return null;
    }
    return normalizeDiagnostic({
      code: "organic_policy_missing",
      category: "configuration",
      retryable: false,
      message: "TikTok organic execution requires a durable transactional policy service",
      nextAction: "Bind the tenant-scoped organic policy and publication store",
    });
  }

  private organicDiagnostic(failureValue: OrganicPolicyFailure): WinnerLiveProviderDiagnostic {
    const code: WinnerLiveProviderDiagnostic["code"] =
      failureValue.code === "policy_missing" || failureValue.code === "provider_snapshot_missing"
        ? "organic_policy_missing"
        : failureValue.code === "policy_stale" || failureValue.code === "provider_snapshot_stale"
          ? "organic_policy_stale"
          : failureValue.code === "account_limit" || failureValue.code === "daily_limit"
            ? "organic_policy_limit"
            : failureValue.code === "duplicate_content"
              ? "organic_policy_duplicate"
              : failureValue.code === "review_missing" || failureValue.code === "review_invalid"
                ? "organic_policy_review_invalid"
                : failureValue.code === "rights_invalid" ||
                    failureValue.code === "disclosure_invalid"
                  ? "organic_policy_rights_invalid"
                  : failureValue.code === "provider_unhealthy" ||
                      failureValue.code === "capability_unavailable"
                    ? "organic_policy_provider_unavailable"
                    : failureValue.code === "idempotency_conflict"
                      ? "idempotency_conflict"
                      : "organic_policy_invalid";
    return normalizeDiagnostic({
      code,
      category:
        failureValue.code === "idempotency_conflict" ||
        failureValue.code === "duplicate_content" ||
        failureValue.code === "account_limit" ||
        failureValue.code === "daily_limit"
          ? "idempotency"
          : failureValue.code === "provider_unhealthy" ||
              failureValue.code === "capability_unavailable"
            ? "provider"
            : "authorization",
      retryable: false,
      message: failureValue.message,
      nextAction: failureValue.nextAction,
    });
  }

  private recordOrganicApplyOutcome(
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
    outcome: {
      state: "accepted_unverified" | "unknown" | "failed" | "conflict";
      providerOperationId: string | null;
      externalEffectOccurred: boolean | "unknown";
    },
    at: Date,
  ): WinnerLiveProviderDiagnostic | null {
    if (!this.isOrganicPlan(plan)) return null;
    try {
      this.organicPolicyService!.recordApplyOutcome(
        this.organicOperation(plan),
        context.organicAuthority!,
        outcome,
        at,
      );
      return null;
    } catch (error) {
      const failureValue =
        error instanceof OrganicPolicyError
          ? error.failure
          : ({
              code: "store_invalid",
              message:
                error instanceof Error
                  ? error.message
                  : "Organic apply outcome could not be persisted",
              nextAction: "Reconcile the durable organic reservation before any new attempt",
            } satisfies OrganicPolicyFailure);
      return this.organicDiagnostic(failureValue);
    }
  }

  private recordOrganicReadBackOutcome(
    method: "readBack" | "reconcile",
    plan: WinnerLiveProviderPlan,
    context: WinnerLiveProviderContext,
    outcome: {
      state: "matched" | "missing" | "conflict" | "unknown";
      providerOperationId: string | null;
      evidence: WinnerLiveJsonObject | null;
    },
    at: Date,
  ): WinnerLiveProviderDiagnostic | null {
    if (!this.isOrganicPlan(plan)) return null;
    try {
      this.organicPolicyService!.recordReadBackOutcome(
        this.organicOperation(plan),
        context.organicAuthority!,
        { ...outcome, method },
        at,
      );
      return null;
    } catch (error) {
      const failureValue =
        error instanceof OrganicPolicyError
          ? error.failure
          : ({
              code: "store_invalid",
              message:
                error instanceof Error
                  ? error.message
                  : "Organic read-back evidence could not be persisted",
              nextAction: "Repair the durable reservation and continue bounded reconciliation",
            } satisfies OrganicPolicyFailure);
      return this.organicDiagnostic(failureValue);
    }
  }

  private transportGate(context: WinnerLiveProviderContext): WinnerLiveProviderDiagnostic | null {
    if (!this.transport) {
      return normalizeDiagnostic({
        code: "transport_missing",
        category: "configuration",
        retryable: false,
        message: `${this.descriptor.displayName} has no injected official transport`,
        nextAction: "Configure an official provider API or SDK transport",
      });
    }
    if (this.transport.adapterId !== this.descriptor.id) {
      return normalizeDiagnostic({
        code: "transport_mismatch",
        category: "configuration",
        retryable: false,
        message: `Transport for ${this.transport.adapterId} cannot serve ${this.descriptor.id}`,
        nextAction: "Inject the transport under its matching provider contract",
      });
    }
    if (context.environment === "production" && this.transport.kind === "contract_fixture") {
      return normalizeDiagnostic({
        code: "transport_mismatch",
        category: "configuration",
        retryable: false,
        message: "A contract-fixture transport cannot run in a production environment",
        nextAction: "Inject the configured official API or SDK transport",
      });
    }
    return null;
  }

  private operationStoreGate(
    context: WinnerLiveProviderContext,
  ): WinnerLiveProviderDiagnostic | null {
    if (!this.store) {
      return normalizeDiagnostic({
        code: "operation_store_missing",
        category: "configuration",
        retryable: false,
        message: "Authorized provider effects require an injected atomic operation store",
        nextAction: "Bind a durable idempotency store before provider execution",
      });
    }
    const fixtureException =
      context.environment === "test" &&
      this.transport?.kind === "contract_fixture" &&
      this.store.durability === "ephemeral_fixture";
    const productionStoreVerified =
      context.environment !== "production" || sqliteWinnerOperationStores.has(this.store);
    if (
      !this.store.atomicClaims ||
      (this.store.durability !== "durable_atomic" && !fixtureException) ||
      !productionStoreVerified
    ) {
      return normalizeDiagnostic({
        code: "operation_store_unsafe",
        category: "idempotency",
        retryable: false,
        message: "Provider execution requires durable atomic idempotency claims",
        nextAction: "Use a transactional durable store; ephemeral memory is fixture-only",
      });
    }
    return null;
  }

  private async current(
    plan: WinnerLiveProviderPlan,
  ): Promise<WinnerLiveProviderStoredOperation | undefined> {
    return this.store?.get(
      plan.organizationId,
      plan.ventureId,
      this.descriptor.id,
      plan.idempotencyKey,
    );
  }

  private execution(
    plan: WinnerLiveProviderPlan,
    state: WinnerLiveProviderExecutionResult["state"],
    reused: boolean,
    providerInvoked: boolean,
    externalEffectOccurred: boolean | "unknown",
    providerOperationId: string | null,
    output: WinnerLiveJsonObject | null,
    diagnostic: WinnerLiveProviderDiagnostic | null,
  ): WinnerLiveProviderExecutionResult {
    return Object.freeze({
      adapterId: this.descriptor.id,
      organizationId: plan.organizationId,
      operationId: plan.operationId,
      requestHash: plan.requestHash,
      state,
      reused,
      providerInvoked,
      externalEffectOccurred,
      liveVerified: false,
      providerOperationId,
      output,
      diagnostic,
    });
  }
}

export function createWinnerLiveProviderAdapters(
  options: {
    readonly transports?: Partial<Record<WinnerLiveProviderId, WinnerLiveProviderTransport>>;
    readonly store?: WinnerLiveProviderOperationStore;
    readonly paidAuthorizationStore?: WinnerLivePaidAuthorizationStore;
    readonly organicPolicyService?: OrganicPolicyService;
  } = {},
): Readonly<Record<WinnerLiveProviderId, WinnerLiveProviderAdapter>> {
  const make = (id: WinnerLiveProviderId): WinnerLiveProviderAdapter =>
    new InjectedWinnerLiveProviderAdapter(
      WINNER_LIVE_PROVIDER_DESCRIPTORS[id],
      options.transports?.[id],
      options.store,
      options.paidAuthorizationStore,
      options.organicPolicyService,
    );
  return Object.freeze({
    creative_generation: make("creative_generation"),
    tiktok_content_posting: make("tiktok_content_posting"),
    tiktok_spark_ads: make("tiktok_spark_ads"),
    aggregated_attribution: make("aggregated_attribution"),
    revenuecat: make("revenuecat"),
  });
}
