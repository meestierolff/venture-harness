import type {
  RecursiveCommandRuntime,
  RecursiveServiceCommandInput,
  RecursiveServiceCommandOutput,
  RecursiveServiceReconcileInput,
  RecursiveServiceReconcileOutput,
} from "../../packages/agent-runtime/src/recursive";
import {
  CommandDefinitiveNoEffectError,
  type CommandHandlerContext,
} from "@venture-harness/command-bus";
import type { JsonObject } from "@venture-harness/core";
import type {
  ProviderReconciliationResult,
  ServiceReconciliationResult,
  VentureRuntimeService,
} from "./service";
import type { ExecutionIdentity, TenantScope } from "./types";
import { ProviderOperationError, VentureRuntimeError } from "./types";

export interface RecursiveProviderExecutionRequest {
  readonly commandId: string;
  readonly input: RecursiveServiceCommandInput;
  readonly identity: ExecutionIdentity;
}

export interface RecursiveAgentTokenRequest {
  readonly scope: TenantScope & { agentId: string };
  readonly commandId: string;
  readonly customerOrganizationId: string;
}

export interface RecursiveProviderReconciliationRequest {
  readonly reconciliationCommandId: string;
  readonly executionCommandId: string;
  readonly input: RecursiveServiceReconcileInput;
  readonly providerOperationId: string;
  readonly identity: ExecutionIdentity;
}

export interface RecursiveVentureCommandRuntimeOptions {
  readonly service: VentureRuntimeService;
  /** Resolve an agent token only inside the trusted host boundary. */
  readonly resolveAgentToken?: (request: RecursiveAgentTokenRequest) => Promise<string> | string;
  /** The credential value is a separate argument and must never be serialized. */
  readonly executeProvider: (
    request: RecursiveProviderExecutionRequest,
    credentialValue: string,
  ) => Promise<JsonObject>;
  /** Provider read-back only: this callback must never repeat the original operation. */
  readonly reconcileProvider?: (
    request: RecursiveProviderReconciliationRequest,
    credentialValue: string,
  ) => Promise<ProviderReconciliationResult<JsonObject>>;
}

function scopeFromContext(
  input: { customerOrganizationId: string },
  context: CommandHandlerContext,
): TenantScope {
  const base = {
    operatorId: context.context.tenant.organizationId,
    ventureId: context.context.tenant.ventureId,
    customerOrganizationId: input.customerOrganizationId,
  };
  if (context.context.identity.kind === "user") {
    return { ...base, userId: context.context.identity.actorId };
  }
  if (context.context.identity.kind === "agent") {
    return { ...base, agentId: context.context.identity.actorId };
  }
  throw new Error("recursive service commands require an authenticated user or agent identity");
}

const DEFINITIVE_PRE_EFFECT_CODES = new Set<VentureRuntimeError["code"]>([
  "tenant_scope_mismatch",
  "not_found",
  "subscription_inactive",
  "entitlement_missing",
  "entitlement_exhausted",
  "service_grant_invalid",
  "agent_grant_invalid",
  "connection_unavailable",
  "capability_unavailable",
  "credential_scope_mismatch",
  "customer_offboarded",
  "idempotency_conflict",
  "idempotency_replay",
  "authorization_envelope_invalid",
]);

function rethrowClassified(error: unknown): never {
  if (error instanceof ProviderOperationError && error.outcome === "definitive_no_effect") {
    throw new CommandDefinitiveNoEffectError(error.message, "handler_failed");
  }
  if (error instanceof VentureRuntimeError && DEFINITIVE_PRE_EFFECT_CODES.has(error.code)) {
    throw new CommandDefinitiveNoEffectError(
      error.message,
      error.code === "idempotency_conflict" || error.code === "idempotency_replay"
        ? "idempotency_conflict"
        : "authorization_denied",
    );
  }
  throw error;
}

/**
 * Adapt the recursive customer service to the canonical CommandBus handler.
 * Operator and venture identity come exclusively from the authenticated
 * command context; the customer remains an explicit third tenancy dimension.
 */
