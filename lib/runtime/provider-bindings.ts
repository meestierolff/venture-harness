import { createHash } from "node:crypto";
import {
  AuthorizationError,
  assertOperationAuthorized,
  inspectOperationAuthorization,
} from "../authorization";
import { looksLikeCredentialValue } from "../config/contracts";
import type { AuthorizationEnvelope, PoliciesConfig } from "../config/policy-schema";
import { Redactor, type CommandRunner, type CredentialBroker } from "../credentials";
import {
  CommandProviderTransport,
  getProviderAdapter,
  HttpProviderTransport,
  ManualProviderTransport,
  transportMap,
  type HttpFetcher,
  type IdempotencyLedger,
  type JwtSigner,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderExecutionReport,
  type ProviderId,
  type ProviderPlan,
  type ProviderPlanRequest,
  type ProviderTransport,
  type ProviderTransportKind,
  type ProviderTransportResult,
  type ProviderVerificationReport,
  collectProviderPublicOutputs,
  type ProviderPublicOutputs,
} from "../providers";
import {
  WorkflowExecutionError,
  sanitizeJson,
  type JsonValue,
  type WorkflowBindings,
  type WorkflowHandlerContext,
  type WorkflowHandlerResult,
  type WorkflowReconciliationContext,
  type WorkflowReconciliationResult,
} from "../workflow";
import type {
  ProviderLifecycleStore,
  ProviderResourceReference,
  ProviderResourceType,
  VerifiedProviderLifecycleRecord,
} from "./provider-lifecycle-store";

export type ProviderRuntimeContext = Omit<ProviderExecutionContext, "authorization" | "signal">;

export interface ProviderWorkflowPlanRequest {
  provider: ProviderId;
  request: ProviderPlanRequest;
  adapter?: ProviderAdapter;
  context?: Partial<ProviderRuntimeContext>;
  /**
   * Immutable upper bound supplied by a trusted launch compiler. A missing
   * estimate may become zero only through an exact provider/capability/action
   * classification; ongoing account-plan usage is explicitly outside it.
   */
  operationBudget?: {
    maxOperations: number;
    missingCostClassification?: {
      basis: "reviewed_known_zero_direct_charge";
      currency: string;
      ongoingAccountPlanUsageCovered: false;
      allowedOperations: readonly {
        provider: ProviderId;
        capability: string;
        action: string;
      }[];
    };
  };
}

export type ProviderWorkflowPlanFactory = (
  context: WorkflowHandlerContext,
) => ProviderWorkflowPlanRequest | Promise<ProviderWorkflowPlanRequest>;

/**
 * A factory may expose an operator-safe prerequisite message. Other factory
 * exceptions stay opaque because they can contain transport or credential data.
 */
export class ProviderPlanFactoryPrerequisiteError extends Error {
  readonly code = "provider_factory_prerequisite";

  constructor(
    message: string,
    readonly waitKind?: "auth" | "external",
  ) {
    super(message);
    this.name = "ProviderPlanFactoryPrerequisiteError";
  }
}

export type ProviderAuthorizationResolver = (
  context: WorkflowHandlerContext,
  plan: ProviderWorkflowPlanRequest,
) => AuthorizationEnvelope | Promise<AuthorizationEnvelope>;

export type ProviderRuntimeContextResolver = (
  context: WorkflowHandlerContext,
  plan: ProviderWorkflowPlanRequest,
) => ProviderRuntimeContext | Promise<ProviderRuntimeContext>;

export interface VerifiedProviderEvidence {
  provider: ProviderId;
  planId: string;
  state: "verified";
  environments: string[];
  capabilities: string[];
  operations: {
    id: string;
    action: string;
    capability: string;
    environment: string;
    status: "matched";
  }[];
  resourceRefs: string[];
  publicOutputs: ProviderPublicOutputs;
  checks: JsonValue;
}

export interface ProviderEvidenceRecorderInput {
  evidence: VerifiedProviderEvidence;
  workflow: WorkflowHandlerContext;
}

export interface ProviderWorkflowBindingsOptions {
  planFactories: Readonly<Record<string, ProviderWorkflowPlanFactory>>;
  policies: PoliciesConfig;
  authorization: AuthorizationEnvelope | ProviderAuthorizationResolver;
  context: ProviderRuntimeContext | ProviderRuntimeContextResolver;
  resolveAdapter?: (provider: ProviderId) => ProviderAdapter;
  now?: () => Date;
  recordEvidence?: (input: ProviderEvidenceRecorderInput) => string | Promise<string>;
  lifecycleStore?: ProviderLifecycleStore;
}

export interface OfficialProviderTransportsOptions {
  commandRunner?: CommandRunner;
  commandAvailable?: () => Promise<{ available: boolean; detail?: string }>;
  httpFetcher?: HttpFetcher;
  httpAvailable?: () => Promise<{ available: boolean; detail?: string }>;
  jwtSigner?: JwtSigner;
  manualTransport?: ProviderTransport;
  additional?: readonly ProviderTransport[];
}

export interface OfficialProviderContextOptions extends OfficialProviderTransportsOptions {
  credentials?: CredentialBroker;
  redactor?: Redactor;
  idempotencyLedger?: IdempotencyLedger;
}

