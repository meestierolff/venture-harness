import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_WORKFLOW_NODE_STATES,
  FileWorkflowStore,
  WorkflowExecutionError,
  WorkflowExecutor,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
  workflowNode,
} from "../lib/workflow";

const temporaryDirectories: string[] = [];

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "vh-workflow-durable-"));
  temporaryDirectories.push(directory);
  const store = new FileWorkflowStore({ rootDir: join(directory, "runs") });
  return { directory, store };
}

function graph(
  nodes: WorkflowNodeDefinition[],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "durable-graph",
    name: "Durable graph",
    version: "1",
    nodes,
    maxParallel: 4,
    maxIterations: 30,
    budgets: {},
    ...overrides,
  };
}

function effectNode(overrides: Partial<WorkflowNodeDefinition> = {}) {
  return workflowNode("provision", {
    kind: "provider",
    transport: "api",
    handler: "provision",
    effect: "external_reversible",
    retry: {
      maxAttempts: 2,
      retryableCodes: ["PROVIDER_INTERRUPTED"],
      backoff: { strategy: "fixed", initialMs: 0, maxMs: 0, multiplier: 1 },
    },
    reconciliation: {
      handler: "provision",
      pollIntervalMs: 0,
      maxPollAttempts: 3,
    },
    ...overrides,
  });
}

