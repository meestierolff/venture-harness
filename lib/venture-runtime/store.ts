import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { initializeSqliteWal } from "@venture-harness/core";
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
  VentureScope,
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
  operator_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, organization_id)
);
CREATE TABLE IF NOT EXISTS users (
  operator_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, user_id)
);
CREATE TABLE IF NOT EXISTS memberships (
  operator_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  operator_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, subscription_id)
);
CREATE TABLE IF NOT EXISTS entitlements (
  operator_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  remaining_units INTEGER,
  status TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, entitlement_id)
);
CREATE TABLE IF NOT EXISTS provider_connections (
  operator_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
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
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, connection_id),
  UNIQUE (operator_id, venture_id, customer_organization_id, provider, external_account_id)
);
CREATE TABLE IF NOT EXISTS service_blueprints (
  operator_id TEXT NOT NULL,
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
  PRIMARY KEY (operator_id, venture_id, blueprint_id, version)
);
CREATE TABLE IF NOT EXISTS service_grants (
  operator_id TEXT NOT NULL,
  service_grant_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  blueprint_version INTEGER NOT NULL,
  connection_ids_json TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, service_grant_id)
);
CREATE TABLE IF NOT EXISTS agent_grants (
  operator_id TEXT NOT NULL,
  agent_grant_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, agent_grant_id),
  UNIQUE (operator_id, venture_id, customer_organization_id, token_digest)
);
CREATE TABLE IF NOT EXISTS external_resources (
  operator_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT,
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  external_resource_id TEXT NOT NULL,
  ownership TEXT NOT NULL,
  preservation_state TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, resource_id)
);
CREATE TABLE IF NOT EXISTS usage_records (
  operator_id TEXT NOT NULL,
  usage_id TEXT NOT NULL,
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
  provider_operation_id TEXT NOT NULL,
  operation_binding_json TEXT,
  result_json TEXT,
  reconciled_at TEXT,
  status TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, usage_id),
  UNIQUE (operator_id, venture_id, customer_organization_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS webhook_events (
  operator_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, provider, provider_event_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  operator_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  customer_organization_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  identity_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL,
  prior_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  PRIMARY KEY (operator_id, venture_id, customer_organization_id, event_id),
  UNIQUE (operator_id, venture_id, customer_organization_id, sequence)
);
CREATE INDEX IF NOT EXISTS connections_scope ON provider_connections(operator_id, venture_id, customer_organization_id);
CREATE INDEX IF NOT EXISTS audit_scope ON audit_events(operator_id, venture_id, customer_organization_id, occurred_at);
`;

const RECURSIVE_TABLES = [
  "organizations",
  "users",
  "memberships",
  "subscriptions",
  "entitlements",
  "provider_connections",
  "service_blueprints",
  "service_grants",
  "agent_grants",
  "external_resources",
  "usage_records",
  "webhook_events",
  "audit_events",
] as const;

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

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new VentureRuntimeError("tenant_scope_mismatch", `${label} is required`);
  }
}

function ventureWhere(scope: VentureScope): readonly [string, string] {
  assertIdentifier(scope.operatorId, "operatorId");
  assertIdentifier(scope.ventureId, "ventureId");
  return [scope.operatorId, scope.ventureId];
}

function scopeWhere(scope: TenantScope): readonly [string, string, string] {
  assertIdentifier(scope.customerOrganizationId, "customerOrganizationId");
  return [...ventureWhere(scope), scope.customerOrganizationId];
}

function assertOperatorScopedSchema(db: Database): void {
  for (const table of RECURSIVE_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue;
    const operatorColumn = (
      columns as {
        name: string;
        pk?: number;
      }[]
    ).find(({ name }) => name === "operator_id");
    if (!operatorColumn || Number(operatorColumn.pk ?? 0) <= 0) {
      throw new VentureRuntimeError(
        "tenant_scope_mismatch",
        `legacy recursive runtime table ${table} is missing an operator-scoped key; migrate it with an explicit operator tenant mapping before recursive execution`,
      );
    }
    const uniqueIndexes = db.prepare(`PRAGMA index_list(${table})`).all() as {
      name: string;
      unique: number;
    }[];
    for (const index of uniqueIndexes.filter((entry) => Number(entry.unique) === 1)) {
      const indexColumns = db.prepare("SELECT name FROM pragma_index_info(?)").all(index.name) as {
        name: string;
      }[];
      if (!indexColumns.some(({ name }) => name === "operator_id")) {
        throw new VentureRuntimeError(
          "tenant_scope_mismatch",
          `legacy recursive runtime table ${table} has an unscoped unique key; migrate it with an explicit operator tenant mapping before recursive execution`,
        );
      }
    }
  }
}

function connectionFrom(row: Record<string, unknown>): ProviderConnectionRecord {
  return {
    operatorId: row.operator_id as string,
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

export interface EntitlementUsageRecord {
  readonly entitlementId: string;
  readonly serviceGrantId: string;
  readonly commandId: string;
  readonly connectionId: string;
  readonly units: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly providerOperationId: string;
  readonly operationBinding: DurableServiceOperationBinding | null;
  readonly status: "reserved" | "completed" | "unknown" | "released";
  readonly result: unknown;
}

/** Credential-free immutable identity/request evidence for provider read-back. */
export interface DurableServiceOperationBinding {
  readonly identity: ExecutionIdentity;
  readonly commandId: string;
  readonly capability: string;
  /** Immutable provider identity used to select the exact output allowlist on restart. */
  readonly provider: string;
  readonly usageUnits: number;
  /** Only the credential-free canonical request digest is durable; raw payload is never stored. */
  readonly operationRequestHash: string;
  readonly requestHash: string;
  readonly providerOperationId: string;
}

export function createVentureRuntimeStore(
  filename: string,
  options: VentureRuntimeStoreOptions = {},
) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  try {
    assertOperatorScopedSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  initializeSqliteWal(db, { label: "venture runtime store" });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const usageColumns = db.prepare("PRAGMA table_info(usage_records)").all() as {
    name: string;
  }[];
  if (!usageColumns.some(({ name }) => name === "provider_operation_id")) {
    db.exec("ALTER TABLE usage_records ADD COLUMN provider_operation_id TEXT");
  }
  if (!usageColumns.some(({ name }) => name === "operation_binding_json")) {
    db.exec("ALTER TABLE usage_records ADD COLUMN operation_binding_json TEXT");
  }
  if (!usageColumns.some(({ name }) => name === "result_json")) {
    db.exec("ALTER TABLE usage_records ADD COLUMN result_json TEXT");
  }
  if (!usageColumns.some(({ name }) => name === "reconciled_at")) {
    db.exec("ALTER TABLE usage_records ADD COLUMN reconciled_at TEXT");
  }
  const auditColumns = db.prepare("PRAGMA table_info(audit_events)").all() as {
    name: string;
  }[];
  if (!auditColumns.some(({ name }) => name === "sequence")) {
    db.exec("ALTER TABLE audit_events ADD COLUMN sequence INTEGER");
    db.exec(`UPDATE audit_events AS target
      SET sequence = (
        SELECT COUNT(*) FROM audit_events AS candidate
        WHERE candidate.operator_id = target.operator_id
          AND candidate.venture_id = target.venture_id
          AND candidate.customer_organization_id = target.customer_organization_id
          AND (
            candidate.occurred_at < target.occurred_at
            OR (candidate.occurred_at = target.occurred_at AND candidate.event_id <= target.event_id)
          )
      )`);
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS audit_operator_sequence ON audit_events(operator_id, venture_id, customer_organization_id, sequence)",
  );
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date());

  function organization(scope: TenantScope): OrganizationRecord {
    const row = db
      .prepare(
        "SELECT * FROM organizations WHERE operator_id = ? AND venture_id = ? AND organization_id = ? AND kind = 'customer'",
      )
      .get(...scopeWhere(scope)) as Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "customer organization not found");
    return {
      operatorId: row.operator_id as string,
      organizationId: row.organization_id as string,
      ventureId: row.venture_id as string,
      kind: row.kind as OrganizationRecord["kind"],
      name: row.name as string,
      status: row.status as OrganizationRecord["status"],
    };
  }

  function createOrganization(record: OrganizationRecord): void {
    ventureWhere(record);
    db.prepare(
      "INSERT INTO organizations (operator_id, organization_id, venture_id, kind, name, status) VALUES (?,?,?,?,?,?)",
    ).run(
      record.operatorId,
      record.organizationId,
      record.ventureId,
      record.kind,
      record.name,
      record.status,
    );
  }

  function createUser(scope: VentureScope, userId: string): void {
    const [operatorId, ventureId] = ventureWhere(scope);
    assertIdentifier(userId, "userId");
    db.prepare(
      "INSERT INTO users (operator_id, user_id, venture_id, status) VALUES (?,?,?,'active')",
    ).run(operatorId, userId, ventureId);
  }

  function addMembership(
    scope: TenantScope,
    userId: string,
    role: "owner" | "admin" | "member",
  ): void {
    assertIdentifier(userId, "userId");
    db.prepare(
      "INSERT INTO memberships (operator_id, venture_id, organization_id, user_id, role, status) VALUES (?,?,?,?,?,'active')",
    ).run(...scopeWhere(scope), userId, role);
  }

  function hasMembership(scope: TenantScope): boolean {
    if (!scope.userId) return false;
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM memberships WHERE operator_id = ? AND venture_id = ? AND organization_id = ? AND user_id = ? AND status = 'active'",
        )
        .get(...scopeWhere(scope), scope.userId),
    );
  }

  function putSubscription(record: SubscriptionRecord): void {
    scopeWhere(record);
    db.prepare(
      "INSERT INTO subscriptions (operator_id, subscription_id, venture_id, customer_organization_id, plan_id, status) VALUES (?,?,?,?,?,?)",
    ).run(
      record.operatorId,
      record.subscriptionId,
      record.ventureId,
      record.customerOrganizationId,
      record.planId,
      record.status,
    );
  }

  function putEntitlement(record: EntitlementRecord): void {
    scopeWhere(record);
    db.prepare(
      "INSERT INTO entitlements (operator_id, entitlement_id, venture_id, customer_organization_id, subscription_id, capability, remaining_units, status) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      record.operatorId,
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
    scopeWhere(record);
    if (!record.credentialRef.startsWith("cred://")) {
      throw new VentureRuntimeError(
        "credential_scope_mismatch",
        "provider connections may persist only cred:// references",
      );
    }
    db.prepare(
      `INSERT INTO provider_connections (
        operator_id, connection_id, venture_id, customer_organization_id, stack_class, provider,
        external_account_id, credential_ref, ownership, owner_organization_id,
        scopes_json, capabilities_json, status, last_verified_at, revoked_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      record.operatorId,
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
        "SELECT * FROM provider_connections WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND connection_id = ?",
      )
      .get(...scopeWhere(scope), connectionId) as Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "provider connection not found");
    return connectionFrom(row);
  }

  function listConnections(scope: TenantScope): readonly ProviderConnectionRecord[] {
    organization(scope);
    return (
      db
        .prepare(
          "SELECT * FROM provider_connections WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? ORDER BY connection_id",
        )
        .all(...scopeWhere(scope)) as Record<string, unknown>[]
    ).map(connectionFrom);
  }

  function revokeConnection(scope: TenantScope, connectionId: string, at = now()): void {
    const result = db
      .prepare(
        "UPDATE provider_connections SET status = 'revoked', revoked_at = ? WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND connection_id = ?",
      )
      .run(at.toISOString(), ...scopeWhere(scope), connectionId);
    if (Number(result.changes ?? 0) !== 1) {
      throw new VentureRuntimeError("not_found", "provider connection not found");
    }
  }

  function putBlueprint(record: ServiceBlueprintRecord): void {
    ventureWhere(record);
    db.prepare(
      `INSERT INTO service_blueprints (
        operator_id, blueprint_id, venture_id, version, outcome, command_id, required_capabilities_json,
        usage_unit, billing_unit, completion_criteria_json, workflow_graph_json, policy_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      record.operatorId,
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
    scope: VentureScope,
    blueprintId: string,
    version?: number,
  ): ServiceBlueprintRecord {
    const row = db
      .prepare(
        version === undefined
          ? "SELECT * FROM service_blueprints WHERE operator_id = ? AND venture_id = ? AND blueprint_id = ? ORDER BY version DESC LIMIT 1"
          : "SELECT * FROM service_blueprints WHERE operator_id = ? AND venture_id = ? AND blueprint_id = ? AND version = ?",
      )
      .get(...ventureWhere(scope), blueprintId, ...(version === undefined ? [] : [version])) as
      Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "service blueprint not found");
    return {
      operatorId: row.operator_id as string,
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
    scopeWhere(record);
    db.prepare(
      "INSERT INTO service_grants (operator_id, service_grant_id, venture_id, customer_organization_id, blueprint_id, blueprint_version, connection_ids_json, granted_by_user_id, not_before, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      record.operatorId,
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
        "SELECT * FROM service_grants WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND service_grant_id = ?",
      )
      .get(...scopeWhere(scope), grantId) as Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("not_found", "service grant not found");
    return {
      operatorId: row.operator_id as string,
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
      "UPDATE service_grants SET revoked_at = ? WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND service_grant_id = ?",
    ).run(at.toISOString(), ...scopeWhere(scope), grantId);
  }

  function putAgentGrant(record: AgentGrantRecord): void {
    scopeWhere(record);
    db.prepare(
      "INSERT INTO agent_grants (operator_id, agent_grant_id, venture_id, customer_organization_id, agent_id, token_digest, scopes_json, granted_by_user_id, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      record.operatorId,
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
        "SELECT * FROM agent_grants WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND token_digest = ?",
      )
      .get(...scopeWhere(scope), tokenDigest) as Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("agent_grant_invalid", "agent grant is invalid");
    return {
      operatorId: row.operator_id as string,
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

  function subscriptionFor(scope: TenantScope, subscriptionId?: string): SubscriptionRecord {
    const row = db
      .prepare(
        subscriptionId
          ? "SELECT * FROM subscriptions WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND subscription_id = ? AND status = 'active'"
          : "SELECT * FROM subscriptions WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND status = 'active' ORDER BY subscription_id LIMIT 1",
      )
      .get(...scopeWhere(scope), ...(subscriptionId ? [subscriptionId] : [])) as
      Record<string, unknown> | undefined;
    if (!row)
      throw new VentureRuntimeError("subscription_inactive", "active subscription required");
    return {
      operatorId: row.operator_id as string,
      subscriptionId: row.subscription_id as string,
      ventureId: row.venture_id as string,
      customerOrganizationId: row.customer_organization_id as string,
      planId: row.plan_id as string,
      status: row.status as SubscriptionRecord["status"],
    };
  }

  function entitlementFor(
    scope: TenantScope,
    capability: string,
    entitlementId?: string,
  ): EntitlementRecord {
    const row = db
      .prepare(
        entitlementId
          ? "SELECT * FROM entitlements WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND capability = ? AND entitlement_id = ?"
          : "SELECT * FROM entitlements WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND capability = ? ORDER BY entitlement_id LIMIT 1",
      )
      .get(...scopeWhere(scope), capability, ...(entitlementId ? [entitlementId] : [])) as
      Record<string, unknown> | undefined;
    if (!row) throw new VentureRuntimeError("entitlement_missing", "required entitlement missing");
    return {
      operatorId: row.operator_id as string,
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
    providerOperationId: string,
    operationBinding: DurableServiceOperationBinding,
  ): "created" | "replay" {
    if (!Number.isInteger(units) || units <= 0)
      throw new Error("usage units must be positive integers");
    db.exec("BEGIN IMMEDIATE");
    try {
      const replay = db
        .prepare(
          "SELECT request_hash FROM usage_records WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
        )
        .get(...scopeWhere(scope), idempotencyKey) as { request_hash: string } | undefined;
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
          "SELECT remaining_units, status FROM entitlements WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND entitlement_id = ?",
        )
        .get(...scopeWhere(scope), entitlementId) as
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
          "UPDATE entitlements SET remaining_units = remaining_units - ?, status = CASE WHEN remaining_units - ? = 0 THEN 'exhausted' ELSE status END WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND entitlement_id = ?",
        ).run(units, units, ...scopeWhere(scope), entitlementId);
      }
      db.prepare(
        "INSERT INTO usage_records (operator_id, usage_id, venture_id, customer_organization_id, entitlement_id, service_grant_id, command_id, connection_id, units, occurred_at, idempotency_key, request_hash, provider_operation_id, operation_binding_json, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        scope.operatorId,
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
        providerOperationId,
        JSON.stringify(operationBinding),
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
    result?: unknown,
  ): void {
    const encodedResult = status === "completed" ? stable(result) : null;
    if (status === "completed" && typeof encodedResult !== "string") {
      throw new VentureRuntimeError(
        "external_outcome_unknown",
        "provider result is not durably serializable and requires reconciliation",
      );
    }
    const update = db
      .prepare(
        status === "completed"
          ? "UPDATE usage_records SET status = ?, result_json = ?, reconciled_at = ? WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ? AND status IN ('reserved', 'unknown')"
          : "UPDATE usage_records SET status = ?, result_json = NULL WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ? AND status = 'reserved'",
      )
      .run(
        status,
        ...(status === "completed" ? [encodedResult, now().toISOString()] : []),
        ...scopeWhere(scope),
        idempotencyKey,
      );
    if (Number(update.changes ?? 0) !== 1) {
      throw new VentureRuntimeError("idempotency_replay", "usage reservation is not pending");
    }
  }

  /**
   * Remove an unsafe legacy result from durable state without releasing the
   * metered reservation. A provider effect may already exist, so only an
   * explicit sanitized read-back or manual reconciliation may settle it.
   */
  function quarantineEntitlementUsage(scope: TenantScope, idempotencyKey: string): void {
    const update = db
      .prepare(
        "UPDATE usage_records SET status = 'unknown', result_json = NULL, reconciled_at = NULL WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ? AND status IN ('reserved', 'unknown', 'completed')",
      )
      .run(...scopeWhere(scope), idempotencyKey);
    if (Number(update.changes ?? 0) !== 1) {
      throw new VentureRuntimeError("idempotency_replay", "usage reservation is not recoverable");
    }
  }

  function releaseEntitlementUsage(scope: TenantScope, idempotencyKey: string): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      const usage = db
        .prepare(
          "SELECT entitlement_id, units, status FROM usage_records WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
        )
        .get(...scopeWhere(scope), idempotencyKey) as
        { entitlement_id: string; units: number; status: string } | undefined;
      if (!usage || !["reserved", "unknown"].includes(usage.status)) {
        throw new VentureRuntimeError("idempotency_replay", "usage reservation is not pending");
      }
      db.prepare(
        "UPDATE entitlements SET remaining_units = CASE WHEN remaining_units IS NULL THEN NULL ELSE remaining_units + ? END, status = 'active' WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND entitlement_id = ?",
      ).run(Number(usage.units), ...scopeWhere(scope), usage.entitlement_id);
      db.prepare(
        "UPDATE usage_records SET status = 'released', reconciled_at = ? WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ? AND status IN ('reserved', 'unknown')",
      ).run(now().toISOString(), ...scopeWhere(scope), idempotencyKey);
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
        "SELECT status FROM usage_records WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
      )
      .get(...scopeWhere(scope), idempotencyKey) as
      { status: "reserved" | "completed" | "unknown" | "released" } | undefined;
    return row?.status ?? null;
  }

  function entitlementUsage(
    scope: TenantScope,
    idempotencyKey: string,
  ): EntitlementUsageRecord | null {
    const row = db
      .prepare(
        "SELECT entitlement_id, service_grant_id, command_id, connection_id, units, idempotency_key, request_hash, provider_operation_id, operation_binding_json, status, result_json FROM usage_records WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND idempotency_key = ?",
      )
      .get(...scopeWhere(scope), idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      entitlementId: row.entitlement_id as string,
      serviceGrantId: row.service_grant_id as string,
      commandId: row.command_id as string,
      connectionId: row.connection_id as string,
      units: Number(row.units),
      idempotencyKey: row.idempotency_key as string,
      requestHash: row.request_hash as string,
      providerOperationId: (row.provider_operation_id as string | null) ?? "",
      operationBinding:
        row.operation_binding_json === null || row.operation_binding_json === undefined
          ? null
          : json<DurableServiceOperationBinding>(row.operation_binding_json),
      status: row.status as EntitlementUsageRecord["status"],
      result: row.result_json === null ? undefined : json<unknown>(row.result_json),
    };
  }

  function putResource(record: ExternalResourceRecord): void {
    ventureWhere(record);
    db.prepare(
      "INSERT INTO external_resources (operator_id, resource_id, venture_id, customer_organization_id, provider, external_account_id, external_resource_id, ownership, preservation_state) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      record.operatorId,
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
          "SELECT * FROM external_resources WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? ORDER BY resource_id",
        )
        .all(...scopeWhere(scope)) as Record<string, unknown>[]
    ).map((row) => ({
      operatorId: row.operator_id as string,
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
    scopeWhere(identity);
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = db
        .prepare(
          "SELECT sequence, current_hash FROM audit_events WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(identity.operatorId, identity.ventureId, identity.customerOrganizationId) as
        { sequence: number; current_hash: string } | undefined;
      const occurredAt = now().toISOString();
      const eventId = id();
      const sequence = Number(prior?.sequence ?? 0) + 1;
      const priorHash = prior?.current_hash ?? "GENESIS";
      const unsigned = {
        operatorId: identity.operatorId,
        eventId,
        sequence,
        schemaVersion: 3,
        identity,
        kind,
        occurredAt,
        sanitizedPayload,
        artifactRefs,
        priorHash,
      };
      const currentHash = createHash("sha256").update(stable(unsigned)).digest("hex");
      db.prepare(
        "INSERT INTO audit_events (operator_id, event_id, venture_id, customer_organization_id, sequence, schema_version, identity_json, kind, occurred_at, payload_json, artifact_refs_json, prior_hash, current_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        identity.operatorId,
        eventId,
        identity.ventureId,
        identity.customerOrganizationId,
        sequence,
        3,
        JSON.stringify(identity),
        kind,
        occurredAt,
        JSON.stringify(sanitizedPayload),
        JSON.stringify(artifactRefs),
        priorHash,
        currentHash,
      );
      db.exec("COMMIT");
      return Object.freeze({ ...unsigned, currentHash });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already closed
      }
      throw error;
    }
  }

  function auditEvents(scope: TenantScope): readonly AuditEventRecord[] {
    return (
      db
        .prepare(
          "SELECT * FROM audit_events WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? ORDER BY sequence",
        )
        .all(...scopeWhere(scope)) as Record<string, unknown>[]
    ).map((row) => {
      const identity = json<ExecutionIdentity>(row.identity_json);
      if (
        identity.operatorId !== row.operator_id ||
        identity.ventureId !== row.venture_id ||
        identity.customerOrganizationId !== row.customer_organization_id
      ) {
        throw new VentureRuntimeError(
          "audit_chain_invalid",
          "audit identity does not match its operator tenant scope",
        );
      }
      return {
        operatorId: row.operator_id as string,
        eventId: row.event_id as string,
        sequence: Number(row.sequence),
        schemaVersion: Number(row.schema_version),
        identity,
        kind: row.kind as string,
        occurredAt: row.occurred_at as string,
        sanitizedPayload: json<Record<string, unknown>>(row.payload_json),
        artifactRefs: json<string[]>(row.artifact_refs_json),
        priorHash: row.prior_hash as string,
        currentHash: row.current_hash as string,
      };
    });
  }

  function verifyAudit(scope: TenantScope): boolean {
    let priorHash = "GENESIS";
    for (const event of auditEvents(scope)) {
      if (event.priorHash !== priorHash) return false;
      const unsigned = {
        ...(event.schemaVersion >= 3 ? { operatorId: event.operatorId } : {}),
        eventId: event.eventId,
        ...(event.schemaVersion >= 2 ? { sequence: event.sequence } : {}),
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
        "SELECT connection_id, payload_hash FROM webhook_events WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND provider = ? AND provider_event_id = ?",
      )
      .get(...scopeWhere(scope), provider, providerEventId) as
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
        "INSERT OR IGNORE INTO webhook_events (operator_id, venture_id, customer_organization_id, connection_id, provider, provider_event_id, occurred_at, payload_hash) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        ...scopeWhere(scope),
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
        "UPDATE organizations SET status = 'offboarded' WHERE operator_id = ? AND venture_id = ? AND organization_id = ?",
      ).run(...scopeWhere(scope));
      db.prepare(
        "UPDATE subscriptions SET status = 'cancelled' WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ?",
      ).run(...scopeWhere(scope));
      db.prepare(
        "UPDATE entitlements SET status = 'revoked' WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ?",
      ).run(...scopeWhere(scope));
      db.prepare(
        "UPDATE provider_connections SET status = 'revoked', revoked_at = ? WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ?",
      ).run(at.toISOString(), ...scopeWhere(scope));
      db.prepare(
        "UPDATE service_grants SET revoked_at = ? WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND revoked_at IS NULL",
      ).run(at.toISOString(), ...scopeWhere(scope));
      db.prepare(
        "UPDATE agent_grants SET revoked_at = ? WHERE operator_id = ? AND venture_id = ? AND customer_organization_id = ? AND revoked_at IS NULL",
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
    quarantineEntitlementUsage,
    releaseEntitlementUsage,
    usageStatus,
    entitlementUsage,
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
