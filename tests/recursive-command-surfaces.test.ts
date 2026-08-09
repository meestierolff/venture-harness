import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentGateway } from "../packages/agent-gateway/src/index";
import {
  createVentureRuntime,
  defineRecursiveServiceCommand,
  defineRecursiveServiceReconcileCommand,
  type RecursiveServiceCommandInput,
  type RecursiveServiceReconcileInput,
} from "../packages/agent-runtime/src/index";
import {
  commandFailureEnvelope,
  commandFailureHttpStatus,
  type CommandFailureEnvelope,
} from "../packages/command-bus/src/index";
import type { CommandExecutionContext, JsonObject } from "../packages/core/src/index";
import {
  createRecursiveVentureCommandRuntime,
  createTenantCredentialBroker,
  createVentureRuntimeService,
  createVentureRuntimeStore,
  type ProviderOutputPolicy,
  type TenantScope,
  type VentureRuntimeStore,
} from "../lib/venture-runtime";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const command = defineRecursiveServiceCommand({
  id: "nova-care.deliver",
  title: "Deliver Nova Care outcome",
  description: "Deliver the venture-specific Nova Care customer outcome.",
});
const reconciliation = defineRecursiveServiceReconcileCommand({
  id: "nova-care.reconcile",
  executionCommandId: command.id,
  title: "Reconcile Nova Care outcome",
  description: "Read back a Nova Care provider operation without repeating it.",
});
const directories: string[] = [];
const stores: VentureRuntimeStore[] = [];
const SECONDARY_WEBHOOK_SECRET = "whsec_secondary_fixture_8Hk2Lm9Q";
const SECONDARY_ACCESS_TOKEN = "opaque-secondary-token-material-9Lm3Np7R";
const PROVIDER_OUTPUT_POLICIES: readonly ProviderOutputPolicy[] = [
  {
    commandId: command.id,
    provider: "nova-fixture",
    capability: "nova.deliver",
    validate: (result) => {
      if (!result || Array.isArray(result) || typeof result !== "object") return false;
      const record = result as Record<string, unknown>;
      const keys = Object.keys(record);
      return (
        keys.length === 3 &&
        keys.every((key) =>
          ["providerReceiptId", "requestId", "brokeredReferenceResolved"].includes(key),
        ) &&
        typeof record.providerReceiptId === "string" &&
        typeof record.requestId === "string" &&
        typeof record.brokeredReferenceResolved === "boolean"
      );
    },
  },
];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scope(operatorId: string, ventureId: string, customerOrganizationId: string): TenantScope {
  return { operatorId, ventureId, customerOrganizationId, userId: `user-${operatorId}` };
}

function commandContext(
  selectedScope: TenantScope,
  kind: "user" | "agent" = "user",
  grantExpiresAt = "2026-08-10T12:00:00.000Z",
): CommandExecutionContext {
  const actorId = kind === "agent" ? `agent-${selectedScope.operatorId}` : selectedScope.userId!;
  return {
    identity: { actorId, kind },
    tenant: {
      organizationId: selectedScope.operatorId,
      ventureId: selectedScope.ventureId,
    },
    subscription: { subscriptionId: "outer-command", status: "none", plan: "service" },
    entitlements: [],
    scopes: ["service.execute", "service.reconcile"],
    grants: [
      {
        grantId: `command-grant-${selectedScope.operatorId}`,
        commandIds: [command.id, reconciliation.contract.id],
        scopes: ["service.execute", "service.reconcile"],
        expiresAt: grantExpiresAt,
      },
    ],
  };
}