export function createOfficialProviderTransports(
  options: OfficialProviderTransportsOptions,
): Partial<Record<ProviderTransportKind, ProviderTransport>> {
  const transports: ProviderTransport[] = [
    options.manualTransport ?? new ManualProviderTransport(),
    ...(options.additional ?? []),
  ];
  if (options.commandRunner) {
    transports.push(
      new CommandProviderTransport({
        runner: options.commandRunner,
        available: options.commandAvailable,
      }),
    );
  }
  if (options.httpFetcher) {
    transports.push(
      new HttpProviderTransport(options.httpFetcher, options.httpAvailable, options.jwtSigner),
    );
  }
  return transportMap(...transports);
}

export function createOfficialProviderContext(
  options: OfficialProviderContextOptions,
): ProviderRuntimeContext {
  return {
    credentials: options.credentials,
    redactor: options.redactor ?? options.credentials?.redactor ?? new Redactor(),
    idempotencyLedger: options.idempotencyLedger,
    transports: createOfficialProviderTransports(options),
  };
}

function mergeContext(
  base: ProviderRuntimeContext,
  override: Partial<ProviderRuntimeContext> | undefined,
): ProviderRuntimeContext {
  return {
    ...base,
    ...override,
    transports: { ...base.transports, ...override?.transports },
    redactor: override?.redactor ?? base.redactor,
  };
}

const SAFE_PROVIDER_FAILURE_CODES = new Set([
  "retryable_rate_limit",
  "retryable_network",
  "retryable_outage",
  "terminal_auth",
  "terminal_validation",
  "terminal_conflict",
  "terminal_unknown",
  "transport_exception",
  "shell_binary_forbidden",
  "jwt_signer_missing",
  "jwt_signing_failed",
  "timeout",
]);

function safeFailureCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return SAFE_PROVIDER_FAILURE_CODES.has(code) || /^exit_\d{1,3}$/.test(code) ? code : undefined;
}

function mappedRetryCode(result: ProviderTransportResult): string {
  switch (result.providerCode) {
    case "retryable_rate_limit":
      return "rate_limited";
    case "retryable_network":
    case "retryable_outage":
      return "provider_unavailable";
    default:
      return safeFailureCode(result.providerCode) ?? "provider_failed";
  }
}

function minimalFailureDetails(
  provider: ProviderId,
  results: readonly ProviderTransportResult[],
): JsonValue {
  return {
    provider,
    outcomes: results.map((result) => ({
      status: result.status,
      statusCode: result.statusCode ?? null,
      providerCode: safeFailureCode(result.providerCode) ?? null,
      retryable: result.retryable === true,
      effectOutcome: result.effectOutcome ?? "unknown",
    })),
  };
}

function executionFailure(
  provider: ProviderId,
  results: readonly ProviderTransportResult[],
): WorkflowExecutionError {
  if (results.some(({ status }) => status === "waiting_manual")) {
    return new WorkflowExecutionError(
      "provider_manual_action_required",
      `${provider} requires a declared manual action and cannot be marked successful`,
      { details: minimalFailureDetails(provider, results) },
    );
  }
  const failed = results.filter(({ status }) => status === "failed");
  const retryable = failed.find((result) => result.retryable === true);
  if (retryable) {
    return new WorkflowExecutionError(
      mappedRetryCode(retryable),
      `${provider} apply failed with a retryable provider error`,
      { retryable: true, details: minimalFailureDetails(provider, results) },
    );
  }
  return new WorkflowExecutionError(
    "provider_failed",
    `${provider} apply did not complete every operation`,
    { details: minimalFailureDetails(provider, results) },
  );
}

function verificationFailure(
  provider: ProviderId,
  verification: ProviderVerificationReport,
): WorkflowExecutionError {
  const statuses = verification.checks.map(({ status }) => status);
  if (verification.state === "pending" || statuses.includes("manual_required")) {
    return new WorkflowExecutionError(
      "provider_manual_action_required",
      `${provider} verification is pending a declared manual action`,
      { details: { provider, verification: verification.state, statuses } },
    );
  }
  if (verification.state === "unavailable" || statuses.includes("unavailable")) {
    return new WorkflowExecutionError(
      "provider_pending",
      `${provider} apply is awaiting read-back proof`,
      {
        retryable: false,
        details: { provider, verification: verification.state, statuses },
      },
    );
  }
  return new WorkflowExecutionError(
    "provider_verification_failed",
    `${provider} read-back did not match the requested state`,
    { details: { provider, verification: verification.state, statuses } },
  );
}

async function resolveValue<T, A extends unknown[]>(
  value: T | ((...args: A) => T | Promise<T>),
  ...args: A
): Promise<T> {
  return typeof value === "function" ? (value as (...inner: A) => T | Promise<T>)(...args) : value;
}

async function promoteVerifiedOperations(
  ledger: IdempotencyLedger,
  operations: readonly {
    operation: { idempotencyKey: string };
    result: ProviderTransportResult;
  }[],
): Promise<void> {
  await Promise.all(
    operations
      .filter(({ result }) => result.status === "succeeded")
      .map(({ operation, result }) =>
        ledger.put(operation.idempotencyKey, {
          status: "succeeded",
          statusCode: result.statusCode,
          providerCode: result.providerCode,
          message: "Provider state was verified by read-back",
          retryable: false,
          verified: true,
        }),
      ),
  );
}

