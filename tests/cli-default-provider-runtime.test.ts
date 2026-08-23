import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  createDefaultProviderPlanFactories,
  DEFAULT_PROVIDER_TARGETS,
  inspectDefaultProviderDoctor,
  loadDefaultProviderConfig,
} from "@/lib/cli/default-provider-runtime";
import {
  CliSessionCredentialBackend,
  CredentialBroker,
  MemoryCredentialBackend,
  type CommandInvocation,
  type CommandRunner,
} from "@/lib/credentials";
import { founderBriefFromLaunchContract } from "@/lib/founder-launch";
import { compileLaunchGraph, founderBriefSchema } from "@/lib/launch";
import { MockProviderTransport, providerRegistry } from "@/lib/providers";
import {
  createOfficialProviderContext,
  type ProviderLifecycleScope,
  type ProviderLifecycleStore,
  type VerifiedProviderLifecycleRecord,
} from "@/lib/runtime";
import type { JsonValue, WorkflowHandlerContext, WorkflowNodeDefinition } from "@/lib/workflow";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";

function brief(path: string) {
  return founderBriefSchema.parse(parse(readFileSync(path, "utf8")));
}

function workflowContext(
  node: WorkflowNodeDefinition,
  dependencyOutputs: Record<string, JsonValue | undefined> = {},
): WorkflowHandlerContext {
  return {
    runId: "offline-provider-factory-test",
    node,
    attempt: 1,
    dependencyOutputs,
    idempotencyKey: `test:${node.id}`,
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

function lifecycleStore(
  records: readonly VerifiedProviderLifecycleRecord[],
  listError?: Error,
): ProviderLifecycleStore {
  return {
    async list() {
      if (listError) throw listError;
      return records.map((record) => ({
        ...record,
        resourceRefs: record.resourceRefs.map((reference) => ({ ...reference })),
      }));
    },
    async get(scope: ProviderLifecycleScope) {
      return (
        records.find(
          (record) =>
            record.provider === scope.provider &&
            record.environment === scope.environment &&
            record.capability === scope.capability,
        ) ?? null
      );
    },
    async recordVerified() {},
  };
}

describe("default provider composition", () => {
  it("preserves an accepted 0.29 Launch Contract price as exactly 29 Stripe minor units", async () => {
    const base = launchReceiptContract();
    const contract = launchReceiptContract({
      business: { ...base.business, priceHypothesis: 0.29 },
    });
    const founderBrief = founderBriefFromLaunchContract(contract);
    const definition = compileLaunchGraph(founderBrief);
    const snapshot = loadDefaultProviderConfig(process.cwd());
    Object.assign(snapshot.providers.providers.stripe!, {
      state: "unconfigured",
      credential_ref: "cred://stripe/test",
      account_id: "acct_exact_decimal_test",
      external_resource_ids: {
        mode: "test",
        webhook_secret_credential_ref: "cred://stripe/exact-decimal-webhook",
      },
    });
    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      launchContract: contract,
      loadConfig: () => snapshot,
    });
    const stripeNode = definition.nodes.find(({ id }) => id === "stripe-commerce")!;

    await expect(
      factories["provider.stripe-commerce"]!(workflowContext(stripeNode)),
    ).resolves.toMatchObject({ request: { inputs: { unitAmount: 29 } } });
  });

  it("feeds staged Brevo, Google, EAS, and TestFlight nodes only from same-run public outputs", async () => {
    const webBrief = founderBriefSchema.parse({
      ...brief("fixtures/web-saas/brief.yaml"),
      domain: "staged.example",
    });
    const webDefinition = compileLaunchGraph(webBrief, undefined, {
      initialOrigin: "custom_domain",
    });
    const webSnapshot = loadDefaultProviderConfig(process.cwd());
    webSnapshot.venture.venture.name = "Staged venture";
    webSnapshot.venture.venture.domain = "staged.example";
    Object.assign(webSnapshot.providers.providers.brevo!, {
      credential_ref: "cred://brevo/staged",
      external_resource_ids: {
        sender_name: "Staged team",
        sender_email: "hello@staged.example",
        template_name: "Welcome",
        template_subject: "Welcome",
        template_html: "<p>Welcome.</p>",
      },
    });
    Object.assign(webSnapshot.providers.providers.google!, {
      credential_ref: "cred://google/staged",
      external_resource_ids: {
        analytics_account_id: "123456",
        measurement_id_credential_ref: "cred://google/staged-measurement-id",
      },
    });
    const webFactories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: webBrief,
      definition: webDefinition,
      loadConfig: () => webSnapshot,
    });
    const webNode = (id: string) => webDefinition.nodes.find((candidate) => candidate.id === id)!;
    const propertyOutput = {
      publicOutputs: {
        dnsRecords: [],
        identifiers: [{ type: "property_id", value: "987654" }],
      },
    } as JsonValue;
    const dnsOutput = {
      mode: "manual_dns",
      records: [
        {
          source_provider: "google",
          type: "TXT",
          name: "@",
          value: "google-site-verification=public",
          ttl: 3600,
          reason: "Verify Google ownership.",
        },
        {
          source_provider: "brevo",
          type: "TXT",
          name: "@",
          value: "brevo-code=public",
          ttl: 3600,
          reason: "Authenticate Brevo.",
        },
      ],
      preserved_existing_mail_records: true,
      preserved_nameservers: true,
      propagation_checks: [
        {
          resolver: "ns1.example.test",
          checked_at: "2026-08-04T12:00:00.000Z",
          status: "matched",
        },
        {
          resolver: "ns2.example.test",
          checked_at: "2026-08-04T12:01:00.000Z",
          status: "matched",
        },
      ],
    } as JsonValue;

    await expect(
      webFactories["provider.google-analytics-stream"]!(
        workflowContext(webNode("google-analytics-stream")),
      ),
    ).rejects.toThrow("same-run");

    const productionOutput = {
      provider: "vercel",
      state: "verified",
      environments: ["production"],
      capabilities: ["deployment"],
      resourceRefs: ["url=https://staged-production.vercel.app"],
    } as JsonValue;

    await expect(
      webFactories["provider.google-analytics-stream"]!(
        workflowContext(webNode("google-analytics-stream"), {
          "google-analytics-property": propertyOutput,
          "initial-production-deploy": productionOutput,
        }),
      ),
    ).resolves.toMatchObject({
      provider: "google",
      request: { inputs: { analyticsPropertyId: "987654" } },
    });
    await expect(
      webFactories["provider.google-site-verification"]!(
        workflowContext(webNode("google-site-verification"), { "dns-records": dnsOutput }),
      ),
    ).resolves.toMatchObject({ request: { capabilities: ["site_verification"] } });
    await expect(
      webFactories["provider.brevo-domain-verification"]!(
        workflowContext(webNode("brevo-domain-verification"), { "dns-records": dnsOutput }),
      ),
    ).resolves.toMatchObject({ request: { capabilities: ["sending_domain_verification"] } });

    const mobileBrief = brief("fixtures/ios-subscription/brief.yaml");
    const mobileDefinition = compileLaunchGraph(mobileBrief);
    const mobileSnapshot = loadDefaultProviderConfig(process.cwd());
    mobileSnapshot.venture.venture.name = "Staged mobile";
    mobileSnapshot.mobile.mobile.bundle_identifier = "com.example.staged";
    mobileSnapshot.mobile.mobile.eas.project_id = "eas-project-staged";
    mobileSnapshot.mobile.mobile.eas.credential_ref = "cred://eas/staged";
    mobileSnapshot.mobile.mobile.app_store_connect.credential_ref = "cred://apple/staged";
    Object.assign(mobileSnapshot.providers.providers.app_store_connect!, {
      external_resource_ids: { beta_group_name: "Internal staged" },
    });
    const mobileFactories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: mobileBrief,
      definition: mobileDefinition,
      loadConfig: () => mobileSnapshot,
    });
    const mobileNode = (id: string) =>
      mobileDefinition.nodes.find((candidate) => candidate.id === id)!;
    const appleOutput = {
      apple_app_id: "1234567890",
      bundle_identifier: "com.example.staged",
    } as JsonValue;
    const buildOutput = {
      publicOutputs: {
        dnsRecords: [],
        identifiers: [
          { type: "build_id", value: "eas-build-staged" },
          { type: "app_version", value: "0.1.0" },
          { type: "build_number", value: "1" },
        ],
      },
    } as JsonValue;
    const easSubmit = await mobileFactories["provider.eas-submit"]!(
      workflowContext(mobileNode("eas-submit"), {
        "apple-first-app-record": appleOutput,
        "eas-build": buildOutput,
      }),
    );
    await expect(
      mobileFactories["provider.eas-submit"]!(
        workflowContext(mobileNode("eas-submit"), {
          "apple-first-app-record": appleOutput,
          "eas-build": {
            publicOutputs: {
              dnsRecords: [],
              identifiers: [
                { type: "build_id", value: "first-build" },
                { type: "build_id", value: "ambiguous-build" },
              ],
            },
          } as JsonValue,
        }),
      ),
    ).rejects.toThrow("one exact build_id");
    expect(easSubmit.request).toMatchObject({
      capabilities: ["app_store_connection", "ios_submit"],
      inputs: {
        appStoreAppId: "1234567890",
        bundleId: "com.example.staged",
        easBuildId: "eas-build-staged",
      },
    });
    expect(
      providerRegistry
        .get("eas")
        .plan({ ...easSubmit.request, dryRun: true })
        .operations.map(({ action }) => action),
    ).toEqual(["app_store_connection.connect", "ios.submit"]);
    const testflight = await mobileFactories["provider.testflight-state"]!(
      workflowContext(mobileNode("testflight-state"), {
        "apple-first-app-record": appleOutput,
        "eas-build": buildOutput,
        "eas-submit": { state: "verified" },
      }),
    );
    expect(testflight.request).toMatchObject({
      capabilities: ["build_processing", "testflight_group", "build_group_assignment"],
      inputs: { appStoreAppId: "1234567890", appVersion: "0.1.0", buildNumber: "1" },
    });
  });

  it("captures config once and returns complete GitHub, Vercel, and Neon requests", async () => {
    const founderBrief = brief("fixtures/web-saas/brief.yaml");
    const definition = compileLaunchGraph(founderBrief);
    const snapshot = loadDefaultProviderConfig(process.cwd());
    const missingFactories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    const node = (id: string) => definition.nodes.find((candidate) => candidate.id === id)!;

    await expect(
      missingFactories["provider.github-repository"]!(workflowContext(node("github-repository"))),
    ).rejects.toThrow("config/providers.yaml providers.github.credential_ref");

    Object.assign(snapshot.providers.providers.github!, {
      state: "verified",
      team_id: "founder-org",
      credential_ref: "cred://github/founder",
      last_verified_at: "2026-08-04T10:00:00.000Z",
      evidence_artifact_ref: "reports/providers/github.json",
      external_resource_ids: {
        repository: "founder-org/first-venture",
        repository_intent: "use_verified",
      },
    });
    Object.assign(snapshot.providers.providers.vercel!, {
      state: "verified",
      team_id: "team_founder",
      credential_ref: "cred://vercel/founder",
      last_verified_at: "2026-08-04T10:00:00.000Z",
      evidence_artifact_ref: "reports/providers/vercel.json",
      external_resource_ids: { project: "first-venture" },
    });
    Object.assign(snapshot.providers.providers.neon!, {
      state: "verified",
      credential_ref: "cred://neon/control-plane",
      last_verified_at: "2026-08-04T10:00:00.000Z",
      evidence_artifact_ref: "reports/providers/neon.json",
      external_resource_ids: {
        organization_id: "neon-org-from-stack",
        project_id: "project-from-readback",
        branch_id: "branch-from-readback",
        database_name: "venture",
        database_credential_ref: "cred://neon/database",
      },
    });
    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    const github = await factories["provider.github-repository"]!(
      workflowContext(node("github-repository")),
    );
    expect(github).toMatchObject({
      provider: "github",
      request: {
        capabilities: ["repository"],
        credentialRef: "cred://github/founder",
        inputs: { repository: "founder-org/first-venture" },
        dryRun: false,
      },
    });

    snapshot.providers.providers.github!.external_resource_ids.repository =
      "founder-org/renamed-venture";
    const githubAfterConfigChange = await factories["provider.github-repository"]!(
      workflowContext(node("github-repository")),
    );
    expect(githubAfterConfigChange.request.inputs.repository).toBe("founder-org/first-venture");

    const vercelPreview = await factories["provider.vercel-project"]!(
      workflowContext(node("vercel-project")),
    );
    const vercelProduction = await factories["provider.production-deploy"]!(
      workflowContext(node("production-deploy")),
    );
    expect(vercelPreview.request).toMatchObject({
      environment: "preview",
      capabilities: ["project", "deployment"],
      inputs: { project: "first-venture", scope: "team_founder" },
    });
    expect(vercelProduction.request).toMatchObject({
      environment: "production",
      capabilities: ["deployment"],
      inputs: { project: "first-venture", scope: "team_founder" },
    });

    const neon = await factories["provider.neon-database"]!(workflowContext(node("neon-database")));
    expect(neon.request).toMatchObject({
      capabilities: ["schema_migration", "read_write_health_check"],
      credentialRef: "cred://neon/control-plane",
      inputs: {
        projectId: "project-from-readback",
        branchId: "branch-from-readback",
        databaseName: "venture",
        databaseCredentialRef: "cred://neon/database",
        workingDirectory: process.cwd(),
      },
    });
    const neonDryRun = providerRegistry.get("neon").plan({ ...neon.request, dryRun: true });
    expect(neonDryRun.operations.map(({ capability }) => capability)).toEqual([
      "schema_migration",
      "read_write_health_check",
    ]);
  });

  it("reuses only a verified preview Vercel project identity for production deployment", async () => {
    const founderBrief = brief("fixtures/web-saas/brief.yaml");
    const definition = compileLaunchGraph(founderBrief);
    const snapshot = loadDefaultProviderConfig(process.cwd());
    Object.assign(snapshot.providers.providers.vercel!, {
      state: "auth_required",
      team_id: "team_founder",
      credential_ref: "cred://vercel/founder",
      external_resource_ids: {
        project: "cross-environment-project",
        project_intent: "create",
      },
    });
    const productionNode = definition.nodes.find(({ id }) => id === "production-deploy")!;
    const previewProject: VerifiedProviderLifecycleRecord = {
      provider: "vercel",
      environment: "preview",
      capability: "project",
      state: "verified",
      planId: "plan.vercel.previewproject",
      verifiedAt: "2026-08-04T12:00:00.000Z",
      resourceRefs: [{ type: "project", value: "cross-environment-project" }],
    };
    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
      lifecycleStore: lifecycleStore([previewProject]),
    });

    await expect(
      factories["provider.production-deploy"]!(workflowContext(productionNode)),
    ).resolves.toMatchObject({
      provider: "vercel",
      request: {
        environment: "production",
        capabilities: ["deployment"],
        inputs: { project: "cross-environment-project", scope: "team_founder" },
      },
    });

    const previewDeploymentOnly = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
      lifecycleStore: lifecycleStore([
        {
          ...previewProject,
          capability: "deployment",
          planId: "plan.vercel.previewdeployment",
        },
      ]),
    });
    await expect(
      previewDeploymentOnly["provider.production-deploy"]!(workflowContext(productionNode)),
    ).rejects.toThrow("no matching verified lifecycle record");
  });

  it("keeps optional Vercel analytics out of automatic GitHub, Vercel, and Neon creation", async () => {
    const founderBrief = brief("fixtures/web-saas/brief.yaml");
    const definition = compileLaunchGraph(founderBrief);
    const snapshot = loadDefaultProviderConfig(process.cwd());
    let factories: ReturnType<typeof createDefaultProviderPlanFactories>;
    const node = (id: string) => definition.nodes.find((candidate) => candidate.id === id)!;

    Object.assign(snapshot.providers.providers.github!, {
      state: "unconfigured",
      team_id: "founder-org",
      credential_ref: "cred://github/founder",
      external_resource_ids: {
        repository: "founder-org/new-venture",
        repository_intent: "create_from_source",
      },
    });
    factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    const github = await factories["provider.github-repository"]!(
      workflowContext(node("github-repository")),
    );
    expect(github.request).toMatchObject({
      capabilities: ["repository"],
      inputs: {
        repository: "founder-org/new-venture",
        sourceDirectory: process.cwd(),
      },
    });
    snapshot.providers.providers.github!.external_resource_ids.repository_intent =
      "create_from_template";
    snapshot.providers.providers.github!.external_resource_ids.template_repository =
      "legacy/template";
    const legacyGithub = await factories["provider.github-repository"]!(
      workflowContext(node("github-repository")),
    );
    expect(legacyGithub.request.inputs).toMatchObject({
      repository: "founder-org/new-venture",
      sourceDirectory: process.cwd(),
    });
    expect(legacyGithub.request.inputs).not.toHaveProperty("templateRepository");

    Object.assign(snapshot.providers.providers.vercel!, {
      state: "unconfigured",
      team_id: "team_founder",
      credential_ref: "cred://vercel/founder",
      external_resource_ids: {
        project: "new-venture",
        project_intent: "create",
      },
    });
    snapshot.venture.venture.domain = "new-venture.example";
    expect(snapshot.venture.venture.capabilities.active).toEqual(["public_website"]);
    factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    const vercel = await factories["provider.vercel-project"]!(
      workflowContext(node("vercel-project")),
    );
    expect(vercel.request).toMatchObject({
      capabilities: ["project", "deployment"],
      inputs: {
        project: "new-venture",
        scope: "team_founder",
        projectIntent: "create",
      },
    });
    expect(vercel.request.inputs).not.toHaveProperty("domain");
    const vercelPlan = providerRegistry.get("vercel").plan({
      ...vercel.request,
      dryRun: true,
    });
    expect(vercelPlan.operations.map(({ action }) => action)).toEqual([
      "project.create",
      "project.link",
      "deployment.preview",
    ]);
    expect(vercelPlan.operations.some(({ capability }) => capability === "web_analytics")).toBe(
      false,
    );
    expect(vercelPlan.operations.some(({ transport }) => transport === "manual")).toBe(false);
    expect(vercelPlan.limitations.join(" ")).toContain(
      "Web Analytics enablement stays a declared manual action",
    );

    Object.assign(snapshot.providers.providers.neon!, {
      state: "unconfigured",
      account_id: "neon-credential-account",
      credential_ref: "cred://neon/control-plane",
      region: "aws-eu-central-1",
      external_resource_ids: {
        organization_id: "neon-org-from-stack",
        project_intent: "create",
        project_name: "new-venture",
        database_credential_ref: "cred://neon/database",
      },
    });
    factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    const neon = await factories["provider.neon-database"]!(workflowContext(node("neon-database")));
    expect(neon.request).toMatchObject({
      capabilities: ["project", "schema_migration", "read_write_health_check"],
      credentialRef: "cred://neon/control-plane",
      inputs: {
        organizationId: "neon-org-from-stack",
        projectName: "new-venture",
        regionId: "aws-eu-central-1",
        databaseCredentialRef: "cred://neon/database",
        workingDirectory: process.cwd(),
      },
    });
    const neonPlan = providerRegistry.get("neon").plan({ ...neon.request, dryRun: true });
    expect(neonPlan.operations.map(({ action }) => action)).toEqual([
      "project.create",
      "schema.migrate",
      "database.read_write_health_check",
    ]);
    expect(neonPlan.operations[0].command?.captureCredential).toEqual({
      credentialRef: "cred://neon/database",
      outputPath: "connection_uris.0.connection_uri",
    });
    expect(neonPlan.operations[1].dependsOn).toEqual([neonPlan.operations[0].id]);
    expect(neonPlan.operations[1].command?.cwd).toBe(process.cwd());
    expect(neonPlan.operations[1].readBack?.command?.cwd).toBe(process.cwd());
    const createArgs = neonPlan.operations[0].command?.args ?? [];
    expect(
      createArgs.slice(createArgs.indexOf("--org-id"), createArgs.indexOf("--org-id") + 2),
    ).toEqual(["--org-id", "neon-org-from-stack"]);
    expect(createArgs).not.toContain("neon-credential-account");
    expect(node("neon-database").purpose).toContain("credential reference");
  });

  it("fails founder Neon creation before planning when the Stack organization id is missing", async () => {
    const founderBrief = brief("fixtures/web-saas/brief.yaml");
    const definition = compileLaunchGraph(founderBrief);
    const snapshot = loadDefaultProviderConfig(process.cwd());
    Object.assign(snapshot.providers.providers.neon!, {
      state: "unconfigured",
      account_id: "must-not-be-used-as-neon-org",
      credential_ref: "cred://neon/control-plane",
      region: "aws-eu-central-1",
      external_resource_ids: {
        project_intent: "create",
        project_name: "new-venture",
        database_credential_ref: "cred://neon/database",
      },
    });
    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    const neonNode = definition.nodes.find(({ id }) => id === "neon-database")!;

    await expect(factories["provider.neon-database"]!(workflowContext(neonNode))).rejects.toThrow(
      "providers.neon.external_resource_ids.organization_id",
    );
  });

  it("builds one exact test-mode Stripe price and binds it to the created product", async () => {
    const founderBrief = founderBriefSchema.parse({
      ...brief("fixtures/web-saas/brief.yaml"),
      domain: "reviewed.example",
    });
    const definition = compileLaunchGraph(founderBrief, undefined, {
      initialOrigin: "custom_domain",
    });
    const snapshot = loadDefaultProviderConfig(process.cwd());
    snapshot.venture.venture.name = "Reviewed venture";
    snapshot.venture.venture.domain = "reviewed.example";
    snapshot.offer.offer.sentence = "A reviewed test offer";
    snapshot.offer.pricing.monthly_price = 19.95;
    Object.assign(snapshot.providers.providers.stripe!, {
      state: "unconfigured",
      credential_ref: "cred://stripe/test",
      account_id: "acct_reviewed_test",
      external_resource_ids: {
        mode: "test",
        webhook_secret_credential_ref: "cred://stripe/reviewed-webhook",
      },
    });
    Object.assign(snapshot.providers.providers.vercel!, {
      credential_ref: "cred://vercel/reviewed",
      team_id: "reviewed-team",
      external_resource_ids: { project: "reviewed-venture", project_intent: "create" },
    });
    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    // These are the same classes of protected inputs a model task could try
    // to tamper with after provider composition. The factory must retain the
    // parsed pre-model brief/offer snapshot.
    snapshot.offer.pricing.monthly_price = 999;
    snapshot.venture.venture.domain = "tampered.example";
    (founderBrief as { domain?: string | null }).domain = "tampered.example";
    const stripeNode = definition.nodes.find(({ id }) => id === "stripe-commerce")!;

    const target = await factories["provider.stripe-commerce"]!(workflowContext(stripeNode));
    expect(target.request).toMatchObject({
      environment: "sandbox",
      capabilities: ["product", "price"],
      inputs: {
        ventureSlug: "synthetic-web-saas",
        stripeAccountId: "acct_reviewed_test",
        stripeMode: "test",
        productName: "Synthetic Web SaaS",
        productId: "{dependency.product.id}",
        currency: "eur",
        unitAmount: 1995,
        recurringInterval: "month",
      },
    });
    const plan = providerRegistry.get("stripe").plan({ ...target.request, dryRun: false });
    expect(plan.operations.map(({ action }) => action)).toEqual(["product.create", "price.create"]);
    expect(plan.operations[1].dependsOn).toEqual([plan.operations[0].id]);
    expect(plan.operations[1].http?.body).toMatchObject({
      product: "{dependency.product.id}",
      currency: "eur",
      unit_amount: 1995,
    });
    const callbacksNode = definition.nodes.find(({ id }) => id === "stripe-callbacks")!;
    const initialProductionOutput = {
      provider: "vercel",
      state: "verified",
      environments: ["production"],
      capabilities: ["deployment"],
      resourceRefs: ["url=https://reviewed-production.vercel.app"],
    } as JsonValue;
    const callbacks = await factories["provider.stripe-callbacks"]!(
      workflowContext(callbacksNode, {
        "initial-production-deploy": initialProductionOutput,
      }),
    );
    expect(callbacks.request).toMatchObject({
      capabilities: ["webhook", "billing_portal"],
      inputs: {
        webhookUrl: "https://reviewed-production.vercel.app/api/stripe/webhook",
        webhookSecretCredentialRef: "cred://stripe/reviewed-webhook",
        portalReturnUrl: "https://reviewed-production.vercel.app/account",
      },
    });
    const callbackPlan = providerRegistry
      .get("stripe")
      .plan({ ...callbacks.request, dryRun: false });
    expect(callbackPlan.operations.map(({ action }) => action)).toEqual([
      "webhook_endpoint.create",
      "billing_portal.configuration.create",
    ]);
    expect(callbackPlan.operations[0].http?.captureCredential).toEqual({
      credentialRef: "cred://stripe/reviewed-webhook",
      outputPath: "secret",
    });
    const domainCallbacksNode = definition.nodes.find(
      ({ id }) => id === "stripe-domain-callbacks",
    )!;
    await expect(
      factories["provider.stripe-domain-callbacks"]!(workflowContext(domainCallbacksNode)),
    ).rejects.toThrow("custom-domain callbacks require same-run verified");
    const verifiedDomainDependencies = {
      "vercel-project": {
        provider: "vercel",
        state: "verified",
        capabilities: ["domain"],
        resourceRefs: ["domain=reviewed.example"],
      },
      "dns-records": {
        mode: "manual_dns",
        propagation_checks: [
          { resolver: "1.1.1.1", status: "matched" },
          { resolver: "8.8.8.8", status: "matched" },
        ],
      },
      "verify-custom-domain": {
        target: "verified_custom_domain",
        deploymentUrl: "https://reviewed.example",
        customDomain: { state: "verified", origin: "https://reviewed.example" },
      },
    } as JsonValue;
    await expect(
      factories["provider.stripe-domain-callbacks"]!(
        workflowContext(
          domainCallbacksNode,
          verifiedDomainDependencies as Record<string, JsonValue>,
        ),
      ),
    ).resolves.toMatchObject({
      request: {
        inputs: {
          webhookUrl: "https://reviewed.example/api/stripe/webhook",
          portalReturnUrl: "https://reviewed.example/account",
        },
      },
    });
    const stripeEnvironmentNode = definition.nodes.find(
      ({ id }) => id === "vercel-stripe-webhook-environment",
    )!;
    await expect(
      factories["provider.vercel-stripe-webhook-environment"]!(
        workflowContext(stripeEnvironmentNode),
      ),
    ).resolves.toMatchObject({
      provider: "vercel",
      request: {
        capabilities: ["environment_variable"],
        inputs: {
          project: "reviewed-venture",
          scope: "reviewed-team",
          environmentVariableName: "STRIPE_WEBHOOK_SECRET",
          environmentTarget: "production",
          environmentValueCredentialRef: "cred://stripe/reviewed-webhook",
        },
      },
    });
    const publicOutput = {
      publicOutputs: {
        dnsRecords: [],
        identifiers: [{ type: "price_id", value: "price_same_run_123" }],
      },
    } as JsonValue;
    const priceEnvironmentNode = definition.nodes.find(
      ({ id }) => id === "vercel-stripe-price-environment",
    )!;
    const priceEnvironment = await factories["provider.vercel-stripe-price-environment"]!(
      workflowContext(priceEnvironmentNode, { "stripe-commerce": publicOutput }),
    );
    expect(priceEnvironment.request).toMatchObject({
      environment: "production",
      inputs: {
        environmentVariableName: "STRIPE_PRICE_ID",
        environmentPublicValue: "price_same_run_123",
      },
    });
    const publicEnvironmentPlan = providerRegistry
      .get("vercel")
      .plan({ ...priceEnvironment.request, dryRun: false });
    expect(publicEnvironmentPlan.operations[0].command).toMatchObject({
      args: expect.arrayContaining([
        "--value",
        "price_same_run_123",
        "--no-sensitive",
        "--project",
        "reviewed-venture",
      ]),
    });
    expect(publicEnvironmentPlan.operations[0].command).not.toHaveProperty("stdinCredentialRef");

    const lookupEnvironmentNode = definition.nodes.find(
      ({ id }) => id === "vercel-stripe-price-lookup-environment",
    )!;
    await expect(
      factories["provider.vercel-stripe-price-lookup-environment"]!(
        workflowContext(lookupEnvironmentNode),
      ),
    ).resolves.toMatchObject({
      request: {
        inputs: {
          environmentVariableName: "STRIPE_PRICE_LOOKUP_KEY",
          environmentPublicValue: "vh_synthetic_web_saas_eur_1995_month",
        },
      },
    });

    snapshot.offer.pricing.annual_price = 199;
    await expect(
      factories["provider.stripe-commerce"]!(workflowContext(stripeNode)),
    ).resolves.toMatchObject({ request: { inputs: { unitAmount: 1995 } } });
    const conflictingFactories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    await expect(
      conflictingFactories["provider.stripe-commerce"]!(workflowContext(stripeNode)),
    ).rejects.toThrow("without omitting one");

    snapshot.offer.pricing.monthly_price = null;
    snapshot.offer.pricing.annual_price = null;
    snapshot.offer.pricing.one_time_price = 149;
    const oneTimeFactories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
    });
    const oneTimeTarget = await oneTimeFactories["provider.stripe-commerce"]!(
      workflowContext(stripeNode),
    );
    expect(oneTimeTarget.request.inputs).toMatchObject({ unitAmount: 14900 });
    expect(oneTimeTarget.request.inputs).not.toHaveProperty("recurringInterval");
    const oneTimePlan = providerRegistry
      .get("stripe")
      .plan({ ...oneTimeTarget.request, dryRun: false });
    expect(oneTimePlan.operations[1].http?.body).not.toHaveProperty("recurring");
    expect(oneTimePlan.operations[1].existingResource?.stateAssertions).toEqual(
      expect.arrayContaining([
        { path: "type", operator: "equals", expected: "one_time" },
        { path: "recurring", operator: "equals", expected: null },
      ]),
    );
    expect(oneTimePlan.operations[1].readBack?.assertions).toEqual(
      expect.arrayContaining([
        { path: "type", operator: "equals", expected: "one_time" },
        { path: "recurring", operator: "equals", expected: null },
      ]),
    );
  });

  it("binds domainless Stripe callbacks only to same-run production deployment read-back", async () => {
    const founderBrief = founderBriefSchema.parse({
      ...brief("fixtures/web-saas/brief.yaml"),
      domain: null,
    });
    const definition = compileLaunchGraph(founderBrief);
    const snapshot = loadDefaultProviderConfig(process.cwd());
    Object.assign(snapshot.providers.providers.stripe!, {
      credential_ref: "cred://stripe/domainless-test",
      account_id: "acct_domainless_test",
      external_resource_ids: {
        mode: "test",
        webhook_secret_credential_ref: "cred://stripe/domainless-webhook",
      },
    });
    Object.assign(snapshot.providers.providers.vercel!, {
      state: "verified",
      last_verified_at: "2026-08-04T12:00:00.000Z",
      evidence_artifact_ref: "reports/launch/domainless/vercel.json",
      credential_ref: "cred://vercel/domainless",
      team_id: "team_domainless",
      external_resource_ids: { project: "domainless-app" },
    });
    snapshot.offer.pricing.monthly_price = 12;
    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      configSnapshot: snapshot,
    });
    const node = (id: string) => definition.nodes.find((candidate) => candidate.id === id)!;
    const initial = await factories["provider.initial-production-deploy"]!(
      workflowContext(node("initial-production-deploy")),
    );
    expect(initial.request).toMatchObject({
      environment: "production",
      capabilities: ["deployment"],
      inputs: { deploymentPhase: "initial_production_origin" },
    });
    const callbacks = factories["provider.stripe-callbacks"]!;
    await expect(callbacks(workflowContext(node("stripe-callbacks")))).rejects.toThrow(
      "initial-production-deploy",
    );
    await expect(
      callbacks(
        workflowContext(node("stripe-callbacks"), {
          "vercel-project": {
            provider: "vercel",
            state: "verified",
            environments: ["preview"],
            capabilities: ["deployment"],
            resourceRefs: ["url=https://domainless-preview.vercel.app"],
          },
        }),
      ),
    ).rejects.toThrow("initial-production-deploy");

    const productionOutput = {
      provider: "vercel",
      state: "verified",
      environments: ["production"],
      capabilities: ["deployment"],
      resourceRefs: ["url=https://domainless-production.vercel.app"],
    } as JsonValue;
    await expect(
      callbacks(
        workflowContext(node("stripe-callbacks"), {
          "initial-production-deploy": productionOutput,
        }),
      ),
    ).resolves.toMatchObject({
      request: {
        inputs: {
          webhookUrl: "https://domainless-production.vercel.app/api/stripe/webhook",
          portalReturnUrl: "https://domainless-production.vercel.app/account",
        },
      },
    });
  });

  it("registers every launch provider handler and rejects unsafe partial compositions", async () => {
    const webBrief = brief("fixtures/web-saas/brief.yaml");
    const mobileBrief = brief("fixtures/ios-subscription/brief.yaml");
    const webDefinition = compileLaunchGraph(webBrief);
    const mobileDefinition = compileLaunchGraph(mobileBrief);
    const allHandlers = new Set(
      [...webDefinition.nodes, ...mobileDefinition.nodes]
        .filter((node) => node.kind === "provider" && node.handler)
        .map((node) => node.handler!),
    );
    for (const handler of allHandlers) expect(DEFAULT_PROVIDER_TARGETS[handler]).toBeDefined();

    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: webBrief,
      definition: webDefinition,
    });
    const stripeNode = webDefinition.nodes.find(({ id }) => id === "stripe-commerce")!;
    await expect(
      factories["provider.stripe-commerce"]!(workflowContext(stripeNode)),
    ).rejects.toThrow("no partial plan was returned");
  });

  it("reuses only same-scope verified lifecycle resources and fails closed on corrupt state", async () => {
    const founderBrief = brief("fixtures/web-saas/brief.yaml");
    const definition = compileLaunchGraph(founderBrief);
    const snapshot = loadDefaultProviderConfig(process.cwd());
    Object.assign(snapshot.providers.providers.github!, {
      state: "unconfigured",
      team_id: "founder-org",
      credential_ref: "cred://github/founder",
      last_verified_at: null,
      evidence_artifact_ref: null,
      external_resource_ids: {},
    });
    const records: VerifiedProviderLifecycleRecord[] = [
      {
        provider: "github",
        environment: "preview",
        capability: "repository_settings",
        state: "verified",
        planId: "plan.github.preview1",
        verifiedAt: "2026-08-04T10:00:00.000Z",
        resourceRefs: [{ type: "repository", value: "founder-org/from-readback" }],
      },
      {
        provider: "github",
        environment: "production",
        capability: "repository_settings",
        state: "verified",
        planId: "plan.github.production1",
        verifiedAt: "2026-08-04T10:00:00.000Z",
        resourceRefs: [{ type: "repository", value: "founder-org/wrong-environment" }],
      },
    ];
    const node = definition.nodes.find(({ id }) => id === "github-repository")!;
    const factories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
      lifecycleStore: lifecycleStore(records),
    });

    await expect(
      factories["provider.github-repository"]!(workflowContext(node)),
    ).resolves.toMatchObject({
      provider: "github",
      request: {
        environment: "preview",
        capabilities: ["repository"],
        inputs: { repository: "founder-org/from-readback" },
      },
    });
    expect(snapshot.providers.providers.github!.external_resource_ids).toEqual({});

    snapshot.providers.providers.github!.external_resource_ids = {
      repository: "founder-org/configured-different",
      repository_intent: "use_verified",
    };
    await expect(
      factories["provider.github-repository"]!(workflowContext(node)),
    ).resolves.toMatchObject({ request: { inputs: { repository: "founder-org/from-readback" } } });
    const mismatchedFactories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
      lifecycleStore: lifecycleStore(records),
    });
    await expect(
      mismatchedFactories["provider.github-repository"]!(workflowContext(node)),
    ).rejects.toThrow("no matching verified lifecycle record proves the existing repository");
    snapshot.providers.providers.github!.external_resource_ids = {};

    const corruptFactories = createDefaultProviderPlanFactories({
      rootDir: process.cwd(),
      brief: founderBrief,
      definition,
      loadConfig: () => snapshot,
      lifecycleStore: lifecycleStore([], new Error("secret provider body")),
    });
    const corrupt = corruptFactories["provider.github-repository"]!(workflowContext(node));
    await expect(corrupt).rejects.toThrow("lifecycle state is corrupt or unreadable");
    await expect(corrupt).rejects.not.toThrow("secret provider body");
  });

  it("reports CLI, reference, scope, expiry, manual-only, dry-run, and apply readiness offline", async () => {
    const runner: CommandRunner = {
      async run(invocation: CommandInvocation) {
        if (["gh", "neonctl", "psql"].includes(invocation.command)) {
          return { exitCode: 0, stdout: `${invocation.command} 1.0\n`, stderr: "" };
        }
        throw Object.assign(new Error(`spawn ${invocation.command} ENOENT`), { code: "ENOENT" });
      },
    };
    const broker = new CredentialBroker([
      new MemoryCredentialBackend(),
      new CliSessionCredentialBackend(runner),
    ]);
    broker.register({
      ref: "cred://github/founder",
      provider: "github",
      kind: "cli_session",
      backend: "cli_session",
      scopes: ["repo"],
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await broker.store({
      ref: "cred://vercel/expired",
      provider: "vercel",
      kind: "api_key",
      backend: "memory",
      scopes: [],
      expiresAt: "2000-01-01T00:00:00.000Z",
      value: "expired-fixture-value",
    });
    await broker.store({
      ref: "cred://neon/tested-api-key",
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      scopes: [],
      expiresAt: "2030-01-01T00:00:00.000Z",
      value: "tested-neon-fixture-value",
    });
    await broker.test("cred://neon/tested-api-key", async () => ({
      ok: true,
      accountId: "neon-account",
      scopes: ["*"],
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const http = new MockProviderTransport("http", async () => ({
      status: "succeeded",
      message: "offline doctor fixture",
      verified: true,
    }));
    const runtime = createOfficialProviderContext({
      commandRunner: runner,
      credentials: broker,
      redactor: broker.redactor,
      additional: [http],
    });
    const founderBrief = brief("fixtures/web-saas/brief.yaml");
    const result = await inspectDefaultProviderDoctor({
      rootDir: process.cwd(),
      broker,
      context: { ...runtime, authorization: "dry_run" },
      runner,
      registry: providerRegistry,
      launch: { brief: founderBrief, definition: compileLaunchGraph(founderBrief) },
    });

    expect(result.cliPrerequisites.find(({ id }) => id === "github")).toMatchObject({
      status: "installed",
      version: "gh 1.0",
    });
    expect(result.cliPrerequisites.find(({ id }) => id === "vercel")).toMatchObject({
      status: "missing",
    });
    expect(result.authenticatedCredentialRefs).toContainEqual({
      ref: "cred://github/founder",
      provider: "github",
      kind: "cli_session",
    });
    expect(result.authenticatedCredentialRefs).toContainEqual({
      ref: "cred://neon/tested-api-key",
      provider: "neon",
      kind: "api_key",
    });
    const github = result.providerChecks.find(({ provider }) => provider === "github")!;
    expect(github.registeredCredentialRefs).toContain("cred://github/founder");
    expect(github.missingScopes).toContain("workflow");
    expect(github.dryRunAvailability).toMatchObject({ available: false, status: "blocked" });
    expect(github.applyAvailability).toMatchObject({ available: false, status: "blocked" });
    const vercel = result.providerChecks.find(({ provider }) => provider === "vercel")!;
    expect(vercel.expiredCredentialRefs).toContainEqual({
      ref: "cred://vercel/expired",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(vercel.cliPrerequisites).toContainEqual(
      expect.objectContaining({ id: "vercel", status: "missing" }),
    );
    expect(result.manualOnlyProviders).toEqual(expect.arrayContaining(["dns", "mijndomein"]));
  });
});
