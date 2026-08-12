import { createHash } from "node:crypto";
import { ManualProviderTransport } from "./transports";
import type { CredentialInspection } from "../credentials";
import type {
  ProviderAdapter,
  ProviderDescriptor,
  ProviderDoctorIssue,
  ProviderDoctorRequest,
  ProviderDoctorResult,
  ProviderExecutionContext,
  ProviderExecutionReport,
  ProviderOperation,
  ProviderOperationExecution,
  ProviderPlan,
  ProviderPlanRequest,
  ProviderReadBackReport,
  ProviderReadBackResult,
  ProviderTransport,
  ProviderTransportResult,
  ProviderVerificationReport,
} from "./types";
import { ProviderPlanError } from "./types";

export type ProviderPlanBuilder = (request: ProviderPlanRequest) => ProviderPlan;

function dryRunResult(): ProviderTransportResult {
  return {
    status: "skipped",
    message: "Dry run: no provider command or request was sent",
    retryable: false,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function requestHash(operation: ProviderOperation): string {
  return createHash("sha256").update(canonicalJson(operation)).digest("hex");
}

function idempotencyFailure(
  providerCode: "idempotency_conflict" | "unknown_outcome_reconciliation_required",
  message: string,
  effectOutcome: ProviderTransportResult["effectOutcome"] = "unknown",
  retryable = false,
): ProviderTransportResult {
  return { status: "failed", providerCode, message, retryable, effectOutcome };
}

function requiresDurableIdempotency(operation: ProviderOperation): boolean {
  return ["reversible_external", "irreversible_external", "financial", "communication"].includes(
    operation.effectClass,
  );
}

const DEPENDENCY_RESULT = /\{dependency\.([a-z0-9_-]+)\.([a-zA-Z0-9_.-]+)\}/g;
const RESULT_REFERENCE = /\{result\.([a-zA-Z0-9_.-]+)\}/g;

function resultPath(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (Array.isArray(value) && !/^\d+$/.test(part)) {
      if (value.length !== 1) return undefined;
      value = value[0];
    }
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

function deepContains(actual: unknown, expected: unknown): boolean {
  if (canonicalJson(actual) === canonicalJson(expected)) return true;
  if (Array.isArray(actual)) {
    if (Array.isArray(expected)) {
      return expected.every((expectedItem) =>
        actual.some((actualItem) => deepContains(actualItem, expectedItem)),
      );
    }
    return actual.some((item) => deepContains(item, expected));
  }
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(expected)
  ) {
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      deepContains((actual as Record<string, unknown>)[key], value),
    );
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  return false;
}

function discoveryAssertionsMatch(
  value: unknown,
  assertions:
    | NonNullable<ProviderOperation["existingResource"]>["identityAssertions"]
    | NonNullable<ProviderOperation["existingResource"]>["stateAssertions"],
): boolean {
  return assertions.every(({ path, operator, expected }) => {
    const actual = resultPath(value, path);
    return operator === "equals"
      ? canonicalJson(actual) === canonicalJson(expected)
      : deepContains(actual, expected);
  });
}

async function discoverExistingResource(
  operation: ProviderOperation,
  transport: ProviderTransport,
  context: ProviderExecutionContext,
): Promise<ProviderTransportResult | null> {
  const discovery = operation.existingResource;
  if (!discovery) return null;
  const lookupOperation: ProviderOperation = {
    ...operation,
    action: `${operation.action}.search_before_create`,
    title: discovery.description,
    effectClass: "read",
    reversibility: "reversible",
    command: discovery.command,
    http: discovery.http,
    manual: undefined,
    existingResource: undefined,
    readBack: undefined,
  };
  let lookup: ProviderTransportResult;
  try {
    lookup = await transport.execute(lookupOperation, {
      credentials: context.credentials,
      redactor: context.redactor,
      signal: context.signal,
    });
  } catch (error) {
    lookup = {
      status: "failed",
      providerCode: "transport_exception",
      message: context.redactor.redactText(error instanceof Error ? error.message : String(error)),
      retryable: false,
      effectOutcome: "confirmed_no_write",
    };
  }
  lookup = context.redactor.redact(lookup);
  if (lookup.status !== "succeeded") {
    return {
      ...lookup,
      message: `Search-before-create failed: ${lookup.message}`,
      effectOutcome: "confirmed_no_write",
    };
  }
  const candidates = resultPath(lookup.output, discovery.candidatesPath);
  if (!Array.isArray(candidates)) {
    return {
      status: "failed",
      providerCode: "terminal_validation",
      message: "Search-before-create returned no bounded candidate list",
      retryable: false,
      effectOutcome: "confirmed_no_write",
    };
  }
  const identityMatches = candidates.filter((candidate) =>
    discoveryAssertionsMatch(candidate, discovery.identityAssertions),
  );
  if (identityMatches.length > 1) {
    return {
      status: "failed",
      providerCode: "existing_resource_ambiguous",
      message: "Search-before-create found duplicate resources for one deterministic identity",
      retryable: false,
      effectOutcome: "confirmed_no_write",
    };
  }
  if (identityMatches.length === 1) {
    const candidate = identityMatches[0];
    if (!discoveryAssertionsMatch(candidate, discovery.stateAssertions)) {
      return {
        status: "failed",
        providerCode: "existing_resource_conflict",
        message: "The deterministic provider resource exists with different reviewed state",
        retryable: false,
        effectOutcome: "confirmed_no_write",
      };
    }
    if (discovery.reuseRequiresCredentialRef) {
      if (!context.credentials) {
        return {
          status: "failed",
          providerCode: "existing_resource_credential_unavailable",
          message:
            "The existing resource cannot be reused without its separately stored credential reference",
          retryable: false,
          effectOutcome: "confirmed_no_write",
        };
      }
      try {
        const inspection = await context.credentials.inspect(discovery.reuseRequiresCredentialRef);
        if (inspection.status !== "available") {
          return {
            status: "failed",
            providerCode: "existing_resource_credential_unavailable",
            message:
              "The existing resource was found, but its separately stored credential is unavailable",
            retryable: false,
            effectOutcome: "confirmed_no_write",
          };
        }
      } catch {
        return {
          status: "failed",
          providerCode: "existing_resource_credential_unavailable",
          message:
            "The existing resource was found, but its credential reference cannot be inspected",
          retryable: false,
          effectOutcome: "confirmed_no_write",
        };
      }
    }
    return {
      status: "succeeded",
      message: "Reused the exact deterministic resource found before create",
      output: candidate,
      verified: false,
      retryable: false,
      effectOutcome: "confirmed_no_write",
    };
  }
  if (discovery.hasMorePath && resultPath(lookup.output, discovery.hasMorePath) === true) {
    return {
      status: "failed",
      providerCode: "existing_resource_search_incomplete",
      message:
        "Search-before-create was paginated before the deterministic identity could be ruled out",
      retryable: false,
      effectOutcome: "confirmed_no_write",
    };
  }
  return null;
}

function interpolateDependencyString(
  value: string,
  operation: ProviderOperation,
  planOperations: readonly ProviderOperation[],
  completed: ReadonlyMap<string, ProviderTransportResult>,
): string {
  return value.replace(DEPENDENCY_RESULT, (placeholder, capability: string, path: string) => {
    const dependencies = planOperations.filter(
      (candidate) =>
        operation.dependsOn.includes(candidate.id) && candidate.capability === capability,
    );
    if (dependencies.length !== 1) return placeholder;
    const resolved = resultPath(completed.get(dependencies[0].id)?.output, path);
    return ["string", "number", "boolean"].includes(typeof resolved)
      ? String(resolved)
      : placeholder;
  });
}

function interpolateDependencyValue(
  value: unknown,
  operation: ProviderOperation,
  planOperations: readonly ProviderOperation[],
  completed: ReadonlyMap<string, ProviderTransportResult>,
): unknown {
  if (typeof value === "string") {
    return interpolateDependencyString(value, operation, planOperations, completed);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      interpolateDependencyValue(item, operation, planOperations, completed),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        interpolateDependencyValue(item, operation, planOperations, completed),
      ]),
    );
  }
  return value;
}

