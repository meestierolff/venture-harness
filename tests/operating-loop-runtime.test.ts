import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectedLoopSourceFetcher,
  InMemoryLoopRunStore,
  ProductionLoopRuntime,
  SqliteLoopAuthorizationStore,
  SqliteLoopEffectExecutor,
  SqliteLoopOutputStore,
  SqliteLoopRunStore,
  VENTURE_LOOP_CATALOG,
  VENTURE_LOOP_IDS,
  executeVentureLoop,
  loopDefinition,
  loopDefinitionHash,
  loopEffectIdempotencyKey,
  validateLoopDefinition,
  type LoopEffectExecutor,
  type LoopEffectEvidence,
  type LoopEffectRequest,
  type LoopEffectReconciliation,
  type LoopEffectTransport,
  type LoopIterationInput,
  type LoopMetricPredicate,
  type LoopRunInput,
  type VentureLoopDefinition,
} from "../packages/loops/src/index";

const tenant = { organizationId: "org-loop", ventureId: "venture-loop" } as const;
const evaluatedAt = "2026-08-09T12:00:00.000Z";
const temporaryDirectories: string[] = [];
const loopStoreOptions = {
  integrityKey: new TextEncoder().encode("venture-harness-loop-integrity-key-v1"),
} as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function satisfyingValue(predicate: LoopMetricPredicate): number {
  if (predicate.operator === "gt") return predicate.threshold + 1;
  if (predicate.operator === "gte" || predicate.operator === "eq") return predicate.threshold;
  return predicate.threshold - 1;
}

function safeGuardrailValue(predicate: LoopMetricPredicate): number {
  if (predicate.operator === "gt") return predicate.threshold;
  if (predicate.operator === "gte" || predicate.operator === "eq") return predicate.threshold + 1;
  return predicate.threshold;
}

function freshIteration(definition: VentureLoopDefinition): LoopIterationInput {
  const metricsBySource = new Map<string, Record<string, number | null>>(
    definition.inputSources.map(({ id }) => [id, {}]),
  );
  for (const metric of definition.primaryMetrics) {
    metricsBySource.get(metric.sourceId)![metric.metricId] = 1;
  }
  for (const guardrail of definition.guardrails) {
    metricsBySource.get(guardrail.sourceId)![guardrail.metricId] = safeGuardrailValue(guardrail);
  }
  for (const predicate of definition.decisionRules.flatMap(({ when }) => when)) {
    metricsBySource.get(predicate.sourceId)![predicate.metricId] = satisfyingValue(predicate);
  }
  for (const predicate of definition.completion.when) {
    metricsBySource.get(predicate.sourceId)![predicate.metricId] = satisfyingValue(predicate);
  }
  return {
    evaluatedAt,
    sources: definition.inputSources.map(({ id }) => ({
      sourceId: id,
      observedAt: evaluatedAt,
      provenance: { kind: "fixture" as const, fixtureId: `fixture-${definition.id}-${id}` },
      metrics: metricsBySource.get(id)!,
      evidenceRefs: [`fixture://${definition.id}/${id}`],
    })),
  };
}

function input(
  definition: VentureLoopDefinition,
  runId = `run-${definition.id}`,
  iterations: readonly LoopIterationInput[] = [freshIteration(definition)],
): LoopRunInput {
  return {
    tenant,
    runId,
    trigger: definition.trigger,
    iterations,
    authorizationEnvelopeId: "fixture-envelope",
    authorizedEffects: [...definition.allowedEffects],
  };
}

function productionInput(
  definition: VentureLoopDefinition,
  runId: string,
  iterations: readonly LoopIterationInput[] = [freshIteration(definition)],
  authorizationEnvelopeId = "apply-envelope",
): LoopRunInput {
  return {
    ...input(
      definition,
      runId,
      iterations.map((iteration) => ({
        ...iteration,
        sources: iteration.sources.map((source) => ({
          ...source,
          provenance: {
            kind: "connected_provider" as const,
            tenant,
            providerId: "fixture-transport",
            connectionId: "connection-loop",
            externalAccountId: "account-loop",
            propertyId: "property-loop",
            operationId: `readback-${runId}-${source.sourceId}`,
            readBackHash: "b".repeat(64),
            fetchedAt: evaluatedAt,
            reportingWindow: {
              startedAt: "2026-08-09T11:00:00.000Z",
              endedAt: evaluatedAt,
              timezone: "UTC",
            },
            quality: { status: "complete" as const, limitations: [] },
            releaseVersion: "fixture-release-v1",
          },
          evidenceRefs: [`provider://loop/${runId}/${source.sourceId}`],
        })),
      })),
    ),
    authorizationEnvelopeId,
    authorizedEffects: [],
  };
}

function productionRuntimeFromInput(options: {
  readonly directory: string;
  readonly definition: VentureLoopDefinition;
  readonly input: LoopRunInput;
  readonly runs: SqliteLoopRunStore;
  readonly authorizations: SqliteLoopAuthorizationStore;
  readonly effects?: SqliteLoopEffectExecutor;
  readonly now?: () => Date;
  readonly outputName?: string;
}): { readonly runtime: ProductionLoopRuntime; readonly outputs: SqliteLoopOutputStore } {
  const now = options.now ?? (() => new Date(evaluatedAt));
  const sources = new ConnectedLoopSourceFetcher(
    {
      fetch: () => ({
        schemaVersion: 1,
        tenant: options.input.tenant,
        runId: options.input.runId,
        loopId: options.definition.id,
        fetchedAt: now().toISOString(),
        iterations: options.input.iterations,
      }),
    },
    {
      bindings: options.definition.inputSources.map(({ id }) => ({
        sourceId: id,
        tenant: options.input.tenant,
        providerId: "fixture-transport",
        connectionId: "connection-loop",
        externalAccountId: "account-loop",
        propertyId: "property-loop",
      })),
      now,
    },
  );
  const outputs = new SqliteLoopOutputStore(
    join(options.directory, options.outputName ?? "outputs.sqlite"),
    loopStoreOptions,
  );
  return {
    runtime: new ProductionLoopRuntime({
      runs: options.runs,
      authorizations: options.authorizations,
      effects: options.effects,
      sources,
      outputs,
      now,
    }),
    outputs,
  };
}

function fixtureEvidence(summaryCode = "fixture_effect"): LoopEffectEvidence {
  return {
    schemaVersion: 1,
    provenance: "fixture",
    verification: "fixture",
    evidenceRefs: [`fixture://loop/${summaryCode}`],
    operationId: null,
    readBackHash: null,
    observedAt: evaluatedAt,
    summaryCode,
  };
}

function providerEvidence(
  verification: "verified" | "accepted_unverified" | "confirmed_absent",
  summaryCode: string,
): LoopEffectEvidence {
  return {
    schemaVersion: 1,
    provenance: "provider_readback",
    verification,
    evidenceRefs: [`provider://loop/${summaryCode}`],
    operationId: `operation-${summaryCode}`,
    readBackHash: verification === "accepted_unverified" ? null : "a".repeat(64),
    observedAt: evaluatedAt,
    summaryCode,
  };
}

function localEvidence(
  verification: "verified" | "accepted_unverified" | "confirmed_absent",
  summaryCode: string,
): LoopEffectEvidence {
  return {
    ...providerEvidence(verification, summaryCode),
    provenance: "local_checkpoint",
    evidenceRefs: [`checkpoint://loop/${summaryCode}`],
  };
}

function grantLoopEnvelope(
  authorizer: SqliteLoopAuthorizationStore,
  definition: VentureLoopDefinition,
  runId: string,
  envelopeId: string,
  allowedEffects: readonly string[],
  notBefore = "2026-08-09T11:59:00.000Z",
  expiresAt = "2026-08-09T13:00:00.000Z",
  options: {
    readonly purpose?: "apply" | "reconcile";
    readonly targetIdempotencyKey?: string;
    readonly targetAttemptToken?: string;
  } = {},
): void {
  const purpose = options.purpose ?? "apply";
  authorizer.grant({
    schemaVersion: 2,
    tenant,
    envelopeId,
    runId,
    loopId: definition.id,
    definitionHash: loopDefinitionHash(definition.id),
    purpose,
    allowedEffects,
    issuedAt: notBefore,
    notBefore,
    expiresAt,
    revokedAt: null,
    targetIdempotencyKey: options.targetIdempotencyKey ?? null,
    targetAttemptToken: options.targetAttemptToken ?? null,
  });
}

function directEffectRequest(
  definition: VentureLoopDefinition,
  runId: string,
  attemptToken = "attempt-direct",
): LoopEffectRequest {
  const rule = definition.decisionRules.find(({ action }) => action.effect !== "none");
  if (!rule) throw new Error("test loop requires an effectful rule");
  return {
    tenant,
    runId,
    loopId: definition.id,
    definitionHash: loopDefinitionHash(definition.id),
    iteration: 1,
    ruleId: rule.id,
    idempotencyKey: loopEffectIdempotencyKey({
      tenant,
      runId,
      loopId: definition.id,
      ruleId: rule.id,
      iteration: 1,
    }),
    authorizationEnvelopeId: "apply-envelope",
    attemptToken,
    action: rule.action,
  };
}

const appliedExecutor: LoopEffectExecutor = {
  durability: "fixture_only",
  apply: () => ({ state: "applied", evidence: fixtureEvidence("applied") }),
  reconcile: () => ({ state: "applied", evidence: fixtureEvidence("reconciled") }),
};

const durableAppliedExecutor: LoopEffectExecutor = {
  durability: "durable_apply_once",
  apply: () => ({ state: "applied", evidence: providerEvidence("verified", "applied") }),
  reconcile: () => ({
    state: "applied",
    evidence: providerEvidence("verified", "reconciled"),
  }),
};

const activeEnvelope = { authorize: () => true } as const;

