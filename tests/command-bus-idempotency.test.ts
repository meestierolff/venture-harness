import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuditChain, SqliteAuditChain, type AuditInput } from "../packages/audit/src/index";
import { createVentureRuntime } from "../packages/agent-runtime/src/index";
import {
  CommandBus,
  CommandDefinitiveNoEffectError,
  InMemoryIdempotencyStore,
  SqliteIdempotencyStore,
  defineCommandContract,
} from "../packages/command-bus/src/index";
import type { CommandExecutionContext, JsonObject } from "../packages/core/src/index";
import { InMemoryEventLog, SqliteEventLog } from "../packages/events/src/index";
import { InMemoryMeteringSink, SqliteMeteringSink } from "../packages/telemetry/src/index";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const context: CommandExecutionContext = {
  identity: { actorId: "atomic-operator", kind: "user" },
  tenant: { organizationId: "atomic-org", ventureId: "atomic-venture" },
  subscription: { subscriptionId: "sub", status: "active", plan: "test" },
  entitlements: [],
  grants: [],
  scopes: [],
};

const objectSchema = {
  name: "AtomicCommandObject",
  jsonSchema: { type: "object" } as const,
  parse(candidate: unknown): JsonObject {
    if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") {
      throw new Error("value must be an object");
    }
    return JSON.parse(JSON.stringify(candidate)) as JsonObject;
  },
};

const contract = defineCommandContract({
  id: "atomic.execute",
  version: 1,
  title: "Execute Atomic Effect",
  description: "Exercise atomic command idempotency.",
  input: objectSchema,
  output: objectSchema,
  requirements: { activeSubscription: false, entitlements: [], grant: true, scopes: [] },
  meter: "atomic_effects",
});

function commandBus(options: {
  idempotency: InMemoryIdempotencyStore | SqliteIdempotencyStore;
  audit?: InMemoryAuditChain;
  events?: InMemoryEventLog;
  metering?: InMemoryMeteringSink;
  now?: () => Date;
  production?: boolean;
}) {
  return new CommandBus(
    {
      identity() {},
      tenant() {},
      subscription() {},
      entitlement() {},
      grant() {},
      scope() {},
      idempotency: options.idempotency,
      audit: options.audit ?? new InMemoryAuditChain(),
      events: options.events ?? new InMemoryEventLog(),
      metering: options.metering ?? new InMemoryMeteringSink(),
    },
    {
      now: options.now,
      executionMode: options.production ? "production" : "fixture",
    },
  );
}

interface WorkerResult {
  status: "success" | "error";
  code?: string;
  output?: JsonObject;
}

function worker(
  databasePath: string,
  effectPath: string,
  startPath: string,
  value: string,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "tests/fixtures/command-bus-process.ts"),
        databasePath,
        effectPath,
        startPath,
        value,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`command worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as WorkerResult);
      } catch (error) {
        reject(new Error(`invalid command worker output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

