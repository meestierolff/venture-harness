import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DuplicateWorkflowRunError,
  FileWorkflowStore,
  WORKFLOW_NODE_STATES,
  WorkflowExecutionError,
  WorkflowExecutor,
  WorkflowValidationError,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
  validateWorkflow,
  workflowNode,
} from "../lib/workflow";

const temporaryDirectories: string[] = [];

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "vh-workflow-test-"));
  temporaryDirectories.push(directory);
  const store = new FileWorkflowStore({ rootDir: join(directory, "runs") });
  return { directory, store };
}

function graph(
  nodes: WorkflowNodeDefinition[],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "test-graph",
    name: "Test graph",
    version: "1",
    nodes,
    maxParallel: 4,
    maxIterations: 50,
    budgets: {},
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workflow contracts", () => {
  it("exposes exactly the required node states", () => {
    expect(WORKFLOW_NODE_STATES).toEqual([
      "pending",
      "ready",
      "running",
      "waiting_for_approval",
      "waiting_for_manual_action",
      "succeeded",
      "failed_retryable",
      "failed_terminal",
      "skipped",
      "compensated",
    ]);
  });

  it("rejects missing dependencies and cycles", () => {
    expect(() =>
      validateWorkflow(graph([workflowNode("a", { dependencies: ["missing"] })])),
    ).toThrow(WorkflowValidationError);

    expect(() =>
      validateWorkflow(
        graph([
          workflowNode("a", { dependencies: ["b"] }),
          workflowNode("b", { dependencies: ["a"] }),
        ]),
      ),
    ).toThrow(/cycle involving: a, b/);
  });

  it("rejects duplicate idempotency keys for side effects", () => {
    expect(() =>
      validateWorkflow(
        graph([
          workflowNode("a", { effect: "local_write", idempotencyKey: "same" }),
          workflowNode("b", { effect: "local_write", idempotencyKey: "same" }),
        ]),
      ),
    ).toThrow(/duplicate side-effect idempotency key/);
  });
});

