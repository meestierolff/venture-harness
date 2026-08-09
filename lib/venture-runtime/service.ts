import { createHash } from "node:crypto";
import { assertCredentialFree, stableJson, type JsonValue } from "@venture-harness/core";
import type { TenantCredentialBroker } from "./credential-broker";
import type { DurableServiceOperationBinding, VentureRuntimeStore } from "./store";
import type { ExecutionIdentity, TenantScope } from "./types";
import { ProviderOperationError, VentureRuntimeError } from "./types";

export interface ExecuteServiceInput {
  scope: TenantScope;
  subscriptionId: string;
  entitlementId: string;
  serviceGrantId: string;
  providerConnectionId: string;
  capability: string;
  commandId: string;
  authorizationEnvelopeId: string;
  runId: string;
  nodeId: string;
  correlationId: string;
  causationId: string;
  idempotencyKey: string;
  usageUnits: number;
  /** Credential-free provider request data included in the durable request binding. */
  operationRequest?: JsonValue;
  agentToken?: string;
}

export interface ReconcileServiceInput extends Omit<
  ExecuteServiceInput,
  "authorizationEnvelopeId" | "agentToken"
> {
  /** Fresh, read-back-only authorization; it never revives the original write grant. */
  reconciliationAuthorizationEnvelopeId: string;
  reconciliationCommandId: string;
}

export type ProviderReconciliationResult<T extends JsonValue> =
  | { readonly outcome: "completed"; readonly result: T }
  | { readonly outcome: "definitive_no_effect" }
  | { readonly outcome: "unknown" };

export type ServiceReconciliationResult<T extends JsonValue> =
  | {
      readonly status: "completed";
      readonly providerOperationId: string;
      readonly result: T;
    }
  | {
      readonly status: "released";
      readonly providerOperationId: string;
    }
  | {
      readonly status: "manual_required";
      readonly providerOperationId: string;
      readonly reason: "customer_offboarded" | "connection_unavailable" | "credential_unavailable";
      readonly message: string;
    };

export interface ProviderOutputValidationContext {
  readonly phase: "execute" | "reconcile";
  readonly commandId: string;
  readonly provider: string;
  readonly capability: string;
}

/** An exact command/provider/capability output allowlist owned by the trusted host. */
export interface ProviderOutputPolicy {
  readonly commandId: string;
  readonly provider: string;
  readonly capability: string;
  readonly validate: (result: JsonValue, context: ProviderOutputValidationContext) => boolean;
}

export interface VentureRuntimeServiceOptions {
  now?: () => Date;
  /** Missing or duplicate policies fail closed before a provider operation. */
  providerOutputPolicies: readonly ProviderOutputPolicy[];
  verifyAuthorization(input: {
    authorizationEnvelopeId: string;
    scope: TenantScope;
    commandId: string;
    capability: string;
    serviceGrantId: string;
    providerConnectionId: string;
    runId: string;
    nodeId: string;
    at: Date;
  }): boolean;
  verifyReconciliationAuthorization?(input: {
    reconciliationAuthorizationEnvelopeId: string;
    scope: TenantScope;
    reconciliationCommandId: string;
    executionCommandId: string;
    capability: string;
    serviceGrantId: string;
    providerConnectionId: string;
    providerOperationId: string;
    runId: string;
    nodeId: string;
    at: Date;
  }): boolean;
}