describe("v0.2 operating-loop runtime", () => {
  it("ships all ten immutable, explicit, executable loop contracts", async () => {
    expect(VENTURE_LOOP_CATALOG.map(({ id }) => id)).toEqual(VENTURE_LOOP_IDS);
    expect(new Set(VENTURE_LOOP_CATALOG.map(({ id }) => id)).size).toBe(10);
    for (const definition of VENTURE_LOOP_CATALOG) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.decisionRules)).toBe(true);
      expect(definition).toMatchObject({
        schemaVersion: 1,
        maximumActions: expect.any(Number),
        maximumIterations: expect.any(Number),
        autonomy: expect.any(String),
        trigger: { kind: expect.any(String), expression: expect.any(String) },
        nextRun: { kind: expect.any(String), expression: expect.any(String) },
        output: { kind: expect.any(String), destination: expect.any(String) },
      });
      expect(definition.inputSources.length).toBeGreaterThan(0);
      expect(definition.primaryMetrics.length).toBeGreaterThan(0);
      expect(definition.stopConditions.length).toBeGreaterThan(0);
      const result = await executeVentureLoop({
        definition,
        input: input(definition),
        store: new InMemoryLoopRunStore(),
        executor: appliedExecutor,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      });
      expect(["completed", "stopped"]).toContain(result.status);
      expect(result.iteration).toBe(1);
    }
  });

  it("rejects structurally unsafe definitions before a run is claimed", () => {
    const definition = loopDefinition("weekly_growth");
    expect(() =>
      validateLoopDefinition({
        ...definition,
        maximumIterations: 0,
      }),
    ).toThrow(/maximumIterations must be positive/);
    expect(() =>
      validateLoopDefinition({
        ...definition,
        decisionRules: [
          {
            ...definition.decisionRules[0]!,
            action: { ...definition.decisionRules[0]!.action, effect: "provider.write" },
          },
        ],
      }),
    ).toThrow(/undeclared effect/);
    expect(() =>
      validateLoopDefinition({
        ...definition,
        trigger: { ...definition.trigger, kind: "cron" as never },
      }),
    ).toThrow(/trigger kind is invalid/);
  });

  it("rejects raw production execution before claim and malformed fixture evidence", async () => {
    const definition = loopDefinition("winner_metric_snapshots");
    const store = new InMemoryLoopRunStore();
    await expect(
      executeVentureLoop({
        definition,
        input: input(definition, "unsafe-store"),
        store,
        executor: appliedExecutor,
        executionMode: "production" as "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/raw production loop execution is forbidden/);
    expect(store.load(tenant, "unsafe-store")).toBeNull();

    const iteration = freshIteration(definition);
    const future: LoopIterationInput = {
      ...iteration,
      evaluatedAt: "2026-08-09T12:00:01.000Z",
    };
    await expect(
      executeVentureLoop({
        definition,
        input: input(definition, "future-evidence", [future]),
        store,
        executor: appliedExecutor,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/cannot be dated after execution started/);
    expect(store.load(tenant, "future-evidence")).toBeNull();
  });

  it("treats missing or stale required input as no evidence and performs no effect", async () => {
    const definition = loopDefinition("winner_metric_snapshots");
    let applied = 0;
    const executor: LoopEffectExecutor = {
      durability: "fixture_only",
      apply: () => {
        applied += 1;
        return { state: "applied", evidence: fixtureEvidence("missing_source_unreached") };
      },
      reconcile: () => ({ state: "unknown", evidence: fixtureEvidence("missing_source_unknown") }),
    };
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "missing-source", [{ evaluatedAt, sources: [] }]),
      store: new InMemoryLoopRunStore(),
      executor,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.limitations.join(" ")).toContain("missing is not zero");
    expect(applied).toBe(0);

    const stale = freshIteration(definition);
    const staleResult = await executeVentureLoop({
      definition,
      input: input(definition, "stale-source", [
        {
          ...stale,
          sources: stale.sources.map((source) => ({
            ...source,
            observedAt: "2026-08-09T10:00:00.000Z",
          })),
        },
      ]),
      store: new InMemoryLoopRunStore(),
      executor,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(staleResult.status).toBe("insufficient_evidence");
    expect(staleResult.limitations.join(" ")).toContain("stale");
    expect(applied).toBe(0);
  });

  it("stops on a guardrail before applying an otherwise eligible decision", async () => {
    const definition = loopDefinition("creative_fatigue");
    const iteration = freshIteration(definition);
    const sources = iteration.sources.map((source) =>
      source.sourceId === "creative_performance"
        ? { ...source, metrics: { ...source.metrics, attribution_uncertain: 1 } }
        : source,
    );
    let applied = 0;
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "guardrail", [{ ...iteration, sources }]),
      store: new InMemoryLoopRunStore(),
      executor: {
        ...appliedExecutor,
        apply: () => {
          applied += 1;
          return { state: "applied", evidence: fixtureEvidence("guardrail_unreached") };
        },
      },
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(result).toMatchObject({ status: "stopped", stopReason: "guardrail_breach" });
    expect(applied).toBe(0);
  });

  it("fails closed when a declared guardrail metric is absent", async () => {
    const definition = loopDefinition("creative_fatigue");
    const iteration = freshIteration(definition);
    const withoutGuardrail: LoopIterationInput = {
      ...iteration,
      sources: iteration.sources.map((source) => ({
        ...source,
        metrics: Object.fromEntries(
          Object.entries(source.metrics).filter(
            ([metricId]) => metricId !== "attribution_uncertain",
          ),
        ),
      })),
    };
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "missing-guardrail", [withoutGuardrail]),
      store: new InMemoryLoopRunStore(),
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.limitations.join(" ")).toContain("Guardrail loop metric");
    expect(result.actions).toHaveLength(0);
  });

  it("binds idempotency to the complete request and replays one applied effect", async () => {
    const definition = loopDefinition("winner_metric_snapshots");
    const store = new InMemoryLoopRunStore();
    let applyCount = 0;
    const executor: LoopEffectExecutor = {
      durability: "fixture_only",
      apply: () => {
        applyCount += 1;
        return { state: "applied", evidence: fixtureEvidence("idempotent_apply") };
      },
      reconcile: () => ({ state: "applied", evidence: fixtureEvidence("idempotent_reconcile") }),
    };
    const request = input(definition, "idempotent-run");
    const first = await executeVentureLoop({
      definition,
      input: request,
      store,
      executor,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    const replay = await executeVentureLoop({
      definition,
      input: request,
      store,
      executor,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(first.actions[0]).toMatchObject({ state: "applied" });
    expect(replay).toEqual(first);
    expect(applyCount).toBe(1);

    const unchanged = freshIteration(definition);
    const changed: LoopIterationInput = {
      ...unchanged,
      sources: unchanged.sources.map((source, index) =>
        index === 0 ? { ...source, metrics: { ...source.metrics, fresh_snapshots: 2 } } : source,
      ),
    };
    await expect(
      executeVentureLoop({
        definition,
        input: input(definition, "idempotent-run", [changed]),
        store,
        executor,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/idempotency conflict/);
  });

  it("keeps an ambiguous effect prepared across restart and reconciles without reapply", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "loops.sqlite");
    const definition = loopDefinition("winner_metric_snapshots");
    const request = input(definition, "restart-run");
    let applyCount = 0;
    const firstStore = new SqliteLoopRunStore(path, loopStoreOptions);
    const first = await executeVentureLoop({
      definition,
      input: request,
      store: firstStore,
      executor: {
        durability: "durable_apply_once",
        apply: () => {
          applyCount += 1;
          return {
            state: "unknown",
            evidence: providerEvidence("accepted_unverified", "restart_accepted"),
          };
        },
        reconcile: () => ({
          state: "unknown",
          evidence: providerEvidence("accepted_unverified", "restart_unknown"),
        }),
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
      leaseMilliseconds: 1_000,
    });
    expect(first).toMatchObject({
      status: "waiting_for_reconciliation",
      actions: [expect.objectContaining({ state: "unknown" })],
    });
    firstStore.close();

    const secondStore = new SqliteLoopRunStore(path, loopStoreOptions);
    const resumedAt = new Date("2026-08-09T12:00:02.000Z");
    const resumed = await executeVentureLoop({
      definition,
      input: request,
      store: secondStore,
      executor: {
        durability: "durable_apply_once",
        apply: () => {
          throw new Error("ambiguous effects must never be applied again");
        },
        reconcile: (effect) => ({
          state: "applied",
          evidence: providerEvidence("verified", `restart_${effect.idempotencyKey.slice(0, 8)}`),
        }),
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => resumedAt,
      leaseMilliseconds: 1_000,
    });
    expect(resumed).toMatchObject({
      status: "completed",
      actions: [expect.objectContaining({ state: "applied" })],
    });
    expect(applyCount).toBe(1);
    secondStore.close();
  });

  it("atomically excludes a second SQLite owner and isolates equal run IDs by tenant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "loops.sqlite");
    const definition = loopDefinition("winner_metric_snapshots");
    const firstStore = new SqliteLoopRunStore(path, loopStoreOptions);
    const secondStore = new SqliteLoopRunStore(path, loopStoreOptions);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredApply = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request = input(definition, "shared-run");
    const firstPromise = executeVentureLoop({
      definition,
      input: request,
      store: firstStore,
      executor: {
        durability: "durable_apply_once",
        apply: async () => {
          entered();
          await blocked;
          return { state: "applied", evidence: providerEvidence("verified", "concurrent_apply") };
        },
        reconcile: () => ({
          state: "unknown",
          evidence: providerEvidence("accepted_unverified", "concurrent_unknown"),
        }),
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    await enteredApply;
    await expect(
      executeVentureLoop({
        definition,
        input: request,
        store: secondStore,
        executor: durableAppliedExecutor,
        authorizer: activeEnvelope,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/pending under another owner/);
    release();
    await firstPromise;

    const otherTenant = { organizationId: "org-other", ventureId: tenant.ventureId };
    const isolated = await executeVentureLoop({
      definition,
      input: { ...request, tenant: otherTenant },
      store: secondStore,
      executor: durableAppliedExecutor,
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(isolated.status).toBe("completed");
    expect(firstStore.load(tenant, "shared-run")).not.toBeNull();
    expect(firstStore.load(otherTenant, "shared-run")).not.toBeNull();
    firstStore.close();
    secondStore.close();
  });

  it("never applies an effect outside the active authorization envelope", async () => {
    const definition = loopDefinition("fleet_upgrade");
    let applyCount = 0;
    const result = await executeVentureLoop({
      definition,
      input: { ...input(definition, "unauthorized"), authorizedEffects: [] },
      store: new InMemoryLoopRunStore(),
      executor: {
        ...appliedExecutor,
        apply: () => {
          applyCount += 1;
          return { state: "applied", evidence: fixtureEvidence("unauthorized_unreached") };
        },
      },
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(result.actions[0]).toMatchObject({
      state: "rejected",
      reason: "effect is outside the active authorization",
    });
    expect(applyCount).toBe(0);
  });

  it("keeps raw production inaccessible and requires authority inside the durable executor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const store = new SqliteLoopRunStore(join(directory, "loops.sqlite"), loopStoreOptions);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    const transport: LoopEffectTransport = {
      apply: () => ({ state: "applied", evidence: localEvidence("verified", "production") }),
      readBack: () => ({
        state: "applied",
        evidence: localEvidence("verified", "production_readback"),
      }),
    };
    expect(
      () =>
        new SqliteLoopEffectExecutor(join(directory, "missing-authority.sqlite"), {
          ...loopStoreOptions,
          transport,
          now: () => new Date(evaluatedAt),
        } as never),
    ).toThrow(/requires the authoritative authorization store/);
    const executor = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer,
      transport,
      now: () => new Date(evaluatedAt),
    });
    await expect(
      executeVentureLoop({
        definition,
        input: input(definition, "fixture-executor-production"),
        store,
        executor: appliedExecutor,
        executionMode: "production" as "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/raw production loop execution is forbidden/);
    await expect(
      executeVentureLoop({
        definition,
        input: productionInput(definition, "missing-authorizer-production"),
        store,
        executor,
        executionMode: "production" as "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/raw production loop execution is forbidden/);
    expect(store.load(tenant, "fixture-executor-production")).toBeNull();
    expect(store.load(tenant, "missing-authorizer-production")).toBeNull();
    executor.close();
    authorizer.close();
    store.close();
  });

  it("rejects lookalike production components before connected evidence can be bypassed", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("weekly_growth");
    const runs = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const authorizations = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    const outputs = new SqliteLoopOutputStore(join(directory, "outputs.sqlite"), loopStoreOptions);
    let fetched = 0;
    expect(
      () =>
        new ProductionLoopRuntime({
          runs,
          authorizations,
          sources: {
            fetch: () => {
              fetched += 1;
              return productionInput(definition, "lookalike-source").iterations;
            },
          } as never,
          outputs,
          now: () => new Date(evaluatedAt),
        }),
    ).toThrow(/concrete connected-source fetcher/);
    expect(fetched).toBe(0);
    expect(runs.load(tenant, "lookalike-source")).toBeNull();
    outputs.close();
    authorizations.close();
    runs.close();
  });

  it("applies exactly once through the concrete production authority and operation journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const runId = "production-apply";
    const store = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    grantLoopEnvelope(authorizer, definition, runId, "apply-envelope", ["local.write"]);
    let applied = 0;
    const executor = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => {
          applied += 1;
          return { state: "applied", evidence: localEvidence("verified", "production_apply") };
        },
        readBack: () => ({
          state: "applied",
          evidence: localEvidence("verified", "production_replay"),
        }),
      },
    });
    const request = productionInput(definition, runId);
    const { runtime, outputs } = productionRuntimeFromInput({
      directory,
      definition,
      input: request,
      runs: store,
      effects: executor,
      authorizations: authorizer,
      now: () => new Date(evaluatedAt),
    });
    const first = await runtime.run({
      loopId: definition.id,
      tenant,
      runId,
      authorizationEnvelopeId: "apply-envelope",
    });
    const replay = await runtime.run({ loopId: definition.id, tenant, runId });
    expect(first).toMatchObject({
      status: "completed",
      actions: [expect.objectContaining({ state: "applied" })],
      evaluations: [
        expect.objectContaining({
          completionSatisfied: true,
          sources: [
            expect.objectContaining({
              provenance: expect.objectContaining({ kind: "connected_provider" }),
            }),
          ],
        }),
      ],
    });
    expect(replay).toEqual(first);
    expect(applied).toBe(1);
    outputs.close();
    executor.close();
    authorizer.close();
    store.close();
  });

  it("composes connected source fetch, durable execution, and a nonempty local output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const runId = "production-composed";
    const runs = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const authorizations = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    grantLoopEnvelope(authorizations, definition, runId, "apply-envelope", ["local.write"]);
    let fetches = 0;
    const sources = new ConnectedLoopSourceFetcher(
      {
        fetch: () => {
          fetches += 1;
          return {
            schemaVersion: 1,
            tenant,
            runId,
            loopId: definition.id,
            fetchedAt: evaluatedAt,
            iterations: productionInput(definition, runId).iterations,
          };
        },
      },
      {
        bindings: definition.inputSources.map(({ id }) => ({
          sourceId: id,
          tenant,
          providerId: "fixture-transport",
          connectionId: "connection-loop",
          externalAccountId: "account-loop",
          propertyId: "property-loop",
        })),
        now: () => new Date(evaluatedAt),
      },
    );
    let applies = 0;
    const effects = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer: authorizations,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => {
          applies += 1;
          return { state: "applied", evidence: localEvidence("verified", "composed_apply") };
        },
        readBack: () => ({
          state: "applied",
          evidence: localEvidence("verified", "composed_readback"),
        }),
      },
    });
    const outputs = new SqliteLoopOutputStore(join(directory, "outputs.sqlite"), loopStoreOptions);
    const runtime = new ProductionLoopRuntime({
      runs,
      authorizations,
      effects,
      sources,
      outputs,
      now: () => new Date(evaluatedAt),
    });
    const first = await runtime.run({
      loopId: definition.id,
      tenant,
      runId,
      authorizationEnvelopeId: "apply-envelope",
    });
    const replay = await runtime.run({ loopId: definition.id, tenant, runId });
    expect(first.status).toBe("completed");
    expect(replay).toEqual(first);
    expect(fetches).toBe(1);
    expect(applies).toBe(1);
    expect(outputs.load(tenant, runId)).toMatchObject({
      status: "completed",
      completionSatisfied: true,
      iterationCount: 1,
      evidenceRefs: [expect.stringMatching(/^provider:\/\//u)],
    });
    outputs.close();
    effects.close();
    authorizations.close();
    runs.close();
  });

  it("never accepts a local checkpoint or future observation as verified provider success", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const store = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    grantLoopEnvelope(authorizer, definition, "local-checkpoint-success", "apply-local", [
      "local.write",
    ]);
    grantLoopEnvelope(authorizer, definition, "future-readback-success", "apply-future", [
      "local.write",
    ]);
    const executor = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: (request) =>
          request.runId === "local-checkpoint-success"
            ? {
                state: "applied",
                evidence: {
                  schemaVersion: 1,
                  provenance: "local_checkpoint",
                  verification: "verified",
                  evidenceRefs: ["checkpoint://loop/local-success"],
                  operationId: null,
                  readBackHash: null,
                  observedAt: evaluatedAt,
                  summaryCode: "local_success",
                },
              }
            : {
                state: "applied",
                evidence: {
                  ...localEvidence("verified", "future_success"),
                  observedAt: "2099-01-01T00:00:00.000Z",
                },
              },
        readBack: () => ({
          state: "unknown",
          evidence: localEvidence("accepted_unverified", "truth_unreached"),
        }),
      },
    });
    const localInput = productionInput(
      definition,
      "local-checkpoint-success",
      undefined,
      "apply-local",
    );
    const localRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: localInput,
      runs: store,
      authorizations: authorizer,
      effects: executor,
      outputName: "local-outputs.sqlite",
    });
    await expect(
      localRuntime.runtime.run({
        loopId: definition.id,
        tenant,
        runId: localInput.runId,
        authorizationEnvelopeId: "apply-local",
      }),
    ).rejects.toThrow(/exact local checkpoint binding/);
    const futureInput = productionInput(
      definition,
      "future-readback-success",
      undefined,
      "apply-future",
    );
    const futureRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: futureInput,
      runs: store,
      authorizations: authorizer,
      effects: executor,
      outputName: "future-outputs.sqlite",
    });
    await expect(
      futureRuntime.runtime.run({
        loopId: definition.id,
        tenant,
        runId: futureInput.runId,
        authorizationEnvelopeId: "apply-future",
      }),
    ).rejects.toThrow(/future-dated or stale/);
    expect(store.load(tenant, "local-checkpoint-success")?.status).toBe("running");
    expect(store.load(tenant, "future-readback-success")?.status).toBe("running");
    localRuntime.outputs.close();
    futureRuntime.outputs.close();
    executor.close();
    authorizer.close();
    store.close();
  });

  it("requires fresh read-back-only authority to reconcile an unknown production effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const runId = "production-recovery";
    const runPath = join(directory, "runs.sqlite");
    const effectPath = join(directory, "effects.sqlite");
    let currentMs = Date.parse(evaluatedAt);
    const now = () => new Date(currentMs);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now,
    });
    grantLoopEnvelope(
      authorizer,
      definition,
      runId,
      "apply-envelope",
      ["local.write"],
      "2026-08-09T11:59:00.000Z",
      "2026-08-09T12:00:01.000Z",
    );
    const request = productionInput(definition, runId);
    let applied = 0;
    let readBacks = 0;
    const firstStore = new SqliteLoopRunStore(runPath, loopStoreOptions);
    const firstExecutor = new SqliteLoopEffectExecutor(effectPath, {
      ...loopStoreOptions,
      authorizer,
      now,
      transport: {
        apply: () => {
          applied += 1;
          return {
            state: "unknown",
            evidence: localEvidence("accepted_unverified", "production_unknown"),
          };
        },
        readBack: () => {
          throw new Error("the first process does not reconcile");
        },
      },
    });
    const firstRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: request,
      runs: firstStore,
      effects: firstExecutor,
      authorizations: authorizer,
      now,
      outputName: "first-outputs.sqlite",
    });
    const first = await firstRuntime.runtime.run({
      loopId: definition.id,
      tenant,
      runId,
      authorizationEnvelopeId: "apply-envelope",
    });
    expect(first.status).toBe("waiting_for_reconciliation");
    firstRuntime.outputs.close();
    firstExecutor.close();
    firstStore.close();

    currentMs += 31_000;
    const blockedStore = new SqliteLoopRunStore(runPath, loopStoreOptions);
    const blockedExecutor = new SqliteLoopEffectExecutor(effectPath, {
      ...loopStoreOptions,
      authorizer,
      now,
      transport: {
        apply: () => {
          throw new Error("an unknown production effect must not be applied again");
        },
        readBack: () => {
          readBacks += 1;
          return {
            state: "applied",
            evidence: localEvidence("verified", "production_recovered"),
          };
        },
      },
    });
    const blockedRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: request,
      runs: blockedStore,
      effects: blockedExecutor,
      authorizations: authorizer,
      now,
      outputName: "blocked-outputs.sqlite",
    });
    const blocked = await blockedRuntime.runtime.run({ loopId: definition.id, tenant, runId });
    expect(blocked.status).toBe("waiting_for_reconciliation");
    expect(blocked.limitations.join(" ")).toContain("read-back-only authorization");
    expect(readBacks).toBe(0);
    blockedRuntime.outputs.close();
    blockedStore.close();

    currentMs += 31_000;
    const preparedAction = first.actions[0]!;
    grantLoopEnvelope(
      authorizer,
      definition,
      runId,
      "reconcile-envelope",
      ["loop.reconcile"],
      new Date(currentMs).toISOString(),
      new Date(currentMs + 5 * 60 * 1_000).toISOString(),
      {
        purpose: "reconcile",
        targetIdempotencyKey: preparedAction.idempotencyKey,
        targetAttemptToken: preparedAction.attemptToken!,
      },
    );
    const recoveredStore = new SqliteLoopRunStore(runPath, loopStoreOptions);
    const recoveredRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: request,
      runs: recoveredStore,
      effects: blockedExecutor,
      authorizations: authorizer,
      now,
      outputName: "recovered-outputs.sqlite",
    });
    const recovered = await recoveredRuntime.runtime.run({
      loopId: definition.id,
      tenant,
      runId,
      reconciliationEnvelopeId: "reconcile-envelope",
    });
    expect(recovered).toMatchObject({
      status: "completed",
      actions: [expect.objectContaining({ state: "applied" })],
    });
    expect(applied).toBe(1);
    expect(readBacks).toBe(1);
    expect(
      authorizer.authorizeReconciliation(
        {
          tenant,
          runId,
          loopId: definition.id,
          definitionHash: loopDefinitionHash(definition.id),
          iteration: preparedAction.iteration,
          ruleId: preparedAction.ruleId,
          idempotencyKey: preparedAction.idempotencyKey,
          authorizationEnvelopeId: "apply-envelope",
          attemptToken: preparedAction.attemptToken!,
          action: preparedAction.action,
        },
        "reconcile-envelope",
      ),
    ).toBe(false);
    recoveredRuntime.outputs.close();
    blockedExecutor.close();
    recoveredStore.close();
    authorizer.close();
  });

  it("rejects credential-shaped provider evidence before any durable result is written", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const runId = "production-secret";
    const runPath = join(directory, "runs.sqlite");
    const effectPath = join(directory, "effects.sqlite");
    const store = new SqliteLoopRunStore(runPath, loopStoreOptions);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    grantLoopEnvelope(authorizer, definition, runId, "apply-envelope", ["local.write"]);
    const secret = "whsec_secondary_productionevidence123456";
    const executor = new SqliteLoopEffectExecutor(effectPath, {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => ({
          state: "applied",
          evidence: {
            ...localEvidence("verified", "unsafe_provider_result"),
            evidenceRefs: [`provider://loop/${secret}`],
            operationId: secret,
            summaryCode: secret,
          },
        }),
        readBack: () => ({
          state: "unknown",
          evidence: localEvidence("accepted_unverified", "unsafe_unreached"),
        }),
      },
    });
    const production = productionInput(definition, runId);
    const { runtime, outputs } = productionRuntimeFromInput({
      directory,
      definition,
      input: production,
      runs: store,
      effects: executor,
      authorizations: authorizer,
    });
    await expect(
      runtime.run({
        loopId: definition.id,
        tenant,
        runId,
        authorizationEnvelopeId: "apply-envelope",
      }),
    ).rejects.toThrow(/credential-like material/);

    interface RawDatabase {
      prepare(sql: string): { get(...values: unknown[]): unknown };
      close(): void;
    }
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => RawDatabase;
    };
    const rawRun = new DatabaseSync(runPath);
    const rawEffect = new DatabaseSync(effectPath);
    const runRow = rawRun.prepare("SELECT record_json FROM loop_runs").get() as {
      record_json: string;
    };
    const effectRow = rawEffect
      .prepare("SELECT evidence_json FROM loop_effect_operations")
      .get() as { evidence_json: string };
    expect(runRow.record_json).not.toContain(secret);
    expect(effectRow.evidence_json).not.toContain(secret);
    rawRun.close();
    rawEffect.close();
    outputs.close();
    executor.close();
    authorizer.close();
    store.close();
  });

  it("blocks fixture or credential-bearing source evidence before a production claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const store = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    grantLoopEnvelope(authorizer, definition, "production-fixture-source", "apply-fixture", [
      "local.write",
    ]);
    grantLoopEnvelope(authorizer, definition, "production-secret-source", "apply-secret", [
      "local.write",
    ]);
    let applied = 0;
    const executor = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => {
          applied += 1;
          return { state: "applied", evidence: localEvidence("verified", "source_safe") };
        },
        readBack: () => ({
          state: "unknown",
          evidence: localEvidence("accepted_unverified", "source_unknown"),
        }),
      },
    });
    const fixtureRequest = {
      ...input(definition, "production-fixture-source"),
      authorizationEnvelopeId: "apply-fixture",
      authorizedEffects: [],
    };
    const fixtureRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: fixtureRequest,
      runs: store,
      effects: executor,
      authorizations: authorizer,
      outputName: "fixture-source-outputs.sqlite",
    });
    await expect(
      fixtureRuntime.runtime.run({
        loopId: definition.id,
        tenant,
        runId: fixtureRequest.runId,
        authorizationEnvelopeId: "apply-fixture",
      }),
    ).rejects.toThrow(/cannot use fixture provenance/);

    const secret = "whsec_source_evidence_AuditBoundary123456";
    const secretRequest = productionInput(
      definition,
      "production-secret-source",
      undefined,
      "apply-secret",
    );
    const secretIterations = secretRequest.iterations.map((iteration) => ({
      ...iteration,
      sources: iteration.sources.map((source) => ({
        ...source,
        evidenceRefs: [`provider://loop/${secret}`],
      })),
    }));
    const secretRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: { ...secretRequest, iterations: secretIterations },
      runs: store,
      effects: executor,
      authorizations: authorizer,
      outputName: "secret-source-outputs.sqlite",
    });
    await expect(
      secretRuntime.runtime.run({
        loopId: definition.id,
        tenant,
        runId: secretRequest.runId,
        authorizationEnvelopeId: "apply-secret",
      }),
    ).rejects.toThrow(/credential-like material/);
    expect(store.load(tenant, "production-fixture-source")).toBeNull();
    expect(store.load(tenant, "production-secret-source")).toBeNull();
    expect(applied).toBe(0);
    fixtureRuntime.outputs.close();
    secretRuntime.outputs.close();
    executor.close();
    authorizer.close();
    store.close();
  });

  it("uses the trusted execution clock for freshness and rejects reversed iterations", async () => {
    const definition = loopDefinition("winner_metric_snapshots");
    const backdated: LoopIterationInput = {
      ...freshIteration(definition),
      evaluatedAt: "2025-01-01T00:00:00.000Z",
      sources: freshIteration(definition).sources.map((source) => ({
        ...source,
        observedAt: "2025-01-01T00:00:00.000Z",
      })),
    };
    let applied = 0;
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "backdated", [backdated]),
      store: new InMemoryLoopRunStore(),
      executor: {
        ...appliedExecutor,
        apply: () => {
          applied += 1;
          return { state: "applied", evidence: fixtureEvidence("backdated_unreached") };
        },
      },
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.limitations.join(" ")).toContain("stale");
    expect(Date.parse(result.completedAt!)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(applied).toBe(0);

    const iterative = loopDefinition("inner_build");
    const later = freshIteration(iterative);
    const earlier = {
      ...later,
      evaluatedAt: "2026-08-09T11:59:58.000Z",
      sources: later.sources.map((source) => ({
        ...source,
        observedAt: "2026-08-09T11:59:58.000Z",
      })),
    };
    await expect(
      executeVentureLoop({
        definition: iterative,
        input: input(iterative, "reversed", [later, earlier]),
        store: new InMemoryLoopRunStore(),
        executor: appliedExecutor,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/strictly increasing/);
  });

  it("treats a missing decision predicate as insufficient evidence", async () => {
    const definition = loopDefinition("weekly_growth");
    const iteration = freshIteration(definition);
    const withoutDecisionMetric: LoopIterationInput = {
      ...iteration,
      sources: iteration.sources.map((source) => ({
        ...source,
        metrics: Object.fromEntries(
          Object.entries(source.metrics).filter(([metricId]) => metricId !== "sample_sufficient"),
        ),
      })),
    };
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "missing-decision", [withoutDecisionMetric]),
      store: new InMemoryLoopRunStore(),
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(result).toMatchObject({ status: "insufficient_evidence", actions: [] });
    expect(result.limitations.join(" ")).toContain("missing is not false");
  });

  it("rejects extra run, trigger, and undeclared metric fields before claim", async () => {
    const definition = loopDefinition("weekly_growth");
    const store = new InMemoryLoopRunStore();
    await expect(
      executeVentureLoop({
        definition,
        input: {
          ...input(definition, "extra-run-field"),
          customerEmail: "private-run@example.com",
        } as never,
        store,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/loop run input contains unclassified fields/);
    await expect(
      executeVentureLoop({
        definition,
        input: {
          ...input(definition, "extra-trigger-field"),
          trigger: { ...definition.trigger, rawMessage: "private trigger content" },
        } as never,
        store,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/loop run trigger contains unclassified fields/);
    const iteration = freshIteration(definition);
    const withUndeclaredMetric: LoopIterationInput = {
      ...iteration,
      sources: iteration.sources.map((source, index) =>
        index === 0
          ? { ...source, metrics: { ...source.metrics, fabricated_conversion_rate: 1 } }
          : source,
      ),
    };
    await expect(
      executeVentureLoop({
        definition,
        input: input(definition, "extra-metric", [withUndeclaredMetric]),
        store,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/is not declared by the immutable definition/);
    expect(store.load(tenant, "extra-run-field")).toBeNull();
    expect(store.load(tenant, "extra-trigger-field")).toBeNull();
    expect(store.load(tenant, "extra-metric")).toBeNull();
  });

  it("stops unresolved when provider read-back never satisfies its completion predicate", async () => {
    const definition = loopDefinition("provider_verification");
    const iteration = freshIteration(definition);
    const noVerifiedOutcome: LoopIterationInput = {
      ...iteration,
      sources: iteration.sources.map((source) => ({
        ...source,
        metrics: {
          ...source.metrics,
          matched: 0,
          confirmed_absent: 0,
          unknown: 0,
        },
      })),
    };
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "provider-no-match", [noVerifiedOutcome]),
      store: new InMemoryLoopRunStore(),
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(result).toMatchObject({
      status: "stopped",
      stopReason: "completion_unsatisfied",
      actions: [],
      evaluations: [expect.objectContaining({ completionSatisfied: false })],
    });
  });

  it("rechecks freshness immediately after authorization before any effect", async () => {
    const definition = loopDefinition("winner_metric_snapshots");
    let currentMs = Date.parse(evaluatedAt);
    let applied = 0;
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "freshness-after-auth"),
      store: new InMemoryLoopRunStore(),
      executor: {
        ...appliedExecutor,
        apply: () => {
          applied += 1;
          return { state: "applied", evidence: fixtureEvidence("stale_unreached") };
        },
      },
      authorizer: {
        authorize: () => {
          currentMs += 3_601_000;
          return true;
        },
      },
      executionMode: "fixture",
      now: () => new Date(currentMs),
    });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.limitations.join(" ")).toContain("stale");
    expect(applied).toBe(0);
  });

  it("requires explicit, well-formed source provenance", async () => {
    const definition = loopDefinition("weekly_growth");
    const malformed = freshIteration(definition);
    await expect(
      executeVentureLoop({
        definition,
        input: input(definition, "missing-provenance", [
          {
            ...malformed,
            sources: malformed.sources.map((source) => ({
              sourceId: source.sourceId,
              observedAt: source.observedAt,
              metrics: source.metrics,
              evidenceRefs: source.evidenceRefs,
            })),
          } as unknown as LoopIterationInput,
        ]),
        store: new InMemoryLoopRunStore(),
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/explicit provenance|unclassified fields/);
  });

  it("retries the same action only after a crashed attempt is fenced as no-effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "loops.sqlite");
    const definition = loopDefinition("winner_metric_snapshots");
    const request = input(definition, "pre-write-crash");
    const firstStore = new SqliteLoopRunStore(path, loopStoreOptions);
    await expect(
      executeVentureLoop({
        definition,
        input: request,
        store: firstStore,
        executor: {
          durability: "durable_apply_once",
          apply: () => {
            throw new Error("confirmed crash before transport");
          },
          reconcile: () => ({
            state: "unknown",
            evidence: providerEvidence("accepted_unverified", "prewrite_unknown"),
          }),
        },
        authorizer: activeEnvelope,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
        leaseMilliseconds: 1_000,
      }),
    ).rejects.toThrow(/crash before transport/);
    const originalIdempotencyKey = firstStore.load(tenant, "pre-write-crash")?.actions[0]
      ?.idempotencyKey;
    firstStore.close();

    let retried = 0;
    const secondStore = new SqliteLoopRunStore(path, loopStoreOptions);
    const recovered = await executeVentureLoop({
      definition,
      input: request,
      store: secondStore,
      executor: {
        durability: "durable_apply_once",
        apply: () => {
          retried += 1;
          return { state: "applied", evidence: providerEvidence("verified", "prewrite_retry") };
        },
        reconcile: () => ({
          state: "confirmed_no_effect",
          attemptFenced: true,
          evidence: providerEvidence("confirmed_absent", "prewrite_absent"),
        }),
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date("2026-08-09T12:00:02.000Z"),
      leaseMilliseconds: 1_000,
    });
    expect(recovered).toMatchObject({
      status: "completed",
      actions: [expect.objectContaining({ state: "applied" })],
    });
    expect(recovered.actions[0]!.idempotencyKey).toBe(originalIdempotencyKey);
    expect(retried).toBe(1);
    secondStore.close();
  });

  it("cannot terminalize absence while an expired-lease apply may still complete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "loops.sqlite");
    const definition = loopDefinition("winner_metric_snapshots");
    const request = input(definition, "fenced-race");
    const firstStore = new SqliteLoopRunStore(path, loopStoreOptions);
    const secondStore = new SqliteLoopRunStore(path, loopStoreOptions);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredApply = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let externalApplied = false;
    const firstPromise = executeVentureLoop({
      definition,
      input: request,
      store: firstStore,
      executor: {
        durability: "durable_apply_once",
        apply: async () => {
          entered();
          await blocked;
          externalApplied = true;
          return { state: "applied", evidence: providerEvidence("verified", "fenced_first") };
        },
        reconcile: () => ({
          state: "unknown",
          evidence: providerEvidence("accepted_unverified", "fenced_first_unknown"),
        }),
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
      leaseMilliseconds: 1_000,
    });
    await enteredApply;
    const takeover = await executeVentureLoop({
      definition,
      input: request,
      store: secondStore,
      executor: {
        durability: "durable_apply_once",
        apply: () => {
          throw new Error("takeover must not apply before fencing");
        },
        reconcile: () =>
          ({
            state: "confirmed_no_effect",
            evidence: providerEvidence("confirmed_absent", "unfenced_absent"),
          }) as unknown as LoopEffectReconciliation,
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date("2026-08-09T12:00:02.000Z"),
      leaseMilliseconds: 1_000,
    });
    expect(takeover).toMatchObject({
      status: "waiting_for_reconciliation",
      actions: [expect.objectContaining({ state: "unknown" })],
    });
    release();
    await expect(firstPromise).rejects.toThrow(/lease is not held/);
    expect(externalApplied).toBe(true);
    expect(secondStore.load(tenant, "fenced-race")).toMatchObject({
      status: "waiting_for_reconciliation",
      actions: [expect.objectContaining({ state: "unknown" })],
    });
    firstStore.close();
    secondStore.close();
  });

  it("refuses credential or private-user material in durable evidence", async () => {
    const definition = loopDefinition("winner_metric_snapshots");
    const store = new InMemoryLoopRunStore();
    await expect(
      executeVentureLoop({
        definition,
        input: input(definition, "unsafe-effect-evidence"),
        store,
        executor: {
          durability: "fixture_only",
          apply: () => ({
            state: "applied",
            evidence: {
              ...fixtureEvidence("unsafe_evidence"),
              customerEmail: "private@example.com",
              stripeSecretKey: "whsec_secondary_abcdefghijklmnopqrstuvwxyz",
            } as unknown as LoopEffectEvidence,
          }),
          reconcile: () => ({ state: "unknown", evidence: fixtureEvidence("unsafe_unknown") }),
        },
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/unclassified field|credential-like/);
    expect(store.load(tenant, "unsafe-effect-evidence")?.actions[0]).toMatchObject({
      state: "prepared",
      evidence: null,
    });
  });

  it("fails closed when a valid-looking durable state is tampered", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "loops.sqlite");
    const definition = loopDefinition("weekly_growth");
    const store = new SqliteLoopRunStore(path, loopStoreOptions);
    await executeVentureLoop({
      definition,
      input: input(definition, "tampered-row"),
      store,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    store.close();

    interface RawDatabase {
      prepare(sql: string): {
        get(...values: unknown[]): unknown;
        run(...values: unknown[]): unknown;
      };
      close(): void;
    }
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => RawDatabase;
    };
    const raw = new DatabaseSync(path);
    const row = raw
      .prepare("SELECT record_json FROM loop_runs WHERE run_id = ?")
      .get("tampered-row") as { record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    raw.prepare("UPDATE loop_runs SET record_json = ? WHERE run_id = ?").run(
      JSON.stringify({
        ...record,
        status: "stopped",
        stopReason: "maximum_actions",
      }),
      "tampered-row",
    );
    raw.close();

    const reopened = new SqliteLoopRunStore(path, loopStoreOptions);
    expect(() => reopened.load(tenant, "tampered-row")).toThrow(/integrity binding/);
    reopened.close();
  });

  it("rejects integrity-valid durable records with unclassified fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "exact-record.sqlite");
    const definition = loopDefinition("weekly_growth");
    const runId = "exact-record";
    const store = new SqliteLoopRunStore(path, loopStoreOptions);
    await executeVentureLoop({
      definition,
      input: input(definition, runId),
      store,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    store.close();

    interface RawDatabase {
      prepare(sql: string): {
        get(...values: unknown[]): unknown;
        run(...values: unknown[]): unknown;
      };
      close(): void;
    }
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => RawDatabase;
    };
    const raw = new DatabaseSync(path);
    const row = raw
      .prepare(
        `SELECT loop_id, definition_hash, input_hash, owner_token, lease_expires_at, record_json
         FROM loop_runs WHERE run_id = ?`,
      )
      .get(runId) as {
      loop_id: string;
      definition_hash: string;
      input_hash: string;
      owner_token: string;
      lease_expires_at: string;
      record_json: string;
    };
    const privateEmail = "private-record@example.com";
    const unsafeRecordJson = JSON.stringify({
      ...(JSON.parse(row.record_json) as Record<string, unknown>),
      customerEmail: privateEmail,
    });
    const recordHmac = createHmac("sha256", loopStoreOptions.integrityKey)
      .update(
        JSON.stringify([
          `${tenant.organizationId}:${tenant.ventureId}`,
          runId,
          row.loop_id,
          row.definition_hash,
          row.input_hash,
          row.owner_token,
          row.lease_expires_at,
          unsafeRecordJson,
        ]),
      )
      .digest("hex");
    raw
      .prepare("UPDATE loop_runs SET record_json = ?, record_hmac = ? WHERE run_id = ?")
      .run(unsafeRecordJson, recordHmac, runId);
    raw.close();
    const reopened = new SqliteLoopRunStore(path, loopStoreOptions);
    expect(() => reopened.load(tenant, runId)).toThrow(/unclassified fields/);
    reopened.close();
  });

  it("never lets a late unknown writer regress a terminal provider read-back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "effects.sqlite");
    const definition = loopDefinition("winner_metric_snapshots");
    const request = directEffectRequest(definition, "late-effect-writer");
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    grantLoopEnvelope(authorizer, definition, request.runId, "apply-envelope", ["local.write"]);
    grantLoopEnvelope(
      authorizer,
      definition,
      request.runId,
      "late-reconcile-envelope",
      ["loop.reconcile"],
      "2026-08-09T11:59:00.000Z",
      "2026-08-09T12:04:00.000Z",
      {
        purpose: "reconcile",
        targetIdempotencyKey: request.idempotencyKey,
        targetAttemptToken: request.attemptToken,
      },
    );
    let markStarted!: () => void;
    let releaseApply!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const first = new SqliteLoopEffectExecutor(path, {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: async () => {
          markStarted();
          await release;
          return {
            state: "unknown",
            evidence: localEvidence("accepted_unverified", "late_unknown"),
          };
        },
        readBack: () => {
          throw new Error("the in-flight owner must not reconcile");
        },
      },
    });
    let readBacks = 0;
    const second = new SqliteLoopEffectExecutor(path, {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => {
          throw new Error("the reconciler must not apply");
        },
        readBack: () => {
          readBacks += 1;
          return { state: "applied", evidence: localEvidence("verified", "terminal_readback") };
        },
      },
    });
    const latePromise = first.apply(request);
    await started;
    const reconciled = await second.reconcile(request, "late-reconcile-envelope");
    releaseApply();
    const late = await latePromise;
    const replay = await second.reconcile(request, "late-reconcile-envelope");
    expect(reconciled.state).toBe("applied");
    expect(late.state).toBe("applied");
    expect(replay.state).toBe("applied");
    expect(readBacks).toBe(1);
    first.close();
    second.close();
    authorizer.close();
  });

  it("rejects cached connected evidence with a foreign tenant or account before claiming a run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("weekly_growth");
    const runs = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const authorizations = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    const sources = new ConnectedLoopSourceFetcher(
      {
        fetch: (request) => {
          const wrongTenant = request.runId === "foreign-tenant-source";
          const iterations = productionInput(definition, request.runId).iterations.map(
            (iteration) => ({
              ...iteration,
              sources: iteration.sources.map((source) => ({
                ...source,
                provenance:
                  source.provenance.kind === "connected_provider"
                    ? {
                        ...source.provenance,
                        tenant: wrongTenant
                          ? { organizationId: "org-foreign", ventureId: tenant.ventureId }
                          : tenant,
                        externalAccountId: wrongTenant ? "account-loop" : "account-foreign",
                      }
                    : source.provenance,
              })),
            }),
          );
          return {
            schemaVersion: 1,
            tenant,
            runId: request.runId,
            loopId: definition.id,
            fetchedAt: evaluatedAt,
            iterations,
          };
        },
      },
      {
        bindings: definition.inputSources.map(({ id }) => ({
          sourceId: id,
          tenant,
          providerId: "fixture-transport",
          connectionId: "connection-loop",
          externalAccountId: "account-loop",
          propertyId: "property-loop",
        })),
        now: () => new Date(evaluatedAt),
      },
    );
    const outputs = new SqliteLoopOutputStore(join(directory, "outputs.sqlite"), loopStoreOptions);
    const runtime = new ProductionLoopRuntime({
      runs,
      authorizations,
      sources,
      outputs,
      now: () => new Date(evaluatedAt),
    });
    await expect(
      runtime.run({ loopId: definition.id, tenant, runId: "foreign-tenant-source" }),
    ).rejects.toThrow(/different tenant/);
    await expect(
      runtime.run({ loopId: definition.id, tenant, runId: "foreign-account-source" }),
    ).rejects.toThrow(/trusted account read-back binding/);
    expect(runs.load(tenant, "foreign-tenant-source")).toBeNull();
    expect(runs.load(tenant, "foreign-account-source")).toBeNull();
    outputs.close();
    authorizations.close();
    runs.close();
  });

  it("makes caller-mutated production definitions unreachable from the public runner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const canonical = loopDefinition("winner_metric_snapshots");
    const store = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const mutations: VentureLoopDefinition[] = [
      { ...canonical, maximumActions: canonical.maximumActions + 1 },
      {
        ...canonical,
        autonomy: "apply_within_policy",
      },
      {
        ...canonical,
        output: { ...canonical.output, destination: "reports/loops/forged" },
      },
      {
        ...canonical,
        decisionRules: canonical.decisionRules.map((rule) => ({
          ...rule,
          when: rule.when.map((predicate) => ({
            ...predicate,
            threshold: predicate.threshold - 1,
          })),
        })),
      },
    ];
    for (const [index, definition] of mutations.entries()) {
      const runId = `mutated-definition-${index}`;
      await expect(
        executeVentureLoop({
          definition,
          input: productionInput(canonical, runId),
          store,
          executionMode: "production" as "fixture",
          now: () => new Date(evaluatedAt),
        }),
      ).rejects.toThrow(/raw production loop execution is forbidden/);
      expect(store.load(tenant, runId)).toBeNull();
    }
    store.close();
  });

  it("requires short one-use reconciliation authority bound to the exact attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    const request = directEffectRequest(definition, "reconcile-authority", "attempt-bound");
    expect(() =>
      grantLoopEnvelope(
        authorizer,
        definition,
        request.runId,
        "mixed-reconcile",
        ["loop.reconcile", "local.write"],
        "2026-08-09T11:59:00.000Z",
        "2026-08-09T12:04:00.000Z",
        {
          purpose: "reconcile",
          targetIdempotencyKey: request.idempotencyKey,
          targetAttemptToken: request.attemptToken,
        },
      ),
    ).toThrow(/read-back only/);
    expect(() =>
      grantLoopEnvelope(
        authorizer,
        definition,
        request.runId,
        "stale-reconcile",
        ["loop.reconcile"],
        "2026-08-09T00:00:00.000Z",
        "2026-08-09T13:00:00.000Z",
        {
          purpose: "reconcile",
          targetIdempotencyKey: request.idempotencyKey,
          targetAttemptToken: request.attemptToken,
        },
      ),
    ).toThrow(/five minutes/);
    grantLoopEnvelope(
      authorizer,
      definition,
      request.runId,
      "wrong-target-reconcile",
      ["loop.reconcile"],
      "2026-08-09T11:59:00.000Z",
      "2026-08-09T12:04:00.000Z",
      {
        purpose: "reconcile",
        targetIdempotencyKey: "e".repeat(64),
        targetAttemptToken: request.attemptToken,
      },
    );
    expect(authorizer.authorizeReconciliation(request, "wrong-target-reconcile")).toBe(false);
    grantLoopEnvelope(
      authorizer,
      definition,
      request.runId,
      "exact-reconcile",
      ["loop.reconcile"],
      "2026-08-09T11:59:00.000Z",
      "2026-08-09T12:04:00.000Z",
      {
        purpose: "reconcile",
        targetIdempotencyKey: request.idempotencyKey,
        targetAttemptToken: request.attemptToken,
      },
    );
    expect(authorizer.authorizeReconciliation(request, "exact-reconcile")).toBe(true);
    expect(authorizer.authorizeReconciliation(request, "exact-reconcile")).toBe(false);
    authorizer.close();
  });

  it("enforces apply and one-use reconciliation authority inside the concrete executor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const request = directEffectRequest(definition, "direct-authority-boundary");
    const effectPath = join(directory, "effects.sqlite");
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    let applies = 0;
    let readBacks = 0;
    const executor = new SqliteLoopEffectExecutor(effectPath, {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => {
          applies += 1;
          return {
            state: "unknown",
            evidence: localEvidence("accepted_unverified", "direct_apply_unknown"),
          };
        },
        readBack: () => {
          readBacks += 1;
          return {
            state: "applied",
            evidence: localEvidence("verified", "direct_apply_reconciled"),
          };
        },
      },
    });
    await expect(executor.apply(request)).rejects.toThrow(/authoritative.*authorization/i);
    expect(applies).toBe(0);

    interface RawDatabase {
      prepare(sql: string): { get(...values: unknown[]): unknown };
      close(): void;
    }
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => RawDatabase;
    };
    const raw = new DatabaseSync(effectPath);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM loop_effect_operations").get()).toMatchObject(
      { count: 0 },
    );
    raw.close();

    grantLoopEnvelope(authorizer, definition, request.runId, "apply-envelope", ["local.write"]);
    await expect(executor.apply(request)).resolves.toMatchObject({ state: "unknown" });
    await expect(executor.reconcile(request)).rejects.toThrow(/read-back-only authorization/);
    expect(readBacks).toBe(0);
    grantLoopEnvelope(
      authorizer,
      definition,
      request.runId,
      "direct-reconcile-envelope",
      ["loop.reconcile"],
      "2026-08-09T11:59:00.000Z",
      "2026-08-09T12:04:00.000Z",
      {
        purpose: "reconcile",
        targetIdempotencyKey: request.idempotencyKey,
        targetAttemptToken: request.attemptToken,
      },
    );
    await expect(executor.reconcile(request, "direct-reconcile-envelope")).resolves.toMatchObject({
      state: "applied",
    });
    expect(readBacks).toBe(1);
    expect(authorizer.authorizeReconciliation(request, "direct-reconcile-envelope")).toBe(false);
    executor.close();
    authorizer.close();
  });

  it("rechecks concrete apply authority immediately before transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const request = directEffectRequest(definition, "authority-expired-before-transport");
    let authorityChecks = 0;
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(authorityChecks++ === 0 ? evaluatedAt : "2026-08-09T12:00:02.000Z"),
    });
    grantLoopEnvelope(
      authorizer,
      definition,
      request.runId,
      "apply-envelope",
      ["local.write"],
      "2026-08-09T11:59:00.000Z",
      "2026-08-09T12:00:01.000Z",
    );
    let transports = 0;
    const executor = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => {
          transports += 1;
          return { state: "applied", evidence: localEvidence("verified", "unreached") };
        },
        readBack: () => ({
          state: "unknown",
          evidence: localEvidence("accepted_unverified", "unreached"),
        }),
      },
    });
    await expect(executor.apply(request)).rejects.toThrow(/expired before transport/);
    expect(transports).toBe(0);
    executor.close();
    authorizer.close();
  });

  it("rejects credential-shaped authorization and effect identifiers before SQLite writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const authPath = join(directory, "auth.sqlite");
    const effectPath = join(directory, "effects.sqlite");
    const definition = loopDefinition("winner_metric_snapshots");
    const secret = "whsec_secondary_auditboundary123456";
    const authorizer = new SqliteLoopAuthorizationStore(authPath, {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    expect(() =>
      grantLoopEnvelope(authorizer, definition, "safe-run", secret, ["local.write"]),
    ).toThrow(/credential-like material/);
    const executor = new SqliteLoopEffectExecutor(effectPath, {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => ({ state: "applied", evidence: localEvidence("verified", "unreached") }),
        readBack: () => ({
          state: "unknown",
          evidence: localEvidence("accepted_unverified", "unreached"),
        }),
      },
    });
    await expect(
      executor.apply(directEffectRequest(definition, "safe-run", secret)),
    ).rejects.toThrow(/credential-like material/);
    expect(readFileSync(authPath).toString("latin1")).not.toContain(secret);
    expect(readFileSync(effectPath).toString("latin1")).not.toContain(secret);
    executor.close();
    authorizer.close();
  });

  it("rejects unclassified authorization fields before write and on integrity-valid raw read", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const runId = "exact-envelope-run";
    const envelopeId = "exact-envelope";
    const privateEmail = "private-envelope@example.com";
    const authPath = join(directory, "auth.sqlite");
    const authorizer = new SqliteLoopAuthorizationStore(authPath, {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    const envelope = {
      schemaVersion: 2 as const,
      tenant,
      envelopeId,
      runId,
      loopId: definition.id,
      definitionHash: loopDefinitionHash(definition.id),
      purpose: "apply" as const,
      allowedEffects: ["local.write"],
      issuedAt: "2026-08-09T11:59:00.000Z",
      notBefore: "2026-08-09T11:59:00.000Z",
      expiresAt: "2026-08-09T13:00:00.000Z",
      revokedAt: null,
      targetIdempotencyKey: null,
      targetAttemptToken: null,
    };
    expect(() => authorizer.grant({ ...envelope, customerEmail: privateEmail } as never)).toThrow(
      /unclassified fields/,
    );
    expect(readFileSync(authPath).toString("latin1")).not.toContain(privateEmail);
    authorizer.grant(envelope);

    interface RawDatabase {
      prepare(sql: string): {
        get(...values: unknown[]): unknown;
        run(...values: unknown[]): unknown;
      };
      close(): void;
    }
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => RawDatabase;
    };
    const raw = new DatabaseSync(authPath);
    const row = raw
      .prepare("SELECT envelope_json FROM loop_authorizations WHERE envelope_id = ?")
      .get(envelopeId) as { envelope_json: string };
    const unsafeEnvelopeJson = JSON.stringify({
      ...(JSON.parse(row.envelope_json) as Record<string, unknown>),
      customerEmail: privateEmail,
    });
    const envelopeHmac = createHmac("sha256", loopStoreOptions.integrityKey)
      .update(
        JSON.stringify([
          `${tenant.organizationId}:${tenant.ventureId}`,
          envelopeId,
          unsafeEnvelopeJson,
        ]),
      )
      .digest("hex");
    raw
      .prepare(
        "UPDATE loop_authorizations SET envelope_json = ?, envelope_hmac = ? WHERE envelope_id = ?",
      )
      .run(unsafeEnvelopeJson, envelopeHmac, envelopeId);
    raw.close();
    const request = {
      ...directEffectRequest(definition, runId),
      authorizationEnvelopeId: envelopeId,
    };
    expect(() => authorizer.authorize(request)).toThrow(/unclassified fields/);
    authorizer.close();
  });

  it("binds every direct effect request to the canonical rule, effect, iteration, and key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const request = directEffectRequest(definition, "bound-direct-effect");
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    expect(() =>
      grantLoopEnvelope(authorizer, definition, request.runId, "forged-envelope", [
        "provider.write",
      ]),
    ).toThrow(/outside the immutable catalog/);
    grantLoopEnvelope(authorizer, definition, request.runId, "apply-envelope", ["local.write"]);
    let transports = 0;
    const executor = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => {
          transports += 1;
          return { state: "applied", evidence: localEvidence("verified", "bound_effect") };
        },
        readBack: () => ({
          state: "unknown",
          evidence: localEvidence("accepted_unverified", "bound_effect_unknown"),
        }),
      },
    });
    const alternateKey = `${request.idempotencyKey[0] === "a" ? "b" : "a"}${request.idempotencyKey.slice(1)}`;
    const forgedRequests: LoopEffectRequest[] = [
      {
        ...request,
        action: { ...request.action, effect: "provider.write" },
      },
      {
        ...request,
        action: { ...request.action, title: "A forged but plausible action" },
      },
      { ...request, ruleId: "forged_rule" },
      { ...request, idempotencyKey: alternateKey },
      { ...request, iteration: definition.maximumIterations + 1 },
    ];
    for (const forged of forgedRequests) {
      expect(() => authorizer.authorize(forged)).toThrow(
        /immutable catalog|canonically bound|iteration is outside/,
      );
      await expect(executor.apply(forged)).rejects.toThrow(
        /immutable catalog|canonically bound|iteration is outside/,
      );
    }
    expect(authorizer.authorize(request)).toBe(true);
    expect(transports).toBe(0);
    executor.close();
    authorizer.close();
  });

  it("rejects private or unclassified connected-source fields before durable claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.sqlite");
    const definition = loopDefinition("weekly_growth");
    const store = new SqliteLoopRunStore(path, loopStoreOptions);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    const privateEmail = "private.person@example.com";
    const base = productionInput(definition, "private-source");
    const extraFields = base.iterations.map((iteration) => ({
      ...iteration,
      customerEmail: privateEmail,
      sources: iteration.sources.map((source) => ({
        ...source,
        rawMessage: "private support content",
      })),
    })) as unknown as readonly LoopIterationInput[];
    const privateRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: { ...base, iterations: extraFields },
      runs: store,
      authorizations: authorizer,
      outputName: "private-outputs.sqlite",
    });
    await expect(
      privateRuntime.runtime.run({ loopId: definition.id, tenant, runId: base.runId }),
    ).rejects.toThrow(/unclassified fields/);

    const qualityInput = productionInput(definition, "private-quality");
    const privateQuality = qualityInput.iterations.map((iteration) => ({
      ...iteration,
      sources: iteration.sources.map((source) => ({
        ...source,
        provenance:
          source.provenance.kind === "connected_provider"
            ? {
                ...source.provenance,
                quality: {
                  status: "partial" as const,
                  limitations: [`customer_${privateEmail}_unavailable`],
                },
              }
            : source.provenance,
      })),
    }));
    const qualityRuntime = productionRuntimeFromInput({
      directory,
      definition,
      input: { ...qualityInput, iterations: privateQuality },
      runs: store,
      authorizations: authorizer,
      outputName: "private-quality-outputs.sqlite",
    });
    await expect(
      qualityRuntime.runtime.run({
        loopId: definition.id,
        tenant,
        runId: qualityInput.runId,
      }),
    ).rejects.toThrow(/canonical identifier/);
    expect(store.load(tenant, "private-source")).toBeNull();
    expect(store.load(tenant, "private-quality")).toBeNull();
    const raw = readFileSync(path).toString("latin1");
    expect(raw).not.toContain(privateEmail);
    expect(raw).not.toContain("private support content");
    privateRuntime.outputs.close();
    qualityRuntime.outputs.close();
    authorizer.close();
    store.close();
  });

  it("rejects credential material in fixture definitions before durable claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.sqlite");
    const canonical = loopDefinition("weekly_growth");
    const secret = "whsec_secondary_runtimeaction123456";
    const definition: VentureLoopDefinition = {
      ...canonical,
      decisionRules: canonical.decisionRules.map((rule) => ({
        ...rule,
        action: { ...rule.action, title: secret },
      })),
    };
    const store = new SqliteLoopRunStore(path, loopStoreOptions);
    await expect(
      executeVentureLoop({
        definition,
        input: input(canonical, "unsafe-fixture-definition"),
        store,
        executionMode: "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/credential-like material/);
    expect(store.load(tenant, "unsafe-fixture-definition")).toBeNull();
    expect(readFileSync(path).toString("latin1")).not.toContain(secret);
    store.close();
  });

  it("does not let a durability claim reopen the raw production path", async () => {
    const definition = loopDefinition("weekly_growth");
    const memory = new InMemoryLoopRunStore();
    const lyingStore = {
      durability: "durable_atomic" as const,
      claim: memory.claim.bind(memory),
      save: memory.save.bind(memory),
      load: memory.load.bind(memory),
    };
    await expect(
      executeVentureLoop({
        definition,
        input: productionInput(definition, "lying-run-store"),
        store: lyingStore,
        executionMode: "production" as "fixture",
        now: () => new Date(evaluatedAt),
      }),
    ).rejects.toThrow(/raw production loop execution is forbidden/);
    expect(memory.load(tenant, "lying-run-store")).toBeNull();
  });

  it("does not report effectful completion when durable execution confirms no effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("winner_metric_snapshots");
    const runId = "confirmed-no-snapshot";
    const store = new SqliteLoopRunStore(join(directory, "runs.sqlite"), loopStoreOptions);
    const authorizer = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    grantLoopEnvelope(authorizer, definition, runId, "apply-envelope", ["local.write"]);
    const executor = new SqliteLoopEffectExecutor(join(directory, "effects.sqlite"), {
      ...loopStoreOptions,
      authorizer,
      now: () => new Date(evaluatedAt),
      transport: {
        apply: () => ({
          state: "confirmed_no_effect",
          evidence: localEvidence("confirmed_absent", "snapshot_not_written"),
        }),
        readBack: () => ({
          state: "confirmed_no_effect",
          attemptFenced: true,
          evidence: localEvidence("confirmed_absent", "snapshot_still_absent"),
        }),
      },
    });
    const production = productionInput(definition, runId);
    const { runtime, outputs } = productionRuntimeFromInput({
      directory,
      definition,
      input: production,
      runs: store,
      effects: executor,
      authorizations: authorizer,
      now: () => new Date(evaluatedAt),
    });
    const result = await runtime.run({
      loopId: definition.id,
      tenant,
      runId,
      authorizationEnvelopeId: "apply-envelope",
    });
    expect(result).toMatchObject({
      status: "stopped",
      stopReason: "completion_unsatisfied",
      actions: [expect.objectContaining({ state: "confirmed_no_effect" })],
    });
    outputs.close();
    executor.close();
    authorizer.close();
    store.close();
  });

  it("does not report completion after unknown recovery and a fenced no-effect retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runs.sqlite");
    const definition = loopDefinition("winner_metric_snapshots");
    const request = input(definition, "recovered-no-snapshot");
    const firstStore = new SqliteLoopRunStore(path, loopStoreOptions);
    const first = await executeVentureLoop({
      definition,
      input: request,
      store: firstStore,
      executor: {
        durability: "durable_apply_once",
        apply: () => ({
          state: "unknown",
          evidence: providerEvidence("accepted_unverified", "snapshot_unknown"),
        }),
        reconcile: () => {
          throw new Error("the first owner must not reconcile");
        },
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
      leaseMilliseconds: 1_000,
    });
    expect(first.status).toBe("waiting_for_reconciliation");
    firstStore.close();

    const secondStore = new SqliteLoopRunStore(path, loopStoreOptions);
    const recovered = await executeVentureLoop({
      definition,
      input: request,
      store: secondStore,
      executor: {
        durability: "durable_apply_once",
        apply: () => ({
          state: "confirmed_no_effect",
          evidence: providerEvidence("confirmed_absent", "snapshot_retry_absent"),
        }),
        reconcile: () => ({
          state: "confirmed_no_effect",
          attemptFenced: true,
          evidence: providerEvidence("confirmed_absent", "snapshot_original_absent"),
        }),
      },
      authorizer: activeEnvelope,
      executionMode: "fixture",
      now: () => new Date("2026-08-09T12:00:02.000Z"),
      leaseMilliseconds: 1_000,
    });
    expect(recovered).toMatchObject({
      status: "stopped",
      stopReason: "completion_unsatisfied",
      actions: [expect.objectContaining({ state: "confirmed_no_effect" })],
    });
    secondStore.close();
  });

  it("never proposes a verified launch checkpoint before required nodes verify", async () => {
    const definition = loopDefinition("launch");
    expect(definition.completion.when.map(({ metricId }) => metricId)).toEqual(
      expect.arrayContaining([
        "passed_checks",
        "required_nodes_total",
        "required_nodes_remaining",
        "exact_release_mismatches",
      ]),
    );
    const complete = freshIteration(definition);
    const incomplete: LoopIterationInput = {
      ...complete,
      sources: complete.sources.map((source) => ({
        ...source,
        metrics: {
          ...source.metrics,
          ...(source.sourceId === "launch_graph"
            ? {
                required_nodes_total: 3,
                required_nodes_remaining: 1,
                exact_release_mismatches: 0,
              }
            : {}),
          ...(source.sourceId === "quality_gate" ? { failed_checks: 0, passed_checks: 10 } : {}),
        },
      })),
    };
    const blocked = await executeVentureLoop({
      definition,
      input: input(definition, "launch-zero-nodes", [incomplete]),
      store: new InMemoryLoopRunStore(),
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    const verified = await executeVentureLoop({
      definition,
      input: input(definition, "launch-verified-nodes", [complete]),
      store: new InMemoryLoopRunStore(),
      executionMode: "fixture",
      now: () => new Date(evaluatedAt),
    });
    expect(blocked).toMatchObject({
      status: "stopped",
      stopReason: "completion_unsatisfied",
      actions: [],
    });
    expect(verified).toMatchObject({
      status: "completed",
      actions: [
        expect.objectContaining({
          ruleId: "propose_launch",
          state: "proposed",
          proposalArtifact: expect.objectContaining({
            schemaVersion: 1,
            kind: "proposal",
            decisionSurface: "launch",
            evidenceRefs: expect.arrayContaining([expect.stringMatching(/^fixture:\/\//u)]),
          }),
        }),
      ],
    });
  });

  it("persists an evidence-bound typed proposal in both the run and local output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-loop-runtime-"));
    temporaryDirectories.push(directory);
    const definition = loopDefinition("launch");
    const runId = "durable-launch-proposal";
    const runPath = join(directory, "runs.sqlite");
    const runs = new SqliteLoopRunStore(runPath, loopStoreOptions);
    const authorizations = new SqliteLoopAuthorizationStore(join(directory, "auth.sqlite"), {
      ...loopStoreOptions,
      now: () => new Date(evaluatedAt),
    });
    const production = productionInput(definition, runId);
    const { runtime, outputs } = productionRuntimeFromInput({
      directory,
      definition,
      input: production,
      runs,
      authorizations,
    });
    const result = await runtime.run({ loopId: definition.id, tenant, runId });
    const artifact = result.actions[0]?.proposalArtifact;
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      kind: "proposal",
      loopId: definition.id,
      runId,
      ruleId: "propose_launch",
      decisionSurface: "launch",
      evidenceRefs: expect.arrayContaining([expect.stringMatching(/^provider:\/\//u)]),
    });
    expect(outputs.load(tenant, runId)?.proposalArtifacts).toEqual([artifact]);
    outputs.close();
    authorizations.close();
    runs.close();

    const reopened = new SqliteLoopRunStore(runPath, loopStoreOptions);
    expect(reopened.load(tenant, runId)?.actions[0]?.proposalArtifact).toEqual(artifact);
    reopened.close();
  });

  it("completes a later Fleet read-back without repeating an already-applied action", async () => {
    const definition = loopDefinition("fleet_upgrade");
    expect(definition.completion.when.map(({ metricId }) => metricId)).toEqual(
      expect.arrayContaining([
        "selected_targets_total",
        "selected_targets_remaining",
        "exact_release_mismatches",
        "rollout_verified",
      ]),
    );
    const first = freshIteration(definition);
    const second: LoopIterationInput = {
      ...freshIteration(definition),
      evaluatedAt: "2026-08-09T12:00:01.000Z",
      sources: freshIteration(definition).sources.map((source) => ({
        ...source,
        observedAt: "2026-08-09T12:00:01.000Z",
        metrics: {
          ...source.metrics,
          ...(source.sourceId === "fleet_registry"
            ? {
                rollout_verified: 1,
                selected_targets_total: 2,
                selected_targets_remaining: 0,
                exact_release_mismatches: 0,
              }
            : {}),
        },
      })),
    };
    const firstWithoutCompletion: LoopIterationInput = {
      ...first,
      sources: first.sources.map((source) => ({
        ...source,
        metrics: {
          ...source.metrics,
          ...(source.sourceId === "fleet_registry"
            ? { rollout_verified: 0, selected_targets_remaining: 2 }
            : {}),
        },
      })),
    };
    let applies = 0;
    const result = await executeVentureLoop({
      definition,
      input: input(definition, "fleet-completion-readback", [firstWithoutCompletion, second]),
      store: new InMemoryLoopRunStore(),
      executor: {
        ...appliedExecutor,
        apply: () => {
          applies += 1;
          return { state: "applied", evidence: fixtureEvidence("fleet_pr_opened") };
        },
      },
      executionMode: "fixture",
      now: () => new Date("2026-08-09T12:00:01.000Z"),
    });
    expect(result).toMatchObject({ status: "completed", stopReason: "completed", iteration: 2 });
    expect(result.actions).toHaveLength(1);
    expect(applies).toBe(1);
  });
});