const SAFE_RESOURCE_KEYS: Readonly<Record<string, ProviderResourceType>> = {
  accountId: "account_id",
  account_id: "account_id",
  amountMinor: "amount_minor",
  amount_minor: "amount_minor",
  unitAmount: "amount_minor",
  unit_amount: "amount_minor",
  appId: "app_id",
  app_id: "app_id",
  appStoreAppId: "app_id",
  appVersion: "app_version",
  appBuildVersion: "build_number",
  branch: "branch",
  branchId: "branch_id",
  branch_id: "branch_id",
  buildId: "build_id",
  build_id: "build_id",
  buildNumber: "build_number",
  build_number: "build_number",
  bundleId: "bundle_id",
  bundle_id: "bundle_id",
  commitOid: "commit_oid",
  commit_oid: "commit_oid",
  currency: "currency",
  databaseId: "database_id",
  database_id: "database_id",
  databaseName: "database_name",
  database_name: "database_name",
  deploymentId: "deployment_id",
  deployment_id: "deployment_id",
  domain: "domain",
  entitlementId: "entitlement_id",
  entitlement_id: "entitlement_id",
  measurementId: "measurement_id",
  measurement_id: "measurement_id",
  livemode: "livemode",
  lookupKey: "lookup_key",
  lookup_key: "lookup_key",
  html_url: "url",
  nameWithOwner: "repository",
  offeringId: "offering_id",
  offering_id: "offering_id",
  priceId: "price_id",
  price_id: "price_id",
  productId: "product_id",
  product_id: "product_id",
  project: "project",
  projectId: "project_id",
  project_id: "project_id",
  projectName: "project_name",
  project_name: "project_name",
  propertyId: "property_id",
  property_id: "property_id",
  repository: "repository",
  repositoryId: "repository_id",
  repository_id: "repository_id",
  region: "region",
  regionId: "region",
  region_id: "region",
  siteUrl: "site_url",
  site_url: "site_url",
  streamId: "stream_id",
  stream_id: "stream_id",
  submissionId: "submission_id",
  submission_id: "submission_id",
  teamId: "team_id",
  team_id: "team_id",
  testflightGroupId: "testflight_group_id",
  testflight_group_id: "testflight_group_id",
  treeOid: "tree_oid",
  tree_oid: "tree_oid",
  url: "url",
  visibility: "visibility",
  webhookId: "webhook_id",
  webhook_id: "webhook_id",
};

function safeResourceValue(value: unknown, redactor: Redactor): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  let text = String(value).trim();
  if (
    text.length === 0 ||
    text.length > 500 ||
    text.startsWith("cred://") ||
    text.includes("[REDACTED]") ||
    looksLikeCredentialValue(text) ||
    redactor.redactText(text) !== text
  ) {
    return null;
  }
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    text = url.toString();
  } catch {
    // Non-URL provider identifiers are expected here.
  }
  return text;
}

function collectSafeResourceRefs(
  value: unknown,
  redactor: Redactor,
  refs = new Map<string, ProviderResourceReference>(),
): ProviderResourceReference[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSafeResourceRefs(item, redactor, refs));
    return [...refs.values()].sort(
      (left, right) => left.type.localeCompare(right.type) || left.value.localeCompare(right.value),
    );
  }
  if (!value || typeof value !== "object") return [...refs.values()];
  for (const [key, item] of Object.entries(value)) {
    const type = SAFE_RESOURCE_KEYS[key];
    if (type) {
      const safe = safeResourceValue(item, redactor);
      if (safe) refs.set(`${type}\u0000${safe}`, { type, value: safe });
    }
    if (typeof item === "object" && item !== null) {
      collectSafeResourceRefs(item, redactor, refs);
    }
  }
  return [...refs.values()]
    .sort(
      (left, right) => left.type.localeCompare(right.type) || left.value.localeCompare(right.value),
    )
    .slice(0, 100);
}

function topLevelValuesForKey(value: unknown, key: string): unknown[] {
  const records = Array.isArray(value) ? value : [value];
  return records.flatMap((candidate) => {
    if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(record, key) ? [record[key]] : [];
  });
}

interface PreparedProviderPlan {
  adapter: ProviderAdapter;
  context: ProviderRuntimeContext;
  plan: ProviderPlan;
}

interface PreparedProviderReconciliation extends PreparedProviderPlan {
  target: ProviderWorkflowPlanRequest;
  ledgerIdentity: string;
}

export interface ProviderPlanCheckpoint {
  [key: string]: JsonValue;
  schemaVersion: 2;
  kind: "provider_plan";
  provider: ProviderId;
  digest: string;
  ledgerBinding: string;
  snapshot: JsonValue;
}