function credentialFreeOperationRequestHash(value: JsonValue): string {
  try {
    assertCredentialFree(value, "provider operation request");
  } catch {
    throw new VentureRuntimeError(
      "credential_leak_detected",
      "provider operation request contains forbidden credential material",
    );
  }
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertCredentialFreeServiceIdentifiers(
  input: ExecuteServiceInput | ReconcileServiceInput,
  additional: readonly string[] = [],
): void {
  const values = [
    input.scope.operatorId,
    input.scope.ventureId,
    input.scope.customerOrganizationId,
    input.scope.userId,
    input.scope.agentId,
    input.subscriptionId,
    input.entitlementId,
    input.serviceGrantId,
    input.providerConnectionId,
    input.capability,
    input.commandId,
    "authorizationEnvelopeId" in input ? input.authorizationEnvelopeId : undefined,
    input.runId,
    input.nodeId,
    input.correlationId,
    input.causationId,
    input.idempotencyKey,
    ...additional,
  ];
  try {
    for (const value of values) {
      if (value !== undefined) assertCredentialFree(value, "service identifier");
    }
  } catch {
    throw new VentureRuntimeError(
      "credential_leak_detected",
      "service identifiers contain forbidden credential material",
    );
  }
}

export interface VentureRuntimeService {
  execute<T extends JsonValue>(
    input: ExecuteServiceInput,
    providerOperation: (secret: string, identity: ExecutionIdentity) => Promise<T>,
  ): Promise<T>;
  reconcile<T extends JsonValue>(
    input: ReconcileServiceInput,
    readBack: (
      providerOperationId: string,
      secret: string,
      identity: ExecutionIdentity,
    ) => Promise<ProviderReconciliationResult<T>>,
  ): Promise<ServiceReconciliationResult<T>>;
  offboard(scope: TenantScope, at?: Date): void;
}

export function createVentureRuntimeService(
  store: VentureRuntimeStore,
  credentials: TenantCredentialBroker,
  options: VentureRuntimeServiceOptions,
): VentureRuntimeService {
  const now = options.now ?? (() => new Date());
  const providerOutputPolicies = new Map<string, ProviderOutputPolicy>();

  function providerOutputPolicyKey(
    commandId: string,
    provider: string,
    capability: string,
  ): string {
    return `${commandId}\u0000${provider}\u0000${capability}`;
  }

  for (const policy of options.providerOutputPolicies) {
    if (![policy.commandId, policy.provider, policy.capability].every((value) => value.trim())) {
      throw new Error("provider output policies require command, provider, and capability");
    }
    const key = providerOutputPolicyKey(policy.commandId, policy.provider, policy.capability);
    if (providerOutputPolicies.has(key)) {
      throw new Error(
        `duplicate provider output policy for ${policy.commandId}/${policy.provider}/${policy.capability}`,
      );
    }
    providerOutputPolicies.set(key, policy);
  }

  function providerOutputPolicy(
    commandId: string,
    provider: string,
    capability: string,
  ): ProviderOutputPolicy {
    const policy = providerOutputPolicies.get(
      providerOutputPolicyKey(commandId, provider, capability),
    );
    if (!policy) {
      throw new VentureRuntimeError(
        "capability_unavailable",
        "provider output policy is not configured for this command and capability",
      );
    }
    return policy;
  }

  function assertAllowedProviderOutput(
    policy: ProviderOutputPolicy,
    result: JsonValue,
    phase: ProviderOutputValidationContext["phase"],
  ): void {
    credentials.assertSafeOutput(result);
    let allowed = false;
    try {
      allowed =
        policy.validate(result, {
          phase,
          commandId: policy.commandId,
          provider: policy.provider,
          capability: policy.capability,
        }) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new VentureRuntimeError(
        "provider_output_invalid",
        "provider output did not match the trusted command allowlist",
      );
    }
  }

  function authorize(input: ExecuteServiceInput) {
    if (!input.scope.userId && !input.agentToken) {
      throw new VentureRuntimeError(
        "tenant_scope_mismatch",
        "user or agent authorization required",
      );
    }
    if (input.scope.agentId && !input.agentToken) {
      throw new VentureRuntimeError("agent_grant_invalid", "agent token required");
    }
    const organization = store.organization(input.scope);
    if (organization.status !== "active") {
      throw new VentureRuntimeError("customer_offboarded", "customer is offboarded");
    }
    if (input.scope.userId && !store.hasMembership(input.scope)) {
      throw new VentureRuntimeError("tenant_scope_mismatch", "active membership required");
    }
    const at = now();
    let authorizedAgentId: string | undefined;
    if (input.agentToken) {
      const digest = createHash("sha256").update(input.agentToken).digest("hex");
      const grant = store.agentGrantByToken(input.scope, digest);
      if (
        grant.revokedAt ||
        new Date(grant.expiresAt) <= at ||
        !grant.scopes.includes(input.commandId)
      ) {
        throw new VentureRuntimeError("agent_grant_invalid", "agent grant is invalid");
      }
      authorizedAgentId = grant.agentId;
    }
    const effectiveScope: TenantScope = {
      ...input.scope,
      ...(authorizedAgentId ? { agentId: authorizedAgentId } : {}),
    };
    const subscription = store.subscriptionFor(effectiveScope, input.subscriptionId);
    if (subscription.status !== "active") {
      throw new VentureRuntimeError("subscription_inactive", "active subscription required");
    }
    const entitlement = store.entitlementFor(effectiveScope, input.capability, input.entitlementId);
    if (entitlement.status !== "active") {
      throw new VentureRuntimeError("entitlement_exhausted", "entitlement is not active");
    }
    if (entitlement.subscriptionId !== subscription.subscriptionId) {
      throw new VentureRuntimeError(
        "entitlement_missing",
        "entitlement is not attached to the active subscription",
      );
    }
    const serviceGrant = store.serviceGrant(effectiveScope, input.serviceGrantId);
    if (
      serviceGrant.revokedAt ||
      at < new Date(serviceGrant.notBefore) ||
      at >= new Date(serviceGrant.expiresAt)
    ) {
      throw new VentureRuntimeError("service_grant_invalid", "service grant is invalid");
    }
    const blueprint = store.blueprint(
      effectiveScope,
      serviceGrant.blueprintId,
      serviceGrant.blueprintVersion,
    );
    if (blueprint.commandId !== input.commandId) {
      throw new VentureRuntimeError("service_grant_invalid", "command is outside service grant");
    }
    if (!blueprint.requiredCapabilities.includes(input.capability)) {
      throw new VentureRuntimeError(
        "capability_unavailable",
        "capability is outside the service blueprint",
      );
    }
    if (!serviceGrant.connectionIds.includes(input.providerConnectionId)) {
      throw new VentureRuntimeError(
        "service_grant_invalid",
        "provider connection is outside service grant",
      );
    }
    const connection = store.connection(effectiveScope, input.providerConnectionId);
    if (connection.status !== "verified" || connection.revokedAt) {
      throw new VentureRuntimeError("connection_unavailable", "provider connection unavailable");
    }
    if (!connection.capabilities.includes(input.capability)) {
      throw new VentureRuntimeError(
        "capability_unavailable",
        "provider connection lacks required capability",
      );
    }
    if (
      !options.verifyAuthorization({
        authorizationEnvelopeId: input.authorizationEnvelopeId,
        scope: effectiveScope,
        commandId: input.commandId,
        capability: input.capability,
        serviceGrantId: serviceGrant.serviceGrantId,
        providerConnectionId: connection.connectionId,
        runId: input.runId,
        nodeId: input.nodeId,
        at,
      })
    ) {
      throw new VentureRuntimeError(
        "authorization_envelope_invalid",
        "active authorization envelope required",
      );
    }
    return { effectiveScope, subscription, entitlement, serviceGrant, connection };
  }

  function requestIdentity(
    input: ExecuteServiceInput,
    authorized: ReturnType<typeof authorize>,
    operationRequestHash: string,
  ): { requestHash: string; providerOperationId: string; identity: ExecutionIdentity } {
    const requestHash = createHash("sha256")
      .update(
        stableJson({
          operatorId: authorized.effectiveScope.operatorId,
          ventureId: authorized.effectiveScope.ventureId,
          customerOrganizationId: authorized.effectiveScope.customerOrganizationId,
          actorId:
            authorized.effectiveScope.agentId ?? authorized.effectiveScope.userId ?? "anonymous",
          subscriptionId: authorized.subscription.subscriptionId,
          entitlementId: authorized.entitlement.entitlementId,
          serviceGrantId: authorized.serviceGrant.serviceGrantId,
          commandId: input.commandId,
          capability: input.capability,
          providerConnectionId: authorized.connection.connectionId,
          authorizationEnvelopeId: input.authorizationEnvelopeId,
          runId: input.runId,
          nodeId: input.nodeId,
          correlationId: input.correlationId,
          causationId: input.causationId,
          usageUnits: input.usageUnits,
          operationRequestHash,
        }),
      )
      .digest("hex");
    const providerOperationId = `svc_op_${createHash("sha256")
      .update(
        `${authorized.effectiveScope.operatorId}\u0000${authorized.effectiveScope.ventureId}\u0000${authorized.effectiveScope.customerOrganizationId}\u0000${input.idempotencyKey}\u0000${requestHash}`,
      )
      .digest("hex")}`;
    const identity: ExecutionIdentity = {
      ...authorized.effectiveScope,
      subscriptionId: authorized.subscription.subscriptionId,
      entitlementId: authorized.entitlement.entitlementId,
      serviceGrantId: authorized.serviceGrant.serviceGrantId,
      authorizationEnvelopeId: input.authorizationEnvelopeId,
      providerConnectionId: authorized.connection.connectionId,
      runId: input.runId,
      nodeId: input.nodeId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      providerOperationId,
    };
    return { requestHash, providerOperationId, identity };
  }

  async function execute<T extends JsonValue>(
    input: ExecuteServiceInput,
    providerOperation: (secret: string, identity: ExecutionIdentity) => Promise<T>,
  ): Promise<T> {
    assertCredentialFreeServiceIdentifiers(input);
    const authorized = authorize(input);
    const { effectiveScope, entitlement, serviceGrant, connection } = authorized;
    const outputPolicy = providerOutputPolicy(
      input.commandId,
      connection.provider,
      input.capability,
    );
    const operationRequest = input.operationRequest ?? null;
    const operationRequestHash = credentialFreeOperationRequestHash(operationRequest);
    const { requestHash, providerOperationId, identity } = requestIdentity(
      input,
      authorized,
      operationRequestHash,
    );
    const reservation = store.reserveEntitlementUsage(
      effectiveScope,
      entitlement.entitlementId,
      serviceGrant.serviceGrantId,
      input.commandId,
      connection.connectionId,
      input.usageUnits,
      input.idempotencyKey,
      requestHash,
      providerOperationId,
      {
        identity,
        commandId: input.commandId,
        capability: input.capability,
        provider: connection.provider,
        usageUnits: input.usageUnits,
        operationRequestHash,
        requestHash,
        providerOperationId,
      },
    );
    if (reservation === "replay") {
      throw new VentureRuntimeError(
        "idempotency_replay",
        "request already exists; reconcile its recorded outcome",
      );
    }
    store.appendAudit(identity, "service.execution.authorized", {
      commandId: input.commandId,
      capability: input.capability,
      usageUnits: input.usageUnits,
      providerOperationId,
    });

    let result: T;
    try {
      result = await credentials.withSecret(effectiveScope, connection.connectionId, (secret) =>
        providerOperation(secret, identity),
      );
      assertAllowedProviderOutput(outputPolicy, result, "execute");
    } catch (error) {
      if (
        (error instanceof ProviderOperationError && error.outcome === "definitive_no_effect") ||
        (error instanceof VentureRuntimeError && error.code === "credential_scope_mismatch")
      ) {
        store.releaseEntitlementUsage(effectiveScope, input.idempotencyKey);
        store.appendAudit(identity, "service.execution.rejected", {
          commandId: input.commandId,
          outcome: "definitive_no_effect",
        });
        throw error;
      }
      store.settleEntitlementUsage(effectiveScope, input.idempotencyKey, "unknown");
      store.appendAudit(identity, "service.execution.unknown", {
        commandId: input.commandId,
        outcome: "unknown",
        providerOperationId,
      });
      throw new VentureRuntimeError(
        "external_outcome_unknown",
        "provider outcome is unknown and requires reconciliation",
      );
    }
    try {
      store.settleEntitlementUsage(effectiveScope, input.idempotencyKey, "completed", result);
    } catch (error) {
      if (store.usageStatus(effectiveScope, input.idempotencyKey) === "reserved") {
        store.settleEntitlementUsage(effectiveScope, input.idempotencyKey, "unknown");
      }
      throw error;
    }
    store.appendAudit(identity, "service.execution.completed", {
      commandId: input.commandId,
      provider: connection.provider,
      externalAccountId: connection.externalAccountId,
      providerOperationId,
    });
    return result;
  }

  function immutableReconciliationRequest(
    input: ReconcileServiceInput,
    binding: DurableServiceOperationBinding,
  ): boolean {
    const identity = binding.identity;
    return (
      input.scope.operatorId === identity.operatorId &&
      input.scope.ventureId === identity.ventureId &&
      input.scope.customerOrganizationId === identity.customerOrganizationId &&
      input.subscriptionId === identity.subscriptionId &&
      input.entitlementId === identity.entitlementId &&
      input.serviceGrantId === identity.serviceGrantId &&
      input.providerConnectionId === identity.providerConnectionId &&
      input.commandId === binding.commandId &&
      input.capability === binding.capability &&
      input.runId === identity.runId &&
      input.nodeId === identity.nodeId &&
      input.correlationId === identity.correlationId &&
      input.causationId === identity.causationId &&
      input.usageUnits === binding.usageUnits &&
      credentialFreeOperationRequestHash(input.operationRequest ?? null) ===
        binding.operationRequestHash
    );
  }

  function manualRequired(
    providerOperationId: string,
    reason: Extract<
      ServiceReconciliationResult<JsonValue>,
      { status: "manual_required" }
    >["reason"],
    message: string,
  ): ServiceReconciliationResult<never> {
    return { status: "manual_required", providerOperationId, reason, message };
  }

  async function reconcile<T extends JsonValue>(
    input: ReconcileServiceInput,
    readBack: (
      providerOperationId: string,
      secret: string,
      identity: ExecutionIdentity,
    ) => Promise<ProviderReconciliationResult<T>>,
  ): Promise<ServiceReconciliationResult<T>> {
    assertCredentialFreeServiceIdentifiers(input, [
      input.reconciliationAuthorizationEnvelopeId,
      input.reconciliationCommandId,
    ]);
    // Load by the immutable tenant/operation key first. The current actor and
    // fresh envelope can authorize read-back but can never change this binding.
    const usage = store.entitlementUsage(input.scope, input.idempotencyKey);
    if (!usage) {
      throw new VentureRuntimeError("not_found", "usage reservation was not found");
    }
    const binding = usage.operationBinding;
    if (
      !binding ||
      !binding.providerOperationId ||
      !binding.provider ||
      binding.providerOperationId !== usage.providerOperationId ||
      binding.requestHash !== usage.requestHash
    ) {
      throw new VentureRuntimeError(
        "external_outcome_unknown",
        "durable operation binding is unavailable; manual reconciliation is required",
      );
    }
    if (
      !immutableReconciliationRequest(input, binding) ||
      usage.entitlementId !== binding.identity.entitlementId ||
      usage.serviceGrantId !== binding.identity.serviceGrantId ||
      usage.commandId !== binding.commandId ||
      usage.connectionId !== binding.identity.providerConnectionId ||
      usage.units !== binding.usageUnits
    ) {
      throw new VentureRuntimeError(
        "idempotency_conflict",
        "reconciliation request does not match the durable provider operation",
      );
    }

    if (!input.scope.userId && !input.scope.agentId) {
      throw new VentureRuntimeError(
        "tenant_scope_mismatch",
        "an authenticated reconciliation actor is required",
      );
    }
    if (input.scope.userId && !store.hasMembership(input.scope)) {
      throw new VentureRuntimeError("tenant_scope_mismatch", "active membership required");
    }
    const at = now();
    const freshAuthorization = options.verifyReconciliationAuthorization
      ? options.verifyReconciliationAuthorization({
          reconciliationAuthorizationEnvelopeId: input.reconciliationAuthorizationEnvelopeId,
          scope: input.scope,
          reconciliationCommandId: input.reconciliationCommandId,
          executionCommandId: binding.commandId,
          capability: binding.capability,
          serviceGrantId: binding.identity.serviceGrantId,
          providerConnectionId: binding.identity.providerConnectionId,
          providerOperationId: binding.providerOperationId,
          runId: binding.identity.runId,
          nodeId: binding.identity.nodeId,
          at,
        })
      : options.verifyAuthorization({
          authorizationEnvelopeId: input.reconciliationAuthorizationEnvelopeId,
          scope: input.scope,
          commandId: input.reconciliationCommandId,
          capability: binding.capability,
          serviceGrantId: binding.identity.serviceGrantId,
          providerConnectionId: binding.identity.providerConnectionId,
          runId: binding.identity.runId,
          nodeId: binding.identity.nodeId,
          at,
        });
    if (!freshAuthorization) {
      throw new VentureRuntimeError(
        "authorization_envelope_invalid",
        "fresh reconciliation authorization envelope required",
      );
    }

    const { providerOperationId, identity } = binding;
    const outputPolicy = providerOutputPolicy(
      binding.commandId,
      binding.provider,
      binding.capability,
    );
    if (usage.status === "completed") {
      if (usage.result === undefined) {
        throw new VentureRuntimeError(
          "external_outcome_unknown",
          "completed legacy usage has no durable result and requires manual reconciliation",
        );
      }
      try {
        assertAllowedProviderOutput(outputPolicy, usage.result as T, "reconcile");
      } catch {
        store.quarantineEntitlementUsage(input.scope, input.idempotencyKey);
        store.appendAudit(identity, "service.execution.output_quarantined", {
          commandId: binding.commandId,
          reconciliationCommandId: input.reconciliationCommandId,
          outcome: "unknown",
          providerOperationId,
        });
        throw new VentureRuntimeError(
          "external_outcome_unknown",
          "stored provider output was rejected and requires sanitized reconciliation",
        );
      }
      return { status: "completed", providerOperationId, result: usage.result as T };
    }
    if (usage.status === "released") return { status: "released", providerOperationId };

    let organization;
    try {
      organization = store.organization(input.scope);
    } catch {
      return manualRequired(
        providerOperationId,
        "customer_offboarded",
        "Customer ownership cannot be verified; preserve the operation for manual reconciliation",
      );
    }
    if (organization.status !== "active") {
      return manualRequired(
        providerOperationId,
        "customer_offboarded",
        "Customer is offboarded; the original provider operation was not repeated",
      );
    }
    let connection;
    try {
      connection = store.connection(input.scope, identity.providerConnectionId);
    } catch {
      return manualRequired(
        providerOperationId,
        "connection_unavailable",
        "Provider connection ownership cannot be verified; manual reconciliation is required",
      );
    }
    if (
      connection.revokedAt ||
      connection.provider !== binding.provider ||
      !["verified", "degraded"].includes(connection.status) ||
      !connection.capabilities.includes(binding.capability)
    ) {
      return manualRequired(
        providerOperationId,
        "connection_unavailable",
        "Provider connection is unavailable; the original provider operation was not repeated",
      );
    }
    try {
      const credential = credentials.inspect(input.scope, connection.connectionId);
      if (credential.revoked) {
        return manualRequired(
          providerOperationId,
          "credential_unavailable",
          "Provider credential is revoked; manual provider-side reconciliation is required",
        );
      }
    } catch {
      return manualRequired(
        providerOperationId,
        "credential_unavailable",
        "Provider credential is unavailable; manual provider-side reconciliation is required",
      );
    }

    let readBackResult: ProviderReconciliationResult<T>;
    try {
      readBackResult = await credentials.withSecret(
        input.scope,
        connection.connectionId,
        (secret) => readBack(providerOperationId, secret, identity),
      );
      if (readBackResult.outcome === "completed") {
        assertAllowedProviderOutput(outputPolicy, readBackResult.result, "reconcile");
      }
    } catch (error) {
      if (error instanceof VentureRuntimeError && error.code === "credential_scope_mismatch") {
        return manualRequired(
          providerOperationId,
          "credential_unavailable",
          "Provider credential became unavailable; manual provider-side reconciliation is required",
        );
      }
      if (usage.status === "reserved") {
        store.settleEntitlementUsage(input.scope, input.idempotencyKey, "unknown");
      }
      throw new VentureRuntimeError(
        "external_outcome_unknown",
        "provider read-back is inconclusive; the original operation was not repeated",
      );
    }
    if (readBackResult.outcome === "completed") {
      store.settleEntitlementUsage(
        input.scope,
        input.idempotencyKey,
        "completed",
        readBackResult.result,
      );
      store.appendAudit(identity, "service.execution.reconciled", {
        commandId: binding.commandId,
        reconciliationCommandId: input.reconciliationCommandId,
        reconciledByActorId: input.scope.agentId ?? input.scope.userId ?? "unknown",
        outcome: "completed",
        providerOperationId,
      });
      return { status: "completed", providerOperationId, result: readBackResult.result };
    }
    if (readBackResult.outcome === "definitive_no_effect") {
      store.releaseEntitlementUsage(input.scope, input.idempotencyKey);
      store.appendAudit(identity, "service.execution.reconciled", {
        commandId: binding.commandId,
        reconciliationCommandId: input.reconciliationCommandId,
        reconciledByActorId: input.scope.agentId ?? input.scope.userId ?? "unknown",
        outcome: "definitive_no_effect",
        providerOperationId,
      });
      return { status: "released", providerOperationId };
    }
    if (usage.status === "reserved") {
      store.settleEntitlementUsage(input.scope, input.idempotencyKey, "unknown");
    }
    store.appendAudit(identity, "service.execution.reconciliation_pending", {
      commandId: binding.commandId,
      reconciliationCommandId: input.reconciliationCommandId,
      reconciledByActorId: input.scope.agentId ?? input.scope.userId ?? "unknown",
      outcome: "unknown",
      providerOperationId,
    });
    throw new VentureRuntimeError(
      "external_outcome_unknown",
      "provider read-back is inconclusive; the original operation was not repeated",
    );
  }

  function offboard(scope: TenantScope, at = now()): void {
    store.offboard(scope, at);
    credentials.revokeScope(scope);
  }

  return { execute, reconcile, offboard };
}
