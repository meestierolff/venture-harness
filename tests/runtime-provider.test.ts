import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { issueAuthorizationEnvelope } from "@/lib/authorization";
import { createDefaultPoliciesConfig } from "@/lib/config/policy-schema";
import { Redactor } from "@/lib/credentials";
import {
  DeclarativeProviderAdapter,
  getProviderAdapter,
  getProviderDescriptor,
  MockProviderTransport,
  type ProviderOperation,
  type ProviderPlanRequest,
} from "@/lib/providers";
import {
  createOfficialProviderContext,
  createProviderWorkflowBindings,
  FileProviderIdempotencyLedger,
} from "@/lib/runtime";
import {
  FileWorkflowStore,
  WorkflowExecutionError,
  WorkflowExecutor,
  workflowNode,
  type WorkflowDefinition,
  type WorkflowHandlerContext,
} from "@/lib/workflow";

const policies = createDefaultPoliciesConfig();
const fixedNow = new Date("2026-08-04T12:00:00.000Z");

function githubRequest(capabilities: readonly string[] = ["repository"]): ProviderPlanRequest {
  return {
    environment: "preview",
    capabilities,
    dryRun: false,
    credentialRef: "cred://github/primary",
    inputs: {
      repository: "example/runtime-fixture",
      templateRepository: "example/venture-harness",
      visibility: "private",
      deleteBranchOnMerge: true,
    },
  };
}

