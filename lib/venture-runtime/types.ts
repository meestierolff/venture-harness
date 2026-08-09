export type StackClass = "company" | "customer" | "agent_access";
export type ResourceOwnership =
  | "customer_owned"
  | "venture_owned"
  | "customer_owned_dedicated_account"
  | "platform_managed_customer_subaccount"
  | "platform_owned_demo"
  | "transfer_pending";

export type ConnectionStatus =
  | "unconfigured"
  | "authorization_created"
  | "waiting_for_user"
  | "exchanging"
  | "selecting_account"
  | "connected"
  | "verified"
  | "degraded"
  | "reconnect_required"
  | "revoked"
  | "failed";

export interface TenantScope {
  operatorId: string;
  ventureId: string;
  customerOrganizationId: string;
  userId?: string;
  agentId?: string;
}

export type VentureScope = Pick<TenantScope, "operatorId" | "ventureId">;

export interface ExecutionIdentity extends TenantScope {
  subscriptionId: string;
  entitlementId: string;
  serviceGrantId: string;
  authorizationEnvelopeId: string;
  providerConnectionId: string;
  runId: string;
  nodeId: string;
  correlationId: string;
  causationId: string;
  /** Stable provider-side idempotency/read-back identity; never a credential. */
  providerOperationId: string;
}

export interface OrganizationRecord {
  operatorId: string;
  organizationId: string;
  ventureId: string;
  kind: "platform" | "venture" | "customer";
  name: string;
  status: "active" | "offboarded";
}

export interface SubscriptionRecord {
  operatorId: string;
  subscriptionId: string;
  ventureId: string;
  customerOrganizationId: string;
  planId: string;
  status: "active" | "past_due" | "cancelled" | "expired";
}

export interface EntitlementRecord {
  operatorId: string;
  entitlementId: string;
  ventureId: string;
  customerOrganizationId: string;
  subscriptionId: string;
  capability: string;
  remainingUnits: number | null;
  status: "active" | "exhausted" | "revoked";
}

export interface ProviderConnectionRecord {
  operatorId: string;
  connectionId: string;
  ventureId: string;
  customerOrganizationId: string;
  stackClass: StackClass;
  provider: string;
  externalAccountId: string;
  credentialRef: string;
  ownership: ResourceOwnership;
  ownerOrganizationId: string;
  scopes: readonly string[];
  capabilities: readonly string[];
  status: ConnectionStatus;
  lastVerifiedAt: string | null;
  revokedAt: string | null;
}

export interface ServiceBlueprintRecord {
  operatorId: string;
  blueprintId: string;
  ventureId: string;
  version: number;
  outcome: string;
  commandId: string;
  requiredCapabilities: readonly string[];
  usageUnit: string;
  billingUnit: string;
  completionCriteria: readonly string[];
  workflowGraph: Readonly<Record<string, unknown>>;
  policy: Readonly<Record<string, unknown>>;
}

export interface ServiceGrantRecord {
  operatorId: string;
  serviceGrantId: string;
  ventureId: string;
  customerOrganizationId: string;
  blueprintId: string;
  blueprintVersion: number;
  connectionIds: readonly string[];
  grantedByUserId: string;
  notBefore: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AgentGrantRecord {
  operatorId: string;
  agentGrantId: string;
  ventureId: string;
  customerOrganizationId: string;
  agentId: string;
  tokenDigest: string;
  scopes: readonly string[];
  grantedByUserId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ExternalResourceRecord {
  operatorId: string;
  resourceId: string;
  ventureId: string;
  customerOrganizationId: string | null;
  provider: string;
  externalAccountId: string;
  externalResourceId: string;
  ownership: ResourceOwnership;
  preservationState: "preserve" | "transfer_pending" | "disposable_fixture";
}

export interface AuditEventRecord {
  operatorId: string;
  eventId: string;
  sequence: number;
  schemaVersion: number;
  identity: ExecutionIdentity;
  kind: string;
  occurredAt: string;
  sanitizedPayload: Readonly<Record<string, unknown>>;
  artifactRefs: readonly string[];
  priorHash: string;
  currentHash: string;
}

export class VentureRuntimeError extends Error {
  constructor(
    readonly code:
      | "tenant_scope_mismatch"
      | "not_found"
      | "subscription_inactive"
      | "entitlement_missing"
      | "entitlement_exhausted"
      | "service_grant_invalid"
      | "agent_grant_invalid"
      | "connection_unavailable"
      | "capability_unavailable"
      | "webhook_route_mismatch"
      | "credential_scope_mismatch"
      | "customer_offboarded"
      | "audit_chain_invalid"
      | "idempotency_conflict"
      | "idempotency_replay"
      | "external_outcome_unknown"
      | "credential_leak_detected"
      | "provider_output_invalid"
      | "authorization_envelope_invalid",
    message: string,
  ) {
    super(message);
    this.name = "VentureRuntimeError";
  }
}

export class ProviderOperationError extends Error {
  constructor(
    readonly outcome: "definitive_no_effect" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "ProviderOperationError";
  }
}
