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

const DEPENDENCY_RESULT = /\{dependency\.([a-z0-9_-]+)\.([a-zA-Z0-9_.-]+)\}/g;

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

    if (!dryRun) {
      for (const operation of plan.operations) {
        const capture = operation.command?.captureCredential;
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
      const existing = await context.idempotencyLedger?.get(operation.idempotencyKey);
      if (existing?.status === "succeeded" && operation.reconcileOnReplay !== true) {
        const result = context.redactor.redact(existing);
        results.push({ operation, result, reused: true });
        completed.set(operation.id, result);
        continue;
      }
      const transport = this.resolveTransport(operation.transport, context);
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
        };
      }
      result = context.redactor.redact(result);
      if (result.status === "succeeded") {
        await context.idempotencyLedger?.put(operation.idempotencyKey, result);
      }
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
}