function materializeDependencies(
  operation: ProviderOperation,
  planOperations: readonly ProviderOperation[],
  completed: ReadonlyMap<string, ProviderTransportResult>,
): ProviderOperation | null {
  const materialized = interpolateDependencyValue(
    operation,
    operation,
    planOperations,
    completed,
  ) as ProviderOperation;
  return JSON.stringify(materialized).includes("{dependency.") ? null : materialized;
}

function replayOutputPaths(
  operation: ProviderOperation,
  planOperations: readonly ProviderOperation[],
): string[] {
  const paths = new Set<string>();
  const readBack = JSON.stringify(operation.readBack ?? null);
  for (const match of readBack.matchAll(RESULT_REFERENCE)) paths.add(match[1]!);
  for (const dependent of planOperations) {
    if (!dependent.dependsOn.includes(operation.id)) continue;
    for (const match of JSON.stringify(dependent).matchAll(DEPENDENCY_RESULT)) {
      if (match[1] === operation.capability) paths.add(match[2]!);
    }
  }
  return [...paths].sort();
}

function executionState(
  plan: ProviderPlan,
  operations: readonly ProviderOperationExecution[],
): ProviderExecutionReport["state"] {
  if (plan.dryRun || operations.every(({ result }) => result.status === "skipped")) {
    return "planned";
  }
  const statuses = operations.map(({ result }) => result.status);
  const succeeded = statuses.some((status) => status === "succeeded");
  const failed = statuses.some((status) => status === "failed");
  const waiting = statuses.some((status) => status === "waiting_manual");
  const blocked = statuses.some((status) => status === "skipped");
  if (failed && succeeded) return "degraded";
  if (failed) return "failed";
  if (waiting) return "waiting_manual";
  if (blocked && succeeded) return "degraded";
  if (blocked) return "failed";
  return "applied";
}