describe("workflow scheduling and durability", () => {
  it("runs independent nodes in parallel and waits for fan-in dependencies", async () => {
    const { store } = harness();
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const parallel = async (name: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(name);
      active -= 1;
      return { output: name };
    };
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          a: () => parallel("a"),
          b: () => parallel("b"),
          c: ({ dependencyOutputs }) => {
            expect(dependencyOutputs).toEqual({ a: "a", b: "b" });
            order.push("c");
            return { output: "joined" };
          },
        },
      },
    });
    const definition = graph([
      workflowNode("a"),
      workflowNode("b"),
      workflowNode("c", { dependencies: ["a", "b"] }),
    ]);

    const state = await executor.start(definition, { runId: "parallel" });

    expect(state.status).toBe("succeeded");
    expect(maximumActive).toBe(2);
    expect(order.at(-1)).toBe("c");
    expect(existsSync(join(store.rootDir, "parallel", "state.json"))).toBe(true);
    expect(existsSync(join(store.rootDir, "parallel", "events.jsonl"))).toBe(true);
  });

  it("serializes nodes in the same concurrency group", async () => {
    const { store } = harness();
    let active = 0;
    let maximumActive = 0;
    const handler = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {};
    };
    const executor = new WorkflowExecutor({
      store,
      bindings: { handlers: { a: handler, b: handler } },
    });
    const definition = graph([
      workflowNode("a", { concurrencyGroup: "provider" }),
      workflowNode("b", { concurrencyGroup: "provider" }),
    ]);

    const state = await executor.start(definition, { runId: "concurrency-group" });

    expect(state.status).toBe("succeeded");
    expect(maximumActive).toBe(1);
  });

  it("skips a conditional node without blocking independent work", async () => {
    const { store } = harness();
    const calls: string[] = [];
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          root: () => ({ output: true }),
          conditional: () => {
            calls.push("conditional");
            return {};
          },
          independent: () => {
            calls.push("independent");
            return {};
          },
        },
        conditions: { disabled: () => false },
      },
    });
    const definition = graph([
      workflowNode("root"),
      workflowNode("conditional", {
        dependencies: ["root"],
        condition: { kind: "handler", handler: "disabled" },
      }),
      workflowNode("independent"),
    ]);

    const state = await executor.start(definition, { runId: "conditional" });

    expect(state.status).toBe("succeeded");
    expect(state.nodes.conditional.state).toBe("skipped");
    expect(calls).toEqual(["independent"]);
  });

  it("persists approval and manual-action interrupts and resumes the same run", async () => {
    const { store } = harness();
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          finish: ({ dependencyOutputs }) => ({ output: dependencyOutputs.manual }),
        },
      },
    });
    const definition = graph([
      workflowNode("approval", {
        kind: "human_approval",
        transport: "human_approval",
        handler: undefined,
        authorization: { required: true, profile: "standard-launch", scopes: ["deploy"] },
      }),
      workflowNode("manual", {
        kind: "manual_action",
        transport: "manual",
        handler: undefined,
        dependencies: ["approval"],
      }),
      workflowNode("finish", { dependencies: ["manual"] }),
    ]);

    let state = await executor.start(definition, { runId: "interrupts" });
    expect(state.status).toBe("waiting");
    expect(state.nodes.approval.state).toBe("waiting_for_approval");

    await executor.approve("interrupts", "approval", {
      approvedBy: "founder",
      output: { authorization: "standard-launch" },
    });
    state = await executor.resume(definition, "interrupts");
    expect(state.status).toBe("waiting");
    expect(state.nodes.manual.state).toBe("waiting_for_manual_action");

    await executor.completeManualAction("interrupts", "manual", {
      approvedBy: "founder",
      output: { recordId: "manual-record" },
    });
    state = await executor.resume(definition, "interrupts");
    expect(state.status).toBe("succeeded");
    expect(state.nodes.finish.output).toEqual({ recordId: "manual-record" });
    expect(state.nodes.approval.definition.authorization).toEqual({
      required: true,
      profile: "standard-launch",
      scopes: ["deploy"],
    });
    expect(
      store.readEvents("interrupts").filter((event) => event.type === "interrupt_resolved"),
    ).toHaveLength(2);
  });

  it("recovers a running node without repeating a verified effect", async () => {
    const { store } = harness();
    let calls = 0;
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          provision: () => {
            calls += 1;
            return {
              output: { resourceId: "resource-1" },
              effectVerified: true,
              evidenceArtifact: "evidence/resource-1.json",
            };
          },
        },
      },
    });
    const definition = graph([
      workflowNode("provision", {
        effect: "external_reversible",
        evidence: { required: true, artifact: "evidence/resource-1.json" },
      }),
    ]);
    await executor.start(definition, { runId: "idempotent" });
    const interrupted = store.load("idempotent");
    interrupted.status = "running";
    interrupted.finishedAt = undefined;
    interrupted.nodes.provision.state = "running";
    interrupted.nodes.provision.finishedAt = undefined;
    store.save(interrupted);

    const resumed = await executor.resume(definition, "idempotent");

    expect(resumed.status).toBe("succeeded");
    expect(resumed.nodes.provision.output).toEqual({ resourceId: "resource-1" });
    expect(calls).toBe(1);
    expect(store.readEvents("idempotent").some((event) => event.type === "run_recovered")).toBe(
      true,
    );
  });

  it("refuses a duplicate run id", () => {
    const { store } = harness();
    const executor = new WorkflowExecutor({ store });
    const definition = graph([workflowNode("a")]);
    executor.create(definition, { runId: "duplicate" });

    expect(() => executor.create(definition, { runId: "duplicate" })).toThrow(
      DuplicateWorkflowRunError,
    );
  });
});