function install(
  store: VentureRuntimeStore,
  credentials: ReturnType<typeof createTenantCredentialBroker>,
  selectedScope: TenantScope,
  credentialValue: string,
) {
  const userId = selectedScope.userId!;
  store.createOrganization({
    operatorId: selectedScope.operatorId,
    organizationId: selectedScope.customerOrganizationId,
    ventureId: selectedScope.ventureId,
    kind: "customer",
    name: selectedScope.customerOrganizationId,
    status: "active",
  });
  store.createUser(selectedScope, userId);
  store.addMembership(selectedScope, userId, "owner");
  store.putSubscription({
    operatorId: selectedScope.operatorId,
    subscriptionId: "subscription-shared",
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    planId: "nova-plan",
    status: "active",
  });
  store.putEntitlement({
    operatorId: selectedScope.operatorId,
    entitlementId: "entitlement-shared",
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    subscriptionId: "subscription-shared",
    capability: "nova.deliver",
    remainingUnits: 20,
    status: "active",
  });
  const connection = {
    operatorId: selectedScope.operatorId,
    connectionId: "connection-shared",
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    stackClass: "customer" as const,
    provider: "nova-fixture",
    externalAccountId: `account-${selectedScope.operatorId}`,
    credentialRef: `cred://tenant/${selectedScope.operatorId}/${selectedScope.ventureId}/${selectedScope.customerOrganizationId}/connection-shared`,
    ownership: "customer_owned" as const,
    ownerOrganizationId: selectedScope.customerOrganizationId,
    scopes: ["nova.deliver"],
    capabilities: ["nova.deliver"],
    status: "verified" as const,
    lastVerifiedAt: NOW.toISOString(),
    revokedAt: null,
  };
  store.putConnection(connection);
  credentials.register(selectedScope, connection, credentialValue);
  store.putBlueprint({
    operatorId: selectedScope.operatorId,
    blueprintId: "blueprint-shared",
    ventureId: selectedScope.ventureId,
    version: 1,
    outcome: "deliver one fixture outcome",
    commandId: command.id,
    requiredCapabilities: ["nova.deliver"],
    usageUnit: "delivery",
    billingUnit: "delivery",
    completionCriteria: ["fixture provider receipt"],
    workflowGraph: { nodes: ["deliver"] },
    policy: { fixture: true },
  });
  store.putServiceGrant({
    operatorId: selectedScope.operatorId,
    serviceGrantId: "service-grant-shared",
    ventureId: selectedScope.ventureId,
    customerOrganizationId: selectedScope.customerOrganizationId,
    blueprintId: "blueprint-shared",
    blueprintVersion: 1,
    connectionIds: ["connection-shared"],
    grantedByUserId: userId,
    notBefore: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-10T12:00:00.000Z",
    revokedAt: null,
  });
}

function input(customerOrganizationId: string): RecursiveServiceCommandInput {
  return {
    customerOrganizationId,
    subscriptionId: "subscription-shared",
    entitlementId: "entitlement-shared",
    serviceGrantId: "service-grant-shared",
    providerConnectionId: "connection-shared",
    capability: "nova.deliver",
    authorizationEnvelopeId: "envelope-approved",
    runId: "run-shared",
    nodeId: "deliver",
    correlationId: "correlation-shared",
    causationId: "customer-request",
    usageUnits: 1,
    payload: { requestId: "request-shared", approved: true },
  };
}

function reconcileInput(
  customerOrganizationId: string,
  operationIdempotencyKey: string,
  overrides: Partial<RecursiveServiceCommandInput> = {},
): RecursiveServiceReconcileInput {
  const original = { ...input(customerOrganizationId), ...overrides };
  const { authorizationEnvelopeId: _authorizationEnvelopeId, ...immutable } = original;
  void _authorizationEnvelopeId;
  return {
    ...immutable,
    reconciliationAuthorizationEnvelopeId: "reconciliation-envelope-approved",
    operationIdempotencyKey,
  };
}

