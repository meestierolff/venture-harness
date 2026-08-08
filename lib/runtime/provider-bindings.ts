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

  constructor(message: string) {
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
      "provider_verification_unavailable",
      `${provider} apply was not proven by read-back`,
      {
        retryable: true,
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
  appId: "app_id",
  app_id: "app_id",
  appStoreAppId: "app_id",
  appVersion: "app_version",
  appBuildVersion: "build_number",
  branchId: "branch_id",
  branch_id: "branch_id",
  buildId: "build_id",
  build_id: "build_id",
  buildNumber: "build_number",
  build_number: "build_number",
  bundleId: "bundle_id",
  bundle_id: "bundle_id",
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
  url: "url",
  webhookId: "webhook_id",
  webhook_id: "webhook_id",
};

function safeResourceValue(value: unknown, redactor: Redactor): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
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

async function executeProviderPlan(
  workflow: WorkflowHandlerContext,
  target: ProviderWorkflowPlanRequest,
  options: ProviderWorkflowBindingsOptions,
): Promise<WorkflowHandlerResult> {
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
    throw new WorkflowExecutionError(
      "provider_plan_failed",
      context.redactor.redactText(error instanceof Error ? error.message : String(error)),
    );
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

  if (!context.idempotencyLedger) {
    throw new WorkflowExecutionError(
      "idempotency_ledger_required",
      `${target.provider} apply requires a provider idempotency ledger`,
    );
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
      );
    }
    workflow.reserveAuthorizationSpend({
      reservationId: `${workflow.node.id}:${workflow.attempt}`,
      currency: envelope.max_estimated_spend.currency,
      maxAmount: envelope.max_estimated_spend.amount,
      operations: estimatedOperations,
    });
  }
  const executionContext: ProviderExecutionContext = {
    ...context,
    authorization: "approved",
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

  await promoteVerifiedOperations(context.idempotencyLedger, report.operations);
  const resourceRefs = collectSafeResourceRefs(
    [
      target.request.inputs,
      report.operations.map(({ result }) => result.output),
      verification.checks,
    ],
    context.redactor,
  );
  const publicOutputs = collectProviderPublicOutputs({
    provider: target.provider,
    requestInputs: target.request.inputs,
    report,
    verification,
  });
  for (const reference of publicOutputs.identifiers) {
    resourceRefs.push(reference);
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

/** Builds workflow handlers without placing executable code or secrets in graph state. */
export function createProviderWorkflowBindings(
  options: ProviderWorkflowBindingsOptions,
): WorkflowBindings {
  return {
    handlers: Object.fromEntries(
      Object.entries(options.planFactories).map(([handler, factory]) => [
        handler,
        async (workflow: WorkflowHandlerContext) => {
          let target: ProviderWorkflowPlanRequest;
          try {
            target = await factory(workflow);
          } catch (error) {
            throw new WorkflowExecutionError(
              "provider_plan_factory_failed",
              error instanceof ProviderPlanFactoryPrerequisiteError
                ? error.message
                : `Provider plan factory "${handler}" failed without producing a safe request`,
            );
          }
          return executeProviderPlan(workflow, target, options);
        },
      ]),
    ),
  };
}
