import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo, type CliResumeRequest } from "../lib/cli";
import { createDefaultCliServices } from "../lib/cli/default-services";
import type { CommandRunner } from "../lib/credentials";
import {
  FileWorkflowStore,
  WorkflowExecutor,
  type WorkflowDefinition,
  workflowNode,
} from "../lib/workflow";

const temporaryDirectories: string[] = [];

function context() {
  const directory = mkdtempSync(join(tmpdir(), "vh-cli-test-"));
  temporaryDirectories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const store = new FileWorkflowStore({ rootDir: join(directory, "runs") });
  return { directory, io, stdout, stderr, store };
}

function definition(): WorkflowDefinition {
  return {
    id: "cli-graph",
    name: "CLI graph",
    version: "1",
    nodes: [
      workflowNode("manual", {
        purpose: "Confirm the unavoidable manual action",
        kind: "manual_action",
        transport: "manual",
        handler: undefined,
      }),
    ],
    maxParallel: 1,
    maxIterations: 10,
    budgets: {},
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("vh CLI", () => {
  it("shows the complete command surface", async () => {
    const { io, stdout, store } = context();

    const result = await runCli(["--help"], { io, store });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("vh plan");
    expect(stdout.join("\n")).toContain("vh launch --dry-run");
    expect(stdout.join("\n")).toContain("vh status");
    expect(stdout.join("\n")).toContain("vh resume");
    expect(stdout.join("\n")).toContain("vh cancel");
    expect(stdout.join("\n")).toContain("vh explain");
    expect(stdout.join("\n")).toContain("vh data sync");
    expect(stdout.join("\n")).toContain("vh learn daily|weekly|biweekly|monthly");
  });

  it("requires a selected brief instead of faking a plan", async () => {
    const { io, stderr, store } = context();

    const result = await runCli(["plan"], { io, store });

    expect(result.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("No founder brief is selected");
    expect(stderr.join("\n")).toContain("vh create --brief");
  });

  it("requires an authorization profile before launch apply", async () => {
    const { io, stderr, store } = context();
    let launched = false;

    const result = await runCli(["launch", "--apply"], {
      io,
      store,
      services: { launch: () => void (launched = true) as never },
    });

    expect(result.exitCode).toBe(2);
    expect(launched).toBe(false);
    expect(stderr.join("\n")).toContain("requires --authorization");
  });

  it("delegates a dry run through an injected launch service", async () => {
    const { io, stdout, store } = context();

    const result = await runCli(["launch", "--dry-run", "--json"], {
      io,
      store,
      services: {
        launch: (request) => ({ mode: request.mode, effects: [], manualActions: [] }),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout[0])).toEqual({ mode: "dry-run", effects: [], manualActions: [] });
  });

  it("reads durable status and explains a node without loading integrations", async () => {
    const { io, stdout, store } = context();
    const executor = new WorkflowExecutor({ store });
    executor.create(definition(), { runId: "cli-run" });

    let result = await runCli(["status", "cli-run"], { io, store });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.pop()!).runId).toBe("cli-run");

    result = await runCli(["explain", "cli-run", "manual"], { io, store });
    expect(result.exitCode).toBe(0);
    const explanation = JSON.parse(stdout.pop()!);
    expect(explanation.purpose).toBe("Confirm the unavoidable manual action");
    expect(explanation.state).toBe("pending");
    expect(explanation.transport).toBe("manual");
  });

  it("parses an exact one-shot checkpoint grant and rejects incomplete scope", async () => {
    const { io, stderr, store } = context();
    new WorkflowExecutor({ store }).create(definition(), { runId: "grant-run" });
    let captured: CliResumeRequest | undefined;
    const services = {
      resume: (request: CliResumeRequest) => {
        captured = request;
        return store.load(request.runId);
      },
    };

    const result = await runCli(
      [
        "resume",
        "grant-run",
        "--grant",
        "manual",
        "--effect",
        "external_delete",
        "--operation",
        "github.repository.delete.fixture",
        "--evidence",
        "reports/launch/grant-run/checkpoints/delete.json",
      ],
      { io, store, services },
    );

    expect(result.exitCode).toBe(0);
    expect(captured).toMatchObject({
      runId: "grant-run",
      nodeId: "manual",
      resolutionKind: "checkpoint_grant",
      effect: "external_delete",
      operationId: "github.repository.delete.fixture",
      evidenceArtifact: "reports/launch/grant-run/checkpoints/delete.json",
    });

    captured = undefined;
    const incomplete = await runCli(
      [
        "resume",
        "grant-run",
        "--grant",
        "manual",
        "--effect",
        "external_delete",
        "--evidence",
        "reports/launch/grant-run/checkpoints/delete.json",
      ],
      { io, store, services },
    );
    expect(incomplete.exitCode).toBe(2);
    expect(captured).toBeUndefined();
    expect(stderr.at(-1)).toContain("--operation");
  });

  it("persists cancellation when no provider runtime is injected", async () => {
    const { io, stdout, stderr, store } = context();
    const executor = new WorkflowExecutor({ store });
    executor.create(definition(), { runId: "cancel-run" });

    const result = await runCli(["cancel", "cancel-run"], { io, store, services: {} });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout[0]).status).toBe("cancelled");
    expect(store.load("cancel-run").status).toBe("cancelled");
    expect(stderr.join("\n")).toContain("compensation");
  });

  it("provides default local provider and CLI doctor evidence without live calls", async () => {
    const { directory, io, stdout, store } = context();
    mkdirSync(join(directory, "config"), { recursive: true });
    for (const file of ["providers.yaml", "venture.yaml", "mobile.yaml", "offer.yaml"]) {
      copyFileSync(join("config", file), join(directory, "config", file));
    }
    const runner: CommandRunner = {
      async run(invocation) {
        throw Object.assign(new Error(`spawn ${invocation.command} ENOENT`), { code: "ENOENT" });
      },
    };
    const services = createDefaultCliServices({
      rootDir: directory,
      store,
      providerCommandRunner: runner,
    });

    const result = await runCli(["doctor"], { io, store, services });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(stdout[0]);
    expect(report.providerChecks).toHaveLength(12);
    expect(
      report.cliPrerequisites.every(({ status }: { status: string }) => status === "missing"),
    ).toBe(true);
    expect(report.manualOnlyProviders).toEqual(expect.arrayContaining(["dns", "mijndomein"]));
    expect(report.providerChecksStatus).toContain("remote readiness");
    expect(report.providerFactoryInspection).toContain("complete-or-fail");
  });
});
