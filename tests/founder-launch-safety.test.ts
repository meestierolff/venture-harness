import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultCliServices,
  type DefaultCliServicesOptions,
  type LaunchBindingContext,
} from "@/lib/cli/default-services";
import { CredentialBroker, MemoryCredentialBackend, type CredentialKind } from "@/lib/credentials";
import {
  FileFounderStackStore,
  founderStackRoleDefinitions,
  parseFounderStackConnection,
  type FounderStackConnection,
  type FounderStackProviderId,
  type FounderStackRole,
} from "@/lib/founder-launch";
import {
  createLaunchGrant,
  parseLaunchGrant,
  type LaunchGrant,
  type LaunchGrantInput,
} from "@/lib/materialization";
import { MockProviderTransport, type ProviderExecutionContext } from "@/lib/providers";
import { CodexCliBuildAgentHost } from "@/lib/runtime";
import { FileWorkflowStore } from "@/lib/workflow";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WORKFLOW_REF = "a".repeat(40);
const IDEA_FIXTURE = resolve("fixtures/ideas/synthetic-founder-web.md");
const STACK_FIXTURE = resolve("fixtures/founder-stack/founder-default.json");
const OUTPUT = "ventures/exception-desk";
const CHILD_BINDING_HALT = "fixture halt after the child rename";

const temporaryDirectories: string[] = [];

const credentialKinds: Record<Exclude<FounderStackProviderId, "dns">, CredentialKind> = {
  github: "restricted_api_key",
  vercel: "api_key",
  neon: "api_key",
  stripe: "restricted_api_key",
  revenuecat: "restricted_api_key",
  brevo: "api_key",
  google: "oauth",
  bing: "api_key",
};

interface SafetyHarness {
  root: string;
  childRoot: string;
  stackRoot: string;
  catalogPath: string;
  connection: FounderStackConnection;
  broker: CredentialBroker;
  providerContext: ProviderExecutionContext;
  cliTransport: MockProviderTransport;
  httpTransport: MockProviderTransport;
}

interface PendingChild extends SafetyHarness {
  grant: LaunchGrant;
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "vh-founder-launch-safety-"));
  temporaryDirectories.push(path);
  return path;
}

function fixtureConnection(): FounderStackConnection {
  return parseFounderStackConnection(JSON.parse(readFileSync(STACK_FIXTURE, "utf8")));
}

async function createHarness(): Promise<SafetyHarness> {
  const root = temporaryDirectory();
  const stackRoot = join(root, ".founder-stack-state");
  const catalogPath = join(root, ".credential-catalog.json");
  const connection = fixtureConnection();
  const broker = new CredentialBroker([new MemoryCredentialBackend()]);
  for (const role of Object.keys(founderStackRoleDefinitions) as FounderStackRole[]) {
    const provider = founderStackRoleDefinitions[role].providerId;
    const selected = connection.roles[role];
    if (provider === "dns" || !selected.credentialRef) continue;
    await broker.store({
      ref: selected.credentialRef,
      provider,
      kind: credentialKinds[provider],
      backend: "memory",
      scopes: selected.scopes,
      accountId: selected.accountId,
      expiresAt: selected.expiresAt,
      testedAt: NOW.toISOString(),
      testStatus: "passed",
      ...(provider === "stripe" ? { providerMode: "test" as const } : {}),
      value: `fixture-${provider}-credential-value`,
    });
  }
  const cliTransport = new MockProviderTransport("cli");
  const httpTransport = new MockProviderTransport("http");
  const providerContext: ProviderExecutionContext = {
    authorization: "dry_run",
    transports: { cli: cliTransport, http: httpTransport },
    credentials: broker,
    redactor: broker.redactor,
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "idea.md"), readFileSync(IDEA_FIXTURE), { mode: 0o600 });
  new FileFounderStackStore(stackRoot).save(connection);
  return {
    root,
    childRoot: join(root, OUTPUT),
    stackRoot,
    catalogPath,
    connection,
    broker,
    providerContext,
    cliTransport,
    httpTransport,
  };
}

function commonOptions(harness: SafetyHarness): DefaultCliServicesOptions {
  return {
    founderStackRoot: harness.stackRoot,
    founderOutputRoot: harness.root,
    founderWorkflowRefSha: WORKFLOW_REF,
    founderWorkflowRepository: "venture-harness/venture-harness",
    allowFixtureFounderStack: true,
    credentialBroker: harness.broker,
    credentialCatalogPath: harness.catalogPath,
    providerContext: harness.providerContext,
    now: () => NOW,
  };
}