describe("workflow failure handling", () => {
  it("retries only an explicitly retryable failure with configured backoff", async () => {
    const { store } = harness();
    let calls = 0;
    const delays: number[] = [];
    const executor = new WorkflowExecutor({
      store,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      bindings: {
        handlers: {
          flaky: () => {
            calls += 1;
            if (calls === 1) {
              throw new WorkflowExecutionError("PROVIDER_BUSY", "try later", { retryable: true });
            }
            return { output: "ok" };
          },
        },
      },
    });
    const definition = graph([
      workflowNode("flaky", {
        retry: {
          maxAttempts: 2,
          retryableCodes: ["PROVIDER_BUSY"],
          backoff: { strategy: "exponential", initialMs: 25, maxMs: 100, multiplier: 2 },
        },
      }),
    ]);

    const state = await executor.start(definition, { runId: "retry" });

    expect(state.status).toBe("succeeded");
    expect(state.nodes.flaky.attempts).toBe(2);
    expect(delays).toEqual([25]);
    expect(store.readEvents("retry").some((event) => event.type === "node_retryable_failure")).toBe(
      true,
    );
  });

  it("isolates a terminal provider failure from siblings and skips its dependent", async () => {
    const { store } = harness();
    let independentRan = false;
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          failed: () => {
            throw new WorkflowExecutionError("PROVIDER_DOWN", "provider unavailable");
          },
          independent: () => {
            independentRan = true;
            return { output: "kept" };
          },
          dependent: () => ({ output: "should-not-run" }),
        },
      },
    });
    const definition = graph([
      workflowNode("failed"),
      workflowNode("independent"),
      workflowNode("dependent", { dependencies: ["failed"] }),
    ]);

    const state = await executor.start(definition, { runId: "outage" });

    expect(state.status).toBe("failed");
    expect(state.nodes.failed.state).toBe("failed_terminal");
    expect(state.nodes.independent.state).toBe("succeeded");
    expect(state.nodes.dependent.state).toBe("skipped");
    expect(independentRan).toBe(true);
  });

  it("blocks a node before execution when its budget is exhausted", async () => {
    const { store } = harness();
    let calls = 0;
    const executor = new WorkflowExecutor({
      store,
      bindings: { handlers: { costly: () => ((calls += 1), {}) } },
    });
    const definition = graph(
      [workflowNode("costly", { cost: { amount: 2, unit: "credits" }, budgetCategory: "api" })],
      { budgets: { api: 1 } },
    );

    const state = await executor.start(definition, { runId: "budget" });

    expect(state.status).toBe("failed");
    expect(state.nodes.costly.error?.code).toBe("BUDGET_EXHAUSTED");
    expect(calls).toBe(0);
  });

  it("stops at the configured scheduler iteration limit", async () => {
    const { store } = harness();
    const executor = new WorkflowExecutor({
      store,
      bindings: { handlers: { a: () => ({}), b: () => ({}) } },
    });
    const definition = graph([workflowNode("a"), workflowNode("b", { dependencies: ["a"] })], {
      maxIterations: 1,
    });

    const state = await executor.start(definition, { runId: "iterations" });

    expect(state.status).toBe("failed");
    expect(state.nodes.a.state).toBe("succeeded");
    expect(state.nodes.b.error?.code).toBe("MAX_ITERATIONS_EXCEEDED");
  });

  it("runs compensation hooks in reverse graph order after failure", async () => {
    const { store } = harness();
    const compensated: string[] = [];
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          created: () => ({ effectVerified: true, output: "resource" }),
          failed: () => {
            throw new Error("failed after create");
          },
        },
        compensators: {
          remove: ({ node }) => {
            compensated.push(node.id);
          },
        },
      },
    });
    const definition = graph([
      workflowNode("created", {
        effect: "local_write",
        compensation: { handler: "remove", when: "on_failure" },
      }),
      workflowNode("failed", { dependencies: ["created"] }),
    ]);

    const state = await executor.start(definition, { runId: "compensate" });

    expect(state.status).toBe("failed");
    expect(state.nodes.created.state).toBe("compensated");
    expect(compensated).toEqual(["created"]);
  });

  it("persists cancellation and runs on-cancel compensation", async () => {
    const { store } = harness();
    let compensated = false;
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: { created: () => ({ effectVerified: true }) },
        compensators: { undo: () => void (compensated = true) },
      },
    });
    const definition = graph([
      workflowNode("created", {
        effect: "local_write",
        compensation: { handler: "undo", when: "on_cancel" },
      }),
      workflowNode("manual", {
        kind: "manual_action",
        transport: "manual",
        handler: undefined,
        dependencies: ["created"],
      }),
    ]);
    await executor.start(definition, { runId: "cancel" });

    const state = await executor.cancel("cancel", "founder stopped", definition);

    expect(state.status).toBe("cancelled");
    expect(state.nodes.created.state).toBe("compensated");
    expect(state.nodes.manual.state).toBe("skipped");
    expect(compensated).toBe(true);
  });

  it("redacts secrets from durable state and trace events", async () => {
    const { directory } = harness();
    const secret = "very-secret-token";
    const store = new FileWorkflowStore({
      rootDir: join(directory, "redacted-runs"),
      secrets: [secret],
    });
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        secrets: [secret],
        handlers: {
          unsafe: ({ trace }) => {
            trace({ token: secret, message: `Bearer ${secret}` });
            throw new Error(`token=${secret}`);
          },
        },
      },
    });
    const definition = graph([
      workflowNode("unsafe", {
        input: { value: { api_key: secret, credential_ref: "keychain://provider/test" } },
      }),
    ]);

    await executor.start(definition, { runId: "redaction" });
    const stateText = readFileSync(join(store.rootDir, "redaction", "state.json"), "utf8");
    const eventText = readFileSync(join(store.rootDir, "redaction", "events.jsonl"), "utf8");

    expect(stateText).not.toContain(secret);
    expect(eventText).not.toContain(secret);
    expect(stateText).toContain("[REDACTED]");
    expect(eventText).toContain("[REDACTED]");
    expect(stateText).toContain("keychain://provider/test");
  });

  it("classifies a timeout as retryable but terminates after the attempt limit", async () => {
    const { store } = harness();
    const executor = new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          slow: ({ signal }) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve({}), 100);
              signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            }),
        },
      },
    });
    const definition = graph([workflowNode("slow", { timeoutMs: 5 })]);

    const state = await executor.start(definition, { runId: "timeout" });

    expect(state.status).toBe("failed");
    expect(state.nodes.slow.error?.code).toBe("TIMEOUT");
    expect(state.nodes.slow.error?.retryable).toBe(true);
  });
});