export interface ProviderPlanSnapshot {
  target: {
    provider: ProviderId;
    request: ProviderPlanRequest;
    operationBudget?: ProviderWorkflowPlanRequest["operationBudget"];
  };
  plan: {
    id: string;
    provider: ProviderId;
    environment: ProviderPlan["environment"];
    dryRun: boolean;
    operations: ProviderPlan["operations"];
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function providerPlanSnapshot(
  target: ProviderWorkflowPlanRequest,
  plan: ProviderPlan,
): ProviderPlanSnapshot {
  return JSON.parse(
    canonicalJson({
      target: {
        provider: target.provider,
        request: target.request,
        operationBudget: target.operationBudget,
      },
      plan: {
        id: plan.id,
        provider: plan.provider,
        environment: plan.environment,
        dryRun: plan.dryRun,
        operations: plan.operations,
      },
    }),
  ) as ProviderPlanSnapshot;
}

function snapshotDigest(snapshot: ProviderPlanSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function ledgerBinding(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function providerPlanCheckpoint(
  target: ProviderWorkflowPlanRequest,
  plan: ProviderPlan,
  ledgerIdentity: string,
): ProviderPlanCheckpoint {
  const snapshot = providerPlanSnapshot(target, plan);
  return {
    schemaVersion: 2,
    kind: "provider_plan",
    provider: target.provider,
    digest: snapshotDigest(snapshot),
    ledgerBinding: ledgerBinding(ledgerIdentity),
    snapshot: snapshot as unknown as JsonValue,
  };
}

function parseProviderPlanCheckpoint(value: JsonValue | undefined): ProviderPlanCheckpoint | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const candidate = value as Record<string, JsonValue>;
  if (
    Object.keys(candidate).sort().join(",") !==
      "digest,kind,ledgerBinding,provider,schemaVersion,snapshot" ||
    candidate.schemaVersion !== 2 ||
    candidate.kind !== "provider_plan" ||
    typeof candidate.provider !== "string" ||
    typeof candidate.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.digest) ||
    typeof candidate.ledgerBinding !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.ledgerBinding) ||
    !candidate.snapshot ||
    Array.isArray(candidate.snapshot) ||
    typeof candidate.snapshot !== "object"
  ) {
    return null;
  }
  const snapshot = candidate.snapshot as unknown as Partial<ProviderPlanSnapshot>;
  if (
    !snapshot.target ||
    !snapshot.plan ||
    snapshot.target.provider !== candidate.provider ||
    snapshot.plan.provider !== candidate.provider ||
    !snapshot.target.request ||
    typeof snapshot.target.request !== "object" ||
    typeof snapshot.plan.id !== "string" ||
    typeof snapshot.plan.environment !== "string" ||
    snapshot.plan.dryRun !== false ||
    !Array.isArray(snapshot.plan.operations) ||
    snapshot.plan.operations.length === 0 ||
    snapshot.plan.operations.some(
      (operation) =>
        !operation ||
        typeof operation !== "object" ||
        operation.provider !== candidate.provider ||
        typeof operation.idempotencyKey !== "string",
    ) ||
    snapshotDigest(snapshot as ProviderPlanSnapshot) !== candidate.digest
  ) {
    return null;
  }
  return candidate as unknown as ProviderPlanCheckpoint;
}

/**
 * Read-only inspection boundary for durable workflow state. A non-null result
 * has passed the exact checkpoint shape and canonical snapshot-digest checks
 * used by provider reconciliation.
 */
export function inspectProviderPlanCheckpoint(
  value: JsonValue | undefined,
): ProviderPlanCheckpoint | null {
  const checkpoint = parseProviderPlanCheckpoint(value);
  return checkpoint ? structuredClone(checkpoint) : null;
}

function checkpointSnapshot(checkpoint: ProviderPlanCheckpoint): ProviderPlanSnapshot {
  return checkpoint.snapshot as unknown as ProviderPlanSnapshot;
}

function checkpointTarget(checkpoint: ProviderPlanCheckpoint): ProviderWorkflowPlanRequest {
  const { target } = checkpointSnapshot(checkpoint);
  return {
    provider: target.provider,
    request: target.request,
    ...(target.operationBudget ? { operationBudget: target.operationBudget } : {}),
  };
}

async function prepareProviderPlan(
  workflow: WorkflowHandlerContext,
  target: ProviderWorkflowPlanRequest,
  options: ProviderWorkflowBindingsOptions,
): Promise<PreparedProviderPlan> {
  const adapter = target.adapter ?? (options.resolveAdapter ?? getProviderAdapter)(target.provider);
  if (adapter.descriptor.id !== target.provider) {
    throw new WorkflowExecutionError(
      "provider_adapter_mismatch",
      `Resolved ${adapter.descriptor.id} adapter for ${target.provider}`,
    );
  }
  const base = await resolveValue(options.context, workflow, target);
  const context = mergeContext(base, target.context);
  let plan: ProviderPlan;
  try {
    plan = adapter.plan(target.request);
  } catch (error) {
    if (error instanceof ProviderPlanFactoryPrerequisiteError && error.waitKind) {
      throw new WorkflowExecutionError(
        error.waitKind === "auth" ? "AUTH_REQUIRED" : "EXTERNAL_ACTION_REQUIRED",
        error.message,
      );
    }
    throw new WorkflowExecutionError(
      "provider_plan_failed",
      context.redactor.redactText(error instanceof Error ? error.message : String(error)),
    );
  }
  if (target.operationBudget) {
    const { maxOperations, missingCostClassification } = target.operationBudget;
    if (
      !Number.isInteger(maxOperations) ||
      maxOperations < 1 ||
      (missingCostClassification !== undefined &&
        (!/^[A-Z]{3}$/u.test(missingCostClassification.currency) ||
          missingCostClassification.basis !== "reviewed_known_zero_direct_charge" ||
          missingCostClassification.ongoingAccountPlanUsageCovered !== false ||
          missingCostClassification.allowedOperations.length === 0))
    ) {
      throw new WorkflowExecutionError(
        "provider_budget_binding_invalid",
        `${target.provider} received an invalid immutable operation-budget binding`,
      );
    }
    if (plan.operations.length > maxOperations) {
      throw new WorkflowExecutionError(
        "provider_operation_limit_exceeded",
        `${target.provider} planned ${plan.operations.length} operations, exceeding this launch node ceiling of ${maxOperations}`,
        { details: { provider: target.provider, effectOutcome: "confirmed_no_write" } },
      );
    }
    const requestedCapabilities = new Set(target.request.capabilities);
    const operations = plan.operations.map((operation) => {
      if (
        operation.provider !== target.provider ||
        !requestedCapabilities.has(operation.capability)
      ) {
        throw new WorkflowExecutionError(
          "provider_plan_scope_mismatch",
          `${target.provider} produced an operation outside its exact requested capability scope`,
          { details: { provider: target.provider, effectOutcome: "confirmed_no_write" } },
        );
      }
      if (operation.estimatedCost) return operation;
      const reviewed = missingCostClassification?.allowedOperations.some(
        (candidate) =>
          candidate.provider === operation.provider &&
          candidate.capability === operation.capability &&
          candidate.action === operation.action,
      );
      if (!reviewed || !missingCostClassification) {
        throw new WorkflowExecutionError(
          "provider_cost_estimate_missing",
          `${target.provider} operation ${operation.action} has no explicit estimate or reviewed known-zero direct-charge classification`,
          { details: { provider: target.provider, effectOutcome: "confirmed_no_write" } },
        );
      }
      return {
        ...operation,
        estimatedCost: { amount: 0, currency: missingCostClassification.currency },
      };
    });
    plan = { ...plan, operations };
  }
  if (plan.dryRun) {
    throw new WorkflowExecutionError(
      "provider_plan_only",
      `${target.provider} plan is a dry run; explicit apply input is required`,
    );
  }
  if (plan.operations.length === 0) {
    throw new WorkflowExecutionError(
      "provider_plan_empty",
      `${target.provider} plan contains no complete provider operation`,
    );
  }
  return { adapter, context, plan };
}

async function durableLedgerIdentity(
  context: ProviderRuntimeContext,
  provider: ProviderId,
): Promise<string> {
  if (!context.idempotencyLedger || context.idempotencyLedger.durability !== "durable_atomic") {
    throw new WorkflowExecutionError(
      "provider_reconciliation_ledger_required",
      `${provider} requires a durable atomic provider idempotency ledger`,
      { details: { provider, effectOutcome: "confirmed_no_write" } },
    );
  }
  try {
    return await context.idempotencyLedger.identity();
  } catch {
    throw new WorkflowExecutionError(
      "provider_idempotency_ledger_unavailable",
      `${provider} durable idempotency ledger is missing, corrupt, or unavailable`,
      { details: { provider, effectOutcome: "confirmed_no_write" } },
    );
  }
}

async function prepareCheckpointProviderPlan(
  workflow: WorkflowHandlerContext,
  checkpoint: ProviderPlanCheckpoint,
  options: ProviderWorkflowBindingsOptions,
): Promise<PreparedProviderPlan & { target: ProviderWorkflowPlanRequest }> {
  const target = checkpointTarget(checkpoint);
  const prepared = await prepareProviderPlan(workflow, target, options);
  const reconstructed = providerPlanSnapshot(target, prepared.plan);
  if (snapshotDigest(reconstructed) !== checkpoint.digest) {
    throw new WorkflowExecutionError(
      "provider_reconciliation_target_mismatch",
      `${target.provider} immutable provider-plan snapshot cannot be rebuilt by the trusted adapter`,
    );
  }
  return { target, ...prepared };
}

async function lifecycleProvesPlan(
  plan: ProviderPlan,
  options: ProviderWorkflowBindingsOptions,
): Promise<boolean> {
  if (!options.lifecycleStore) return false;
  const scopes = new Map(
    plan.operations.map((operation) => [
      `${operation.provider}\u0000${operation.environment}\u0000${operation.capability}`,
      operation,
    ]),
  );
  let records: VerifiedProviderLifecycleRecord[];
  try {
    records = await options.lifecycleStore.list();
  } catch {
    throw new WorkflowExecutionError(
      "provider_lifecycle_state_unavailable",
      `${plan.provider} lifecycle state is unavailable during reconciliation`,
    );
  }
  return [...scopes.values()].every((operation) =>
    records.some(
      (record) =>
        record.provider === operation.provider &&
        record.environment === operation.environment &&
        record.capability === operation.capability &&
        record.planId === plan.id,
    ),
  );
}

async function prepareProviderReconciliation(
  handler: string,
  factory: ProviderWorkflowPlanFactory,
  workflow: WorkflowHandlerContext,
  checkpoint: ProviderPlanCheckpoint,
  options: ProviderWorkflowBindingsOptions,
): Promise<PreparedProviderReconciliation> {
  let currentFailure: unknown;
  try {
    const target = await resolveProviderTarget(handler, factory, workflow);
    const prepared = await prepareProviderPlan(workflow, target, options);
    const identity = await durableLedgerIdentity(prepared.context, target.provider);
    if (ledgerBinding(identity) !== checkpoint.ledgerBinding) {
      throw new WorkflowExecutionError(
        "provider_reconciliation_ledger_mismatch",
        `${target.provider} reconciliation resolved a different durable ledger generation`,
      );
    }
    const reconstructed = providerPlanCheckpoint(target, prepared.plan, identity);
    if (
      reconstructed.provider === checkpoint.provider &&
      reconstructed.digest === checkpoint.digest
    ) {
      return { ...prepared, target, ledgerIdentity: identity };
    }
  } catch (error) {
    currentFailure = error;
  }

  const stored = await prepareCheckpointProviderPlan(workflow, checkpoint, options);
  if (!(await lifecycleProvesPlan(stored.plan, options))) {
    if (currentFailure) throw currentFailure;
    throw new WorkflowExecutionError(
      "provider_reconciliation_target_mismatch",
      `${checkpoint.provider} reconciliation target does not match the durable immutable plan`,
    );
  }

  const identity = await durableLedgerIdentity(stored.context, stored.target.provider);
  if (ledgerBinding(identity) !== checkpoint.ledgerBinding) {
    throw new WorkflowExecutionError(
      "provider_reconciliation_ledger_mismatch",
      `${stored.target.provider} reconciliation resolved a different durable ledger generation`,
    );
  }
  return { ...stored, ledgerIdentity: identity };
}

async function verifiedProviderResult(
  workflow: WorkflowHandlerContext,
  target: ProviderWorkflowPlanRequest,
  options: ProviderWorkflowBindingsOptions,
  context: ProviderRuntimeContext,
  plan: ProviderPlan,
  report: ProviderExecutionReport,
  verification: ProviderVerificationReport,
): Promise<WorkflowHandlerResult> {
  if (!context.idempotencyLedger) {
    throw new WorkflowExecutionError(
      "idempotency_ledger_required",
      `${target.provider} verification requires a provider idempotency ledger`,
    );
  }
  await promoteVerifiedOperations(context.idempotencyLedger, report.operations);
  const resourceRefs = collectSafeResourceRefs(
    [
      target.request.inputs,
      report.operations.map(({ result }) => result.output),
      verification.checks,
    ],
    context.redactor,
  );
  // `id` is intentionally not globally allowlisted because it is ambiguous.
  // A Vercel deployment operation provides the capability context needed to
  // preserve its exact safe identifier without admitting arbitrary body ids.
  for (const execution of report.operations.filter(
    ({ operation }) => operation.provider === "vercel" && operation.capability === "deployment",
  )) {
    const evidence = verification.checks
      .filter(({ operationId }) => operationId === execution.operation.id)
      .map(({ evidence: value }) => value);
    for (const candidate of topLevelValuesForKey([execution.result.output, ...evidence], "id")) {
      const value = safeResourceValue(candidate, context.redactor);
      if (value !== null) resourceRefs.push({ type: "deployment_id", value });
    }
  }
  const publicOutputs = collectProviderPublicOutputs({
    provider: target.provider,
    requestInputs: target.request.inputs,
    report,
    verification,
  });
  for (const reference of publicOutputs.identifiers) {
    const value = safeResourceValue(reference.value, context.redactor);
    if (value !== null) resourceRefs.push({ ...reference, value });
  }
  const uniqueResourceRefs = [
    ...new Map(resourceRefs.map((item) => [`${item.type}\u0000${item.value}`, item])).values(),
  ].sort(
    (left, right) => left.type.localeCompare(right.type) || left.value.localeCompare(right.value),
  );
  const evidence: VerifiedProviderEvidence = {
    provider: target.provider,
    planId: plan.id,
    state: "verified",
    environments: [...new Set(plan.operations.map(({ environment }) => environment))].sort(),
    capabilities: [...new Set(plan.operations.map(({ capability }) => capability))].sort(),
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      action: operation.action,
      capability: operation.capability,
      environment: operation.environment,
      status: "matched" as const,
    })),
    resourceRefs: uniqueResourceRefs.map(({ type, value }) => `${type}=${value}`),
    publicOutputs,
    checks: verification.checks.map(({ operationId, status }) => ({ operationId, status })),
  };
  const evidenceArtifact = options.recordEvidence
    ? await options.recordEvidence({ evidence, workflow })
    : `provider-readback://${target.provider}/${plan.id}`;
  if (options.lifecycleStore) {
    const verifiedAt = (options.now?.() ?? new Date()).toISOString();
    const scopes = new Map<string, VerifiedProviderLifecycleRecord>();
    for (const operation of plan.operations) {
      const record: VerifiedProviderLifecycleRecord = {
        provider: target.provider,
        environment: operation.environment,
        capability: operation.capability,
        state: "verified",
        planId: plan.id,
        verifiedAt,
        resourceRefs: uniqueResourceRefs,
      };
      scopes.set(`${record.provider}\u0000${record.environment}\u0000${record.capability}`, record);
    }
    try {
      await options.lifecycleStore.recordVerified([...scopes.values()]);
    } catch {
      throw new WorkflowExecutionError(
        "provider_lifecycle_persistence_failed",
        `${target.provider} was verified, but its safe lifecycle state could not be persisted; repair the lifecycle store and resume for read-back`,
        {
          details: {
            provider: target.provider,
            environments: evidence.environments,
            capabilities: evidence.capabilities,
          },
        },
      );
    }
  }
  return {
    output: sanitizeJson(evidence),
    effectVerified: true,
    evidenceArtifact,
  };
}

