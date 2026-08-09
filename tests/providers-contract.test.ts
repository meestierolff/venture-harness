import { describe, expect, it } from "vitest";
import { CredentialBroker, MemoryCredentialBackend, Redactor } from "@/lib/credentials";
import {
  getProviderAdapter,
  MockProviderTransport,
  providerIds,
  providerRegistry,
  type ProviderExecutionContext,
} from "@/lib/providers";
import { providerPlanFixtures } from "./fixtures/provider/requests";

describe("provider adapter contract", () => {
  it("registers the complete provider catalog with operational declarations", () => {
    expect(providerRegistry.list()).toHaveLength(providerIds.length);
    expect(
      providerRegistry
        .list()
        .map(({ descriptor }) => descriptor.id)
        .sort(),
    ).toEqual([...providerIds].sort());

    for (const id of providerIds) {
      const descriptor = getProviderAdapter(id).descriptor;
      expect(descriptor.id).toBe(id);
      expect(descriptor.displayName.length).toBeGreaterThan(0);
      expect(descriptor.capabilities.length).toBeGreaterThan(0);
      expect(descriptor.authMethods.length).toBeGreaterThan(0);
      expect(descriptor.effectClasses.length).toBeGreaterThan(0);
      expect(descriptor.environments.length).toBeGreaterThan(0);
      expect(descriptor.transports.length).toBeGreaterThan(0);
      expect(descriptor.rateLimits.retryableStatusCodes).toContain(429);
      expect(descriptor.rateLimits.defaultMaxAttempts).toBeGreaterThan(0);
      expect(descriptor.idempotency.notes.length).toBeGreaterThan(0);
      expect(descriptor.verification.evidence.length).toBeGreaterThan(0);
      expect(descriptor.redactionRules.length).toBeGreaterThan(0);
      expect(descriptor).toHaveProperty("requiredScopes");
      expect(descriptor).toHaveProperty("reversibility");
      expect(descriptor).toHaveProperty("riskClass");
    }
  });

  it("builds a type-complete dry-run operation for every declared capability", () => {
    for (const id of providerIds) {
      const adapter = getProviderAdapter(id);
      const plan = adapter.plan(providerPlanFixtures[id]);
      expect(plan.provider).toBe(id);
      expect(plan.dryRun).toBe(true);
      expect(plan.operations.length).toBeGreaterThanOrEqual(adapter.descriptor.capabilities.length);
      expect(new Set(plan.operations.map(({ capability }) => capability))).toEqual(
        new Set(adapter.descriptor.capabilities),
      );
      for (const operation of plan.operations) {
        expect(operation.id).toMatch(new RegExp(`^${id}\\.`));
        expect(operation.idempotencyKey).toMatch(new RegExp(`^${id}:`));
        expect(operation.verification.description.length).toBeGreaterThan(0);
        expect([operation.command, operation.http, operation.manual].filter(Boolean)).toHaveLength(
          1,
        );
        if (operation.credentialRef) {
          expect(operation.credentialRef).toMatch(/^cred:\/\//);
        }
      }
    }
  });

  it("emits concrete official CLI operation plans", () => {
    const github = getProviderAdapter("github").plan(providerPlanFixtures.github);
    expect(github.operations.map(({ command }) => command?.binary)).toEqual([
      "node",
      "gh",
      "gh",
      "gh",
    ]);
    expect(github.operations[0]).toMatchObject({
      action: "repository.create_from_source",
      reconcileOnReplay: true,
      command: {
        cwd: ".",
        args: expect.arrayContaining([
          "scripts/github-publish-source.ts",
          "apply",
          "--repository",
          "example/venture",
        ]),
      },
    });
    expect(github.operations[0].command?.args).not.toContain("--template");
    expect(github.operations[0].readBack?.assertions).toEqual(
      expect.arrayContaining([
        { path: "commitOid", operator: "equals", expected: "{result.commitOid}" },
        { path: "treeOid", operator: "equals", expected: "{result.treeOid}" },
      ]),
    );
    expect(github.operations[1].command?.stdinCredentialRef).toBe(
      "cred://github/actions-secret-payload",
    );

    const vercel = getProviderAdapter("vercel").plan(providerPlanFixtures.vercel);
    expect(vercel.operations.flatMap(({ command }) => (command ? [command.args[0]] : []))).toEqual([
      "link",
      "env",
      "deploy",
      "domains",
    ]);
    expect(vercel.operations.at(-1)).toMatchObject({
      capability: "web_analytics",
      transport: "manual",
    });

    const neon = getProviderAdapter("neon").plan(providerPlanFixtures.neon);
    expect(neon.operations.slice(0, 4).every(({ command }) => command?.binary === "neonctl")).toBe(
      true,
    );
    expect(
      neon.operations
        .slice(0, 4)
        .every(({ command }) => command?.authEnvironment?.name === "NEON_API_KEY"),
    ).toBe(true);
    const projectOrgIndex = neon.operations[0].command?.args.indexOf("--org-id") ?? -1;
    expect(projectOrgIndex).toBeGreaterThanOrEqual(0);
    expect(neon.operations[0].command?.args[projectOrgIndex + 1]).toBe("org-example");
    expect(neon.operations[0].readBack?.command?.args).not.toContain("--org-id");
    expect(neon.operations.slice(1, 4).flatMap(({ command }) => command?.args ?? [])).not.toContain(
      "--org-id",
    );
    expect(neon.operations[0].readBack?.assertions).toContainEqual({
      path: "org_id",
      operator: "equals",
      expected: "org-example",
    });
    expect(neon.operations.slice(4).map(({ command }) => command?.binary)).toEqual([
      "psql",
      "psql",
    ]);
    expect(
      neon.operations
        .slice(4)
        .every(
          ({ command }) =>
            command?.authEnvironment?.name === "PGDATABASE" &&
            command.authEnvironment.credentialRef === "cred://neon/database",
        ),
    ).toBe(true);
    expect(neon.operations.slice(4).flatMap(({ command }) => command?.args ?? [])).not.toContain(
      "cred://neon/database",
    );

    const eas = getProviderAdapter("eas").plan(providerPlanFixtures.eas);
    expect(eas.operations[0].transport).toBe("manual");
    expect(eas.operations.slice(1).map(({ command }) => command?.args[0])).toEqual([
      "integrations:asc:connect",
      "build",
      "submit",
    ]);
    expect(eas.operations[2].readBack?.assertions).toEqual(
      expect.arrayContaining([
        { path: "id", operator: "equals", expected: "{result.id}" },
        { path: "status", operator: "equals", expected: "FINISHED" },
      ]),
    );
    expect(eas.operations[3].readBack?.assertions).toContainEqual(
      expect.objectContaining({
        operator: "contains",
        expected: expect.objectContaining({
          status: "FINISHED",
          submittedBuild: { id: "build-example" },
        }),
      }),
    );
  });

  it("chains explicit Vercel creation through link and structured deployment read-back", () => {
    const plan = getProviderAdapter("vercel").plan({
      ...providerPlanFixtures.vercel,
      capabilities: ["project", "deployment"],
      inputs: {
        project: "new-venture",
        scope: "example-team",
        projectIntent: "create",
      },
    });

    expect(plan.operations.map(({ action }) => action)).toEqual([
      "project.create",
      "project.link",
      "deployment.production",
    ]);
    expect(plan.operations[1].dependsOn).toEqual([plan.operations[0].id]);
    expect(plan.operations[2].dependsOn).toEqual([plan.operations[1].id]);
    expect(plan.operations[2].command?.args).toContain("--format=json");
    expect(plan.operations[2].readBack?.command?.args).toContain("--format=json");
    expect(plan.operations[2].readBack?.assertions).toEqual([
      { path: "id", operator: "equals", expected: "{result.id}" },
      { path: "readyState", operator: "equals", expected: "READY" },
    ]);
  });

  it("emits concrete official API operation plans without credential values", () => {
    const expectedHosts = {
      stripe: "api.stripe.com",
      revenuecat: "api.revenuecat.com",
      brevo: "api.brevo.com",
      google: "googleapis.com",
      bing: "bing.com",
      app_store_connect: "api.appstoreconnect.apple.com",
    } as const;
    for (const [id, host] of Object.entries(expectedHosts)) {
      const plan = getProviderAdapter(id as keyof typeof expectedHosts).plan(
        providerPlanFixtures[id as keyof typeof expectedHosts],
      );
      for (const operation of plan.operations.filter(({ transport }) => transport === "http")) {
        expect(operation.http?.url).toContain(host);
        expect(operation.http?.auth?.credentialRef).toMatch(/^cred:\/\//);
        expect(JSON.stringify(operation.http)).not.toMatch(
          /sk_live|private[-_ ]?key-----|do_not_log/i,
        );
      }
    }

    const stripe = getProviderAdapter("stripe").plan(providerPlanFixtures.stripe);
    expect(stripe.operations.every(({ http }) => http?.nativeIdempotency)).toBe(true);
    expect(stripe.operations.map(({ http }) => http?.url)).toEqual([
      "https://api.stripe.com/v1/products",
      "https://api.stripe.com/v1/prices",
      "https://api.stripe.com/v1/webhook_endpoints",
      "https://api.stripe.com/v1/billing_portal/configurations",
    ]);
    expect(
      stripe.operations.find(({ capability }) => capability === "webhook")?.http,
    ).toMatchObject({
      captureCredential: {
        credentialRef: "cred://stripe/webhook-secret",
        outputPath: "secret",
      },
    });

    const bing = getProviderAdapter("bing").plan(providerPlanFixtures.bing);
    expect(bing.operations.map(({ http }) => http?.body)).toEqual([
      { siteUrl: "https://example.test" },
      {
        siteUrl: "https://example.test",
        feedUrl: "https://example.test/sitemap.xml",
      },
      {
        siteUrl: "https://example.test",
        url: "https://example.test/pricing",
      },
    ]);
    expect(bing.operations[0].readBack?.assertions).toEqual([
      {
        path: "d",
        operator: "contains",
        expected: { Url: "https://example.test" },
      },
    ]);
    expect(bing.operations[1].readBack?.assertions).toEqual([
      {
        path: "d",
        operator: "contains",
        expected: { Url: "https://example.test/sitemap.xml" },
      },
    ]);
    const google = getProviderAdapter("google").plan(providerPlanFixtures.google);
    expect(
      google.operations.find(({ capability }) => capability === "analytics_web_stream")?.http
        ?.captureCredential,
    ).toEqual({
      credentialRef: "cred://google/measurement-id",
      outputPath: "webStreamData.measurementId",
    });
  });

  it("keeps DNS and MijnDomein honest manual plans", () => {
    for (const id of ["dns", "mijndomein"] as const) {
      const plan = getProviderAdapter(id).plan(providerPlanFixtures[id]);
      expect(plan.operations.every(({ transport }) => transport === "manual")).toBe(true);
      expect(plan.operations.every(({ manual }) => manual?.instructions.length)).toBeTruthy();
      expect(JSON.stringify(plan)).not.toContain('"command"');
      expect(JSON.stringify(plan)).not.toContain('"http"');
    }
  });

  it("keeps Vercel Web Analytics enablement as a read-back-gated manual action", () => {
    const plan = getProviderAdapter("vercel").plan({
      environment: "preview",
      capabilities: ["web_analytics"],
      credentialRef: "cred://vercel/primary",
      inputs: { project: "reviewed-project", scope: "reviewed-team" },
      dryRun: false,
    });

    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      capability: "web_analytics",
      action: "web_analytics.enable_manual",
      transport: "manual",
      manual: {
        requiredFields: { project: "reviewed-project", scope: "reviewed-team" },
      },
      verification: { strategy: "manual" },
    });
    expect(plan.operations[0].manual?.completionEvidence.join(" ")).toContain(
      "analytics script request",
    );
  });

  it("models Apple's first app record as manual and only subsequent actions as API/CLI", () => {
    const apple = getProviderAdapter("app_store_connect").plan(
      providerPlanFixtures.app_store_connect,
    );
    expect(apple.operations[0]).toMatchObject({
      capability: "first_app_record",
      transport: "manual",
      action: "app_record.create_manual",
    });
    expect(apple.operations.slice(1).every(({ transport }) => transport === "http")).toBe(true);
    expect(apple.operations.some(({ http }) => http?.url.endsWith("/v1/apps"))).toBe(false);

    const eas = getProviderAdapter("eas").plan(providerPlanFixtures.eas);
    expect(eas.operations[0]).toMatchObject({
      capability: "app_store_prerequisite",
      transport: "manual",
    });
  });

  it("reports credential and transport readiness without exposing values", async () => {
    const memory = new MemoryCredentialBackend();
    const broker = new CredentialBroker([memory]);
    await broker.store({
      ref: "cred://github/primary",
      provider: "github",
      kind: "cli_session",
      backend: "memory",
      scopes: ["*"],
      value: "github-doctor-secret",
    });
    const context: ProviderExecutionContext = {
      authorization: "dry_run",
      credentials: broker,
      redactor: broker.redactor,
      transports: { cli: new MockProviderTransport("cli") },
    };
    const result = await getProviderAdapter("github").doctor(
      {
        credentialRefs: ["cred://github/primary"],
        requiredCapabilities: ["repository"],
      },
      context,
    );
    expect(result.status).toBe("ready");
    expect(result.credentialRefs).toEqual([
      {
        ref: "cred://github/primary",
        status: "available",
        scopes: ["*"],
        expiresAt: undefined,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("github-doctor-secret");
  });

  it("reports manual-only providers without pretending to have executable access", async () => {
    const result = await getProviderAdapter("dns").doctor(
      { requiredCapabilities: ["record"] },
      {
        authorization: "dry_run",
        redactor: new Redactor(),
        transports: {},
      },
    );
    expect(result.status).toBe("manual_only");
    expect(result.transports).toEqual([
      { kind: "manual", available: true, detail: "Human completion is required" },
    ]);
    expect(result.issues.some(({ code }) => code === "provider_limitation")).toBe(true);
  });
});
