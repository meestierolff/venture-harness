import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issueAuthorizationEnvelope } from "@/lib/authorization";
import { createDefaultPoliciesConfig } from "@/lib/config/policy-schema";
import { Redactor } from "@/lib/credentials";
import { MockProviderTransport } from "@/lib/providers";
import {
  createProviderWorkflowBindings,
  FileProviderIdempotencyLedger,
  FileProviderLifecycleStore,
  ProviderLifecycleStoreError,
} from "@/lib/runtime";
import { workflowNode, type JsonValue, type WorkflowHandlerContext } from "@/lib/workflow";

const now = new Date("2026-08-04T12:00:00.000Z");
const policies = createDefaultPoliciesConfig();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function context(runId = "provider-lifecycle-run"): WorkflowHandlerContext {
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
    idempotencyKey: "provider-lifecycle:github-provider",
    signal: new AbortController().signal,
    trace: () => undefined,
    checkpointOperation: () => undefined,
  };
}

function authorization(runId = "provider-lifecycle-run") {
  return issueAuthorizationEnvelope({
    runId,
    profile: "standard-launch",
    providers: ["github"],
    environments: ["preview"],
    policies,
    approvalRef: "test:provider-lifecycle",
    now,
  });
}

function providerAuthorization(
  runId: string,
  provider: "stripe" | "vercel",
  environment: "test" | "preview",
) {
  return issueAuthorizationEnvelope({
    runId,
    profile: "live-commerce-launch",
    providers: [provider],
    environments: [environment],
    policies,
    approvalRef: `test:provider-lifecycle:${provider}`,
    now,
  });
}