async function executeProviderPlan(
  workflow: WorkflowHandlerContext,
  target: ProviderWorkflowPlanRequest,
  options: ProviderWorkflowBindingsOptions,
): Promise<WorkflowHandlerResult> {
  const { adapter, context, plan } = await prepareProviderPlan(workflow, target, options);
  const providerLedgerIdentity = await durableLedgerIdentity(context, target.provider);
  if (!workflow.checkpointOperation) {
    throw new WorkflowExecutionError(
      "provider_operation_checkpoint_required",
      `${target.provider} apply requires a durable immutable-target checkpoint`,
      { details: { provider: target.provider, effectOutcome: "confirmed_no_write" } },
    );
  }
  const immutableCheckpoint = providerPlanCheckpoint(target, plan, providerLedgerIdentity);
  workflow.checkpointOperation(immutableCheckpoint);

  const envelope = await resolveValue(options.authorization, workflow, target);
  if (envelope.run_id !== workflow.runId) {
    throw new WorkflowExecutionError(
      "authorization_rejected",
      `Authorization envelope belongs to ${envelope.run_id}, not ${workflow.runId}`,
    );
  }
  const authorizationNow = options.now?.() ?? new Date();
  let inspections: ReturnType<typeof inspectOperationAuthorization>[];
  try {
    inspections = plan.operations.map((operation) =>
      inspectOperationAuthorization(envelope, operation, options.policies, authorizationNow),
    );
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new WorkflowExecutionError("authorization_rejected", error.message, {
        details: { provider: target.provider, reason: error.code },
      });
    }
    throw error;
  }
  const requirements = inspections.flatMap((inspection, index) =>
    inspection.checkpointRequired
      ? [
          {
            effect: inspection.effect,
            operationId: plan.operations[index].id,
            provider: plan.operations[index].provider,
            action: plan.operations[index].action,
          },
        ]
      : [],
  );
  const grants =
    requirements.length === 0
      ? []
      : (workflow.claimAuthorizationCheckpoints?.(requirements) ??
        (() => {
          throw new WorkflowExecutionError(
            "authorization_checkpoint_required",
            `${target.provider} requires one-shot human authorization before provider execution`,
            { details: { requirements } },
          );
        })());
  const executionAuthorizationNow = options.now?.() ?? new Date();
  try {
    for (const [index, operation] of plan.operations.entries()) {
      const inspection = inspections[index];
      const checkpointGrant = inspection.checkpointRequired
        ? grants.find(
            (grant) => grant.effect === inspection.effect && grant.operationId === operation.id,
          )
        : undefined;
      assertOperationAuthorized(envelope, operation, options.policies, executionAuthorizationNow, {
        nodeId: workflow.node.id,
        checkpointGrant,
      });
    }
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new WorkflowExecutionError("authorization_rejected", error.message, {
        details: { provider: target.provider, reason: error.code },
      });
    }
    throw error;
  }

  const estimatedOperations = plan.operations.flatMap((operation) =>
    operation.estimatedCost
      ? [{ operationId: operation.id, amount: operation.estimatedCost.amount }]
      : [],
  );
  if (estimatedOperations.length > 0) {
    if (!workflow.reserveAuthorizationSpend) {
      throw new WorkflowExecutionError(
        "authorization_spend_ledger_required",
        `${target.provider} has estimated provider cost but no durable run spend ledger`,
        { details: { provider: target.provider, effectOutcome: "confirmed_no_write" } },
      );
    }
    try {
      workflow.reserveAuthorizationSpend({
        reservationId: `${workflow.node.id}:${immutableCheckpoint.digest}`,
        currency: envelope.max_estimated_spend.currency,
        maxAmount: envelope.max_estimated_spend.amount,
        operations: estimatedOperations,
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionError) {
        const prior =
          error.details && typeof error.details === "object" && !Array.isArray(error.details)
            ? error.details
            : {};
        throw new WorkflowExecutionError(error.code, error.message, {
          retryable: error.retryable,
          details: { ...prior, effectOutcome: "confirmed_no_write" },
        });
      }
      throw error;
    }
  }
  const executionContext: ProviderExecutionContext = {
    ...context,
    authorization: "approved",
    reuseSuccessfulOperations: workflow.attempt > 1,
    signal: workflow.signal,
  };
  const report = await adapter.apply(plan, executionContext);
  if (report.state !== "applied") {
    throw executionFailure(
      target.provider,
      report.operations.map(({ result }) => result),
    );
  }
  const readBack = await adapter.readBack(report, executionContext);
  const verification = adapter.verify(report, readBack);
  if (verification.state !== "verified") {
    throw verificationFailure(target.provider, verification);
  }
  return verifiedProviderResult(workflow, target, options, context, plan, report, verification);
}

