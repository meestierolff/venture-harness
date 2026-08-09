import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentGateway } from "../packages/agent-gateway/src/index";
import {
  LEARNING_CADENCE_LOOP_IDS,
  createVentureRuntime,
  type LearningRunInput,
} from "../packages/agent-runtime/src/index";
import {
  commandFailureEnvelope,
  type CommandFailureEnvelope,
} from "../packages/command-bus/src/index";
import { invokeOperationalCli } from "../packages/cli-generator/src/operational";
import type { CommandExecutionContext, TenantRef } from "../packages/core/src/index";
import {
  ConnectedLoopSourceFetcher,
  ProductionLoopRuntime,
  SqliteLoopAuthorizationStore,
  SqliteLoopOutputStore,
  SqliteLoopRunStore,
  loopDefinition,
  type ConnectedLoopSourceRequest,
  type ConnectedLoopSourceResult,
  type VentureLoopId,
} from "../packages/loops/dist/index.js";

const nowIso = "2026-08-09T12:00:00.000Z";
const integrityKey = new TextEncoder().encode("agent-learning-loop-integrity-key-v1");
const tenant = { organizationId: "org-learning", ventureId: "venture-learning" } as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function contextFor(
  selectedTenant: TenantRef = tenant,
  actorId = "operator-learning",
): CommandExecutionContext {
  return {
    identity: { actorId, kind: "user" },
    tenant: selectedTenant,
    subscription: { subscriptionId: "sub-learning", status: "active", plan: "test" },
    entitlements: [],
    scopes: [],
    grants: [],
  };
}

function metrics(loopId: VentureLoopId): Record<string, number> {
  if (loopId === "daily_early_signal") {
    return { qualified_events: 2, tracking_errors: 0, evidence_complete: 1 };
  }
  if (loopId === "weekly_growth") {
    return { activation_rate: 0.4, retention_regression: 0, sample_sufficient: 1 };
  }
  if (loopId === "biweekly_product") {
    return { task_completion_rate: 0.7, reliability_regression: 0, sample_sufficient: 1 };
  }
  if (loopId === "monthly_strategy") {
    return { retained_value: 100, cash_guardrail_breached: 0, decision_ready: 1 };
  }
  throw new Error(`unsupported learning test loop ${loopId}`);
}

type SourceMode = "valid" | "missing" | "stale" | "foreign_account";

function connectedResult(
  request: ConnectedLoopSourceRequest,
  mode: SourceMode,
): ConnectedLoopSourceResult {
  const fetchedAt = mode === "stale" ? "2026-08-09T11:59:59.000Z" : nowIso;
  if (mode === "missing") {
    return {
      schemaVersion: 1,
      tenant: request.tenant,
      runId: request.runId,
      loopId: request.loopId,
      fetchedAt,
      iterations: [],
    };
  }
  return {
    schemaVersion: 1,
    tenant: request.tenant,
    runId: request.runId,
    loopId: request.loopId,
    fetchedAt,
    iterations: [
      {
        evaluatedAt: fetchedAt,
        sources: request.sources.map(({ id }) => ({
          sourceId: id,
          observedAt: fetchedAt,
          provenance: {
            kind: "connected_provider" as const,
            tenant: request.tenant,
            providerId: "fixture-provider",
            connectionId: "connection-learning",
            externalAccountId: mode === "foreign_account" ? "account-foreign" : "account-learning",
            propertyId: "property-learning",
            operationId: `fixture-readback-${request.runId}`,
            readBackHash: "a".repeat(64),
            fetchedAt,
            reportingWindow: {
              startedAt: "2026-08-09T00:00:00.000Z",
              endedAt: fetchedAt,
              timezone: "UTC",
            },
            quality: { status: "complete" as const, limitations: [] },
            releaseVersion: "fixture-release-v1",
          },
          metrics: metrics(request.loopId),
          evidenceRefs: [`provider://fixture/${request.loopId}/${request.runId}`],
        })),
      },
    ],
  };
}

