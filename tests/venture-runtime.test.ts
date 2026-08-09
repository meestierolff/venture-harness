import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderOperationError,
  VentureRuntimeError,
  createTenantCredentialBroker,
  createVentureRuntimeService,
  createVentureRuntimeStore,
  type ExecuteServiceInput,
  type ProviderConnectionRecord,
  type TenantScope,
  type VentureRuntimeStore,
} from "@/lib/venture-runtime";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CANARY_A = "vh_canary_customer_a_7mYk9Q";
const CANARY_B = "vh_canary_customer_b_3xVp2L";

const directories: string[] = [];
const stores: VentureRuntimeStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function scope(venture: string, customer: string, user?: string): TenantScope {
  return {
    operatorId: "operator-vh",
    ventureId: venture,
    customerOrganizationId: customer,
    ...(user ? { userId: user } : {}),
  };
}

function connection(
  selectedScope: TenantScope,
  connectionId: string,
  externalAccountId: string,
): ProviderConnectionRecord {
  return {
    connectionId,
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    stackClass: "customer",
    provider: "tiktok",
    externalAccountId,
    credentialRef: `cred://tenant/${selectedScope.ventureId}/${selectedScope.customerOrganizationId}/${connectionId}`,
    ownership: "customer_owned",
    ownerOrganizationId: selectedScope.customerOrganizationId,
    scopes: ["video.publish"],
    capabilities: ["social.publish"],
    status: "verified",
    lastVerifiedAt: NOW.toISOString(),
    revokedAt: null,
  };
}

function openRuntime() {
  const directory = mkdtempSync(join(tmpdir(), "vh-venture-runtime-"));
  directories.push(directory);
  const filename = join(directory, "runtime.sqlite");
  let sequence = 0;
  const store = createVentureRuntimeStore(filename, {
    id: () => `id-${String(++sequence).padStart(6, "0")}`,
    now: () => NOW,
  });
  stores.push(store);
  const credentials = createTenantCredentialBroker();
  const service = createVentureRuntimeService(store, credentials, () => NOW);
  return { filename, store, credentials, service };
}