function founderRequest() {
  return {
    mode: "apply" as const,
    idea: "./idea.md",
    stackProfile: "founder-default" as const,
    production: true as const,
    nonInteractive: true as const,
    output: OUTPUT,
    json: true,
  };
}

async function createPendingChild(): Promise<PendingChild> {
  const harness = await createHarness();
  const haltAfterRename = vi.fn(async () => {
    throw new Error(CHILD_BINDING_HALT);
  });
  const planFactories = vi.fn(() => {
    throw new Error("provider planning must not run while preparing the pending child");
  });
  const services = createDefaultCliServices({
    ...commonOptions(harness),
    rootDir: harness.root,
    store: new FileWorkflowStore({ rootDir: join(harness.root, ".root-runs") }),
    launchBindings: haltAfterRename,
    providerPlanFactories: planFactories,
  });

  await expect(services.founderLaunch!(founderRequest())).rejects.toThrow(CHILD_BINDING_HALT);
  expect(haltAfterRename).toHaveBeenCalledTimes(1);
  expect(planFactories).not.toHaveBeenCalled();
  expect(harness.cliTransport.calls).toEqual([]);
  expect(harness.httpTransport.calls).toEqual([]);
  expect(existsSync(harness.childRoot)).toBe(true);
  const grant = parseLaunchGrant(
    JSON.parse(readFileSync(join(harness.childRoot, ".venture/launch-grant.json"), "utf8")),
  );
  return { ...harness, grant };
}

function reissueGrant(
  grant: LaunchGrant,
  mutate: (input: LaunchGrantInput) => LaunchGrantInput,
): LaunchGrant {
  const input = JSON.parse(JSON.stringify(grant)) as Record<string, unknown>;
  delete input.grantId;
  delete input.schemaVersion;
  return createLaunchGrant(mutate(input as unknown as LaunchGrantInput));
}

function mutateProviderConfig(
  childRoot: string,
  provider: "github" | "vercel",
  field: "account_id" | "team_id",
  value: string,
): void {
  const path = join(childRoot, "config/providers.yaml");
  const config = parse(readFileSync(path, "utf8")) as {
    providers: Record<string, Record<string, unknown>>;
  };
  config.providers[provider]![field] = value;
  writeFileSync(path, stringify(config), { encoding: "utf8", mode: 0o600 });
}