export function createRecursiveVentureCommandRuntime(
  options: RecursiveVentureCommandRuntimeOptions,
): RecursiveCommandRuntime {
  return Object.freeze({
    async execute(
      input: RecursiveServiceCommandInput,
      context: CommandHandlerContext,
    ): Promise<RecursiveServiceCommandOutput> {
      const scope = scopeFromContext(input, context);
      const agentToken = scope.agentId
        ? await options.resolveAgentToken?.({
            scope: scope as TenantScope & { agentId: string },
            commandId: context.commandId,
            customerOrganizationId: input.customerOrganizationId,
          })
        : undefined;
      let data: JsonObject;
      try {
        data = await options.service.execute(
          {
            scope,
            subscriptionId: input.subscriptionId,
            entitlementId: input.entitlementId,
            serviceGrantId: input.serviceGrantId,
            providerConnectionId: input.providerConnectionId,
            capability: input.capability,
            commandId: context.commandId,
            authorizationEnvelopeId: input.authorizationEnvelopeId,
            runId: input.runId,
            nodeId: input.nodeId,
            correlationId: input.correlationId,
            causationId: input.causationId,
            idempotencyKey: context.idempotencyKey,
            usageUnits: input.usageUnits,
            operationRequest: input.payload,
            ...(agentToken ? { agentToken } : {}),
          },
          (credentialValue, identity) =>
            options.executeProvider(
              {
                commandId: context.commandId,
                input,
                identity,
              },
              credentialValue,
            ),
        );
      } catch (error) {
        rethrowClassified(error);
      }
      return {
        commandId: context.commandId,
        operatorId: scope.operatorId,
        ventureId: scope.ventureId,
        customerOrganizationId: scope.customerOrganizationId,
        status: "completed",
        data,
      };
    },
    async reconcile(
      input: RecursiveServiceReconcileInput,
      context: CommandHandlerContext,
      executionCommandId: string,
    ): Promise<RecursiveServiceReconcileOutput> {
      const scope = scopeFromContext(input, context);
      if (!options.reconcileProvider) {
        throw new CommandDefinitiveNoEffectError(
          "provider read-back adapter is not configured",
          "handler_failed",
        );
      }
      let reconciled: ServiceReconciliationResult<JsonObject>;
      try {
        reconciled = await options.service.reconcile(
          {
            scope,
            subscriptionId: input.subscriptionId,
            entitlementId: input.entitlementId,
            serviceGrantId: input.serviceGrantId,
            providerConnectionId: input.providerConnectionId,
            capability: input.capability,
            commandId: executionCommandId,
            reconciliationAuthorizationEnvelopeId: input.reconciliationAuthorizationEnvelopeId,
            reconciliationCommandId: context.commandId,
            runId: input.runId,
            nodeId: input.nodeId,
            correlationId: input.correlationId,
            causationId: input.causationId,
            idempotencyKey: input.operationIdempotencyKey,
            usageUnits: input.usageUnits,
            operationRequest: input.payload,
          },
          (providerOperationId, credentialValue, identity) =>
            options.reconcileProvider!(
              {
                reconciliationCommandId: context.commandId,
                executionCommandId,
                input,
                providerOperationId,
                identity,
              },
              credentialValue,
            ),
        );
      } catch (error) {
        rethrowClassified(error);
      }
      return {
        commandId: context.commandId,
        executionCommandId,
        operatorId: scope.operatorId,
        ventureId: scope.ventureId,
        customerOrganizationId: scope.customerOrganizationId,
        providerOperationId: reconciled.providerOperationId,
        status: reconciled.status,
        data:
          reconciled.status === "completed"
            ? (reconciled.result as JsonObject)
            : reconciled.status === "released"
              ? { confirmedNoEffect: true }
              : {
                  manualRequired: true,
                  reason: reconciled.reason,
                  message: reconciled.message,
                  reapplied: false,
                },
      };
    },
  });
}
