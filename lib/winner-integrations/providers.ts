import { createHash } from "node:crypto";
import {
  assertCredentialFree,
  findCredentialMaterial,
  tenantKey,
  type TenantRef,
} from "../../packages/core/src/index";

/** Provider-neutral Winner Loop lifecycle exercised only by labelled fixtures. */

export const WINNER_PROVIDER_ADAPTER_IDS = [
  "fixture_local_renderer",
  "fixture_organic_content",
  "fixture_tiktok_spark",
  "fixture_aggregated_attribution",
  "fixture_revenuecat",
] as const;
export type WinnerProviderAdapterId = (typeof WINNER_PROVIDER_ADAPTER_IDS)[number];

export const WINNER_PROVIDER_FEATURES = [
  "creative_render",
  "organic_create_draft",
  "organic_publish_direct",
  "paid_promote_existing_post_contract",
  "attribution_read_aggregates",
  "subscription_read_lifecycle",
] as const;
export type WinnerProviderFeature = (typeof WINNER_PROVIDER_FEATURES)[number];

export type WinnerProviderCategory =
  | "creative_generation"
  | "organic_publication"
  | "paid_acquisition"
  | "attribution"
  | "subscription_lifecycle";

export type WinnerProviderReviewKey = "organic.direct_publish" | "paid.spark_contract";
export type WinnerProviderPotentialEffect =
  "local_write" | "external_read" | "external_draft" | "public_communication" | "financial";

export type FixtureJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly FixtureJsonValue[]
  | { readonly [key: string]: FixtureJsonValue };
export type FixtureJsonObject = Readonly<Record<string, FixtureJsonValue>>;

export interface WinnerProviderFeatureDeclaration {
  readonly feature: WinnerProviderFeature;
  readonly credentialRequired: boolean;
  readonly reviewRequired: WinnerProviderReviewKey | null;
  readonly potentialExternalEffect: WinnerProviderPotentialEffect;
  readonly notes: string;
}

export interface WinnerProviderDescriptor {
  readonly id: WinnerProviderAdapterId;
  readonly displayName: string;
  readonly category: WinnerProviderCategory;
  readonly fixtureOnly: true;
  readonly defaultFeature: WinnerProviderFeature;
  readonly publicationDefault: "review_before_publish" | "not_applicable";
  readonly features: readonly WinnerProviderFeatureDeclaration[];
  readonly limitations: readonly string[];
}

export interface WinnerProviderFixtureContext {
  /** Must be true for fixture apply. It never authorizes a real provider call. */
  readonly fixtureExecution: boolean;
  /** References only; secret values are invalid here. */
  readonly credentialRefs?: Partial<Record<WinnerProviderAdapterId, string>>;
  readonly reviewApprovals?: readonly WinnerProviderReviewKey[];
  readonly featureOverrides?: Partial<
    Record<WinnerProviderFeature, "available" | "unavailable" | "unknown">
  >;
  readonly now?: () => Date;
}

export type WinnerProviderFeatureState =
  "available" | "auth_required" | "review_required" | "unavailable" | "unknown";

export interface WinnerProviderFeatureAvailability {
  readonly feature: WinnerProviderFeature;
  readonly state: WinnerProviderFeatureState;
  readonly missingRequirements: readonly string[];
  readonly potentialExternalEffect: WinnerProviderPotentialEffect;
  readonly detectedAt: string;
  readonly fixtureOnly: true;
}

export interface WinnerProviderDoctorIssue {
  readonly code:
    "auth_missing" | "auth_invalid" | "review_required" | "feature_unavailable" | "feature_unknown";
  readonly feature: WinnerProviderFeature;
  readonly message: string;
  readonly remediation: string;
}

export interface WinnerProviderDoctorResult {
  readonly adapterId: WinnerProviderAdapterId;
  readonly status: "ready" | "auth_required" | "review_required" | "degraded" | "unavailable";
  readonly features: readonly WinnerProviderFeatureAvailability[];
  readonly issues: readonly WinnerProviderDoctorIssue[];
  readonly fixtureOnly: true;
}

export interface WinnerProviderPlanRequest {
  readonly tenant: TenantRef;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly feature?: WinnerProviderFeature;
  readonly payload: FixtureJsonObject;
}

export interface WinnerProviderPlan {
  readonly adapterId: WinnerProviderAdapterId;
  readonly tenant: TenantRef;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly feature: WinnerProviderFeature;
  readonly requestHash: string;
  readonly payload: FixtureJsonObject;
  readonly state: "ready" | "blocked";
  readonly blockers: readonly string[];
  readonly credentialRef: string | null;
  readonly potentialExternalEffect: WinnerProviderPotentialEffect;
  readonly effectClass: "local_fixture_write";
  readonly fixtureOnly: true;
  readonly externalExecutionAllowed: false;
  readonly publicationAllowed: false;
  readonly spendAllowed: false;
  readonly maxSpendMinor: 0;
  readonly publicationPolicy: "review_before_publish" | "not_applicable";
  readonly createdAt: string;
}

export interface WinnerProviderExecutionResult {
  readonly adapterId: WinnerProviderAdapterId;
  readonly operationId: string;
  readonly state: "planned" | "succeeded" | "blocked" | "failed" | "conflict";
  readonly reused: boolean;
  readonly providerInvoked: false;
  readonly externalEffectOccurred: false;
  readonly message: string;
  readonly output: FixtureJsonObject | null;
}

