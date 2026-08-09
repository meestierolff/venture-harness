import { growthContractSchema, type GrowthContract } from "../config/growth-contract-schema";
import { assessCreativeCompliance, type CreativeManifestStore } from "./creative-manifest";
import type { CreativeLedgerStore } from "./creative-ledger-store";
import {
  hashOrganicPolicyValue,
  type OrganicPolicyStore,
  type OrganicPolicyScope,
  type OrganicPolicyTerms,
  type OrganicProviderSnapshotInput,
  type OrganicPublicationFeature,
  type OrganicReservationState,
  type OrganicReviewMode,
  type StoredOrganicPolicySnapshot,
  type StoredOrganicProviderSnapshot,
  type StoredOrganicReservation,
  type StoredOrganicReviewApproval,
} from "./organic-policy-store";

const TIKTOK_ADAPTER_ID = "tiktok_content_posting";
const TIKTOK_PROVIDER_ID = "tiktok_content";
const MAX_ORGANIC_ACCOUNTS = 3;
const MAX_POLICY_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_PROVIDER_SNAPSHOT_AGE_MS = 15 * 60 * 1_000;
const HASH = /^[a-f0-9]{64}$/u;

export interface OrganicPolicyOperation {
  readonly adapterId: typeof TIKTOK_ADAPTER_ID;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly providerAccountId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly feature: OrganicPublicationFeature;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OrganicPolicyIntent {
  readonly policySnapshotId: string;
  readonly policyHash: string;
  readonly providerSnapshotId: string;
  readonly accountStateHash: string;
  readonly region: string;
  readonly deliveryVariantId: string | null;
  readonly contentFingerprint: string;
  readonly variationFingerprint: string | null;
  readonly intentHash: string;
}

export interface OrganicPolicyExecutionAuthority extends OrganicPolicyIntent {
  readonly reviewApprovalId: string | null;
}

export type OrganicPolicyFailureCode =
  | "policy_missing"
  | "policy_invalid"
  | "policy_stale"
  | "provider_snapshot_missing"
  | "provider_snapshot_stale"
  | "provider_unhealthy"
  | "capability_unavailable"
  | "account_not_allowed"
  | "provider_not_allowed"
  | "account_limit"
  | "daily_limit"
  | "duplicate_content"
  | "review_missing"
  | "review_invalid"
  | "rights_invalid"
  | "disclosure_invalid"
  | "publication_mode_invalid"
  | "authority_forged"
  | "idempotency_conflict"
  | "store_invalid";

export interface OrganicPolicyFailure {
  readonly code: OrganicPolicyFailureCode;
  readonly message: string;
  readonly nextAction: string;
}

export type OrganicPolicyAuthorizationResult =
  | {
      readonly kind: "authorized";
      readonly reused: boolean;
      readonly reviewMode: OrganicReviewMode;
      readonly reservation: StoredOrganicReservation;
    }
  | { readonly kind: "blocked"; readonly failure: OrganicPolicyFailure };

export type OrganicPolicyReconciliationResult =
  | { readonly kind: "authorized"; readonly reservation: StoredOrganicReservation }
  | { readonly kind: "blocked"; readonly failure: OrganicPolicyFailure };

export interface OrganicPolicyService {
  readonly durability: "durable";
  readonly transactionalReservations: true;
  recordPolicySnapshot(input: {
    readonly organizationId: string;
    readonly snapshotId: string;
    readonly contract: unknown;
    readonly capturedAt: string;
    readonly expiresAt: string;
  }): StoredOrganicPolicySnapshot;
  recordProviderSnapshot(input: OrganicProviderSnapshotInput): StoredOrganicProviderSnapshot;
  createIntent(
    operation: OrganicPolicyOperation,
    input: {
      readonly policySnapshotId: string;
      readonly providerSnapshotId: string;
      readonly region: string;
      readonly deliveryVariantId?: string | null;
      readonly now?: Date;
    },
  ): OrganicPolicyIntent;
  approveIntent(input: {
    readonly operation: OrganicPolicyOperation;
    readonly intent: OrganicPolicyIntent;
    readonly approvalId: string;
    readonly approvedBy: string;
    readonly approvalRef: string;
    readonly approvedAt: string;
    readonly expiresAt: string;
  }): StoredOrganicReviewApproval;
  executionAuthority(
    intent: OrganicPolicyIntent,
    reviewApprovalId?: string | null,
  ): OrganicPolicyExecutionAuthority;
  authorizeAndReserve(
    operation: OrganicPolicyOperation,
    authority: OrganicPolicyExecutionAuthority | undefined,
    at?: Date,
  ): OrganicPolicyAuthorizationResult;
  authorizeReconciliation(
    operation: OrganicPolicyOperation,
    authority: OrganicPolicyExecutionAuthority | undefined,
  ): OrganicPolicyReconciliationResult;
  recordApplyOutcome(
    operation: OrganicPolicyOperation,
    authority: OrganicPolicyExecutionAuthority,
    outcome: {
      readonly state: "accepted_unverified" | "unknown" | "failed" | "conflict";
      readonly providerOperationId: string | null;
      readonly externalEffectOccurred: boolean | "unknown";
    },
    at?: Date,
  ): StoredOrganicReservation;
  recordReadBackOutcome(
    operation: OrganicPolicyOperation,
    authority: OrganicPolicyExecutionAuthority,
    outcome: {
      readonly method: "readBack" | "reconcile";
      readonly state: "matched" | "missing" | "conflict" | "unknown";
      readonly providerOperationId: string | null;
      readonly evidence: Readonly<Record<string, unknown>> | null;
    },
    at?: Date,
  ): StoredOrganicReservation;
  getReservation(
    scope: OrganicPolicyScope,
    reservationId: string,
  ): StoredOrganicReservation | undefined;
}

export class OrganicPolicyError extends Error {
  constructor(readonly failure: OrganicPolicyFailure) {
    super(failure.message);
    this.name = "OrganicPolicyError";
  }
}

function failure(
  code: OrganicPolicyFailureCode,
  message: string,
  nextAction: string,
): OrganicPolicyFailure {
  return Object.freeze({ code, message, nextAction });
}

function throwFailure(code: OrganicPolicyFailureCode, message: string, nextAction: string): never {
  throw new OrganicPolicyError(failure(code, message, nextAction));
}

function assertDateRange(start: string, end: string, label: string): void {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throwFailure(
      "policy_invalid",
      `${label} has an invalid active window`,
      `Record a valid, bounded ${label}`,
    );
  }
}