function scopeMissing(actual: readonly string[], required: readonly string[]): string[] {
  return required.filter((scope) => !actual.includes(scope) && !actual.includes("*"));
}

function preflightUrlMatchesOperation(url: string, operationUrl: string): boolean {
  try {
    const preflight = new URL(url);
    const operation = new URL(operationUrl);
    return (
      preflight.protocol === "https:" &&
      !preflight.username &&
      !preflight.password &&
      operation.protocol === "https:" &&
      !operation.username &&
      !operation.password &&
      preflight.origin === operation.origin
    );
  } catch {
    return false;
  }
}

export class DeclarativeProviderAdapter implements ProviderAdapter {
  constructor(
    readonly descriptor: ProviderDescriptor,
    private readonly buildPlan: ProviderPlanBuilder,
  ) {}

  async doctor(
    request: ProviderDoctorRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderDoctorResult> {
    const issues: ProviderDoctorIssue[] = [];
    const requestedCapabilities = request.requiredCapabilities ?? [];
    for (const capability of requestedCapabilities) {
      if (!this.descriptor.capabilities.includes(capability)) {
        issues.push({
          code: "capability_unknown",
          message: `${this.descriptor.displayName} does not declare capability ${capability}`,
          remediation: `Choose one of: ${this.descriptor.capabilities.join(", ")}`,
        });
      }
    }

    const transportResults = await Promise.all(
      this.descriptor.transports.map(async (kind) => {
        const transport =
          context.transports[kind] ??
          (kind === "manual" ? new ManualProviderTransport() : undefined);
        if (!transport) {
          return { kind, available: false, detail: "No transport was injected" };
        }
        try {
          return { kind, ...(await transport.available()) };
        } catch (error) {
          return {
            kind,
            available: false,
            detail: context.redactor.redactText(
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
      }),
    );

    const nonManual = transportResults.filter(({ kind }) => kind !== "manual");
    if (nonManual.length > 0 && nonManual.every(({ available }) => !available)) {
      issues.push({
        code: "transport_missing",
        message: `No executable ${this.descriptor.displayName} transport is available`,
        remediation: `Inject one of: ${nonManual.map(({ kind }) => kind).join(", ")}`,
      });
    }

    const credentialResults: ProviderDoctorResult["credentialRefs"][number][] = [];
    const credentialInspections: CredentialInspection[] = [];
    const manualCapabilities: Partial<Record<ProviderDescriptor["id"], readonly string[]>> = {
      revenuecat: ["project_bootstrap"],
      dns: ["record"],
      mijndomein: ["record", "domain_attachment"],
      app_store_connect: ["first_app_record"],
      eas: ["app_store_prerequisite"],
    };
    const requestIsManualOnly =
      requestedCapabilities.length > 0 &&
      requestedCapabilities.every((capability) =>
        manualCapabilities[this.descriptor.id]?.includes(capability),
      );
    const needsCredential =
      !requestIsManualOnly &&
      this.descriptor.authMethods.some(
        (method) => method !== "manual" && method !== "none" && method !== "cli_session",
      );
    const acceptsCliSession =
      !requestIsManualOnly && this.descriptor.authMethods.includes("cli_session");
    const capabilityCredentialRequirements =
      requestedCapabilities.length > 0
        ? (this.descriptor.credentialRequirements ?? []).filter((requirement) =>
            requirement.capabilities.some((capability) =>
              requestedCapabilities.includes(capability),
            ),
          )
        : [];
    const refs = request.credentialRefs ?? [];
    if (
      capabilityCredentialRequirements.length === 0 &&
      (needsCredential || acceptsCliSession) &&
      refs.length === 0
    ) {
      issues.push({
        code: "auth_missing",
        message: `No credential reference was supplied for ${this.descriptor.displayName}`,
        remediation: `Register a ${this.descriptor.authMethods
          .filter((method) => method !== "manual" && method !== "none")
          .join(" or ")} credential and pass its cred:// reference`,
      });
    }
    for (const ref of refs) {
      if (!context.credentials) {
        issues.push({
          code: "auth_missing",
          message: `Credential ${ref} cannot be inspected without a broker`,
          remediation: "Inject a CredentialBroker into the provider context",
        });
        continue;
      }
      try {
        const inspection = await context.credentials.inspect(ref);
        credentialInspections.push(inspection);
        credentialResults.push({
          ref: inspection.ref,
          status: inspection.status,
          scopes: [...inspection.scopes],
          expiresAt: inspection.expiresAt,
        });
        if (inspection.status !== "available") {
          issues.push({
            code: "auth_invalid",
            message: `Credential ${ref} is ${inspection.status}`,
            remediation: "Test or replace the credential before applying a plan",
          });
        }
        const missing = scopeMissing(inspection.scopes, this.descriptor.requiredScopes);
        if (inspection.status === "available" && missing.length > 0) {
          issues.push({
            code: "auth_invalid",
            message: `Credential ${ref} has not declared required scopes: ${missing.join(", ")}`,
            remediation: "Replace it with a least-privilege credential that includes those scopes",
          });
        }
      } catch (error) {
        issues.push({
          code: "auth_invalid",
          message: context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
          remediation: "Register and test the referenced credential",
        });
      }
    }

    for (const requirement of capabilityCredentialRequirements) {
      const compatible = credentialInspections.filter(({ kind }) =>
        requirement.acceptedKinds.includes(kind),
      );
      if (compatible.length === 0) {
        issues.push({
          code: "auth_missing",
          message: `No ${requirement.acceptedKinds.join(" or ")} credential reference was supplied for ${requirement.purpose}`,
          remediation: `Register the ${requirement.purpose} credential in the broker and pass its cred:// reference`,
        });
      }
    }

    for (const limitation of this.descriptor.limitations) {
      issues.push({
        code: "provider_limitation",
        message: limitation,
        remediation: "Keep the limitation as an explicit manual or verification step",
      });
    }

    const isManualOnly = this.descriptor.transports.every((transport) => transport === "manual");
    const authIssue = issues.some(({ code }) => code === "auth_missing" || code === "auth_invalid");
    const unavailable = issues.some(({ code }) => code === "transport_missing");
    const capabilityIssue = issues.some(({ code }) => code === "capability_unknown");
    return {
      provider: this.descriptor.id,
      status: isManualOnly
        ? "manual_only"
        : unavailable
          ? "unavailable"
          : authIssue
            ? "auth_required"
            : capabilityIssue
              ? "degraded"
              : "ready",
      credentialRefs: credentialResults,
      transports: transportResults,
      issues,
    };
  }

  plan(request: ProviderPlanRequest): ProviderPlan {
    if (request.capabilities.length === 0) {
      throw new ProviderPlanError(
        "At least one provider capability must be requested",
        "invalid_plan",
      );
    }
    const unknown = request.capabilities.filter(
      (capability) => !this.descriptor.capabilities.includes(capability),
    );
    if (unknown.length > 0) {
      throw new ProviderPlanError(
        `${this.descriptor.id} does not support: ${unknown.join(", ")}`,
        "unknown_capability",
      );
    }
    const plan = this.buildPlan({ ...request, dryRun: request.dryRun ?? true });
    if (plan.provider !== this.descriptor.id) {
      throw new ProviderPlanError(
        `Plan provider ${plan.provider} does not match adapter ${this.descriptor.id}`,
        "invalid_plan",
      );
    }
    for (const operation of plan.operations) {
      if (operation.provider !== this.descriptor.id) {
        throw new ProviderPlanError(
          `Operation ${operation.id} belongs to ${operation.provider}`,
          "invalid_plan",
        );
      }
      const specCount = [operation.command, operation.http, operation.manual].filter(
        Boolean,
      ).length;
      if (specCount !== 1) {
        throw new ProviderPlanError(
          `Operation ${operation.id} must declare exactly one transport specification`,
          "invalid_plan",
        );
      }
      if (operation.existingResource) {
        const discovery = operation.existingResource;
        const discoverySpecCount = [discovery.command, discovery.http].filter(Boolean).length;
        if (
          discoverySpecCount !== 1 ||
          discovery.transport !== operation.transport ||
          (discovery.http !== undefined && discovery.http.method !== "GET") ||
          discovery.identityAssertions.length === 0 ||
          discovery.stateAssertions.length === 0
        ) {
          throw new ProviderPlanError(
            `Operation ${operation.id} has an invalid search-before-create declaration`,
            "invalid_plan",
          );
        }
      }
      if (operation.http?.credentialPreflight) {
        const preflight = operation.http.credentialPreflight;
        if (
          operation.http.method === "GET" ||
          !operation.http.auth ||
          preflight.requests.length === 0 ||
          preflight.requests.length > 4 ||
          preflight.requests.some(
            ({ url, assertions }) =>
              !preflightUrlMatchesOperation(url, operation.http!.url) || assertions.length === 0,
          )
        ) {
          throw new ProviderPlanError(
            `Operation ${operation.id} has an invalid same-credential preflight declaration`,
            "invalid_plan",
          );
        }
      }
      if (
        this.descriptor.id === "stripe" &&
        operation.http &&
        operation.http.method !== "GET" &&
        !operation.http.credentialPreflight
      ) {
        throw new ProviderPlanError(
          `Stripe operation ${operation.id} must prove the exact credential account and mode before mutation`,
          "invalid_plan",
        );
      }
    }
    return plan;
  }

  async apply(
    plan: ProviderPlan,
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionReport> {
    if (plan.provider !== this.descriptor.id) {
      throw new ProviderPlanError(
        `Cannot apply ${plan.provider} plan with ${this.descriptor.id} adapter`,
        "invalid_plan",
      );
    }
    const results: ProviderOperationExecution[] = [];
    const completed = new Map<string, ProviderTransportResult>();
    const dryRun = plan.dryRun || context.authorization !== "approved";
    if (
      !dryRun &&
      plan.operations.some(requiresDurableIdempotency) &&
      (!context.idempotencyLedger ||
        (context.idempotencyLedger.durability !== "durable_atomic" && !context.fixtureMode))
    ) {
      throw new ProviderPlanError(
        "Approved external provider apply requires a durable idempotency ledger",
        "invalid_plan",
      );
    }

    if (!dryRun) {
      for (const operation of plan.operations) {
        const capture = operation.command?.captureCredential ?? operation.http?.captureCredential;
        if (!capture) continue;
        if (!context.credentials) {
          throw new ProviderPlanError(
            `${operation.id} requires a credential broker for captured output`,
            "invalid_plan",
          );
        }
        const reference = context.credentials.getReference(capture.credentialRef);
        if (!reference || reference.provider !== operation.provider) {
          throw new ProviderPlanError(
            `${operation.id} credential capture target is not registered for ${operation.provider}`,
            "invalid_plan",
          );
        }
        const inspection = await context.credentials.inspect(capture.credentialRef);
        if (!inspection.writable) {
          throw new ProviderPlanError(
            `${operation.id} credential capture target is not writable`,
            "invalid_plan",
          );
        }
      }
    }

    for (const plannedOperation of plan.operations) {
      if (dryRun) {
        const result = dryRunResult();
        results.push({ operation: plannedOperation, result, reused: false });
        completed.set(plannedOperation.id, result);
        continue;
      }
      const blockedBy = plannedOperation.dependsOn.filter(
        (dependency) => completed.get(dependency)?.status !== "succeeded",
      );
      if (blockedBy.length > 0) {
        const result: ProviderTransportResult = {
          status: "skipped",
          message: `Blocked by incomplete dependencies: ${blockedBy.join(", ")}`,
          retryable: false,
        };
        results.push({ operation: plannedOperation, result, reused: false });
        completed.set(plannedOperation.id, result);
        continue;
      }
      const operation = materializeDependencies(plannedOperation, plan.operations, completed);
      if (!operation) {
        const result: ProviderTransportResult = {
          status: "failed",
          providerCode: "terminal_validation",
          message: `Could not resolve every declared dependency output for ${plannedOperation.action}`,
          retryable: false,
        };
        results.push({ operation: plannedOperation, result, reused: false });
        completed.set(plannedOperation.id, result);
        continue;
      }
      const operationRequestHash = requestHash(operation);
      const replay = {
        outputPaths: replayOutputPaths(plannedOperation, plan.operations),
      };
      const claim = await context.idempotencyLedger?.claim(
        operation.idempotencyKey,
        operationRequestHash,
      );
      if (claim?.status === "conflict") {
        const result = idempotencyFailure(
          "idempotency_conflict",
          "The idempotency key is already bound to a different provider request",
        );
        results.push({ operation, result, reused: false });
        completed.set(operation.id, result);
        continue;
      }
      if (
        claim?.status === "replay" &&
        (operation.reconcileOnReplay !== true || context.reuseSuccessfulOperations === true)
      ) {
        const result = context.redactor.redact(claim.result);
        results.push({ operation, result, reused: true });
        completed.set(operation.id, result);
        continue;
      }
      let transport: ProviderTransport;
      try {
        transport = this.resolveTransport(operation.transport, context);
      } catch (error) {
        const result: ProviderTransportResult = {
          status: "failed",
          providerCode: "terminal_validation",
          message: context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
          retryable: false,
          effectOutcome: "confirmed_no_write",
        };
        await context.idempotencyLedger?.settle(
          operation.idempotencyKey,
          operationRequestHash,
          "definitive_no_write",
          result,
          replay,
        );
        results.push({ operation, result, reused: false });
        completed.set(operation.id, result);
        continue;
      }
      if (claim?.status === "pending_reconciliation") {
        const result = await this.reconcileUnknownOutcome(
          operation,
          transport,
          claim.result,
          context,
        );
        const state =
          result.status === "succeeded"
            ? "succeeded"
            : result.effectOutcome === "confirmed_no_write"
              ? "definitive_no_write"
              : "pending_reconciliation";
        await context.idempotencyLedger?.settle(
          operation.idempotencyKey,
          operationRequestHash,
          state,
          result,
          replay,
        );
        results.push({ operation, result, reused: true });
        completed.set(operation.id, result);
        continue;
      }
      const existing = await discoverExistingResource(operation, transport, context);
      if (existing) {
        const settlement = existing.status === "succeeded" ? "succeeded" : "definitive_no_write";
        await context.idempotencyLedger?.settle(
          operation.idempotencyKey,
          operationRequestHash,
          settlement,
          existing,
          replay,
        );
        results.push({ operation, result: existing, reused: existing.status === "succeeded" });
        completed.set(operation.id, existing);
        continue;
      }
      let result: ProviderTransportResult;
      try {
        result = await transport.execute(operation, {
          credentials: context.credentials,
          redactor: context.redactor,
          signal: context.signal,
        });
      } catch (error) {
        result = {
          status: "failed",
          providerCode: "transport_exception",
          message: context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
          retryable: false,
          effectOutcome: "unknown",
        };
      }
      result = context.redactor.redact(result);
      if (result.status === "succeeded" && result.effectOutcome === undefined) {
        result = { ...result, effectOutcome: "confirmed_write" };
      }
      const settlement =
        result.status === "succeeded"
          ? "succeeded"
          : result.effectOutcome === "confirmed_no_write" ||
              result.status === "waiting_manual" ||
              result.status === "skipped"
            ? "definitive_no_write"
            : "pending_reconciliation";
      await context.idempotencyLedger?.settle(
        operation.idempotencyKey,
        operationRequestHash,
        settlement,
        result,
        replay,
      );
      results.push({ operation, result, reused: false });
      completed.set(operation.id, result);
    }

    return {
      planId: plan.id,
      provider: plan.provider,
      state: executionState(plan, results),
      operations: results,
    };
  }

  /**
   * Reconstructs request-bound operation state and performs only provider
   * reconciliation/read operations. This path deliberately never calls
   * ProviderTransport.execute; a confirmed no-write is released back to the
   * workflow so a later authorized handler attempt may apply it safely.
   */
  async reconcile(
    plan: ProviderPlan,
    context: ProviderExecutionContext,
  ): Promise<ProviderExecutionReport> {
    if (plan.provider !== this.descriptor.id) {
      throw new ProviderPlanError(
        `Cannot reconcile ${plan.provider} plan with ${this.descriptor.id} adapter`,
        "invalid_plan",
      );
    }
    if (
      !context.idempotencyLedger ||
      (context.idempotencyLedger.durability !== "durable_atomic" && !context.fixtureMode)
    ) {
      throw new ProviderPlanError(
        "Provider reconciliation requires a durable idempotency ledger",
        "invalid_plan",
      );
    }

    const results: ProviderOperationExecution[] = [];
    const completed = new Map<string, ProviderTransportResult>();
    for (const plannedOperation of plan.operations) {
      const blockedBy = plannedOperation.dependsOn.filter(
        (dependency) => completed.get(dependency)?.status !== "succeeded",
      );
      if (blockedBy.length > 0) {
        const result: ProviderTransportResult = {
          status: "skipped",
          message: `Reconciliation blocked by incomplete dependencies: ${blockedBy.join(", ")}`,
          retryable: false,
          effectOutcome: "confirmed_no_write",
        };
        results.push({ operation: plannedOperation, result, reused: true });
        completed.set(plannedOperation.id, result);
        continue;
      }

      const operation = materializeDependencies(plannedOperation, plan.operations, completed);
      if (!operation) {
        const result: ProviderTransportResult = {
          status: "failed",
          providerCode: "terminal_validation",
          message: `Could not reconstruct every declared dependency output for ${plannedOperation.action}`,
          retryable: false,
          effectOutcome: "unknown",
        };
        results.push({ operation: plannedOperation, result, reused: true });
        completed.set(plannedOperation.id, result);
        continue;
      }

      const operationRequestHash = requestHash(operation);
      const replay = { outputPaths: replayOutputPaths(plannedOperation, plan.operations) };
      const claim = await context.idempotencyLedger.claim(
        operation.idempotencyKey,
        operationRequestHash,
      );
      if (claim.status === "conflict") {
        const result = idempotencyFailure(
          "idempotency_conflict",
          "The idempotency key is bound to a different provider request; reconciliation stopped",
        );
        results.push({ operation, result, reused: true });
        completed.set(operation.id, result);
        continue;
      }
      if (claim.status === "acquired") {
        const result = idempotencyFailure(
          "unknown_outcome_reconciliation_required",
          "No request-bound provider attempt was recorded; provider write was not invoked",
          "confirmed_no_write",
          true,
        );
        await context.idempotencyLedger.settle(
          operation.idempotencyKey,
          operationRequestHash,
          "definitive_no_write",
          result,
          replay,
        );
        results.push({ operation, result, reused: true });
        completed.set(operation.id, result);
        continue;
      }
      if (claim.status === "replay") {
        const result = context.redactor.redact(claim.result);
        results.push({ operation, result, reused: true });
        completed.set(operation.id, result);
        continue;
      }

      let result: ProviderTransportResult;
      try {
        const transport = this.resolveTransport(operation.transport, context);
        result = await this.reconcileUnknownOutcome(operation, transport, claim.result, context);
      } catch (error) {
        result = idempotencyFailure(
          "unknown_outcome_reconciliation_required",
          context.redactor.redactText(
            `Provider reconciliation is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      const settlement =
        result.status === "succeeded"
          ? "succeeded"
          : result.effectOutcome === "confirmed_no_write"
            ? "definitive_no_write"
            : "pending_reconciliation";
      await context.idempotencyLedger.settle(
        operation.idempotencyKey,
        operationRequestHash,
        settlement,
        result,
        replay,
      );
      results.push({ operation, result, reused: true });
      completed.set(operation.id, result);
    }

    return {
      planId: plan.id,
      provider: plan.provider,
      state: executionState(plan, results),
      operations: results,
    };
  }

  async readBack(
    report: ProviderExecutionReport,
    context: ProviderExecutionContext,
  ): Promise<ProviderReadBackReport> {
    const checks: ProviderReadBackResult[] = [];
    for (const execution of report.operations) {
      const { operation, result } = execution;
      if (result.status === "waiting_manual") {
        checks.push({
          operationId: operation.id,
          status: "manual_required",
          message: "Human completion evidence has not been supplied",
        });
        continue;
      }
      if (result.status !== "succeeded") {
        checks.push({
          operationId: operation.id,
          status: "unavailable",
          message: `Read-back skipped because execution was ${result.status}`,
        });
        continue;
      }
      const transport = this.resolveTransport(
        operation.readBack?.transport ?? operation.transport,
        context,
      );
      if (!transport.readBack) {
        checks.push({
          operationId: operation.id,
          status: result.verified ? "matched" : "unavailable",
          message: result.verified
            ? "Execution result included verification evidence"
            : "The injected transport does not implement read-back",
        });
        continue;
      }
      try {
        checks.push(
          context.redactor.redact(
            await transport.readBack(operation, result, {
              credentials: context.credentials,
              redactor: context.redactor,
              signal: context.signal,
            }),
          ),
        );
      } catch (error) {
        checks.push({
          operationId: operation.id,
          status: "unavailable",
          message: context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    }
    return { planId: report.planId, provider: report.provider, results: checks };
  }

  verify(
    report: ProviderExecutionReport,
    readBack: ProviderReadBackReport,
  ): ProviderVerificationReport {
    if (report.planId !== readBack.planId || report.provider !== readBack.provider) {
      throw new ProviderPlanError(
        "Read-back report does not belong to this execution",
        "invalid_plan",
      );
    }
    const statuses = readBack.results.map(({ status }) => status);
    const state: ProviderVerificationReport["state"] = statuses.some(
      (status) => status === "mismatched",
    )
      ? "failed"
      : statuses.some((status) => status === "manual_required")
        ? "pending"
        : statuses.length > 0 && statuses.every((status) => status === "matched")
          ? "verified"
          : "unavailable";
    return {
      planId: report.planId,
      provider: report.provider,
      state,
      checks: readBack.results,
    };
  }

  private resolveTransport(
    kind: ProviderTransport["kind"],
    context: ProviderExecutionContext,
  ): ProviderTransport {
    const transport =
      context.transports[kind] ?? (kind === "manual" ? new ManualProviderTransport() : undefined);
    if (!transport) throw new Error(`No ${kind} transport was injected`);
    return transport;
  }

  private async reconcileUnknownOutcome(
    operation: ProviderOperation,
    transport: ProviderTransport,
    prior: ProviderTransportResult,
    context: ProviderExecutionContext,
  ): Promise<ProviderTransportResult> {
    let discoveryFailure: ProviderTransportResult | null = null;
    try {
      // A deterministic search is also the only generic reconciliation path
      // for HTTP providers whose POST timed out after the remote commit. Run
      // it again on resume before attempting an id-based read-back, because an
      // ambiguous response often contains no resource id to interpolate.
      if (operation.existingResource) {
        const discovered = await discoverExistingResource(operation, transport, context);
        if (discovered?.status === "succeeded") {
          return {
            ...discovered,
            message: `Unknown provider outcome reconciled by deterministic lookup: ${discovered.message}`,
            retryable: false,
            verified: true,
            effectOutcome: "confirmed_write",
          };
        }
        discoveryFailure = discovered;
      }
      if (transport.reconcile) {
        const reconciliation = context.redactor.redact(
          await transport.reconcile(operation, {
            credentials: context.credentials,
            redactor: context.redactor,
            signal: context.signal,
          }),
        );
        if (reconciliation.status === "matched") {
          return {
            status: "succeeded",
            message: reconciliation.message,
            output: reconciliation.result?.output ?? reconciliation.evidence,
            statusCode: reconciliation.result?.statusCode,
            providerCode: reconciliation.result?.providerCode,
            retryable: false,
            verified: true,
            effectOutcome: "confirmed_write",
          };
        }
        if (reconciliation.status === "definitive_no_write") {
          return {
            status: "failed",
            providerCode: "unknown_outcome_reconciliation_required",
            message: reconciliation.message,
            retryable: true,
            verified: true,
            effectOutcome: "confirmed_no_write",
          };
        }
      } else if (operation.readBack && transport.readBack) {
        const readBack = context.redactor.redact(
          await transport.readBack(operation, prior, {
            credentials: context.credentials,
            redactor: context.redactor,
            signal: context.signal,
          }),
        );
        if (readBack.status === "matched") {
          return {
            status: "succeeded",
            message: `Unknown provider outcome reconciled: ${readBack.message}`,
            output: readBack.evidence,
            retryable: false,
            verified: true,
            effectOutcome: "confirmed_write",
          };
        }
      }
    } catch (error) {
      return idempotencyFailure(
        "unknown_outcome_reconciliation_required",
        context.redactor.redactText(
          `Provider reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if (
      operation.http?.nativeIdempotency === true &&
      (!discoveryFailure ||
        discoveryFailure.providerCode === "existing_resource_credential_unavailable")
    ) {
      try {
        const retried = context.redactor.redact(
          await transport.execute(operation, {
            credentials: context.credentials,
            redactor: context.redactor,
            signal: context.signal,
          }),
        );
        if (retried.status === "succeeded") {
          return {
            ...retried,
            message: `Unknown provider outcome recovered through the provider's native idempotency key: ${retried.message}`,
            retryable: false,
            verified: false,
            effectOutcome: "confirmed_write",
          };
        }
      } catch {
        // The original write is still ambiguous; keep the durable ledger in
        // reconciliation instead of treating the retry failure as no-write.
      }
    }
    return idempotencyFailure(
      "unknown_outcome_reconciliation_required",
      discoveryFailure
        ? `The prior provider write remains ambiguous after bounded lookup: ${discoveryFailure.message}`
        : "The prior provider write remains ambiguous; the write was not repeated",
    );
  }
}