async function resolveProviderTarget(
  handler: string,
  factory: ProviderWorkflowPlanFactory,
  workflow: WorkflowHandlerContext,
): Promise<ProviderWorkflowPlanRequest> {
  try {
    return await factory(workflow);
  } catch (error) {
    if (error instanceof ProviderPlanFactoryPrerequisiteError && error.waitKind) {
      throw new WorkflowExecutionError(
        error.waitKind === "auth" ? "AUTH_REQUIRED" : "EXTERNAL_ACTION_REQUIRED",
        error.message,
        { details: { effectOutcome: "confirmed_no_write" } },
      );
    }
    throw new WorkflowExecutionError(
      "provider_plan_factory_failed",
      error instanceof ProviderPlanFactoryPrerequisiteError
        ? error.message
        : `Provider plan factory "${handler}" failed without producing a safe request`,
    );
  }
}

function reconciliationWorkflowContext(
  reconciliation: WorkflowReconciliationContext,
): WorkflowHandlerContext {
  return {
    runId: reconciliation.runId,
    node: reconciliation.node,
    attempt: reconciliation.attempt,
    input: reconciliation.input,
    dependencyOutputs: reconciliation.dependencyOutputs,
    idempotencyKey: reconciliation.idempotencyKey,
    signal: reconciliation.signal,
    trace: reconciliation.trace,
  };
}