function loopHarness(
  options: {
    directory?: string;
    mode?: SourceMode;
    boundTenant?: TenantRef;
    onFetch?: () => void;
  } = {},
) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "vh-agent-learning-loop-"));
  if (!options.directory) temporaryDirectories.push(directory);
  const boundTenant = options.boundTenant ?? tenant;
  const runs = new SqliteLoopRunStore(join(directory, "runs.sqlite"), { integrityKey });
  const authorizations = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
    integrityKey,
    now: () => new Date(nowIso),
  });
  const outputs = new SqliteLoopOutputStore(join(directory, "outputs.sqlite"), {
    integrityKey,
  });
  const bindings = Object.values(LEARNING_CADENCE_LOOP_IDS).flatMap((loopId) =>
    loopDefinition(loopId).inputSources.map(({ id }) => ({
      sourceId: id,
      tenant: boundTenant,
      providerId: "fixture-provider",
      connectionId: "connection-learning",
      externalAccountId: "account-learning",
      propertyId: "property-learning",
    })),
  );
  const sources = new ConnectedLoopSourceFetcher(
    {
      fetch: (request) => {
        options.onFetch?.();
        return connectedResult(request, options.mode ?? "valid");
      },
    },
    { bindings, now: () => new Date(nowIso) },
  );
  const learningLoopRuntime = new ProductionLoopRuntime({
    runs,
    authorizations,
    sources,
    outputs,
    now: () => new Date(nowIso),
  });
  const runtime = createVentureRuntime({
    commandExecutionMode: "fixture",
    memberships: [
      {
        organizationId: boundTenant.organizationId,
        actorId: "operator-learning",
        role: "operator",
        active: true,
      },
      {
        organizationId: boundTenant.organizationId,
        actorId: "operator-second",
        role: "operator",
        active: true,
      },
      {
        organizationId: "org-foreign",
        actorId: "operator-learning",
        role: "operator",
        active: true,
      },
    ],
    learningLoopRuntime,
    now: () => new Date(nowIso),
  });
  return {
    directory,
    runtime,
    outputs,
    close() {
      outputs.close();
      authorizations.close();
      runs.close();
    },
  };
}

type Surface = "direct" | "rest" | "cli" | "mcp" | "sdk" | "ui";

async function invokeSurface(
  surface: Surface,
  runtime: ReturnType<typeof loopHarness>["runtime"],
  input: LearningRunInput,
  invocation: { context: CommandExecutionContext; idempotencyKey: string },
) {
  const gateway = createAgentGateway(runtime);
  const contract = runtime.contracts.find(({ id }) => id === "learn.run")!;
  if (surface === "direct") return gateway.direct.execute("learn.run", input, invocation);
  if (surface === "rest") {
    const response = await gateway.rest.handle({
      method: "POST",
      path: contract.surfaces.rest.path,
      body: input,
      ...invocation,
    });
    if (response.status !== 200) throw response.body;
    return response.body;
  }
  if (surface === "cli") {
    const response = await gateway.cli.invoke(
      [...contract.surfaces.cli.tokens, "--input", JSON.stringify(input), "--json"],
      invocation,
    );
    if (response.exitCode !== 0) throw response.failure;
    return JSON.parse(response.stdout) as unknown;
  }
  if (surface === "mcp") {
    return gateway.mcp.callTool(contract.surfaces.mcp.tool, input, invocation);
  }
  if (surface === "sdk") return gateway.sdk.commands.learn!.run!(input, invocation);
  return gateway.ui.find(({ commandId }) => commandId === "learn.run")!.invoke(input, invocation);
}

