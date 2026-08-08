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
import { workflowNode, type WorkflowHandlerContext } from "@/lib/workflow";

const now = new Date("2026-08-04T12:00:00.000Z");
const policies = createDefaultPoliciesConfig();

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
          resourceRefs: [{ type: "product_id", value: "sk_live_abcdefghijklmnop" }],
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
        resourceRefs: ["repository=founder/lifecycle-venture", "url=https://example.test/deploy"],
      },
    });
    expect(await new FileProviderLifecycleStore(lifecyclePath).list()).toEqual([
      expect.objectContaining({
        provider: "github",
        environment: "preview",
        capability: "repository",
        state: "verified",
        resourceRefs: [
          { type: "repository", value: "founder/lifecycle-venture" },
          { type: "url", value: "https://example.test/deploy" },
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
});
