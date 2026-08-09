import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  AgentGrantRecord,
  AuditEventRecord,
  EntitlementRecord,
  ExecutionIdentity,
  ExternalResourceRecord,
  OrganizationRecord,
  ProviderConnectionRecord,
  ServiceBlueprintRecord,
  ServiceGrantRecord,
  SubscriptionRecord,
  TenantScope,
} from "./types";
import { VentureRuntimeError } from "./types";

interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes?: number | bigint };
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

function loadSqlite(): { DatabaseSync: new (filename: string) => Database } {
  return createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (filename: string) => Database;
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  organization_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (venture_id, user_id)
);
CREATE TABLE IF NOT EXISTS memberships (
  venture_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (venture_id, organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entitlements (
  entitlement_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  remaining_units INTEGER,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_connections (
  connection_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  stack_class TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  ownership TEXT NOT NULL,
  owner_organization_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL,
  last_verified_at TEXT,
  revoked_at TEXT,
  UNIQUE (venture_id, customer_organization_id, provider, external_account_id)
);
CREATE TABLE IF NOT EXISTS service_blueprints (
  blueprint_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  command_id TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  usage_unit TEXT NOT NULL,
  billing_unit TEXT NOT NULL,
  completion_criteria_json TEXT NOT NULL,
  workflow_graph_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  PRIMARY KEY (venture_id, blueprint_id, version)
);
CREATE TABLE IF NOT EXISTS service_grants (
  service_grant_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  blueprint_version INTEGER NOT NULL,
  connection_ids_json TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_grants (
  agent_grant_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (venture_id, customer_organization_id, token_digest)
);
CREATE TABLE IF NOT EXISTS external_resources (
  resource_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT,
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  external_resource_id TEXT NOT NULL,
  ownership TEXT NOT NULL,
  preservation_state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_records (
  usage_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  service_grant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  units INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (venture_id, customer_organization_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS webhook_events (
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (venture_id, customer_organization_id, provider, provider_event_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  identity_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL,
  prior_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_scope ON provider_connections(venture_id, customer_organization_id);
CREATE INDEX IF NOT EXISTS audit_scope ON audit_events(venture_id, customer_organization_id, occurred_at);
`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function json<T>(value: unknown): T {
  return JSON.parse(value as string) as T;
}

function scopeWhere(scope: TenantScope): readonly [string, string] {
  return [scope.ventureId, scope.customerOrganizationId];
}

function connectionFrom(row: Record<string, unknown>): ProviderConnectionRecord {
  return {
    connectionId: row.connection_id as string,
    ventureId: row.venture_id as string,
    customerOrganizationId: row.customer_organization_id as string,
    stackClass: row.stack_class as ProviderConnectionRecord["stackClass"],
    provider: row.provider as string,
    externalAccountId: row.external_account_id as string,
    credentialRef: row.credential_ref as string,
    ownership: row.ownership as ProviderConnectionRecord["ownership"],
    ownerOrganizationId: row.owner_organization_id as string,
    scopes: json<string[]>(row.scopes_json),
    capabilities: json<string[]>(row.capabilities_json),
    status: row.status as ProviderConnectionRecord["status"],
    lastVerifiedAt: (row.last_verified_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
  };
}

export interface VentureRuntimeStoreOptions {
  id?: () => string;
  now?: () => Date;
}

export function createVentureRuntimeStore(
  filename: string,
  options: VentureRuntimeStoreOptions = {},
) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date());

  function organization(scope: TenantScope): OrganizationRecord {
    const row = db
      .prepare(
        "SELECT * FROM organizations WHERE venture_id = ? AND organization_id = ? AND kind = 'customer'",
      )
      .get(...scopeWhere(scope)) as Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "customer organization not found");
    return {
      organizationId: row.organization_id as string,
      ventureId: row.venture_id as string,
      kind: row.kind as OrganizationRecord["kind"],
      name: row.name as string,
      status: row.status as OrganizationRecord["status"],
    };
  }

  function createOrganization(record: OrganizationRecord): void {
    db.prepare(
      "INSERT INTO organizations (organization_id, venture_id, kind, name, status) VALUES (?,?,?,?,?)",
    ).run(record.organizationId, record.ventureId, record.kind, record.name, record.status);
  }

  function createUser(ventureId: string, userId: string): void {
    db.prepare("INSERT INTO users (user_id, venture_id, status) VALUES (?,?,'active')").run(
      userId,
      ventureId,
    );
  }

  function addMembership(
    ventureId: string,
    organizationId: string,
    userId: string,
    role: "owner" | "admin" | "member",
  ): void {
    db.prepare(
      "INSERT INTO memberships (venture_id, organization_id, user_id, role, status) VALUES (?,?,?,?,'active')",
    ).run(ventureId, organizationId, userId, role);
  }

  function hasMembership(scope: TenantScope): boolean {
    if (!scope.userId) return false;
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM memberships WHERE venture_id = ? AND organization_id = ? AND user_id = ? AND status = 'active'",
        )
        .get(scope.ventureId, scope.customerOrganizationId, scope.userId),
    );
  }

  function putSubscription(record: SubscriptionRecord): void {
    db.prepare(
      "INSERT INTO subscriptions (subscription_id, venture_id, customer_organization_id, plan_id, status) VALUES (?,?,?,?,?)",
    ).run(
      record.subscriptionId,
      record.ventureId,
      record.customerOrganizationId,
      record.planId,
      record.status,
    );
  }

  function putEntitlement(record: EntitlementRecord): void {
    db.prepare(
      "INSERT INTO entitlements (entitlement_id, venture_id, customer_organization_id, subscription_id, capability, remaining_units, status) VALUES (?,?,?,?,?,?,?)",
    ).run(
      record.entitlementId,
      record.ventureId,
      record.customerOrganizationId,
      record.subscriptionId,
      record.capability,
      record.remainingUnits,
      record.status,
    );
  }

  function putConnection(record: ProviderConnectionRecord): void {
    if (!record.credentialRef.startsWith("cred://")) {
      throw new VentureRuntimeError(
        "credential_scope_mismatch",
        "provider connections may persist only cred:// references",
      );
    }
    db.prepare(
      `INSERT INTO provider_connections (
        connection_id, venture_id, customer_organization_id, stack_class, provider,
        external_account_id, credential_ref, ownership, owner_organization_id,
        scopes_json, capabilities_json, status, last_verified_at, revoked_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      record.connectionId,
      record.ventureId,
      record.customerOrganizationId,
      record.stackClass,
      record.provider,
      record.externalAccountId,
      record.credentialRef,
      record.ownership,
      record.ownerOrganizationId,
      JSON.stringify(record.scopes),
      JSON.stringify(record.capabilities),
      record.status,
      record.lastVerifiedAt,
      record.revokedAt,
    );
  }

  function connection(scope: TenantScope, connectionId: string): ProviderConnectionRecord {
    const row = db
      .prepare(
        "SELECT * FROM provider_connections WHERE venture_id = ? AND customer_organization_id = ? AND connection_id = ?",
      )
      .get(scope.ventureId, scope.customerOrganizationId, connectionId) as
      Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "provider connection not found");
    return connectionFrom(row);
  }

  function listConnections(scope: TenantScope): readonly ProviderConnectionRecord[] {
    organization(scope);
    return (
      db
        .prepare(
          "SELECT * FROM provider_connections WHERE venture_id = ? AND customer_organization_id = ? ORDER BY connection_id",
        )
        .all(...scopeWhere(scope)) as Record<string, unknown>[]
    ).map(connectionFrom);
  }

  function revokeConnection(scope: TenantScope, connectionId: string, at = now()): void {
    const result = db
      .prepare(
        "UPDATE provider_connections SET status = 'revoked', revoked_at = ? WHERE venture_id = ? AND customer_organization_id = ? AND connection_id = ?",
      )
      .run(at.toISOString(), scope.ventureId, scope.customerOrganizationId, connectionId);
    if (Number(result.changes ?? 0) !== 1) {
      throw new VentureRuntimeError("not_found", "provider connection not found");
    }
  }

  function putBlueprint(record: ServiceBlueprintRecord): void {
    db.prepare(
      `INSERT INTO service_blueprints (
        blueprint_id, venture_id, version, outcome, command_id, required_capabilities_json,
        usage_unit, billing_unit, completion_criteria_json, workflow_graph_json, policy_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      record.blueprintId,
      record.ventureId,
      record.version,
      record.outcome,
      record.commandId,
      JSON.stringify(record.requiredCapabilities),
      record.usageUnit,
      record.billingUnit,
      JSON.stringify(record.completionCriteria),
      JSON.stringify(record.workflowGraph),
      JSON.stringify(record.policy),
    );
  }

  function blueprint(
    ventureId: string,
    blueprintId: string,
    version?: number,
  ): ServiceBlueprintRecord {
    const row = db
      .prepare(
        version === undefined
          ? "SELECT * FROM service_blueprints WHERE venture_id = ? AND blueprint_id = ? ORDER BY version DESC LIMIT 1"
          : "SELECT * FROM service_blueprints WHERE venture_id = ? AND blueprint_id = ? AND version = ?",
      )
      .get(
        ...(version === undefined ? [ventureId, blueprintId] : [ventureId, blueprintId, version]),
      ) as Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "service blueprint not found");
    return {
      blueprintId: row.blueprint_id as string,
      ventureId: row.venture_id as string,
      version: Number(row.version),
      outcome: row.outcome as string,
      commandId: row.command_id as string,
      requiredCapabilities: json<string[]>(row.required_capabilities_json),
      usageUnit: row.usage_unit as string,
      billingUnit: row.billing_unit as string,
      completionCriteria: json<string[]>(row.completion_criteria_json),
      workflowGraph: json<Record<string, unknown>>(row.workflow_graph_json),
      policy: json<Record<string, unknown>>(row.policy_json),
    };
  }

  function putServiceGrant(record: ServiceGrantRecord): void {
    db.prepare(
      "INSERT INTO service_grants (service_grant_id, venture_id, customer_organization_id, blueprint_id, blueprint_version, connection_ids_json, granted_by_user_id, not_before, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      record.serviceGrantId,
      record.ventureId,
      record.customerOrganizationId,
      record.blueprintId,
      record.blueprintVersion,
      JSON.stringify(record.connectionIds),
      record.grantedByUserId,
      record.notBefore,
      record.expiresAt,
      record.revokedAt,
    );
  }

  function serviceGrant(scope: TenantScope, grantId: string): ServiceGrantRecord {
    const row = db
      .prepare(
        "SELECT * FROM service_grants WHERE venture_id = ? AND customer_organization_id = ? AND service_grant_id = ?",
      )
      .get(scope.ventureId, scope.customerOrganizationId, grantId) as
      Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "service grant not found");
    return {
      serviceGrantId: row.service_grant_id as string,
      ventureId: row.venture_id as string,
      customerOrganizationId: row.customer_organization_id as string,
      blueprintId: row.blueprint_id as string,
      blueprintVersion: Number(row.blueprint_version),
      connectionIds: json<string[]>(row.connection_ids_json),
      grantedByUserId: row.granted_by_user_id as string,
      notBefore: row.not_before as string,
      expiresAt: row.expires_at as string,
      revokedAt: (row.revoked_at as string | null) ?? null,
    };
  }

  function revokeServiceGrant(scope: TenantScope, grantId: string, at = now()): void {
    db.prepare(
      "UPDATE service_grants SET revoked_at = ? WHERE venture_id = ? AND customer_organization_id = ? AND service_grant_id = ?",
    ).run(at.toISOString(), scope.ventureId, scope.customerOrganizationId, grantId);
  }

  function putAgentGrant(record: AgentGrantRecord): void {
    db.prepare(
      "INSERT INTO agent_grants (agent_grant_id, venture_id, customer_organization_id, agent_id, token_digest, scopes_json, granted_by_user_id, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      record.agentGrantId,
      record.ventureId,
      record.customerOrganizationId,
      record.agentId,
      record.tokenDigest,
      JSON.stringify(record.scopes),
      record.grantedByUserId,
      record.expiresAt,
      record.revokedAt,
    );
  }

  function agentGrantByToken(scope: TenantScope, tokenDigest: string): AgentGrantRecord {
    const row = db
      .prepare(
        "SELECT * FROM agent_grants WHERE venture_id = ? AND customer_organization_id = ? AND token_digest = ?",
      )
      .get(scope.ventureId, scope.customerOrganizationId, tokenDigest) as
      Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("agent_grant_invalid", "agent grant is invalid");
    return {
      agentGrantId: row.agent_grant_id as string,
      ventureId: row.venture_id as string,
      customerOrganizationId: row.customer_organization_id as string,
      agentId: row.agent_id as string,
      tokenDigest: row.token_digest as string,
      scopes: json<string[]>(row.scopes_json),
      grantedByUserId: row.granted_by_user_id as string,
      expiresAt: row.expires_at as string,
      revokedAt: (row.revoked_at as string | null) ?? null,
    };
  }

  function subscriptionFor(scope: TenantScope): SubscriptionRecord {
    const row = db
      .prepare(
        "SELECT * FROM subscriptions WHERE venture_id = ? AND customer_organization_id = ? AND status = 'active' ORDER BY subscription_id LIMIT 1",
      )
      .get(...scopeWhere(scope)) as Record<string, unknown> | undefined;
    if (!row)
      throw new VentureRuntimeError("subscription_inactive", "active subscription required");
    return {
      subscriptionId: row.subscription_id as string,
      ventureId: row.venture_id as string,
      customerOrganizationId: row.customer_organization_id as string,
      planId: row.plan_id as string,
      status: row.status as SubscriptionRecord["status"],
    };
  }

  function entitlementFor(scope: TenantScope, capability: string): EntitlementRecord {
    const row = db
      .prepare(
        "SELECT * FROM entitlements WHERE venture_id = ? AND customer_organization_id = ? AND capability = ? ORDER BY entitlement_id LIMIT 1",
      )
      .get(scope.ventureId, scope.customerOrganizationId, capability) as
      Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("entitlement_missing", "required entitlement missing");
    return {
      entitlementId: row.entitlement_id as string,
      ventureId: row.venture_id as string,
      customerOrganizationId: row.customer_organization_id as string,
      subscriptionId: row.subscription_id as string,
      capability: row.capability as string,
      remainingUnits: row.remaining_units === null ? null : Number(row.remaining_units),
      status: row.status as EntitlementRecord["status"],
    };
  }

  function reserveEntitlementUsage(
    scope: TenantScope,
    entitlementId: string,
    serviceGrantId: string,
    commandId: string,
    connectionId: string,
    units: number,
    idempotencyKey: string,
    requestHash: string,
  ): "created" | "replay" {
    if (!Number.isInteger(units) || units <= 0)
      throw new Error("usage units must be positive integers");
    db.exec("BEGIN IMMEDIATE");
    try {
      const replay = db
        .prepare(
          "SELECT request_hash FROM usage_records WHERE venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
        )
        .get(scope.ventureId, scope.customerOrganizationId, idempotencyKey) as
        { request_hash: string } | undefined;
      if (replay) {
        db.exec("ROLLBACK");
        if (replay.request_hash !== requestHash) {
          throw new VentureRuntimeError(
            "idempotency_conflict",
            "idempotency key is already bound to a different request",
          );
        }
        return "replay";
      }
      const row = db
        .prepare(
          "SELECT remaining_units, status FROM entitlements WHERE venture_id = ? AND customer_organization_id = ? AND entitlement_id = ?",
        )
        .get(scope.ventureId, scope.customerOrganizationId, entitlementId) as
        { remaining_units: number | null; status: string } | undefined;
      if (!row || row.status !== "active") {
        throw new VentureRuntimeError("entitlement_exhausted", "entitlement is not active");
      }
      if (row.remaining_units !== null && Number(row.remaining_units) < units) {
        throw new VentureRuntimeError(
          "entitlement_exhausted",
          "entitlement has insufficient units",
        );
      }
      if (row.remaining_units !== null) {
        db.prepare(
          "UPDATE entitlements SET remaining_units = remaining_units - ?, status = CASE WHEN remaining_units - ? = 0 THEN 'exhausted' ELSE status END WHERE entitlement_id = ?",
        ).run(units, units, entitlementId);
      }
      db.prepare(
        "INSERT INTO usage_records (usage_id, venture_id, customer_organization_id, entitlement_id, service_grant_id, command_id, connection_id, units, occurred_at, idempotency_key, request_hash, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id(),
        scope.ventureId,
        scope.customerOrganizationId,
        entitlementId,
        serviceGrantId,
        commandId,
        connectionId,
        units,
        now().toISOString(),
        idempotencyKey,
        requestHash,
        "reserved",
      );
      db.exec("COMMIT");
      return "created";
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction already closed.
      }
      throw error;
    }
  }

  function settleEntitlementUsage(
    scope: TenantScope,
    idempotencyKey: string,
    status: "completed" | "unknown",
  ): void {
    const result = db
      .prepare(
        "UPDATE usage_records SET status = ? WHERE venture_id = ? AND customer_organization_id = ? AND idempotency_key = ? AND status = 'reserved'",
      )
      .run(status, scope.ventureId, scope.customerOrganizationId, idempotencyKey);
    if (Number(result.changes ?? 0) !== 1) {
      throw new VentureRuntimeError("idempotency_replay", "usage reservation is not pending");
    }
  }

  function releaseEntitlementUsage(scope: TenantScope, idempotencyKey: string): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      const usage = db
        .prepare(
          "SELECT entitlement_id, units, status FROM usage_records WHERE venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
        )
        .get(scope.ventureId, scope.customerOrganizationId, idempotencyKey) as
        { entitlement_id: string; units: number; status: string } | undefined;
      if (!usage || usage.status !== "reserved") {
        throw new VentureRuntimeError("idempotency_replay", "usage reservation is not pending");
      }
      db.prepare(
        "UPDATE entitlements SET remaining_units = CASE WHEN remaining_units IS NULL THEN NULL ELSE remaining_units + ? END, status = 'active' WHERE venture_id = ? AND customer_organization_id = ? AND entitlement_id = ?",
      ).run(
        Number(usage.units),
        scope.ventureId,
        scope.customerOrganizationId,
        usage.entitlement_id,
      );
      db.prepare(
        "UPDATE usage_records SET status = 'released' WHERE venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
      ).run(scope.ventureId, scope.customerOrganizationId, idempotencyKey);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already closed
      }
      throw error;
    }
  }

  function usageStatus(
    scope: TenantScope,
    idempotencyKey: string,
  ): "reserved" | "completed" | "unknown" | "released" | null {
    const row = db
      .prepare(
        "SELECT status FROM usage_records WHERE venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
      )
      .get(scope.ventureId, scope.customerOrganizationId, idempotencyKey) as
      { status: "reserved" | "completed" | "unknown" | "released" } | undefined;
    return row?.status ?? null;
  }

  function putResource(record: ExternalResourceRecord): void {
    db.prepare(
      "INSERT INTO external_resources (resource_id, venture_id, customer_organization_id, provider, external_account_id, external_resource_id, ownership, preservation_state) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      record.resourceId,
      record.ventureId,
      record.customerOrganizationId,
      record.provider,
      record.externalAccountId,
      record.externalResourceId,
      record.ownership,
      record.preservationState,
    );
  }

  function listResources(scope: TenantScope): readonly ExternalResourceRecord[] {
    organization(scope);
    return (
      db
        .prepare(
          "SELECT * FROM external_resources WHERE venture_id = ? AND customer_organization_id = ? ORDER BY resource_id",
        )
        .all(...scopeWhere(scope)) as Record<string, unknown>[]
    ).map((row) => ({
      resourceId: row.resource_id as string,
      ventureId: row.venture_id as string,
      customerOrganizationId: (row.customer_organization_id as string | null) ?? null,
      provider: row.provider as string,
      externalAccountId: row.external_account_id as string,
      externalResourceId: row.external_resource_id as string,
      ownership: row.ownership as ExternalResourceRecord["ownership"],
      preservationState: row.preservation_state as ExternalResourceRecord["preservationState"],
    }));
  }

  function appendAudit(
    identity: ExecutionIdentity,
    kind: string,
    sanitizedPayload: Readonly<Record<string, unknown>>,
    artifactRefs: readonly string[] = [],
  ): AuditEventRecord {
    const prior = db
      .prepare(
        "SELECT current_hash FROM audit_events WHERE venture_id = ? AND customer_organization_id = ? ORDER BY occurred_at DESC, event_id DESC LIMIT 1",
      )
      .get(identity.ventureId, identity.customerOrganizationId) as
      { current_hash: string } | undefined;
    const occurredAt = now().toISOString();
    const eventId = id();
    const priorHash = prior?.current_hash ?? "GENESIS";
    const unsigned = {
      eventId,
      schemaVersion: 1,
      identity,
      kind,
      occurredAt,
      sanitizedPayload,
      artifactRefs,
      priorHash,
    };
    const currentHash = createHash("sha256").update(stable(unsigned)).digest("hex");
    db.prepare(
      "INSERT INTO audit_events (event_id, venture_id, customer_organization_id, schema_version, identity_json, kind, occurred_at, payload_json, artifact_refs_json, prior_hash, current_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      eventId,
      identity.ventureId,
      identity.customerOrganizationId,
      1,
      JSON.stringify(identity),
      kind,
      occurredAt,
      JSON.stringify(sanitizedPayload),
      JSON.stringify(artifactRefs),
      priorHash,
      currentHash,
    );
    return Object.freeze({ ...unsigned, currentHash });
  }

  function auditEvents(scope: TenantScope): readonly AuditEventRecord[] {
    return (
      db
        .prepare(
          "SELECT * FROM audit_events WHERE venture_id = ? AND customer_organization_id = ? ORDER BY occurred_at, event_id",
        )
        .all(...scopeWhere(scope)) as Record<string, unknown>[]
    ).map((row) => ({
      eventId: row.event_id as string,
      schemaVersion: Number(row.schema_version),
      identity: json<ExecutionIdentity>(row.identity_json),
      kind: row.kind as string,
      occurredAt: row.occurred_at as string,
      sanitizedPayload: json<Record<string, unknown>>(row.payload_json),
      artifactRefs: json<string[]>(row.artifact_refs_json),
      priorHash: row.prior_hash as string,
      currentHash: row.current_hash as string,
    }));
  }

  function verifyAudit(scope: TenantScope): boolean {
    let priorHash = "GENESIS";
    for (const event of auditEvents(scope)) {
      if (event.priorHash !== priorHash) return false;
      const unsigned = {
        eventId: event.eventId,
        schemaVersion: event.schemaVersion,
        identity: event.identity,
        kind: event.kind,
        occurredAt: event.occurredAt,
        sanitizedPayload: event.sanitizedPayload,
        artifactRefs: event.artifactRefs,
        priorHash: event.priorHash,
      };
      const expected = createHash("sha256").update(stable(unsigned)).digest("hex");
      if (expected !== event.currentHash) return false;
      priorHash = event.currentHash;
    }
    return true;
  }

  function recordWebhook(
    scope: TenantScope,
    connectionId: string,
    provider: string,
    providerEventId: string,
    payload: unknown,
  ): "created" | "duplicate" {
    const selected = connection(scope, connectionId);
    if (selected.provider !== provider) {
      throw new VentureRuntimeError("webhook_route_mismatch", "webhook route does not match");
    }
    const payloadHash = createHash("sha256").update(stable(payload)).digest("hex");
    const prior = db
      .prepare(
        "SELECT connection_id, payload_hash FROM webhook_events WHERE venture_id = ? AND customer_organization_id = ? AND provider = ? AND provider_event_id = ?",
      )
      .get(scope.ventureId, scope.customerOrganizationId, provider, providerEventId) as
      { connection_id: string; payload_hash: string } | undefined;
    if (prior) {
      if (prior.connection_id !== connectionId || prior.payload_hash !== payloadHash) {
        throw new VentureRuntimeError(
          "idempotency_conflict",
          "provider event ID is already bound to a different event",
        );
      }
      return "duplicate";
    }
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO webhook_events (venture_id, customer_organization_id, connection_id, provider, provider_event_id, occurred_at, payload_hash) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        scope.ventureId,
        scope.customerOrganizationId,
        connectionId,
        provider,
        providerEventId,
        now().toISOString(),
        payloadHash,
      );
    return Number(result.changes ?? 0) === 1 ? "created" : "duplicate";
  }

  function offboard(scope: TenantScope, at = now()): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      organization(scope);
      db.prepare(
        "UPDATE organizations SET status = 'offboarded' WHERE venture_id = ? AND organization_id = ?",
      ).run(...scopeWhere(scope));
      db.prepare(
        "UPDATE subscriptions SET status = 'cancelled' WHERE venture_id = ? AND customer_organization_id = ?",
      ).run(...scopeWhere(scope));
      db.prepare(
        "UPDATE entitlements SET status = 'revoked' WHERE venture_id = ? AND customer_organization_id = ?",
      ).run(...scopeWhere(scope));
      db.prepare(
        "UPDATE provider_connections SET status = 'revoked', revoked_at = ? WHERE venture_id = ? AND customer_organization_id = ?",
      ).run(at.toISOString(), ...scopeWhere(scope));
      db.prepare(
        "UPDATE service_grants SET revoked_at = ? WHERE venture_id = ? AND customer_organization_id = ? AND revoked_at IS NULL",
      ).run(at.toISOString(), ...scopeWhere(scope));
      db.prepare(
        "UPDATE agent_grants SET revoked_at = ? WHERE venture_id = ? AND customer_organization_id = ? AND revoked_at IS NULL",
      ).run(at.toISOString(), ...scopeWhere(scope));
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already closed
      }
      throw error;
    }
  }

  return {
    createOrganization,
    createUser,
    addMembership,
    hasMembership,
    organization,
    putSubscription,
    putEntitlement,
    putConnection,
    connection,
    listConnections,
    revokeConnection,
    putBlueprint,
    blueprint,
    putServiceGrant,
    serviceGrant,
    revokeServiceGrant,
    putAgentGrant,
    agentGrantByToken,
    subscriptionFor,
    entitlementFor,
    reserveEntitlementUsage,
    settleEntitlementUsage,
    releaseEntitlementUsage,
    usageStatus,
    putResource,
    listResources,
    appendAudit,
    auditEvents,
    verifyAudit,
    recordWebhook,
    offboard,
    close: () => db.close(),
  };
}

export type VentureRuntimeStore = ReturnType<typeof createVentureRuntimeStore>;
