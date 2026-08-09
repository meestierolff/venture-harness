import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderOperationError,
  VentureRuntimeError,
  createTenantCredentialBroker,
  createVentureRuntimeService,
  createVentureRuntimeStore,
  type ExecuteServiceInput,
  type ProviderOutputPolicy,
  type ProviderConnectionRecord,
  type ReconcileServiceInput,
  type TenantScope,
  type VentureRuntimeStore,
} from "@/lib/venture-runtime";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CANARY_A = "vh_canary_customer_a_7mYk9Q";
const CANARY_B = "vh_canary_customer_b_3xVp2L";

const directories: string[] = [];
const stores: VentureRuntimeStore[] = [];

const PROVIDER_OUTPUT_POLICIES: readonly ProviderOutputPolicy[] = [
  {
    commandId: "posts.publish",
    provider: "tiktok",
    capability: "social.publish",
    validate: (result) => {
      if (!result || Array.isArray(result) || typeof result !== "object") return false;
      const record = result as Record<string, unknown>;
      const keys = Object.keys(record);
      if (
        keys.length === 0 ||
        keys.some((key) => !["providerPostId", "verified", "ok"].includes(key))
      ) {
        return false;
      }
      return (
        (record.providerPostId === undefined || typeof record.providerPostId === "string") &&
        (record.verified === undefined || typeof record.verified === "boolean") &&
        (record.ok === undefined || typeof record.ok === "boolean")
      );
    },
  },
];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function scope(
  venture: string,
  customer: string,
  user?: string,
  operator = "operator-vh",
): TenantScope {
  return {
    operatorId: operator,
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
    operatorId: selectedScope.operatorId,
    connectionId,
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    stackClass: "customer",
    provider: "tiktok",
    externalAccountId,
    credentialRef: `cred://tenant/${selectedScope.operatorId}/${selectedScope.ventureId}/${selectedScope.customerOrganizationId}/${connectionId}`,
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
  const service = createVentureRuntimeService(store, credentials, {
    now: () => NOW,
    providerOutputPolicies: PROVIDER_OUTPUT_POLICIES,
    verifyAuthorization: (input) =>
      input.authorizationEnvelopeId === "envelope-fixture-only" &&
      input.at.toISOString() === NOW.toISOString(),
  });
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
    operatorId: selectedScope.operatorId,
    organizationId: selectedScope.customerOrganizationId,
    ventureId: selectedScope.ventureId,
    kind: "customer",
    name: `Customer ${suffix}`,
    status: "active",
  });
  store.createUser(selectedScope, userId);
  store.addMembership(selectedScope, userId, "owner");
  store.putSubscription({
    operatorId: selectedScope.operatorId,
    subscriptionId,
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    planId: "plan-growth",
    status: "active",
  });
  store.putEntitlement({
    operatorId: selectedScope.operatorId,
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
    operatorId: selectedScope.operatorId,
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
    operatorId: selectedScope.operatorId,
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
    operatorId: selectedScope.operatorId,
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
    subscriptionId: ids.subscriptionId,
    entitlementId: ids.entitlementId,
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

function reconcileInput(input: ExecuteServiceInput): ReconcileServiceInput {
  const {
    authorizationEnvelopeId: _authorizationEnvelopeId,
    agentToken: _agentToken,
    ...rest
  } = input;
  void _authorizationEnvelopeId;
  void _agentToken;
  return {
    ...rest,
    reconciliationAuthorizationEnvelopeId: "envelope-fixture-only",
    reconciliationCommandId: "posts.reconcile",
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

  it("rejects credential-shaped operation requests before reservation and stores only safe digests", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-request", "customer-request", "user-request");
    const ids = installCustomer(runtime, tenantA, "request", CANARY_A);
    const provider = vi.fn(() => Promise.resolve({ providerPostId: "fixture-post-request" }));
    const secondarySecret = "whsec_secondary_fixture_8Hk2Lm9Q";
    await expect(
      runtime.service.execute(
        executeInput(tenantA, ids, "unsafe-operation-request", {
          operationRequest: { receiptHint: secondarySecret },
        }),
        provider,
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "credential_leak_detected"));
    expect(provider).not.toHaveBeenCalled();
    expect(runtime.store.usageStatus(tenantA, "unsafe-operation-request")).toBeNull();

    await expect(
      runtime.service.execute(
        executeInput(tenantA, ids, "unsafe-identifier", {
          authorizationEnvelopeId: "whsec_secondary_auditboundary123456",
        }),
        provider,
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "credential_leak_detected"));
    expect(provider).not.toHaveBeenCalled();
    expect(runtime.store.usageStatus(tenantA, "unsafe-identifier")).toBeNull();

    await runtime.service.execute(
      executeInput(tenantA, ids, "safe-operation-request", {
        operationRequest: { requestId: "safe-request-marker", approved: true },
      }),
      provider,
    );
    const binding = runtime.store.entitlementUsage(tenantA, "safe-operation-request")
      ?.operationBinding as unknown as Record<string, unknown>;
    expect(binding).not.toHaveProperty("operationRequest");
    expect(binding.operationRequestHash).toMatch(/^[a-f0-9]{64}$/u);

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (databaseFile: string) => {
        prepare(sql: string): { all(...values: unknown[]): Record<string, unknown>[] };
        close(): void;
      };
    };
    const database = new DatabaseSync(runtime.filename);
    const rows = database
      .prepare(
        "SELECT idempotency_key, operation_binding_json FROM usage_records ORDER BY idempotency_key",
      )
      .all();
    database.close();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secondarySecret);
    expect(JSON.stringify(rows)).not.toContain("safe-request-marker");
    expect(JSON.stringify(rows)).not.toContain('operationRequest"');
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

  it("requires explicit subscription, entitlement and authorization-envelope binding", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    const operation = vi.fn(() => Promise.resolve({ ok: true }));

    await expect(
      runtime.service.execute(
        executeInput(tenantA, ids, "wrong-subscription", {
          subscriptionId: "subscription-other",
        }),
        operation,
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "subscription_inactive"));
    await expect(
      runtime.service.execute(
        executeInput(tenantA, ids, "wrong-entitlement", {
          entitlementId: "entitlement-other",
        }),
        operation,
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "entitlement_missing"));
    await expect(
      runtime.service.execute(
        executeInput(tenantA, ids, "wrong-envelope", {
          authorizationEnvelopeId: "forged-envelope",
        }),
        operation,
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "authorization_envelope_invalid"));
    expect(operation).not.toHaveBeenCalled();
    expect(runtime.store.usageStatus(tenantA, "wrong-envelope")).toBeNull();
  });

  it("requires an exact command/provider output policy before invoking the provider", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-policy", "customer-policy", "user-policy");
    const ids = installCustomer(runtime, tenantA, "policy", CANARY_A);
    const serviceWithoutPolicy = createVentureRuntimeService(runtime.store, runtime.credentials, {
      now: () => NOW,
      providerOutputPolicies: [],
      verifyAuthorization: ({ authorizationEnvelopeId }) =>
        authorizationEnvelopeId === "envelope-fixture-only",
    });
    const provider = vi.fn(() => Promise.resolve({ ok: true }));

    await expect(
      serviceWithoutPolicy.execute(executeInput(tenantA, ids, "missing-output-policy"), provider),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "capability_unavailable"));
    expect(provider).not.toHaveBeenCalled();
    expect(runtime.store.usageStatus(tenantA, "missing-output-policy")).toBeNull();
  });

  it("isolates connections, credentials, resources, webhooks and agent grants by operator, venture and customer", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const tenantB = scope("venture-b", "customer-b", "user-b");
    const idsA = installCustomer(runtime, tenantA, "a", CANARY_A);
    const idsB = installCustomer(runtime, tenantB, "b", CANARY_B);
    const agentTokenA = "agent-token-a";
    runtime.store.putAgentGrant({
      operatorId: tenantA.operatorId,
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
      `cred://tenant/operator-vh/venture-b/customer-b/${idsB.connectionId}`,
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

  it("isolates identical recursive identifiers across platform operators", async () => {
    const runtime = openRuntime();
    const operatorA = scope("venture-shared", "customer-shared", undefined, "operator-a");
    const operatorB = scope("venture-shared", "customer-shared", undefined, "operator-b");
    const idsA = installCustomer(runtime, operatorA, "shared", CANARY_A);
    const idsB = installCustomer(runtime, operatorB, "shared", CANARY_B);
    expect(idsA).toEqual(idsB);

    const token = "agent-token-shared";
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    const putAgentGrant = (selectedScope: TenantScope) =>
      runtime.store.putAgentGrant({
        operatorId: selectedScope.operatorId,
        agentGrantId: "agent-grant-shared",
        ventureId: selectedScope.ventureId,
        customerOrganizationId: selectedScope.customerOrganizationId,
        agentId: "agent-shared",
        tokenDigest,
        scopes: ["posts.publish"],
        grantedByUserId: "user-shared",
        expiresAt: new Date("2026-08-10T12:00:00.000Z").toISOString(),
        revokedAt: null,
      });
    putAgentGrant(operatorA);

    const rejectedProvider = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(
      runtime.service.execute(
        executeInput(operatorB, idsB, "same-operation", { agentToken: token }),
        rejectedProvider,
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "agent_grant_invalid"));
    expect(rejectedProvider).not.toHaveBeenCalled();

    putAgentGrant(operatorB);
    const secretsByOperator = new Map<string, string>();
    for (const [selectedScope, ids, expectedSecret] of [
      [operatorA, idsA, CANARY_A],
      [operatorB, idsB, CANARY_B],
    ] as const) {
      await runtime.service.execute(
        executeInput(selectedScope, ids, "same-operation", { agentToken: token }),
        (secret, identity) => {
          expect(secret).toBe(expectedSecret);
          secretsByOperator.set(identity.operatorId, secret);
          return Promise.resolve({ providerPostId: "post-shared", verified: true });
        },
      );
      expect(runtime.store.organization(selectedScope).operatorId).toBe(selectedScope.operatorId);
      expect(runtime.store.connection(selectedScope, ids.connectionId).operatorId).toBe(
        selectedScope.operatorId,
      );
      expect(runtime.store.listResources(selectedScope)).toMatchObject([
        { operatorId: selectedScope.operatorId, resourceId: "resource-shared" },
      ]);
      expect(runtime.store.usageStatus(selectedScope, "same-operation")).toBe("completed");
      expect(runtime.store.auditEvents(selectedScope)).toHaveLength(2);
      expect(runtime.store.verifyAudit(selectedScope)).toBe(true);
      expect(
        runtime.store.recordWebhook(
          selectedScope,
          ids.connectionId,
          "tiktok",
          "provider-event-shared",
          { postId: "post-shared" },
        ),
      ).toBe("created");
    }
    expect(secretsByOperator).toEqual(
      new Map([
        ["operator-a", CANARY_A],
        ["operator-b", CANARY_B],
      ]),
    );

    expect(() =>
      runtime.credentials.register(
        operatorA,
        { ...runtime.store.connection(operatorA, idsA.connectionId), operatorId: "operator-b" },
        "forged-cross-operator-secret",
      ),
    ).toThrowError(/scope mismatch/);

    runtime.service.offboard(operatorA);
    expect(runtime.store.organization(operatorA).status).toBe("offboarded");
    expect(runtime.store.connection(operatorA, idsA.connectionId).status).toBe("revoked");
    expect(runtime.credentials.inspect(operatorA, idsA.connectionId).revoked).toBe(true);
    expect(runtime.store.organization(operatorB).status).toBe("active");
    expect(runtime.store.connection(operatorB, idsB.connectionId).status).toBe("verified");
    expect(runtime.credentials.inspect(operatorB, idsB.connectionId).revoked).toBe(false);
    expect(runtime.store.listResources(operatorA)).toHaveLength(1);
    expect(runtime.store.listResources(operatorB)).toHaveLength(1);
  });

  it("rejects an expired Agent Grant before the provider callback", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    const expiredToken = "expired-agent-token";
    runtime.store.putAgentGrant({
      operatorId: tenantA.operatorId,
      agentGrantId: "agent-grant-expired",
      ventureId: tenantA.ventureId,
      customerOrganizationId: tenantA.customerOrganizationId,
      agentId: "agent-expired",
      tokenDigest: createHash("sha256").update(expiredToken).digest("hex"),
      scopes: ["posts.publish"],
      grantedByUserId: "user-a",
      expiresAt: NOW.toISOString(),
      revokedAt: null,
    });
    const provider = vi.fn(() => Promise.resolve({ ok: true }));

    await expect(
      runtime.service.execute(
        executeInput(tenantA, ids, "expired-agent-grant", { agentToken: expiredToken }),
        provider,
      ),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "agent_grant_invalid"));
    expect(provider).not.toHaveBeenCalled();
    expect(runtime.store.usageStatus(tenantA, "expired-agent-grant")).toBeNull();
    expect(runtime.store.auditEvents(tenantA)).toEqual([]);
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

  it("stops before the provider when a finite entitlement is exhausted", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    const operation = vi.fn(() => Promise.resolve({ ok: true }));
    for (const key of ["unit-1", "unit-2", "unit-3"]) {
      await runtime.service.execute(executeInput(tenantA, ids, key), operation);
    }
    await expect(
      runtime.service.execute(executeInput(tenantA, ids, "unit-4"), operation),
    ).rejects.toSatisfy((error: unknown) => runtimeError(error, "entitlement_exhausted"));
    expect(operation).toHaveBeenCalledTimes(3);
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

  it("recovers a crash-after-effect reservation by durable provider read-back after restart", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    const providerResults = new Map<string, { providerPostId: string; verified: boolean }>();
    const apply = vi.fn((_: string, identity: { providerOperationId: string }) => {
      const result = { providerPostId: "post-after-crash", verified: true };
      providerResults.set(identity.providerOperationId, result);
      return Promise.resolve(result);
    });
    const crashStore = {
      ...runtime.store,
      settleEntitlementUsage: () => {
        throw new Error("simulated process crash before local settlement");
      },
    } as VentureRuntimeStore;
    const crashingService = createVentureRuntimeService(crashStore, runtime.credentials, {
      now: () => NOW,
      providerOutputPolicies: PROVIDER_OUTPUT_POLICIES,
      verifyAuthorization: ({ authorizationEnvelopeId }) =>
        authorizationEnvelopeId === "envelope-fixture-only",
    });
    const request = executeInput(tenantA, ids, "crash-after-effect", {
      operationRequest: { approvedPostId: "fixture-post" },
    });

    await expect(crashingService.execute(request, apply)).rejects.toThrow(
      /simulated process crash/,
    );
    expect(apply).toHaveBeenCalledOnce();
    expect(runtime.store.usageStatus(tenantA, request.idempotencyKey)).toBe("reserved");
    const durableOperation = runtime.store.entitlementUsage(tenantA, request.idempotencyKey);
    expect(durableOperation?.providerOperationId).toMatch(/^svc_op_[a-f0-9]{64}$/);

    runtime.store.close();
    stores.splice(stores.indexOf(runtime.store), 1);
    const restartedStore = createVentureRuntimeStore(runtime.filename, { now: () => NOW });
    stores.push(restartedStore);
    const restartedCredentials = createTenantCredentialBroker();
    restartedCredentials.register(
      tenantA,
      restartedStore.connection(tenantA, ids.connectionId),
      CANARY_A,
    );
    const restartedService = createVentureRuntimeService(restartedStore, restartedCredentials, {
      now: () => NOW,
      providerOutputPolicies: PROVIDER_OUTPUT_POLICIES,
      verifyAuthorization: ({ authorizationEnvelopeId }) =>
        authorizationEnvelopeId === "envelope-fixture-only",
      verifyReconciliationAuthorization: ({
        reconciliationAuthorizationEnvelopeId,
        reconciliationCommandId,
      }) =>
        reconciliationAuthorizationEnvelopeId === "reconciliation-fixture-only" &&
        reconciliationCommandId === "posts.reconcile",
    });
    const readBack = vi.fn((providerOperationId: string) => {
      const result = providerResults.get(providerOperationId);
      return Promise.resolve(
        result
          ? ({ outcome: "completed", result } as const)
          : ({ outcome: "definitive_no_effect" } as const),
      );
    });

    const { authorizationEnvelopeId: _authorizationEnvelopeId, ...immutableRequest } = request;
    void _authorizationEnvelopeId;
    const reconciliationRequest = {
      ...immutableRequest,
      reconciliationAuthorizationEnvelopeId: "reconciliation-fixture-only",
      reconciliationCommandId: "posts.reconcile",
    };
    await expect(restartedService.reconcile(reconciliationRequest, readBack)).resolves.toEqual({
      status: "completed",
      providerOperationId: durableOperation!.providerOperationId,
      result: { providerPostId: "post-after-crash", verified: true },
    });
    expect(readBack).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(restartedStore.usageStatus(tenantA, request.idempotencyKey)).toBe("completed");
    await expect(
      restartedService.reconcile(reconciliationRequest, readBack),
    ).resolves.toMatchObject({
      status: "completed",
      result: { providerPostId: "post-after-crash", verified: true },
    });
    expect(readBack).toHaveBeenCalledOnce();
  });

  it("returns manual reconciliation without re-applying after credential revocation or offboarding", async () => {
    const runtime = openRuntime();
    const credentialScope = scope("venture-manual", "customer-credential", "user-credential");
    const credentialIds = installCustomer(runtime, credentialScope, "credential", CANARY_A);
    const credentialRequest = executeInput(credentialScope, credentialIds, "manual-credential");
    const providerApply = vi.fn(() => Promise.reject(new Error("timeout after provider write")));
    await expect(runtime.service.execute(credentialRequest, providerApply)).rejects.toSatisfy(
      (error: unknown) => runtimeError(error, "external_outcome_unknown"),
    );
    runtime.credentials.revoke(credentialScope, credentialIds.connectionId);
    const credentialReadBack = vi.fn();
    await expect(
      runtime.service.reconcile(reconcileInput(credentialRequest), credentialReadBack),
    ).resolves.toEqual({
      status: "manual_required",
      providerOperationId: runtime.store.entitlementUsage(
        credentialScope,
        credentialRequest.idempotencyKey,
      )!.providerOperationId,
      reason: "credential_unavailable",
      message: "Provider credential is revoked; manual provider-side reconciliation is required",
    });
    expect(credentialReadBack).not.toHaveBeenCalled();
    expect(runtime.store.usageStatus(credentialScope, credentialRequest.idempotencyKey)).toBe(
      "unknown",
    );

    const offboardedScope = scope("venture-manual", "customer-offboarded", "user-offboarded");
    const offboardedIds = installCustomer(runtime, offboardedScope, "offboarded", CANARY_B);
    const offboardedRequest = executeInput(offboardedScope, offboardedIds, "manual-offboarded");
    await expect(runtime.service.execute(offboardedRequest, providerApply)).rejects.toSatisfy(
      (error: unknown) => runtimeError(error, "external_outcome_unknown"),
    );
    runtime.service.offboard(offboardedScope);
    const offboardedReadBack = vi.fn();
    await expect(
      runtime.service.reconcile(reconcileInput(offboardedRequest), offboardedReadBack),
    ).resolves.toMatchObject({
      status: "manual_required",
      reason: "customer_offboarded",
      message: expect.stringContaining("original provider operation was not repeated"),
    });
    expect(offboardedReadBack).not.toHaveBeenCalled();
    expect(providerApply).toHaveBeenCalledTimes(2);
    expect(runtime.store.usageStatus(offboardedScope, offboardedRequest.idempotencyKey)).toBe(
      "unknown",
    );
  });

  it("blocks a provider adapter from returning a credential and rotates without exposing it", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    const rotated = "vh_canary_rotated_q8Jz4N";
    runtime.credentials.rotate(tenantA, ids.connectionId, rotated);

    expect(runtime.credentials.inspect(tenantA, ids.connectionId)).toEqual({
      credentialRef: `cred://tenant/operator-vh/venture-a/customer-a/${ids.connectionId}`,
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

  it("quarantines unregistered nested credentials before execute or reconciliation settlement", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-output-safety", "customer-output-safety", "user-output-safety");
    const ids = installCustomer(runtime, tenantA, "output-safety", CANARY_A);
    const request = executeInput(tenantA, ids, "secondary-output-secret");
    const webhookSecret = "whsec_secondary_unregistered_8Kp4Lr2N";
    const accessToken = "opaque-secondary-token-material-7Jn3Mq9P";

    let executionError: unknown;
    try {
      await runtime.service.execute(request, () =>
        Promise.resolve({
          providerPostId: "post-with-unsafe-metadata",
          verified: true,
          providerMetadata: { receiptHint: webhookSecret },
        }),
      );
    } catch (error) {
      executionError = error;
    }
    expect(executionError).toMatchObject({
      code: "external_outcome_unknown",
      message: "provider outcome is unknown and requires reconciliation",
    });
    expect(JSON.stringify(executionError)).not.toContain(webhookSecret);
    expect(runtime.store.entitlementUsage(tenantA, request.idempotencyKey)).toMatchObject({
      status: "unknown",
      result: undefined,
    });

    await expect(
      runtime.service.reconcile(reconcileInput(request), () =>
        Promise.resolve({
          outcome: "completed" as const,
          result: {
            providerPostId: "post-with-unsafe-metadata",
            verified: true,
            nested: [{ secondaryToken: accessToken }],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "external_outcome_unknown",
      message: "provider read-back is inconclusive; the original operation was not repeated",
    });
    expect(runtime.store.entitlementUsage(tenantA, request.idempotencyKey)).toMatchObject({
      status: "unknown",
      result: undefined,
    });

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (databaseFile: string) => {
        prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    const database = new DatabaseSync(runtime.filename);
    const rawUsage = database
      .prepare("SELECT status, result_json FROM usage_records WHERE idempotency_key = ?")
      .get(request.idempotencyKey);
    const rawAudit = database
      .prepare("SELECT group_concat(payload_json, '') AS payloads FROM audit_events")
      .get();
    database.close();
    expect(rawUsage).toEqual({ status: "unknown", result_json: null });
    expect(JSON.stringify(rawAudit)).not.toContain(webhookSecret);
    expect(JSON.stringify(rawAudit)).not.toContain(accessToken);
  });

  it("revokes access during offboarding while preserving customer-owned resource records", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);

    runtime.service.offboard(tenantA);
    expect(runtime.store.organization(tenantA).status).toBe("offboarded");
    expect(runtime.store.connection(tenantA, ids.connectionId).status).toBe("revoked");
    expect(runtime.store.listResources(tenantA)).toMatchObject([
      { resourceId: "resource-a", preservationState: "preserve", ownership: "customer_owned" },
    ]);
    expect(runtime.credentials.inspect(tenantA, ids.connectionId).revoked).toBe(true);
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

  it("rejects an audit identity moved across operator scope", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-shared", "customer-shared", "user-shared", "operator-a");
    const ids = installCustomer(runtime, tenantA, "shared", CANARY_A);
    await runtime.service.execute(executeInput(tenantA, ids, "audit-operator-scope"), () =>
      Promise.resolve({ ok: true }),
    );

    runtime.store.close();
    stores.pop();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const database = new DatabaseSync(runtime.filename);
    database.exec(`
      UPDATE audit_events
      SET identity_json = replace(
        identity_json,
        '"operatorId":"operator-a"',
        '"operatorId":"operator-b"'
      )
      WHERE sequence = 1
    `);
    database.close();

    const reopened = createVentureRuntimeStore(runtime.filename, { now: () => NOW });
    stores.push(reopened);
    expect(() => reopened.auditEvents(tenantA)).toThrowError(
      /audit identity does not match its operator tenant scope/i,
    );
  });

  it("serializes one audit chain across independent database clients", async () => {
    const runtime = openRuntime();
    const tenantA = scope("venture-a", "customer-a", "user-a");
    const ids = installCustomer(runtime, tenantA, "a", CANARY_A);
    await runtime.service.execute(executeInput(tenantA, ids, "audit-multi-client"), () =>
      Promise.resolve({ ok: true }),
    );
    const identity = runtime.store.auditEvents(tenantA)[0]!.identity;
    const second = createVentureRuntimeStore(runtime.filename, { now: () => NOW });
    stores.push(second);

    runtime.store.appendAudit(identity, "client-a", { fixture: true });
    second.appendAudit(identity, "client-b", { fixture: true });

    expect(runtime.store.auditEvents(tenantA).map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(runtime.store.verifyAudit(tenantA)).toBe(true);
    expect(second.verifyAudit(tenantA)).toBe(true);
  });

  it("stores operator_id in every recursive table and every primary key", () => {
    const runtime = openRuntime();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        prepare(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const database = new DatabaseSync(runtime.filename);
    const recursiveTables = [
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
    ];

    for (const table of recursiveTables) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        pk: number;
      }[];
      expect(columns.find(({ name }) => name === "operator_id")?.pk, table).toBeGreaterThan(0);
    }
    database.close();
  });

  it("fails closed for a legacy recursive database without an explicit operator mapping", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const directory = mkdtempSync(join(tmpdir(), "vh-venture-runtime-legacy-"));
    directories.push(directory);
    const filename = join(directory, "legacy.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(`
      CREATE TABLE webhook_events (
        venture_id TEXT NOT NULL,
        customer_organization_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        PRIMARY KEY (venture_id, customer_organization_id, provider, provider_event_id)
      )
    `);
    database.close();

    expect(() => createVentureRuntimeStore(filename)).toThrowError(
      /explicit operator tenant mapping/i,
    );
  });

  it("fails closed when operator_id was added without repairing the legacy primary key", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const directory = mkdtempSync(join(tmpdir(), "vh-venture-runtime-partial-scope-"));
    directories.push(directory);
    const filename = join(directory, "partially-scoped.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(`
      CREATE TABLE webhook_events (
        operator_id TEXT NOT NULL,
        venture_id TEXT NOT NULL,
        customer_organization_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        PRIMARY KEY (venture_id, customer_organization_id, provider, provider_event_id)
      )
    `);
    database.close();

    expect(() => createVentureRuntimeStore(filename)).toThrowError(
      /explicit operator tenant mapping/i,
    );
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
