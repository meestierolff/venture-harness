import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { Redactor, type CommandInvocation, type CommandRunner } from "@/lib/credentials";
import {
  createDefaultCliServices,
  type DefaultCliServicesOptions,
} from "@/lib/cli/default-services";
import { compileLaunchGraph, founderBriefSchema } from "@/lib/launch";
import {
  assertBuildAgentHostAvailable,
  CHILD_DEPENDENCY_INSTALL_ARGS,
  CodexCliBuildAgentHost,
  codexBuildAgentEnvironment,
  productCommandEnvironment,
  createLaunchProductBindings,
  type BuildAgentHost,
  type BuildAgentRequest,
  type BuildAgentResult,
} from "@/lib/runtime";
import {
  FileWorkflowStore,
  WorkflowExecutor,
  workflowNode,
  type WorkflowDefinition,
  type WorkflowHandlerContext,
  type WorkflowNodeDefinition,
} from "@/lib/workflow";

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
      billingMode: this.available ? ("fixture_no_model_execution" as const) : ("unknown" as const),
      billingEvidence: this.available ? ("fixture_attestation" as const) : null,
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

function installTooling(root: string): void {
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(root, "node_modules/.pnpm"), { recursive: true });
  writeFileSync(join(root, "node_modules/.bin/tsc"), "fixture TypeScript shim\n");
  writeFileSync(join(root, "node_modules/.bin/playwright"), "fixture Playwright shim\n");
  copyFileSync(join(root, "pnpm-lock.yaml"), join(root, "node_modules/.pnpm/lock.yaml"));
}

function dependencyInstallNode(): WorkflowNodeDefinition {
  const node = compileLaunchGraph(webBrief).nodes.find(({ id }) => id === "install-dependencies");
  if (!node) throw new Error("web launch graph did not compile install-dependencies");
  return structuredClone(node);
}

function dependencyFinalizationNode(dependencies: readonly string[]): WorkflowNodeDefinition {
  const node = dependencyInstallNode();
  return {
    ...node,
    id: "finalize-dependencies",
    dependencies: [...dependencies],
    idempotencyKey: "launch:fixture:finalize-dependencies",
    evidence: {
      required: true,
      artifact: "reports/quality/dependency-finalization.json",
    },
  };
}

