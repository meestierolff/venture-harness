import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo, type CliServices } from "@/lib/cli";
import {
  createDefaultCliServices,
  type DefaultCliServicesOptions,
  type LaunchBindingContext,
} from "@/lib/cli/default-services";
import { createDefaultProviderPlanFactories } from "@/lib/cli/default-provider-runtime";
import { parseHarnessLock } from "@/lib/config/harness-lock";
import { CredentialBroker, MemoryCredentialBackend, type CredentialKind } from "@/lib/credentials";
import {
  parseFounderStackConnection,
  type FounderStackConnection,
  type FounderStackProviderId,
  type FounderStackRole,
  founderStackRoleDefinitions,
} from "@/lib/founder-launch";
import type { MigrationFileSystem } from "@/lib/migrations";
import { CommandProviderTransport, HttpProviderTransport } from "@/lib/providers";
import {
  createLaunchProductBindings,
  createOfficialProviderContext,
  FileProviderIdempotencyLedger,
  FileProviderLifecycleStore,
  ProviderPlanFactoryPrerequisiteError,
  type ProviderWorkflowPlanFactory,
} from "@/lib/runtime";
import { applyUpgrade, type HarnessRelease } from "@/lib/upgrade";
import { FileWorkflowStore } from "@/lib/workflow";
import { runVhShell } from "../../scripts/vh-bundle";
import {
  FounderGoldenPathBuildAgentFixture,
  FounderGoldenPathProductCommandFixture,
} from "./founder-golden-path-product";
import { FounderGoldenPathOfficialTransportFixture } from "./founder-golden-path-runtime";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-08-09T12:00:00.000Z");
const IDEA_FIXTURE = resolve(REPOSITORY_ROOT, "fixtures/ideas/synthetic-founder-web.md");
const STACK_FIXTURE = resolve(REPOSITORY_ROOT, "fixtures/founder-stack/founder-default.json");
const CHILD_OUTPUT = "ventures/exception-desk";

const CREDENTIAL_KINDS: Record<Exclude<FounderStackProviderId, "dns">, CredentialKind> = {
  github: "restricted_api_key",
  vercel: "api_key",
  neon: "api_key",
  stripe: "restricted_api_key",
  revenuecat: "restricted_api_key",
  brevo: "api_key",
  google: "oauth",
  bing: "api_key",
};

const PROTECTED_VENTURE_PATHS = [
  "src/product/founder-contract.json",
  "docs/brand/DESIGN.md",
  "src/design/theme.css",
  "app/globals.css",
  "app/page.tsx",
  "app/exception-desk-client.tsx",
  "src/product/exception-desk.mjs",
  "src/product/exception-desk.d.mts",
  "src/analytics/exception-desk-events.mjs",
  "src/analytics/exception-desk-events.d.mts",
  "tests/founder-scaffold.test.mjs",
  "tests/design-contract.test.mjs",
  "tests/exception-desk-journey.test.mjs",
  "tests/exception-desk-events.test.mjs",
] as const;

interface ShellCallResult {
  args: string[];
  exitCode: number;
  value: unknown;
  stderr: string[];
}

export interface SyntheticFounderGoldenPathOptions {
  rootDir: string;
  ideaFixture?: string;
  githubAuthWaitResume?: boolean;
}

