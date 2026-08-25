import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CommandRunner } from "@/lib/credentials";
import { founderBriefSchema } from "@/lib/launch";
import {
  createLaunchProductBindings,
  type BuildAgentHost,
  type BuildAgentRequest,
  type BuildAgentResult,
} from "@/lib/runtime";
import {
  FileWorkflowStore,
  WorkflowExecutor,
  defineWorkflow,
  workflowNode,
  type WorkflowHandlerContext,
} from "@/lib/workflow";

const brief = founderBriefSchema.parse(parse(readFileSync("fixtures/web-saas/brief.yaml", "utf8")));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "vh-model-boundary-"));
  roots.push(value);
  mkdirSync(join(value, "app"), { recursive: true });
  mkdirSync(join(value, "tests"), { recursive: true });
  writeFileSync(join(value, "app/page.tsx"), "export default function Page() { return null; }\n");
  writeFileSync(join(value, "tests/core-journey.test.ts"), "// direct journey assertions\n");
  return value;
}

function context(runId: string): WorkflowHandlerContext {
  return {
    runId,
    node: workflowNode("build-core-journey", {
      purpose: "Build the bounded core journey",
      kind: "model",
      transport: "model",
      handler: "launch.buildCoreJourney",
      effect: "local_write",
      evidence: { required: true },
    }),
    attempt: 1,
    dependencyOutputs: {},
    idempotencyKey: `test:${runId}`,
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

function compliantResult(changedFiles: string[] = []): BuildAgentResult {
  const command = "pnpm test tests/core-journey.test.ts";
  return {
    status: "completed",
    summary: "Direct journey check passed.",
    changedFiles,
    checks: [{ command, status: "passed", evidence: "one direct journey test passed" }],
    limitations: [],
    eventTypes: [],
    completion: {
      outcome: "already_compliant",
      artifacts: [
        { path: "app/page.tsx", role: "core_journey" },
        { path: "tests/core-journey.test.ts", role: "affected_test" },
      ],
      validator: { checkCommand: command },
    },
  };
}

class Host implements BuildAgentHost {
  readonly id = "boundary-test-host";

  constructor(private readonly execute: (request: BuildAgentRequest) => BuildAgentResult) {}

  async inspect() {
    return {
      host: this.id,
      status: "available" as const,
      version: "test",
      billingMode: "fixture_no_model_execution" as const,
      billingEvidence: "fixture_attestation" as const,
      nextAction: null,
    };
  }

  async run(request: BuildAgentRequest) {
    return this.execute(request);
  }
}

const unusedRunner: CommandRunner = {
  async run() {
    throw new Error("No deterministic command should run in this focused model test");
  },
};

function handler(rootDir: string, host: BuildAgentHost) {
  return createLaunchProductBindings({
    rootDir,
    brief,
    agentHost: host,
    commandRunner: unusedRunner,
  }).handlers!["launch.buildCoreJourney"];
}

describe("model-owned product mutation boundary", () => {
  it.each([
    ["canonical config", "config/venture.yaml"],
    ["ignored Venture authority", ".venture/launch-grant.json"],
    ["pre-existing report authority", "reports/audit/control.json"],
  ])("detects an unreported mutation of %s", async (_label, path) => {
    const rootDir = root();
    const absolute = join(rootDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "canonical\n");
    const host = new Host(() => {
      writeFileSync(absolute, "tampered\n");
      return compliantResult();
    });

    await expect(
      handler(rootDir, host)(context(`actual-${path.replaceAll("/", "-")}`)),
    ).rejects.toMatchObject({ code: "BUILD_AGENT_PROTECTED_INPUT_MUTATION" });
  });

  it("rejects a protected path merely reported as model-owned output", async () => {
    const rootDir = root();
    mkdirSync(join(rootDir, "config"), { recursive: true });
    writeFileSync(join(rootDir, "config/venture.yaml"), "canonical\n");

    await expect(
      handler(
        rootDir,
        new Host(() => compliantResult(["config/venture.yaml"])),
      )(context("reported-control")),
    ).rejects.toMatchObject({ code: "BUILD_AGENT_PROTECTED_INPUT_MUTATION" });
  });

  it("allows disposable direct-validator artifacts under the two Playwright result roots", async () => {
    const rootDir = root();
    const host = new Host(() => {
      for (const path of [
        ".venture/test-results/direct/result.json",
        ".venture/private/test-results/direct/trace.zip",
      ]) {
        mkdirSync(dirname(join(rootDir, path)), { recursive: true });
        writeFileSync(join(rootDir, path), "validator output\n");
      }
      return compliantResult();
    });

    await expect(
      handler(rootDir, host)(context("allowed-validator-output")),
    ).resolves.toMatchObject({
      effectVerified: true,
      output: { completion: { outcome: "already_compliant" } },
    });
  });

  it("fails the model node before a dependent source or provider effect can start", async () => {
    const rootDir = root();
    mkdirSync(join(rootDir, "config"), { recursive: true });
    writeFileSync(join(rootDir, "config/offer.yaml"), "pricing: canonical\n");
    let downstreamCalls = 0;
    const modelBindings = createLaunchProductBindings({
      rootDir,
      brief,
      commandRunner: unusedRunner,
      agentHost: new Host(() => {
        writeFileSync(join(rootDir, "config/offer.yaml"), "pricing: tampered\n");
        return compliantResult();
      }),
    });
    const definition = defineWorkflow({
      id: "protected-boundary-order",
      name: "Protected boundary order",
      version: "1",
      nodes: [
        workflowNode("build-core-journey", {
          purpose: "Build the bounded core journey",
          kind: "model",
          transport: "model",
          handler: "launch.buildCoreJourney",
          effect: "local_write",
          evidence: { required: true },
        }),
        workflowNode("source-publication", {
          purpose: "Publish source only after the protected model boundary passes",
          kind: "code",
          handler: "test.sourcePublication",
          dependencies: ["build-core-journey"],
          effect: "local_write",
        }),
      ],
      maxParallel: 1,
      maxIterations: 4,
      budgets: { default: 0 },
    });
    const executor = new WorkflowExecutor({
      store: new FileWorkflowStore({ rootDir: join(rootDir, ".venture/runs") }),
      bindings: {
        ...modelBindings,
        handlers: {
          ...modelBindings.handlers,
          "test.sourcePublication": async () => {
            downstreamCalls += 1;
            return { output: { published: true }, effectVerified: true };
          },
        },
      },
    });

    const state = await executor.start(definition, { runId: "protected-order" });

    expect(state.nodes["build-core-journey"]).toMatchObject({
      state: "waiting_for_external_action",
      error: { code: "UNKNOWN_OUTCOME_RECONCILIATION_REQUIRED" },
    });
    expect(state.nodes["source-publication"].state).not.toBe("succeeded");
    expect(downstreamCalls).toBe(0);
  });
});