function dependencyWorkflow(nodes: WorkflowNodeDefinition[]): WorkflowDefinition {
  return {
    id: "dependency-bootstrap-regression",
    name: "Dependency bootstrap regression",
    version: "0.2.0",
    nodes,
    maxParallel: 1,
    maxIterations: 20,
    budgets: { dependencies: 0, default: 0, quality: 0 },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex CLI build-agent host", () => {
  it("uses the official shell-free exec argv and sends bounded context only through stdin", async () => {
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
      { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" },
      {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(finalResult) },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 },
            model: "gpt-test-observed",
          }),
        ].join("\n"),
        stderr: "",
      },
    ]);
    const host = new CodexCliBuildAgentHost({
      rootDir: root,
      runner,
      model: "gpt-test-fixed",
    });

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
      usage: {
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 7,
        model: "gpt-test-observed",
        toolCalls: 1,
        failedCommands: 0,
      },
    });
    expect(runner.calls[0]).toMatchObject({ command: "codex", args: ["--version"], cwd: root });
    expect(runner.calls[1]).toMatchObject({
      command: "codex",
      args: ["login", "status"],
      cwd: root,
    });
    expect(runner.calls[2]).toMatchObject({
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        "workspace-write",
        "--ephemeral",
        "--ignore-user-config",
        "--json",
        "--model",
        "gpt-test-fixed",
        "-C",
        root,
        "-",
      ],
      cwd: root,
      sensitiveStdin: true,
    });
    expect(runner.calls[2]?.args.join(" ")).not.toContain("private founder concept");
    expect(runner.calls[2]?.stdin).toContain("private founder concept appears only on stdin");
  });

  it("rejects credential context before execution and rejects malformed Codex output", async () => {
    const root = temporaryRoot();
    const credentialRunner = new FakeRunner([
      { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
      { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" },
    ]);
    const credentialHost = new CodexCliBuildAgentHost({
      rootDir: root,
      runner: credentialRunner,
    });
    await expect(
      credentialHost.run({
        runId: "launch-secret",
        nodeId: "build-core-journey",
        purpose: "Build",
        instructions: "Build",
        context: { api_key: "synthetic-value" },
      }),
    ).rejects.toMatchObject({ code: "credential_material" });
    expect(credentialRunner.calls).toHaveLength(2);

    const malformedRunner = new FakeRunner([
      { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
      { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" },
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
      { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" },
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

  it("attests ChatGPT subscription login and identifies API-key billing", async () => {
    const root = temporaryRoot();
    const subscription = new CodexCliBuildAgentHost({
      rootDir: root,
      runner: new FakeRunner([
        { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
        { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" },
      ]),
    });
    await expect(subscription.inspect()).resolves.toMatchObject({
      status: "available",
      billingMode: "chatgpt_subscription",
      billingEvidence: "codex_login_status",
      nextAction: null,
    });

    const apiKey = new CodexCliBuildAgentHost({
      rootDir: root,
      runner: new FakeRunner([
        { exitCode: 0, stdout: "codex-cli 1.2.3\n", stderr: "" },
        { exitCode: 0, stdout: "Logged in using an API key\n", stderr: "" },
      ]),
    });
    await expect(apiKey.inspect()).resolves.toMatchObject({
      status: "available",
      billingMode: "api_key_metered",
      billingEvidence: "codex_login_status",
      nextAction: expect.stringMatching(/ChatGPT subscription/i),
    });
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

  it("isolates generated-product commands from provider and agent credentials", () => {
    expect(
      productCommandEnvironment(
        {
          NODE_ENV: "test",
          PATH: "/bin",
          HOME: "/founder-home",
          CODEX_HOME: "/founder-codex",
          VERCEL_TOKEN: "provider-secret",
          DATABASE_URL: "postgresql://user:secret@example.test/db",
          NPM_TOKEN: "registry-secret",
        },
        "/venture/.venture/product-command-home",
      ),
    ).toEqual({
      NODE_ENV: "test",
      PATH: "/bin",
      HOME: "/venture/.venture/product-command-home",
      USERPROFILE: "/venture/.venture/product-command-home",
      XDG_CONFIG_HOME: "/venture/.venture/product-command-home/.config",
      npm_config_userconfig: "/venture/.venture/product-command-home/.npmrc",
      NPM_CONFIG_USERCONFIG: "/venture/.venture/product-command-home/.npmrc",
    });
  });

  it("refuses generated-child quality commands without the Core package policy", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "venture.manifest.json"), "{}\n");
    const runner = new FakeRunner([]);
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: new FakeBuildAgentHost({
        status: "blocked",
        summary: "unused",
        changedFiles: [],
        checks: [],
        limitations: [],
        eventTypes: [],
        completion: null,
      }),
      commandRunner: runner,
    });

    await expect(
      bindings.handlers!["launch.verifyLocal"](
        handlerContext("launch-package-policy", "verify-local", "launch.verifyLocal", "none"),
      ),
    ).rejects.toMatchObject({ code: "PACKAGE_EXECUTION_POLICY_INVALID" });
    expect(runner.calls).toEqual([]);
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
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    installTooling(root);
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
        usage: {
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 30,
          toolCalls: 4,
          failedCommands: 0,
        },
      };
      if (request.nodeId === "prepare-repository") {
        writeFileSync(join(root, "app/scaffold.tsx"), "export const scaffold = true;\n");
        writeFileSync(
          join(root, "docs/brand/DESIGN.md"),
          "# Design\n\nDistinct responsive thesis and accessibility constraints.\n",
        );
        writeFileSync(join(root, "app/globals.css"), ":root { --accent: #123456; }\n");
        writeFileSync(
          join(root, "app/page.tsx"),
          "export default function Page() { return <main>Core journey</main>; }\n",
        );
        writeFileSync(
          join(root, "tests/core-journey.test.ts"),
          "// core journey assertions passed\n",
        );
        writeFileSync(
          join(root, "lib/analytics/event-instrumentation.ts"),
          "export const eventPack = ['core_journey_completed'];\n",
        );
        return {
          ...common,
          changedFiles: [
            "app/scaffold.tsx",
            "docs/brand/DESIGN.md",
            "app/globals.css",
            "app/page.tsx",
            "tests/core-journey.test.ts",
            "lib/analytics/event-instrumentation.ts",
          ],
          checks: [
            {
              command: "pnpm test tests/core-journey.test.ts",
              status: "passed",
              evidence: "combined product journey passed",
            },
          ],
          completion: {
            outcome: "changed",
            artifacts: [
              { path: "app/scaffold.tsx", role: "repository_scaffold" },
              { path: "harness.lock", role: "managed_manifest" },
              { path: "docs/brand/DESIGN.md", role: "design_record" },
              { path: "app/globals.css", role: "design_implementation" },
              { path: "app/page.tsx", role: "core_journey" },
              { path: "tests/core-journey.test.ts", role: "affected_test" },
              { path: "config/analytics.yaml", role: "event_contract" },
              {
                path: "lib/analytics/event-instrumentation.ts",
                role: "event_instrumentation",
              },
            ],
            validator: { checkCommand: "pnpm test tests/core-journey.test.ts" },
          },
        };
      }
      if (request.nodeId === "review-product") {
        return {
          ...common,
          changedFiles: [],
          checks: [
            {
              command: "pnpm test tests/core-journey.test.ts",
              status: "passed",
              evidence: "independent journey and responsive review passed",
            },
          ],
          completion: {
            outcome: "already_compliant",
            artifacts: [
              { path: "app/globals.css", role: "design_implementation" },
              { path: "app/page.tsx", role: "core_journey" },
              { path: "tests/core-journey.test.ts", role: "affected_test" },
              {
                path: "lib/analytics/event-instrumentation.ts",
                role: "event_instrumentation",
              },
            ],
            validator: { checkCommand: "pnpm test tests/core-journey.test.ts" },
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
      { exitCode: 0, stdout: "frozen dependencies installed\n", stderr: "" },
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

    const dependencyInstall = await bindings.handlers!["launch.installDependencies"](
      handlerContext("launch-product", "install-dependencies", "launch.installDependencies"),
    );
    expect(dependencyInstall).toMatchObject({
      effectVerified: true,
      output: { frozenLockfile: true, lockfile: "pnpm-lock.yaml" },
    });

    const agentHandlers = [
      ["prepare-repository", "launch.prepareRepository"],
      ["review-product", "launch.reviewProduct"],
    ] as const;
    const agentResults = [];
    for (const [nodeId, handler] of agentHandlers) {
      const context = handlerContext("launch-product", nodeId, handler);
      context.node.cost = { amount: 1, unit: "tasks" };
      context.node.budgetCategory = "launch.build_agent_tasks";
      const result = await bindings.handlers![handler](context);
      agentResults.push(result);
      expect(result.effectVerified).toBe(true);
      expect(JSON.stringify(result.output)).not.toContain(secret);
      expect(result.evidenceArtifact).toBe(`reports/launch/launch-product/product/${nodeId}.json`);
    }

    expect(agentResults[0]?.costs).toEqual([
      expect.objectContaining({
        kind: "model",
        category: "launch.build_agent_tasks",
        amount: 1,
        unit: "tasks",
        budgeted: true,
      }),
      expect.objectContaining({
        kind: "model",
        category: "launch.observed_model_tokens",
        amount: 150,
        unit: "tokens",
        budgeted: false,
        inputTokens: 120,
        outputTokens: 30,
        tool: "fake_build_agent",
        metadata: expect.objectContaining({
          cachedInputTokens: 20,
          contextFileCount: expect.any(Number),
          contextEstimatedTokens: expect.any(Number),
          contextTokenCap: 32_000,
          contextSelectionTruncated: false,
          toolCalls: 4,
          failedCommands: 0,
        }),
      }),
    ]);

    await bindings.handlers!["launch.verifyLocal"](
      handlerContext("launch-product", "verify-local", "launch.verifyLocal", "none"),
    );
    await expect(
      bindings.handlers!["launch.verifyMvp"](
        handlerContext("launch-product", "verify-launch", "launch.verifyMvp", "none"),
      ),
    ).rejects.toMatchObject({ code: "PRIMARY_JOURNEY_CONTRACT_MISSING" });

    expect(host.requests).toHaveLength(2);
    expect(qualityRunner.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      ["pnpm", "verify:fast"],
    ]);
    const evidence = readFileSync(
      join(root, "reports/launch/launch-product/product/review-product.json"),
      "utf8",
    );
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain("Bounded JSON context");
    expect(JSON.parse(evidence)).toMatchObject({
      host: "fake_build_agent",
      rawPromptPersisted: false,
      rawJsonlPersisted: false,
      verifiedChangedFiles: [],
      completionValidator: {
        checkCommand: "pnpm test tests/core-journey.test.ts",
        evidence: "independent journey and responsive review passed",
      },
    });
    expect(existsSync(join(root, "reports/launch/launch-product/product/verify-launch.json"))).toBe(
      false,
    );
    expect(
      JSON.parse(
        readFileSync(
          join(root, "reports/launch/launch-product/product/install-dependencies.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      command: ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      frozenLockfile: true,
      parentWorkspaceIgnored: true,
      lifecycleScriptsDisabled: false,
      installedModulesReadBack: true,
      installedLockfileReadBack: true,
      requiredToolingReadBack: true,
      packageManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      lockfileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      exitCode: 0,
    });
  });

  it("runs every generic seed preflight command in the compiled dependency order", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    installTooling(root);
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "frozen dependencies installed\n", stderr: "" },
      { exitCode: 0, stdout: "typecheck passed\n", stderr: "" },
      { exitCode: 0, stdout: "build passed\n", stderr: "" },
      { exitCode: 0, stdout: "readonly journey passed\n", stderr: "" },
      { exitCode: 0, stdout: "tests passed\n", stderr: "" },
    ]);
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

    await bindings.handlers!["launch.installDependencies"](
      handlerContext("seed-preflight-order", "install-dependencies", "launch.installDependencies"),
    );
    for (const [nodeId, handler] of [
      ["verify-seed-typecheck", "launch.verifySeedTypecheck"],
      ["verify-seed-build", "launch.verifySeedBuild"],
      ["verify-seed-readonly", "launch.verifySeedReadonly"],
      ["verify-seed-tests", "launch.verifySeedTests"],
    ] as const) {
      const result = await bindings.handlers![handler](
        handlerContext("seed-preflight-order", nodeId, handler, "none"),
      );
      expect(result).toMatchObject({
        output: { command: expect.arrayContaining(["pnpm"]), exitCode: 0 },
        evidenceArtifact: `reports/launch/seed-preflight-order/product/${nodeId}.json`,
      });
    }

    expect(runner.calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      ["pnpm", "typecheck"],
      ["pnpm", "build"],
      ["pnpm", "test:e2e:readonly"],
      ["pnpm", "test"],
    ]);
  });

  it("stops a failing generic seed before any Codex request or provider effect", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        calls.push([invocation.command, ...invocation.args]);
        if (invocation.args.join("\u0000") === CHILD_DEPENDENCY_INSTALL_ARGS.join("\u0000")) {
          installTooling(root);
          return { exitCode: 0, stdout: "frozen dependencies installed\n", stderr: "" };
        }
        expect(invocation.args).toEqual(["typecheck"]);
        return { exitCode: 1, stdout: "", stderr: "seed type error\n" };
      },
    };
    const host = new FakeBuildAgentHost({
      status: "completed",
      summary: "must remain unused",
      changedFiles: [],
      checks: [],
      limitations: [],
      eventTypes: [],
      completion: null,
    });
    const productBindings = createLaunchProductBindings({
      rootDir: root,
      brief: webBrief,
      agentHost: host,
      commandRunner: runner,
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });
    const providerEffect = vi.fn(async () => ({ output: { applied: true }, effectVerified: true }));
    const definition = compileLaunchGraph(webBrief);
    const handlers = { ...productBindings.handlers };
    for (const node of definition.nodes.filter(({ kind }) => kind === "provider")) {
      if (node.handler) handlers[node.handler] = providerEffect;
    }
    const executor = new WorkflowExecutor({
      store: new FileWorkflowStore({ rootDir: join(root, "runs") }),
      bindings: { ...productBindings, handlers },
    });

    const state = await executor.start(definition, { runId: "seed-preflight-failure" });

    expect(state.status).toBe("failed");
    expect(state.nodes["verify-seed-typecheck"].error).toMatchObject({
      code: "QUALITY_CHECK_FAILED",
    });
    expect(state.nodes["prepare-repository"].state).toBe("skipped");
    expect(host.requests).toHaveLength(0);
    expect(providerEffect).not.toHaveBeenCalled();
    expect(calls).toEqual([
      ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      ["pnpm", "typecheck"],
    ]);
  });

  it("persists a failed frozen dependency install before any quality command can run", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const runner = new FakeRunner([
      {
        exitCode: 1,
        stdout: "",
        stderr: "ERR_PNPM_OUTDATED_LOCKFILE package.json and pnpm-lock.yaml disagree\n",
      },
    ]);
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

    await expect(
      bindings.handlers!["launch.installDependencies"](
        handlerContext(
          "launch-install-failure",
          "install-dependencies",
          "launch.installDependencies",
        ),
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_INSTALL_FAILED" });
    expect(runner.calls).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(
          join(root, "reports/launch/launch-install-failure/product/install-dependencies.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ exitCode: 1, frozenLockfile: true });
  });

  it("refuses symlinked dependency inputs before invoking pnpm", async () => {
    const root = temporaryRoot();
    const packageTarget = join(root, "package-target.json");
    writeFileSync(packageTarget, "{}\n");
    symlinkSync(packageTarget, join(root, "package.json"));
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const runner = new FakeRunner([]);
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

    await expect(
      bindings.handlers!["launch.installDependencies"](
        handlerContext(
          "launch-symlinked-dependency",
          "install-dependencies",
          "launch.installDependencies",
        ),
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_INSTALL_FAILED" });
    expect(runner.calls).toHaveLength(0);
    expect(
      JSON.parse(
        readFileSync(
          join(
            root,
            "reports/launch/launch-symlinked-dependency/product/install-dependencies.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      exitCode: null,
      invocationError: expect.stringMatching(/package\.json.*regular file/),
    });
  });

  it("reconciles a failed dependency attempt and resumes the same run without starting descendants early", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    let installAttempts = 0;
    const runner: CommandRunner = {
      async run(invocation) {
        expect([invocation.command, ...invocation.args]).toEqual([
          "pnpm",
          ...CHILD_DEPENDENCY_INSTALL_ARGS,
        ]);
        installAttempts += 1;
        if (installAttempts === 1) {
          return { exitCode: 1, stdout: "", stderr: "fixture registry unavailable\n" };
        }
        installTooling(root);
        return { exitCode: 0, stdout: "frozen dependencies installed\n", stderr: "" };
      },
    };
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
    const descendant = vi.fn(() => ({ output: { dependencyReady: true } }));
    bindings.handlers!["fixture.afterInstall"] = descendant;
    const definition = dependencyWorkflow([
      dependencyInstallNode(),
      workflowNode("after-install", {
        dependencies: ["install-dependencies"],
        handler: "fixture.afterInstall",
      }),
    ]);
    const executor = new WorkflowExecutor({
      store: new FileWorkflowStore({ rootDir: join(root, "runs") }),
      bindings,
    });

    let state = await executor.start(definition, { runId: "dependency-failure-resume" });
    expect(state.status).toBe("waiting");
    expect(state.nodes["install-dependencies"]).toMatchObject({
      state: "waiting_for_external_action",
      attempts: 1,
      operation: {
        checkpoint: {
          packageManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          lockfileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(descendant).not.toHaveBeenCalled();

    state = await executor.resume(definition, "dependency-failure-resume");
    expect(state.status).toBe("succeeded");
    expect(state.nodes["install-dependencies"]).toMatchObject({
      state: "succeeded",
      attempts: 2,
      effectVerified: true,
    });
    expect(descendant).toHaveBeenCalledOnce();
    expect(installAttempts).toBe(2);
    expect(
      JSON.parse(
        readFileSync(
          join(
            root,
            "reports/launch/dependency-failure-resume/product/install-dependencies.reconcile.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ state: "not_applied" });
  });

  it("revalidates a successful mutable install and performs one bounded reinstall before quality", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        calls.push([invocation.command, ...invocation.args]);
        if (invocation.args.join("\u0000") === CHILD_DEPENDENCY_INSTALL_ARGS.join("\u0000")) {
          installTooling(root);
          return { exitCode: 0, stdout: "frozen dependencies installed\n", stderr: "" };
        }
        expect(invocation.args).toEqual(["verify:fast"]);
        return { exitCode: 0, stdout: "fast checks passed\n", stderr: "" };
      },
    };
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
    const definition = dependencyWorkflow([
      dependencyInstallNode(),
      workflowNode("repair-checkpoint", {
        kind: "human_approval",
        transport: "human_approval",
        handler: undefined,
        dependencies: ["install-dependencies"],
      }),
      workflowNode("verify-local", {
        capability: "quality.fast",
        dependencies: ["repair-checkpoint"],
        handler: "launch.verifyLocal",
        evidence: { required: true, artifact: "reports/quality/launch-fast.json" },
      }),
    ]);
    const executor = new WorkflowExecutor({
      store: new FileWorkflowStore({ rootDir: join(root, "runs") }),
      bindings,
    });

    let state = await executor.start(definition, { runId: "dependency-repair-resume" });
    expect(state.status).toBe("waiting");
    rmSync(join(root, "node_modules/.bin/tsc"));
    await executor.approve("dependency-repair-resume", "repair-checkpoint", {
      approvedBy: "fixture-founder",
    });
    state = await executor.resume(definition, "dependency-repair-resume");

    expect(state.status).toBe("succeeded");
    expect(calls).toEqual([
      ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      ["pnpm", "verify:fast"],
    ]);
    expect(existsSync(join(root, "node_modules/.bin/tsc"))).toBe(true);
  });

  it("checkpoints a coherent dependency change after product planning before quality", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\ninitial: true\n");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        calls.push([invocation.command, ...invocation.args]);
        if (invocation.args.join("\u0000") === CHILD_DEPENDENCY_INSTALL_ARGS.join("\u0000")) {
          installTooling(root);
          return { exitCode: 0, stdout: "frozen dependencies installed\n", stderr: "" };
        }
        expect(invocation.args).toEqual(["verify:fast"]);
        return { exitCode: 0, stdout: "fast checks passed\n", stderr: "" };
      },
    };
    const productBindings = createLaunchProductBindings({
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
    const definition = dependencyWorkflow([
      dependencyInstallNode(),
      workflowNode("plan-dependency-change", {
        capability: "product.dependencies",
        dependencies: ["install-dependencies"],
        handler: "fixture.planDependencyChange",
        effect: "local_write",
      }),
      dependencyFinalizationNode(["plan-dependency-change"]),
      workflowNode("verify-local", {
        capability: "quality.fast",
        dependencies: ["finalize-dependencies"],
        handler: "launch.verifyLocal",
        evidence: { required: true, artifact: "reports/quality/launch-fast.json" },
      }),
    ]);
    const executor = new WorkflowExecutor({
      store: new FileWorkflowStore({ rootDir: join(root, "runs") }),
      bindings: {
        ...productBindings,
        handlers: {
          ...productBindings.handlers,
          "fixture.planDependencyChange": async () => {
            writeFileSync(
              join(root, "package.json"),
              '{"dependencies":{"reviewed-dependency":"1.0.0"}}\n',
            );
            writeFileSync(
              join(root, "pnpm-lock.yaml"),
              "lockfileVersion: '9.0'\nreviewed-dependency: 1.0.0\n",
            );
            return {
              output: { dependencyPlan: "reviewed-dependency@1.0.0" },
              effectVerified: true,
            };
          },
        },
      },
    });

    const state = await executor.start(definition, { runId: "dependency-finalization" });

    expect(state.status).toBe("succeeded");
    expect(state.nodes["finalize-dependencies"]).toMatchObject({
      state: "succeeded",
      effectVerified: true,
    });
    expect(calls).toEqual([
      ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      ["pnpm", "verify:fast"],
    ]);
  });

  it("fails closed without reinstalling when checkpointed dependency inputs change", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    let calls = 0;
    const runner: CommandRunner = {
      async run(invocation) {
        calls += 1;
        expect(invocation.args).toEqual([...CHILD_DEPENDENCY_INSTALL_ARGS]);
        installTooling(root);
        return { exitCode: 0, stdout: "frozen dependencies installed\n", stderr: "" };
      },
    };
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
    const definition = dependencyWorkflow([
      dependencyInstallNode(),
      dependencyFinalizationNode(["install-dependencies"]),
      workflowNode("input-review", {
        kind: "human_approval",
        transport: "human_approval",
        handler: undefined,
        dependencies: ["finalize-dependencies"],
      }),
      workflowNode("verify-local", {
        capability: "quality.fast",
        dependencies: ["input-review"],
        handler: "launch.verifyLocal",
        evidence: { required: true, artifact: "reports/quality/launch-fast.json" },
      }),
    ]);
    const executor = new WorkflowExecutor({
      store: new FileWorkflowStore({ rootDir: join(root, "runs") }),
      bindings,
    });

    let state = await executor.start(definition, { runId: "dependency-input-change" });
    expect(state.status).toBe("waiting");
    writeFileSync(join(root, "package.json"), '{"dependencies":{"unexpected":"1.0.0"}}\n');
    await executor.approve("dependency-input-change", "input-review", {
      approvedBy: "fixture-founder",
    });
    state = await executor.resume(definition, "dependency-input-change");

    expect(state.status).toBe("failed");
    expect(state.nodes["verify-local"].error).toMatchObject({
      code: "DEPENDENCY_INPUT_CHANGED",
    });
    expect(calls).toBe(2);
  });

  it("refuses generic browser smoke as production journey proof without a Launch Contract", async () => {
    const root = temporaryRoot();
    const runner = new FakeRunner([{ exitCode: 0, stdout: "2 passed\n", stderr: "" }]);
    const bindings = createLaunchProductBindings({
      rootDir: root,
      brief: founderBriefSchema.parse({ ...webBrief, domain: "example.com" }),
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

    await expect(bindings.handlers!["launch.verifyProduction"](context)).rejects.toMatchObject({
      code: "PRIMARY_JOURNEY_CONTRACT_MISSING",
    });
    expect(runner.calls).toEqual([]);
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
    ).toMatchObject({
      status: "rolled_back_after_failure",
      rollbackRestored: true,
      originalErrorCode: "BUILD_AGENT_EVIDENCE_INVALID",
    });
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
      JSON.parse(
        readFileSync(
          join(root, "reports/launch/launch-missing-role/product/build-core-journey.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      status: "rolled_back_after_failure",
      rollbackRestored: true,
      originalErrorCode: "BUILD_AGENT_EVIDENCE_INVALID",
    });
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
      JSON.parse(
        readFileSync(
          join(root, "reports/launch/launch-irrelevant-check/product/build-core-journey.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      status: "rolled_back_after_failure",
      rollbackRestored: true,
      originalErrorCode: "BUILD_AGENT_EVIDENCE_INVALID",
    });
  });

  it.each(["symbolic link", "hard link"] as const)(
    "rejects an untrusted %s before accepting model-authored source",
    async (entryKind) => {
      const root = temporaryRoot();
      const outside = temporaryRoot();
      mkdirSync(join(root, "public"), { recursive: true });
      const canary = join(outside, "private-canary.txt");
      writeFileSync(canary, "outside-private-canary\n");
      const host = new FakeBuildAgentHost(() => {
        const target = join(root, "public/leak.txt");
        if (entryKind === "symbolic link") symlinkSync(canary, target);
        else linkSync(canary, target);
        return {
          status: "blocked",
          summary: "Unsafe fixture entry created.",
          changedFiles: [],
          checks: [],
          limitations: ["fixture"],
          eventTypes: [],
          completion: null,
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
          handlerContext(
            `launch-${entryKind.replace(" ", "-")}`,
            "build-core-journey",
            "launch.buildCoreJourney",
          ),
        ),
      ).rejects.toMatchObject({ code: "BUILD_AGENT_UNSAFE_FILE_ENTRY" });
    },
  );

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

  it.each(["buildAgentHost", "ideaSharpenerHost"] as const)(
    "refuses a caller-injected %s on the production services factory",
    (field) => {
      const run = vi.fn();
      const options = {
        rootDir: temporaryRoot(),
        [field]: { id: "caller-controlled-host", run },
      } as unknown as DefaultCliServicesOptions;

      expect(() => createDefaultCliServices(options)).toThrow(
        /do not accept caller-injected model hosts/i,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("uses the default host branch before creating a CLI launch run", async () => {
    const root = temporaryRoot();
    vi.spyOn(CodexCliBuildAgentHost.prototype, "inspect").mockResolvedValue({
      host: "codex_cli",
      status: "missing",
      version: null,
      billingMode: "unknown",
      billingEvidence: null,
      nextAction: "Install and authenticate the Codex CLI, then rerun the same launch command.",
    });
    mkdirSync(join(root, "config"));
    copyFileSync("config/policies.yaml", join(root, "config/policies.yaml"));
    copyFileSync("config/providers.yaml", join(root, "config/providers.yaml"));
    const store = new FileWorkflowStore({ rootDir: join(root, ".venture/runs") });
    const services = createDefaultCliServices({
      rootDir: root,
      store,
      productCommandRunner: new FakeRunner([]),
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });
    await services.create!({
      brief: resolve("fixtures/ideas/synthetic-founder-web.md"),
      json: true,
    });

    await expect(
      services.launch!({
        mode: "apply",
        authorization: "live-commerce-launch",
        runId: "launch-no-build-host",
        json: true,
      }),
    ).rejects.toThrow(/Install and authenticate the Codex CLI.*No run or external action/i);
    expect(store.exists("launch-no-build-host")).toBe(false);
    expect(existsSync(join(root, "reports/launch/launch-no-build-host"))).toBe(false);
  });
});