function policyTerms(contract: GrowthContract): OrganicPolicyTerms {
  if (
    contract.organic.max_accounts > MAX_ORGANIC_ACCOUNTS ||
    contract.organic.allowed_accounts.length > contract.organic.max_accounts ||
    contract.organic.allowed_accounts.length > MAX_ORGANIC_ACCOUNTS
  ) {
    throwFailure(
      "account_limit",
      "Growth Contract organic accounts exceed the hard maximum of three",
      "Reduce allowed_accounts and max_accounts to no more than three",
    );
  }
  if (
    contract.organic.allowed_providers.length === 0 ||
    contract.organic.allowed_accounts.length === 0
  ) {
    throwFailure(
      "policy_invalid",
      "Growth Contract organic provider and account allowlists must be non-empty",
      "Approve at least one exact organic provider and account",
    );
  }
  return Object.freeze({
    contractVersion: 2 as const,
    ventureId: contract.venture_id,
    allowedProviders: Object.freeze([...contract.organic.allowed_providers]),
    allowedAccounts: Object.freeze([...contract.organic.allowed_accounts]),
    maxAccounts: contract.organic.max_accounts,
    maxPostsPerAccountPerDay: contract.organic.max_posts_per_account_per_day,
    duplicateContentPolicy: contract.organic.duplicate_content_policy,
    defaultReviewMode: contract.organic.default_review_mode,
    disclosureRequired:
      contract.organic.ai_disclosure_required || contract.compliance.ai_disclosure_required,
    allowedRegions: Object.freeze([...contract.compliance.allowed_geographies]),
    prohibitedClaims: Object.freeze([...contract.compliance.prohibited_claims]),
    providerPolicyState: contract.compliance.provider_policy_state,
  });
}

function operationCreativeId(operation: OrganicPolicyOperation): string {
  const creativeId = operation.payload.creative_id;
  if (typeof creativeId !== "string" || !creativeId.trim()) {
    throwFailure(
      "policy_invalid",
      "Organic operation has no immutable creative identity",
      "Plan the operation with the registered creative_id",
    );
  }
  return creativeId;
}

function operationScope(operation: OrganicPolicyOperation): OrganicPolicyScope {
  return {
    organizationId: operation.organizationId,
    ventureId: operation.ventureId,
  };
}

function assertOperation(operation: OrganicPolicyOperation): void {
  if (
    operation.adapterId !== TIKTOK_ADAPTER_ID ||
    !operation.organizationId.trim() ||
    !operation.ventureId.trim() ||
    !operation.providerAccountId.trim() ||
    !operation.operationId.trim() ||
    !operation.idempotencyKey.trim() ||
    !HASH.test(operation.requestHash)
  ) {
    throwFailure(
      "policy_invalid",
      "Organic operation is malformed or is not a TikTok Content Posting request",
      "Re-plan the exact organic operation through the registered adapter",
    );
  }
  operationCreativeId(operation);
}

