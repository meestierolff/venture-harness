import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentGateway } from "../packages/agent-gateway/src/index";
import { SqliteAuditChain } from "../packages/audit/src/index";
import {
  createVentureRuntime,
  stackOperationCommandContracts,
  type StackOperationInput,
} from "../packages/agent-runtime/src/index";
import {
  InMemoryIdempotencyStore,
  SqliteIdempotencyStore,
} from "../packages/command-bus/src/index";
import type { CommandExecutionContext } from "../packages/core/src/index";
import { SqliteEventLog } from "../packages/events/src/index";
import { SqliteMeteringSink } from "../packages/telemetry/src/index";
import { Redactor } from "@/lib/credentials";
import {
  InMemoryIdempotencyLedger,
  InMemoryStackOperationStore,
  MockProviderTransport,
  SqliteStackOperationStore,
  createRepositoryStackCommandRuntime,
  founderDefaultStackProfile,
  genericDnsStackProfile,
  type ProviderStackProfile,
  type ProviderReadBackResult,
  type StackOperationStore,
} from "@/lib/providers";
import { FileProviderIdempotencyLedger } from "@/lib/runtime";

const NOW = "2026-08-09T12:00:00.000Z";
const temporaryDirectories: string[] = [];
const commandStores: SqliteIdempotencyStore[] = [];
const evidenceStores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of commandStores.splice(0)) store.close();
  for (const store of evidenceStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-stack-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

const commandContext: CommandExecutionContext = {
  identity: { actorId: "operator-1", kind: "user" },
  tenant: { organizationId: "org-acme", ventureId: "venture-alpha" },
  subscription: { subscriptionId: "provider-local", status: "active", plan: "operator" },
  entitlements: [],
  scopes: ["provider.read", "provider.apply"],
  grants: [
    {
      grantId: "stack-provider-grant",
      commandIds: ["stack.doctor", "stack.apply", "stack.read-back", "stack.reconcile"],
      scopes: ["provider.read", "provider.apply"],
      expiresAt: "2026-08-09T13:00:00.000Z",
    },
  ],
};

function dnsInput(
  profile: ProviderStackProfile = genericDnsStackProfile,
  providerId: "dns" | "mijndomein" = "dns",
): StackOperationInput {
  return {
    profileId: profile.profileId,
    profileVersion: profile.version,
    role: "dns.record",
    providerId,
    capability: "record",
    environment: "production",
    operationId: "dns-record-verification-1",
    payload: {
      zone: "example.test",
      recordType: "TXT",
      recordName: "_verify",
      recordValue: "fixture-verification-value",
      ttl: 300,
    },
  };
}

function selection(input: StackOperationInput) {
  return {
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    role: input.role,
    providerId: input.providerId,
    capability: input.capability,
    environment: input.environment,
  };
}

function durableCommandStore(root: string): SqliteIdempotencyStore {
  const store = new SqliteIdempotencyStore(join(root, "command-idempotency.sqlite"));
  commandStores.push(store);
  return store;
}

function manualFixtureTransport(options: { forgedOperationId?: boolean } = {}) {
  return new MockProviderTransport(
    "manual",
    vi.fn(async (operation) => ({
      status: "succeeded" as const,
      message: "Fixture manual action recorded outside any provider or network",
      output: { fixtureReceiptId: `receipt-${operation.id}` },
      verified: false,
      effectOutcome: "confirmed_write" as const,
    })),
    vi.fn(async (operation): Promise<ProviderReadBackResult> => ({
      operationId: options.forgedOperationId ? `${operation.id}.forged` : operation.id,
      status: "matched",
      message: "Fixture authoritative DNS state matches",
      evidence: {
        evidenceClass: "fixture",
        profileId: genericDnsStackProfile.profileId,
        profileVersion: genericDnsStackProfile.version,
        providerId: "dns",
        capability: "record",
        operationId: operation.id,
        authoritative: true,
      },
    })),
  );
}

function stackRuntime(options: {
  root: string;
  transport?: MockProviderTransport;
  operationStore?: StackOperationStore;
  providerLedger?: FileProviderIdempotencyLedger | InMemoryIdempotencyLedger;
  validateManualEvidence?: boolean;
  now?: string;
}) {
  const transport = options.transport ?? manualFixtureTransport();
  const providerLedger =
    options.providerLedger ??
    new FileProviderIdempotencyLedger(join(options.root, "provider-idempotency.json"));
  const operationStore =
    options.operationStore ??
    new SqliteStackOperationStore(join(options.root, "operations.sqlite"));
  const runtime = createRepositoryStackCommandRuntime({
    operationStore,
    now: () => new Date(options.now ?? NOW),
    resolveContext: () => ({
      execution: {
        authorization: "approved",
        transports: { manual: transport },
        redactor: new Redactor(),
        idempotencyLedger: providerLedger,
      },
      evidenceClass: "fixture",
      validateManualEvidence:
        options.validateManualEvidence === false
          ? undefined
          : ({ readBack, profileId, profileVersion, providerId, capability }) => {
              const evidence = readBack.evidence as Record<string, unknown>;
              return (
                evidence.evidenceClass === "fixture" &&
                evidence.profileId === profileId &&
                evidence.profileVersion === profileVersion &&
                evidence.providerId === providerId &&
                evidence.capability === capability &&
                evidence.operationId === readBack.operationId &&
                evidence.authoritative === true
              );
            },
    }),
  });
  return { runtime, transport, providerLedger, operationStore };
}

function crashingStore(
  delegate: StackOperationStore,
  crash: "after_claim" | "after_provider_before_complete",
): StackOperationStore {
  return {
    durability: "durable_atomic",
    get: delegate.get.bind(delegate),
    inspect: delegate.inspect.bind(delegate),
    update: delegate.update.bind(delegate),
    resolve: delegate.resolve.bind(delegate),
    release: delegate.release.bind(delegate),
    async claim(key, input) {
      const claimed = await delegate.claim(key, input);
      if (crash === "after_claim" && claimed.kind === "owner") {
        throw new Error("fixture process crash after prepared claim");
      }
      return claimed;
    },
    async complete(key, input) {
      if (crash === "after_provider_before_complete") {
        throw new Error("fixture process crash after provider write");
      }
      return delegate.complete(key, input);
    },
    async markAmbiguous(key, input) {
      if (crash === "after_provider_before_complete") {
        throw new Error("fixture process terminated before ambiguity write");
      }
      return delegate.markAmbiguous(key, input);
    },
  };
}

function ventureRuntime(options: {
  root: string;
  stackRuntime?: ReturnType<typeof stackRuntime>["runtime"];
  commandStore?: InMemoryIdempotencyStore | SqliteIdempotencyStore;
  production?: boolean;
}) {
  const productionEvidence = options.production
    ? {
        audit: new SqliteAuditChain(join(options.root, "command-audit.sqlite")),
        events: new SqliteEventLog(join(options.root, "command-events.sqlite")),
        metering: new SqliteMeteringSink(join(options.root, "command-metering.sqlite")),
      }
    : {};
  if (options.production) evidenceStores.push(...Object.values(productionEvidence));
  return createVentureRuntime({
    memberships: [
      { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
    ],
    stackCommandRuntime: options.stackRuntime,
    commandIdempotencyStore: options.commandStore,
    commandExecutionMode: options.production ? "production" : "fixture",
    ...productionEvidence,
    now: () => new Date(NOW),
  });
}

function invocation(idempotencyKey: string) {
  return { context: commandContext, idempotencyKey };
}

describe("canonical Stack Profile provider command runtime", () => {
  it("lists and doctors two profiles whose DNS role resolves to genuinely different adapters", async () => {
    const root = temporaryRoot();
    const injected = stackRuntime({ root });
    const runtime = ventureRuntime({ root, stackRuntime: injected.runtime });

    const catalog = await runtime.execute("stack.list", {}, invocation("stack-list"));
    expect(catalog).toMatchObject({
      status: "available",
      data: {
        stacks: [
          {
            profileId: founderDefaultStackProfile.profileId,
            profileVersion: founderDefaultStackProfile.version,
            bindings: { "dns.record": { providerId: "mijndomein", capability: "record" } },
          },
          {
            profileId: genericDnsStackProfile.profileId,
            profileVersion: genericDnsStackProfile.version,
            bindings: { "dns.record": { providerId: "dns", capability: "record" } },
          },
        ],
      },
    });

    const generic = await runtime.execute(
      "stack.doctor",
      selection(dnsInput()),
      invocation("doctor-generic"),
    );
    const founder = await runtime.execute(
      "stack.doctor",
      selection(dnsInput(founderDefaultStackProfile, "mijndomein")),
      invocation("doctor-founder"),
    );
    expect(generic).toMatchObject({ providerId: "dns", status: "manual_only" });
    expect(founder).toMatchObject({ providerId: "mijndomein", status: "manual_only" });
  });

  it("selects the exact alternative profile through direct, REST, CLI, MCP, SDK, and UI", async () => {
    const root = temporaryRoot();
    const injected = stackRuntime({ root });
    const runtime = ventureRuntime({ root, stackRuntime: injected.runtime });
    const gateway = createAgentGateway(runtime);
    const input = dnsInput();
    const contract = stackOperationCommandContracts.find(({ id }) => id === "stack.plan")!;
    const invoke = (surface: string) => invocation(`stack-plan-${surface}`);

    const direct = await gateway.direct.execute("stack.plan", input, invoke("direct"));
    const rest = await gateway.rest.handle({
      method: "POST",
      path: contract.surfaces.rest.path,
      body: input,
      ...invoke("rest"),
    });
    const cli = await gateway.cli.invoke(
      [...contract.surfaces.cli.tokens, "--input", JSON.stringify(input)],
      invoke("cli"),
    );
    const mcp = await gateway.mcp.callTool(contract.surfaces.mcp.tool, input, invoke("mcp"));
    const sdk = await gateway.sdk.commands.stack!.plan!(input, invoke("sdk"));
    const ui = await gateway.ui
      .find(({ actionId }) => actionId === "stack.plan")!
      .invoke(input, invoke("ui"));

    expect(direct).toMatchObject({
      commandId: "stack.plan",
      profileId: "founder-default-generic-dns",
      profileVersion: "0.2.0",
      role: "dns.record",
      providerId: "dns",
      capability: "record",
      status: "planned",
      data: {
        plan: {
          provider: "dns",
          dryRun: true,
          operations: [{ transport: "manual", provider: "dns", capability: "record" }],
          manualActions: [
            {
              system: "DNS control panel",
              completionEvidence: [
                "Control-panel change receipt or screenshot",
                "Authoritative DNS response with exact name, type, value, and TTL",
              ],
            },
          ],
        },
      },
    });
    expect(rest).toEqual({ status: 200, body: direct });
    expect(cli.exitCode, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(direct);
    expect(mcp).toEqual(direct);
    expect(sdk).toEqual(direct);
    expect(ui).toEqual(direct);
  });

  it("dry-runs without a transport and keeps the exact manual action pending", async () => {
    const root = temporaryRoot();
    const injected = stackRuntime({ root });
    const runtime = ventureRuntime({ root, stackRuntime: injected.runtime });
    const result = await runtime.execute("stack.dry-run", dnsInput(), invocation("dry-run"));

    expect(result).toMatchObject({
      status: "planned",
      providerInvoked: false,
      externalEffectOccurred: false,
      liveVerified: false,
      data: {
        plan: { provider: "dns", dryRun: true, manualActions: [{ system: "DNS control panel" }] },
        report: {
          state: "planned",
          operations: [{ result: { status: "skipped" }, reused: false }],
        },
      },
    });
    expect(injected.transport.calls).toHaveLength(0);
  });

  it("applies once in an authorized fixture, reads back exact evidence, and reconciles after restart", async () => {
    const root = temporaryRoot();
    const fixtureTransport = manualFixtureTransport();
    const firstStack = stackRuntime({ root, transport: fixtureTransport });
    const firstRuntime = ventureRuntime({
      root,
      stackRuntime: firstStack.runtime,
      commandStore: durableCommandStore(root),
      production: true,
    });
    const input = dnsInput();

    const applied = await firstRuntime.execute("stack.apply", input, invocation("apply-1"));
    const readBack = await firstRuntime.execute(
      "stack.read-back",
      input,
      invocation("read-back-1"),
    );
    expect(applied).toMatchObject({
      status: "applied_unverified",
      providerInvoked: true,
      externalEffectOccurred: true,
      liveVerified: false,
    });
    expect(readBack).toMatchObject({
      status: "verified_fixture",
      providerId: "dns",
      liveVerified: false,
      data: { evidenceClass: "fixture", verification: { state: "verified" } },
    });
    expect(fixtureTransport.calls).toHaveLength(1);

    commandStores.splice(0).forEach((store) => store.close());
    const restartedStack = stackRuntime({ root, transport: fixtureTransport });
    const restartedRuntime = ventureRuntime({
      root,
      stackRuntime: restartedStack.runtime,
      commandStore: durableCommandStore(root),
      production: true,
    });
    const reconciled = await restartedRuntime.execute(
      "stack.reconcile",
      input,
      invocation("reconcile-after-restart"),
    );

    expect(reconciled).toMatchObject({
      status: "verified_fixture",
      providerInvoked: true,
      liveVerified: false,
      data: { verification: { state: "verified" }, evidenceClass: "fixture" },
    });
    expect(fixtureTransport.calls).toHaveLength(1);
  });

  it("keeps the packaged default unconfigured and performs no provider effect", async () => {
    const root = temporaryRoot();
    const runtime = ventureRuntime({ root });
    await expect(
      runtime.execute("stack.apply", dnsInput(), invocation("default-apply")),
    ).rejects.toMatchObject({
      code: "handler_failed",
      message: expect.stringContaining("stack_runtime_unconfigured"),
    });
  });

  it("fails closed for profile, version, provider, and capability attestation mismatches", async () => {
    const root = temporaryRoot();
    const injected = stackRuntime({ root });
    const runtime = ventureRuntime({ root, stackRuntime: injected.runtime });
    const input = dnsInput();
    const mismatches = [
      { ...input, profileVersion: "9.9.9" },
      { ...input, providerId: "mijndomein" },
      { ...input, capability: "domain_attachment" },
      { ...input, profileId: "missing-profile" },
    ];

    for (const [index, mismatch] of mismatches.entries()) {
      await expect(
        runtime.execute("stack.plan", mismatch, invocation(`mismatch-${index}`)),
      ).rejects.toMatchObject({ code: "handler_failed" });
    }
    expect(injected.transport.calls).toHaveLength(0);
  });

  it("rejects ephemeral production command, operation, and provider idempotency layers", async () => {
    const firstRoot = temporaryRoot();
    const firstStack = stackRuntime({ root: firstRoot });
    expect(() =>
      ventureRuntime({
        root: firstRoot,
        stackRuntime: firstStack.runtime,
        commandStore: new InMemoryIdempotencyStore(),
        production: true,
      }),
    ).toThrow(/Production venture runtime requires injected durable atomic stores/);
    expect(firstStack.transport.calls).toHaveLength(0);

    const secondRoot = temporaryRoot();
    const ephemeralOperation = stackRuntime({
      root: secondRoot,
      operationStore: new InMemoryStackOperationStore(),
    });
    const durableCommandRuntime = ventureRuntime({
      root: secondRoot,
      stackRuntime: ephemeralOperation.runtime,
      commandStore: durableCommandStore(secondRoot),
      production: true,
    });
    await expect(
      durableCommandRuntime.execute("stack.apply", dnsInput(), invocation("ephemeral-operation")),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });
    expect(ephemeralOperation.transport.calls).toHaveLength(0);

    const thirdRoot = temporaryRoot();
    const ephemeralProvider = stackRuntime({
      root: thirdRoot,
      providerLedger: new InMemoryIdempotencyLedger(),
    });
    await expect(
      ventureRuntime({
        root: thirdRoot,
        stackRuntime: ephemeralProvider.runtime,
        commandStore: durableCommandStore(thirdRoot),
        production: true,
      }).execute("stack.apply", dnsInput(), invocation("ephemeral-provider")),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });
    expect(ephemeralProvider.transport.calls).toHaveLength(0);
  });

  it("atomically binds an operation before provider apply across independent clients", async () => {
    const root = temporaryRoot();
    const transport = manualFixtureTransport();
    const operationPath = join(root, "shared-operations.sqlite");
    const providerPath = join(root, "shared-provider-idempotency.json");
    const firstStack = stackRuntime({
      root,
      transport,
      operationStore: new SqliteStackOperationStore(operationPath),
      providerLedger: new FileProviderIdempotencyLedger(providerPath),
    });
    const secondStack = stackRuntime({
      root,
      transport,
      operationStore: new SqliteStackOperationStore(operationPath),
      providerLedger: new FileProviderIdempotencyLedger(providerPath),
    });
    const firstRuntime = ventureRuntime({
      root,
      stackRuntime: firstStack.runtime,
      commandStore: durableCommandStore(join(root, "client-one")),
      production: true,
    });
    const secondRuntime = ventureRuntime({
      root,
      stackRuntime: secondStack.runtime,
      commandStore: durableCommandStore(join(root, "client-two")),
      production: true,
    });
    const firstInput = dnsInput();
    const conflictingInput = {
      ...dnsInput(),
      payload: { ...dnsInput().payload, recordValue: "different-fixture-value" },
    };

    const results = await Promise.allSettled([
      firstRuntime.execute("stack.apply", firstInput, invocation("client-one-apply")),
      secondRuntime.execute("stack.apply", conflictingInput, invocation("client-two-conflict")),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fulfilled",
          value: expect.objectContaining({ status: "applied_unverified" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "handler_failed" }),
        }),
      ]),
    );
    expect(transport.calls).toHaveLength(1);
  });

  it("releases an expired prepared claim after a crash before the provider ledger claim", async () => {
    const root = temporaryRoot();
    const operationPath = join(root, "crash-before-provider.sqlite");
    const initialStore = new SqliteStackOperationStore(operationPath, { pendingTimeoutMs: 1 });
    const transport = manualFixtureTransport();
    const crashed = stackRuntime({
      root,
      transport,
      operationStore: crashingStore(initialStore, "after_claim"),
    });
    await expect(
      ventureRuntime({
        root,
        stackRuntime: crashed.runtime,
        commandStore: durableCommandStore(join(root, "before-crash")),
        production: true,
      }).execute("stack.apply", dnsInput(), invocation("crash-before-provider")),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });
    expect(transport.calls).toHaveLength(0);
    initialStore.close();

    const restartedStore = new SqliteStackOperationStore(operationPath, { pendingTimeoutMs: 1 });
    const restarted = stackRuntime({
      root,
      transport,
      operationStore: restartedStore,
      now: "2026-08-09T12:01:00.000Z",
    });
    const runtime = ventureRuntime({
      root,
      stackRuntime: restarted.runtime,
      commandStore: durableCommandStore(join(root, "before-restart")),
      production: true,
    });
    const reconciled = await runtime.execute(
      "stack.reconcile",
      dnsInput(),
      invocation("reconcile-crash-before-provider"),
    );
    expect(reconciled).toMatchObject({
      status: "confirmed_no_effect",
      providerInvoked: false,
      externalEffectOccurred: false,
      data: { diagnostic: { code: "provider_attempt_absent" } },
    });
    const applied = await runtime.execute(
      "stack.apply",
      dnsInput(),
      invocation("apply-after-safe-release"),
    );
    expect(applied).toMatchObject({ status: "applied_unverified" });
    expect(transport.calls).toHaveLength(1);
    restartedStore.close();
  });

  it("reconciles after a crash following provider write but before operation completion", async () => {
    const root = temporaryRoot();
    const operationPath = join(root, "crash-after-provider.sqlite");
    const initialStore = new SqliteStackOperationStore(operationPath, { pendingTimeoutMs: 1 });
    const transport = manualFixtureTransport();
    const crashed = stackRuntime({
      root,
      transport,
      operationStore: crashingStore(initialStore, "after_provider_before_complete"),
    });
    await expect(
      ventureRuntime({
        root,
        stackRuntime: crashed.runtime,
        commandStore: durableCommandStore(join(root, "after-crash")),
        production: true,
      }).execute("stack.apply", dnsInput(), invocation("crash-after-provider")),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });
    expect(transport.calls).toHaveLength(1);
    initialStore.close();

    const restartedStore = new SqliteStackOperationStore(operationPath, { pendingTimeoutMs: 1 });
    const restarted = stackRuntime({
      root,
      transport,
      operationStore: restartedStore,
      now: "2026-08-09T12:01:00.000Z",
    });
    const reconciled = await ventureRuntime({
      root,
      stackRuntime: restarted.runtime,
      commandStore: durableCommandStore(join(root, "after-restart")),
      production: true,
    }).execute("stack.reconcile", dnsInput(), invocation("reconcile-crash-after-provider"));
    expect(reconciled).toMatchObject({
      status: "verified_fixture",
      liveVerified: false,
      data: { evidenceClass: "fixture", verification: { state: "verified" } },
    });
    expect(transport.calls).toHaveLength(1);
    restartedStore.close();
  });

  it("never turns missing manual evidence or forged read-back into verified state", async () => {
    const missingRoot = temporaryRoot();
    const missing = stackRuntime({ root: missingRoot, validateManualEvidence: false });
    const missingRuntime = ventureRuntime({
      root: missingRoot,
      stackRuntime: missing.runtime,
      commandStore: durableCommandStore(missingRoot),
      production: true,
    });
    await missingRuntime.execute("stack.apply", dnsInput(), invocation("missing-apply"));
    const withoutEvidence = await missingRuntime.execute(
      "stack.read-back",
      dnsInput(),
      invocation("missing-read-back"),
    );
    expect(withoutEvidence).toMatchObject({
      status: "waiting_manual_evidence",
      liveVerified: false,
      data: { diagnostic: { code: "manual_evidence_required" } },
    });

    const forgedRoot = temporaryRoot();
    const forged = stackRuntime({
      root: forgedRoot,
      transport: manualFixtureTransport({ forgedOperationId: true }),
    });
    const forgedRuntime = ventureRuntime({
      root: forgedRoot,
      stackRuntime: forged.runtime,
      commandStore: durableCommandStore(forgedRoot),
      production: true,
    });
    await forgedRuntime.execute("stack.apply", dnsInput(), invocation("forged-apply"));
    await expect(
      forgedRuntime.execute("stack.read-back", dnsInput(), invocation("forged-read-back")),
    ).rejects.toMatchObject({ code: "idempotency_ambiguous" });
  });
});