function installCustomer(
  runtime: ReturnType<typeof openRuntime>,
  selectedScope: TenantScope,
  suffix: string,
  secret: string,
) {
  const { store, credentials } = runtime;
  const userId = selectedScope.userId ?? `user-${suffix}`;
  const subscriptionId = `subscription-${suffix}`;
  const entitlementId = `entitlement-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const serviceGrantId = `service-grant-${suffix}`;
  const blueprintId = `blueprint-${suffix}`;

  store.createOrganization({
    organizationId: selectedScope.customerOrganizationId,
    ventureId: selectedScope.ventureId,
    kind: "customer",
    name: `Customer ${suffix}`,
    status: "active",
  });
  store.createUser(selectedScope.ventureId, userId);
  store.addMembership(
    selectedScope.ventureId,
    selectedScope.customerOrganizationId,
    userId,
    "owner",
  );
  store.putSubscription({
    subscriptionId,
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    planId: "plan-growth",
    status: "active",
  });
  store.putEntitlement({
    entitlementId,
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    subscriptionId,
    capability: "social.publish",
    remainingUnits: 3,
    status: "active",
  });
  const selectedConnection = connection(selectedScope, connectionId, `external-${suffix}`);
  store.putConnection(selectedConnection);
  credentials.register(selectedScope, selectedConnection, secret);
  store.putBlueprint({
    blueprintId,
    ventureId: selectedScope.ventureId,
    version: 1,
    outcome: "publish one approved fixture post",
    commandId: "posts.publish",
    requiredCapabilities: ["social.publish"],
    usageUnit: "published_post",
    billingUnit: "published_post",
    completionCriteria: ["provider read-back verified"],
    workflowGraph: { nodes: ["authorize", "publish", "reconcile"] },
    policy: { realEffects: false },
  });
  store.putServiceGrant({
    serviceGrantId,
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    blueprintId,
    blueprintVersion: 1,
    connectionIds: [connectionId],
    grantedByUserId: userId,
    notBefore: new Date("2026-08-09T11:00:00.000Z").toISOString(),
    expiresAt: new Date("2026-08-10T12:00:00.000Z").toISOString(),
    revokedAt: null,
  });
  store.putResource({
    resourceId: `resource-${suffix}`,
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    provider: "tiktok",
    externalAccountId: `external-${suffix}`,
    externalResourceId: `post-${suffix}`,
    ownership: "customer_owned",
    preservationState: "preserve",
  });
  return {
    subscriptionId,
    entitlementId,
    connectionId,
    serviceGrantId,
    blueprintId,
  };
}

function executeInput(
  selectedScope: TenantScope,
  ids: ReturnType<typeof installCustomer>,
  idempotencyKey: string,
  overrides: Partial<ExecuteServiceInput> = {},
): ExecuteServiceInput {
  return {
    scope: selectedScope,
    serviceGrantId: ids.serviceGrantId,
    providerConnectionId: ids.connectionId,
    capability: "social.publish",
    commandId: "posts.publish",
    authorizationEnvelopeId: "envelope-fixture-only",
    runId: `run-${idempotencyKey}`,
    nodeId: "publish",
    correlationId: `correlation-${idempotencyKey}`,
    causationId: "command-fixture",
    idempotencyKey,
    usageUnits: 1,
    ...overrides,
  };
}

function runtimeError(error: unknown, code: VentureRuntimeError["code"]): boolean {
  return error instanceof VentureRuntimeError && error.code === code;
}

describe("recursive venture runtime", () => {
  it("binds customer execution to membership, subscription, entitlement, grant and connection", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    let observedIdentity: unknown;

    const output = await runtime.service.execute(
      executeInput(tenantA, ids, "success-1"),
      (secret, identity) => {
        expect(secret).toBe(CANARY_A);
        observedIdentity = identity;
        return Promise.resolve({ providerPostId: "fixture-post-a", verified: true });
      },
    );

    expect(output).toEqual({ providerPostId: "fixture-post-a", verified: true });
    expect(observedIdentity).toMatchObject({
      operatorId: "operator-vh",
      ventureId: "venture-a",
      customerOrganizationId: "customer-a",
      userId: "user-a",
      subscriptionId: ids.subscriptionId,
      entitlementId: ids.entitlementId,
      serviceGrantId: ids.serviceGrantId,
      providerConnectionId: ids.connectionId,
      authorizationEnvelopeId: "envelope-fixture-only",
      runId: "run-success-1",
      nodeId: "publish",
    });
    expect(runtime.store.usageStatus(tenantA, "success-1")).toBe("completed");
    expect(runtime.store.verifyAudit(tenantA)).toBe(true);
    const observable = JSON.stringify(runtime.store.auditEvents(tenantA));
    expect(observable).not.toContain(CANARY_A);
    expect(observable).not.toContain("cred://");
  });

  it("fails closed for anonymous callers and ungranted agent identities", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);

    await expect(
      runtime.service.execute(
        executeInput(scope("venture-a", "customer-a"), ids, "anonymous"),
        () => Promise.resolve({ ok: true }),
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "tenant_scope_mismatch"));

    await expect(
      runtime.service.execute(
        executeInput({ ...tenantA, agentId: "agent-forged" }, ids, "agent-forged"),
        () => Promise.resolve({ ok: true }),
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "agent_grant_invalid"));
  });

  it("isolates connections, credentials, resources, webhooks and agent grants by venture and customer", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const tenantB = scope("venture-b", "customer-b", "user-b");
    const idsA = installCustomer(runtime, tenantA, "a", CANARY_A);
    const idsB = installCustomer(runtime, tenantB, "b", CANARY_B);
    const agentTokenA = "agent-token-a";
    runtime.store.putAgentGrant({
      agentGrantId: "agent-grant-a",
      ventureId: tenantA.ventureId,
      customerOrganizationId: tenantA.customerOrganizationId,
      agentId: "agent-a",
      tokenDigest: createHash("sha256").update(agentTokenA).digest("hex"),
      scopes: ["posts.publish"],
      grantedByUserId: "user-a",
      expiresAt: new Date("2026-08-10T12:00:00.000Z").toISOString(),
      revokedAt: null,
    });

    expect(runtime.store.listConnections(tenantA).map((item) => item.connectionId)).toEqual([
      idsA.connectionId,
    ]);
    expect(runtime.store.listResources(tenantA).map((item) => item.resourceId)).toEqual([
      "resource-a",
    ]);
    expect(() => runtime.store.connection(tenantB, idsA.connectionId)).toThrowError(/not found/);
    expect(() => runtime.credentials.inspect(tenantB, idsA.connectionId)).toThrowError(
      /unavailable/,
    );
    expect(runtime.credentials.list(tenantB)).toEqual([
      `cred://tenant/venture-b/customer-b/${idsB.connectionId}`,
    ]);

    await expect(
      runtime.service.execute(
        executeInput(scope("venture-b", "customer-b"), idsB, "cross-agent", {
          agentToken: agentTokenA,
        }),
        () => Promise.resolve({ ok: true }),
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "agent_grant_invalid"));

    expect(() =>
      runtime.store.recordWebhook(tenantB, idsA.connectionId, "tiktok", "event-a", { ok: true }),
    ).toThrowError(/not found/);
    expect(
      runtime.store.recordWebhook(tenantA, idsA.connectionId, "tiktok", "event-shared", {}),
    ).toBe("created");
    expect(
      runtime.store.recordWebhook(tenantB, idsB.connectionId, "tiktok", "event-shared", {}),
    ).toBe("created");
  });

  it("binds idempotency to the complete request and never repeats an external write", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    let calls = 0;
    const provider = () => {
      calls += 1;
      return Promise.resolve({ providerPostId: "post-a" });
    };

    await runtime.service.execute(executeInput(tenantA, ids, "bound-key"), provider);
    await expect(
      runtime.service.execute(executeInput(tenantA, ids, "bound-key"), provider),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "idempotency_replay"));
    await expect(
      runtime.service.execute(executeInput(tenantA, ids, "bound-key", { usageUnits: 2 }), provider),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "idempotency_conflict"));
    expect(calls).toBe(1);
  });

  it("retains metering headroom for unknown outcomes and releases only definitive no-effect failures", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);

    await expect(
      runtime.service.execute(executeInput(tenantA, ids, "unknown"), () => {
        throw new Error(`timeout after write ${CANARY_A}`);
      }),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "external_outcome_unknown"));
    expect(runtime.store.usageStatus(tenantA, "unknown")).toBe("unknown");

    await expect(
      runtime.service.execute(executeInput(tenantA, ids, "definitive"), () => {
        throw new ProviderOperationError(
          "definitive_no_effect",
          `request rejected before write ${CANARY_A}`,
        );
      }),
    ).rejects.toMatchObject({
      name: "ProviderOperationError",
      outcome: "definitive_no_effect",
      message: "request rejected before write [REDACTED]",
    });
    expect(runtime.store.usageStatus(tenantA, "definitive")).toBe("released");
    expect(JSON.stringify(runtime.store.auditEvents(tenantA))).not.toContain(CANARY_A);
  });

  it("blocks a provider adapter from returning a credential and rotates without exposing it", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    const rotated = "vh_canary_rotated_q8Jz4N";
    runtime.credentials.rotate(tenantA, ids.connectionId, rotated);

    expect(runtime.credentials.inspect(tenantA, ids.connectionId)).toEqual({
      credentialRef: `cred://tenant/venture-a/customer-a/${ids.connectionId}`,
      revoked: false,
    });
    await expect(
      runtime.service.execute(executeInput(tenantA, ids, "leak"), (secret) =>
        Promise.resolve({ accidentalDebugValue: secret }),
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "external_outcome_unknown"));
    const observable = JSON.stringify(runtime.store.auditEvents(tenantA));
    expect(observable).not.toContain(CANARY_A);
    expect(observable).not.toContain(rotated);
  });

  it("revokes access during offboarding while preserving customer-owned resource records", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);

    runtime.store.offboard(tenantA);
    expect(runtime.store.organization(tenantA).status).toBe("offboarded");
    expect(runtime.store.connection(tenantA, ids.connectionId).status).toBe("revoked");
    expect(runtime.store.listResources(tenantA)).toMatchObject([
      { resourceId: "resource-a", preservationState: "preserve", ownership: "customer_owned" },
    ]);
    await expect(
      runtime.service.execute(executeInput(tenantA, ids, "after-offboard"), () =>
        Promise.resolve({ ok: true }),
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "customer_offboarded"));
  });

  it("detects audit-chain tampering", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    await runtime.service.execute(executeInput(tenantA, ids, "audit"), () =>
      Promise.resolve({ ok: true }),
    );
    expect(runtime.store.verifyAudit(tenantA)).toBe(true);

    runtime.store.close();
    stores.pop();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const db = new DatabaseSync(runtime.filename);
    db.exec(
      "UPDATE audit_events SET payload_json = '{\"tampered\":true}' WHERE kind = 'service.execution.completed'",
    );
    db.close();

    const reopened = createVentureRuntimeStore(runtime.filename, { now: () => NOW });
    stores.push(reopened);
    expect(reopened.verifyAudit(tenantA)).toBe(false);
  });

  it("rejects webhook replay conflicts without crossing tenant boundaries", () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    expect(
      runtime.store.recordWebhook(tenantA, ids.connectionId, "tiktok", "provider-event-1", {
        postId: "post-a",
      }),
    ).toBe("created");
    expect(
      runtime.store.recordWebhook(tenantA, ids.connectionId, "tiktok", "provider-event-1", {
        postId: "post-a",
      }),
    ).toBe("duplicate");
    expect(() =>
      runtime.store.recordWebhook(tenantA, ids.connectionId, "tiktok", "provider-event-1", {
        postId: "post-b",
      }),
    ).toThrowError(/different event/);
  });
});