export interface WinnerProviderReadBackResult {
  readonly adapterId: WinnerProviderAdapterId;
  readonly operationId: string;
  readonly state: "matched" | "missing" | "conflict";
  readonly providerInvoked: false;
  readonly evidence: FixtureJsonObject | null;
  readonly message: string;
}

export interface WinnerProviderVerificationResult {
  readonly adapterId: WinnerProviderAdapterId;
  readonly operationId: string;
  readonly state: "verified_fixture" | "pending" | "failed";
  readonly liveVerified: false;
  readonly evidence: FixtureJsonObject | null;
  readonly message: string;
}

export interface WinnerProviderReconciliationResult {
  readonly adapterId: WinnerProviderAdapterId;
  readonly operationId: string;
  readonly state: "matched" | "missing" | "conflict";
  readonly providerInvoked: false;
  readonly reapplied: false;
  readonly message: string;
}

export interface WinnerProviderFixtureRecord {
  readonly adapterId: WinnerProviderAdapterId;
  readonly tenant: TenantRef;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly feature: WinnerProviderFeature;
  readonly output: FixtureJsonObject;
  readonly appliedAt: string;
  readonly fixtureLabel: "SYNTHETIC_FIXTURE — no provider was contacted";
}

export interface WinnerProviderFixtureStore {
  get(
    tenant: TenantRef,
    adapterId: WinnerProviderAdapterId,
    idempotencyKey: string,
  ): WinnerProviderFixtureRecord | undefined;
  put(record: WinnerProviderFixtureRecord): void;
  size(): number;
}

export function createMemoryWinnerProviderFixtureStore(): WinnerProviderFixtureStore {
  const records = new Map<string, WinnerProviderFixtureRecord>();
  const keyOf = (tenant: TenantRef, adapterId: WinnerProviderAdapterId, idempotencyKey: string) => {
    assertFixtureTenant(tenant);
    return JSON.stringify([tenant.organizationId, tenant.ventureId, adapterId, idempotencyKey]);
  };
  return Object.freeze({
    get(tenant: TenantRef, adapterId: WinnerProviderAdapterId, idempotencyKey: string) {
      const record = records.get(keyOf(tenant, adapterId, idempotencyKey));
      if (record) assertSafeWinnerProviderFixtureRecord(record);
      return record;
    },
    put(record: WinnerProviderFixtureRecord): void {
      assertSafeWinnerProviderFixtureRecord(record);
      const key = keyOf(record.tenant, record.adapterId, record.idempotencyKey);
      const current = records.get(key);
      if (current && current.requestHash !== record.requestHash) {
        throw new Error("fixture provider idempotency key is bound to different input");
      }
      if (!current)
        records.set(key, Object.freeze({ ...record, tenant: Object.freeze({ ...record.tenant }) }));
    },
    size: () => records.size,
  });
}

export interface WinnerProviderAdapter {
  readonly descriptor: WinnerProviderDescriptor;
  featureAvailability(
    context: WinnerProviderFixtureContext,
  ): readonly WinnerProviderFeatureAvailability[];
  doctor(
    context: WinnerProviderFixtureContext,
    requestedFeatures?: readonly WinnerProviderFeature[],
  ): Promise<WinnerProviderDoctorResult>;
  plan(
    request: WinnerProviderPlanRequest,
    context: WinnerProviderFixtureContext,
  ): WinnerProviderPlan;
  dryRun(plan: WinnerProviderPlan): Promise<WinnerProviderExecutionResult>;
  apply(
    plan: WinnerProviderPlan,
    context: WinnerProviderFixtureContext,
  ): Promise<WinnerProviderExecutionResult>;
  readBack(plan: WinnerProviderPlan): Promise<WinnerProviderReadBackResult>;
  verify(plan: WinnerProviderPlan): Promise<WinnerProviderVerificationResult>;
  reconcile(plan: WinnerProviderPlan): Promise<WinnerProviderReconciliationResult>;
  redact(value: unknown): unknown;
}

export class WinnerProviderContractError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unsupported_feature"
      | "unsafe_fixture_payload"
      | "plan_adapter_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "WinnerProviderContractError";
  }
}

const SAFE_OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const SAFE_FIXTURE_REFERENCE = /^fixture:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const PAYLOAD_FIELDS = Object.freeze({
  creative_render: ["creative_id", "render_profile", "creative_family_id", "hypothesis_id"],
  organic_create_draft: [
    "creative_id",
    "caption_class",
    "delivery_variant_id",
    "reviewed",
    "draft_id",
  ],
  organic_publish_direct: [
    "creative_id",
    "caption_class",
    "delivery_variant_id",
    "reviewed",
    "draft_id",
  ],
  paid_promote_existing_post_contract: [
    "source_post_ref",
    "creative_id",
    "delivery_variant_id",
    "grant_id",
    "requested_spend_minor",
  ],
  attribution_read_aggregates: ["aggregate_rows", "reporting_window", "creative_id", "campaign_id"],
  subscription_read_lifecycle: ["lifecycle_event_count", "environment", "project_id"],
} satisfies Readonly<Record<WinnerProviderFeature, readonly string[]>>);

