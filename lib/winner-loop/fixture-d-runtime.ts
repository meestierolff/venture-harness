import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  InMemoryAuditChain,
  type AuditInput,
  type AuditRecord,
  type AuditSink,
} from "../../packages/audit/src/index";
import { CommandBus, defineCommandContract } from "../../packages/command-bus/src/index";
import type {
  CommandExecutionContext,
  JsonObject,
  JsonValue,
  TenantRef,
} from "../../packages/core/src/index";
import { InMemoryEventLog } from "../../packages/events/src/index";
import type { RuntimeSchema } from "../../packages/config/src/index";
import type { CapabilityRequest } from "@venture-harness/provider-sdk";
import {
  createFixtureDistributionPrProposal,
  createWinnerLoopEventRuntime,
  type FixtureJsonObject,
  type WinnerLoopEvent,
  type WinnerLoopEventRuntime,
  type WinnerProviderAdapterId,
  type WinnerProviderFeature,
} from "../winner-integrations";
import {
  FileFixtureAssetVault,
  FileFixtureCommandIdempotencyStore,
  WINNER_FIXTURE_CAPABILITY_BY_FEATURE,
  createWinnerFixtureCapabilityRuntime,
  fixtureCapabilityCredential,
} from "../winner-integrations/capability-bridge";
import {
  NodeMaterializationFileSystem,
  PACKS,
  compileVentureMaterialization,
  createLaunchGrant,
  emptyPackInstallationState,
  installPack,
  materializeVenture,
} from "../materialization";
import { FileWorkflowStore, WorkflowExecutor, defineWorkflow, workflowNode } from "../workflow";
import type { GrowthContract } from "../config/growth-contract-schema";
import {
  buildCreativeTrace,
  runFixtureD,
  type FixtureDBootstrapEvidence,
  type FixtureDProviderBoundary,
  type FixtureDProviderFeature,
  type FixtureDProviderOperation,
  type FixtureDProviderOperationResult,
  type FixtureDResult,
} from "./fixture-d";
import { createSqliteCreativeLedgerStore } from "./creative-ledger-store";
import { createSqliteCreativeManifestStore } from "./creative-manifest";
import { createSqliteWinnerLoopEvidenceStore } from "./evidence-store";
import { createSqlitePaidTestStore } from "./paid-test-store";
import { createSqliteSpendStore } from "./spend-store";
import { createSqliteSubscriptionEventStore } from "./subscription-store";

const FIXED_NOW = new Date("2026-08-09T12:00:00.000Z");
const RUN_COMMAND_ID = "winner.run-fixture-d";
const STEP_COMMAND_ID = "winner.record-fixture-step";

function jsonObjectSchema(label: string): RuntimeSchema<JsonObject> {
  return {
    name: label,
    jsonSchema: { type: "object" },
    parse(value: unknown): JsonObject {
      if (!value || Array.isArray(value) || typeof value !== "object") {
        throw new Error(`${label} must be a JSON object`);
      }
      return JSON.parse(JSON.stringify(value)) as JsonObject;
    },
  };
}

const runContract = defineCommandContract({
  id: RUN_COMMAND_ID,
  version: 1,
  title: "Run Fixture D",
  description: "Run the deterministic Winner Loop fixture through local production boundaries.",
  input: jsonObjectSchema("Fixture D input"),
  output: jsonObjectSchema("Fixture D trace"),
  requirements: {
    activeSubscription: true,
    entitlements: ["winner_loop"],
    grant: true,
    scopes: ["winner:fixture:run"],
  },
  meter: "winner_fixture_runs",
});

const stepContract = defineCommandContract({
  id: STEP_COMMAND_ID,
  version: 1,
  title: "Record Fixture D Step",
  description: "Record one sanitized, deterministic Fixture D milestone.",
  input: jsonObjectSchema("Fixture D step"),
  output: jsonObjectSchema("Fixture D step acknowledgement"),
  requirements: {
    activeSubscription: true,
    entitlements: ["winner_loop"],
    grant: true,
    scopes: ["winner:fixture:run"],
  },
});

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