function setup(selectedScopes: readonly TenantScope[], clock: () => Date = () => NOW) {
  const directory = mkdtempSync(join(tmpdir(), "vh-recursive-command-"));
  directories.push(directory);
  const store = createVentureRuntimeStore(join(directory, "runtime.sqlite"), {
    now: clock,
  });
  stores.push(store);
  const credentials = createTenantCredentialBroker();
  selectedScopes.forEach((selectedScope, index) =>
    install(store, credentials, selectedScope, `credential-canary-${index + 1}`),
  );
  const service = createVentureRuntimeService(store, credentials, {
    now: clock,
    providerOutputPolicies: PROVIDER_OUTPUT_POLICIES,
    verifyAuthorization: ({ authorizationEnvelopeId, commandId, at }) =>
      authorizationEnvelopeId === "envelope-approved" &&
      commandId === command.id &&
      at < new Date("2026-08-10T12:00:00.000Z"),
    verifyReconciliationAuthorization: ({
      reconciliationAuthorizationEnvelopeId,
      reconciliationCommandId,
      executionCommandId,
    }) =>
      reconciliationAuthorizationEnvelopeId === "reconciliation-envelope-approved" &&
      reconciliationCommandId === reconciliation.contract.id &&
      executionCommandId === command.id,
  });
  const providerResults = new Map<string, JsonObject>();
  const provider = vi.fn(async (request, credentialValue: string) => {
    const safeResult = {
      providerReceiptId: `receipt-${request.identity.operatorId}-${request.identity.ventureId}`,
      requestId: String(request.input.payload.requestId),
      brokeredReferenceResolved: credentialValue.startsWith("credential-canary-"),
    };
    const result: JsonObject =
      request.input.payload.simulateUnsafeOutput === true
        ? {
            ...safeResult,
            providerMetadata: { secondaryProviderSecret: SECONDARY_WEBHOOK_SECRET },
          }
        : safeResult;
    providerResults.set(request.identity.providerOperationId, result);
    if (request.input.payload.simulateUnknown === true) {
      throw new Error("simulated timeout after the provider effect");
    }
    return result;
  });
  const providerReadBack = vi.fn(async (request, credentialValue: string) => {
    const result = providerResults.get(request.providerOperationId);
    if (!credentialValue.startsWith("credential-canary-")) return { outcome: "unknown" as const };
    if (result && request.input.payload.simulateUnsafeReadBack === true) {
      return {
        outcome: "completed" as const,
        result: {
          ...result,
          providerMetadata: { secondaryToken: SECONDARY_ACCESS_TOKEN },
        },
      };
    }
    return result
      ? { outcome: "completed" as const, result }
      : { outcome: "definitive_no_effect" as const };
  });
  const agentTokens = new Map<string, string>();
  const recursiveCommandRuntime = createRecursiveVentureCommandRuntime({
    service,
    resolveAgentToken: ({ scope: agentScope }) =>
      agentTokens.get(
        `${agentScope.operatorId}:${agentScope.ventureId}:${agentScope.customerOrganizationId}:${agentScope.agentId}`,
      ) ?? "missing-agent-token",
    executeProvider: provider,
    reconcileProvider: providerReadBack,
  });
  const memberships = selectedScopes.flatMap((selectedScope) => [
    {
      organizationId: selectedScope.operatorId,
      actorId: selectedScope.userId!,
      role: "owner" as const,
      active: true,
    },
    {
      organizationId: selectedScope.operatorId,
      actorId: `agent-${selectedScope.operatorId}`,
      role: "agent" as const,
      active: true,
    },
  ]);
  const runtime = createVentureRuntime({
    commandExecutionMode: "fixture",
    memberships,
    recursiveCommandRuntime,
    recursiveCommands: [command],
    recursiveReconcileCommands: [reconciliation],
    now: clock,
  });
  return {
    directory,
    filename: join(directory, "runtime.sqlite"),
    store,
    runtime,
    provider,
    providerReadBack,
    agentTokens,
  };
}

async function sixSurfaceFailures(
  runtime: ReturnType<typeof setup>["runtime"],
  commandId: string,
  request: JsonObject,
  options: { context: CommandExecutionContext; idempotencyKey: string },
): Promise<readonly CommandFailureEnvelope[]> {
  const gateway = createAgentGateway(runtime);
  const contract = runtime.contracts.find(({ id }) => id === commandId)!;
  const caught = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected command surface failure");
      },
      (error: unknown) => commandFailureEnvelope(error),
    );
  const direct = await caught(gateway.direct.execute(commandId, request, options));
  const rest = await gateway.rest.handle({
    method: "POST",
    path: contract.surfaces.rest.path,
    body: request,
    ...options,
  });
  const cli = await gateway.cli.invoke(
    [...contract.surfaces.cli.tokens, "--input", JSON.stringify(request), "--json"],
    options,
  );
  const mcp = await caught(gateway.mcp.callTool(contract.surfaces.mcp.tool, request, options));
  const sdk = await caught(
    gateway.sdk.commands[contract.surfaces.sdk.namespace]![contract.surfaces.sdk.method]!(
      request,
      options,
    ),
  );
  const ui = await caught(
    gateway.ui.find(({ commandId: id }) => id === commandId)!.invoke(request, options),
  );
  expect(rest.status).toBe(commandFailureHttpStatus(direct.code));
  expect(cli).toMatchObject({ exitCode: 1, stdout: "" });
  expect(JSON.parse(cli.stderr)).toEqual(cli.failure);
  return [direct, rest.body as CommandFailureEnvelope, cli.failure!, mcp, sdk, ui];
}

