import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const founderConfigPath = join(directory, "founder.json");
  return { directory, io, stdout, stderr, store, founderConfigPath };
}

/**
 * Configure an isolated ventures root.
 *
 * Without this the CLI reads the real user config, so Stack output depends on
 * whether the machine running the test happens to have a ventures root set.
 */
function withVenturesRoot(directory: string, founderConfigPath: string): string {
  const venturesRoot = join(directory, "ventures");
  mkdirSync(venturesRoot, { recursive: true });
  writeFileSync(founderConfigPath, `${JSON.stringify({ schemaVersion: 1, venturesRoot })}\n`);
  return venturesRoot;
}

const FIXTURE_STACK_SESSIONS = [
  { provider: "github", installed: true, authenticated: true, account: "fixture-founder" },
  { provider: "vercel", installed: true, authenticated: true, account: "fixture-team" },
  {
    provider: "stripe",
    installed: true,
    authenticated: true,
    account: "acct_fixture_test",
    mode: "test",
  },
] as const;

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

  it("persists the credential-free Stack draft before reporting doctor actions", async () => {
    const { directory, io, stdout, store, founderConfigPath } = context();
    withVenturesRoot(directory, founderConfigPath);
    let received: unknown;

    const result = await runCli(["stack", "connect", "founder-default", "--json"], {
      io,
      store,
      founderConfigPath,
      stackSessions: FIXTURE_STACK_SESSIONS,
      services: {
        stack: (request) => {
          received = request;
          return {
            schemaVersion: 1,
            status: "attention_required",
            launchReady: false,
            unresolvedActions: [
              {
                role: "database.postgres",
                providerId: "neon",
                why: "neon is unconfigured.",
                command: "vh auth login neon --ref cred://neon/founder-default",
                blocksLaunch: true,
              },
            ],
          };
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(received).toMatchObject({
      action: "connect",
      profileId: "founder-default",
      credentialWrites: [],
      updatedRoles: ["source.repository", "hosting.web"],
      replaceOptionalRoles: false,
      updateWritableCredentialBackend: false,
      connection: {
        ownerOrganizationId: "fixture-founder",
        selectedOptionalRoles: [
          "email.transactional",
          "growth.google",
          "search.bing",
          "dns.records",
        ],
        inspectedCliSessions: {
          github: { accountId: "fixture-founder", authenticated: true },
          vercel: { accountId: "fixture-team", authenticated: true },
          stripe: { accountId: "acct_fixture_test", authenticated: true, mode: "test" },
        },
        roles: {
          "source.repository": { credentialRef: "cred://github/founder-default" },
          "hosting.web": { credentialRef: "cred://vercel/founder-default" },
          "commerce.web": { verification: { status: "unverified" } },
        },
      },
    });
    expect(JSON.parse(stdout[0])).toMatchObject({
      command: "stack.connect",
      saved: true,
      status: "attention_required",
      launchReady: false,
      unresolvedActions: [
        expect.objectContaining({
          role: "database.postgres",
          command: "vh auth login neon --ref cred://neon/founder-default",
        }),
      ],
    });
  });

  it("blocks launch readiness while no ventures root is configured", async () => {
    const { io, stdout, store, founderConfigPath } = context();

    const result = await runCli(["stack", "connect", "founder-default", "--json"], {
      io,
      store,
      founderConfigPath,
      stackSessions: FIXTURE_STACK_SESSIONS,
      services: {
        stack: () => ({
          schemaVersion: 1,
          status: "ready",
          launchReady: true,
          unresolvedActions: [],
        }),
      },
    });

    // Every provider is ready, so the ventures root is the only thing standing
    // between this Stack and a launch that has somewhere safe to materialize.
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdout[0])).toMatchObject({
      command: "stack.connect",
      saved: true,
      venturesRoot: null,
      launchReady: false,
      unresolvedActions: [
        {
          role: "workspace",
          provider: "local",
          command: "vh config set ventures-root <absolute-path>",
          blocksLaunch: true,
        },
      ],
    });
  });

  it("collects guided Stack secrets only through deferred hidden broker writes", async () => {
    const { io, stdout, store } = context();
    const visible = ["no", "no", "no", "fixture-neon-org", "aws-eu-central-1"];
    const hidden = ["fixture-neon-hidden", "fixture-stripe-hidden"];
    const stored: Array<{ provider: string; value: string }> = [];
    let received: unknown;

    const result = await runCli(
      ["stack", "connect", "founder-default", "--credential-backend", "macos_keychain"],
      {
        io,
        store,
        stackSessions: [
          { provider: "github", installed: true, authenticated: true, account: "fixture-founder" },
          { provider: "vercel", installed: true, authenticated: true, account: "fixture-team" },
          {
            provider: "stripe",
            installed: true,
            authenticated: true,
            account: "acct_fixture_test",
            mode: "test",
          },
        ],
        stackPrompt: {
          isTty: true,
          write: () => undefined,
          readVisible: async () => visible.shift() ?? "",
          readCredential: async () => hidden.shift() ?? "",
        },
        services: {
          stack: async (request) => {
            received = request;
            for (const pending of request.credentialWrites ?? []) {
              stored.push({ provider: pending.provider, value: await pending.readValue() });
            }
            return {
              schemaVersion: 1,
              status: "attention_required",
              launchReady: false,
              unresolvedActions: [],
            };
          },
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(received).toMatchObject({
      updatedRoles: ["source.repository", "hosting.web", "database.postgres", "commerce.web"],
      replaceOptionalRoles: true,
      connection: { selectedOptionalRoles: ["dns.records"] },
      credentialWrites: [
        expect.objectContaining({ provider: "neon", backend: "macos_keychain" }),
        expect.objectContaining({ provider: "stripe", backend: "macos_keychain" }),
      ],
    });
    expect(stored).toEqual([
      { provider: "neon", value: "fixture-neon-hidden" },
      { provider: "stripe", value: "fixture-stripe-hidden" },
    ]);
    expect(JSON.stringify({ received, stdout })).not.toContain("fixture-neon-hidden");
  });

  it("keeps non-interactive auth credential-free and rejects credential-shaped argv", async () => {
    const { io, stdout, stderr, store } = context();
    let received: unknown;
    const result = await runCli(
      [
        "auth",
        "login",
        "stripe",
        "--backend",
        "onepassword",
        "--ref",
        "cred://stripe/founder-default",
        "--json",
      ],
      {
        io,
        store,
        stackPrompt: {
          isTty: true,
          write: () => undefined,
          readVisible: async () => {
            throw new Error("visible prompt must not run");
          },
          readCredential: async () => {
            throw new Error("hidden prompt must not run");
          },
        },
        services: {
          auth: (request) => {
            received = request;
            return { status: "hidden_input_required", valuesExposed: false };
          },
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(received).toMatchObject({
      action: "login",
      provider: "stripe",
      backend: "onepassword",
      kind: "restricted_api_key",
    });
    expect(received).not.toHaveProperty("readValue");
    expect(JSON.parse(stdout[0])).toMatchObject({
      status: "hidden_input_required",
      valuesExposed: false,
    });

    const refused = await runCli(["auth", "login", "stripe", "sk_test_fixture_argv"], {
      io,
      store,
      services: { auth: () => ({}) },
    });
    expect(refused.exitCode).toBe(2);
    expect(stderr.at(-1)).toContain("never accepts a credential value as an argument");
  });

  it("returns nonzero when a remote credential test does not pass", async () => {
    const { io, stdout, store } = context();
    const failed = await runCli(["auth", "test", "stripe", "--json"], {
      io,
      store,
      services: {
        auth: () => ({
          tested: [
            {
              ref: "cred://stripe/founder-default",
              mode: "remote_tester",
              result: { ok: false, message: "stripe credential did not prove test mode" },
            },
          ],
          allPassed: false,
          valuesExposed: false,
        }),
      },
    });

    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(stdout[0])).toMatchObject({ allPassed: false, valuesExposed: false });

    const passed = await runCli(["auth", "test", "stripe", "--json"], {
      io,
      store,
      services: {
        auth: () => ({
          tested: [
            {
              ref: "cred://stripe/founder-default",
              mode: "remote_tester",
              result: { ok: true, providerMode: "test" },
            },
          ],
          allPassed: true,
          valuesExposed: false,
        }),
      },
    });
    expect(passed.exitCode).toBe(0);
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