function reconciliationFailure(error: unknown): WorkflowReconciliationResult {
  if (error instanceof WorkflowExecutionError) {
    return {
      status: "failed",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      effectState: "unknown",
    };
  }
  return {
    status: "failed",
    code: "provider_reconciliation_failed",
    message: "Provider reconciliation failed without a safe verified outcome",
    retryable: false,
    effectState: "unknown",
  };
}

async function assertReconciliationAuthorized(
  workflow: WorkflowHandlerContext,
  target: ProviderWorkflowPlanRequest,
  plan: ProviderPlan,
  options: ProviderWorkflowBindingsOptions,
): Promise<void> {
  const envelope = await resolveValue(options.authorization, workflow, target);
  if (envelope.run_id !== workflow.runId) {
    throw new WorkflowExecutionError(
      "provider_reconciliation_authorization_rejected",
      `Authorization envelope belongs to ${envelope.run_id}, not ${workflow.runId}`,
    );
  }
  const authorizationNow = options.now?.() ?? new Date();
  try {
    for (const operation of plan.operations) {
      inspectOperationAuthorization(envelope, operation, options.policies, authorizationNow);
    }
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new WorkflowExecutionError(
        "provider_reconciliation_authorization_rejected",
        error.message,
      );
    }
    throw error;
  }
}