export interface SyntheticFounderGoldenPathResult {
  status: "verified_fixture";
  fixtureLabel: "synthetic-founder-golden-path";
  rootDir: string;
  childRoot: string;
  runId: string;
  workflowStatus: "succeeded";
  launchReport: { json: string; markdown: string; overallState: "succeeded" };
  lifecycle: {
    stackDoctor: "ready";
    ideaCompile: "ready";
    launchGrant: "issued_for_apply";
    firstApply: "succeeded" | "waiting_for_auth";
    authResume: "not_required" | "same_command_succeeded";
    customDomain: "deferred_nonblocking";
    replay: "idempotent";
    coreUpgrade: "0.2.0_to_0.2.1";
  };
  proof: {
    rootCliArgv: string[][];
    officialTransports: { cli: string; http: string };
    providerPlans: Array<{
      provider: string;
      adapterConstructor: string;
      capabilities: string[];
    }>;
    providerInvocationCount: number;
    providerEvidenceCount: number;
    productTasks: string[];
    productCommands: string[][];
    repository: { remote: string; commit: string; tree: string };
    migration: { command: string; cwd: string; readBack: true };
    deployment: { url: string; customDomain: null; environmentVariables: string[] };
    primaryJourney: { signal: "invoice_draft_confirmed"; directTests: "passed" };
    upgrade: { dryRun: "planned"; apply: "applied"; preservedPaths: string[] };
    durableIdempotencyLedger: string;
    fixtureProvenance: string[];
    blockingResume: null | {
      waitingNode: "github-repository";
      sameChildIdentity: true;
      materializationUnchanged: true;
      sameRunId: true;
      sameLaunchGrant: true;
      completedProviderOperationsPreserved: true;
      buildCallsPreserved: true;
      replayZeroEffect: true;
    };
    secretsPersisted: false;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relativeFile(root: string, path: string): string {
  const target = resolve(root, path);
  const child = relative(root, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || child.startsWith(sep)) {
    throw new Error(`Path escapes fixture root: ${path}`);
  }
  return target;
}

class DiskUpgradeFileSystem implements MigrationFileSystem {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #target(path: string): string {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`Unsafe upgrade path: ${path}`);
    }
    return relativeFile(this.#root, path);
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(this.#target(path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    const target = this.#target(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.upgrade-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  }

  async remove(path: string): Promise<void> {
    await unlink(this.#target(path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function invokeRootCli(input: {
  args: readonly string[];
  services: CliServices;
  store: FileWorkflowStore;
}): Promise<ShellCallResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  const exitCode = await runVhShell(input.args, {
    io,
    founderRunner: (args, options) =>
      runCli([...args], { io: options.io, services: input.services, store: input.store }),
  });
  let value: unknown = null;
  if (stdout.length > 0) {
    const output = stdout.join("\n");
    try {
      value = JSON.parse(output) as unknown;
    } catch {
      value = output;
    }
  }
  if (exitCode !== 0) {
    let workflowDiagnostic: string | null = null;
    try {
      const response = record(value, "failed founder CLI response");
      const childRoot = stringValue(response.childRoot, "failed founder child root");
      const runId = stringValue(response.runId, "failed founder run id");
      const state = new FileWorkflowStore({ rootDir: resolve(childRoot, ".venture/runs") }).load(
        runId,
      );
      workflowDiagnostic = Object.entries(state.nodes)
        .filter(([, node]) => node.state !== "succeeded")
        .map(
          ([id, node]) =>
            `${id}=${node.state}${node.error ? ` (${node.error.code}: ${node.error.message})` : ""}`,
        )
        .join(", ");
      const failedEvidence = Object.entries(state.nodes)
        .filter(([, node]) => node.error)
        .flatMap(([id, node]) => {
          try {
            const evidenceReference =
              node.evidenceArtifact ?? `reports/launch/${runId}/product/${id}.json`;
            const evidence = readFileSync(resolve(childRoot, evidenceReference), "utf8");
            return [`${id} evidence: ${evidence.slice(-4_000)}`];
          } catch {
            return [];
          }
        })
        .join("\n");
      if (failedEvidence) workflowDiagnostic += `\n${failedEvidence}`;
    } catch {
      // The original CLI output remains authoritative when no workflow state exists.
    }
    throw new Error(
      [
        `root vh ${input.args.join(" ")} exited ${exitCode}`,
        workflowDiagnostic ? `Workflow diagnostic: ${workflowDiagnostic}` : null,
        ...stderr,
        stdout.length > 0 ? stdout.join("\n") : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return { args: [...input.args], exitCode, value, stderr };
}

async function credentialBrokerFor(connection: FounderStackConnection): Promise<{
  broker: CredentialBroker;
  fixtureSecrets: string[];
}> {
  const broker = new CredentialBroker([new MemoryCredentialBackend()]);
  const fixtureSecrets: string[] = [];
  for (const role of Object.keys(founderStackRoleDefinitions) as FounderStackRole[]) {
    const provider = founderStackRoleDefinitions[role].providerId;
    const selected = connection.roles[role];
    if (provider === "dns" || !selected.credentialRef) continue;
    const value = `fixture-${provider}-credential-value-${createHash("sha256")
      .update(selected.credentialRef)
      .digest("hex")
      .slice(0, 16)}`;
    fixtureSecrets.push(value);
    await broker.store({
      ref: selected.credentialRef,
      provider,
      kind: CREDENTIAL_KINDS[provider],
      backend: "memory",
      scopes: selected.scopes,
      accountId: selected.accountId ?? selected.teamId ?? selected.organizationId,
      expiresAt: selected.expiresAt,
      testedAt: NOW.toISOString(),
      testStatus: "passed",
      ...(provider === "stripe" ? { providerMode: "test" as const } : {}),
      value,
    });
  }
  return { broker, fixtureSecrets };
}

function directJourneyCheck(childRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "tests/seed-contract.test.mjs",
      "tests/design-contract.test.mjs",
      "tests/exception-desk-journey.test.mjs",
      "tests/exception-desk-events.test.mjs",
    ],
    { cwd: childRoot, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      ["Direct founder journey tests failed", result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function git(childRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: childRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function readableRepositoryText(root: string): string {
  const chunks: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && [".git", ".next", "node_modules"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) chunks.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return chunks.join("\n");
}

function providerFactoriesFor(
  context: LaunchBindingContext,
  transportFixture: FounderGoldenPathOfficialTransportFixture,
  githubAuthReady: () => boolean,
  executionCounts: Map<string, number>,
): Readonly<Record<string, ProviderWorkflowPlanFactory>> {
  const defaults = createDefaultProviderPlanFactories({
    rootDir: context.rootDir,
    brief: context.brief,
    definition: context.definition,
    ...(context.launchContract ? { launchContract: context.launchContract } : {}),
    lifecycleStore: new FileProviderLifecycleStore(
      resolve(context.rootDir, ".venture/provider-lifecycle.json"),
    ),
  });
  return Object.fromEntries(
    Object.entries(defaults).map(([handler, factory]) => [
      handler,
      async (workflow) => {
        if (workflow.runId !== "doctor-plan-only") {
          executionCounts.set(handler, (executionCounts.get(handler) ?? 0) + 1);
        }
        if (
          handler === "provider.github-repository" &&
          workflow.runId !== "doctor-plan-only" &&
          !githubAuthReady()
        ) {
          throw new ProviderPlanFactoryPrerequisiteError(
            "Authenticate the configured GitHub account, then rerun the exact founder apply command.",
            "auth",
          );
        }
        return transportFixture.register(await factory(workflow));
      },
    ]),
  );
}

export async function runSyntheticFounderGoldenPath(
  options: SyntheticFounderGoldenPathOptions,
): Promise<SyntheticFounderGoldenPathResult> {
  const rootDir = resolve(options.rootDir);
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  if (readdirSync(rootDir).length > 0) {
    throw new Error("Synthetic founder Golden Path root must be empty");
  }
  const ideaSource = resolve(options.ideaFixture ?? IDEA_FIXTURE);
  copyFileSync(ideaSource, resolve(rootDir, "idea.md"));
  copyFileSync(STACK_FIXTURE, resolve(rootDir, "founder-default.json"));

  const connection = parseFounderStackConnection(JSON.parse(readFileSync(STACK_FIXTURE, "utf8")));
  const { broker, fixtureSecrets } = await credentialBrokerFor(connection);
  // Production containment resolves the configured ventures root through the
  // filesystem before returning a child path. Mirror that contract here so
  // macOS' /var -> /private/var alias cannot create a false Golden Path drift.
  const childRoot = resolve(realpathSync(rootDir), CHILD_OUTPUT);
  const providerFixtureRoot = resolve(rootDir, ".fixture-provider-state");
  const transportFixture = new FounderGoldenPathOfficialTransportFixture({
    fixtureRoot: providerFixtureRoot,
    expectedChildRoot: childRoot,
  });
  const buildAgent = new FounderGoldenPathBuildAgentFixture(childRoot);
  const productCommands = new FounderGoldenPathProductCommandFixture(childRoot);
  const stackRoot = resolve(rootDir, ".founder-stack-state");
  const catalogPath = resolve(rootDir, ".credential-catalog.json");
  const rootLedger = resolve(rootDir, ".root-provider-idempotency.json");
  const rootProviderRuntime = createOfficialProviderContext({
    commandRunner: transportFixture,
    httpFetcher: transportFixture,
    commandAvailable: async () => ({
      available: true,
      detail: "fixture-backed official command transport",
    }),
    httpAvailable: async () => ({
      available: true,
      detail: "fixture-backed official HTTP transport",
    }),
    credentials: broker,
    redactor: broker.redactor,
    idempotencyLedger: new FileProviderIdempotencyLedger(rootLedger),
  });
  const commandTransport = rootProviderRuntime.transports.cli;
  const httpTransport = rootProviderRuntime.transports.http;
  assert.ok(commandTransport instanceof CommandProviderTransport);
  assert.ok(httpTransport instanceof HttpProviderTransport);

  const workflowRefSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  assert.match(workflowRefSha, /^[a-f0-9]{40}$/u);

  let executionTime = NOW;
  let githubAuthReady = !options.githubAuthWaitResume;
  const providerFactoryExecutionCounts = new Map<string, number>();
  const commonOptions: Omit<DefaultCliServicesOptions, "rootDir" | "store"> = {
    founderStackRoot: stackRoot,
    founderOutputRoot: rootDir,
    founderWorkflowRefSha: workflowRefSha,
    founderWorkflowRepository: "venture-harness/venture-harness",
    allowFixtureFounderStack: true,
    credentialBroker: broker,
    credentialCatalogPath: catalogPath,
    providerCommandRunner: transportFixture,
    productCommandRunner: productCommands,
    launchBindings: (context) =>
      createLaunchProductBindings({
        rootDir: context.rootDir,
        brief: context.brief,
        launchContract: context.launchContract,
        authorization: context.authorization,
        agentHost: buildAgent,
        commandRunner: productCommands,
        redactor: broker.redactor,
        now: () => executionTime,
      }),
    providerContext: { ...rootProviderRuntime, authorization: "dry_run" },
    providerPlanFactories: (context) =>
      providerFactoriesFor(
        context,
        transportFixture,
        () => githubAuthReady,
        providerFactoryExecutionCounts,
      ),
    providerRuntimeContext: (context) =>
      createOfficialProviderContext({
        commandRunner: transportFixture,
        httpFetcher: transportFixture,
        commandAvailable: async () => ({
          available: true,
          detail: "fixture-backed official command transport",
        }),
        httpAvailable: async () => ({
          available: true,
          detail: "fixture-backed official HTTP transport",
        }),
        credentials: broker,
        redactor: broker.redactor,
        idempotencyLedger: new FileProviderIdempotencyLedger(
          resolve(context.rootDir, ".venture/provider-idempotency.json"),
        ),
      }),
    now: () => executionTime,
  };
  const rootStore = new FileWorkflowStore({ rootDir: resolve(rootDir, ".root-runs") });
  const rootServices = createDefaultCliServices({
    ...commonOptions,
    rootDir,
    store: rootStore,
  });
  const calls: ShellCallResult[] = [];
  const rootCall = async (args: readonly string[]) => {
    const call = await invokeRootCli({ args, services: rootServices, store: rootStore });
    calls.push(call);
    return call.value;
  };

  const stackCreate = record(
    await rootCall([
      "stack",
      "create",
      "founder-default",
      "--file",
      "founder-default.json",
      "--json",
    ]),
    "stack create",
  );
  assert.equal(stackCreate.status, "created");
  assert.equal(stackCreate.externalEffects, false);

  const stackDoctor = record(
    await rootCall(["stack", "doctor", "founder-default", "--json"]),
    "stack doctor",
  );
  assert.equal(stackDoctor.status, "ready");
  assert.equal(stackDoctor.externalEffects, false);
  assert.equal(stackDoctor.liveProviderState, "not_checked");

  const dryRunArgs = [
    "launch",
    "--idea",
    "./idea.md",
    "--stack",
    "founder-default",
    "--production",
    "--dry-run",
    "--non-interactive",
    "--output",
    CHILD_OUTPUT,
    "--json",
  ] as const;
  const dryRun = record(await rootCall(dryRunArgs), "founder dry run");
  assert.equal(dryRun.status, "ready");
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(record(dryRun.launchGrant, "dry-run grant").status, "proposed_not_issued");
  assert.equal(dryRun.externalEffectsOccurred, false);
  assert.equal(existsSync(childRoot), false);

  const applyArgs = [
    "launch",
    "--idea",
    "./idea.md",
    "--stack",
    "founder-default",
    "--production",
    "--apply",
    "--non-interactive",
    "--output",
    CHILD_OUTPUT,
    "--json",
  ] as const;
  const firstLaunch = record(await rootCall(applyArgs), "founder apply");
  assert.equal(firstLaunch.mode, "apply");
  assert.equal(firstLaunch.childRoot, childRoot);
  assert.equal(record(firstLaunch.launchGrant, "issued grant").status, "issued_for_apply");
  assert.equal(record(firstLaunch.materialized, "materialized child").status, "materialized");
  const firstRunId = stringValue(firstLaunch.runId, "launch run id");
  const childStore = new FileWorkflowStore({
    rootDir: resolve(childRoot, ".venture/runs"),
  });
  let launch = firstLaunch;
  let blockingResumeVerified = false;
  if (options.githubAuthWaitResume) {
    assert.equal(firstLaunch.status, "waiting_external_action");
    assert.equal(firstLaunch.workflowStatus, "waiting");
    const waitingState = childStore.load(firstRunId);
    assert.equal(waitingState.status, "waiting");
    assert.deepEqual(
      {
        state: waitingState.nodes["github-repository"]?.state,
        code: waitingState.nodes["github-repository"]?.error?.code,
      },
      { state: "waiting_for_auth", code: "AUTH_REQUIRED" },
    );

    const childIdentity = statSync(childRoot);
    assert.ok(childIdentity.isDirectory());
    const immutableMaterialization = Object.fromEntries(
      [
        ".venture/founder-input.json",
        ".venture/launch-grant.json",
        ".venture/launch-grant.receipt.json",
        "harness.lock",
        "package.json",
        "venture.manifest.json",
      ].map((path) => [path, readFileSync(relativeFile(childRoot, path), "utf8")]),
    );
    const launchGrantBeforeResume = structuredClone(
      record(firstLaunch.launchGrant, "waiting launch grant"),
    );
    assert.ok(
      transportFixture.invocations.length > 0,
      "at least one independent provider operation must finish before GitHub auth blocks",
    );
    const completedProviderOutputs = Object.fromEntries(
      Object.entries(waitingState.nodes)
        .filter(([, node]) => node.definition.kind === "provider" && node.state === "succeeded")
        .map(([nodeId, node]) => [nodeId, structuredClone(node.output)]),
    );
    assert.ok(Object.keys(completedProviderOutputs).length > 0);
    const completedProviderFactoryCounts = new Map(
      Object.values(waitingState.nodes)
        .filter((node) => node.definition.kind === "provider" && node.state === "succeeded")
        .map((node) => [
          node.definition.handler!,
          providerFactoryExecutionCounts.get(node.definition.handler!) ?? 0,
        ]),
    );
    assert.ok([...completedProviderFactoryCounts.values()].every((count) => count === 1));
    const providerLedgerPath = resolve(childRoot, ".venture/provider-idempotency.json");
    const providerLedgerBeforeResume = record(
      JSON.parse(readFileSync(providerLedgerPath, "utf8")),
      "provider ledger before GitHub auth resume",
    );
    const providerLedgerEntriesBeforeResume = structuredClone(
      record(
        providerLedgerBeforeResume.entries,
        "provider ledger entries before GitHub auth resume",
      ),
    );
    assert.ok(Object.keys(providerLedgerEntriesBeforeResume).length > 0);
    const buildInvocationsBeforeResume = [...buildAgent.invocations];
    const productCommandsBeforeResume = structuredClone(productCommands.invocations);
    const completedProductCommandCounts = new Map<string, number>();
    for (const invocation of productCommandsBeforeResume) {
      const key = JSON.stringify(invocation);
      completedProductCommandCounts.set(key, (completedProductCommandCounts.get(key) ?? 0) + 1);
    }
    assert.ok(buildInvocationsBeforeResume.length > 0);
    assert.ok(productCommandsBeforeResume.length > 0);

    githubAuthReady = true;
    executionTime = new Date(executionTime.getTime() + 60_000);
    launch = record(await rootCall(applyArgs), "founder apply after GitHub auth");
    assert.equal(launch.status, "succeeded");
    assert.equal(launch.workflowStatus, "succeeded");
    assert.equal(launch.childRoot, childRoot);
    assert.equal(launch.runId, firstRunId);
    assert.deepEqual(record(launch.launchGrant, "resumed launch grant"), launchGrantBeforeResume);
    assert.equal(
      record(launch.materialized, "resumed materialization").planDigest,
      record(firstLaunch.materialized, "waiting materialization").planDigest,
    );
    const resumedChildIdentity = statSync(childRoot);
    assert.equal(resumedChildIdentity.dev, childIdentity.dev);
    assert.equal(resumedChildIdentity.ino, childIdentity.ino);
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(immutableMaterialization).map((path) => [
          path,
          readFileSync(relativeFile(childRoot, path), "utf8"),
        ]),
      ),
      immutableMaterialization,
    );
    const resumedState = childStore.load(firstRunId);
    assert.equal(resumedState.status, "succeeded");
    for (const [nodeId, output] of Object.entries(completedProviderOutputs)) {
      assert.deepEqual(resumedState.nodes[nodeId]?.output, output);
    }
    for (const [handler, count] of completedProviderFactoryCounts) {
      assert.equal(
        providerFactoryExecutionCounts.get(handler),
        count,
        `completed provider plan ran again after GitHub auth: ${handler}`,
      );
    }
    const providerLedgerAfterResume = record(
      JSON.parse(readFileSync(providerLedgerPath, "utf8")),
      "provider ledger after GitHub auth resume",
    );
    const providerLedgerEntriesAfterResume = record(
      providerLedgerAfterResume.entries,
      "provider ledger entries after GitHub auth resume",
    );
    for (const [key, entry] of Object.entries(providerLedgerEntriesBeforeResume)) {
      assert.deepEqual(providerLedgerEntriesAfterResume[key], entry);
    }
    assert.deepEqual(buildAgent.invocations, buildInvocationsBeforeResume);
    const resumedProductCommandCounts = new Map<string, number>();
    for (const invocation of productCommands.invocations) {
      const key = JSON.stringify(invocation);
      resumedProductCommandCounts.set(key, (resumedProductCommandCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of completedProductCommandCounts) {
      assert.equal(
        resumedProductCommandCounts.get(key),
        count,
        `completed product command ran again after GitHub auth: ${key}`,
      );
    }
    blockingResumeVerified = true;
  } else {
    assert.equal(firstLaunch.status, "succeeded");
    assert.equal(firstLaunch.workflowStatus, "succeeded");
  }

  const runId = stringValue(launch.runId, "completed launch run id");
  const completedState = childStore.load(runId);
  assert.equal(completedState.status, "succeeded");
  assert.ok(Object.values(completedState.nodes).every(({ state }) => state === "succeeded"));
  for (const deferredNode of [
    "dns-records",
    "verify-custom-domain",
    "brevo-email",
    "google-search-console",
    "bing-discovery",
  ]) {
    assert.equal(completedState.nodes[deferredNode], undefined);
  }
  const providerInvocationCount = transportFixture.invocations.length;
  const buildInvocationCount = buildAgent.invocations.length;
  const productCommandInvocationCount = productCommands.invocations.length;
  executionTime = new Date(executionTime.getTime() + 60_000);
  const replayedLaunch = record(await rootCall(applyArgs), "replayed founder apply");
  assert.equal(replayedLaunch.status, "succeeded");
  assert.equal(replayedLaunch.runId, runId);
  assert.equal(
    record(replayedLaunch.launchGrant, "replayed launch grant").grantId,
    record(launch.launchGrant, "launch grant").grantId,
  );
  assert.equal(transportFixture.invocations.length, providerInvocationCount);
  assert.equal(buildAgent.invocations.length, buildInvocationCount);
  assert.equal(productCommands.invocations.length, productCommandInvocationCount);
  assert.equal(blockingResumeVerified, Boolean(options.githubAuthWaitResume));
  transportFixture.assertComplete();

  directJourneyCheck(childRoot);
  assert.equal(existsSync(resolve(childRoot, "runtime/bootstrap.ts")), false);
  assert.equal(existsSync(resolve(childRoot, "service-blueprints")), false);
  const packageJson = JSON.parse(readFileSync(resolve(childRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(
    Object.keys(packageJson.dependencies ?? {}).some((name) =>
      name.startsWith("@venture-harness/"),
    ),
    false,
  );
  const founderInput = record(
    JSON.parse(readFileSync(resolve(childRoot, ".venture/founder-input.json"), "utf8")),
    "founder input",
  );
  assert.match(stringValue(founderInput.sourceHash, "idea source hash"), /^[a-f0-9]{64}$/u);
  assert.deepEqual(founderInput.assumptions, []);
  const grantReceipt = record(
    JSON.parse(readFileSync(resolve(childRoot, ".venture/launch-grant.receipt.json"), "utf8")),
    "grant receipt",
  );
  assert.equal(grantReceipt.grantId, record(launch.launchGrant, "launch grant").grantId);
  assert.equal("modelBudget" in grantReceipt, false);
  assert.equal("externalResourceBudget" in grantReceipt, false);
  assert.deepEqual(
    grantReceipt.modelExecutionPolicy,
    record(launch.launchGrant, "launch grant").modelExecutionPolicy,
  );
  assert.deepEqual(
    grantReceipt.providerOperationBudget,
    record(launch.launchGrant, "launch grant").providerOperationBudget,
  );

  const reportReference = record(launch.launchReport, "launch report paths");
  const reportJsonReference = stringValue(reportReference.json, "launch report JSON");
  const reportMarkdownReference = stringValue(reportReference.markdown, "launch report Markdown");
  const launchReport = record(
    JSON.parse(readFileSync(relativeFile(childRoot, reportJsonReference), "utf8")),
    "final launch report",
  );
  assert.equal(launchReport.overallState, "succeeded");
  assert.equal(record(launchReport.brief, "report brief").synthetic, true);
  assert.deepEqual(launchReport.remainingManualActions, []);
  assert.ok(
    (launchReport.limitations as unknown[]).some(
      (limitation) => typeof limitation === "string" && limitation.includes("Synthetic fixture"),
    ),
  );
  assert.ok(
    readFileSync(relativeFile(childRoot, reportMarkdownReference), "utf8").includes("succeeded"),
  );
  const receiptReference = record(launch.launchReceipt, "launch receipt paths");
  const launchReceipt = record(
    JSON.parse(
      readFileSync(
        relativeFile(childRoot, stringValue(receiptReference.json, "launch receipt JSON")),
        "utf8",
      ),
    ),
    "launch receipt",
  );
  const receiptVenture = record(launchReceipt.venture, "launch receipt venture");
  assert.equal(receiptVenture.customDomain, null);
  assert.match(
    stringValue(receiptVenture.productionUrl, "receipt production URL"),
    /\.vercel\.app\/?$/u,
  );
  assert.ok(
    (launchReceipt.manualActions as unknown[]).some((candidate) => {
      const action = record(candidate, "launch receipt manual action");
      return String(action.action).includes("exception-desk.example.test");
    }),
    "the requested custom domain must remain a nonblocking Launch Receipt action",
  );

  const providerEvidenceDirectory = resolve(childRoot, `reports/launch/${runId}/providers`);
  const providerEvidenceCount = readdirSync(providerEvidenceDirectory).filter((name) =>
    name.endsWith(".json"),
  ).length;
  assert.ok(providerEvidenceCount >= 4);
  const childLedger = resolve(childRoot, ".venture/provider-idempotency.json");
  assert.ok(existsSync(childLedger));
  assert.ok(readFileSync(childLedger, "utf8").includes("succeeded"));

  const remote = readdirSync(resolve(providerFixtureRoot, "remotes"))
    .filter((name) => name.endsWith(".git"))
    .map((name) => resolve(providerFixtureRoot, "remotes", name))[0];
  assert.ok(remote);
  const childCommit = git(childRoot, ["rev-parse", "HEAD"]);
  const remoteCommit = git(childRoot, [`--git-dir=${remote}`, "rev-parse", "refs/heads/main"]);
  const remoteTree = git(childRoot, [`--git-dir=${remote}`, "rev-parse", `${remoteCommit}^{tree}`]);
  assert.equal(remoteCommit, childCommit);
  assert.equal(
    git(childRoot, ["show", `${remoteCommit}:app/page.tsx`]).includes("ExceptionDeskClient"),
    true,
  );

  const migrationInvocation = transportFixture.invocations.find(
    ({ transport, registered }) =>
      transport === "cli" &&
      registered.some(
        ({ capability, phases }) => capability === "schema_migration" && phases.includes("apply"),
      ),
  );
  assert.ok(migrationInvocation);
  const migrationKey = JSON.parse(migrationInvocation.key) as {
    args: string[];
    command: string;
    cwd: string;
  };
  assert.equal(migrationKey.command, "psql");
  assert.equal(resolve(migrationKey.cwd), childRoot);
  assert.ok(migrationKey.args.includes("migrations/sql/001_core_evidence.up.sql"));
  assert.ok(
    transportFixture.invocations.some(({ registered }) =>
      registered.some(
        ({ capability, phases }) =>
          capability === "schema_migration" && phases.includes("read_back"),
      ),
    ),
  );

  const deploymentRefs = record(
    completedState.nodes["production-deploy"]?.output,
    "production deployment output",
  ).resourceRefs;
  assert.ok(Array.isArray(deploymentRefs));
  const deploymentUrl = deploymentRefs
    .filter((item): item is string => typeof item === "string")
    .find((item) => item.startsWith("url="))
    ?.slice("url=".length);
  const parsedDeploymentUrl = new URL(deploymentUrl ?? "");
  assert.match(parsedDeploymentUrl.hostname, /^[^.]+\.fixture\.vercel\.app$/u);
  assert.equal(parsedDeploymentUrl.pathname, "/");
  const environmentVariables = transportFixture.registeredPlans
    .flatMap(({ operations }) => operations)
    .filter(({ capability }) => capability === "environment_variable")
    .map(({ id }) => id);
  assert.equal(environmentVariables.length, 5);

  const originalHashes = Object.fromEntries(
    PROTECTED_VENTURE_PATHS.map((path) => [path, sha256(relativeFile(childRoot, path))]),
  );
  const currentLock = parseHarnessLock(readFileSync(resolve(childRoot, "harness.lock"), "utf8"));
  const release: HarnessRelease = {
    version: "0.2.1",
    configContractVersion: 2,
    source: { kind: "release", ref: "fixture:founder-golden-path-core-0.2.1" },
    files: [
      ...PROTECTED_VENTURE_PATHS.map((path) => ({
        path,
        ownership: "venture_owned" as const,
        content: `incoming Core replacement for ${path}\n`,
      })),
      {
        path: "runtime/core-upgrade-marker.txt",
        ownership: "core_owned",
        content: "Core 0.2.1 applied by synthetic founder Golden Path\n",
      },
    ],
  };
  const upgradeFileSystem = new DiskUpgradeFileSystem(childRoot);
  const upgradeDryRun = await applyUpgrade({
    fileSystem: upgradeFileSystem,
    currentLock,
    release,
    dryRun: true,
  });
  assert.equal(upgradeDryRun.status, "planned");
  assert.ok(
    PROTECTED_VENTURE_PATHS.every((path) =>
      upgradeDryRun.files.some((file) => file.path === path && file.action === "preserve"),
    ),
  );
  const upgradeApplied = await applyUpgrade({
    fileSystem: upgradeFileSystem,
    currentLock,
    release,
  });
  assert.equal(upgradeApplied.status, "applied");
  assert.deepEqual(
    Object.fromEntries(
      PROTECTED_VENTURE_PATHS.map((path) => [path, sha256(relativeFile(childRoot, path))]),
    ),
    originalHashes,
  );
  assert.ok(existsSync(resolve(childRoot, "runtime/core-upgrade-marker.txt")));
  const upgradedLock = parseHarnessLock(readFileSync(resolve(childRoot, "harness.lock"), "utf8"));
  assert.equal(upgradedLock.harness_version, "0.2.1");
  assert.equal(upgradedLock.lock_version === 2 ? upgradedLock.core_version : null, "0.2.1");
  directJourneyCheck(childRoot);

  const durableText = readableRepositoryText(childRoot);
  for (const secret of fixtureSecrets) assert.equal(durableText.includes(secret), false);
  for (const secretPrefix of ["whsec_fixture_", "postgresql://fixture:fixture@", "G-FIXTURE"]) {
    assert.equal(durableText.includes(secretPrefix), false);
  }

  const providerPlans = transportFixture.registeredPlans.map((plan) => ({
    provider: plan.provider,
    adapterConstructor: plan.adapterConstructor,
    capabilities: [...new Set(plan.operations.map(({ capability }) => capability))].sort(),
  }));
  assert.ok(
    providerPlans.every(
      ({ adapterConstructor }) => adapterConstructor === "DeclarativeProviderAdapter",
    ),
  );
  const providers = new Set(providerPlans.map(({ provider }) => provider));
  for (const provider of ["github", "neon", "stripe", "vercel"]) {
    assert.ok(providers.has(provider), `missing official ${provider} plan`);
  }
  for (const deferredProvider of ["brevo", "google", "bing", "dns"]) {
    assert.equal(providers.has(deferredProvider), false);
  }
  assert.ok(
    transportFixture.invocations.some(
      ({ transport, sensitiveInput }) => transport === "cli" && sensitiveInput,
    ),
  );
  assert.ok(
    transportFixture.invocations.some(
      ({ transport, sensitiveInput }) => transport === "http" && sensitiveInput,
    ),
  );

  return {
    status: "verified_fixture",
    fixtureLabel: "synthetic-founder-golden-path",
    rootDir,
    childRoot,
    runId,
    workflowStatus: "succeeded",
    launchReport: {
      json: resolve(childRoot, reportJsonReference),
      markdown: resolve(childRoot, reportMarkdownReference),
      overallState: "succeeded",
    },
    lifecycle: {
      stackDoctor: "ready",
      ideaCompile: "ready",
      launchGrant: "issued_for_apply",
      firstApply: options.githubAuthWaitResume ? "waiting_for_auth" : "succeeded",
      authResume: options.githubAuthWaitResume ? "same_command_succeeded" : "not_required",
      customDomain: "deferred_nonblocking",
      replay: "idempotent",
      coreUpgrade: "0.2.0_to_0.2.1",
    },
    proof: {
      rootCliArgv: calls.map(({ args }) => args),
      officialTransports: {
        cli: commandTransport.constructor.name,
        http: httpTransport.constructor.name,
      },
      providerPlans,
      providerInvocationCount,
      providerEvidenceCount,
      productTasks: [...buildAgent.invocations],
      productCommands: productCommands.invocations.map(({ args }) => args),
      repository: { remote, commit: remoteCommit, tree: remoteTree },
      migration: { command: "psql", cwd: migrationKey.cwd, readBack: true },
      deployment: {
        url: deploymentUrl!,
        customDomain: null,
        environmentVariables,
      },
      primaryJourney: { signal: "invoice_draft_confirmed", directTests: "passed" },
      upgrade: {
        dryRun: "planned",
        apply: "applied",
        preservedPaths: [...PROTECTED_VENTURE_PATHS],
      },
      durableIdempotencyLedger: childLedger,
      fixtureProvenance: [
        "official_transport_underlying_fixture",
        "official_command_transport_local_bare_git_remote",
        "local_product_command_boundary",
        "provider_url_verified_before_deferred_custom_domain",
      ],
      blockingResume: options.githubAuthWaitResume
        ? {
            waitingNode: "github-repository",
            sameChildIdentity: true,
            materializationUnchanged: true,
            sameRunId: true,
            sameLaunchGrant: true,
            completedProviderOperationsPreserved: true,
            buildCallsPreserved: true,
            replayZeroEffect: true,
          }
        : null,
      secretsPersisted: false,
    },
  };
}
