import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Redactor, type CommandInvocation, type CommandRunner } from "@/lib/credentials";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import { founderBriefSchema } from "@/lib/launch";
import {
  assertBuildAgentHostAvailable,
  CodexCliBuildAgentHost,
  codexBuildAgentEnvironment,
  createLaunchProductBindings,
  type BuildAgentHost,
  type BuildAgentRequest,
  type BuildAgentResult,
} from "@/lib/runtime";
import { FileWorkflowStore, workflowNode, type WorkflowHandlerContext } from "@/lib/workflow";

const webBrief = founderBriefSchema.parse(
  parse(readFileSync("fixtures/web-saas/brief.yaml", "utf8")),
);

const temporaryDirectories: string[] = [];

class FakeRunner implements CommandRunner {
  readonly calls: CommandInvocation[] = [];

  constructor(
    private readonly results: Array<
      { exitCode: number; stdout: string; stderr: string } | { error: NodeJS.ErrnoException }
    >,
  ) {}

  async run(invocation: CommandInvocation) {
    this.calls.push(invocation);
    const next = this.results.shift();
    if (!next) throw new Error("FakeRunner has no queued result");
    if ("error" in next) throw next.error;
    return next;
  }
}

class FakeBuildAgentHost implements BuildAgentHost {
  readonly id = "fake_build_agent";
  readonly requests: BuildAgentRequest[] = [];

  constructor(
    private readonly result:
      | BuildAgentResult
      | ((request: BuildAgentRequest) => BuildAgentResult | Promise<BuildAgentResult>),
    private readonly available = true,
  ) {}

  async inspect() {
    return {
      host: this.id,
      status: this.available ? ("available" as const) : ("missing" as const),
      version: this.available ? "fake 1.0" : null,
      nextAction: this.available ? null : "Install the fake host.",
    };
  }

