import { createHash } from "node:crypto";
import type { TenantCredentialBroker } from "./credential-broker";
import type { VentureRuntimeStore } from "./store";
import type { ExecutionIdentity, TenantScope } from "./types";
import { ProviderOperationError, VentureRuntimeError } from "./types";

export interface ExecuteServiceInput {
  scope: TenantScope;
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
  agentToken?: string;
}

export function createVentureRuntimeService(
  store: VentureRuntimeStore,
  credentials: TenantCredentialBroker,
  now: () => Date = () => new Date(),
) {
  async function execute<T>(
    input: ExecuteServiceInput,
    providerOperation: (secret: string, identity: ExecutionIdentity) => Promise<T>,
  ): Promise<T> {
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
    let authorizedAgentId: string | undefined;
    if (input.agentToken) {
      const digest = createHash("sha256").update(input.agentToken).digest("hex");
      const grant = store.agentGrantByToken(input.scope, digest);
      if (
        grant.revokedAt ||
        new Date(grant.expiresAt) < now() ||
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
    const subscription = store.subscriptionFor(effectiveScope);
    if (subscription.status !== "active") {
      throw new VentureRuntimeError("subscription_inactive", "active subscription required");
    }
    const entitlement = store.entitlementFor(effectiveScope, input.capability);
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
    const at = now();
    if (
      serviceGrant.revokedAt ||
      at < new Date(serviceGrant.notBefore) ||
      at > new Date(serviceGrant.expiresAt)
    ) {
      throw new VentureRuntimeError("service_grant_invalid", "service grant is invalid");
    }
    const blueprint = store.blueprint(
      effectiveScope.ventureId,
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

    const identity: ExecutionIdentity = {
      ...effectiveScope,
      subscriptionId: subscription.subscriptionId,
      entitlementId: entitlement.entitlementId,
      serviceGrantId: serviceGrant.serviceGrantId,
      authorizationEnvelopeId: input.authorizationEnvelopeId,
      providerConnectionId: connection.connectionId,
      runId: input.runId,
      nodeId: input.nodeId,
      correlationId: input.correlationId,
      causationId: input.causationId,
    };

    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          entitlementId: entitlement.entitlementId,
          serviceGrantId: serviceGrant.serviceGrantId,
          commandId: input.commandId,
          providerConnectionId: connection.connectionId,
          authorizationEnvelopeId: input.authorizationEnvelopeId,
          usageUnits: input.usageUnits,
        }),
      )
      .digest("hex");
    const reservation = store.reserveEntitlementUsage(
      effectiveScope,
      entitlement.entitlementId,
      serviceGrant.serviceGrantId,
      input.commandId,
      connection.connectionId,
      input.usageUnits,
      input.idempotencyKey,
      requestHash,
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
    });

    let result: T;
    try {
      result = await credentials.withSecret(effectiveScope, connection.connectionId, (secret) =>
        providerOperation(secret, identity),
      );
    } catch (error) {
      if (error instanceof ProviderOperationError && error.outcome === "definitive_no_effect") {
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
      });
      throw new VentureRuntimeError(
        "external_outcome_unknown",
        "provider outcome is unknown and requires reconciliation",
      );
    }
    store.settleEntitlementUsage(effectiveScope, input.idempotencyKey, "completed");
    store.appendAudit(identity, "service.execution.completed", {
      commandId: input.commandId,
      provider: connection.provider,
      externalAccountId: connection.externalAccountId,
    });
    return result;
  }

  return { execute };
}