describe("production learning-loop Agent Surface composition", () => {
  it("maps all four report/propose cadences through one canonical six-surface command", async () => {
    let fetches = 0;
    const harness = loopHarness({ onFetch: () => (fetches += 1) });
    const surfaces: readonly Surface[] = ["direct", "rest", "cli", "mcp", "sdk", "ui"];
    for (const cadence of ["daily", "weekly", "biweekly", "monthly"] as const) {
      const invocation = { context: contextFor(), idempotencyKey: `learning-${cadence}` };
      const results: unknown[] = [];
      for (const surface of surfaces) {
        results.push(await invokeSurface(surface, harness.runtime, { cadence }, invocation));
      }
      for (const result of results) expect(result).toEqual(results[0]);
      expect(results[0]).toMatchObject({
        commandId: "learn.run",
        mode: "local_write",
        status: "completed",
        data: {
          cadence,
          loopId: LEARNING_CADENCE_LOOP_IDS[cadence],
          runId: expect.stringMatching(new RegExp(`^learn-${cadence}-[a-f0-9]{32}$`, "u")),
          completionSatisfied: true,
          iterationCount: 1,
          actionsApplied: 0,
          externalEffects: false,
          evidenceRefs: [expect.stringMatching(/^provider:\/\/fixture\//u)],
        },
      });
      const runId = (results[0] as { data: { runId: string } }).data.runId;
      expect(harness.outputs.load(tenant, runId)).toMatchObject({
        loopId: LEARNING_CADENCE_LOOP_IDS[cadence],
        runId,
        status: "completed",
        completionSatisfied: true,
        iterationCount: 1,
      });
    }
    expect(fetches).toBe(4);
    harness.close();
  });

  it("keeps the packed default truthful and makes no provider request", async () => {
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: tenant.organizationId,
          actorId: "operator-learning",
          role: "operator",
          active: true,
        },
      ],
      now: () => new Date(nowIso),
    });
    const result = await runtime.execute(
      "learn.run",
      { cadence: "weekly" },
      {
        context: contextFor(),
        idempotencyKey: "learning-unconfigured",
      },
    );
    expect(result).toEqual({
      commandId: "learn.run",
      mode: "pending",
      status: "insufficient_evidence",
      data: {
        cadence: "weekly",
        actionsApplied: 0,
        externalEffects: false,
        providerRequestMade: false,
        reason: "no normalized provider evidence is configured",
        runtime: "unconfigured",
      },
    });
  });

  it("preserves the vh learn <cadence> CLI shorthand", async () => {
    const harness = loopHarness();
    const response = await invokeOperationalCli(
      harness.runtime.bus,
      ["learn", "weekly", "--json", "--idempotency-key", "learning-cli-shorthand"],
      { context: contextFor(), idempotencyKey: "canonical-context-key" },
    );
    expect(response.exitCode, response.stderr).toBe(0);
    expect(JSON.parse(response.stdout)).toMatchObject({
      commandId: "learn.run",
      status: "completed",
      data: { cadence: "weekly", loopId: "weekly_growth", externalEffects: false },
    });
    harness.close();
  });

  it("replays from durable loop state after command-ledger restart using the canonical binding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-agent-learning-restart-"));
    temporaryDirectories.push(directory);
    let fetches = 0;
    const first = loopHarness({ directory, onFetch: () => (fetches += 1) });
    const invocation = { context: contextFor(), idempotencyKey: "learning-restart" };
    const initial = await first.runtime.execute("learn.run", { cadence: "weekly" }, invocation);
    first.close();

    const restarted = loopHarness({ directory, onFetch: () => (fetches += 1) });
    const replay = await restarted.runtime.execute("learn.run", { cadence: "weekly" }, invocation);
    expect(replay).toEqual(initial);
    restarted.close();

    const secondCaller = loopHarness({ directory, onFetch: () => (fetches += 1) });
    const secondActor = await secondCaller.runtime.execute(
      "learn.run",
      { cadence: "weekly" },
      {
        context: contextFor(tenant, "operator-second"),
        idempotencyKey: "learning-restart",
      },
    );
    expect((secondActor as { data: { runId: string } }).data.runId).toBe(
      (initial as { data: { runId: string } }).data.runId,
    );
    expect(secondActor).toEqual(initial);
    expect(fetches).toBe(1);
    secondCaller.close();
  });

  it("rejects a foreign tenant before transport and never reads another tenant's durable run", async () => {
    let fetches = 0;
    const harness = loopHarness({ onFetch: () => (fetches += 1) });
    await expect(
      harness.runtime.execute(
        "learn.run",
        { cadence: "weekly" },
        {
          context: contextFor({ organizationId: "org-foreign", ventureId: tenant.ventureId }),
          idempotencyKey: "learning-foreign-tenant",
        },
      ),
    ).rejects.toThrow(/one exact trusted account binding/);
    expect(fetches).toBe(0);
    harness.close();
  });

  for (const scenario of [
    ["missing", /no iteration evidence/],
    ["stale", /outside the trusted request window/],
    ["foreign_account", /trusted account read-back binding/],
  ] as const) {
    it(`returns one sanitized ${scenario[0]}-source error on all six surfaces`, async () => {
      const failures: CommandFailureEnvelope[] = [];
      for (const surface of ["direct", "rest", "cli", "mcp", "sdk", "ui"] as const) {
        const harness = loopHarness({ mode: scenario[0] });
        try {
          await invokeSurface(
            surface,
            harness.runtime,
            { cadence: "weekly" },
            {
              context: contextFor(),
              idempotencyKey: `learning-${scenario[0]}`,
            },
          );
          throw new Error("expected learning source rejection");
        } catch (error) {
          failures.push(
            error &&
              typeof error === "object" &&
              "error" in error &&
              error.error === "command_failed"
              ? (error as CommandFailureEnvelope)
              : commandFailureEnvelope(error),
          );
        } finally {
          harness.close();
        }
      }
      expect(new Set(failures.map(({ code }) => code))).toEqual(new Set(["handler_failed"]));
      expect(new Set(failures.map(({ message }) => message)).size).toBe(1);
      expect(failures[0]!.message).toMatch(scenario[1]);
    });
  }
});