const OUTPUT_FIELDS = Object.freeze({
  creative_render: [
    "fixture_only",
    "creative_id",
    "render_job_id",
    "renderer_kind",
    "asset_ref",
    "content_hash",
  ],
  organic_create_draft: [
    "fixture_only",
    "creative_id",
    "publication_id",
    "publication_mode",
    "review_before_publish",
    "reviewed",
    "publicly_visible",
  ],
  organic_publish_direct: [
    "fixture_only",
    "creative_id",
    "publication_id",
    "publication_mode",
    "review_before_publish",
    "reviewed",
    "publicly_visible",
  ],
  paid_promote_existing_post_contract: [
    "fixture_only",
    "contract_id",
    "source_post_ref",
    "fixture_reported_spend_minor",
    "spend_allowed",
    "external_spend_minor",
    "campaign_created",
  ],
  attribution_read_aggregates: [
    "fixture_only",
    "dataset_id",
    "attribution_class",
    "aggregate_rows",
    "person_level_rows",
    "deterministic_claim_allowed",
  ],
  subscription_read_lifecycle: [
    "fixture_only",
    "dataset_id",
    "lifecycle_event_count",
    "environment",
    "attribution_engine",
    "subscriber_payload_persisted",
  ],
} satisfies Readonly<Record<WinnerProviderFeature, readonly string[]>>);

function stableValue(value: FixtureJsonValue): FixtureJsonValue {
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

function requestHash(input: FixtureJsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(input)))
    .digest("hex");
}

function assertFixtureTenant(tenant: TenantRef): void {
  try {
    tenantKey(tenant);
  } catch {
    throw new WinnerProviderContractError(
      "invalid_request",
      "fixture provider requires a canonical scoped tenant",
    );
  }
  if (tenant.organizationId === "__legacy_unscoped__") {
    throw new WinnerProviderContractError(
      "invalid_request",
      "fixture provider requires a canonical scoped tenant",
    );
  }
}

function unsafeFixturePayload(message: string): never {
  throw new WinnerProviderContractError("unsafe_fixture_payload", message);
}

function assertSharedCredentialFree(value: unknown, label: string): void {
  try {
    assertCredentialFree(value, label);
  } catch {
    unsafeFixturePayload(`Credential or non-JSON material is forbidden in ${label}`);
  }
}

function exactFields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    unsafeFixturePayload(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    unsafeFixturePayload(`${label} contains unsupported fields`);
  }
}

function optionalOpaqueString(record: Record<string, unknown>, field: string, label: string): void {
  const value = record[field];
  if (value !== undefined && (typeof value !== "string" || !SAFE_OPAQUE_REFERENCE.test(value))) {
    unsafeFixturePayload(`${label}.${field} must be a safe opaque reference`);
  }
}

function requiredOpaqueString(record: Record<string, unknown>, field: string, label: string): void {
  optionalOpaqueString(record, field, label);
  if (typeof record[field] !== "string") {
    unsafeFixturePayload(`${label}.${field} is required`);
  }
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  const value = record[field];
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    unsafeFixturePayload(`${label}.${field} must be a non-negative safe integer`);
  }
}

function requiredNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
  label: string,
): void {
  optionalNonNegativeInteger(record, field, label);
  if (typeof record[field] !== "number") {
    unsafeFixturePayload(`${label}.${field} is required`);
  }
}

function requiredBoolean(
  record: Record<string, unknown>,
  field: string,
  expected: boolean,
  label: string,
): void {
  if (record[field] !== expected) {
    unsafeFixturePayload(`${label}.${field} must be ${String(expected)}`);
  }
}

export function assertSafeWinnerProviderPayload(
  feature: WinnerProviderFeature,
  value: unknown,
): asserts value is FixtureJsonObject {
  assertSharedCredentialFree(value, "fixture provider payload");
  exactFields(value, PAYLOAD_FIELDS[feature], "fixture provider payload");
  const stringFields = PAYLOAD_FIELDS[feature].filter(
    (field) =>
      field !== "reviewed" &&
      field !== "requested_spend_minor" &&
      field !== "aggregate_rows" &&
      field !== "lifecycle_event_count",
  );
  for (const field of stringFields) optionalOpaqueString(value, field, "fixture provider payload");
  if ("reviewed" in value && typeof value.reviewed !== "boolean") {
    unsafeFixturePayload("fixture provider payload.reviewed must be a boolean");
  }
  for (const field of ["requested_spend_minor", "aggregate_rows", "lifecycle_event_count"]) {
    optionalNonNegativeInteger(value, field, "fixture provider payload");
  }
  if (
    feature === "paid_promote_existing_post_contract" &&
    typeof value.source_post_ref === "string" &&
    !SAFE_OPAQUE_REFERENCE.test(value.source_post_ref)
  ) {
    unsafeFixturePayload(
      "fixture provider payload.source_post_ref must be a safe opaque reference",
    );
  }
}