async function reconcileProviderPlan(
  workflow: WorkflowHandlerContext,
  prepared: PreparedProviderReconciliation,
  options: ProviderWorkflowBindingsOptions,
): Promise<WorkflowReconciliationResult> {
  const { adapter, context, plan, target } = prepared;
  await assertReconciliationAuthorized(workflow, target, plan, options);
  if (!adapter.reconcile) {
    return {
      status: "failed",
      code: "provider_reconciliation_unavailable",
      message: `${target.provider} adapter does not implement no-write reconciliation`,
      retryable: false,
      effectState: "unknown",
    };
  }

  const executionContext: ProviderExecutionContext = {
    ...context,
    authorization: "dry_run",
    signal: workflow.signal,
  };
  const report = await adapter.reconcile(plan, executionContext);
  const results = report.operations.map(({ result }) => result);
  if (results.some(({ providerCode }) => providerCode === "idempotency_conflict")) {
    return {
      status: "failed",
      code: "provider_idempotency_conflict",
      message: `${target.provider} reconciliation target does not match the durable request`,
      retryable: false,
      effectState: "unknown",
    };
  }
  if (
    results.some(
      ({ status, effectOutcome }) =>
        effectOutcome === "unknown" || (status === "failed" && effectOutcome === undefined),
    )
  ) {
    return {
      status: "unknown",
      message: `${target.provider} outcome remains unknown after bounded read-back reconciliation`,
    };
  }
  const everyOperationConfirmedNoWrite =
    results.length > 0 &&
    results.every(({ effectOutcome }) => effectOutcome === "confirmed_no_write");
  if (everyOperationConfirmedNoWrite) {
    return { status: "not_applied" };
  }
  const hasConfirmedWrite = results.some(
    ({ status, effectOutcome }) => status === "succeeded" || effectOutcome === "confirmed_write",
  );
  const hasIncompleteOperation = results.some(({ status }) => status !== "succeeded");
  if (hasConfirmedWrite && hasIncompleteOperation) {
    return {
      status: "partially_applied",
      message: `${target.provider} has a request-bound partial apply; only missing operations may be retried`,
    };
  }
  if (report.state !== "applied") {
    return {
      status: "unknown",
      message: `${target.provider} reconciliation did not establish one safe plan outcome`,
    };
  }

  const readBack = await adapter.readBack(report, executionContext);
  const verification = adapter.verify(report, readBack);
  if (verification.state === "failed") {
    return {
      status: "failed",
      code: "provider_verification_failed",
      message: `${target.provider} read-back conflicts with the immutable requested state`,
      retryable: false,
      effectState: "confirmed_write",
    };
  }
  if (verification.state !== "verified") {
    return { status: "pending" };
  }

  let verified: WorkflowHandlerResult;
  try {
    verified = await verifiedProviderResult(
      workflow,
      target,
      options,
      context,
      plan,
      report,
      verification,
    );
  } catch (error) {
    return {
      status: "failed",
      code:
        error instanceof WorkflowExecutionError
          ? error.code
          : "provider_reconciliation_completion_failed",
      message:
        error instanceof WorkflowExecutionError
          ? error.message
          : `${target.provider} was read-back verified but completion state could not be persisted`,
      retryable: false,
      effectState: "confirmed_write",
    };
  }
  return {
    status: "verified",
    output: verified.output,
    evidenceArtifact: verified.evidenceArtifact,
  };
}

/** Builds workflow handlers without placing executable code or secrets in graph state. */
export function createProviderWorkflowBindings(
  options: ProviderWorkflowBindingsOptions,
): WorkflowBindings {
  return {
    handlers: Object.fromEntries(
      Object.entries(options.planFactories).map(([handler, factory]) => [
        handler,
        async (workflow: WorkflowHandlerContext) => {
          const target = await resolveProviderTarget(handler, factory, workflow);
          return executeProviderPlan(workflow, target, options);
        },
      ]),
    ),
    reconcilers: Object.fromEntries(
      Object.entries(options.planFactories).map(([handler, factory]) => [
        handler,
        async (reconciliation: WorkflowReconciliationContext) => {
          const workflow = reconciliationWorkflowContext(reconciliation);
          try {
            const checkpoint = parseProviderPlanCheckpoint(reconciliation.operation.checkpoint);
            if (!checkpoint) {
              return {
                status: "failed" as const,
                code: "provider_reconciliation_target_missing",
                message: `Provider plan handler "${handler}" has no valid durable immutable-target checkpoint`,
                retryable: false,
                effectState: "unknown" as const,
              };
            }
            const prepared = await prepareProviderReconciliation(
              handler,
              factory,
              workflow,
              checkpoint,
              options,
            );
            return await reconcileProviderPlan(workflow, prepared, options);
          } catch (error) {
            return reconciliationFailure(error);
          }
        },
      ]),
    ),
  };
}