function workflowContext(runId = "runtime-approved"): WorkflowHandlerContext {
  return {
    runId,
    node: workflowNode("github-provider", {
      kind: "provider",
      capability: "github_repository",
      transport: "cli",
      handler: "provider.github",
      effect: "external_reversible",
      authorization: { required: true, profile: "standard_launch", scopes: ["repository"] },
    }),
    attempt: 1,
    dependencyOutputs: {},
    idempotencyKey: "workflow:github-provider",
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

function envelope(runId: string, providers: string[] = ["github"]) {
  return issueAuthorizationEnvelope({
    runId,
    profile: "standard-launch",
    providers,
    environments: ["preview"],
    policies,
    approvalRef: "test:approved-provider-apply",
    now: fixedNow,
  });
}

function bindings(input: {
  runId?: string;
  ledger: FileProviderIdempotencyLedger;
  transport: MockProviderTransport;
  redactor?: Redactor;
  providers?: string[];
  request?: ProviderPlanRequest;
}) {
  const runId = input.runId ?? "runtime-approved";
  const redactor = input.redactor ?? new Redactor();
  return createProviderWorkflowBindings({
    planFactories: {
      "provider.github": async () => ({
        provider: "github",
        request: input.request ?? githubRequest(),
      }),
    },
    policies,
    authorization: envelope(runId, input.providers),
    context: {
      transports: { cli: input.transport },
      redactor,
      idempotencyLedger: input.ledger,
    },
    now: () => fixedNow,
  });
}

describe("provider workflow bindings", () => {
  it("waits before a dangerous transport and consumes a fresh exact grant for every attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-checkpoint-"));
    const runId = "runtime-dangerous-checkpoint";
    let currentNow = fixedNow;
    const dangerousOperation: ProviderOperation = {
      id: "github.repository.delete.fixture",
      provider: "github",
      capability: "repository",
      action: "repository.delete",
      title: "Delete one repository fixture",
      transport: "cli",
      environment: "production",
      riskClass: "critical",
      effectClass: "irreversible_external",
      reversibility: "irreversible",
      idempotencyKey: "github:repository:delete:fixture",
      dependsOn: [],
      command: { binary: "gh", args: ["repo", "delete", "example/fixture", "--yes"] },
      verification: { strategy: "read_back", description: "verify repository absence" },
    };
    const adapter = new DeclarativeProviderAdapter(getProviderDescriptor("github"), (request) => ({
      id: "github-delete-fixture-plan",
      provider: "github",
      environment: "production",
      dryRun: request.dryRun ?? true,
      createdAt: fixedNow.toISOString(),
      operations: [dangerousOperation],
      limitations: ["test-only adapter; no live provider is contacted"],
    }));
    let invocation = 0;
    const transport = new MockProviderTransport("cli", async () => {
      invocation += 1;
      if (invocation === 1) {
        currentNow = new Date(fixedNow.getTime() + 1_000);
      }
      return invocation === 1
        ? {
            status: "failed",
            message: "temporary fixture outage",
            providerCode: "retryable_outage",
            retryable: true,
          }
        : {
            status: "succeeded",
            message: "fixture deleted",
            output: { repository: "example/fixture", state: "absent" },
            verified: true,
          };
    });
    const authorization = issueAuthorizationEnvelope({
      runId,
      profile: "live-commerce-launch",
      providers: ["github"],
      environments: ["production"],
      policies,
      approvalRef: "test:dangerous-provider-checkpoint",
      now: fixedNow,
    });
    const providerBindings = createProviderWorkflowBindings({
      planFactories: {
        "provider.github-dangerous": () => ({
          provider: "github",
          adapter,
          request: {
            environment: "production",
            capabilities: ["repository"],
            dryRun: false,
            inputs: {},
          },
        }),
      },
      policies,
      authorization,
      context: {
        transports: { cli: transport },
        redactor: new Redactor(),
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      },
      now: () => currentNow,
    });
    const store = new FileWorkflowStore({ rootDir: join(directory, "runs") });
    const executor = new WorkflowExecutor({
      store,
      now: () => currentNow,
      bindings: {
        ...providerBindings,
        checkpointEvidenceVerifier: () => true,
      },
    });
    const definition: WorkflowDefinition = {
      id: "dangerous-provider-checkpoint",
      name: "Dangerous provider checkpoint fixture",
      version: "1",
      nodes: [
        workflowNode("dangerous-provider", {
          kind: "provider",
          capability: "repository",
          transport: "cli",
          handler: "provider.github-dangerous",
          effect: "external_irreversible",
          risk: "critical",
          authorization: {
            required: true,
            profile: "live_commerce_launch",
            scopes: ["repository"],
          },
          retry: {
            maxAttempts: 2,
            retryableCodes: ["provider_unavailable"],
            backoff: { strategy: "none", initialMs: 0, maxMs: 0, multiplier: 1 },
          },
          evidence: { required: true },
        }),
      ],
      maxParallel: 1,
      maxIterations: 10,
      budgets: {},
    };

    let state = await executor.start(definition, { runId });
    expect(state.status).toBe("waiting");
    expect(state.nodes["dangerous-provider"].state).toBe("waiting_for_approval");
    expect(state.nodes["dangerous-provider"].attempts).toBe(0);
    expect(transport.calls).toHaveLength(0);

    const grant = async (sequence: number) =>
      executor.grantAuthorizationCheckpoint(runId, "dangerous-provider", {
        effect: "external_delete",
        operationId: dangerousOperation.id,
        evidenceArtifact: `reports/launch/runtime-dangerous-checkpoint/checkpoints/delete-repository-${sequence}.json`,
        approvedBy: "founder-operator",
        approvedAt: currentNow.toISOString(),
        expiresAt: authorization.expires_at,
      });
    await grant(1);
    state = await executor.resume(definition, runId);
    expect(state.status).toBe("waiting");
    expect(state.nodes["dangerous-provider"].attempts).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(Object.values(state.checkpointGrants ?? {})).toHaveLength(1);
    expect(Object.values(state.checkpointGrants ?? {})[0].consumedAttempt).toBe(1);

    await expect(grant(1)).rejects.toThrow(/already issued a one-shot grant/);
    await grant(2);
    state = await executor.resume(definition, runId);
    expect(state.status).toBe("succeeded");
    expect(transport.calls).toHaveLength(2);
    expect(Object.values(state.checkpointGrants ?? {})).toHaveLength(2);
    expect(
      Object.values(state.checkpointGrants ?? {}).map(({ consumedAttempt }) => consumedAttempt),
    ).toEqual([1, 2]);
    expect(
      store.readEvents(runId).filter(({ type }) => type === "checkpoint_grant_consumed"),
    ).toHaveLength(2);
  });

  it("enforces the estimated-spend ceiling cumulatively across provider nodes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-cumulative-spend-"));
    const runId = "runtime-cumulative-spend";
    const operationFor = (suffix: string): ProviderOperation => ({
      id: `github.repository.settings.${suffix}`,
      provider: "github",
      capability: "repository_settings",
      action: "repository.settings.update",
      title: `Update synthetic repository ${suffix}`,
      transport: "cli",
      environment: "preview",
      riskClass: "high",
      effectClass: "reversible_external",
      reversibility: "reversible",
      idempotencyKey: `github:repository:settings:${suffix}`,
      dependsOn: [],
      command: { binary: "gh", args: ["api", `repos/example/${suffix}`, "--method", "PATCH"] },
      verification: { strategy: "read_back", description: "verify synthetic settings" },
      estimatedCost: { amount: 6, currency: "EUR" },
    });
    const adapterFor = (operation: ProviderOperation) =>
      new DeclarativeProviderAdapter(getProviderDescriptor("github"), (request) => ({
        id: `plan-${operation.id}`,
        provider: "github",
        environment: "preview",
        dryRun: request.dryRun ?? true,
        createdAt: fixedNow.toISOString(),
        operations: [operation],
        limitations: ["synthetic cumulative-spend fixture"],
      }));
    const firstOperation = operationFor("first");
    const secondOperation = operationFor("second");
    const transport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: "synthetic settings updated",
      verified: true,
    }));
    const authorization = {
      ...issueAuthorizationEnvelope({
        runId,
        profile: "standard-launch",
        providers: ["github"],
        environments: ["preview"],
        capabilities: ["repository_settings"],
        policies,
        approvalRef: "test:cumulative-spend",
        now: fixedNow,
      }),
      max_estimated_spend: { amount: 10, currency: "EUR" },
      unknown_external_costs_allowed: false,
    };
    const request: ProviderPlanRequest = {
      environment: "preview",
      capabilities: ["repository_settings"],
      dryRun: false,
      inputs: {},
    };
    const providerBindings = createProviderWorkflowBindings({
      planFactories: {
        "provider.first": () => ({
          provider: "github",
          adapter: adapterFor(firstOperation),
          request,
        }),
        "provider.second": () => ({
          provider: "github",
          adapter: adapterFor(secondOperation),
          request,
        }),
      },
      policies,
      authorization,
      context: {
        transports: { cli: transport },
        redactor: new Redactor(),
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      },
      now: () => fixedNow,
    });
    const store = new FileWorkflowStore({ rootDir: join(directory, "runs") });
    const executor = new WorkflowExecutor({
      store,
      bindings: providerBindings,
      now: () => fixedNow,
    });
    const providerNode = (id: string, handler: string, dependencies: string[] = []) =>
      workflowNode(id, {
        kind: "provider",
        capability: "repository_settings",
        transport: "cli",
        handler,
        dependencies,
        effect: "external_reversible",
        risk: "high",
        authorization: {
          required: true,
          profile: "standard_launch",
          scopes: ["repository_settings"],
        },
      });
    const definition: WorkflowDefinition = {
      id: "cumulative-spend",
      name: "Cumulative spend fixture",
      version: "1",
      nodes: [
        providerNode("first-provider", "provider.first"),
        providerNode("second-provider", "provider.second", ["first-provider"]),
      ],
      maxParallel: 1,
      maxIterations: 10,
      budgets: {},
    };

    const state = await executor.start(definition, { runId });

    expect(state.status).toBe("failed");
    expect(state.nodes["first-provider"].state).toBe("succeeded");
    expect(state.nodes["second-provider"].error?.code).toBe("spend_limit_exceeded");
    expect(state.authorizationSpend).toMatchObject({ currency: "EUR", totalAmount: 6 });
    expect(transport.calls).toHaveLength(1);
    expect(
      store.readEvents(runId).filter(({ type }) => type === "authorization_spend_reserved"),
    ).toHaveLength(1);
  });

  it("applies an authorized plan and returns evidence only after read-back verifies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-provider-"));
    const transport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: "repository created",
      output: {
        nameWithOwner: "example/runtime-fixture",
        url: "https://github.com/example/runtime-fixture",
      },
      verified: true,
    }));
    const runtime = bindings({
      ledger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      transport,
    });

    const result = await runtime.handlers!["provider.github"](workflowContext());

    expect(result.effectVerified).toBe(true);
    expect(result.evidenceArtifact).toMatch(/^provider-readback:\/\/github\//);
    expect(result.output).toMatchObject({
      provider: "github",
      state: "verified",
      resourceRefs: [
        "repository=example/runtime-fixture",
        "url=https://github.com/example/runtime-fixture",
      ],
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects a provider outside the run envelope before transport execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-auth-"));
    const transport = new MockProviderTransport("cli");
    const runtime = bindings({
      ledger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      transport,
      providers: ["vercel"],
    });

    await expect(runtime.handlers!["provider.github"](workflowContext())).rejects.toMatchObject({
      name: "WorkflowExecutionError",
      code: "authorization_rejected",
      retryable: false,
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("reconciles local-source publication across runtime instances without persisting output or secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-ledger-"));
    const path = join(directory, "ledger.json");
    const secret = "opaque-runtime-secret";
    const redactor = new Redactor();
    redactor.addSecret(secret);
    const firstTransport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: secret,
      providerCode: secret,
      output: { diagnostic: secret, nameWithOwner: "example/runtime-fixture" },
      verified: true,
    }));
    await bindings({
      ledger: new FileProviderIdempotencyLedger(path, { now: () => fixedNow }),
      transport: firstTransport,
      redactor,
    }).handlers!["provider.github"](workflowContext());

    const secondTransport = new MockProviderTransport("cli");
    const result = await bindings({
      ledger: new FileProviderIdempotencyLedger(path, { now: () => fixedNow }),
      transport: secondTransport,
      redactor,
    }).handlers!["provider.github"](workflowContext());
    const contents = await readFile(path, "utf8");
    const operationKey =
      getProviderAdapter("github").plan(githubRequest()).operations[0].idempotencyKey;

    expect(result.effectVerified).toBe(true);
    expect(firstTransport.calls).toHaveLength(1);
    expect(secondTransport.calls).toHaveLength(1);
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain(operationKey);
    expect(contents).not.toContain("nameWithOwner");
    expect(contents).toContain('"verified": true');
  });

  it("maps retryable partial provider failures to WorkflowExecutionError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-partial-"));
    let invocation = 0;
    const transport = new MockProviderTransport("cli", async () => {
      invocation += 1;
      return invocation === 1
        ? { status: "succeeded", message: "created", verified: true }
        : {
            status: "failed",
            message: "temporary outage",
            providerCode: "retryable_outage",
            retryable: true,
          };
    });
    const runtime = bindings({
      ledger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      transport,
      request: githubRequest(["repository", "repository_settings"]),
    });

    let error: unknown;
    try {
      await runtime.handlers!["provider.github"](workflowContext());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkflowExecutionError);
    expect(error).toMatchObject({ code: "provider_unavailable", retryable: true });
  });

  it("fails when apply is accepted but read-back remains unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-pending-"));
    const transport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: "request accepted",
      verified: false,
    }));
    const runtime = bindings({
      ledger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      transport,
    });

    await expect(runtime.handlers!["provider.github"](workflowContext())).rejects.toMatchObject({
      code: "provider_verification_unavailable",
      retryable: true,
    });
  });

  it("keeps an official manual provider plan pending instead of reporting success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-runtime-manual-"));
    const runId = "runtime-manual-dns";
    const authorization = issueAuthorizationEnvelope({
      runId,
      profile: "live-commerce-launch",
      providers: ["mijndomein"],
      environments: ["production"],
      policies,
      approvalRef: "test:manual-dns-plan",
      now: fixedNow,
    });
    const runtime = createProviderWorkflowBindings({
      planFactories: {
        "provider.mijndomein": async () => ({
          provider: "mijndomein",
          request: {
            environment: "production",
            capabilities: ["record"],
            dryRun: false,
            inputs: {
              zone: "example.test",
              recordType: "TXT",
              recordName: "_verification",
              recordValue: "public-fixture-value",
              ttl: 3600,
            },
          },
        }),
      },
      policies,
      authorization,
      context: createOfficialProviderContext({
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      }),
      now: () => fixedNow,
    });
    const context = workflowContext(runId);
    context.node = workflowNode("manual-provider", {
      kind: "provider",
      capability: "dns",
      transport: "manual",
      handler: "provider.mijndomein",
      effect: "external_reversible",
      authorization: {
        required: true,
        profile: "live_commerce_launch",
        scopes: ["record"],
      },
    });

    await expect(runtime.handlers!["provider.mijndomein"](context)).rejects.toMatchObject({
      code: "provider_manual_action_required",
      retryable: false,
    });
  });
});