  async run(request: BuildAgentRequest) {
    this.requests.push(request);
    return typeof this.result === "function" ? this.result(request) : this.result;
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vh-build-host-"));
  temporaryDirectories.push(root);
  return root;
}

function handlerContext(
  runId: string,
  nodeId: string,
  handler: string,
  effect: "none" | "local_write" = "local_write",
): WorkflowHandlerContext {
  return {
    runId,
    node: workflowNode(nodeId, {
      purpose: `Execute ${nodeId}`,
      handler,
      effect,
      evidence: { required: true, artifact: `reports/${nodeId}.json` },
    }),
    attempt: 1,
    dependencyOutputs: {},
    idempotencyKey: `${runId}:${nodeId}`,
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex CLI build-agent host", () => {
  it("uses the official shell-free exec argv and sends the brief only through stdin", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app/page.tsx"), "export default function Page() {}\n");
    const finalResult = {
      status: "completed",
      summary: "Built the bounded journey.",
      changed_files: ["app/page.tsx"],
      checks: [{ command: "pnpm test", status: "passed", evidence: "1 test passed" }],
      limitations: [],
      completion: {
        outcome: "changed",
        artifacts: [{ path: "app/page.tsx", role: "core_journey" }],
        validator: { check_command: "pnpm test" },
      },
    };
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
      {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(finalResult) },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 },
          }),
        ].join("\n"),
        stderr: "",
      },
    ]);
    const host = new CodexCliBuildAgentHost({ rootDir: root, runner });

    const result = await host.run({
      runId: "launch-one",
      nodeId: "build-core-journey",
      purpose: "Build a private founder concept",
      instructions: "Change the smallest useful journey.",
      context: { brief: "private founder concept appears only on stdin" },
    });

    expect(result).toMatchObject({
      status: "completed",
      changedFiles: ["app/page.tsx"],
      completion: { outcome: "changed" },
      eventTypes: ["item.completed", "thread.started", "turn.completed"],
      usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 7 },
    });
    expect(runner.calls[0]).toMatchObject({ command: "codex", args: ["--version"], cwd: root });
    expect(runner.calls[1]).toMatchObject({
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        "workspace-write",
        "--ephemeral",
        "--ignore-user-config",
        "--json",
        "-C",
        root,
        "-",
      ],
      cwd: root,
      sensitiveStdin: true,
    });
    expect(runner.calls[1].args.join(" ")).not.toContain("private founder concept");
    expect(runner.calls[1].stdin).toContain("private founder concept appears only on stdin");
  });

  it("rejects credential material before starting Codex and rejects malformed final output", async () => {
    const root = temporaryRoot();
    const credentialRunner = new FakeRunner([
      { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
    ]);
    const credentialHost = new CodexCliBuildAgentHost({ rootDir: root, runner: credentialRunner });
    await expect(
      credentialHost.run({
        runId: "launch-secret",
        nodeId: "build-core-journey",
        purpose: "Build",
        instructions: "Build",
        context: { value: "sk_live_1234567890abcdef" },
      }),
    ).rejects.toMatchObject({ code: "credential_material" });
    expect(credentialRunner.calls).toHaveLength(1);

    const malformedRunner = new FakeRunner([
      { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
      { exitCode: 0, stdout: "not-jsonl\n", stderr: "" },
    ]);
    const malformedHost = new CodexCliBuildAgentHost({ rootDir: root, runner: malformedRunner });
    await expect(
      malformedHost.run({
        runId: "launch-invalid",
        nodeId: "build-core-journey",
        purpose: "Build",
        instructions: "Build",
        context: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_jsonl" });

    const noCompletionRunner = new FakeRunner([
      { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              status: "completed",
              summary: "Claimed completion without proof.",
              changed_files: [],
              checks: [],
              limitations: [],
              completion: null,
            }),
          },
        }),
        stderr: "",
      },
    ]);
    const noCompletionHost = new CodexCliBuildAgentHost({
      rootDir: root,
      runner: noCompletionRunner,
    });
    await expect(
      noCompletionHost.run({
        runId: "launch-no-completion",
        nodeId: "build-core-journey",
        purpose: "Build",
        instructions: "Build",
        context: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_final_result" });
  });

  it("passes only a credential-free environment allowlist to the default host runner", () => {
    expect(
      codexBuildAgentEnvironment({
        NODE_ENV: "test",
        PATH: "/bin",
        HOME: "/safe-home",
        CODEX_HOME: "/safe-codex",
        VERCEL_TOKEN: "provider-secret",
        DATABASE_URL: "postgresql://user:secret@example.test/db",
        NPM_TOKEN: "registry-secret",
      }),
    ).toEqual({
      NODE_ENV: "test",
      PATH: "/bin",
      HOME: "/safe-home",
      CODEX_HOME: "/safe-codex",
    });
  });
});

describe("default launch product bindings", () => {
  it("routes product changes through the host, keeps quality deterministic, and persists redacted evidence", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(root, "docs/brand"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, "lib/analytics"), { recursive: true });
    writeFileSync(join(root, "harness.lock"), "{}\n");
    writeFileSync(join(root, "app/page.tsx"), "export default function Page() { return null; }\n");
    writeFileSync(join(root, "docs/brand/DESIGN.md"), "# Design\n\nTemplate state.\n");
    writeFileSync(join(root, "tests/core-journey.test.ts"), "// pending journey test\n");
    writeFileSync(join(root, "config/analytics.yaml"), "event_packs: {}\n");
    const secret = "agent-output-secret";
    const redactor = new Redactor();
    redactor.addSecret(secret);
    const host = new FakeBuildAgentHost((request) => {
      const common = {
        status: "completed" as const,
        summary: `Completed ${request.nodeId} without persisting ${secret}.`,
        limitations: [],
        eventTypes: ["item.completed", "turn.completed"],
      };
      if (request.nodeId === "prepare-repository") {
        writeFileSync(join(root, "app/scaffold.tsx"), "export const scaffold = true;\n");
        return {
          ...common,
          changedFiles: ["app/scaffold.tsx"],
          checks: [
            {
              command: "pnpm test tests/scaffold.test.ts",
              status: "passed",
              evidence: "scaffold contract passed",
            },
          ],
          completion: {
            outcome: "changed",
            artifacts: [
              { path: "app/scaffold.tsx", role: "repository_scaffold" },
              { path: "harness.lock", role: "managed_manifest" },
            ],
            validator: { checkCommand: "pnpm test tests/scaffold.test.ts" },
          },
        };
      }
      if (request.nodeId === "design-direction") {
        writeFileSync(
          join(root, "docs/brand/DESIGN.md"),
          "# Design\n\nDistinct responsive thesis and accessibility constraints.\n",
        );
        writeFileSync(join(root, "app/globals.css"), ":root { --accent: #123456; }\n");
        return {
          ...common,
          changedFiles: ["docs/brand/DESIGN.md", "app/globals.css"],
          checks: [
            {
              command: "pnpm test tests/design-accessibility.test.ts",
              status: "passed",
              evidence: "design and accessibility assertions passed",
            },
          ],
          completion: {
            outcome: "changed",
            artifacts: [
              { path: "docs/brand/DESIGN.md", role: "design_record" },
              { path: "app/globals.css", role: "design_implementation" },
            ],
            validator: { checkCommand: "pnpm test tests/design-accessibility.test.ts" },
          },
        };
      }
      if (request.nodeId === "build-core-journey") {
        writeFileSync(
          join(root, "app/page.tsx"),
          "export default function Page() { return <main>Core journey</main>; }\n",
        );
        writeFileSync(
          join(root, "tests/core-journey.test.ts"),
          "// core journey assertions passed\n",
        );
        return {
          ...common,
          changedFiles: ["app/page.tsx", "tests/core-journey.test.ts"],
          checks: [
            {
              command: "pnpm test tests/core-journey.test.ts",
              status: "passed",
              evidence: "core journey test passed",
            },
          ],
          completion: {
            outcome: "changed",
            artifacts: [
              { path: "app/page.tsx", role: "core_journey" },
              { path: "tests/core-journey.test.ts", role: "affected_test" },
            ],
            validator: { checkCommand: "pnpm test tests/core-journey.test.ts" },
          },
        };
      }
      writeFileSync(
        join(root, "lib/analytics/event-instrumentation.ts"),
        "export const eventPack = ['core_journey_completed'];\n",
      );
      return {
        ...common,
        changedFiles: ["lib/analytics/event-instrumentation.ts"],
        checks: [
          {
            command: "pnpm test tests/analytics-event-pack.test.ts",
            status: "passed",
            evidence: "event contract and PII assertions passed",
          },
        ],
        completion: {
          outcome: "changed",
          artifacts: [
            { path: "config/analytics.yaml", role: "event_contract" },
            {
              path: "lib/analytics/event-instrumentation.ts",
              role: "event_instrumentation",
            },
          ],
          validator: { checkCommand: "pnpm test tests/analytics-event-pack.test.ts" },
        },
      };
    });
    const qualityRunner = new FakeRunner([
      { exitCode: 0, stdout: "fast passed\n", stderr: "" },
      { exitCode: 0, stdout: "mvp passed\n", stderr: "" },
    ]);
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: host,
      commandRunner: qualityRunner,
      redactor,
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    const agentHandlers = [
      ["prepare-repository", "launch.prepareRepository"],
      ["design-direction", "launch.designDirection"],
      ["build-core-journey", "launch.buildCoreJourney"],
      ["configure-event-pack", "launch.configureEventPack"],
    ] as const;
    for (const [nodeId, handler] of agentHandlers) {
      const result = await bindings.handlers![handler](
        handlerContext("launch-product", nodeId, handler),
      );
      expect(result.effectVerified).toBe(true);
      expect(JSON.stringify(result.output)).not.toContain(secret);
      expect(result.evidenceArtifact).toBe(`reports/launch/launch-product/product/${nodeId}.json`);
    }

    await bindings.handlers!["launch.verifyLocal"](
      handlerContext("launch-product", "verify-local", "launch.verifyLocal", "none"),
    );
    await bindings.handlers!["launch.verifyMvp"](
      handlerContext("launch-product", "verify-launch", "launch.verifyMvp", "none"),
    );

    expect(host.requests).toHaveLength(4);
    expect(qualityRunner.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["pnpm", "verify:fast"],
      ["pnpm", "verify:mvp"],
    ]);
    const evidence = readFileSync(
      join(root, "reports/launch/launch-product/product/build-core-journey.json"),
      "utf8",
    );
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain("Bounded JSON context");
    expect(JSON.parse(evidence)).toMatchObject({
      host: "fake_build_agent",
      rawPromptPersisted: false,
      rawJsonlPersisted: false,
      verifiedChangedFiles: [
        {
          path: "app/page.tsx",
          beforeSha256: expect.any(String),
          afterSha256: expect.any(String),
        },
        {
          path: "tests/core-journey.test.ts",
          beforeSha256: expect.any(String),
          afterSha256: expect.any(String),
        },
      ],
      completionValidator: {
        checkCommand: "pnpm test tests/core-journey.test.ts",
        evidence: "core journey test passed",
      },
    });
    expect(existsSync(join(root, "reports/launch/launch-product/product/verify-launch.json"))).toBe(
      true,
    );
  });

  it("runs read-only browser checks against the exact URL from production read-back", async () => {
    const root = temporaryRoot();
    const runner = new FakeRunner([{ exitCode: 0, stdout: "2 passed\n", stderr: "" }]);
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: new FakeBuildAgentHost({
        status: "completed",
        summary: "unused",
        changedFiles: [],
        checks: [],
        limitations: [],
        eventTypes: [],
        completion: null,
      }),
      commandRunner: runner,
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });
    const context: WorkflowHandlerContext = {
      ...handlerContext(
        "launch-production-check",
        "verify-production",
        "launch.verifyProduction",
        "none",
      ),
      dependencyOutputs: {
        "production-deploy": {
          provider: "vercel",
          state: "verified",
          resourceRefs: ["deployment_id=dpl_exact", "url=https://venture-example.vercel.app/"],
        },
      },
    };

    const result = await bindings.handlers!["launch.verifyProduction"](context);

    expect(result.output).toMatchObject({
      deploymentUrl: "https://venture-example.vercel.app",
      verified: true,
    });
    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: "pnpm",
        args: ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts"],
        env: { PLAYWRIGHT_BASE_URL: "https://venture-example.vercel.app" },
      }),
    ]);
    expect(result.evidenceArtifact).toBe(
      "reports/launch/launch-production-check/product/verify-production.json",
    );
  });

  it("rejects a completed product node with no typed artifacts, changes, or direct check", async () => {
    const root = temporaryRoot();
    const host = new FakeBuildAgentHost({
      status: "completed",
      summary: "Nothing to do.",
      changedFiles: [],
      checks: [],
      limitations: [],
      eventTypes: [],
      completion: null,
    });
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: host,
      commandRunner: new FakeRunner([]),
    });

    await expect(
      bindings.handlers!["launch.prepareRepository"](
        handlerContext("launch-empty", "prepare-repository", "launch.prepareRepository"),
      ),
    ).rejects.toMatchObject({ code: "BUILD_AGENT_EVIDENCE_INVALID" });
    expect(
      JSON.parse(
        readFileSync(
          join(root, "reports/launch/launch-empty/product/prepare-repository.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ status: "invalid_evidence", repositoryChanges: [] });
  });

  it("rejects a pre-existing unchanged file reported as a completed core-journey change", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "app/page.tsx"), "export default function Page() { return null; }\n");
    writeFileSync(join(root, "tests/core-journey.test.ts"), "// journey test\n");
    const host = new FakeBuildAgentHost({
      status: "completed",
      summary: "Claimed a journey change.",
      changedFiles: ["app/page.tsx"],
      checks: [
        {
          command: "pnpm test tests/core-journey.test.ts",
          status: "passed",
          evidence: "one test passed",
        },
      ],
      limitations: [],
      eventTypes: [],
      completion: {
        outcome: "changed",
        artifacts: [
          { path: "app/page.tsx", role: "core_journey" },
          { path: "tests/core-journey.test.ts", role: "affected_test" },
        ],
        validator: { checkCommand: "pnpm test tests/core-journey.test.ts" },
      },
    });
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: host,
      commandRunner: new FakeRunner([]),
    });

    await expect(
      bindings.handlers!["launch.buildCoreJourney"](
        handlerContext("launch-unchanged", "build-core-journey", "launch.buildCoreJourney"),
      ),
    ).rejects.toMatchObject({ code: "BUILD_AGENT_EVIDENCE_INVALID" });
  });

  it("accepts typed already_compliant only when artifacts and a relevant validator prove the node", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "app/page.tsx"),
      "export default function Page() { return <main>Existing journey</main>; }\n",
    );
    writeFileSync(join(root, "tests/core-journey.test.ts"), "// existing journey assertions\n");
    const checkCommand = "pnpm test tests/core-journey.test.ts";
    const host = new FakeBuildAgentHost({
      status: "completed",
      summary: "The tested core journey already meets the completion contract.",
      changedFiles: [],
      checks: [{ command: checkCommand, status: "passed", evidence: "core journey test passed" }],
      limitations: [],
      eventTypes: [],
      completion: {
        outcome: "already_compliant",
        artifacts: [
          { path: "app/page.tsx", role: "core_journey" },
          { path: "tests/core-journey.test.ts", role: "affected_test" },
        ],
        validator: { checkCommand },
      },
    });
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: host,
      commandRunner: new FakeRunner([]),
    });

    const result = await bindings.handlers!["launch.buildCoreJourney"](
      handlerContext("launch-compliant", "build-core-journey", "launch.buildCoreJourney"),
    );

    expect(result.effectVerified).toBe(true);
    expect(result.output).toMatchObject({
      completion: { outcome: "already_compliant" },
      changedFiles: [],
    });
    expect(
      JSON.parse(
        readFileSync(
          join(root, "reports/launch/launch-compliant/product/build-core-journey.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      verifiedChangedFiles: [],
      completionValidator: { checkCommand, evidence: "core journey test passed" },
    });
  });

  it("rejects changed completion that omits a node-specific artifact role", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app/page.tsx"), "export default function Page() { return null; }\n");
    const checkCommand = "pnpm test tests/core-journey.test.ts";
    const host = new FakeBuildAgentHost(() => {
      writeFileSync(
        join(root, "app/page.tsx"),
        "export default function Page() { return <main>Changed</main>; }\n",
      );
      return {
        status: "completed",
        summary: "Changed the journey without an affected-test artifact.",
        changedFiles: ["app/page.tsx"],
        checks: [{ command: checkCommand, status: "passed", evidence: "journey check passed" }],
        limitations: [],
        eventTypes: [],
        completion: {
          outcome: "changed",
          artifacts: [{ path: "app/page.tsx", role: "core_journey" }],
          validator: { checkCommand },
        },
      };
    });
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: host,
      commandRunner: new FakeRunner([]),
    });

    await expect(
      bindings.handlers!["launch.buildCoreJourney"](
        handlerContext("launch-missing-role", "build-core-journey", "launch.buildCoreJourney"),
      ),
    ).rejects.toMatchObject({ code: "BUILD_AGENT_EVIDENCE_INVALID" });
    expect(
      readFileSync(
        join(root, "reports/launch/launch-missing-role/product/build-core-journey.json"),
        "utf8",
      ),
    ).toContain("missing required artifact role affected_test");
  });

  it("rejects already_compliant when its passed command is not relevant to the node", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "app/page.tsx"), "export default function Page() { return null; }\n");
    writeFileSync(join(root, "tests/core-journey.test.ts"), "// existing assertions\n");
    const host = new FakeBuildAgentHost({
      status: "completed",
      summary: "Claimed compliance from an unrelated check.",
      changedFiles: [],
      checks: [{ command: "pnpm typecheck", status: "passed", evidence: "types passed" }],
      limitations: [],
      eventTypes: [],
      completion: {
        outcome: "already_compliant",
        artifacts: [
          { path: "app/page.tsx", role: "core_journey" },
          { path: "tests/core-journey.test.ts", role: "affected_test" },
        ],
        validator: { checkCommand: "pnpm typecheck" },
      },
    });
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: host,
      commandRunner: new FakeRunner([]),
    });

    await expect(
      bindings.handlers!["launch.buildCoreJourney"](
        handlerContext("launch-irrelevant-check", "build-core-journey", "launch.buildCoreJourney"),
      ),
    ).rejects.toMatchObject({ code: "BUILD_AGENT_EVIDENCE_INVALID" });
    expect(
      readFileSync(
        join(root, "reports/launch/launch-irrelevant-check/product/build-core-journey.json"),
        "utf8",
      ),
    ).toContain("relevant direct passed check");
  });

  it("fails closed when the configured build host is missing", async () => {
    const host = new FakeBuildAgentHost(
      {
        status: "blocked",
        summary: "Unavailable",
        changedFiles: [],
        checks: [],
        limitations: [],
        eventTypes: [],
        completion: null,
      },
      false,
    );
    await expect(assertBuildAgentHostAvailable(host)).rejects.toMatchObject({
      code: "BUILD_AGENT_UNAVAILABLE",
    });
  });

  it("uses the default host branch before creating a CLI launch run", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "config"));
    copyFileSync("config/policies.yaml", join(root, "config/policies.yaml"));
    const store = new FileWorkflowStore({ rootDir: join(root, ".venture/runs") });
    const unavailableHost = new FakeBuildAgentHost(
      {
        status: "blocked",
        summary: "Unavailable",
        changedFiles: [],
        checks: [],
        limitations: [],
        eventTypes: [],
        completion: null,
      },
      false,
    );
    const services = createDefaultCliServices({
      rootDir: root,
      store,
      buildAgentHost: unavailableHost,
      productCommandRunner: new FakeRunner([]),
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });
    await services.create!({
      brief: resolve("fixtures/web-saas/brief.yaml"),
      json: true,
    });

    await expect(
      services.launch!({
        mode: "apply",
        authorization: "live-commerce-launch",
        runId: "launch-no-build-host",
        json: true,
      }),
    ).rejects.toThrow(/Install the fake host.*No run or external action was created/);
    expect(store.exists("launch-no-build-host")).toBe(false);
    expect(existsSync(join(root, "reports/launch/launch-no-build-host"))).toBe(false);
  });
});