function simulateInterruptedAttempt(
  store: FileWorkflowStore,
  executor: WorkflowExecutor,
  definition: WorkflowDefinition,
  runId: string,
  phase: "prepared" | "external_write_acknowledged" = "prepared",
) {
  const state = executor.create(definition, { runId });
  const record = state.nodes.provision;
  state.status = "running";
  record.state = "running";
  record.attempts = 1;
  record.iterationAttempts = 1;
  record.startedAt = "2026-08-09T09:00:00.000Z";
  record.operation = {
    attempt: 1,
    idempotencyKey: record.definition.idempotencyKey,
    phase,
    preparedAt: record.startedAt,
    updatedAt: record.startedAt,
    reconcileAttempts: 0,
  };
  store.save(state);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable workflow crash recovery", () => {
  it("exposes the complete durable node-state model while retaining the manual alias", () => {
    expect(DURABLE_WORKFLOW_NODE_STATES).toEqual([
      "pending",
      "ready",
      "running",
      "waiting_for_auth",
      "waiting_for_external_action",
      "waiting_for_approval",
      "waiting_for_manual_action",
      "succeeded",
      "failed_retryable",
      "failed_terminal",
      "skipped",
      "compensated",
      "cancelled",
    ]);
  });

  it("reconciles not-applied after a crash before external write, then applies once", async () => {
    const { store } = harness();
    const definition = graph([effectNode()]);
    simulateInterruptedAttempt(store, new WorkflowExecutor({ store }), definition, "before-write");
    let handlerCalls = 0;
    let reconciliationCalls = 0;
    const resumed = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          provision: () => {
            handlerCalls += 1;
            return { output: { resourceId: "resource-new" }, effectVerified: true };
          },
        },
        reconcilers: {
          provision: () => {
            reconciliationCalls += 1;
            return { status: "not_applied" };
          },
        },
      },
    }).resume(definition, "before-write");

    expect(resumed.status).toBe("succeeded");
    expect(reconciliationCalls).toBe(1);
    expect(handlerCalls).toBe(1);
    expect(resumed.nodes.provision.attempts).toBe(2);
  });

  it("uses read-back after write-before-persistence and never invokes the effect again", async () => {
    const { store } = harness();
    const definition = graph([effectNode()]);
    simulateInterruptedAttempt(
      store,
      new WorkflowExecutor({ store }),
      definition,
      "after-write",
      "external_write_acknowledged",
    );
    let handlerCalls = 0;
    const resumed = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: { provision: () => ((handlerCalls += 1), { effectVerified: true }) },
        reconcilers: {
          provision: ({ idempotencyKey }) => ({
            status: "verified",
            output: { resourceId: "resource-existing", idempotencyKey },
            evidenceArtifact: "evidence/provider-readback.json",
          }),
        },
      },
    }).resume(definition, "after-write");

    expect(resumed.status).toBe("succeeded");
    expect(handlerCalls).toBe(0);
    expect(resumed.nodes.provision.output).toEqual({
      resourceId: "resource-existing",
      idempotencyKey: "provision",
    });
    expect(resumed.verifiedEffects.provision?.nodeId).toBe("provision");
  });

  it("defaults a failed reconciliation to unknown and never retries the handler", async () => {
    const { store } = harness();
    const definition = graph([effectNode()]);
    simulateInterruptedAttempt(
      store,
      new WorkflowExecutor({ store }),
      definition,
      "failed-unknown",
    );
    let handlerCalls = 0;
    const resumed = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          provision: () => {
            handlerCalls += 1;
            return { effectVerified: true };
          },
        },
        reconcilers: {
          provision: () => ({
            status: "failed",
            code: "RECONCILIATION_BACKEND_FAILED",
            message: "read-back backend failed",
            retryable: true,
          }),
        },
      },
    }).resume(definition, "failed-unknown");

    expect(resumed.status).toBe("failed");
    expect(resumed.nodes.provision.operation?.phase).toBe("unknown");
    expect(resumed.nodes.provision.error?.code).toBe("RECONCILIATION_BACKEND_FAILED");
    expect(handlerCalls).toBe(0);
  });

  it("marks a partial reconciliation distinctly and retries only the bound handler attempt", async () => {
    const { store } = harness();
    const definition = graph([effectNode()]);
    simulateInterruptedAttempt(store, new WorkflowExecutor({ store }), definition, "partial-write");
    let handlerCalls = 0;
    const resumed = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          provision: () => {
            handlerCalls += 1;
            return { output: { resourceId: "completed-missing-operation" }, effectVerified: true };
          },
        },
        reconcilers: {
          provision: () => ({ status: "partially_applied" }),
        },
      },
    }).resume(definition, "partial-write");

    expect(resumed.status).toBe("succeeded");
    expect(resumed.nodes.provision.attempts).toBe(2);
    expect(handlerCalls).toBe(1);
  });

  it("recovers the write-ahead event on either side of the atomic checkpoint boundary", () => {
    const { store } = harness();
    const definition = graph([workflowNode("checkpoint")]);
    const executor = new WorkflowExecutor({ store });

    for (const [runId, eventAlreadyAppended] of [
      ["checkpoint-before-event", false],
      ["checkpoint-after-event", true],
    ] as const) {
      const state = executor.create(definition, { runId });
      const event = {
        sequence: state.eventSequence + 1,
        timestamp: "2026-08-09T09:30:00.000Z",
        runId,
        type: "node_trace" as const,
        nodeId: "checkpoint",
        details: { crashBoundary: eventAlreadyAppended ? "after_event" : "before_event" },
      };
      state.eventSequence = event.sequence;
      state.pendingEvent = event;
      store.save(state);
      if (eventAlreadyAppended) store.appendEvent(event);

      const recovered = store.load(runId);
      expect(recovered.pendingEvent).toBeUndefined();
      expect(
        store.readEvents(runId).filter(({ sequence }) => sequence === event.sequence),
      ).toHaveLength(1);
      store.load(runId);
      expect(
        store.readEvents(runId).filter(({ sequence }) => sequence === event.sequence),
      ).toHaveLength(1);
    }
  });

  it("persists provider polling and resumes it after repeated process restarts", async () => {
    const { store } = harness();
    const definition = graph([effectNode()]);
    let handlerCalls = 0;
    let polls = 0;
    const bindings = {
      handlers: {
        provision: () => {
          handlerCalls += 1;
          return {
            wait: {
              kind: "external" as const,
              reason: "provider operation is pending",
              externalReference: "operation-1",
            },
          };
        },
      },
      reconcilers: {
        provision: () => {
          polls += 1;
          return polls === 1
            ? ({ status: "pending", externalReference: "operation-1" } as const)
            : ({
                status: "verified",
                output: { resourceId: "resource-1" },
                evidenceArtifact: "evidence/readback.json",
              } as const);
        },
      },
    };

    let state = await new WorkflowExecutor({ store, bindings }).start(definition, {
      runId: "poll-restart",
    });
    expect(state.nodes.provision.state).toBe("waiting_for_external_action");

    state = await new WorkflowExecutor({ store, bindings }).resume(definition, "poll-restart");
    expect(state.nodes.provision.state).toBe("waiting_for_external_action");
    state = await new WorkflowExecutor({ store, bindings }).resume(definition, "poll-restart");

    expect(state.status).toBe("succeeded");
    expect(handlerCalls).toBe(1);
    expect(polls).toBe(2);
    expect(state.nodes.provision.output).toEqual({ resourceId: "resource-1" });
  });

  it("waits for credential refresh, reconciles the uncertain attempt, and resumes safely", async () => {
    const { store } = harness();
    const definition = graph([effectNode()]);
    let calls = 0;
    const bindings = {
      handlers: {
        provision: () => {
          calls += 1;
          if (calls === 1) {
            throw new WorkflowExecutionError("CREDENTIAL_EXPIRED", "credential expired", {
              retryable: true,
            });
          }
          return { output: { resourceId: "authorized" }, effectVerified: true };
        },
      },
      reconcilers: { provision: () => ({ status: "not_applied" as const }) },
    };
    const executor = new WorkflowExecutor({ store, bindings });

    let state = await executor.start(definition, { runId: "credential-refresh" });
    expect(state.nodes.provision.state).toBe("waiting_for_auth");
    await executor.refreshAuthorization("credential-refresh", "provision", {
      authorizedBy: "operator-1",
      credentialRef: "cred://tenant/provider",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    state = await new WorkflowExecutor({ store, bindings }).resume(
      definition,
      "credential-refresh",
    );

    expect(state.status).toBe("succeeded");
    expect(calls).toBe(2);
    expect(state.nodes.provision.output).toEqual({ resourceId: "authorized" });
  });

  it("does not consume the provider poll budget while reconciliation waits for authorization", async () => {
    const { store } = harness();
    const definition = graph([
      effectNode({
        reconciliation: { handler: "provision", pollIntervalMs: 0, maxPollAttempts: 1 },
      }),
    ]);
    simulateInterruptedAttempt(
      store,
      new WorkflowExecutor({ store }),
      definition,
      "reconcile-auth-refresh",
    );
    let authorized = false;
    let handlerCalls = 0;
    const bindings = {
      handlers: {
        provision: () => {
          handlerCalls += 1;
          return { effectVerified: true };
        },
      },
      reconcilers: {
        provision: () =>
          authorized
            ? ({
                status: "verified",
                output: { resourceId: "already-applied" },
                evidenceArtifact: "evidence/reconciled.json",
              } as const)
            : ({
                status: "failed",
                code: "provider_reconciliation_authorization_rejected",
                message: "authorization expired",
                effectState: "unknown",
              } as const),
      },
    };
    const executor = new WorkflowExecutor({ store, bindings });

    let state = await executor.resume(definition, "reconcile-auth-refresh");
    expect(state.nodes.provision.state).toBe("waiting_for_auth");
    expect(state.nodes.provision.operation?.reconcileAttempts).toBe(0);

    authorized = true;
    await executor.refreshAuthorization("reconcile-auth-refresh", "provision", {
      authorizedBy: "operator-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    state = await new WorkflowExecutor({ store, bindings }).resume(
      definition,
      "reconcile-auth-refresh",
    );

    expect(state.status).toBe("succeeded");
    expect(state.nodes.provision.output).toEqual({ resourceId: "already-applied" });
    expect(handlerCalls).toBe(0);
  });

  it("fails closed on an unknown effect outcome when no reconciler is registered", async () => {
    const { store } = harness();
    const definition = graph([effectNode()]);
    let calls = 0;
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          provision: () => {
            calls += 1;
            throw new WorkflowExecutionError("PROVIDER_INTERRUPTED", "connection lost", {
              retryable: true,
            });
          },
        },
      },
    });

    let state = await executor.start(definition, { runId: "unknown-outcome" });
    expect(state.status).toBe("waiting");
    expect(state.nodes.provision.state).toBe("waiting_for_external_action");
    expect(state.nodes.provision.error?.code).toBe("UNKNOWN_OUTCOME_RECONCILIATION_REQUIRED");
    state = await new WorkflowExecutor({ store }).resume(definition, "unknown-outcome");
    expect(state.nodes.provision.state).toBe("waiting_for_external_action");
    expect(calls).toBe(1);
  });

  it("persists cancellation before abort completion and never resumes the cancelled node", async () => {
    const { store } = harness();
    const definition = graph([workflowNode("long-running")]);
    let calls = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          "long-running": ({ signal }) =>
            new Promise((resolve, reject) => {
              calls += 1;
              signalStarted();
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
              void resolve;
            }),
        },
      },
    });

    const running = executor.start(definition, { runId: "cancel-crash-safe" });
    await started;
    const cancelled = await executor.cancel("cancel-crash-safe", "operator cancelled", definition);
    await running;

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nodes["long-running"].state).toBe("cancelled");
    expect(store.load("cancel-crash-safe").status).toBe("cancelled");
    const resumed = await new WorkflowExecutor({ store }).resume(definition, "cancel-crash-safe");
    expect(resumed.status).toBe("cancelled");
    expect(calls).toBe(1);
    expect(
      store.readEvents("cancel-crash-safe").filter(({ type }) => type === "run_cancelled"),
    ).toHaveLength(1);
    expect(
      readdirSync(join(store.rootDir, "cancel-crash-safe")).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });
});