export function assertSafeWinnerProviderOutput(
  feature: WinnerProviderFeature,
  value: unknown,
): asserts value is FixtureJsonObject {
  assertSharedCredentialFree(value, "fixture provider output");
  exactFields(value, OUTPUT_FIELDS[feature], "fixture provider output");
  requiredBoolean(value, "fixture_only", true, "fixture provider output");
  switch (feature) {
    case "creative_render":
      for (const field of ["creative_id", "render_job_id", "renderer_kind"]) {
        requiredOpaqueString(value, field, "fixture provider output");
      }
      if (typeof value.asset_ref !== "string" || !SAFE_FIXTURE_REFERENCE.test(value.asset_ref)) {
        unsafeFixturePayload("fixture provider output.asset_ref must be a safe fixture reference");
      }
      if (typeof value.content_hash !== "string" || !SHA256.test(value.content_hash)) {
        unsafeFixturePayload("fixture provider output.content_hash must be a SHA-256 digest");
      }
      break;
    case "organic_create_draft":
    case "organic_publish_direct":
      requiredOpaqueString(value, "creative_id", "fixture provider output");
      requiredOpaqueString(value, "publication_id", "fixture provider output");
      if (value.publication_mode !== "draft" && value.publication_mode !== "direct") {
        unsafeFixturePayload("fixture provider output.publication_mode is invalid");
      }
      requiredBoolean(value, "review_before_publish", true, "fixture provider output");
      if (typeof value.reviewed !== "boolean") {
        unsafeFixturePayload("fixture provider output.reviewed must be a boolean");
      }
      requiredBoolean(value, "publicly_visible", false, "fixture provider output");
      break;
    case "paid_promote_existing_post_contract":
      requiredOpaqueString(value, "contract_id", "fixture provider output");
      requiredOpaqueString(value, "source_post_ref", "fixture provider output");
      requiredNonNegativeInteger(value, "fixture_reported_spend_minor", "fixture provider output");
      requiredBoolean(value, "spend_allowed", false, "fixture provider output");
      if (value.external_spend_minor !== 0) {
        unsafeFixturePayload("fixture provider output.external_spend_minor must be zero");
      }
      requiredBoolean(value, "campaign_created", false, "fixture provider output");
      break;
    case "attribution_read_aggregates":
      requiredOpaqueString(value, "dataset_id", "fixture provider output");
      if (value.attribution_class !== "PRIVACY_AGGREGATED") {
        unsafeFixturePayload("fixture provider output.attribution_class is invalid");
      }
      requiredNonNegativeInteger(value, "aggregate_rows", "fixture provider output");
      if (value.person_level_rows !== 0) {
        unsafeFixturePayload("fixture provider output.person_level_rows must be zero");
      }
      requiredBoolean(value, "deterministic_claim_allowed", false, "fixture provider output");
      break;
    case "subscription_read_lifecycle":
      requiredOpaqueString(value, "dataset_id", "fixture provider output");
      requiredNonNegativeInteger(value, "lifecycle_event_count", "fixture provider output");
      requiredOpaqueString(value, "environment", "fixture provider output");
      requiredBoolean(value, "attribution_engine", false, "fixture provider output");
      requiredBoolean(value, "subscriber_payload_persisted", false, "fixture provider output");
      break;
  }
}

export function assertSafeWinnerProviderFixtureRecord(
  value: unknown,
): asserts value is WinnerProviderFixtureRecord {
  assertSharedCredentialFree(value, "fixture provider record");
  exactFields(
    value,
    [
      "adapterId",
      "tenant",
      "operationId",
      "idempotencyKey",
      "requestHash",
      "feature",
      "output",
      "appliedAt",
      "fixtureLabel",
    ],
    "fixture provider record",
  );
  if (!WINNER_PROVIDER_ADAPTER_IDS.includes(value.adapterId as WinnerProviderAdapterId)) {
    unsafeFixturePayload("fixture provider record.adapterId is invalid");
  }
  if (!WINNER_PROVIDER_FEATURES.includes(value.feature as WinnerProviderFeature)) {
    unsafeFixturePayload("fixture provider record.feature is invalid");
  }
  assertFixtureTenant(value.tenant as TenantRef);
  requiredOpaqueString(value, "operationId", "fixture provider record");
  requiredOpaqueString(value, "idempotencyKey", "fixture provider record");
  if (typeof value.requestHash !== "string" || !SHA256.test(value.requestHash)) {
    unsafeFixturePayload("fixture provider record.requestHash must be a SHA-256 digest");
  }
  if (
    typeof value.appliedAt !== "string" ||
    !Number.isFinite(Date.parse(value.appliedAt)) ||
    new Date(value.appliedAt).toISOString() !== value.appliedAt
  ) {
    unsafeFixturePayload("fixture provider record.appliedAt must be an ISO timestamp");
  }
  if (value.fixtureLabel !== "SYNTHETIC_FIXTURE — no provider was contacted") {
    unsafeFixturePayload("fixture provider record.fixtureLabel is invalid");
  }
  const feature = value.feature as WinnerProviderFeature;
  const adapter = value.adapterId as WinnerProviderAdapterId;
  const supported =
    (adapter === "fixture_local_renderer" && feature === "creative_render") ||
    (adapter === "fixture_organic_content" &&
      (feature === "organic_create_draft" || feature === "organic_publish_direct")) ||
    (adapter === "fixture_tiktok_spark" && feature === "paid_promote_existing_post_contract") ||
    (adapter === "fixture_aggregated_attribution" && feature === "attribution_read_aggregates") ||
    (adapter === "fixture_revenuecat" && feature === "subscription_read_lifecycle");
  if (!supported)
    unsafeFixturePayload("fixture provider record feature/adapter binding is invalid");
  assertSafeWinnerProviderOutput(feature, value.output);
}

function credentialReferenceIsValid(value: string): boolean {
  return (
    findCredentialMaterial(
      { credentialRef: value },
      { allowedCredentialReferenceKeys: ["credentialRef"] },
    ) === null
  );
}

function redactValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (
      (key === "credentialRef" || key === "credential_ref") &&
      credentialReferenceIsValid(value)
    ) {
      return value;
    }
    return findCredentialMaterial(value) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, entry]) => {
        if (
          (childKey === "credentialRef" || childKey === "credential_ref") &&
          typeof entry === "string" &&
          credentialReferenceIsValid(entry)
        ) {
          return [childKey, entry];
        }
        const fieldFinding = findCredentialMaterial({ [childKey]: entry });
        return [
          childKey,
          fieldFinding?.kind === "secret_bearing_field" && fieldFinding.path === `$.${childKey}`
            ? "[REDACTED]"
            : redactValue(entry, childKey),
        ];
      }),
    );
  }
  return value;
}