async function expectLaunchRejectedBeforeBindings(input: {
  harness: PendingChild;
  grant: LaunchGrant;
  error: RegExp;
  runId: string;
}): Promise<void> {
  const productBindings = vi.fn(() => {
    throw new Error("product bindings were reached before founder safety preflight");
  });
  const planFactories = vi.fn(() => {
    throw new Error("provider planning was reached before founder safety preflight");
  });
  const services = createDefaultCliServices({
    ...commonOptions(input.harness),
    rootDir: input.harness.childRoot,
    store: new FileWorkflowStore({
      rootDir: join(input.harness.childRoot, ".venture/runs"),
    }),
    launchBindings: productBindings,
    providerPlanFactories: planFactories,
  });

  await expect(
    services.launch!({
      mode: "apply",
      authorization: "live-commerce-launch",
      runId: input.runId,
      json: true,
      launchGrant: input.grant,
    }),
  ).rejects.toThrow(input.error);
  expect(productBindings).not.toHaveBeenCalled();
  expect(planFactories).not.toHaveBeenCalled();
  expect(input.harness.cliTransport.calls).toEqual([]);
  expect(input.harness.httpTransport.calls).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical founder launch safety preflight", () => {
  it.each([
    {
      provider: "github" as const,
      field: "account_id" as const,
      value: "different-github-owner",
      error: /Launch Grant.*GitHub|GitHub.*Launch Grant|repository owner|account destination/i,
    },
    {
      provider: "vercel" as const,
      field: "team_id" as const,
      value: "different-vercel-team",
      error:
        /Launch Grant.*Vercel|Vercel.*Launch Grant|team.*(?:match|destination)|account destination/i,
    },
  ])(
    "blocks a Launch Grant/$provider config mismatch before product or provider planning",
    async ({ provider, field, value, error }) => {
      const harness = await createPendingChild();
      mutateProviderConfig(harness.childRoot, provider, field, value);

      await expectLaunchRejectedBeforeBindings({
        harness,
        grant: harness.grant,
        error,
        runId: `launch-config-mismatch-${provider}`,
      });
    },
  );

  it("blocks a missing exact provider capability before adapter planning", async () => {
    const harness = await createPendingChild();
    expect(
      harness.grant.providerAccounts.some(
        ({ provider, capability }) => provider === "github" && capability === "repository",
      ),
    ).toBe(true);
    const grant = reissueGrant(harness.grant, (input) => ({
      ...input,
      providerAccounts: input.providerAccounts.filter(
        ({ provider, capability }) => provider !== "github" || capability !== "repository",
      ),
    }));

    await expectLaunchRejectedBeforeBindings({
      harness,
      grant,
      error:
        /Launch Grant.*(?:missing|requires).*capabilit|missing exact provider destination|provider\/capability\/account destinations/i,
      runId: "launch-missing-exact-capability",
    });
  });

  it("blocks a provider-operation ceiling of one before product or provider handlers", async () => {
    const harness = await createPendingChild();
    const grant = reissueGrant(harness.grant, (input) => ({
      ...input,
      providerOperationBudget: {
        ...input.providerOperationBudget!,
        maxOperations: 1,
      },
    }));

    await expectLaunchRejectedBeforeBindings({
      harness,
      grant,
      error: /provider-operation.*(?:ceiling|budget|exceed)|requires .* operations/i,
      runId: "launch-provider-operation-budget-one",
    });
  });

  it("blocks a mismatched build-agent task bound before product or provider handlers", async () => {
    const harness = await createPendingChild();
    const grant = reissueGrant(harness.grant, (input) => ({
      ...input,
      modelExecutionPolicy: { ...input.modelExecutionPolicy!, maxBuildAgentTasks: 1 },
    }));

    await expectLaunchRejectedBeforeBindings({
      harness,
      grant,
      error: /build-agent task bound|compiled tasks/i,
      runId: "launch-build-task-bound-one",
    });
  });

  it("blocks an unavailable build host before creating a child or staging directory", async () => {
    const harness = await createHarness();
    vi.spyOn(CodexCliBuildAgentHost.prototype, "inspect").mockResolvedValue({
      host: "codex_cli",
      status: "missing",
      version: null,
      billingMode: "unknown",
      billingEvidence: null,
      nextAction: "Install and authenticate the Codex CLI, then retry founder launch.",
    });
    const planFactories = vi.fn(() => {
      throw new Error("provider planning must not run without a build host");
    });
    const services = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".root-runs") }),
      providerPlanFactories: planFactories,
    });

    await expect(services.founderLaunch!(founderRequest())).rejects.toThrow(
      /Install and authenticate the Codex CLI.*No run or external action was created/i,
    );
    expect(planFactories).not.toHaveBeenCalled();
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
    expect(existsSync(harness.childRoot)).toBe(false);
    const ventures = join(harness.root, "ventures");
    expect(existsSync(ventures) ? readdirSync(ventures) : []).toEqual([]);
  });

  it("blocks API-key-billed Codex before creating a child or calling providers", async () => {
    const harness = await createHarness();
    writeFileSync(
      join(harness.root, "idea.md"),
      readFileSync(join(harness.root, "idea.md"), "utf8").replace("synthetic: true\n", ""),
      { mode: 0o600 },
    );
    vi.spyOn(CodexCliBuildAgentHost.prototype, "inspect").mockResolvedValue({
      host: "codex_cli",
      status: "available",
      version: "codex-cli fixture",
      billingMode: "api_key_metered",
      billingEvidence: "codex_login_status",
      nextAction: "Authenticate Codex with a ChatGPT subscription account.",
    });
    const planFactories = vi.fn(() => {
      throw new Error("provider planning must not run with API-key-billed Codex");
    });
    const services = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".root-runs") }),
      providerPlanFactories: planFactories,
    });

    await expect(services.founderLaunch!(founderRequest())).rejects.toThrow(
      /requires `codex login status` to attest ChatGPT subscription use.*blocked before child creation/i,
    );
    expect(planFactories).not.toHaveBeenCalled();
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
    expect(existsSync(harness.childRoot)).toBe(false);
    const ventures = join(harness.root, "ventures");
    expect(existsSync(ventures) ? readdirSync(ventures) : []).toEqual([]);
  });

  it("refuses a caller-injected self-attested model host", async () => {
    const harness = await createHarness();
    const run = vi.fn();
    const options = {
      ...commonOptions(harness),
      rootDir: harness.root,
      buildAgentHost: {
        id: "caller-controlled-host",
        inspect: vi.fn(async () => ({
          host: "caller-controlled-host",
          status: "available",
          version: "caller-v1",
          billingMode: "chatgpt_subscription",
          billingEvidence: "codex_login_status",
          nextAction: null,
        })),
        run,
      },
    } as unknown as DefaultCliServicesOptions;

    expect(() => createDefaultCliServices(options)).toThrow(
      /do not accept caller-injected model hosts/i,
    );
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(harness.childRoot)).toBe(false);
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
  });

  it("continues a matching renamed child transaction with no run on the same command", async () => {
    const harness = await createPendingChild();
    const transactionPath = join(harness.childRoot, ".venture/founder-launch.json");
    expect(existsSync(transactionPath)).toBe(true);
    const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as {
      schemaVersion: number;
      status: string;
      runId: string;
    };
    expect(transaction.schemaVersion).toBe(1);
    const childStore = new FileWorkflowStore({
      rootDir: join(harness.childRoot, ".venture/runs"),
    });
    expect(childStore.exists(transaction.runId)).toBe(false);
    writeFileSync(
      transactionPath,
      `${JSON.stringify({ ...transaction, status: "launch_pending", updatedAt: NOW.toISOString() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const continuationReached = vi.fn(async () => {
      throw new Error("matching founder transaction continued");
    });
    const planFactories = vi.fn(() => {
      throw new Error("provider planning must not run before continuation bindings complete");
    });
    const restarted = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".restarted-root-runs") }),
      launchBindings: continuationReached,
      providerPlanFactories: planFactories,
    });

    await expect(restarted.founderLaunch!(founderRequest())).rejects.toThrow(
      "matching founder transaction continued",
    );
    expect(continuationReached).toHaveBeenCalledTimes(1);
    expect(planFactories).not.toHaveBeenCalled();
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
  });

  it("fails closed when a checked venture parent is swapped before the staging rename", async () => {
    const harness = await createHarness();
    const outside = temporaryDirectory();
    const realParent = join(harness.root, "ventures-before-swap");
    let swapped = false;
    const services = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".race-root-runs") }),
      launchBindings: async () => {
        throw new Error("launch bindings must not run after a path swap");
      },
      providerPlanFactories: () => {
        throw new Error("provider planning must not run after a path swap");
      },
      pathSecurityHook(event) {
        if (event !== "before-founder-staging-rename" || swapped) return;
        swapped = true;
        renameSync(join(harness.root, "ventures"), realParent);
        symlinkSync(outside, join(harness.root, "ventures"), "dir");
      },
    });

    await expect(services.founderLaunch!(founderRequest())).rejects.toThrow(
      /non-symlink directory|symbolic-link alias|changed|ENOENT/i,
    );
    expect(swapped).toBe(true);
    expect(existsSync(join(outside, "exception-desk"))).toBe(false);
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
  });

  it("fails closed when a checked venture parent is swapped before continuation reads", async () => {
    const harness = await createPendingChild();
    const outside = temporaryDirectory();
    const realParent = join(harness.root, "ventures-before-continuation-swap");
    const continuationBindings = vi.fn(() => {
      throw new Error("swapped continuation reached launch bindings");
    });
    let swapped = false;
    const restarted = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".race-continuation-runs") }),
      launchBindings: continuationBindings,
      pathSecurityHook(event) {
        if (event !== "before-founder-continuation" || swapped) return;
        swapped = true;
        renameSync(join(harness.root, "ventures"), realParent);
        symlinkSync(outside, join(harness.root, "ventures"), "dir");
      },
    });

    await expect(restarted.founderLaunch!(founderRequest())).rejects.toThrow(
      /non-symlink directory|symbolic-link alias|changed|ENOENT/i,
    );
    expect(swapped).toBe(true);
    expect(continuationBindings).not.toHaveBeenCalled();
    expect(existsSync(join(outside, "exception-desk", ".venture"))).toBe(false);
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
  });

  it("renews only the run envelope for an expired matching pre-run transaction", async () => {
    const harness = await createPendingChild();
    const renewedAt = new Date(Date.parse(harness.grant.expiresAt) + 60_000);
    const continuedContexts: LaunchBindingContext[] = [];
    const continuationReached = vi.fn(async (context: LaunchBindingContext) => {
      continuedContexts.push(context);
      throw new Error("expired pending founder transaction continued with renewed envelope");
    });
    const planFactories = vi.fn(() => {
      throw new Error("provider planning must not run before renewed continuation bindings");
    });
    const restarted = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".renewed-root-runs") }),
      launchBindings: continuationReached,
      providerPlanFactories: planFactories,
      now: () => renewedAt,
    });

    await expect(restarted.founderLaunch!(founderRequest())).rejects.toThrow(
      "expired pending founder transaction continued with renewed envelope",
    );
    expect(continuationReached).toHaveBeenCalledTimes(1);
    expect(continuedContexts[0]?.authorization).toMatchObject({
      issued_at: renewedAt.toISOString(),
      approval_ref: expect.stringMatching(
        new RegExp(`^launch-grant-pre-run-renewal:${harness.grant.grantId}:`),
      ),
    });
    expect(Date.parse(continuedContexts[0]!.authorization.expires_at)).toBeGreaterThan(
      renewedAt.getTime(),
    );

    const renewalDirectory = join(harness.childRoot, ".venture/launch-grant-renewals");
    const renewalFiles = readdirSync(renewalDirectory);
    expect(renewalFiles).toHaveLength(1);
    const receipt = JSON.parse(
      readFileSync(join(renewalDirectory, renewalFiles[0]!), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: "founder_pre_run_envelope_renewal",
      originalGrantId: harness.grant.grantId,
      runId: expect.stringContaining(harness.grant.ventureSlug),
      renewedAt: renewedAt.toISOString(),
      approvalRef: continuedContexts[0]!.authorization.approval_ref,
    });
    expect(receipt.originalGrantDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.transactionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.authorizationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      parseLaunchGrant(
        JSON.parse(readFileSync(join(harness.childRoot, ".venture/launch-grant.json"), "utf8")),
      ),
    ).toEqual(harness.grant);
    expect(planFactories).not.toHaveBeenCalled();
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
  });

  it("does not renew a revoked pre-run Launch Grant", async () => {
    const harness = await createPendingChild();
    const revokedAt = new Date(NOW.getTime() + 60_000).toISOString();
    writeFileSync(
      join(harness.childRoot, ".venture/launch-grant.json"),
      `${JSON.stringify({ ...harness.grant, revokedAt }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const continuationBindings = vi.fn(() => {
      throw new Error("revoked founder Grant reached launch bindings");
    });
    const restarted = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".revoked-root-runs") }),
      launchBindings: continuationBindings,
      now: () => new Date(Date.parse(harness.grant.expiresAt) + 60_000),
    });

    await expect(restarted.founderLaunch!(founderRequest())).rejects.toThrow(
      /revoked|materialization plan/i,
    );
    expect(continuationBindings).not.toHaveBeenCalled();
    expect(existsSync(join(harness.childRoot, ".venture/launch-grant-renewals"))).toBe(false);
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
  });

  it("rejects an altered persisted founder brief before continuing a matching transaction", async () => {
    const harness = await createPendingChild();
    const briefPath = join(harness.childRoot, ".venture/input/founder-brief.yaml");
    const brief = parse(readFileSync(briefPath, "utf8")) as Record<string, unknown>;
    brief.intended_outcome = "A forged outcome that was not compiled from the founder idea";
    writeFileSync(briefPath, stringify(brief), { encoding: "utf8", mode: 0o600 });
    const continuationBindings = vi.fn(() => {
      throw new Error("altered founder brief reached launch bindings");
    });
    const restarted = createDefaultCliServices({
      ...commonOptions(harness),
      rootDir: harness.root,
      store: new FileWorkflowStore({ rootDir: join(harness.root, ".tampered-root-runs") }),
      launchBindings: continuationBindings,
    });

    await expect(restarted.founderLaunch!(founderRequest())).rejects.toThrow(
      /does not match the current idea|input binding/i,
    );
    expect(continuationBindings).not.toHaveBeenCalled();
    expect(harness.cliTransport.calls).toEqual([]);
    expect(harness.httpTransport.calls).toEqual([]);
  });
});
