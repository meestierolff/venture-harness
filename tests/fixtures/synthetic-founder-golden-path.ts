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
  writeFileSync,
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
import { expectedDnsRecordsFromDependencies } from "@/lib/launch";
import type { MigrationFileSystem } from "@/lib/migrations";
import { CommandProviderTransport, HttpProviderTransport } from "@/lib/providers";
import {
  createOfficialProviderContext,
  FileProviderIdempotencyLedger,
  FileProviderLifecycleStore,
  type ProviderWorkflowPlanFactory,
} from "@/lib/runtime";
import { applyUpgrade, type HarnessRelease } from "@/lib/upgrade";
import { FileWorkflowStore, type JsonValue, type WorkflowRunState } from "@/lib/workflow";
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
    firstApply: "waiting_external_action";
    manualDns: "verified_fixture";
    resume: "succeeded";
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
    deployment: { url: string; environmentVariables: string[] };
    primaryJourney: { signal: "invoice_draft_confirmed"; directTests: "passed" };
    upgrade: { dryRun: "planned"; apply: "applied"; preservedPaths: string[] };
    durableIdempotencyLedger: string;
    fixtureProvenance: string[];
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

function workflowState(value: unknown): WorkflowRunState {
  const candidate = record(value, "workflow result") as unknown as WorkflowRunState;
  if (!candidate.runId || !candidate.nodes || !candidate.status) {
    throw new Error("CLI workflow output is incomplete");
  }
  return candidate;
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
      async (workflow) => transportFixture.register(await factory(workflow)),
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
  const commonOptions: Omit<DefaultCliServicesOptions, "rootDir" | "store"> = {
    founderStackRoot: stackRoot,
    founderOutputRoot: rootDir,
    founderWorkflowRefSha: workflowRefSha,
    allowFixtureFounderStack: true,
    credentialBroker: broker,
    credentialCatalogPath: catalogPath,
    providerCommandRunner: transportFixture,
    productCommandRunner: productCommands,
    buildAgentHost: buildAgent,
    providerContext: { ...rootProviderRuntime, authorization: "dry_run" },
    providerPlanFactories: (context) => providerFactoriesFor(context, transportFixture),
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
  const launch = record(await rootCall(applyArgs), "founder apply");
  assert.equal(launch.status, "waiting_external_action");
  assert.equal(launch.mode, "apply");
  assert.equal(launch.childRoot, childRoot);
  assert.equal(record(launch.launchGrant, "issued grant").status, "issued_for_apply");
  assert.equal(record(launch.materialized, "materialized child").status, "materialized");
  const runId = stringValue(launch.runId, "launch run id");
  assert.equal(launch.workflowStatus, "waiting");

  const childStore = new FileWorkflowStore({
    rootDir: resolve(childRoot, ".venture/runs"),
  });
  const waitingState = childStore.load(runId);
  assert.equal(waitingState.status, "waiting");
  // A bare `pending` here says nothing about why the graph stopped. The run is
  // already known to be waiting, so if DNS is not the node that is waiting then
  // something upstream is, and naming it is the whole diagnosis.
  const dnsState = waitingState.nodes["dns-records"]?.state;
  if (dnsState !== "waiting_for_manual_action") {
    const unfinished = Object.entries(waitingState.nodes)
      .filter(([, node]) => node.state !== "succeeded")
      .map(([id, node]) => `${id}=${node.state}${node.error ? ` (${node.error.code})` : ""}`)
      .join(", ");
    assert.fail(
      `Expected dns-records to be waiting_for_manual_action but it was ${dnsState}. ` +
        `The run status is ${waitingState.status}, so another node stopped the graph first. ` +
        `Unfinished nodes: ${unfinished || "none"}.`,
    );
  }
  const dependencyOutputs = Object.fromEntries(
    waitingState.nodes["dns-records"]!.definition.dependencies.map((dependency) => [
      dependency,
      waitingState.nodes[dependency]?.output,
    ]),
  ) as Readonly<Record<string, JsonValue | undefined>>;
  const records = expectedDnsRecordsFromDependencies(dependencyOutputs);
  assert.ok(records.length >= 3, "manual DNS fixture must consolidate provider record plans");
  const evidenceReference = `reports/launch/${runId}/manual/dns-records.json`;
  const evidencePath = relativeFile(childRoot, evidenceReference);
  mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schema_version: 1,
        kind: "manual_action_evidence",
        run_id: runId,
        node_id: "dns-records",
        status: "verified",
        approved_by: "vh-cli-user",
        verified_at: NOW.toISOString(),
        output: {
          mode: "manual_dns",
          records,
          preserved_existing_mail_records: true,
          preserved_nameservers: true,
          propagation_checks: [
            {
              resolver: "resolver-a.fixture.invalid",
              checked_at: NOW.toISOString(),
              status: "matched",
            },
            {
              resolver: "resolver-b.fixture.invalid",
              checked_at: NOW.toISOString(),
              status: "matched",
            },
          ],
        },
        verification: [
          "Fixture-backed exact record-set comparison passed.",
          "Two deterministic resolver read-backs matched; no live DNS state is claimed.",
        ],
        limitations: ["Synthetic fixture evidence only; no public DNS request was sent."],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const childServices = createDefaultCliServices({
    ...commonOptions,
    rootDir: childRoot,
    store: childStore,
  });
  const childCall = async (args: readonly string[]) => {
    const call = await invokeRootCli({ args, services: childServices, store: childStore });
    calls.push(call);
    return call.value;
  };
  executionTime = new Date(NOW.getTime() + 25 * 60 * 60 * 1_000);
  const resumed = workflowState(
    await childCall([
      "resume",
      runId,
      "--authorization",
      "live-commerce-launch",
      "--manual",
      "dns-records",
      "--evidence",
      evidenceReference,
      "--json",
    ]),
  );
  assert.equal(resumed.status, "succeeded");
  const renewedLaunch = record(
    JSON.parse(readFileSync(resolve(childRoot, `.venture/launches/${runId}.json`), "utf8")),
    "renewed launch metadata",
  );
  const renewedAuthorization = record(renewedLaunch.authorization, "renewed launch authorization");
  assert.equal(
    renewedAuthorization.approval_ref,
    `launch-grant-renewal:${record(launch.launchGrant, "launch grant").grantId}:cli:live-commerce-launch`,
  );
  assert.deepEqual(renewedAuthorization.max_estimated_spend, {
    amount: 0,
    currency: "EUR",
  });
  assert.equal(renewedAuthorization.unknown_external_costs_allowed, false);
  assert.ok(Object.values(resumed.nodes).every(({ state }) => state === "succeeded"));
  const providerInvocationCount = transportFixture.invocations.length;
  const buildInvocationCount = buildAgent.invocations.length;
  const replayed = workflowState(await childCall(["resume", runId, "--json"]));
  assert.equal(replayed.status, "succeeded");
  assert.equal(transportFixture.invocations.length, providerInvocationCount);
  assert.equal(buildAgent.invocations.length, buildInvocationCount);
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

  const providerEvidenceDirectory = resolve(childRoot, `reports/launch/${runId}/providers`);
  const providerEvidenceCount = readdirSync(providerEvidenceDirectory).filter((name) =>
    name.endsWith(".json"),
  ).length;
  assert.ok(providerEvidenceCount >= 10);
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
    resumed.nodes["production-deploy"]?.output,
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
  for (const provider of ["github", "neon", "stripe", "brevo", "google", "bing", "vercel"]) {
    assert.ok(providers.has(provider), `missing official ${provider} plan`);
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
      firstApply: "waiting_external_action",
      manualDns: "verified_fixture",
      resume: "succeeded",
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
        "manual_dns_fixture_evidence",
      ],
      secretsPersisted: false,
    },
  };
}