function stringFrom(payload: FixtureJsonObject, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function integerFrom(payload: FixtureJsonObject, key: string, fallback: number): number {
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

type FixtureOutputBuilder = (plan: WinnerProviderPlan) => FixtureJsonObject;

class FixtureWinnerProviderAdapter implements WinnerProviderAdapter {
  constructor(
    readonly descriptor: WinnerProviderDescriptor,
    private readonly store: WinnerProviderFixtureStore,
    private readonly buildOutput: FixtureOutputBuilder,
  ) {}

  private declaration(feature: WinnerProviderFeature): WinnerProviderFeatureDeclaration {
    const declaration = this.descriptor.features.find((candidate) => candidate.feature === feature);
    if (!declaration) {
      throw new WinnerProviderContractError(
        "unsupported_feature",
        `${this.descriptor.id} does not support ${feature}`,
      );
    }
    return declaration;
  }

  featureAvailability(
    context: WinnerProviderFixtureContext,
  ): readonly WinnerProviderFeatureAvailability[] {
    const detectedAt = (context.now ?? (() => new Date()))().toISOString();
    const credentialRef = context.credentialRefs?.[this.descriptor.id];
    const approvals = new Set(context.reviewApprovals ?? []);
    return Object.freeze(
      this.descriptor.features.map((declaration) => {
        const override = context.featureOverrides?.[declaration.feature];
        if (override === "unavailable" || override === "unknown") {
          return Object.freeze({
            feature: declaration.feature,
            state: override,
            missingRequirements: Object.freeze([
              override === "unknown"
                ? "Account-specific feature availability has not been verified"
                : "Feature is not available for this fixture account",
            ]),
            potentialExternalEffect: declaration.potentialExternalEffect,
            detectedAt,
            fixtureOnly: true as const,
          });
        }
        const missing: string[] = [];
        let invalidCredential = false;
        if (declaration.credentialRequired) {
          if (!credentialRef) missing.push("credential reference");
          else if (!credentialReferenceIsValid(credentialRef)) {
            missing.push("valid cred:// reference");
            invalidCredential = true;
          }
        }
        if (declaration.reviewRequired && !approvals.has(declaration.reviewRequired)) {
          missing.push(`human review ${declaration.reviewRequired}`);
        }
        const state: WinnerProviderFeatureState =
          declaration.credentialRequired && (!credentialRef || invalidCredential)
            ? "auth_required"
            : declaration.reviewRequired && !approvals.has(declaration.reviewRequired)
              ? "review_required"
              : "available";
        return Object.freeze({
          feature: declaration.feature,
          state,
          missingRequirements: Object.freeze(missing),
          potentialExternalEffect: declaration.potentialExternalEffect,
          detectedAt,
          fixtureOnly: true as const,
        });
      }),
    );
  }

  async doctor(
    context: WinnerProviderFixtureContext,
    requestedFeatures: readonly WinnerProviderFeature[] = this.descriptor.features.map(
      ({ feature }) => feature,
    ),
  ): Promise<WinnerProviderDoctorResult> {
    for (const feature of requestedFeatures) this.declaration(feature);
    const availability = this.featureAvailability(context).filter(({ feature }) =>
      requestedFeatures.includes(feature),
    );
    const issues: WinnerProviderDoctorIssue[] = [];
    const credentialRef = context.credentialRefs?.[this.descriptor.id];
    const approvals = new Set(context.reviewApprovals ?? []);
    for (const item of availability) {
      if (item.state === "auth_required") {
        const invalid = credentialRef !== undefined && !credentialReferenceIsValid(credentialRef);
        issues.push({
          code: invalid ? "auth_invalid" : "auth_missing",
          feature: item.feature,
          message: invalid
            ? `${this.descriptor.displayName} received a credential value or malformed reference`
            : `${this.descriptor.displayName} requires a credential reference for ${item.feature}`,
          remediation: "Register provider auth with the broker and pass only its cred:// reference",
        });
      }
      const declaration = this.declaration(item.feature);
      if (declaration.reviewRequired && !approvals.has(declaration.reviewRequired)) {
        issues.push({
          code: "review_required",
          feature: item.feature,
          message: `${item.feature} remains behind explicit human review`,
          remediation: `Record the declared review checkpoint before planning ${item.feature}`,
        });
      }
      if (item.state === "unavailable" || item.state === "unknown") {
        issues.push({
          code: item.state === "unknown" ? "feature_unknown" : "feature_unavailable",
          feature: item.feature,
          message: item.missingRequirements.join("; "),
          remediation:
            "Re-run feature discovery against the authorized account; do not assume support",
        });
      }
    }
    const states = availability.map(({ state }) => state);
    const available = states.filter((state) => state === "available").length;
    let status: WinnerProviderDoctorResult["status"] = "ready";
    if (available > 0 && available < states.length) status = "degraded";
    else if (states.some((state) => state === "auth_required")) status = "auth_required";
    else if (states.some((state) => state === "review_required")) status = "review_required";
    else if (states.some((state) => state === "unknown" || state === "unavailable")) {
      status = "unavailable";
    }
    return Object.freeze({
      adapterId: this.descriptor.id,
      status,
      features: Object.freeze([...availability]),
      issues: Object.freeze(issues),
      fixtureOnly: true,
    });
  }

  plan(
    request: WinnerProviderPlanRequest,
    context: WinnerProviderFixtureContext,
  ): WinnerProviderPlan {
    assertSharedCredentialFree(request, "fixture provider request");
    if (!request.tenant || !request.operationId.trim() || !request.idempotencyKey.trim()) {
      throw new WinnerProviderContractError(
        "invalid_request",
        "tenant, operationId, and idempotencyKey are required",
      );
    }
    assertFixtureTenant(request.tenant);
    const feature = request.feature ?? this.descriptor.defaultFeature;
    const declaration = this.declaration(feature);
    assertSafeWinnerProviderPayload(feature, request.payload);
    const availability = this.featureAvailability(context).find(
      (candidate) => candidate.feature === feature,
    )!;
    const payload = Object.freeze({ ...request.payload });
    const hash = requestHash({
      adapter_id: this.descriptor.id,
      tenant: {
        organization_id: request.tenant.organizationId,
        venture_id: request.tenant.ventureId,
      },
      operation_id: request.operationId,
      feature,
      payload,
    });
    return Object.freeze({
      adapterId: this.descriptor.id,
      tenant: Object.freeze({ ...request.tenant }),
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      feature,
      requestHash: hash,
      payload,
      state: availability.state === "available" ? "ready" : "blocked",
      blockers: Object.freeze([...availability.missingRequirements]),
      credentialRef: context.credentialRefs?.[this.descriptor.id] ?? null,
      potentialExternalEffect: declaration.potentialExternalEffect,
      effectClass: "local_fixture_write",
      fixtureOnly: true,
      externalExecutionAllowed: false,
      publicationAllowed: false,
      spendAllowed: false,
      maxSpendMinor: 0,
      publicationPolicy: this.descriptor.publicationDefault,
      createdAt: (context.now ?? (() => new Date()))().toISOString(),
    });
  }

  async dryRun(plan: WinnerProviderPlan): Promise<WinnerProviderExecutionResult> {
    this.assertPlan(plan);
    return Object.freeze({
      adapterId: this.descriptor.id,
      operationId: plan.operationId,
      state: plan.state === "blocked" ? "blocked" : "planned",
      reused: false,
      providerInvoked: false,
      externalEffectOccurred: false,
      message:
        plan.state === "blocked"
          ? `Fixture dry run is blocked: ${plan.blockers.join("; ")}`
          : "Fixture dry run only: no provider, publication, or spend action occurred",
      output: null,
    });
  }

  async apply(
    plan: WinnerProviderPlan,
    context: WinnerProviderFixtureContext,
  ): Promise<WinnerProviderExecutionResult> {
    this.assertPlan(plan);
    if (!context.fixtureExecution) {
      return this.execution(plan, "failed", false, "fixtureExecution=true is required", null);
    }
    const availability = this.featureAvailability(context).find(
      ({ feature }) => feature === plan.feature,
    );
    if (plan.state === "blocked" || availability?.state !== "available") {
      return this.execution(
        plan,
        "blocked",
        false,
        `Fixture apply blocked: ${availability?.missingRequirements.join("; ") || plan.blockers.join("; ")}`,
        null,
      );
    }
    const existing = this.store.get(plan.tenant, this.descriptor.id, plan.idempotencyKey);
    if (existing) {
      assertSafeWinnerProviderFixtureRecord(existing);
      if (existing.requestHash !== plan.requestHash) {
        return this.execution(
          plan,
          "conflict",
          false,
          "Idempotency key is already bound to different fixture input",
          null,
        );
      }
      return this.execution(
        plan,
        "succeeded",
        true,
        "Reused the verified fixture result; no provider was invoked",
        existing.output,
      );
    }
    const output = Object.freeze({ ...this.buildOutput(plan) });
    assertSafeWinnerProviderOutput(plan.feature, output);
    this.store.put(
      Object.freeze({
        adapterId: this.descriptor.id,
        tenant: plan.tenant,
        operationId: plan.operationId,
        idempotencyKey: plan.idempotencyKey,
        requestHash: plan.requestHash,
        feature: plan.feature,
        output,
        appliedAt: (context.now ?? (() => new Date()))().toISOString(),
        fixtureLabel: "SYNTHETIC_FIXTURE — no provider was contacted",
      }),
    );
    return this.execution(
      plan,
      "succeeded",
      false,
      "Applied synthetic fixture state only; no provider, publication, or spend action occurred",
      output,
    );
  }

  async readBack(plan: WinnerProviderPlan): Promise<WinnerProviderReadBackResult> {
    this.assertPlan(plan);
    const record = this.store.get(plan.tenant, this.descriptor.id, plan.idempotencyKey);
    if (!record) {
      return Object.freeze({
        adapterId: this.descriptor.id,
        operationId: plan.operationId,
        state: "missing",
        providerInvoked: false,
        evidence: null,
        message: "No fixture state exists; live provider state was not queried",
      });
    }
    assertSafeWinnerProviderFixtureRecord(record);
    if (record.requestHash !== plan.requestHash) {
      return Object.freeze({
        adapterId: this.descriptor.id,
        operationId: plan.operationId,
        state: "conflict",
        providerInvoked: false,
        evidence: null,
        message: "Fixture state belongs to a different request hash",
      });
    }
    return Object.freeze({
      adapterId: this.descriptor.id,
      operationId: plan.operationId,
      state: "matched",
      providerInvoked: false,
      evidence: record.output,
      message: "Read back matching synthetic fixture state; live verification remains pending",
    });
  }

  async verify(plan: WinnerProviderPlan): Promise<WinnerProviderVerificationResult> {
    const readBack = await this.readBack(plan);
    const invariant =
      readBack.state === "matched" && readBack.evidence
        ? this.outputInvariant(plan, readBack.evidence)
        : false;
    return Object.freeze({
      adapterId: this.descriptor.id,
      operationId: plan.operationId,
      state: invariant ? "verified_fixture" : readBack.state === "missing" ? "pending" : "failed",
      liveVerified: false,
      evidence: invariant ? readBack.evidence : null,
      message: invariant
        ? "Fixture read-back matched contract invariants; this is not live provider verification"
        : readBack.message,
    });
  }

  async reconcile(plan: WinnerProviderPlan): Promise<WinnerProviderReconciliationResult> {
    const readBack = await this.readBack(plan);
    return Object.freeze({
      adapterId: this.descriptor.id,
      operationId: plan.operationId,
      state: readBack.state,
      providerInvoked: false,
      reapplied: false,
      message:
        readBack.state === "matched"
          ? "Fixture state reconciled by read-back without replaying apply"
          : `${readBack.message}; apply was not replayed`,
    });
  }

  redact(value: unknown): unknown {
    return redactValue(value);
  }

  private outputInvariant(plan: WinnerProviderPlan, output: FixtureJsonObject): boolean {
    if (this.descriptor.id === "fixture_tiktok_spark") {
      return (
        output.spend_allowed === false &&
        output.external_spend_minor === 0 &&
        output.campaign_created === false
      );
    }
    if (this.descriptor.id === "fixture_revenuecat") {
      return output.attribution_engine === false && output.fixture_only === true;
    }
    if (this.descriptor.id === "fixture_aggregated_attribution") {
      return output.attribution_class === "PRIVACY_AGGREGATED" && output.fixture_only === true;
    }
    if (this.descriptor.id === "fixture_organic_content") {
      return (
        output.review_before_publish === true &&
        output.fixture_only === true &&
        (plan.feature !== "organic_publish_direct" || output.reviewed === true)
      );
    }
    return output.fixture_only === true;
  }

  private execution(
    plan: WinnerProviderPlan,
    state: WinnerProviderExecutionResult["state"],
    reused: boolean,
    message: string,
    output: FixtureJsonObject | null,
  ): WinnerProviderExecutionResult {
    return Object.freeze({
      adapterId: this.descriptor.id,
      operationId: plan.operationId,
      state,
      reused,
      providerInvoked: false,
      externalEffectOccurred: false,
      message,
      output,
    });
  }

  private assertPlan(plan: WinnerProviderPlan): void {
    if (plan.adapterId !== this.descriptor.id || plan.fixtureOnly !== true) {
      throw new WinnerProviderContractError(
        "plan_adapter_mismatch",
        `Plan for ${plan.adapterId} cannot run through ${this.descriptor.id}`,
      );
    }
    assertFixtureTenant(plan.tenant);
    if (
      plan.externalExecutionAllowed !== false ||
      plan.publicationAllowed !== false ||
      plan.spendAllowed !== false ||
      plan.maxSpendMinor !== 0
    ) {
      throw new WinnerProviderContractError(
        "plan_adapter_mismatch",
        "Fixture plans may not authorize external execution, publication, or spend",
      );
    }
    this.declaration(plan.feature);
    assertSafeWinnerProviderPayload(plan.feature, plan.payload);
    const expectedHash = requestHash({
      adapter_id: plan.adapterId,
      tenant: {
        organization_id: plan.tenant.organizationId,
        venture_id: plan.tenant.ventureId,
      },
      operation_id: plan.operationId,
      feature: plan.feature,
      payload: plan.payload,
    });
    if (plan.requestHash !== expectedHash) {
      throw new WinnerProviderContractError(
        "plan_adapter_mismatch",
        "Fixture plan request hash does not match its immutable operation content",
      );
    }
  }
}

const descriptor = (
  input: Omit<WinnerProviderDescriptor, "fixtureOnly" | "features" | "limitations"> & {
    features: readonly WinnerProviderFeatureDeclaration[];
    limitations: readonly string[];
  },
): WinnerProviderDescriptor =>
  Object.freeze({
    ...input,
    fixtureOnly: true,
    features: Object.freeze(input.features.map((feature) => Object.freeze({ ...feature }))),
    limitations: Object.freeze([...input.limitations]),
  });

export const WINNER_PROVIDER_DESCRIPTORS: Readonly<
  Record<WinnerProviderAdapterId, WinnerProviderDescriptor>
> = Object.freeze({
  fixture_local_renderer: descriptor({
    id: "fixture_local_renderer",
    displayName: "Local creative renderer fixture",
    category: "creative_generation",
    defaultFeature: "creative_render",
    publicationDefault: "not_applicable",
    features: [
      {
        feature: "creative_render",
        credentialRequired: false,
        reviewRequired: null,
        potentialExternalEffect: "local_write",
        notes:
          "Creates deterministic fixture metadata; no private media bytes enter the adapter state.",
      },
    ],
    limitations: [
      "Fixture metadata only; it does not prove a hosted creative-generation provider.",
    ],
  }),
  fixture_organic_content: descriptor({
    id: "fixture_organic_content",
    displayName: "Organic content fixture",
    category: "organic_publication",
    defaultFeature: "organic_create_draft",
    publicationDefault: "review_before_publish",
    features: [
      {
        feature: "organic_create_draft",
        credentialRequired: true,
        reviewRequired: null,
        potentialExternalEffect: "external_draft",
        notes: "Draft is the safe default and remains fixture-local in this adapter.",
      },
      {
        feature: "organic_publish_direct",
        credentialRequired: true,
        reviewRequired: "organic.direct_publish",
        potentialExternalEffect: "public_communication",
        notes: "Direct publication is feature-detected and requires explicit human review.",
      },
    ],
    limitations: [
      "No content platform is contacted.",
      "Account review, audit status, and direct-post availability require live read-back later.",
    ],
  }),
  fixture_tiktok_spark: descriptor({
    id: "fixture_tiktok_spark",
    displayName: "TikTok Spark contract fixture",
    category: "paid_acquisition",
    defaultFeature: "paid_promote_existing_post_contract",
    publicationDefault: "not_applicable",
    features: [
      {
        feature: "paid_promote_existing_post_contract",
        credentialRequired: true,
        reviewRequired: "paid.spark_contract",
        potentialExternalEffect: "financial",
        notes: "Models authorization linkage only; campaign creation and all spend are forbidden.",
      },
    ],
    limitations: [
      "No ad account eligibility is claimed.",
      "No campaign, ad group, ad, payment change, or spend can be created by this fixture.",
    ],
  }),
  fixture_aggregated_attribution: descriptor({
    id: "fixture_aggregated_attribution",
    displayName: "Aggregated attribution fixture",
    category: "attribution",
    defaultFeature: "attribution_read_aggregates",
    publicationDefault: "not_applicable",
    features: [
      {
        feature: "attribution_read_aggregates",
        credentialRequired: true,
        reviewRequired: null,
        potentialExternalEffect: "external_read",
        notes:
          "Returns aggregate, privacy-limited fixture rows without device or subscriber identity.",
      },
    ],
    limitations: ["Privacy-aggregated evidence is not deterministic person-level attribution."],
  }),
  fixture_revenuecat: descriptor({
    id: "fixture_revenuecat",
    displayName: "RevenueCat lifecycle fixture",
    category: "subscription_lifecycle",
    defaultFeature: "subscription_read_lifecycle",
    publicationDefault: "not_applicable",
    features: [
      {
        feature: "subscription_read_lifecycle",
        credentialRequired: true,
        reviewRequired: null,
        potentialExternalEffect: "external_read",
        notes: "Returns normalized subscription lifecycle aggregates only.",
      },
    ],
    limitations: [
      "RevenueCat lifecycle evidence is not an attribution engine.",
      "Project, environment, webhook signature, and account access require live verification later.",
    ],
  }),
});

function builderFor(id: WinnerProviderAdapterId): FixtureOutputBuilder {
  switch (id) {
    case "fixture_local_renderer":
      return (plan) => ({
        fixture_only: true,
        creative_id: stringFrom(plan.payload, "creative_id", "fixture-creative"),
        render_job_id: `fixture-render-${plan.requestHash.slice(0, 12)}`,
        renderer_kind: "local_fixture",
        asset_ref: `fixture://creative/${plan.requestHash.slice(0, 16)}`,
        content_hash: plan.requestHash,
      });
    case "fixture_organic_content":
      return (plan) => ({
        fixture_only: true,
        creative_id: stringFrom(plan.payload, "creative_id", "fixture-creative"),
        publication_id: `fixture-publication-${plan.requestHash.slice(0, 12)}`,
        publication_mode: plan.feature === "organic_publish_direct" ? "direct" : "draft",
        review_before_publish: true,
        reviewed: plan.feature === "organic_publish_direct",
        publicly_visible: false,
      });
    case "fixture_tiktok_spark":
      return (plan) => ({
        fixture_only: true,
        contract_id: `fixture-spark-${plan.requestHash.slice(0, 12)}`,
        source_post_ref: stringFrom(plan.payload, "source_post_ref", "fixture-post"),
        fixture_reported_spend_minor: integerFrom(plan.payload, "requested_spend_minor", 0),
        spend_allowed: false,
        external_spend_minor: 0,
        campaign_created: false,
      });
    case "fixture_aggregated_attribution":
      return (plan) => ({
        fixture_only: true,
        dataset_id: `fixture-attribution-${plan.requestHash.slice(0, 12)}`,
        attribution_class: "PRIVACY_AGGREGATED",
        aggregate_rows: integerFrom(plan.payload, "aggregate_rows", 1),
        person_level_rows: 0,
        deterministic_claim_allowed: false,
      });
    case "fixture_revenuecat":
      return (plan) => ({
        fixture_only: true,
        dataset_id: `fixture-subscriptions-${plan.requestHash.slice(0, 12)}`,
        lifecycle_event_count: integerFrom(plan.payload, "lifecycle_event_count", 0),
        environment: stringFrom(plan.payload, "environment", "sandbox"),
        attribution_engine: false,
        subscriber_payload_persisted: false,
      });
  }
}

export function createWinnerProviderFixtureAdapters(
  options: {
    store?: WinnerProviderFixtureStore;
  } = {},
): Readonly<Record<WinnerProviderAdapterId, WinnerProviderAdapter>> {
  const store = options.store ?? createMemoryWinnerProviderFixtureStore();
  const create = (id: WinnerProviderAdapterId): WinnerProviderAdapter =>
    new FixtureWinnerProviderAdapter(WINNER_PROVIDER_DESCRIPTORS[id], store, builderFor(id));
  return Object.freeze({
    fixture_local_renderer: create("fixture_local_renderer"),
    fixture_organic_content: create("fixture_organic_content"),
    fixture_tiktok_spark: create("fixture_tiktok_spark"),
    fixture_aggregated_attribution: create("fixture_aggregated_attribution"),
    fixture_revenuecat: create("fixture_revenuecat"),
  });
}