class DurableFixtureAudit implements AuditSink {
  readonly #chain = new InMemoryAuditChain();

  constructor(
    readonly path: string,
    private readonly tenant: TenantRef,
  ) {}

  append(input: AuditInput): AuditRecord {
    const record = this.#chain.append(input);
    atomicJson(this.path, this.#chain.read(this.tenant));
    return record;
  }

  read(): AuditRecord[] {
    return this.#chain.read(this.tenant);
  }

  verify(): boolean {
    return this.#chain.verify(this.tenant);
  }
}

interface ProviderLifecycleEvidence {
  adapterId: WinnerProviderAdapterId;
  feature: WinnerProviderFeature;
  capability: string;
  operationId: string;
  doctor: string;
  dryRun: string;
  apply: string;
  readBack: string;
  verify: string;
  reconcile: string;
  providerInvoked: false;
  externalEffectOccurred: false;
  spendAllowed: false;
  packageSdk: "@venture-harness/provider-sdk";
  registryResolved: true;
  stackProfileId: "winner-loop-fixture-v1";
  durableReplay: boolean;
}

const FIXTURE_ADAPTER_BY_FEATURE: Readonly<
  Record<FixtureDProviderFeature, WinnerProviderAdapterId>
> = Object.freeze({
  creative_render: "fixture_local_renderer",
  organic_create_draft: "fixture_organic_content",
  organic_publish_direct: "fixture_organic_content",
  paid_promote_existing_post_contract: "fixture_tiktok_spark",
  attribution_read_aggregates: "fixture_aggregated_attribution",
  subscription_read_lifecycle: "fixture_revenuecat",
});

function fixtureProviderContext() {
  return {
    fixtureExecution: true,
    reviewApprovals: ["organic.direct_publish", "paid.spark_contract"] as const,
    now: () => FIXED_NOW,
  };
}

function event(
  name: WinnerLoopEvent["name"],
  sequence: number,
  ventureId: string,
  properties: Record<string, string | number | boolean>,
): WinnerLoopEvent {
  return {
    name,
    schemaVersion: 1,
    eventId: `fixture-event-${String(sequence).padStart(2, "0")}`,
    ventureId,
    occurredAt: FIXED_NOW.toISOString(),
    providerProvenance: {
      adapterKind: "fixture_boundary",
      evidenceRef: `fixture://winner-loop/event-${sequence}`,
      fixture: true,
    },
    properties,
  } as WinnerLoopEvent;
}

function emitObservedEvents(runtime: WinnerLoopEventRuntime, result: FixtureDResult): void {
  const renderJobId =
    result.providerObjects.find(({ objectKind }) => objectKind === "render_job")?.externalId ??
    "missing-render-job";
  const publicationId =
    result.providerObjects.find(({ objectKind }) => objectKind === "organic_post")?.externalId ??
    "missing-publication";
  const common = {
    creativeId: result.creativeId,
    proposalId: result.proposalId,
    grantId: result.grantId,
  };
  const observed: Array<[WinnerLoopEvent["name"], Record<string, string | number | boolean>]> = [
    [
      "creative_hypothesis_created",
      {
        hypothesis_id: "hyp-fixture-001",
        creative_family_id: "fam-fixture-001",
        hypothesis_version: "fixture-v1",
      },
    ],
    [
      "creative_render_requested",
      {
        creative_id: common.creativeId,
        render_job_id: renderJobId,
        renderer_kind: "fixture_local_renderer",
      },
    ],
    [
      "creative_render_completed",
      {
        creative_id: common.creativeId,
        render_job_id: renderJobId,
        asset_manifest_id: "fixture-asset-manifest",
        render_status: "completed",
      },
    ],
    [
      "creative_rights_reviewed",
      {
        creative_id: common.creativeId,
        manifest_id: "fixture-manifest-1",
        rights_status: "approved_paid",
        reviewer_role: "fixture_reviewer",
      },
    ],
    [
      "creative_approved_for_organic",
      {
        creative_id: common.creativeId,
        manifest_id: "fixture-manifest-1",
        review_mode: "human",
      },
    ],
    [
      "organic_post_published",
      {
        creative_id: common.creativeId,
        publication_id: publicationId,
        provider_kind: "fixture_organic_content",
        publication_mode: "direct",
      },
    ],
    [
      "organic_metric_snapshot",
      {
        creative_id: common.creativeId,
        snapshot_id: "fixture-snapshot-set",
        offset_minutes: 360,
        metric_count: 9,
        data_quality: "partial",
      },
    ],
    [
      "winner_evaluation_completed",
      {
        creative_id: common.creativeId,
        recommendation_id: result.evaluation.recommendationId,
        scoring_version: result.evaluation.scoringVersion,
        recommendation: result.evaluation.recommendation,
        confidence: result.evaluation.confidence,
      },
    ],
    [
      "boost_candidate_recommended",
      {
        creative_id: common.creativeId,
        recommendation_id: result.evaluation.recommendationId,
        baseline_definition_id: "fixture-baseline-v1",
      },
    ],
    [
      "paid_test_proposed",
      {
        creative_id: common.creativeId,
        proposal_id: common.proposalId,
        network_kind: "tiktok_paid",
        hard_cap_minor: 10_000,
        currency: "EUR",
      },
    ],
    [
      "spend_grant_approved",
      {
        grant_id: common.grantId,
        proposal_id: common.proposalId,
        approved_cap_minor: 10_000,
        currency: "EUR",
        approval_mode: "human",
      },
    ],
    [
      "spend_reserved",
      {
        grant_id: common.grantId,
        reservation_id: "fixture-reservation-1",
        reserved_minor: 5_000,
        currency: "EUR",
      },
    ],
    [
      "paid_test_started",
      {
        creative_id: common.creativeId,
        paid_test_id: common.proposalId,
        grant_id: common.grantId,
        network_kind: "tiktok_paid",
      },
    ],
    [
      "paid_test_completed",
      {
        creative_id: common.creativeId,
        paid_test_id: common.proposalId,
        outcome: "completed",
      },
    ],
    [
      "attribution_evidence_recorded",
      {
        creative_id: common.creativeId,
        attribution_id: "fixture-attribution-1",
        attribution_class: result.cohorts[0]?.attributionClass ?? "UNKNOWN",
        attribution_provider_kind: "fixture_aggregated_attribution",
        window_hours: 168,
      },
    ],
    [
      "subscription_event_ingested",
      {
        subscription_event_id: "fixture-purchase",
        event_type: "INITIAL_PURCHASE",
        environment: "production",
        currency: "EUR",
      },
    ],
    ...result.cohorts.map(
      (cohort): [WinnerLoopEvent["name"], Record<string, string | number | boolean>] => [
        "cohort_snapshot_calculated",
        {
          creative_id: common.creativeId,
          cohort_window: cohort.window.label,
          attribution_class: cohort.attributionClass,
          subscriber_count: cohort.metrics.initialSubscribers,
          data_quality: cohort.missingData.length > 0 ? "partial" : "complete",
        },
      ],
    ),
  ];
  observed.forEach(([name, properties], index) =>
    runtime.emit(event(name, index + 1, result.ventureId, properties)),
  );
}

export interface FixtureDProductionOptions {
  contract: GrowthContract;
  workspaceDirectory: string;
  tracePath: string;
  runId?: string;
  /** Deterministic package-SDK fault injection for negative-control tests only. */
  fixtureFault?: {
    readonly feature: FixtureDProviderFeature;
    readonly phase: "apply" | "readBack";
  };
}

export interface FixtureDProductionResult {
  runId: string;
  state: "succeeded";
  trace: JsonObject;
  tracePath: string;
  auditPath: string;
  workflowDirectory: string;
  commandAuditRecords: number;
  commandEvents: number;
  eventPackEvents: number;
  providerOperations: readonly ProviderLifecycleEvidence[];
  distributionProposalId: string;
}

/**
 * Execute Fixture D behind one explicit command grant and a durable workflow.
 * Every provider is fixture-backed; the runtime cannot publish or spend.
 */
export async function runFixtureDThroughProductionBoundaries(
  options: FixtureDProductionOptions,
): Promise<FixtureDProductionResult> {
  const workspaceDirectory = resolve(options.workspaceDirectory);
  const tracePath = resolve(options.tracePath);
  const runId = options.runId ?? "winner-loop-fixture-d";
  const tenant: TenantRef = {
    organizationId: "fixture-organization",
    ventureId: options.contract.venture_id,
  };
  const auditPath = join(workspaceDirectory, "audit", "command-chain.json");
  const audit = new DurableFixtureAudit(auditPath, tenant);
  const events = new InMemoryEventLog();
  const assets = new FileFixtureAssetVault(join(workspaceDirectory, "assets", "vault.json"));
  const eventPack = createWinnerLoopEventRuntime();
  const providerContext = fixtureProviderContext();
  const fixtureCapabilityRuntime = createWinnerFixtureCapabilityRuntime({
    storePath: join(workspaceDirectory, "providers", "fixture-operations.json"),
    context: providerContext,
  });
  const providerEvidence: ProviderLifecycleEvidence[] = [];
  const connectionDoctors = new Map<string, string>();
  let meteredCommands = 0;
  const now = () => new Date(FIXED_NOW);
  const commandContext: CommandExecutionContext = {
    identity: { actorId: "fixture-founder", kind: "user" },
    tenant,
    subscription: {
      subscriptionId: "fixture-subscription",
      status: "active",
      plan: "fixture",
    },
    entitlements: ["winner_loop"],
    grants: [
      {
        grantId: "fixture-command-grant",
        commandIds: [RUN_COMMAND_ID, STEP_COMMAND_ID],
        scopes: ["winner:fixture:run"],
        expiresAt: "2026-08-10T00:00:00.000Z",
      },
    ],
    scopes: ["winner:fixture:run"],
  };
  const bus = new CommandBus(
    {
      identity(context) {
        if (context.identity.actorId !== commandContext.identity.actorId) {
          throw new Error("fixture identity is not authorized");
        }
      },
      tenant(context) {
        if (
          context.tenant.organizationId !== tenant.organizationId ||
          context.tenant.ventureId !== tenant.ventureId
        ) {
          throw new Error("cross-tenant Fixture D command denied");
        }
      },
      subscription(_contract, context) {
        if (!["active", "trialing"].includes(context.subscription.status)) {
          throw new Error("active subscription required");
        }
      },
      entitlement(contract, context) {
        for (const entitlement of contract.requirements.entitlements) {
          if (!context.entitlements.includes(entitlement)) {
            throw new Error(`missing entitlement ${entitlement}`);
          }
        }
      },
      grant(contract, context, at) {
        if (!contract.requirements.grant) return;
        const grant = context.grants.find(
          (candidate) =>
            candidate.commandIds.includes(contract.id) &&
            !candidate.revokedAt &&
            at < new Date(candidate.expiresAt),
        );
        if (!grant) throw new Error(`active command grant required for ${contract.id}`);
      },
      scope(contract, context) {
        for (const scope of contract.requirements.scopes) {
          if (!context.scopes.includes(scope)) throw new Error(`missing command scope ${scope}`);
        }
      },
      idempotency: new FileFixtureCommandIdempotencyStore(
        join(workspaceDirectory, "commands", "idempotency.json"),
      ),
      audit,
      events,
      metering: {
        record() {
          meteredCommands += 1;
        },
      },
    },
    { now, executionMode: "fixture" },
  );
  bus.register(stepContract, (input) => ({
    step: input.step ?? null,
    name: input.name ?? null,
    recorded: true,
  }));

  const databaseDirectory = join(workspaceDirectory, "database");
  mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  const spendStore = createSqliteSpendStore(join(databaseDirectory, "spend.db"));
  const creativeLedgerStore = createSqliteCreativeLedgerStore(
    join(databaseDirectory, "creative-ledger.db"),
  );
  const manifestStore = createSqliteCreativeManifestStore(join(databaseDirectory, "manifests.db"));
  const paidTestStore = createSqlitePaidTestStore(join(databaseDirectory, "paid-tests.db"));
  const evidenceStore = createSqliteWinnerLoopEvidenceStore(join(databaseDirectory, "evidence.db"));
  const subscriptionStore = createSqliteSubscriptionEventStore(
    join(databaseDirectory, "subscriptions.db"),
  );
  const resolveCapability = (
    feature: WinnerProviderFeature,
    operationId: string,
    idempotencyKey: string,
    payload: FixtureJsonObject,
  ) => {
    const capability = WINNER_FIXTURE_CAPABILITY_BY_FEATURE[feature];
    const adapter = fixtureCapabilityRuntime.registry.resolve(
      capability,
      fixtureCapabilityRuntime.profile,
    );
    const descriptor = adapter.capabilities.find(({ id }) => id === capability);
    if (!descriptor) throw new Error(`resolved adapter omitted ${capability}`);
    const request: CapabilityRequest = {
      capability,
      tenant,
      environment: "fixture",
      input: {
        operation_id: operationId,
        payload: JSON.parse(JSON.stringify(payload)) as JsonValue,
      },
      idempotencyKey,
      credential:
        descriptor.requiredScopes.length > 0
          ? fixtureCapabilityCredential(tenant, adapter.providerId as WinnerProviderAdapterId)
          : undefined,
    };
    return { adapter, capability, request };
  };

  const providerBoundary: FixtureDProviderBoundary = {
    async doctor(feature): Promise<"ready"> {
      const resolved = resolveCapability(
        feature,
        `fixture-doctor-${feature}`,
        `fixture-doctor-${feature}`,
        {},
      );
      const doctor = await resolved.adapter.discover(resolved.request);
      const status = typeof doctor.status === "string" ? doctor.status : "unavailable";
      connectionDoctors.set(resolved.adapter.providerId, status);
      if (status !== "ready") {
        throw new Error(`fixture provider doctor failed for ${resolved.adapter.providerId}`);
      }
      return "ready";
    },
    async execute(operation: FixtureDProviderOperation): Promise<FixtureDProviderOperationResult> {
      const resolved = resolveCapability(
        operation.feature,
        operation.operationId,
        operation.idempotencyKey,
        JSON.parse(JSON.stringify(operation.payload)) as FixtureJsonObject,
      );
      const expectedAdapter = FIXTURE_ADAPTER_BY_FEATURE[operation.feature];
      if (resolved.adapter.providerId !== expectedAdapter) {
        throw new Error(`stack profile resolved the wrong adapter for ${resolved.capability}`);
      }
      const doctor = await resolved.adapter.discover(resolved.request);
      const estimate = await resolved.adapter.estimate(resolved.request);
      const plan = await resolved.adapter.plan(resolved.request);
      if (
        options.fixtureFault?.feature === operation.feature &&
        options.fixtureFault.phase === "apply"
      ) {
        throw new Error(`injected fixture SDK apply failure for ${operation.feature}`);
      }
      const applied = await resolved.adapter.apply(resolved.request, plan);
      if (
        options.fixtureFault?.feature === operation.feature &&
        options.fixtureFault.phase === "readBack"
      ) {
        throw new Error(`injected fixture SDK readBack failure for ${operation.feature}`);
      }
      const readBack = await resolved.adapter.readBack(resolved.request, applied);
      const reconciled = await resolved.adapter.reconcile(resolved.request);
      if (
        doctor.status !== "ready" ||
        !estimate.known ||
        estimate.amount !== 0 ||
        applied.state !== "applied" ||
        readBack.state !== "verified" ||
        reconciled.state !== "verified"
      ) {
        throw new Error(`fixture provider lifecycle failed for ${expectedAdapter}`);
      }
      const output = readBack.output ?? applied.output;
      if (!output || Array.isArray(output) || typeof output !== "object") {
        throw new Error(`fixture provider returned no verified output for ${operation.feature}`);
      }
      providerEvidence.push({
        adapterId: expectedAdapter,
        feature: operation.feature,
        capability: resolved.capability,
        operationId: operation.operationId,
        doctor: "ready",
        dryRun: "planned",
        apply: "succeeded",
        readBack: "matched",
        verify: "verified_fixture",
        reconcile: "matched",
        providerInvoked: false,
        externalEffectOccurred: false,
        spendAllowed: false,
        packageSdk: "@venture-harness/provider-sdk",
        registryResolved: true,
        stackProfileId: "winner-loop-fixture-v1",
        durableReplay: applied.evidence?.reused === true,
      });
      return {
        providerId: resolved.adapter.providerId,
        output: JSON.parse(JSON.stringify(output)) as Record<string, unknown>,
        readBackVerified: true,
      };
    },
  };

  const materializeFixtureVenture = async (): Promise<FixtureDBootstrapEvidence> => {
    const grant = createLaunchGrant({
      ownerOrganizationId: tenant.organizationId,
      ventureName: "Winner Loop Fixture Venture",
      ventureSlug: options.contract.venture_id,
      ideaDigest: "d".repeat(64),
      seed: { id: "hybrid-agentic-service", version: "0.2.0" },
      stackProfile: { id: "founder-default", version: "0.2.0" },
      repository: {
        owner: "fixture-organization",
        name: options.contract.venture_id,
        visibility: "private",
      },
      providerAccounts: [],
      autonomyProfile: "plan_only",
      allowedExternalEffects: ["repository.create"],
      modelBudget: { maxTokens: 0, maxMinorUnits: 0, currency: "EUR" },
      externalResourceBudget: { maxResources: 1, maxMinorUnits: 0, currency: "EUR" },
      permissions: {
        productionDeployment: false,
        domainConfiguration: false,
        liveCommerceConfiguration: false,
      },
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      grantedBy: { actorId: "fixture-founder", actorType: "founder" },
      approvalRef: "fixture:materialization:approved",
    });
    const plan = compileVentureMaterialization({
      grant,
      at: FIXED_NOW,
      coreVersion: "0.2.0",
      workflowRefSha: "a".repeat(40),
      effects: [],
    });
    const materialized = await materializeVenture(
      plan,
      new NodeMaterializationFileSystem(join(workspaceDirectory, "venture")),
      FIXED_NOW,
    );
    const pack = installPack(emptyPackInstallationState(), PACKS["winner-loop"], "0.2.0");
    if (
      pack.state.installed["winner-loop"] !== PACKS["winner-loop"].version ||
      !pack.state.capabilities.includes("subscription.lifecycle.read")
    ) {
      throw new Error("Winner Loop fixture pack installation read-back failed");
    }
    return {
      ventureMaterialized: true,
      materializedFiles: materialized.files.length,
      materializationPlanDigest: materialized.planDigest,
      packStatus: pack.status,
      packVersion: PACKS["winner-loop"].version,
    };
  };

  let domainResult: FixtureDResult | null = null;
  bus.register(runContract, async () => {
    const bootstrapEvidence = await materializeFixtureVenture();
    const asset = assets.put(
      tenant,
      "fixture-rendered-asset",
      "video/mp4",
      new TextEncoder().encode("SYNTHETIC_FIXTURE_ASSET"),
    );
    if (
      !assets.get(tenant, asset.assetId) ||
      assets.get(tenant, asset.assetId)?.sha256 !== asset.sha256
    ) {
      throw new Error("fixture asset vault read-back failed");
    }
    domainResult = await runFixtureD({
      organizationId: tenant.organizationId,
      contract: options.contract,
      store: spendStore,
      creativeLedgerStore,
      manifestStore,
      paidTestStore,
      evidenceStore,
      subscriptionStore,
      providerBoundary,
      bootstrapEvidence,
      now,
      recordStep: async (step) => {
        await bus.execute(stepContract, step as unknown as JsonValue, {
          context: commandContext,
          idempotencyKey: `fixture-step-${step.step}`,
        });
      },
    });
    return JSON.parse(JSON.stringify(buildCreativeTrace(domainResult))) as JsonObject;
  });

  eventPack.install();
  eventPack.enable();
  const workflowDirectory = join(workspaceDirectory, "workflow");
  const workflowStore = new FileWorkflowStore({ rootDir: workflowDirectory });
  let finalTrace: JsonObject | null = null;
  let distributionProposalId = "";
  const workflow = defineWorkflow({
    id: "winner-loop-fixture-d-production-boundaries",
    name: "Winner Loop Fixture D production-boundary proof",
    version: "1",
    nodes: [
      workflowNode("fixture-preflight", {
        purpose: "Verify the explicit grant, installed event pack, and fixture-only providers",
        handler: "fixture.preflight",
        capability: "winner.fixture.preflight",
      }),
      workflowNode("fixture-run", {
        purpose: "Run Fixture D through the authorized command bus",
        handler: "fixture.run",
        capability: "winner.fixture.run",
        dependencies: ["fixture-preflight"],
        effect: "local_write",
        evidence: { required: true, artifact: tracePath },
        timeoutMs: 60_000,
      }),
      workflowNode("fixture-verify", {
        purpose: "Verify durable evidence and emit the sanitized trace",
        handler: "fixture.verify",
        capability: "winner.fixture.verify",
        dependencies: ["fixture-run"],
        effect: "local_write",
        evidence: { required: true, artifact: tracePath },
      }),
    ],
    maxParallel: 1,
    maxIterations: 16,
    budgets: { default: 100 },
  });

  try {
    const executor = new WorkflowExecutor({
      store: workflowStore,
      now,
      bindings: {
        handlers: {
          "fixture.preflight": async () => {
            const doctorStatuses = await Promise.all(
              Object.entries(WINNER_FIXTURE_CAPABILITY_BY_FEATURE).map(
                async ([feature, capability]) => {
                  const resolved = resolveCapability(
                    feature as WinnerProviderFeature,
                    `fixture-preflight-${feature}`,
                    `fixture-preflight-${feature}`,
                    {},
                  );
                  const discovered = await resolved.adapter.discover(resolved.request);
                  return {
                    adapterId: resolved.adapter.providerId,
                    capability,
                    status: discovered.status,
                  };
                },
              ),
            );
            if (!audit.verify() || !eventPack.isInstalled() || !eventPack.isEnabled()) {
              throw new Error("Fixture D production-boundary preflight failed");
            }
            return {
              output: {
                commandGrant: commandContext.grants[0]!.grantId,
                fixtureOnly: true,
                stackProfileId: fixtureCapabilityRuntime.profile.profileId,
                providerStatuses: doctorStatuses,
              },
              effectVerified: true,
            };
          },
          "fixture.run": async () => {
            const trace = await bus.execute(
              runContract,
              { runId, fixtureOnly: true },
              {
                context: commandContext,
                idempotencyKey: `fixture-run-${runId}`,
              },
            );
            return { output: trace, effectVerified: true, evidenceArtifact: tracePath };
          },
          "fixture.verify": () => {
            if (!domainResult || domainResult.steps.length !== 34) {
              throw new Error("Fixture D did not record all 34 milestones");
            }
            emitObservedEvents(eventPack, domainResult);
            const proposal = createFixtureDistributionPrProposal(
              { organizationId: tenant.organizationId, ventureId: tenant.ventureId },
              {
                proposalId: "fixture-distribution-pr-1",
                learning: domainResult.learning,
                hypothesis:
                  "Test whether a clearer payout comparison is associated with qualified intent.",
                implementation:
                  "Prepare a fixture campaign-page CTA variant for a bounded comparison.",
                diffSummary:
                  "Fixture-only campaign-page CTA candidate linked to Winner Loop evidence.",
                files: [
                  {
                    path: "src/campaigns/payout-rank-cta.ts",
                    operation: "modify",
                    before: "Existing fixture campaign CTA",
                    after: "Candidate fixture CTA for the observed audience segment",
                  },
                ],
                previewDescription: "Static fixture preview metadata for operator review.",
                createdAt: FIXED_NOW.toISOString(),
              },
            );
            distributionProposalId = proposal.proposalId;
            const asset = assets.get(tenant, "fixture-rendered-asset");
            const baseTrace = buildCreativeTrace(domainResult);
            finalTrace = JSON.parse(
              JSON.stringify({
                ...baseTrace,
                productionBoundaries: {
                  commandBus: {
                    runCommand: RUN_COMMAND_ID,
                    stepCommand: STEP_COMMAND_ID,
                    steps: domainResult.steps.length,
                    meteredCommands,
                  },
                  graph: {
                    runId,
                    graphId: workflow.id,
                    durableStore: "file",
                  },
                  assets: {
                    assetId: asset?.assetId ?? null,
                    sha256: asset?.sha256 ?? null,
                    readBackMatched: asset !== null,
                    durableStore: "file",
                  },
                  audit: {
                    path: "fixture-workspace/audit/command-chain.json",
                    records: audit.read().length,
                    chainVerified: audit.verify(),
                  },
                  persistence: {
                    spend: spendStore.productionSafe,
                    creativeLedger: creativeLedgerStore.durable,
                    manifests: manifestStore.durable,
                    paidTests: paidTestStore.durable,
                    evidence: evidenceStore.durable,
                    subscriptions: subscriptionStore.durable,
                  },
                  providers: {
                    fixtureOnly: true,
                    packageSdk: "@venture-harness/provider-sdk",
                    registry: "@venture-harness/provider-registry",
                    stackProfileId: fixtureCapabilityRuntime.profile.profileId,
                    durableStore: "file",
                    connections: Object.fromEntries(connectionDoctors),
                    operations: providerEvidence,
                    liveVerified: false,
                  },
                  eventPack: {
                    installed: eventPack.isInstalled(),
                    enabled: eventPack.isEnabled(),
                    eventsRecorded: eventPack.recorded().length,
                    destination: "first_party_evidence",
                  },
                },
                distributionPr: proposal,
              }),
            ) as JsonObject;
            if (!audit.verify() || !asset || providerEvidence.length !== 6) {
              throw new Error("Fixture D boundary read-back failed");
            }
            atomicJson(tracePath, finalTrace);
            return {
              output: {
                tracePath,
                auditVerified: true,
                providerOperations: providerEvidence.length,
                eventPackEvents: eventPack.recorded().length,
                distributionProposalId,
              },
              effectVerified: true,
              evidenceArtifact: tracePath,
            };
          },
        },
      },
    });
    const state = await executor.start(workflow, { runId });
    if (state.status !== "succeeded" || !finalTrace || !audit.verify()) {
      const failedNode = Object.values(state.nodes).find((node) => node.error || node.waiting);
      const nodeFailure = failedNode?.error?.message ?? failedNode?.waiting?.reason;
      throw new Error(
        `Fixture D workflow ended ${state.status}${nodeFailure ? `: ${nodeFailure}` : ""}`,
      );
    }
    return {
      runId,
      state: "succeeded",
      trace: finalTrace,
      tracePath,
      auditPath,
      workflowDirectory,
      commandAuditRecords: audit.read().length,
      commandEvents: events.read(tenant).length,
      eventPackEvents: eventPack.recorded().length,
      providerOperations: Object.freeze([...providerEvidence]),
      distributionProposalId,
    };
  } finally {
    spendStore.close();
    creativeLedgerStore.close();
    manifestStore.close();
    paidTestStore.close();
    evidenceStore.close();
    subscriptionStore.close();
  }
}