describe("recursive command Agent Surfaces", () => {
  it("executes one venture-specific blueprint command identically on all six surfaces", async () => {
    const selectedScope = scope("operator-nova", "venture-nova", "customer-nova");
    const { runtime, provider } = setup([selectedScope]);
    const gateway = createAgentGateway(runtime);
    const request = input(selectedScope.customerOrganizationId);
    const options = {
      context: commandContext(selectedScope),
      idempotencyKey: "same-customer-request",
    };
    const expectedSurfaces = {
      rest: { path: "/v1/commands/nova-care.deliver" },
      cli: { tokens: ["nova-care", "deliver"] },
      mcp: { tool: "nova-care_deliver" },
      sdk: { namespace: "nova-care", method: "deliver" },
      ui: { actionId: "nova-care.deliver" },
    };
    expect(command.surfaces).toMatchObject(expectedSurfaces);

    const direct = await gateway.direct.execute(command.id, request, options);
    const rest = await gateway.rest.handle({
      method: "POST",
      path: command.surfaces.rest.path,
      body: request,
      ...options,
    });
    const cli = await gateway.cli.invoke(
      [
        ...command.surfaces.cli.tokens,
        "--input",
        JSON.stringify(request),
        "--context",
        JSON.stringify(options.context),
        "--idempotency-key",
        options.idempotencyKey,
      ],
      options,
    );
    const mcp = await gateway.mcp.callTool(command.surfaces.mcp.tool, request, options);
    const sdk = await gateway.sdk.commands[command.surfaces.sdk.namespace]![
      command.surfaces.sdk.method
    ]!(request, options);
    const ui = await gateway.ui
      .find(({ commandId }) => commandId === command.id)!
      .invoke(request, options);

    expect(rest).toMatchObject({ status: 200, body: direct });
    expect(JSON.parse(cli.stdout)).toEqual(direct);
    expect(mcp).toEqual(direct);
    expect(sdk).toEqual(direct);
    expect(ui).toEqual(direct);
    expect(direct).toMatchObject({
      commandId: "nova-care.deliver",
      operatorId: "operator-nova",
      ventureId: "venture-nova",
      customerOrganizationId: "customer-nova",
      status: "completed",
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(JSON.stringify(direct)).not.toContain("credential-canary");
  });

  it("rejects inbound secondary credentials identically on six surfaces before reservation", async () => {
    const selectedScope = scope("operator-inbound", "venture-inbound", "customer-inbound");
    const { runtime, store, provider, filename } = setup([selectedScope]);
    const request = input(selectedScope.customerOrganizationId);
    request.payload = {
      requestId: "request-safe",
      receiptHint: "whsec_secondary_fixture_8Hk2Lm9Q",
    };
    const failures = await sixSurfaceFailures(runtime, command.id, request, {
      context: commandContext(selectedScope),
      idempotencyKey: "inbound-secondary-credential",
    });
    expect(new Set(failures.map(({ code }) => code))).toEqual(new Set(["invalid_input"]));
    expect(new Set(failures.map(({ message }) => message)).size).toBe(1);
    expect(JSON.stringify(failures)).not.toContain("whsec_secondary_fixture_8Hk2Lm9Q");
    expect(provider).not.toHaveBeenCalled();
    expect(store.usageStatus(selectedScope, "inbound-secondary-credential")).toBeNull();

    const identifierRequest = input(selectedScope.customerOrganizationId);
    identifierRequest.authorizationEnvelopeId = "whsec_secondary_auditboundary123456";
    const identifierFailures = await sixSurfaceFailures(runtime, command.id, identifierRequest, {
      context: commandContext(selectedScope),
      idempotencyKey: "inbound-credential-identifier",
    });
    expect(new Set(identifierFailures.map(({ code }) => code))).toEqual(new Set(["invalid_input"]));
    expect(JSON.stringify(identifierFailures)).not.toContain("whsec_secondary_auditboundary123456");
    expect(provider).not.toHaveBeenCalled();

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (databaseFile: string) => {
        prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    const database = new DatabaseSync(filename);
    const raw = database
      .prepare(
        "SELECT count(*) AS records, group_concat(operation_binding_json, '') AS bindings FROM usage_records",
      )
      .get();
    database.close();
    expect(raw).toEqual({ records: 0, bindings: null });
  });

  it("keeps source, ESM dist, and CJS dist recursive parsers on the shared credential policy", async () => {
    const credentialShapes = [
      "whsec_secondary_fixture_8Hk2Lm9Q",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abcdefghijkl",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature_fixture",
    ];
    const esm = (await import("../packages/agent-runtime/dist/index.js")) as {
      recursiveServiceExecuteCommand: typeof command;
    };
    const cjs = createRequire(import.meta.url)("../packages/agent-runtime") as {
      recursiveServiceExecuteCommand: typeof command;
    };
    for (const runtimeContract of [
      command,
      esm.recursiveServiceExecuteCommand,
      cjs.recursiveServiceExecuteCommand,
    ]) {
      for (const credential of credentialShapes) {
        expect(() =>
          runtimeContract.input.parse({
            ...input("customer-parser"),
            payload: { requestId: "safe", receiptHint: credential },
          }),
        ).toThrow(/credential or non-JSON material is forbidden/);
      }
      expect(() =>
        runtimeContract.input.parse({
          ...input("customer-parser"),
          authorizationEnvelopeId: "whsec_secondary_auditboundary123456",
        }),
      ).toThrow(/credential material is forbidden in authorizationEnvelopeId/);
    }
  });

  it("reconciles one unknown provider operation identically on all six surfaces without re-applying", async () => {
    const selectedScope = scope("operator-recovery", "venture-recovery", "customer-recovery");
    const { runtime, store, provider, providerReadBack } = setup([selectedScope]);
    const gateway = createAgentGateway(runtime);
    const operationIdempotencyKey = "customer-operation-after-timeout";
    const original = input(selectedScope.customerOrganizationId);
    original.payload = {
      ...original.payload,
      simulateUnknown: true,
    };
    await expect(
      runtime.execute(command.id, original, {
        context: commandContext(selectedScope),
        idempotencyKey: operationIdempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });
    expect(provider).toHaveBeenCalledOnce();
    expect(store.usageStatus(selectedScope, operationIdempotencyKey)).toBe("unknown");

    const request = reconcileInput(selectedScope.customerOrganizationId, operationIdempotencyKey, {
      payload: original.payload,
    });
    const options = {
      context: commandContext(selectedScope),
      idempotencyKey: "reconcile-the-customer-operation",
    };
    expect(reconciliation.contract.surfaces).toMatchObject({
      rest: { path: "/v1/commands/nova-care.reconcile" },
      cli: { tokens: ["nova-care", "reconcile"] },
      mcp: { tool: "nova-care_reconcile" },
      sdk: { namespace: "nova-care", method: "reconcile" },
      ui: { actionId: "nova-care.reconcile" },
    });

    const direct = await gateway.direct.execute(reconciliation.contract.id, request, options);
    const rest = await gateway.rest.handle({
      method: "POST",
      path: reconciliation.contract.surfaces.rest.path,
      body: request,
      ...options,
    });
    const cli = await gateway.cli.invoke(
      [
        ...reconciliation.contract.surfaces.cli.tokens,
        "--input",
        JSON.stringify(request),
        "--context",
        JSON.stringify(options.context),
        "--idempotency-key",
        options.idempotencyKey,
      ],
      options,
    );
    const mcp = await gateway.mcp.callTool(
      reconciliation.contract.surfaces.mcp.tool,
      request,
      options,
    );
    const sdk = await gateway.sdk.commands[reconciliation.contract.surfaces.sdk.namespace]![
      reconciliation.contract.surfaces.sdk.method
    ]!(request, options);
    const ui = await gateway.ui
      .find(({ commandId }) => commandId === reconciliation.contract.id)!
      .invoke(request, options);

    expect(rest).toMatchObject({ status: 200, body: direct });
    expect(JSON.parse(cli.stdout)).toEqual(direct);
    expect(mcp).toEqual(direct);
    expect(sdk).toEqual(direct);
    expect(ui).toEqual(direct);
    expect(direct).toMatchObject({
      commandId: "nova-care.reconcile",
      executionCommandId: "nova-care.deliver",
      status: "completed",
      data: {
        providerReceiptId: "receipt-operator-recovery-venture-recovery",
        requestId: "request-shared",
      },
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(providerReadBack).toHaveBeenCalledOnce();
    expect(store.usageStatus(selectedScope, operationIdempotencyKey)).toBe("completed");
  });

  it("quarantines a nested secondary webhook secret across all six execute surfaces and raw SQLite", async () => {
    const selectedScope = scope("operator-secret", "venture-secret", "customer-secret");
    const { runtime, store, provider, filename } = setup([selectedScope]);
    const request = input(selectedScope.customerOrganizationId);
    request.payload = { ...request.payload, simulateUnsafeOutput: true };
    const operationIdempotencyKey = "secondary-secret-operation";
    const failures = await sixSurfaceFailures(runtime, command.id, request, {
      context: commandContext(selectedScope),
      idempotencyKey: operationIdempotencyKey,
    });

    expect(new Set(failures.map(({ code }) => code))).toEqual(new Set(["idempotency_ambiguous"]));
    expect(new Set(failures.map(({ message }) => message)).size).toBe(1);
    expect(JSON.stringify(failures)).not.toContain(SECONDARY_WEBHOOK_SECRET);
    expect(provider).toHaveBeenCalledOnce();
    expect(store.entitlementUsage(selectedScope, operationIdempotencyKey)).toMatchObject({
      status: "unknown",
      result: undefined,
    });

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (databaseFile: string) => {
        prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    const database = new DatabaseSync(filename);
    const rawUsage = database
      .prepare("SELECT status, result_json FROM usage_records WHERE idempotency_key = ?")
      .get(operationIdempotencyKey);
    const rawAudit = database
      .prepare("SELECT group_concat(payload_json, '') AS payloads FROM audit_events")
      .get();
    database.close();
    expect(rawUsage).toEqual({ status: "unknown", result_json: null });
    expect(JSON.stringify(rawAudit)).not.toContain(SECONDARY_WEBHOOK_SECRET);
  });

  it("quarantines a nested secondary token from reconciliation on all six surfaces", async () => {
    const selectedScope = scope(
      "operator-reconcile-secret",
      "venture-reconcile-secret",
      "customer-reconcile-secret",
    );
    const { runtime, store, provider, providerReadBack, filename } = setup([selectedScope]);
    const operationIdempotencyKey = "secondary-token-provider-operation";
    const original = input(selectedScope.customerOrganizationId);
    original.payload = {
      ...original.payload,
      simulateUnknown: true,
      simulateUnsafeReadBack: true,
    };
    await expect(
      runtime.execute(command.id, original, {
        context: commandContext(selectedScope),
        idempotencyKey: operationIdempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });

    const request = reconcileInput(selectedScope.customerOrganizationId, operationIdempotencyKey, {
      payload: original.payload,
    });
    const failures = await sixSurfaceFailures(runtime, reconciliation.contract.id, request, {
      context: commandContext(selectedScope),
      idempotencyKey: "secondary-token-reconciliation",
    });
    expect(new Set(failures.map(({ code }) => code))).toEqual(new Set(["idempotency_ambiguous"]));
    expect(new Set(failures.map(({ message }) => message)).size).toBe(1);
    expect(JSON.stringify(failures)).not.toContain(SECONDARY_ACCESS_TOKEN);
    expect(provider).toHaveBeenCalledOnce();
    expect(providerReadBack).toHaveBeenCalledOnce();
    expect(store.entitlementUsage(selectedScope, operationIdempotencyKey)).toMatchObject({
      status: "unknown",
      result: undefined,
    });

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (databaseFile: string) => {
        prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    const database = new DatabaseSync(filename);
    const rawUsage = database
      .prepare("SELECT status, result_json FROM usage_records WHERE idempotency_key = ?")
      .get(operationIdempotencyKey);
    database.close();
    expect(rawUsage).toEqual({ status: "unknown", result_json: null });
  });

  it("isolates shared recursive IDs by operator, venture, and customer organization", async () => {
    const firstScope = scope("operator-a", "venture-a", "customer-shared");
    const secondScope = scope("operator-b", "venture-b", "customer-shared");
    const { runtime, provider } = setup([firstScope, secondScope]);
    const request = input("customer-shared");

    const first = await runtime.execute(command.id, request, {
      context: commandContext(firstScope),
      idempotencyKey: "same-idempotency-key",
    });
    const second = await runtime.execute(command.id, request, {
      context: commandContext(secondScope),
      idempotencyKey: "same-idempotency-key",
    });
    expect(first).toMatchObject({ operatorId: "operator-a", ventureId: "venture-a" });
    expect(second).toMatchObject({ operatorId: "operator-b", ventureId: "venture-b" });
    expect(provider).toHaveBeenCalledTimes(2);

    await expect(
      runtime.execute(command.id, input("customer-forged"), {
        context: commandContext(firstScope),
        idempotencyKey: "forged-customer",
      }),
    ).rejects.toThrow();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("restarts and reconciles with fresh read-back authority after original grants expire", async () => {
    let current = NOW;
    const clock = () => current;
    const selectedScope = scope("operator-restarted", "venture-restarted", "customer-restarted");
    const started = setup([selectedScope], clock);
    const agentId = `agent-${selectedScope.operatorId}`;
    const agentToken = "original-agent-token";
    started.store.putAgentGrant({
      operatorId: selectedScope.operatorId,
      agentGrantId: "agent-grant-original",
      ventureId: selectedScope.ventureId,
      customerOrganizationId: selectedScope.customerOrganizationId,
      agentId,
      tokenDigest: createHash("sha256").update(agentToken).digest("hex"),
      scopes: [command.id],
      grantedByUserId: selectedScope.userId!,
      expiresAt: "2026-08-10T12:00:00.000Z",
      revokedAt: null,
    });
    started.agentTokens.set(
      `${selectedScope.operatorId}:${selectedScope.ventureId}:${selectedScope.customerOrganizationId}:${agentId}`,
      agentToken,
    );
    const operationIdempotencyKey = "agent-operation-before-expiry";
    const original = input(selectedScope.customerOrganizationId);
    original.payload = { ...original.payload, simulateUnknown: true };
    await expect(
      started.runtime.execute(command.id, original, {
        context: commandContext(selectedScope, "agent"),
        idempotencyKey: operationIdempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });
    expect(started.provider).toHaveBeenCalledOnce();
    const durable = started.store.entitlementUsage(selectedScope, operationIdempotencyKey)!;
    const originalProviderOperationId = durable.providerOperationId;

    started.store.close();
    stores.splice(stores.indexOf(started.store), 1);
    current = new Date("2026-08-11T12:00:00.000Z");
    const restartedStore = createVentureRuntimeStore(started.filename, { now: clock });
    stores.push(restartedStore);
    const restartedCredentials = createTenantCredentialBroker();
    restartedCredentials.register(
      selectedScope,
      restartedStore.connection(selectedScope, "connection-shared"),
      "credential-canary-restarted",
    );
    const restartedService = createVentureRuntimeService(restartedStore, restartedCredentials, {
      now: clock,
      providerOutputPolicies: PROVIDER_OUTPUT_POLICIES,
      verifyAuthorization: () => false,
      verifyReconciliationAuthorization: ({
        reconciliationAuthorizationEnvelopeId,
        reconciliationCommandId,
        executionCommandId,
        providerOperationId,
      }) =>
        reconciliationAuthorizationEnvelopeId === "reconciliation-envelope-approved" &&
        reconciliationCommandId === reconciliation.contract.id &&
        executionCommandId === command.id &&
        providerOperationId === originalProviderOperationId,
    });
    const restartedCommandRuntime = createRecursiveVentureCommandRuntime({
      service: restartedService,
      executeProvider: () => {
        throw new Error("reconciliation must never repeat provider apply");
      },
      reconcileProvider: started.providerReadBack,
    });
    const forgedScope = { ...selectedScope, userId: "user-forged" };
    const restartedRuntime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [selectedScope, forgedScope].map((candidate) => ({
        organizationId: candidate.operatorId,
        actorId: candidate.userId!,
        role: "operator" as const,
        active: true,
      })),
      recursiveCommandRuntime: restartedCommandRuntime,
      recursiveCommands: [command],
      recursiveReconcileCommands: [reconciliation],
      now: clock,
    });
    const request = reconcileInput(selectedScope.customerOrganizationId, operationIdempotencyKey, {
      payload: original.payload,
    });
    await expect(
      restartedRuntime.execute(
        reconciliation.contract.id,
        { ...request, payload: { ...request.payload, requestId: "forged" } },
        {
          context: commandContext(selectedScope, "user", "2026-08-12T12:00:00.000Z"),
          idempotencyKey: "forged-operation-binding",
        },
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      restartedRuntime.execute(reconciliation.contract.id, request, {
        context: commandContext(forgedScope, "user", "2026-08-12T12:00:00.000Z"),
        idempotencyKey: "forged-reconciliation-actor",
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });

    await expect(
      restartedRuntime.execute(reconciliation.contract.id, request, {
        context: commandContext(selectedScope, "user", "2026-08-12T12:00:00.000Z"),
        idempotencyKey: "fresh-reconciliation-authority",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      providerOperationId: originalProviderOperationId,
      data: { requestId: "request-shared" },
    });
    expect(started.provider).toHaveBeenCalledOnce();
    expect(started.providerReadBack).toHaveBeenCalledOnce();
    expect(restartedStore.entitlementUsage(selectedScope, operationIdempotencyKey)).toMatchObject({
      status: "completed",
      providerOperationId: originalProviderOperationId,
      requestHash: durable.requestHash,
    });
  });

  it("rejects an expired Agent Grant before the provider callback", async () => {
    const selectedScope = scope("operator-agent", "venture-agent", "customer-agent");
    const { runtime, store, provider, agentTokens } = setup([selectedScope]);
    const token = "expired-agent-token";
    const agentId = `agent-${selectedScope.operatorId}`;
    store.putAgentGrant({
      operatorId: selectedScope.operatorId,
      agentGrantId: "agent-grant-expired",
      ventureId: selectedScope.ventureId,
      customerOrganizationId: selectedScope.customerOrganizationId,
      agentId,
      tokenDigest: createHash("sha256").update(token).digest("hex"),
      scopes: [command.id],
      grantedByUserId: selectedScope.userId!,
      expiresAt: "2026-08-09T11:59:59.000Z",
      revokedAt: null,
    });
    agentTokens.set(
      `${selectedScope.operatorId}:${selectedScope.ventureId}:${selectedScope.customerOrganizationId}:${agentId}`,
      token,
    );

    await expect(
      runtime.execute(command.id, input(selectedScope.customerOrganizationId), {
        context: commandContext(selectedScope, "agent"),
        idempotencyKey: "expired-agent-request",
      }),
    ).rejects.toThrow(/agent grant is invalid/i);
    expect(provider).not.toHaveBeenCalled();

    const activeToken = "active-agent-token";
    store.putAgentGrant({
      operatorId: selectedScope.operatorId,
      agentGrantId: "agent-grant-active",
      ventureId: selectedScope.ventureId,
      customerOrganizationId: selectedScope.customerOrganizationId,
      agentId,
      tokenDigest: createHash("sha256").update(activeToken).digest("hex"),
      scopes: [command.id],
      grantedByUserId: selectedScope.userId!,
      expiresAt: "2026-08-10T12:00:00.000Z",
      revokedAt: null,
    });
    agentTokens.set(
      `${selectedScope.operatorId}:${selectedScope.ventureId}:${selectedScope.customerOrganizationId}:${agentId}`,
      activeToken,
    );
    await expect(
      runtime.execute(command.id, input(selectedScope.customerOrganizationId), {
        context: commandContext(selectedScope, "agent"),
        idempotencyKey: "expired-agent-request",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(provider).toHaveBeenCalledOnce();
  });
});