describe("atomic command idempotency", () => {
  it("constructs durable command and evidence stores through packaged CommonJS exports", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-command-cjs-"));
    temporaryDirectories.push(directory);
    const packaged = createRequire(import.meta.url)("../packages/command-bus") as {
      SqliteIdempotencyStore: typeof SqliteIdempotencyStore;
    };
    const packagedAudit = createRequire(import.meta.url)("../packages/audit") as {
      SqliteAuditChain: typeof SqliteAuditChain;
    };
    const packagedEvents = createRequire(import.meta.url)("../packages/events") as {
      SqliteEventLog: typeof SqliteEventLog;
    };
    const packagedTelemetry = createRequire(import.meta.url)("../packages/telemetry") as {
      SqliteMeteringSink: typeof SqliteMeteringSink;
    };
    const store = new packaged.SqliteIdempotencyStore(join(directory, "idempotency.sqlite"));
    const audit = new packagedAudit.SqliteAuditChain(join(directory, "audit.sqlite"));
    const events = new packagedEvents.SqliteEventLog(join(directory, "events.sqlite"));
    const metering = new packagedTelemetry.SqliteMeteringSink(join(directory, "metering.sqlite"));
    expect(store.durability).toBe("durable_atomic");
    expect([audit.durability, events.durability, metering.durability]).toEqual([
      "durable_atomic",
      "durable_atomic",
      "durable_atomic",
    ]);
    store.close();
    audit.close();
    events.close();
    metering.close();
  });

  it("threads a durable production ledger through the packaged venture runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-command-runtime-production-"));
    temporaryDirectories.push(directory);
    const storePath = join(directory, "idempotency.sqlite");
    const auditPath = join(directory, "audit.sqlite");
    const eventsPath = join(directory, "events.sqlite");
    const meteringPath = join(directory, "metering.sqlite");
    const store = new SqliteIdempotencyStore(storePath);
    const audit = new SqliteAuditChain(auditPath);
    const events = new SqliteEventLog(eventsPath);
    const metering = new SqliteMeteringSink(meteringPath);
    const firstRuntime = createVentureRuntime({
      memberships: [
        {
          organizationId: context.tenant.organizationId,
          actorId: context.identity.actorId,
          role: "owner",
          active: true,
        },
      ],
      commandExecutionMode: "production",
      commandIdempotencyStore: store,
      audit,
      events,
      metering,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    const productionContext: CommandExecutionContext = {
      ...context,
      entitlements: ["campaigns.launch"],
      scopes: ["campaigns:write"],
      grants: [
        {
          grantId: "production-command-grant",
          commandIds: ["campaigns.launch"],
          scopes: ["campaigns:write"],
          expiresAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    };
    const invocation = { context: productionContext, idempotencyKey: "production-runtime" };
    const input = {
      campaignId: "atomic-campaign",
      channel: "organic",
      objective: "Prove durable production command wiring",
    };
    const first = await firstRuntime.execute("campaigns.launch", input, invocation);
    store.close();
    audit.close();
    events.close();
    metering.close();

    const restartedStore = new SqliteIdempotencyStore(storePath);
    const restartedAudit = new SqliteAuditChain(auditPath);
    const restartedEvents = new SqliteEventLog(eventsPath);
    const restartedMetering = new SqliteMeteringSink(meteringPath);
    const restartedRuntime = createVentureRuntime({
      memberships: [
        {
          organizationId: context.tenant.organizationId,
          actorId: context.identity.actorId,
          role: "owner",
          active: true,
        },
      ],
      commandExecutionMode: "production",
      commandIdempotencyStore: restartedStore,
      audit: restartedAudit,
      events: restartedEvents,
      metering: restartedMetering,
      now: () => new Date("2026-08-09T12:01:00.000Z"),
    });
    expect(await restartedRuntime.execute("campaigns.launch", input, invocation)).toEqual(first);
    expect(restartedEvents.read(productionContext.tenant)).toHaveLength(1);
    expect(restartedMetering.read(productionContext.tenant)).toHaveLength(1);
    expect(
      restartedAudit
        .read(productionContext.tenant)
        .filter(({ outcome }) => outcome === "succeeded"),
    ).toHaveLength(1);
    expect(restartedAudit.verify(productionContext.tenant)).toBe(true);
    restartedStore.close();
    restartedAudit.close();
    restartedEvents.close();
    restartedMetering.close();
  });

  it("defaults the packaged venture runtime to production and rejects fixture evidence sinks", () => {
    expect(() =>
      createVentureRuntime({
        memberships: [],
        commandIdempotencyStore: new InMemoryIdempotencyStore(),
        audit: new InMemoryAuditChain(),
        events: new InMemoryEventLog(),
        metering: new InMemoryMeteringSink(),
      }),
    ).toThrow(/Production venture runtime requires injected durable atomic stores/);
  });

  it("fails a directly constructed production write closed with fixture evidence sinks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-command-unsafe-evidence-"));
    temporaryDirectories.push(directory);
    const idempotency = new SqliteIdempotencyStore(join(directory, "idempotency.sqlite"));
    const bus = commandBus({ idempotency, production: true });
    let effects = 0;
    bus.register(contract, () => ({ accepted: true, effect: ++effects }));

    await expect(
      bus.execute(contract, { value: "blocked" }, { context, idempotencyKey: "unsafe-evidence" }),
    ).rejects.toMatchObject({ code: "evidence_sink_unsafe" });
    expect(effects).toBe(0);
    idempotency.close();
  });

  it("allows exactly one handler effect across independent Node processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-command-atomic-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "idempotency.sqlite");
    const effectPath = join(directory, "effects.log");
    const startPath = join(directory, "start");
    new SqliteIdempotencyStore(databasePath).close();
    const workers = [
      ...Array.from({ length: 7 }, () => worker(databasePath, effectPath, startPath, "same")),
      worker(databasePath, effectPath, startPath, "different"),
    ];
    writeFileSync(startPath, "start\n", "utf8");
    const results = await Promise.all(workers);

    expect(results.some(({ status }) => status === "success")).toBe(true);
    expect(
      results.every(
        ({ status, code }) =>
          status === "success" || code === "idempotency_pending" || code === "idempotency_conflict",
      ),
    ).toBe(true);
    expect(results.some(({ code }) => code === "idempotency_conflict")).toBe(true);
    const effects = readFileSync(effectPath, "utf8").trim().split("\n");
    expect(effects).toHaveLength(1);
    const winningValue = effects[0]!.slice(effects[0]!.indexOf(":") + 1);
    const conflictingValue = winningValue === "same" ? "different" : "same";

    const replay = await worker(databasePath, effectPath, startPath, winningValue);
    expect(replay).toMatchObject({
      status: "success",
      output: { accepted: true, value: winningValue },
    });
    const conflict = await worker(databasePath, effectPath, startPath, conflictingValue);
    expect(conflict).toMatchObject({ status: "error", code: "idempotency_conflict" });
    expect(readFileSync(effectPath, "utf8").trim().split("\n")).toHaveLength(1);
  }, 20_000);

  it("fails closed after owner loss and never takes over an unknown outcome", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-command-owner-loss-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const first = new SqliteIdempotencyStore(path, { pendingTimeoutMs: 10 });
    expect(
      first.claim("owner-loss", {
        requestHash: "sha256:one",
        ownerToken: "crashed-owner",
        now: "2026-08-09T12:00:00.000Z",
      }),
    ).toMatchObject({ kind: "owner" });
    first.close();

    const restarted = new SqliteIdempotencyStore(path, { pendingTimeoutMs: 10 });
    expect(
      restarted.claim("owner-loss", {
        requestHash: "sha256:one",
        ownerToken: "replacement-owner",
        now: "2026-08-09T12:00:01.000Z",
      }),
    ).toEqual({
      kind: "ambiguous",
      claimedAt: "2026-08-09T12:00:00.000Z",
      ambiguousAt: "2026-08-09T12:00:01.000Z",
    });
    expect(
      restarted.claim("owner-loss", {
        requestHash: "sha256:one",
        ownerToken: "another-owner",
        now: "2026-08-09T12:01:00.000Z",
      }),
    ).toMatchObject({ kind: "ambiguous" });
    restarted.close();
  });

  it("marks a thrown handler outcome ambiguous and does not invoke it again", async () => {
    const idempotency = new InMemoryIdempotencyStore();
    const bus = commandBus({ idempotency });
    let effects = 0;
    bus.register(contract, () => {
      effects += 1;
      throw new Error("connection lost after request write");
    });
    const invocation = { context, idempotencyKey: "handler-failure" };
    await expect(bus.execute(contract, { value: "same" }, invocation)).rejects.toMatchObject({
      code: "idempotency_ambiguous",
    });
    await expect(bus.execute(contract, { value: "same" }, invocation)).rejects.toMatchObject({
      code: "idempotency_ambiguous",
    });
    expect(effects).toBe(1);
  });

  it("releases a proven pre-effect handler failure so the same key can be corrected", async () => {
    const idempotency = new InMemoryIdempotencyStore();
    const bus = commandBus({ idempotency });
    let configured = false;
    let effects = 0;
    bus.register(contract, () => {
      if (!configured) {
        throw new CommandDefinitiveNoEffectError(
          "provider credential reference is unavailable",
          "handler_failed",
        );
      }
      effects += 1;
      return { accepted: true };
    });
    const invocation = { context, idempotencyKey: "correctable-pre-effect-failure" };
    await expect(bus.execute(contract, { value: "same" }, invocation)).rejects.toMatchObject({
      code: "handler_failed",
    });
    configured = true;
    await expect(bus.execute(contract, { value: "same" }, invocation)).resolves.toEqual({
      accepted: true,
    });
    expect(effects).toBe(1);
  });

  it("repairs completion artifacts on replay without duplicating prior artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-command-outbox-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const events = new SqliteEventLog(join(directory, "events.sqlite"));
    const metering = new SqliteMeteringSink(join(directory, "metering.sqlite"));
    const audit = new SqliteAuditChain(join(directory, "audit.sqlite"));
    let failSuccessAudit = true;
    const flakyAudit = {
      durability: "durable_atomic" as const,
      append(input: AuditInput) {
        if (input.outcome === "succeeded" && failSuccessAudit) {
          failSuccessAudit = false;
          throw new Error("simulated audit outage");
        }
        return audit.append(input);
      },
    };
    const firstStore = new SqliteIdempotencyStore(path);
    const firstBus = new CommandBus(
      {
        identity() {},
        tenant() {},
        subscription() {},
        entitlement() {},
        grant() {},
        scope() {},
        idempotency: firstStore,
        audit: flakyAudit,
        events,
        metering,
      },
      { executionMode: "production" },
    );
    let effects = 0;
    firstBus.register(contract, () => ({ accepted: true, effect: ++effects }));
    const invocation = { context, idempotencyKey: "artifact-repair" };
    await expect(firstBus.execute(contract, { value: "same" }, invocation)).rejects.toMatchObject({
      code: "idempotency_pending",
    });
    firstStore.close();
    events.close();
    metering.close();
    audit.close();

    const restartedStore = new SqliteIdempotencyStore(path);
    const restartedEvents = new SqliteEventLog(join(directory, "events.sqlite"));
    const restartedMetering = new SqliteMeteringSink(join(directory, "metering.sqlite"));
    const restartedAudit = new SqliteAuditChain(join(directory, "audit.sqlite"));
    const repairedAudit = {
      durability: "durable_atomic" as const,
      append: (input: AuditInput) => restartedAudit.append(input),
    };
    const restartedBus = new CommandBus(
      {
        identity() {},
        tenant() {},
        subscription() {},
        entitlement() {},
        grant() {},
        scope() {},
        idempotency: restartedStore,
        audit: repairedAudit,
        events: restartedEvents,
        metering: restartedMetering,
      },
      { executionMode: "production" },
    );
    restartedBus.register(contract, () => ({ accepted: true, effect: ++effects }));
    const replay = await restartedBus.execute(contract, { value: "same" }, invocation);
    const replayAgain = await restartedBus.execute(contract, { value: "same" }, invocation);
    restartedStore.close();

    expect(replayAgain).toEqual(replay);
    expect(effects).toBe(1);
    expect(restartedEvents.read(context.tenant)).toHaveLength(1);
    expect(restartedMetering.read(context.tenant)).toHaveLength(1);
    expect(
      restartedAudit.read(context.tenant).filter(({ outcome }) => outcome === "succeeded"),
    ).toHaveLength(1);
    restartedEvents.close();
    restartedMetering.close();
    restartedAudit.close();
  });

  it("releases an explicitly read-only claim after a retryable handler failure", async () => {
    const readContract = defineCommandContract({
      id: "atomic.read",
      version: 1,
      title: "Read Atomic State",
      description: "Exercise retryable read-only failure semantics.",
      input: objectSchema,
      output: objectSchema,
      effect: "read",
      requirements: { activeSubscription: false, entitlements: [], grant: false, scopes: [] },
    });
    const bus = commandBus({ idempotency: new InMemoryIdempotencyStore(), production: true });
    let calls = 0;
    bus.register(readContract, () => {
      calls += 1;
      if (calls === 1) throw new Error("transient read failure");
      return { available: true };
    });
    const invocation = { context, idempotencyKey: "retryable-read" };
    await expect(bus.execute(readContract, {}, invocation)).rejects.toThrow(
      "transient read failure",
    );
    expect(await bus.execute(readContract, {}, invocation)).toEqual({ available: true });
    expect(calls).toBe(2);
  });

  it("rejects fixture-only memory state in production before invoking the handler", async () => {
    const bus = commandBus({ idempotency: new InMemoryIdempotencyStore(), production: true });
    let effects = 0;
    bus.register(contract, () => ({ accepted: true, effect: ++effects }));
    await expect(
      bus.execute(contract, { value: "same" }, { context, idempotencyKey: "unsafe-store" }),
    ).rejects.toMatchObject({ code: "idempotency_store_unsafe" });
    expect(effects).toBe(0);
  });
});