function isCurrent(observedAt: string, expiresAt: string, at: Date, maximumAgeMs: number): boolean {
  const observed = Date.parse(observedAt);
  const expires = Date.parse(expiresAt);
  return (
    Number.isFinite(observed) &&
    Number.isFinite(expires) &&
    observed <= at.getTime() &&
    at.getTime() < expires &&
    at.getTime() - observed <= maximumAgeMs
  );
}

function utcOffsetDayKey(at: Date, timezone: string): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function asOrganicOperationPayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean | Readonly<Record<string, unknown>>>> {
  return payload as Readonly<
    Record<string, string | number | boolean | Readonly<Record<string, unknown>>>
  >;
}

export function createOrganicPolicyService(options: {
  readonly store: OrganicPolicyStore;
  readonly creativeStore: Pick<
    CreativeLedgerStore,
    "durable" | "getVariant" | "getDeliveryVariant"
  >;
  readonly manifestStore: Pick<CreativeManifestStore, "durable" | "getCurrent">;
  readonly timezone?: string;
}): OrganicPolicyService {
  if (options.store.durability !== "durable" || !options.store.transactionalReservations) {
    throw new OrganicPolicyError(
      failure(
        "store_invalid",
        "Organic publication requires a durable transactional reservation store",
        "Bind the SQLite organic policy store before provider execution",
      ),
    );
  }
  if (!options.creativeStore.durable || !options.manifestStore.durable) {
    throw new OrganicPolicyError(
      failure(
        "store_invalid",
        "Current creative identity and rights must come from durable authoritative stores",
        "Bind durable creative and manifest stores before provider execution",
      ),
    );
  }
  const timezone = options.timezone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new OrganicPolicyError(
      failure("policy_invalid", "Organic policy timezone is invalid", "Use an IANA timezone"),
    );
  }

  function loadPolicy(
    operation: OrganicPolicyOperation,
    snapshotId: string,
    at: Date,
    requireCurrent: boolean,
  ): StoredOrganicPolicySnapshot {
    let snapshot: StoredOrganicPolicySnapshot | undefined;
    let latest: StoredOrganicPolicySnapshot | undefined;
    try {
      snapshot = options.store.getPolicySnapshot(operationScope(operation), snapshotId);
      latest = options.store.getLatestPolicySnapshot(operationScope(operation));
    } catch (error) {
      throwFailure(
        "authority_forged",
        error instanceof Error ? error.message : "Policy snapshot integrity check failed",
        "Restore the signed policy snapshot before any organic provider call",
      );
    }
    if (!snapshot) {
      throwFailure(
        "policy_missing",
        "The referenced Growth Contract policy snapshot does not exist for this venture",
        "Record a current Growth Contract v2 snapshot",
      );
    }
    if (
      requireCurrent &&
      (latest?.snapshotId !== snapshot.snapshotId ||
        !isCurrent(snapshot.capturedAt, snapshot.expiresAt, at, MAX_POLICY_SNAPSHOT_AGE_MS))
    ) {
      throwFailure(
        "policy_stale",
        "The Growth Contract policy snapshot is stale or superseded",
        "Record and bind the latest current Growth Contract v2 snapshot",
      );
    }
    return snapshot;
  }

  function loadProvider(
    operation: OrganicPolicyOperation,
    snapshotId: string,
    at: Date,
    requireCurrent: boolean,
  ): StoredOrganicProviderSnapshot {
    let snapshot: StoredOrganicProviderSnapshot | undefined;
    let latest: StoredOrganicProviderSnapshot | undefined;
    try {
      snapshot = options.store.getProviderSnapshot(operationScope(operation), snapshotId);
      latest = options.store.getLatestProviderSnapshot(
        operationScope(operation),
        TIKTOK_PROVIDER_ID,
        operation.providerAccountId,
      );
    } catch (error) {
      throwFailure(
        "authority_forged",
        error instanceof Error ? error.message : "Provider snapshot integrity check failed",
        "Restore a signed provider health snapshot before any organic provider call",
      );
    }
    if (!snapshot) {
      throwFailure(
        "provider_snapshot_missing",
        "The referenced TikTok account snapshot does not exist for this venture",
        "Run provider doctor and persist its sanitized account and capability read-back",
      );
    }
    if (
      snapshot.providerId !== TIKTOK_PROVIDER_ID ||
      snapshot.organizationId !== operation.organizationId ||
      snapshot.providerAccountId !== operation.providerAccountId ||
      snapshot.ventureId !== operation.ventureId
    ) {
      throwFailure(
        "authority_forged",
        "Provider snapshot is bound to another provider, account, or venture",
        "Use the current snapshot for this exact TikTok account",
      );
    }
    if (
      requireCurrent &&
      (latest?.snapshotId !== snapshot.snapshotId ||
        !isCurrent(snapshot.observedAt, snapshot.expiresAt, at, MAX_PROVIDER_SNAPSHOT_AGE_MS))
    ) {
      throwFailure(
        "provider_snapshot_stale",
        "TikTok account health and capability evidence is stale or superseded",
        "Query current creator/account state and persist a new snapshot",
      );
    }
    return snapshot;
  }

  function creativeState(
    operation: OrganicPolicyOperation,
    deliveryVariantId: string | null,
    policy: StoredOrganicPolicySnapshot,
    at: Date,
    region: string,
  ): {
    contentFingerprint: string;
    variationFingerprint: string | null;
    manifestVersion: number;
    reviewEventId: string;
  } {
    const creativeId = operationCreativeId(operation);
    const scope = operationScope(operation);
    const variant = options.creativeStore.getVariant(scope, creativeId);
    const manifest = options.manifestStore.getCurrent(scope, creativeId);
    if (!variant || !manifest) {
      throwFailure(
        "rights_invalid",
        "The creative identity or current rights manifest is absent",
        "Register the creative and complete a current rights review",
      );
    }
    const assessment = assessCreativeCompliance(
      manifest,
      { mode: "organic", channel: "tiktok_organic", region, at },
      {
        disclosureRequired: policy.terms.disclosureRequired,
        allowedRegions: policy.terms.allowedRegions,
        allowedChannels: ["tiktok_organic"],
        prohibitedClaims: policy.terms.prohibitedClaims,
      },
    );
    if (!assessment.allowed) {
      const disclosureOnly = assessment.blockers.every((entry) => entry === "disclosure_missing");
      throwFailure(
        disclosureOnly ? "disclosure_invalid" : "rights_invalid",
        `Current organic rights/compliance check failed: ${assessment.blockers.join(", ")}`,
        "Refresh the current manifest review; do not reuse stale approval",
      );
    }
    const payload = asOrganicOperationPayload(operation.payload);
    if (
      operation.feature === "distribution.content.publish" &&
      manifest.aiGenerated &&
      payload.is_aigc !== true
    ) {
      throwFailure(
        "disclosure_invalid",
        "AI-generated creative is not disclosed in the provider request",
        "Set the provider AIGC disclosure and retain its current evidence",
      );
    }

    let variationFingerprint: string | null = null;
    if (deliveryVariantId !== null) {
      const delivery = options.creativeStore.getDeliveryVariant(scope, deliveryVariantId);
      if (!delivery || delivery.creativeId !== creativeId) {
        throwFailure(
          "authority_forged",
          "Delivery variant is absent or belongs to another creative",
          "Bind the exact registered delivery variant",
        );
      }
      if (operation.feature === "distribution.content.publish") {
        const settings = delivery.delivery.platformSettings;
        const exactSettings = [
          "disable_duet",
          "disable_stitch",
          "disable_comment",
          "brand_content_toggle",
          "brand_organic_toggle",
          "is_aigc",
        ] as const;
        if (
          delivery.delivery.caption !== payload.title ||
          delivery.delivery.privacy !== payload.privacy_level ||
          exactSettings.some((key) => settings[key] !== payload[key])
        ) {
          throwFailure(
            "authority_forged",
            "Provider request differs from the registered delivery variant",
            "Re-plan from the immutable delivery variant and approve that exact request",
          );
        }
      }
      variationFingerprint = delivery.deliveryFingerprint;
    } else if (operation.feature === "distribution.content.publish") {
      throwFailure(
        "policy_invalid",
        "Direct publication requires an immutable delivery variant",
        "Register caption, privacy, and platform settings as a delivery variant",
      );
    }

    if (
      policy.terms.duplicateContentPolicy === "allow_with_variation" &&
      variationFingerprint === null
    ) {
      throwFailure(
        "policy_invalid",
        "allow_with_variation requires a registered delivery variation",
        "Bind a delivery variant or use a stricter duplicate policy",
      );
    }
    return {
      contentFingerprint: variant.contentFingerprint,
      variationFingerprint,
      manifestVersion: assessment.manifestVersion,
      reviewEventId: assessment.reviewEventId,
    };
  }

  function validatePolicyScope(
    operation: OrganicPolicyOperation,
    policy: StoredOrganicPolicySnapshot,
    provider: StoredOrganicProviderSnapshot,
  ): void {
    const terms = policy.terms;
    if (
      terms.contractVersion !== 2 ||
      policy.organizationId !== operation.organizationId ||
      provider.organizationId !== operation.organizationId ||
      terms.ventureId !== operation.ventureId ||
      terms.maxAccounts > MAX_ORGANIC_ACCOUNTS ||
      terms.allowedAccounts.length > terms.maxAccounts ||
      terms.allowedAccounts.length > MAX_ORGANIC_ACCOUNTS
    ) {
      throwFailure(
        "policy_invalid",
        "Growth Contract v2 scope or account limits are invalid",
        "Record a valid tenant-scoped contract with no more than three accounts",
      );
    }
    if (!terms.allowedProviders.includes(provider.providerId)) {
      throwFailure(
        "provider_not_allowed",
        "Growth Contract does not allow this organic provider",
        "Approve the exact provider in the current contract",
      );
    }
    if (!terms.allowedAccounts.includes(operation.providerAccountId)) {
      throwFailure(
        "account_not_allowed",
        "Growth Contract does not allow this organic account",
        "Select one of the explicitly allowed organic accounts",
      );
    }
  }

  function validateExecutionState(
    operation: OrganicPolicyOperation,
    policy: StoredOrganicPolicySnapshot,
    provider: StoredOrganicProviderSnapshot,
  ): void {
    if (policy.terms.providerPolicyState !== "clear") {
      throwFailure(
        "provider_unhealthy",
        "Growth Contract provider policy state is not clear",
        "Resolve the current policy warning/restriction and record a new snapshot",
      );
    }
    if (
      provider.health !== "healthy" ||
      provider.providerPolicyState !== "clear" ||
      !provider.canPost
    ) {
      throwFailure(
        "provider_unhealthy",
        "Current TikTok account state does not permit a posting attempt",
        "Resolve account health or posting eligibility and refresh creator info",
      );
    }
    if (!provider.availableFeatures.includes(operation.feature)) {
      throwFailure(
        "capability_unavailable",
        "Current TikTok account snapshot lacks the requested posting capability",
        "Use an available mode or reauthorize the required provider scope",
      );
    }
    if (
      policy.terms.defaultReviewMode === "PLATFORM_DRAFT" &&
      operation.feature !== "distribution.content.draft"
    ) {
      throwFailure(
        "publication_mode_invalid",
        "PLATFORM_DRAFT policy forbids direct publication",
        "Upload a platform draft for the creator to finish in TikTok",
      );
    }
  }

  function buildIntent(
    operation: OrganicPolicyOperation,
    input: {
      policySnapshotId: string;
      providerSnapshotId: string;
      region: string;
      deliveryVariantId: string | null;
      at: Date;
      requireCurrent: boolean;
    },
  ): OrganicPolicyIntent & {
    policy: StoredOrganicPolicySnapshot;
    provider: StoredOrganicProviderSnapshot;
    manifestVersion: number;
    reviewEventId: string;
  } {
    assertOperation(operation);
    if (!input.region.trim()) {
      throwFailure(
        "policy_invalid",
        "Organic publication region is required",
        "Bind the exact target region to the request",
      );
    }
    const policy = loadPolicy(operation, input.policySnapshotId, input.at, input.requireCurrent);
    const provider = loadProvider(
      operation,
      input.providerSnapshotId,
      input.at,
      input.requireCurrent,
    );
    validatePolicyScope(operation, policy, provider);
    const creative = creativeState(
      operation,
      input.deliveryVariantId,
      policy,
      input.at,
      input.region,
    );
    const intentHash = hashOrganicPolicyValue({
      adapterId: operation.adapterId,
      organizationId: operation.organizationId,
      ventureId: operation.ventureId,
      providerAccountId: operation.providerAccountId,
      operationId: operation.operationId,
      requestHash: operation.requestHash,
      feature: operation.feature,
      policySnapshotId: policy.snapshotId,
      policyHash: policy.policyHash,
      providerSnapshotId: provider.snapshotId,
      accountStateHash: provider.accountStateHash,
      region: input.region,
      deliveryVariantId: input.deliveryVariantId,
      contentFingerprint: creative.contentFingerprint,
      variationFingerprint: creative.variationFingerprint,
      manifestVersion: creative.manifestVersion,
      reviewEventId: creative.reviewEventId,
    });
    return {
      policySnapshotId: policy.snapshotId,
      policyHash: policy.policyHash,
      providerSnapshotId: provider.snapshotId,
      accountStateHash: provider.accountStateHash,
      region: input.region,
      deliveryVariantId: input.deliveryVariantId,
      contentFingerprint: creative.contentFingerprint,
      variationFingerprint: creative.variationFingerprint,
      intentHash,
      policy,
      provider,
      manifestVersion: creative.manifestVersion,
      reviewEventId: creative.reviewEventId,
    };
  }

  function assertAuthority(
    operation: OrganicPolicyOperation,
    authority: OrganicPolicyExecutionAuthority | undefined,
    at: Date,
    requireCurrent: boolean,
  ): ReturnType<typeof buildIntent> {
    if (!authority) {
      throwFailure(
        "policy_missing",
        "Organic execution authority is absent",
        "Bind current signed policy/account snapshots and review state",
      );
    }
    const expected = buildIntent(operation, {
      policySnapshotId: authority.policySnapshotId,
      providerSnapshotId: authority.providerSnapshotId,
      region: authority.region,
      deliveryVariantId: authority.deliveryVariantId,
      at,
      requireCurrent,
    });
    if (
      authority.policyHash !== expected.policyHash ||
      authority.accountStateHash !== expected.accountStateHash ||
      authority.contentFingerprint !== expected.contentFingerprint ||
      authority.variationFingerprint !== expected.variationFingerprint ||
      authority.intentHash !== expected.intentHash
    ) {
      throwFailure(
        "authority_forged",
        "Organic execution authority does not match current signed inputs",
        "Recreate authority from the exact immutable provider plan",
      );
    }
    return expected;
  }

  function validateReview(
    operation: OrganicPolicyOperation,
    authority: OrganicPolicyExecutionAuthority,
    intent: ReturnType<typeof buildIntent>,
    at: Date,
  ): StoredOrganicReviewApproval | null {
    if (
      intent.policy.terms.defaultReviewMode !== "REVIEW_BEFORE_PUBLISH" ||
      operation.feature !== "distribution.content.publish"
    ) {
      if (authority.reviewApprovalId !== null) {
        throwFailure(
          "review_invalid",
          "Review approval was supplied for a policy mode that does not consume it",
          "Use authority produced for the configured review mode",
        );
      }
      return null;
    }
    if (!authority.reviewApprovalId) {
      throwFailure(
        "review_missing",
        "REVIEW_BEFORE_PUBLISH requires a durable request-bound approval",
        "Approve the exact publication intent before provider execution",
      );
    }
    let review: StoredOrganicReviewApproval | undefined;
    try {
      review = options.store.getReviewApproval(
        operationScope(operation),
        authority.reviewApprovalId,
      );
    } catch (error) {
      throwFailure(
        "authority_forged",
        error instanceof Error ? error.message : "Review approval integrity check failed",
        "Restore a signed review approval for the exact request",
      );
    }
    if (
      !review ||
      review.organizationId !== operation.organizationId ||
      review.ventureId !== operation.ventureId ||
      review.operationId !== operation.operationId ||
      review.requestHash !== operation.requestHash ||
      review.intentHash !== intent.intentHash ||
      review.policySnapshotId !== intent.policy.snapshotId ||
      review.providerSnapshotId !== intent.provider.snapshotId ||
      review.providerAccountId !== operation.providerAccountId ||
      review.creativeId !== operationCreativeId(operation) ||
      !review.approvedBy.trim() ||
      !review.approvalRef.trim() ||
      !isCurrent(review.approvedAt, review.expiresAt, at, MAX_POLICY_SNAPSHOT_AGE_MS)
    ) {
      throwFailure(
        "review_invalid",
        "Organic review is absent, stale, or bound to different material terms",
        "Approve the exact current publication intent again",
      );
    }
    return review;
  }

  function exactReservation(
    operation: OrganicPolicyOperation,
    authority: OrganicPolicyExecutionAuthority,
  ): StoredOrganicReservation {
    let reservation: StoredOrganicReservation | undefined;
    try {
      reservation = options.store.getReservationByIdempotencyKey(
        operationScope(operation),
        operation.idempotencyKey,
      );
    } catch (error) {
      throwFailure(
        "authority_forged",
        error instanceof Error ? error.message : "Reservation integrity check failed",
        "Restore the durable organic reservation before reconciliation",
      );
    }
    if (
      !reservation ||
      reservation.organizationId !== operation.organizationId ||
      reservation.operationId !== operation.operationId ||
      reservation.requestHash !== operation.requestHash ||
      reservation.intentHash !== authority.intentHash ||
      reservation.policySnapshotId !== authority.policySnapshotId ||
      reservation.providerSnapshotId !== authority.providerSnapshotId ||
      reservation.providerAccountId !== operation.providerAccountId ||
      reservation.feature !== operation.feature
    ) {
      throwFailure(
        "authority_forged",
        "Organic reservation is absent or belongs to another request",
        "Reconcile only the exact durably reserved provider operation",
      );
    }
    return reservation;
  }

  const service: OrganicPolicyService = {
    durability: "durable",
    transactionalReservations: true,

    recordPolicySnapshot(input) {
      assertDateRange(input.capturedAt, input.expiresAt, "policy snapshot");
      let contract: GrowthContract;
      try {
        contract = growthContractSchema.parse(input.contract);
      } catch (error) {
        throw new OrganicPolicyError(
          failure(
            "policy_invalid",
            error instanceof Error ? error.message : "Growth Contract v2 is invalid",
            "Validate and record an exact Growth Contract v2 snapshot",
          ),
        );
      }
      return options.store.putPolicySnapshot({
        organizationId: input.organizationId,
        snapshotId: input.snapshotId,
        terms: policyTerms(contract),
        capturedAt: input.capturedAt,
        expiresAt: input.expiresAt,
      });
    },

    recordProviderSnapshot(input) {
      assertDateRange(input.observedAt, input.expiresAt, "provider snapshot");
      if (
        !input.organizationId.trim() ||
        input.providerId !== TIKTOK_PROVIDER_ID ||
        !input.evidenceRef.trim() ||
        new Set(input.availableFeatures).size !== input.availableFeatures.length
      ) {
        throw new OrganicPolicyError(
          failure(
            "policy_invalid",
            "Provider snapshot is malformed or is not TikTok Content Posting evidence",
            "Persist sanitized doctor/creator-info evidence for the exact account",
          ),
        );
      }
      return options.store.putProviderSnapshot(input);
    },

    createIntent(operation, input) {
      const built = buildIntent(operation, {
        policySnapshotId: input.policySnapshotId,
        providerSnapshotId: input.providerSnapshotId,
        region: input.region,
        deliveryVariantId: input.deliveryVariantId ?? null,
        at: input.now ?? new Date(),
        requireCurrent: true,
      });
      return Object.freeze({
        policySnapshotId: built.policySnapshotId,
        policyHash: built.policyHash,
        providerSnapshotId: built.providerSnapshotId,
        accountStateHash: built.accountStateHash,
        region: built.region,
        deliveryVariantId: built.deliveryVariantId,
        contentFingerprint: built.contentFingerprint,
        variationFingerprint: built.variationFingerprint,
        intentHash: built.intentHash,
      });
    },

    approveIntent(input) {
      assertDateRange(input.approvedAt, input.expiresAt, "organic review approval");
      const at = new Date(input.approvedAt);
      const expected = assertAuthority(
        input.operation,
        { ...input.intent, reviewApprovalId: null },
        at,
        true,
      );
      if (
        expected.policy.terms.defaultReviewMode !== "REVIEW_BEFORE_PUBLISH" ||
        input.operation.feature !== "distribution.content.publish" ||
        !input.approvedBy.trim() ||
        !input.approvalRef.trim()
      ) {
        throw new OrganicPolicyError(
          failure(
            "review_invalid",
            "Only a complete direct-publication review can be recorded in review mode",
            "Record a named reviewer and evidence for the exact current intent",
          ),
        );
      }
      return options.store.putReviewApproval({
        organizationId: input.operation.organizationId,
        approvalId: input.approvalId,
        ventureId: input.operation.ventureId,
        operationId: input.operation.operationId,
        requestHash: input.operation.requestHash,
        intentHash: expected.intentHash,
        policySnapshotId: expected.policy.snapshotId,
        providerSnapshotId: expected.provider.snapshotId,
        providerAccountId: input.operation.providerAccountId,
        creativeId: operationCreativeId(input.operation),
        approvedBy: input.approvedBy,
        approvalRef: input.approvalRef,
        approvedAt: input.approvedAt,
        expiresAt: input.expiresAt,
      });
    },

    executionAuthority(intent, reviewApprovalId = null) {
      return Object.freeze({ ...intent, reviewApprovalId });
    },

    authorizeAndReserve(operation, authority, at = new Date()) {
      try {
        const intent = assertAuthority(operation, authority, at, true);
        validateExecutionState(operation, intent.policy, intent.provider);
        const review = validateReview(operation, authority!, intent, at);
        const bindingHash = hashOrganicPolicyValue({
          organizationId: operation.organizationId,
          operationRequestHash: operation.requestHash,
          intentHash: intent.intentHash,
          policyIntegrityProof: intent.policy.integrityProof,
          providerIntegrityProof: intent.provider.integrityProof,
          reviewIntegrityProof: review?.integrityProof ?? null,
          idempotencyKey: operation.idempotencyKey,
        });
        const reservationId = `organic_${hashOrganicPolicyValue({
          organizationId: operation.organizationId,
          ventureId: operation.ventureId,
          idempotencyKey: operation.idempotencyKey,
          bindingHash,
        }).slice(0, 40)}`;
        const result = options.store.reserveAtomically(
          {
            organizationId: operation.organizationId,
            reservationId,
            ventureId: operation.ventureId,
            idempotencyKey: operation.idempotencyKey,
            operationId: operation.operationId,
            requestHash: operation.requestHash,
            intentHash: intent.intentHash,
            bindingHash,
            policySnapshotId: intent.policy.snapshotId,
            providerSnapshotId: intent.provider.snapshotId,
            providerId: intent.provider.providerId,
            providerAccountId: operation.providerAccountId,
            feature: operation.feature,
            reviewMode: intent.policy.terms.defaultReviewMode,
            creativeId: operationCreativeId(operation),
            deliveryVariantId: intent.deliveryVariantId,
            contentFingerprint: intent.contentFingerprint,
            variationFingerprint: intent.variationFingerprint,
            region: intent.region,
            dayKey: utcOffsetDayKey(at, timezone),
            createdAt: at.toISOString(),
          },
          {
            maxAccounts: intent.policy.terms.maxAccounts,
            maxPostsPerAccountPerDay: intent.policy.terms.maxPostsPerAccountPerDay,
            duplicateContentPolicy: intent.policy.terms.duplicateContentPolicy,
          },
        );
        switch (result.kind) {
          case "created":
            return Object.freeze({
              kind: "authorized" as const,
              reused: false,
              reviewMode: intent.policy.terms.defaultReviewMode,
              reservation: result.reservation,
            });
          case "idempotent_replay":
            return Object.freeze({
              kind: "authorized" as const,
              reused: true,
              reviewMode: intent.policy.terms.defaultReviewMode,
              reservation: result.reservation,
            });
          case "idempotency_conflict":
            return Object.freeze({
              kind: "blocked" as const,
              failure: failure(
                "idempotency_conflict",
                "Organic idempotency key is bound to different immutable input",
                "Use the original request or a new intentional idempotency key",
              ),
            });
          case "account_limit":
            return Object.freeze({
              kind: "blocked" as const,
              failure: failure(
                "account_limit",
                `Organic account cap exceeded (${result.attempted}/${result.limit})`,
                "Use an already active allowed account or approve a stricter account set",
              ),
            });
          case "daily_limit":
            return Object.freeze({
              kind: "blocked" as const,
              failure: failure(
                "daily_limit",
                `Organic daily account cap exceeded (${result.attempted}/${result.limit})`,
                "Wait for the next tenant-local day; do not bypass the reservation",
              ),
            });
          case "duplicate":
            return Object.freeze({
              kind: "blocked" as const,
              failure: failure(
                "duplicate_content",
                "Growth Contract duplicate policy blocks this content",
                `Reuse reservation ${result.existingReservationId} or create a permitted variation`,
              ),
            });
        }
      } catch (error) {
        const organic =
          error instanceof OrganicPolicyError
            ? error.failure
            : failure(
                "store_invalid",
                error instanceof Error ? error.message : "Organic policy evaluation failed",
                "Restore the durable policy store before provider execution",
              );
        return Object.freeze({ kind: "blocked" as const, failure: organic });
      }
    },

    authorizeReconciliation(operation, authority) {
      try {
        assertOperation(operation);
        if (!authority) {
          throwFailure(
            "policy_missing",
            "Organic reconciliation authority is absent",
            "Use the exact authority stored with the unresolved reservation",
          );
        }
        const reservation = exactReservation(operation, authority);
        return Object.freeze({ kind: "authorized" as const, reservation });
      } catch (error) {
        const organic =
          error instanceof OrganicPolicyError
            ? error.failure
            : failure(
                "store_invalid",
                error instanceof Error ? error.message : "Organic reservation lookup failed",
                "Restore the durable organic reservation before provider read-back",
              );
        return Object.freeze({ kind: "blocked" as const, failure: organic });
      }
    },

    recordApplyOutcome(operation, authority, outcome, at = new Date()) {
      const reservation = exactReservation(operation, authority);
      let state: OrganicReservationState;
      if (outcome.state === "accepted_unverified") state = "accepted_unverified";
      else if (outcome.state === "unknown" || outcome.externalEffectOccurred === "unknown") {
        state = "pending_reconciliation";
      } else if (outcome.state === "conflict") state = "conflict";
      else state = outcome.externalEffectOccurred === false ? "failed_no_effect" : "conflict";
      return options.store.transitionReservation({
        organizationId: operation.organizationId,
        ventureId: operation.ventureId,
        reservationId: reservation.reservationId,
        requestHash: operation.requestHash,
        intentHash: authority.intentHash,
        state,
        providerOperationId: outcome.providerOperationId,
        updatedAt: at.toISOString(),
      });
    },

    recordReadBackOutcome(operation, authority, outcome, at = new Date()) {
      const reservation = exactReservation(operation, authority);
      let state: OrganicReservationState;
      if (outcome.state === "matched") {
        state =
          operation.feature === "distribution.content.publish" ? "published" : "verified_draft";
      } else if (outcome.state === "conflict") state = "conflict";
      else if (outcome.state === "missing" && outcome.method === "reconcile") {
        state = "confirmed_absent";
      } else state = "pending_reconciliation";
      return options.store.transitionReservation({
        organizationId: operation.organizationId,
        ventureId: operation.ventureId,
        reservationId: reservation.reservationId,
        requestHash: operation.requestHash,
        intentHash: authority.intentHash,
        state,
        providerOperationId: outcome.providerOperationId,
        evidenceHash: outcome.evidence ? hashOrganicPolicyValue(outcome.evidence) : null,
        updatedAt: at.toISOString(),
      });
    },

    getReservation(scope, reservationId) {
      return options.store.getReservation(scope, reservationId);
    },
  };

  return Object.freeze(service);
}
