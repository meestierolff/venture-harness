import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentGateway } from "../packages/agent-gateway/src/index";
import { SqliteAuditChain } from "../packages/audit/src/index";
import {
  createProviderLifecycleCommandRuntime,
  createVentureRuntime,
  providerOperationCommandContracts,
  type ProviderOperationInput,
  type WinnerProviderCommandFeature,
} from "../packages/agent-runtime/src/index";
import type { CommandExecutionContext, JsonObject } from "../packages/core/src/index";
import { SqliteEventLog } from "../packages/events/src/index";
import { SqliteMeteringSink } from "../packages/telemetry/src/index";
import { SqliteIdempotencyStore } from "../packages/command-bus/src/index";
import {
  SqliteWinnerLiveProviderOperationStore,
  WinnerLiveTransportError,
  createMemoryWinnerLiveProviderOperationStore,
  createWinnerLiveProviderAdapters,
  type WinnerLiveProviderAuthorization,
  type WinnerLiveProviderContext,
  type WinnerLiveProviderEffect,
  type WinnerLiveProviderId,
  type WinnerLiveProviderOperationStore,
  type WinnerLiveProviderTransport,
} from "@/lib/winner-integrations";

const NOW = "2026-08-09T12:00:00.000Z";
const now = () => new Date(NOW);
const temporaryDirectories: string[] = [];
const sqliteResources: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of sqliteResources.splice(0)) {
    try {
      store.close();
    } catch {
      // A restart test may have closed an earlier connection deliberately.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-provider-commands-"));
  temporaryDirectories.push(directory);
  return directory;
}

function trackSqlite<T extends { close(): void }>(resource: T): T {
  sqliteResources.push(resource);
  return resource;
}

function durableCommandStores(directory: string) {
  return {
    commandIdempotencyStore: trackSqlite(
      new SqliteIdempotencyStore(join(directory, "command-idempotency.sqlite")),
    ),
    audit: trackSqlite(new SqliteAuditChain(join(directory, "command-audit.sqlite"))),
    events: trackSqlite(new SqliteEventLog(join(directory, "command-events.sqlite"))),
    metering: trackSqlite(new SqliteMeteringSink(join(directory, "command-metering.sqlite"))),
  };
}

const commandContext: CommandExecutionContext = {
  identity: { actorId: "operator-1", kind: "user" },
  tenant: { organizationId: "org-acme", ventureId: "venture-alpha" },
  subscription: { subscriptionId: "local-provider", status: "active", plan: "operator" },
  entitlements: [],
  scopes: ["provider.read", "provider.apply"],
  grants: [
    {
      grantId: "provider-command-grant",
      commandIds: [
        "provider.doctor",
        "provider.apply",
        "provider.status",
        "provider.read-back",
        "provider.reconcile",
      ],
      scopes: ["provider.read", "provider.apply"],
      expiresAt: "2026-08-09T13:00:00.000Z",
    },
  ],
};

const effectByFeature: Readonly<Record<WinnerProviderCommandFeature, WinnerLiveProviderEffect>> = {
  "creative.video.generate": "reversible_external_write",
  "distribution.content.draft": "reversible_external_write",
  "distribution.content.publish": "public_communication",
  "ads.organic_post.boost": "financial",
  "ads.campaign.pause": "reversible_external_write",
  "attribution.campaign.read": "external_read",
  "subscription.lifecycle.read": "external_read",
};

const payloads: Readonly<Record<WinnerProviderCommandFeature, JsonObject>> = {
  "creative.video.generate": {
    operation: "generate_video",
    creative_id: "creative-1",
    provider_model: "official-model-1",
    prompt_ref: "artifact://winner/prompts/creative-1",
    asset_manifest_ref: "artifact://winner/assets/creative-1",
    rights_manifest_ref: "artifact://winner/rights/creative-1",
    output_destination_ref: "asset://venture-alpha/generated/creative-1.mp4",
    aspect_ratio: "9:16",
    max_cost_minor: 100,
    currency: "EUR",
  },
  "distribution.content.draft": {
    operation: "upload_draft",
    creative_id: "creative-1",
    creator_info_ref: "artifact://tiktok/creator-info",
    user_consent_ref: "artifact://tiktok/consent",
    policy_snapshot_ref: "artifact://tiktok/policy",
    media: {
      method: "brokered_file_upload",
      media_ref: "asset://venture-alpha/creative-1.mp4",
      size_bytes: 2_000_000,
      mime_type: "video/mp4",
    },
  },
  "distribution.content.publish": {
    operation: "publish_direct",
    creative_id: "creative-1",
    creator_info_ref: "artifact://tiktok/creator-info",
    user_consent_ref: "artifact://tiktok/consent",
    policy_snapshot_ref: "artifact://tiktok/policy",
    media: {
      method: "brokered_file_upload",
      media_ref: "asset://venture-alpha/creative-1.mp4",
      size_bytes: 2_000_000,
      mime_type: "video/mp4",
    },
    title: "Truthful walkthrough",
    privacy_level: "PUBLIC_TO_EVERYONE",
    disable_duet: false,
    disable_stitch: false,
    disable_comment: false,
    brand_content_toggle: false,
    brand_organic_toggle: true,
    is_aigc: true,
  },
  "ads.organic_post.boost": {
    operation: "create_spark_paid_test",
    proposal_id: "proposal-1",
    creative_id: "creative-1",
    source_post_id: "post-1",
    spark_authorization_ref: "artifact://tiktok/spark-authorization",
    advertiser_id: "advertiser-1",
    campaign_key: "campaign-1",
    objective: "APP_PROMOTION",
    optimization_event: "SUBSCRIBE",
    geographies: ["NL"],
    total_budget_minor: 5_000,
    daily_cap_minor: 1_000,
    reserved_minor: 5_000,
    currency: "EUR",
    start_at: "2026-08-10T00:00:00.000Z",
    end_at: "2026-08-17T00:00:00.000Z",
    auto_scale: false,
    scale_mode: "manual_recommendation_only",
  },
  "ads.campaign.pause": {
    operation: "pause_campaign",
    campaign_id: "campaign-1",
    advertiser_id: "advertiser-1",
    pause_reason: "manual_kill_switch",
    incident_ref: "artifact://incidents/pause-1",
    observed_spend_minor: 0,
    currency: "EUR",
    requested_at: NOW,
  },
  "attribution.campaign.read": {
    operation: "read_aggregates",
    provider_kind: "official-mmp",
    dataset_ref: "provider://mmp/report-1",
    creative_ids: ["creative-1"],
    window_start: "2026-08-01T00:00:00.000Z",
    window_end: "2026-08-08T00:00:00.000Z",
    allowed_attribution_classes: ["PROVIDER_ATTRIBUTED", "PRIVACY_AGGREGATED"],
    aggregate_only: true,
    include_person_level_rows: false,
  },
  "subscription.lifecycle.read": {
    operation: "read_lifecycle_aggregates",
    project_id: "project-1",
    environment: "production",
    window_start: "2026-08-01T00:00:00.000Z",
    window_end: "2026-08-08T00:00:00.000Z",
    currency: "EUR",
    cohort_periods: ["D0", "D7", "D30", "D90"],
    lifecycle_event_types: ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION"],
    aggregate_only: true,
    include_subscriber_payload: false,
  },
};

const providerByFeature = {
  "creative.video.generate": "creative_generation",
  "distribution.content.draft": "tiktok_content_posting",
  "distribution.content.publish": "tiktok_content_posting",
  "ads.organic_post.boost": "tiktok_spark_ads",
  "ads.campaign.pause": "tiktok_spark_ads",
  "attribution.campaign.read": "aggregated_attribution",
  "subscription.lifecycle.read": "revenuecat",
} as const;

function operationInput(
  feature: WinnerProviderCommandFeature = "creative.video.generate",
): ProviderOperationInput {
  return {
    organizationId: "org-acme",
    providerId: providerByFeature[feature],
    providerAccountId: feature === "creative.video.generate" ? "creative-account-1" : "account-1",
    feature,
    operationId: `operation-${feature.replaceAll(".", "-")}`,
    providerIdempotencyKey: `provider-${feature.replaceAll(".", "-")}`,
    payload: payloads[feature],
  };
}

function durableStore(): WinnerLiveProviderOperationStore {
  return trackSqlite(
    new SqliteWinnerLiveProviderOperationStore(join(temporaryRoot(), "provider-operations.sqlite")),
  );
}

function authorization(
  providerId: WinnerLiveProviderId,
  providerAccountId: string,
  feature: WinnerProviderCommandFeature,
  effect: WinnerLiveProviderEffect,
): WinnerLiveProviderAuthorization {
  return {
    sourceGrantKind: "customer_service_grant",
    sourceGrantId: `service-grant-${feature}`,
    organizationId: "org-acme",
    ventureId: "venture-alpha",
    providerId,
    externalAccountIds: [providerAccountId],
    allowedFeatures: [feature],
    allowedEffects: [effect],
    maxExternalCostMinor: 100,
    currency: "EUR",
    approvedBy: "founder-1",
    approvalRef: `artifact://approvals/${feature}`,
    issuedAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-09T13:00:00.000Z",
  };
}

function contextFor(request: {
  organizationId: string;
  providerId: WinnerLiveProviderAuthorization["providerId"];
  providerAccountId: string;
  feature: WinnerProviderCommandFeature;
}): WinnerLiveProviderContext {
  return {
    organizationId: request.organizationId,
    credentialRef: `cred://winner/${request.providerId}`,
    authorization: authorization(
      request.providerId,
      request.providerAccountId,
      request.feature,
      effectByFeature[request.feature],
    ),
    reconciliationAuthorization: authorization(
      request.providerId,
      request.providerAccountId,
      request.feature,
      "external_read",
    ),
    executionMode: "authorized_transport",
    environment: "production",
    now,
  };
}

function creativeTransport(options: { rejectWithSecret?: boolean } = {}) {
  const transport: WinnerLiveProviderTransport & {
    doctor: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
    readBack: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
  } = {
    adapterId: "creative_generation",
    kind: "official_api",
    doctor: vi.fn(async (request) => ({
      state: "ready" as const,
      observedAccountId: request.providerAccountId,
      availableFeatures: request.requestedFeatures,
      grantedScopes: request.requiredScopes,
      providerInvoked: true,
      liveVerified: true,
    })),
    apply: vi.fn(async ({ plan }) => {
      if (options.rejectWithSecret) {
        throw new WinnerLiveTransportError(
          "provider_401",
          "confirmed_no_effect",
          false,
          "Bearer super-secret-provider-token",
        );
      }
      return {
        state: "accepted" as const,
        providerOperationId: `job-${plan.requestHash.slice(0, 12)}`,
        providerInvoked: true,
        externalEffectOccurred: true,
        output: { creative_id: plan.payload.creative_id, status: "PROCESSING" },
      };
    }),
    readBack: vi.fn(async ({ plan }) => ({
      state: "matched" as const,
      providerOperationId: `job-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: true,
      liveVerified: true,
      evidence: {
        creative_id: plan.payload.creative_id,
        asset_ref: "asset://venture-alpha/generated/creative-1.mp4",
        status: "COMPLETED",
      },
    })),
    reconcile: vi.fn(async ({ plan }) => ({
      state: "matched" as const,
      providerOperationId: `job-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: true,
      liveVerified: true,
      evidence: {
        creative_id: plan.payload.creative_id,
        asset_ref: "asset://venture-alpha/generated/creative-1.mp4",
        status: "COMPLETED",
      },
    })),
  };
  return transport;
}

function runtime(
  options: {
    transports?: Partial<Record<WinnerLiveProviderId, WinnerLiveProviderTransport>>;
    store?: WinnerLiveProviderOperationStore;
    resolveContext?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const adapters = createWinnerLiveProviderAdapters({
    transports: options.transports,
    store: options.store,
  });
  const resolveContext =
    options.resolveContext ??
    vi.fn((request) => contextFor(request as Parameters<typeof contextFor>[0]));
  const providerCommandRuntime = createProviderLifecycleCommandRuntime({
    adapters,
    resolveContext,
  });
  const ventureRuntime = createVentureRuntime({
    memberships: [
      { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
    ],
    providerCommandRuntime,
    commandExecutionMode: "fixture",
    now,
  });
  return { ventureRuntime, adapters, resolveContext, providerCommandRuntime };
}

describe("Winner live-provider command surfaces", () => {
  it("derives doctor, plan, dry-run, apply, status, read-back, and reconcile on every surface", async () => {
    const { ventureRuntime } = runtime();
    const gateway = createAgentGateway(ventureRuntime);
    expect(providerOperationCommandContracts.map(({ id }) => id)).toEqual([
      "provider.doctor",
      "provider.plan",
      "provider.dry-run",
      "provider.apply",
      "provider.status",
      "provider.read-back",
      "provider.reconcile",
    ]);
    expect(
      Object.fromEntries(providerOperationCommandContracts.map(({ id, effect }) => [id, effect])),
    ).toEqual({
      "provider.doctor": "read",
      "provider.plan": "read",
      "provider.dry-run": "read",
      "provider.apply": "write",
      "provider.status": "write",
      "provider.read-back": "write",
      "provider.reconcile": "write",
    });
    for (const contract of providerOperationCommandContracts) {
      expect(gateway.rest.openApi.paths).toHaveProperty(contract.surfaces.rest.path);
      expect(gateway.mcp.tools).toContainEqual(
        expect.objectContaining({ name: contract.surfaces.mcp.tool, commandId: contract.id }),
      );
      expect(gateway.sdk.commands.provider).toHaveProperty(contract.surfaces.sdk.method);
      expect(gateway.ui).toContainEqual(
        expect.objectContaining({ actionId: contract.id, commandId: contract.id }),
      );
    }

    const input = operationInput();
    const plan = providerOperationCommandContracts.find(({ id }) => id === "provider.plan")!;
    const invoke = (surface: string) => ({
      context: commandContext,
      idempotencyKey: `surface-${surface}`,
    });
    const direct = await gateway.direct.execute("provider.plan", input, invoke("direct"));
    const rest = await gateway.rest.handle({
      method: "POST",
      path: plan.surfaces.rest.path,
      body: input,
      ...invoke("rest"),
    });
    const cli = await gateway.cli.invoke(
      [...plan.surfaces.cli.tokens, "--input", JSON.stringify(input)],
      invoke("cli"),
    );
    const mcp = await gateway.mcp.callTool(plan.surfaces.mcp.tool, input, invoke("mcp"));
    const sdk = await gateway.sdk.commands.provider!.plan!(input, invoke("sdk"));
    const ui = await gateway.ui
      .find(({ actionId }) => actionId === "provider.plan")!
      .invoke(input, invoke("ui"));
    expect(rest).toEqual({ status: 200, body: direct });
    expect(JSON.parse(cli.stdout)).toEqual(direct);
    expect(cli.exitCode).toBe(0);
    expect(mcp).toEqual(direct);
    expect(sdk).toEqual(direct);
    expect(ui).toEqual(direct);
  });

  it("keeps the packaged default unconfigured and never selects a fixture or network apply", async () => {
    const packaged = createVentureRuntime({
      memberships: [
        { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
      ],
      commandExecutionMode: "fixture",
      now,
    });
    await expect(
      packaged.execute("provider.apply", operationInput(), {
        context: commandContext,
        idempotencyKey: "default-apply",
      }),
    ).rejects.toMatchObject({
      code: "handler_failed",
      message: expect.stringContaining("transport_missing"),
    });
  });

  it("refuses an explicitly injected contract fixture at the command apply boundary", async () => {
    const officialShape = creativeTransport();
    const fixtureTransport: WinnerLiveProviderTransport = {
      ...officialShape,
      kind: "contract_fixture",
    };
    const resolveContext = vi.fn(() => {
      throw new Error("fixture apply must be rejected before context resolution");
    });
    const { ventureRuntime } = runtime({
      transports: { creative_generation: fixtureTransport },
      store: durableStore(),
      resolveContext,
    });
    await expect(
      ventureRuntime.execute("provider.apply", operationInput(), {
        context: commandContext,
        idempotencyKey: "fixture-command-apply",
      }),
    ).rejects.toMatchObject({
      code: "handler_failed",
      message: expect.stringContaining("official_transport_required"),
    });
    expect(resolveContext).not.toHaveBeenCalled();
    expect(officialShape.apply).not.toHaveBeenCalled();
  });

  it("validates every Winner capability through plan and dry-run without resolving auth or transport", async () => {
    const resolveContext = vi.fn(() => {
      throw new Error("context must not resolve during plan or dry-run");
    });
    const { ventureRuntime } = runtime({ resolveContext });
    for (const feature of Object.keys(providerByFeature) as WinnerProviderCommandFeature[]) {
      const input = operationInput(feature);
      const planned = await ventureRuntime.execute("provider.plan", input, {
        context: commandContext,
        idempotencyKey: `plan-${feature}`,
      });
      const dryRun = await ventureRuntime.execute("provider.dry-run", input, {
        context: commandContext,
        idempotencyKey: `dry-${feature}`,
      });
      expect(planned).toMatchObject({
        providerId: providerByFeature[feature],
        feature,
        status: "planned",
        providerInvoked: false,
        externalEffectOccurred: false,
      });
      expect(dryRun).toMatchObject({
        providerId: providerByFeature[feature],
        feature,
        status: "planned",
        providerInvoked: false,
        externalEffectOccurred: false,
      });
    }
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it("rejects provider/capability mismatch before context resolution or any provider call", async () => {
    const resolveContext = vi.fn(() =>
      contextFor({
        organizationId: "org-acme",
        providerId: "revenuecat",
        providerAccountId: "account-1",
        feature: "subscription.lifecycle.read",
      }),
    );
    const { ventureRuntime } = runtime({ resolveContext });
    await expect(
      ventureRuntime.execute(
        "provider.apply",
        { ...operationInput(), providerId: "revenuecat" },
        { context: commandContext, idempotencyKey: "mismatched-provider" },
      ),
    ).rejects.toMatchObject({
      code: "handler_failed",
      message: expect.stringContaining("provider_capability_mismatch"),
    });
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it("rejects a cross-organization command input before plan or context resolution", async () => {
    const resolveContext = vi.fn(() => {
      throw new Error("cross-organization input must not resolve trusted context");
    });
    const { ventureRuntime } = runtime({ resolveContext });
    await expect(
      ventureRuntime.execute(
        "provider.plan",
        { ...operationInput(), organizationId: "org-forged" },
        { context: commandContext, idempotencyKey: "cross-organization-plan" },
      ),
    ).rejects.toMatchObject({
      code: "handler_failed",
      message: expect.stringContaining("provider_tenant_mismatch"),
    });
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it("applies once across runtime restart, then status/read-back/reconcile without reapply", async () => {
    const store = durableStore();
    const transport = creativeTransport();
    const transports = { creative_generation: transport } as const;
    const first = runtime({ transports, store }).ventureRuntime;
    const input = operationInput();

    const doctor = await first.execute(
      "provider.doctor",
      {
        organizationId: input.organizationId,
        providerId: input.providerId,
        providerAccountId: input.providerAccountId,
        feature: input.feature,
      },
      { context: commandContext, idempotencyKey: "doctor-creative" },
    );
    expect(doctor).toMatchObject({ status: "ready", providerInvoked: true, liveVerified: true });

    const applied = await first.execute("provider.apply", input, {
      context: commandContext,
      idempotencyKey: "command-apply-first",
    });
    expect(applied).toMatchObject({
      status: "accepted_unverified",
      providerInvoked: true,
      externalEffectOccurred: true,
      liveVerified: false,
    });
    expect(transport.apply).toHaveBeenCalledOnce();

    const restarted = runtime({ transports, store }).ventureRuntime;
    const replay = await restarted.execute("provider.apply", input, {
      context: commandContext,
      idempotencyKey: "command-apply-after-restart",
    });
    expect(replay).toMatchObject({
      status: "accepted_unverified",
      providerInvoked: false,
      externalEffectOccurred: false,
      data: { result: { reused: true } },
    });
    expect(transport.apply).toHaveBeenCalledOnce();

    const status = await restarted.execute("provider.status", input, {
      context: commandContext,
      idempotencyKey: "command-status",
    });
    const readBack = await restarted.execute("provider.read-back", input, {
      context: commandContext,
      idempotencyKey: "command-read-back",
    });
    const reconciled = await restarted.execute("provider.reconcile", input, {
      context: commandContext,
      idempotencyKey: "command-reconcile",
    });
    expect(status).toMatchObject({ status: "verified", providerInvoked: true, liveVerified: true });
    expect(readBack).toMatchObject({
      status: "matched",
      providerInvoked: true,
      liveVerified: true,
    });
    expect(reconciled).toMatchObject({
      status: "matched",
      providerInvoked: true,
      externalEffectOccurred: false,
      liveVerified: true,
      data: { result: { reapplied: false } },
    });
    expect(transport.apply).toHaveBeenCalledOnce();
    expect(transport.readBack).toHaveBeenCalledTimes(2);
    expect(transport.reconcile).toHaveBeenCalledOnce();
  });

  it("executes the official path on a production CommandBus with durable command idempotency", async () => {
    const directory = temporaryRoot();
    const providerStore = durableStore();
    const transport = creativeTransport();
    const configured = runtime({
      transports: { creative_generation: transport },
      store: providerStore,
    });
    const firstStores = durableCommandStores(directory);
    const first = createVentureRuntime({
      memberships: [
        { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
      ],
      providerCommandRuntime: configured.providerCommandRuntime,
      commandExecutionMode: "production",
      ...firstStores,
      now,
    });
    const input = operationInput();
    const invocation = { context: commandContext, idempotencyKey: "production-command-apply" };
    const applied = await first.execute("provider.apply", input, invocation);
    expect(applied).toMatchObject({
      status: "accepted_unverified",
      providerInvoked: true,
      externalEffectOccurred: true,
    });
    expect(firstStores.commandIdempotencyStore.durability).toBe("durable_atomic");
    firstStores.commandIdempotencyStore.close();
    firstStores.audit.close();
    firstStores.events.close();
    firstStores.metering.close();

    const restartedStores = durableCommandStores(directory);
    const restarted = createVentureRuntime({
      memberships: [
        { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
      ],
      providerCommandRuntime: configured.providerCommandRuntime,
      commandExecutionMode: "production",
      ...restartedStores,
      now,
    });
    expect(await restarted.execute("provider.apply", input, invocation)).toEqual(applied);
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("fails a production provider write closed before transport when provider storage is ephemeral", async () => {
    const directory = temporaryRoot();
    const transport = creativeTransport();
    const configured = runtime({
      transports: { creative_generation: transport },
      store: createMemoryWinnerLiveProviderOperationStore(),
    });
    const production = createVentureRuntime({
      memberships: [
        { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
      ],
      providerCommandRuntime: configured.providerCommandRuntime,
      commandExecutionMode: "production",
      ...durableCommandStores(directory),
      now,
    });
    await expect(
      production.execute("provider.apply", operationInput(), {
        context: commandContext,
        idempotencyKey: "unsafe-production-provider-store",
      }),
    ).rejects.toMatchObject({
      code: "handler_failed",
      message: expect.stringContaining("operation_store_unsafe"),
    });
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("redacts provider credential material from command results and audit-facing surfaces", async () => {
    const transport = creativeTransport({ rejectWithSecret: true });
    const { ventureRuntime } = runtime({
      transports: { creative_generation: transport },
      store: durableStore(),
    });
    const error = await ventureRuntime
      .execute("provider.apply", operationInput(), {
        context: commandContext,
        idempotencyKey: "redacted-apply",
      })
      .then(
        () => {
          throw new Error("expected provider rejection");
        },
        (failure: unknown) => failure,
      );
    const serialized = JSON.stringify(error);
    expect(error).toMatchObject({
      code: "handler_failed",
      message: "provider_rejected: [REDACTED]",
    });
    expect(serialized).not.toContain("super-secret-provider-token");
    expect(serialized).not.toContain("cred://winner/creative_generation");
  });

  it("rejects credential-like command payloads before context or provider execution", async () => {
    const resolveContext = vi.fn(() =>
      contextFor({
        organizationId: "org-acme",
        providerId: "creative_generation",
        providerAccountId: "creative-account-1",
        feature: "creative.video.generate",
      }),
    );
    const { ventureRuntime } = runtime({ resolveContext });
    await expect(
      ventureRuntime.execute(
        "provider.apply",
        {
          ...operationInput(),
          payload: {
            ...payloads["creative.video.generate"],
            prompt_ref: "https://assets.example/prompt?signature=secret-value",
          },
        },
        { context: commandContext, idempotencyKey: "unsafe-payload" },
      ),
    ).rejects.toThrow(/credential-bearing URL is forbidden/i);
    expect(resolveContext).not.toHaveBeenCalled();
  });
});