describe("verified provider lifecycle persistence", () => {
  it("stores and replaces only typed state within one provider/environment/capability scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-lifecycle-store-"));
    const path = join(directory, "provider-lifecycle.json");
    const store = new FileProviderLifecycleStore(path);

    await store.recordVerified([
      {
        provider: "github",
        environment: "preview",
        capability: "repository",
        state: "verified",
        planId: "plan.github.first",
        verifiedAt: "2026-08-04T11:00:00.000Z",
        resourceRefs: [{ type: "repository", value: "founder/first-venture" }],
      },
      {
        provider: "github",
        environment: "production",
        capability: "repository_settings",
        state: "verified",
        planId: "plan.github.settings",
        verifiedAt: "2026-08-04T11:05:00.000Z",
        resourceRefs: [{ type: "repository", value: "founder/first-venture" }],
      },
    ]);
    await store.recordVerified([
      {
        provider: "github",
        environment: "preview",
        capability: "repository",
        state: "verified",
        planId: "plan.github.second",
        verifiedAt: "2026-08-04T12:00:00.000Z",
        resourceRefs: [{ type: "repository", value: "founder/renamed-venture" }],
      },
    ]);

    expect(await store.list()).toHaveLength(2);
    expect(
      await store.get({ provider: "github", environment: "preview", capability: "repository" }),
    ).toMatchObject({
      planId: "plan.github.second",
      resourceRefs: [{ type: "repository", value: "founder/renamed-venture" }],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps schema-version-1 records readable while adding staged public identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-lifecycle-compatible-"));
    const path = join(directory, "provider-lifecycle.json");
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            provider: "github",
            environment: "preview",
            capability: "repository",
            state: "verified",
            planId: "plan.github.legacy",
            verifiedAt: "2026-08-03T12:00:00.000Z",
            resourceRefs: [{ type: "repository", value: "founder/legacy-venture" }],
          },
        ],
      })}\n`,
      "utf8",
    );
    const store = new FileProviderLifecycleStore(path);

    await store.recordVerified([
      {
        provider: "google",
        environment: "production",
        capability: "analytics_web_stream",
        state: "verified",
        planId: "plan.google.staged",
        verifiedAt: "2026-08-04T12:00:00.000Z",
        resourceRefs: [
          { type: "property_id", value: "123456789" },
          { type: "stream_id", value: "987654321" },
          { type: "measurement_id", value: "G-ABC1234567" },
        ],
      },
    ]);

    expect(await store.list()).toEqual([
      expect.objectContaining({
        provider: "github",
        resourceRefs: [{ type: "repository", value: "founder/legacy-venture" }],
      }),
      expect.objectContaining({
        provider: "google",
        resourceRefs: [
          { type: "measurement_id", value: "G-ABC1234567" },
          { type: "property_id", value: "123456789" },
          { type: "stream_id", value: "987654321" },
        ],
      }),
    ]);
  });

  it("fails closed on corrupt, unknown, duplicate, or credential-like lifecycle state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-lifecycle-corrupt-"));
    const path = join(directory, "provider-lifecycle.json");
    const store = new FileProviderLifecycleStore(path);
    await writeFile(path, "{not-json\n", "utf8");

    await expect(store.list()).rejects.toBeInstanceOf(ProviderLifecycleStoreError);
    await expect(
      store.recordVerified([
        {
          provider: "github",
          environment: "preview",
          capability: "repository",
          state: "verified",
          planId: "plan.github.safe",
          verifiedAt: "2026-08-04T12:00:00.000Z",
          resourceRefs: [{ type: "repository", value: "founder/safe" }],
        },
      ]),
    ).rejects.toBeInstanceOf(ProviderLifecycleStoreError);
    expect(await readFile(path, "utf8")).toBe("{not-json\n");

    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, records: [], providerBody: { arbitrary: true } }),
      "utf8",
    );
    await expect(store.list()).rejects.toBeInstanceOf(ProviderLifecycleStoreError);
    await expect(
      new FileProviderLifecycleStore(join(directory, "new.json")).recordVerified([
        {
          provider: "stripe",
          environment: "sandbox",
          capability: "product",
          state: "verified",
          planId: "plan.stripe.unsafe",
          verifiedAt: "2026-08-04T12:00:00.000Z",
          resourceRefs: [{ type: "product_id", value: "sk_live_SYNTHETICNOTAREALb" }],
        },
      ]),
    ).rejects.toBeInstanceOf(ProviderLifecycleStoreError);
  });

  it("persists verified binding state without provider bodies, credentials, or URL queries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-lifecycle-binding-"));
    const lifecyclePath = join(directory, "provider-lifecycle.json");
    const evidencePath = join(directory, "provider-evidence.json");
    const secret = "opaque-provider-lifecycle-secret";
    const redactor = new Redactor();
    redactor.addSecret(secret);
    const transport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: "fixture apply",
      verified: true,
      output: {
        nameWithOwner: "founder/lifecycle-venture",
        branch: "main",
        commitOid: "a".repeat(40),
        treeOid: "b".repeat(40),
        visibility: "private",
        url: "https://example.test/deploy?trace=arbitrary-body",
        productId: secret,
        providerBody: { arbitrary: "must-not-persist" },
      },
    }));
    const bindings = createProviderWorkflowBindings({
      planFactories: {
        "provider.github": async () => ({
          provider: "github",
          request: {
            environment: "preview",
            capabilities: ["repository"],
            dryRun: false,
            credentialRef: "cred://github/primary",
            inputs: {
              repository: "founder/lifecycle-venture",
              templateRepository: "founder/venture-harness",
              visibility: "private",
            },
          },
        }),
      },
      policies,
      authorization: authorization(),
      context: {
        transports: { cli: transport },
        redactor,
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      },
      lifecycleStore: new FileProviderLifecycleStore(lifecyclePath),
      recordEvidence: ({ evidence }) => {
        return writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8").then(
          () => "reports/providers/github.json",
        );
      },
      now: () => now,
    });

    const result = await bindings.handlers!["provider.github"](context());
    const [lifecycle, evidence] = await Promise.all([
      readFile(lifecyclePath, "utf8"),
      readFile(evidencePath, "utf8"),
    ]);

    expect(result).toMatchObject({
      effectVerified: true,
      output: {
        resourceRefs: [
          "branch=main",
          `commit_oid=${"a".repeat(40)}`,
          "repository=founder/lifecycle-venture",
          `tree_oid=${"b".repeat(40)}`,
          "url=https://example.test/deploy",
          "visibility=private",
        ],
      },
    });
    expect(await new FileProviderLifecycleStore(lifecyclePath).list()).toEqual([
      expect.objectContaining({
        provider: "github",
        environment: "preview",
        capability: "repository",
        state: "verified",
        resourceRefs: [
          { type: "branch", value: "main" },
          { type: "commit_oid", value: "a".repeat(40) },
          { type: "repository", value: "founder/lifecycle-venture" },
          { type: "tree_oid", value: "b".repeat(40) },
          { type: "url", value: "https://example.test/deploy" },
          { type: "visibility", value: "private" },
        ],
      }),
    ]);
    for (const persisted of [lifecycle, evidence, JSON.stringify(result)]) {
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain("must-not-persist");
      expect(persisted).not.toContain("arbitrary-body");
      expect(persisted).not.toContain("templateRepository");
      expect(persisted).not.toContain("cred://github/primary");
    }
  });

  it("preserves exact safe Stripe price and Vercel deployment read-back identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-lifecycle-public-refs-"));
    const stripeRunId = "provider-lifecycle-stripe-refs";
    const lookupKey = "vh_lifecycle_fixture_eur_2450_month";
    const stripeTransport = new MockProviderTransport("http", async (operation) =>
      operation.action.endsWith(".search_before_create")
        ? {
            status: "succeeded",
            message: "no existing price",
            output: { data: [], has_more: false },
            effectOutcome: "confirmed_no_write",
          }
        : {
            status: "succeeded",
            message: "fixture price created",
            verified: true,
            output: {
              id: "price_fixture_exact",
              product: "prod_fixture_exact",
              currency: "eur",
              unit_amount: 2450,
              lookup_key: lookupKey,
              livemode: false,
            },
          },
    );
    const stripe = createProviderWorkflowBindings({
      planFactories: {
        "provider.stripe": () => ({
          provider: "stripe",
          request: {
            environment: "sandbox",
            capabilities: ["price"],
            dryRun: false,
            credentialRef: "cred://stripe/primary",
            inputs: {
              ventureSlug: "lifecycle-fixture",
              stripeAccountId: "acct_lifecycle_fixture",
              stripeMode: "test",
              productId: "prod_fixture_exact",
              currency: "eur",
              unitAmount: 2450,
              recurringInterval: "month",
            },
          },
        }),
      },
      policies,
      authorization: providerAuthorization(stripeRunId, "stripe", "test"),
      context: {
        transports: { http: stripeTransport },
        redactor: new Redactor(),
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "stripe-ledger.json")),
      },
      now: () => now,
    });
    const stripeContext = context(stripeRunId);
    stripeContext.node = workflowNode("stripe-provider", {
      kind: "provider",
      capability: "stripe",
      transport: "api",
      handler: "provider.stripe",
      effect: "external_reversible",
      authorization: {
        required: true,
        profile: "live_commerce_launch",
        scopes: ["price"],
      },
    });
    await expect(stripe.handlers!["provider.stripe"](stripeContext)).resolves.toMatchObject({
      output: {
        resourceRefs: expect.arrayContaining([
          "amount_minor=2450",
          "currency=eur",
          "livemode=false",
          `lookup_key=${lookupKey}`,
          "price_id=price_fixture_exact",
        ]),
      },
    });

    const vercelRunId = "provider-lifecycle-vercel-refs";
    const vercel = createProviderWorkflowBindings({
      planFactories: {
        "provider.vercel": () => ({
          provider: "vercel",
          request: {
            environment: "preview",
            capabilities: ["deployment"],
            dryRun: false,
            credentialRef: "cred://vercel/primary",
            inputs: { project: "lifecycle-fixture", scope: "team_fixture" },
          },
        }),
      },
      policies,
      authorization: providerAuthorization(vercelRunId, "vercel", "preview"),
      context: {
        transports: {
          cli: new MockProviderTransport("cli", async () => ({
            status: "succeeded",
            message: "fixture deployment created",
            verified: true,
            output: {
              id: "dpl_fixture_exact",
              url: "https://lifecycle-fixture.vercel.app",
              readyState: "READY",
            },
          })),
        },
        redactor: new Redactor(),
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "vercel-ledger.json")),
      },
      now: () => now,
    });
    const vercelContext = context(vercelRunId);
    vercelContext.node = workflowNode("vercel-provider", {
      kind: "provider",
      capability: "public_website",
      transport: "cli",
      handler: "provider.vercel",
      effect: "external_reversible",
      authorization: {
        required: true,
        profile: "live_commerce_launch",
        scopes: ["deployment"],
      },
    });
    await expect(vercel.handlers!["provider.vercel"](vercelContext)).resolves.toMatchObject({
      output: {
        resourceRefs: expect.arrayContaining([
          "deployment_id=dpl_fixture_exact",
          "url=https://lifecycle-fixture.vercel.app/",
        ]),
      },
    });
  });

  it("fails the workflow after verification when lifecycle state is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-lifecycle-failure-"));
    const lifecyclePath = join(directory, "provider-lifecycle.json");
    await writeFile(lifecyclePath, "not-json", "utf8");
    const transport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: "fixture apply",
      output: { nameWithOwner: "founder/lifecycle-venture" },
      verified: true,
    }));
    const bindings = createProviderWorkflowBindings({
      planFactories: {
        "provider.github": async () => ({
          provider: "github",
          request: {
            environment: "preview",
            capabilities: ["repository"],
            dryRun: false,
            inputs: {
              repository: "founder/lifecycle-venture",
              templateRepository: "founder/venture-harness",
            },
          },
        }),
      },
      policies,
      authorization: authorization(),
      context: {
        transports: { cli: transport },
        redactor: new Redactor(),
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      },
      lifecycleStore: new FileProviderLifecycleStore(lifecyclePath),
      now: () => now,
    });

    await expect(bindings.handlers!["provider.github"](context())).rejects.toMatchObject({
      code: "provider_lifecycle_persistence_failed",
      retryable: false,
    });
    expect(transport.calls).toHaveLength(1);
    expect(await readFile(lifecyclePath, "utf8")).toBe("not-json");
  });

  it("rebuilds a lifecycle-proven crash checkpoint through the trusted adapter without a second write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-lifecycle-reconstruct-"));
    const lifecycleStore = new FileProviderLifecycleStore(join(directory, "lifecycle.json"));
    const runId = "provider-lifecycle-reconstruct";
    let checkpoint: JsonValue | undefined;
    let readBacks = 0;
    const transport = new MockProviderTransport(
      "cli",
      async () => ({
        status: "succeeded",
        message: "fixture repository applied",
        output: {
          branch: "main",
          commitOid: "a".repeat(40),
          treeOid: "b".repeat(40),
        },
        effectOutcome: "confirmed_write",
      }),
      async (operation) => {
        readBacks += 1;
        return {
          operationId: operation.id,
          status: "matched",
          message: "fixture repository matched",
          evidence: { verified: true },
        };
      },
    );
    const bindings = createProviderWorkflowBindings({
      planFactories: {
        "provider.github": async () => ({
          provider: "github",
          request: {
            environment: "preview",
            capabilities: ["repository"],
            dryRun: false,
            credentialRef: "cred://github/primary",
            inputs: {
              repository:
                (await lifecycleStore.list()).length === 0
                  ? "founder/lifecycle-crash-original"
                  : "founder/lifecycle-factory-after-crash",
              sourceDirectory: ".",
              visibility: "private",
            },
          },
        }),
      },
      policies,
      authorization: authorization(runId),
      context: {
        transports: { cli: transport },
        redactor: new Redactor(),
        idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "ledger.json")),
      },
      lifecycleStore,
      now: () => now,
    });
    const workflow = context(runId);
    workflow.checkpointOperation = (value) => {
      checkpoint = value;
    };

    await expect(bindings.handlers!["provider.github"](workflow)).resolves.toMatchObject({
      effectVerified: true,
    });
    expect(checkpoint).toBeDefined();
    expect(transport.calls).toHaveLength(1);
    expect(readBacks).toBe(1);

    const reconcile = (durableCheckpoint: JsonValue) =>
      bindings.reconcilers!["provider.github"]({
        runId,
        node: workflow.node,
        attempt: 1,
        dependencyOutputs: {},
        idempotencyKey: workflow.idempotencyKey,
        operation: {
          attempt: 1,
          idempotencyKey: workflow.idempotencyKey,
          phase: "handler_completed",
          preparedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          reconcileAttempts: 0,
          checkpoint: durableCheckpoint,
        },
        reason: "restart",
        signal: new AbortController().signal,
        trace: () => undefined,
      });
    await expect(reconcile(checkpoint!)).resolves.toMatchObject({ status: "verified" });
    expect(transport.calls).toHaveLength(1);
    expect(readBacks).toBe(2);

    const tampered = structuredClone(checkpoint!) as Record<string, JsonValue>;
    const snapshot = tampered.snapshot as Record<string, JsonValue>;
    const plan = snapshot.plan as Record<string, JsonValue>;
    const operations = plan.operations as Record<string, JsonValue>[];
    operations[0] = {
      ...operations[0],
      command: { binary: "untrusted-checkpoint-command", args: [] },
    };
    tampered.digest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

    await expect(reconcile(tampered)).resolves.toMatchObject({
      status: "failed",
      code: "provider_reconciliation_target_mismatch",
      effectState: "unknown",
    });
    expect(transport.calls).toHaveLength(1);
    expect(readBacks).toBe(2);
  });
});
