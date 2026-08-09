import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileWorkflowStore,
  WorkflowExecutor,
  type WorkflowDefinition,
  type WorkflowHandlerContext,
  type WorkflowNodeDefinition,
  topologicalOrder,
  workflowNode,
} from "../lib/workflow";

const temporaryDirectories: string[] = [];

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "vh-workflow-control-"));
  temporaryDirectories.push(directory);
  const store = new FileWorkflowStore({ rootDir: join(directory, "runs") });
  return { directory, store };
}

function graph(
  nodes: WorkflowNodeDefinition[],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "control-graph",
    name: "Control graph",
    version: "1",
    nodes,
    maxParallel: 4,
    maxIterations: 30,
    budgets: {},
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workflow graph control plane", () => {
  it("topologically executes fan-out/fan-in and deterministic conditions", async () => {
    const { store } = harness();
    const definition = graph([
      workflowNode("root"),
      workflowNode("fan-a", { dependencies: ["root"] }),
      workflowNode("fan-b", { dependencies: ["root"] }),
      workflowNode("disabled", {
        dependencies: ["root"],
        condition: { kind: "handler", handler: "disabled" },
      }),
      workflowNode("join", { dependencies: ["fan-a", "fan-b"] }),
    ]);
    const order = topologicalOrder(definition);
    expect(order.indexOf("root")).toBeLessThan(order.indexOf("fan-a"));
    expect(order.indexOf("fan-a")).toBeLessThan(order.indexOf("join"));
    expect(order.indexOf("fan-b")).toBeLessThan(order.indexOf("join"));
    const state = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          root: () => ({ output: "root" }),
          "fan-a": () => ({ output: "a" }),
          "fan-b": () => ({ output: "b" }),
          disabled: () => ({ output: "must-not-run" }),
          join: ({ dependencyOutputs }) => ({
            output: {
              "fan-a": dependencyOutputs["fan-a"] ?? null,
              "fan-b": dependencyOutputs["fan-b"] ?? null,
            },
          }),
        },
        conditions: { disabled: () => false },
      },
    }).start(definition, { runId: "fan-control" });

    expect(state.status).toBe("succeeded");
    expect(state.nodes.disabled.state).toBe("skipped");
    expect(state.nodes.join.output).toEqual({ "fan-a": "a", "fan-b": "b" });
  });

  it("creates distinct persisted isolated workspaces per node and attempt", async () => {
    const { store } = harness();
    const workspaces: string[] = [];
    const isolated = (id: string) =>
      workflowNode(id, { isolation: "worktree", concurrencyGroup: id });
    const definition = graph([isolated("workspace-a"), isolated("workspace-b")]);
    const state = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          "workspace-a": ({ workspacePath }) => {
            workspaces.push(workspacePath!);
            return { output: workspacePath! };
          },
          "workspace-b": ({ workspacePath }) => {
            workspaces.push(workspacePath!);
            return { output: workspacePath! };
          },
        },
      },
    }).start(definition, { runId: "isolated" });

    expect(state.status).toBe("succeeded");
    expect(new Set(workspaces).size).toBe(2);
    expect(workspaces.every((path) => existsSync(path))).toBe(true);
    expect(workspaces.every((path) => path.startsWith(join(store.rootDir, "isolated")))).toBe(true);
    expect(state.nodes["workspace-a"].workspace?.mode).toBe("worktree");
  });

  it("records model and tool costs durably against separate hard budgets", async () => {
    const { store } = harness();
    const definition = graph(
      [
        workflowNode("synthesis", {
          kind: "model",
          transport: "model",
          model: { tier: "capable", provider: "test", model: "test-model" },
          budgetCategory: "model",
          cost: { amount: 0, unit: "credits" },
        }),
      ],
      { budgets: { model: 1, tools: 1 } },
    );
    const state = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          synthesis: ({ recordCost }) => {
            recordCost!({
              kind: "model",
              category: "model",
              amount: 0.4,
              unit: "credits",
              inputTokens: 120,
              outputTokens: 30,
              model: "test-model",
            });
            recordCost!({
              kind: "tool",
              category: "tools",
              amount: 0.2,
              unit: "credits",
              tool: "search",
            });
            return { output: "grounded" };
          },
        },
      },
    }).start(definition, { runId: "cost-ledger" });

    expect(state.status).toBe("succeeded");
    expect(state.budget.consumed).toMatchObject({ model: 0.4, tools: 0.2 });
    expect(state.costs).toMatchObject([
      { kind: "model", inputTokens: 120, outputTokens: 30, amount: 0.4 },
      { kind: "tool", tool: "search", amount: 0.2 },
    ]);
    expect(store.load("cost-ledger").costs).toEqual(state.costs);
  });

  it("hard-stops when dynamically reported tool cost exceeds the budget", async () => {
    const { store } = harness();
    const definition = graph(
      [workflowNode("tool", { budgetCategory: "tools", cost: { amount: 0, unit: "credits" } })],
      { budgets: { tools: 0.1 } },
    );
    const state = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          tool: ({ recordCost }) => {
            recordCost!({ kind: "tool", category: "tools", amount: 0.2, unit: "credits" });
            return {};
          },
        },
      },
    }).start(definition, { runId: "cost-stop" });

    expect(state.status).toBe("failed");
    expect(state.nodes.tool.error?.code).toBe("BUDGET_EXCEEDED_AFTER_EXECUTION");
    expect(state.budget.consumed.tools).toBe(0.2);
  });

  it("executes declared loops only within their persisted node bound", async () => {
    const { store } = harness();
    let iterations = 0;
    const bounded = graph([workflowNode("loop", { loop: { maxIterations: 3 } })]);
    const succeeded = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          loop: () => {
            iterations += 1;
            return { output: iterations, continueLoop: iterations < 3 };
          },
        },
      },
    }).start(bounded, { runId: "bounded-loop" });

    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.nodes.loop.loopIterations).toBe(3);
    expect(iterations).toBe(3);

    const runawayDefinition = graph([workflowNode("runaway", { loop: { maxIterations: 2 } })]);
    const runaway = await new WorkflowExecutor({
      store,
      bindings: { handlers: { runaway: () => ({ continueLoop: true }) } },
    }).start(runawayDefinition, { runId: "runaway-loop" });
    expect(runaway.status).toBe("failed");
    expect(runaway.nodes.runaway.error?.code).toBe("LOOP_LIMIT_EXCEEDED");
  });

  it("streams append-only persisted events from a sequence cursor", async () => {
    const { store } = harness();
    const definition = graph([workflowNode("eventful")]);
    await new WorkflowExecutor({
      store,
      bindings: { handlers: { eventful: ({ trace }) => (trace({ step: 1 }), {}) } },
    }).start(definition, { runId: "event-stream" });

    const all = [];
    for await (const event of store.streamEvents("event-stream", { follow: false }))
      all.push(event);
    const tail = [];
    for await (const event of store.streamEvents("event-stream", {
      afterSequence: all[1].sequence,
      follow: false,
    }))
      tail.push(event);

    expect(all.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: all.length }, (_, index) => index + 1),
    );
    expect(tail[0].sequence).toBe(all[1].sequence + 1);
    expect(all.some(({ type }) => type === "node_trace")).toBe(true);
  });

  it("follows new persisted events until the run reaches a terminal state", async () => {
    const { store } = harness();
    const definition = graph([workflowNode("streamed")]);
    const executor = new WorkflowExecutor({
      store,
      bindings: { handlers: { streamed: () => ({ output: "done" }) } },
    });
    executor.enqueue(definition, { runId: "live-stream" });
    const collect = async () => {
      const events = [];
      for await (const event of store.streamEvents("live-stream", {
        follow: true,
        pollIntervalMs: 1,
        stopWhenRunFinishes: true,
      })) {
        events.push(event);
      }
      return events;
    };
    const eventsPromise = collect();

    await executor.startQueued(definition, "live-stream");
    const events = await eventsPromise;

    expect(events.at(-1)?.type).toBe("run_succeeded");
    expect(events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
  });

  it("queues and supersedes durably before starting the replacement", async () => {
    const { store } = harness();
    const current = graph([workflowNode("old")]);
    const replacement = graph([workflowNode("new")], {
      id: "replacement-graph",
      name: "Replacement graph",
      version: "2",
    });
    const executor = new WorkflowExecutor({
      store,
      bindings: { handlers: { old: () => ({}), new: () => ({ output: "replacement" }) } },
    });
    const queued = executor.enqueue(current, { runId: "old-run" });
    expect(queued.status).toBe("queued");
    expect(executor.listQueue().map(({ runId }) => runId)).toEqual(["old-run"]);

    const result = await executor.supersede("old-run", current, replacement, {
      runId: "replacement-run",
      reason: "new founder input",
      supersededBy: "operator-1",
    });
    expect(result.superseded.status).toBe("superseded");
    expect(result.superseded.supersededByRunId).toBe("replacement-run");
    expect(result.replacement.status).toBe("queued");
    expect(result.replacement.supersedesRunId).toBe("old-run");
    expect(executor.listQueue().map(({ runId }) => runId)).toEqual(["replacement-run"]);

    const completed = await executor.startQueued(replacement, "replacement-run");
    expect(completed.status).toBe("succeeded");
    expect(completed.nodes.new.output).toBe("replacement");
  });

  it("reconciles an in-flight effect before completing supersede", async () => {
    const { store } = harness();
    const current = graph([
      workflowNode("external", {
        kind: "provider",
        transport: "api",
        handler: "external",
        effect: "external_reversible",
        reconciliation: { handler: "external", pollIntervalMs: 0, maxPollAttempts: 2 },
      }),
    ]);
    const replacement = graph([workflowNode("replacement")], {
      id: "replacement-after-effect",
      name: "Replacement after effect",
      version: "2",
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    let handlerCalls = 0;
    let reconciliationCalls = 0;
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          external: ({ signal }) =>
            new Promise((_resolve, reject) => {
              handlerCalls += 1;
              signalStarted();
              signal.addEventListener("abort", () => reject(new Error("superseded")), {
                once: true,
              });
            }),
          replacement: () => ({ output: "queued" }),
        },
        reconcilers: {
          external: () => {
            reconciliationCalls += 1;
            return {
              status: "verified",
              output: { resourceId: "written-before-supersede" },
            } as const;
          },
        },
      },
    });
    const running = executor.start(current, { runId: "supersede-active" });
    await started;

    const result = await executor.supersede("supersede-active", current, replacement, {
      runId: "supersede-replacement",
      reason: "new bounded request",
      supersededBy: "operator-1",
    });
    await running;

    expect(result.superseded.status).toBe("superseded");
    expect(result.superseded.nodes.external.state).toBe("succeeded");
    expect(result.superseded.verifiedEffects.external?.output).toEqual({
      resourceId: "written-before-supersede",
    });
    expect(handlerCalls).toBe(1);
    expect(reconciliationCalls).toBe(1);
    expect(result.replacement.status).toBe("queued");
  });

  it("steers only the changed node and its descendants", async () => {
    const { store } = harness();
    const calls = { left: 0, leftChild: 0, right: 0, rightChild: 0, join: 0 };
    const definition = graph([
      workflowNode("left", { input: { value: 1 } }),
      workflowNode("left-child", { dependencies: ["left"] }),
      workflowNode("right", { input: { value: 10 } }),
      workflowNode("right-child", { dependencies: ["right"] }),
      workflowNode("join", { dependencies: ["left-child", "right-child"] }),
    ]);
    const bindings = {
      handlers: {
        left: ({ input }: WorkflowHandlerContext) => ((calls.left += 1), { output: input }),
        "left-child": ({ dependencyOutputs }: WorkflowHandlerContext) => (
          (calls.leftChild += 1),
          { output: dependencyOutputs.left }
        ),
        right: ({ input }: WorkflowHandlerContext) => ((calls.right += 1), { output: input }),
        "right-child": ({ dependencyOutputs }: WorkflowHandlerContext) => (
          (calls.rightChild += 1),
          { output: dependencyOutputs.right }
        ),
        join: ({ dependencyOutputs }: WorkflowHandlerContext) => (
          (calls.join += 1),
          {
            output: {
              "left-child": dependencyOutputs["left-child"] ?? null,
              "right-child": dependencyOutputs["right-child"] ?? null,
            },
          }
        ),
      },
    };
    const executor = new WorkflowExecutor({ store, bindings });
    await executor.start(definition, { runId: "steer" });

    const steered = await executor.steer(definition, "steer", {
      inputs: { left: 2 },
      reason: "left-side correction",
      steeredBy: "operator-1",
    });
    expect(steered.nodes.left.state).toBe("pending");
    expect(steered.nodes["left-child"].state).toBe("pending");
    expect(steered.nodes.join.state).toBe("pending");
    expect(steered.nodes.right.state).toBe("succeeded");
    expect(steered.nodes["right-child"].state).toBe("succeeded");

    const resumed = await new WorkflowExecutor({ store, bindings }).resume(definition, "steer");
    expect(resumed.status).toBe("succeeded");
    expect(calls).toEqual({ left: 2, leftChild: 2, right: 1, rightChild: 1, join: 2 });
    expect(resumed.nodes.left.output).toBe(2);
  });

  it("rejects steering that would replay an already-started effect", async () => {
    const { store } = harness();
    const definition = graph([
      workflowNode("input", { input: { value: 1 } }),
      workflowNode("effect", {
        dependencies: ["input"],
        effect: "local_write",
      }),
    ]);
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          input: ({ input }) => ({ output: input }),
          effect: () => ({ effectVerified: true, output: "written" }),
        },
      },
    });
    await executor.start(definition, { runId: "steer-effect" });

    await expect(
      executor.steer(definition, "steer-effect", {
        inputs: { input: 2 },
        reason: "unsafe replay",
        steeredBy: "operator-1",
      }),
    ).rejects.toThrow(/effectful node "effect"/);
    expect(store.load("steer-effect").status).toBe("succeeded");
  });
});
