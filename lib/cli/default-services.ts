import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import {
  CORE_JOURNEYS,
  EVENT_PACKS,
  resolveActiveCoreJourneys,
  resolveActiveEventPacks,
  type EventPackId,
} from "../analytics";
import { issueAuthorizationEnvelope } from "../authorization";
import { authorizationEnvelopeSchema, type AuthorizationEnvelope } from "../config/policy-schema";
import { artifactReferenceSchema, looksLikeCredentialValue } from "../config/contracts";
import { loadHarnessLock } from "../config/harness-lock";
import { launchSchema } from "../config/launch-schema";
import { createDefaultLoopsConfig, loopsSchema } from "../config/loop-schema";
import { mobileSchema } from "../config/mobile-schema";
import { policiesSchema } from "../config/policy-schema";
import { providersSchema } from "../config/provider-schema";
import { ventureSchema } from "../config/venture-schema";
import { analyticsSchema } from "../config/schemas";
import {
  CliSessionCredentialBackend,
  CredentialBroker,
  EnvironmentCredentialBackend,
  MacOSKeychainCredentialBackend,
  NodeCommandRunner,
  OnePasswordCredentialBackend,
  credentialKinds,
  defaultCredentialCatalogPath,
  loadCredentialCatalog,
  removeCredentialReferences,
  runInteractiveCliLogin,
  saveCredentialCatalog,
  supportsInteractiveCliAuth,
  upsertCredentialReference,
  type CommandRunner,
  type CredentialKind,
  type CredentialReference,
  type CredentialTester,
} from "../credentials";
import {
  DATA_SOURCE_IDS,
  type DataConnector,
  type DataSourceId,
  type DataSourceRequirement,
} from "../data";
import {
  compileLaunchDryRun,
  compileLaunchGraph,
  createLaunchManualBindings,
  createRepositoryInterruptEvidenceVerifier,
  founderBriefSchema,
  requiredCapabilitiesForLaunch,
  requiredEnvironmentsForLaunch,
  routeLaunch,
  scopeLaunchGraphForAuthorization,
  type FounderBrief,
  type LaunchDecision,
} from "../launch";
import { nextCronOccurrence, persistLearningReport, persistOperatingCadence } from "../learning";
import { createNodeMigrationFileSystem, migrateV01ToV02 } from "../migrations";
import {
  providerRegistry,
  type HttpFetcher,
  type ProviderExecutionContext,
  type ProviderId,
  type ProviderRegistry,
} from "../providers";
import {
  assertBuildAgentHostAvailable,
  CodexCliBuildAgentHost,
  codexBuildAgentEnvironment,
  createRepositoryCheckpointEvidenceVerifier,
  createLaunchProductBindings,
  createLaunchReportInputFromRun,
  createLaunchReportWorkflowBinding,
  createOfficialProviderContext,
  createProviderWorkflowBindings,
  FileProviderIdempotencyLedger,
  FileProviderLifecycleStore,
  NativeHttpFetcher,
  loadRepositoryCheckpointEvidence,
  persistLaunchReport,
  renderLaunchReport,
  type BuildAgentHost,
  type ProviderRuntimeContext,
  type ProviderWorkflowPlanFactory,
} from "../runtime";
import {
  applyOperationalUpgrade,
  locateLocalHarnessRelease,
  type HarnessRelease,
} from "../upgrade";
import {
  FileWorkflowStore,
  WorkflowExecutor,
  validateWorkflow,
  type JsonValue,
  type WorkflowBindings,
  type WorkflowDefinition,
  type WorkflowRunState,
  type WorkflowStore,
} from "../workflow";
import type { CliServices } from "./types";
import {
  createDefaultProviderPlanFactories,
  inspectDefaultProviderDoctor,
} from "./default-provider-runtime";
import { createDefaultLearningRuntime } from "./default-learning-runtime";

const LAUNCH_ROUTER_VERSION = "0.2.0" as const;

interface ProjectState {
  schemaVersion: 2;
  createdAt: string;
  brief: FounderBrief;
  decision: LaunchDecision;
  activeEventPacks: EventPackId[];
  routerVersion: typeof LAUNCH_ROUTER_VERSION;
}

interface LaunchState {
  schemaVersion: 2;
  brief: FounderBrief;
  decision: LaunchDecision;
  activeEventPacks: EventPackId[];
  routerVersion: typeof LAUNCH_ROUTER_VERSION;
  definition: WorkflowDefinition;
  authorization: AuthorizationEnvelope;
}

export interface LaunchBindingContext {
  rootDir: string;
  brief: FounderBrief;
  definition: WorkflowDefinition;
  authorization: AuthorizationEnvelope;
}

export interface DefaultCliServicesOptions {
  rootDir?: string;
  store?: WorkflowStore;
  /** Product/local/model handlers only. Provider and launch.report handlers are reserved. */
  launchBindings?: (context: LaunchBindingContext) => Promise<WorkflowBindings> | WorkflowBindings;
  /** Agent-neutral host used by the default product handlers when launchBindings is not injected. */
  buildAgentHost?: BuildAgentHost;
  /** Direct runner for deterministic launch quality commands; useful for isolated tests. */
  productCommandRunner?: CommandRunner;
  /** Direct runner for provider CLI sessions and doctor checks; useful for isolated tests. */
  providerCommandRunner?: CommandRunner;
  /** Direct runner for read-only data connectors such as psql; useful for isolated tests. */
  dataCommandRunner?: CommandRunner;
  /** Official HTTP read transport for direct-data connectors; injectable for deterministic tests. */
  dataHttpFetcher?: HttpFetcher;
  /** Direct runner for fixed local upgrade sync/check steps; useful for isolated tests. */
  upgradeCommandRunner?: CommandRunner;
  providerPlanFactories?:
    | Readonly<Record<string, ProviderWorkflowPlanFactory>>
    | ((
        context: LaunchBindingContext,
      ) =>
        | Promise<Readonly<Record<string, ProviderWorkflowPlanFactory>>>
        | Readonly<Record<string, ProviderWorkflowPlanFactory>>);
  providerRuntimeContext?:
    | ProviderRuntimeContext
    | ((context: LaunchBindingContext) => Promise<ProviderRuntimeContext> | ProviderRuntimeContext);
  credentialBroker?: CredentialBroker;
  /** Override the global metadata-only credential catalog (useful for tests and portable hosts). */
  credentialCatalogPath?: string;
  credentialTesters?: Partial<Record<string, CredentialTester>>;
  interactiveCliLogin?: (provider: string) => Promise<void>;
  providerRegistry?: ProviderRegistry;
  providerContext?: ProviderExecutionContext;
  dataConnectors?: DataConnector[];
  dataRequirements?: DataSourceRequirement[];
  release?: HarnessRelease;
  now?: () => Date;
}

const PROVIDER_BY_NODE: Record<string, ProviderId> = {
  "github-repository": "github",
  "neon-database": "neon",
  "brevo-sending-domain": "brevo",
  "brevo-domain-verification": "brevo",
  "brevo-email": "brevo",
  "stripe-commerce": "stripe",
  "google-analytics-property": "google",
  "google-analytics-stream": "google",
  "google-site-dns-record": "google",
  "google-site-verification": "google",
  "google-search-console": "google",
  "bing-discovery": "bing",
  "vercel-project": "vercel",
  "production-deploy": "vercel",
  "dns-records": "dns",
  "revenuecat-entitlements": "revenuecat",
  "apple-first-app-record": "app_store_connect",
  "eas-build": "eas",
  "eas-submit": "eas",
  "testflight-state": "app_store_connect",
};

function mergeBindings(...bindings: readonly WorkflowBindings[]): WorkflowBindings {
  const interruptEvidenceVerifier = bindings
    .map((binding) => binding.interruptEvidenceVerifier)
    .filter(
      (verifier): verifier is NonNullable<WorkflowBindings["interruptEvidenceVerifier"]> =>
        verifier !== undefined,
    )
    .at(-1);
  const checkpointEvidenceVerifier = bindings
    .map((binding) => binding.checkpointEvidenceVerifier)
    .filter(
      (verifier): verifier is NonNullable<WorkflowBindings["checkpointEvidenceVerifier"]> =>
        verifier !== undefined,
    )
    .at(-1);
  return {
    handlers: Object.assign({}, ...bindings.map((binding) => binding.handlers ?? {})),
    validators: Object.assign({}, ...bindings.map((binding) => binding.validators ?? {})),
    conditions: Object.assign({}, ...bindings.map((binding) => binding.conditions ?? {})),
    compensators: Object.assign({}, ...bindings.map((binding) => binding.compensators ?? {})),
    interruptEvidenceVerifier,
    checkpointEvidenceVerifier,
    secrets: [...new Set(bindings.flatMap((binding) => binding.secrets ?? []))],
  };
}

function providerHandlerNames(definition: WorkflowDefinition): string[] {
  return definition.nodes
    .filter((node) => node.kind === "provider" && node.handler)
    .map((node) => node.handler!)
    .sort();
}

function productHandlerNames(definition: WorkflowDefinition): string[] {
  return definition.nodes
    .filter((node) => node.handler && node.kind !== "provider" && node.handler !== "launch.report")
    .map((node) => node.handler!)
    .sort();
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    return absolute;
  }
  throw new Error(`Path escapes the venture root: ${path}`);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function writeYamlAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, stringify(value, { lineWidth: 100 }));
}

function readStructured(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : parse(text);
}

function eventPacksFor(brief: FounderBrief, decision: LaunchDecision): EventPackId[] {
  return resolveActiveEventPacks({
    capabilities: decision.capabilities,
    appKind: decision.rail.appKind,
    monetizationModel: brief.monetization_model,
    leadJourney: ["lead_generation", "services"].includes(brief.monetization_model),
  });
}

function learningSourcesFor(
  decision: LaunchDecision,
  activeEventPacks: readonly EventPackId[],
): { source: DataSourceId; required: boolean }[] {
  const requested = new Set<DataSourceId>(
    activeEventPacks.flatMap((pack) => [...EVENT_PACKS[pack].freshnessSources]) as DataSourceId[],
  );
  if (decision.capabilities.includes("bing_webmaster")) requested.add("bing_webmaster");
  if (
    decision.capabilities.includes("transactional_email") ||
    decision.capabilities.includes("lifecycle_email")
  ) {
    requested.add("brevo");
  }
  if (decision.payment.provider === "stripe") requested.add("stripe");
  if (decision.payment.provider === "revenuecat") requested.add("revenuecat");
  const required = new Set<DataSourceId>(["neon_commercial_evidence", "release_log"]);
  if (decision.payment.provider !== "none") required.add(decision.payment.provider);
  return DATA_SOURCE_IDS.filter((source) => requested.has(source)).map((source) => ({
    source,
    required: required.has(source),
  }));
}

function synchronizeBriefContracts(
  root: string,
  brief: FounderBrief,
  decision: LaunchDecision,
  activeEventPacks: readonly EventPackId[],
  synchronizedAt: Date,
): string[] {
  const pendingWrites: { path: string; reference: string; value: unknown }[] = [];
  const venturePath = inside(root, "config/venture.yaml");
  if (existsSync(venturePath)) {
    const current = ventureSchema.parse(readStructured(venturePath));
    const next = ventureSchema.parse({
      ...current,
      venture: {
        ...current.venture,
        name: brief.name,
        domain: brief.domain ?? current.venture.domain,
        market: brief.target_market ?? brief.specific_user_or_audience,
        target_market: brief.target_market ?? brief.specific_user_or_audience,
        language: (brief.locale ?? current.venture.locale).split("-")[0],
        locale: brief.locale ?? current.venture.locale,
        currency: brief.currency ?? current.venture.currency,
        timezone: brief.timezone ?? current.venture.timezone,
        stage: decision.mode.selectedMode === "validate_first" ? "demand_validation" : "build",
        repository_visibility: brief.repository_visibility ?? current.venture.repository_visibility,
        harness_version: "0.2.0",
        app_kind: decision.rail.appKind,
        launch_mode: decision.mode.selectedMode,
        business_model: brief.business_model,
        monetization_model: brief.monetization_model,
        mobile_stack: decision.rail.mobileStack,
        outcomes: {
          ...current.venture.outcomes,
          primary: {
            statement: brief.intended_outcome,
            success_signal: brief.primary_success_signal,
          },
        },
        capabilities: {
          ...current.venture.capabilities,
          active: [...decision.capabilities],
        },
      },
      validation: {
        ...current.validation,
        stage: decision.mode.selectedMode === "validate_first" ? "demand_validation" : "build",
        primary_conversion: brief.primary_success_signal,
      },
    });
    pendingWrites.push({ path: venturePath, reference: "config/venture.yaml", value: next });
  }

  const launchConfigPath = inside(root, "config/launch.yaml");
  if (existsSync(launchConfigPath)) {
    const current = launchSchema.parse(readStructured(launchConfigPath));
    const factorRationale = (factor: string, level: string) =>
      `${factor.replaceAll("_", " ")} was supplied as ${level} in the selected founder brief.`;
    const next = launchSchema.parse({
      ...current,
      launch: {
        ...current.launch,
        selected_mode: decision.mode.selectedMode,
        confidence: decision.mode.confidence,
        rationale: decision.mode.rationale,
        rejected_alternatives: decision.mode.rejectedAlternatives,
        assumptions: decision.mode.assumptions,
        evidence_that_could_change_choice: decision.mode.evidenceThatCouldChangeChoice,
        rail: {
          app_kind: decision.rail.appKind,
          mobile_stack: decision.rail.mobileStack,
          rationale: decision.rail.rationale,
        },
        routing_factors: Object.fromEntries(
          Object.entries(current.launch.routing_factors).map(([factor]) => {
            const level = brief.factors[factor as keyof typeof brief.factors];
            return [factor, { level, rationale: factorRationale(factor, level) }];
          }),
        ),
        progressive_commitment: {
          specific_user_or_audience: brief.specific_user_or_audience,
          problem_or_job: brief.problem_or_job,
          intended_outcome: brief.intended_outcome,
          smallest_core_journey: brief.smallest_core_journey,
          primary_success_signal: brief.primary_success_signal,
          material_constraints: brief.material_constraints,
          known_truths: brief.known_truths,
          unresolved_assumptions: brief.assumptions,
          blocking_issues: [],
        },
      },
    });
    pendingWrites.push({
      path: launchConfigPath,
      reference: "config/launch.yaml",
      value: next,
    });
  }

  const mobilePath = inside(root, "config/mobile.yaml");
  if (existsSync(mobilePath)) {
    const current = mobileSchema.parse(readStructured(mobilePath));
    const mobile = decision.rail.mobileStack !== "none";
    if (
      mobile &&
      current.mobile.app_store_connect.first_app_record.state === "complete" &&
      brief.bundle_identifier &&
      current.mobile.bundle_identifier &&
      current.mobile.bundle_identifier !== brief.bundle_identifier
    ) {
      throw new Error(
        `The verified Apple app record uses ${current.mobile.bundle_identifier}, but the brief requests ${brief.bundle_identifier}; reconcile the identifier before selecting this brief.`,
      );
    }
    const next = mobileSchema.parse({
      ...current,
      mobile: {
        ...current.mobile,
        stack: decision.rail.mobileStack,
        rationale: decision.rail.rationale,
        bundle_identifier: mobile
          ? (brief.bundle_identifier ?? current.mobile.bundle_identifier)
          : current.mobile.bundle_identifier,
        app_scheme: mobile
          ? (brief.app_scheme ?? current.mobile.app_scheme ?? brief.id)
          : current.mobile.app_scheme,
        app_store_connect: {
          ...current.mobile.app_store_connect,
          primary_language: brief.locale ?? current.mobile.app_store_connect.primary_language,
          first_app_record: mobile
            ? current.mobile.app_store_connect.first_app_record.state === "complete"
              ? current.mobile.app_store_connect.first_app_record
              : {
                  state: "required",
                  manual_action_ref: "reports/launch/<run-id>/manual/apple-first-app-record.json",
                }
            : { state: "not_required", manual_action_ref: null },
        },
      },
    });
    pendingWrites.push({ path: mobilePath, reference: "config/mobile.yaml", value: next });
  }

  const analyticsPath = inside(root, "config/analytics.yaml");
  if (existsSync(analyticsPath)) {
    const current = analyticsSchema.parse(readStructured(analyticsPath));
    const activeJourneys = new Set(resolveActiveCoreJourneys(activeEventPacks));
    const coreJourneys = Object.fromEntries(
      Object.entries(CORE_JOURNEYS).map(([journeyId, journey]) => [
        journeyId,
        {
          active: activeJourneys.has(journeyId as keyof typeof CORE_JOURNEYS),
          required_packs: [...journey.requiredPacks],
          start_events: [...journey.startEvents],
          outcome_events: [...journey.outcomeEvents],
          authoritative_destination: "neon",
        },
      ]),
    );
    const next = analyticsSchema.parse({
      ...current,
      event_packs: {
        ...((current.event_packs as Record<string, unknown> | undefined) ?? {}),
        active: [...activeEventPacks],
      },
      core_journeys: coreJourneys,
    });
    pendingWrites.push({
      path: analyticsPath,
      reference: "config/analytics.yaml",
      value: next,
    });
  }

  const loopsPath = inside(root, "config/loops.yaml");
  if (existsSync(loopsPath)) {
    const current = loopsSchema.parse(readStructured(loopsPath));
    const sources = learningSourcesFor(decision, activeEventPacks);
    const freshnessHours = { daily: 36, weekly: 192, biweekly: 384, monthly: 800 } as const;
    const enabledCadences = new Set(["daily", "weekly", "biweekly", "monthly"]);
    const next = loopsSchema.parse({
      ...current,
      loops: Object.fromEntries(
        Object.entries(current.loops).map(([loopId, loop]) => [
          loopId,
          {
            ...loop,
            enabled: brief.needs.scheduled_learning && enabledCadences.has(loop.cadence),
            next_run_at:
              brief.needs.scheduled_learning && enabledCadences.has(loop.cadence)
                ? nextCronOccurrence(loop.trigger.expression, synchronizedAt)
                : null,
            inputs: sources.map(({ source, required }) => ({
              source,
              required,
              freshness_hours: freshnessHours[loop.cadence],
            })),
          },
        ]),
      ),
    });
    pendingWrites.push({ path: loopsPath, reference: "config/loops.yaml", value: next });
  }
  const originals = new Map(
    pendingWrites.map(({ path }) => [path, readFileSync(path, "utf8")] as const),
  );
  const written: string[] = [];
  try {
    for (const pending of pendingWrites) {
      writeYamlAtomic(pending.path, pending.value);
      written.push(pending.path);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const path of written.reverse()) {
      try {
        writeTextAtomic(path, originals.get(path)!);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      rollbackErrors.length === 0
        ? `Brief contract synchronization failed and prior files were restored: ${message}`
        : `Brief contract synchronization failed and rollback was incomplete (${rollbackErrors.join("; ")}): ${message}`,
    );
  }
  return pendingWrites.map(({ reference }) => reference);
}

function noCredentialMaterial(value: unknown, path = "output"): void {
  if (typeof value === "string") {
    if (looksLikeCredentialValue(value)) {
      throw new Error(`${path} looks like credential material; return only resource identifiers.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => noCredentialMaterial(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|private.?key|api.?key/i.test(key)) {
      throw new Error(`${path}.${key} is a forbidden credential field.`);
    }
    noCredentialMaterial(item, `${path}.${key}`);
  }
}

function projectPath(root: string): string {
  return inside(root, ".venture/project.json");
}

function launchPath(root: string, runId: string): string {
  return inside(root, `.venture/launches/${runId}.json`);
}

function loadProject(root: string): ProjectState {
  const path = projectPath(root);
  if (!existsSync(path)) {
    throw new Error("No founder brief is selected. Next: run vh create --brief <file>.");
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as
    ProjectState | { schemaVersion: 1; createdAt: string; brief: FounderBrief };
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error("Unsupported .venture/project.json version.");
  }
  const brief = founderBriefSchema.parse(value.brief);
  const canonicalDecision = routeLaunch(brief);
  const canonicalPacks = eventPacksFor(brief, canonicalDecision);
  if (value.schemaVersion === 1) {
    return {
      schemaVersion: 2,
      createdAt: value.createdAt,
      brief,
      decision: canonicalDecision,
      activeEventPacks: canonicalPacks,
      routerVersion: LAUNCH_ROUTER_VERSION,
    };
  }
  if (value.routerVersion !== LAUNCH_ROUTER_VERSION) {
    throw new Error(
      `Project routing snapshot uses ${value.routerVersion}; run vh upgrade before launching it with router ${LAUNCH_ROUTER_VERSION}.`,
    );
  }
  if (
    !isDeepStrictEqual(value.decision, canonicalDecision) ||
    !isDeepStrictEqual(value.activeEventPacks, canonicalPacks)
  ) {
    throw new Error(
      "Project routing snapshot does not match its selected brief and router version; restore or recreate the project state before launch.",
    );
  }
  return { ...value, brief, decision: value.decision, activeEventPacks: canonicalPacks };
}

function loadLaunch(root: string, runId: string): LaunchState {
  const path = launchPath(root, runId);
  if (!existsSync(path)) {
    throw new Error(
      `Launch definition for ${runId} is missing; restore .venture/launches metadata.`,
    );
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as
    | LaunchState
    | {
        schemaVersion: 1;
        brief: FounderBrief;
        definition: WorkflowDefinition;
        authorization: AuthorizationEnvelope;
      };
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error(`Unsupported launch metadata for ${runId}.`);
  }
  const brief = founderBriefSchema.parse(value.brief);
  const authorization = authorizationEnvelopeSchema.parse(value.authorization);
  validateWorkflow(value.definition);
  const canonicalDecision = routeLaunch(brief);
  const canonicalPacks = eventPacksFor(brief, canonicalDecision);
  if (value.schemaVersion === 1) {
    return {
      schemaVersion: 2,
      brief,
      decision: canonicalDecision,
      activeEventPacks: canonicalPacks,
      routerVersion: LAUNCH_ROUTER_VERSION,
      definition: value.definition,
      authorization,
    };
  }
  if (
    value.routerVersion !== LAUNCH_ROUTER_VERSION ||
    !isDeepStrictEqual(value.decision, canonicalDecision) ||
    !isDeepStrictEqual(value.activeEventPacks, canonicalPacks)
  ) {
    throw new Error(
      `Launch ${runId} has an invalid or unsupported routing snapshot; restore the persisted launch metadata before resuming.`,
    );
  }
  return { ...value, brief, authorization, activeEventPacks: canonicalPacks };
}

function providerIds(definition: WorkflowDefinition): ProviderId[] {
  return [
    ...new Set(
      definition.nodes.flatMap((node) =>
        PROVIDER_BY_NODE[node.id] ? [PROVIDER_BY_NODE[node.id]] : [],
      ),
    ),
  ];
}

function generatedRunId(brief: FounderBrief, now: Date): string {
  return `launch-${brief.id}-${now.getTime().toString(36)}`.toLowerCase();
}

function environmentVariableForRef(ref: string): string {
  return ref
    .replace(/^cred:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .toUpperCase();
}

function providerRevocationAction(reference: CredentialReference): string {
  const target = reference.label ?? reference.accountId ?? reference.ref;
  const actions: Readonly<Record<string, string>> = {
    github: `Open GitHub Settings > Developer settings > Personal access tokens and revoke the token for ${target}; also review Settings > Password and authentication > Sessions`,
    vercel: `Open Vercel Account Settings > Tokens and revoke the token for ${target}; also review active login sessions`,
    neon: `Open Neon Console > Account settings > API keys and revoke the key for ${target}`,
    stripe: `Open the matching Stripe test/live Dashboard > Developers > API keys and expire or delete the key for ${target}`,
    revenuecat: `Open the matching RevenueCat project > API keys and revoke the secret key for ${target}`,
    brevo: `Open Brevo Settings > SMTP & API > API Keys and delete the key for ${target}`,
    google: `Open Google Account Security and Google Cloud IAM/Credentials for ${target}; revoke the OAuth grant or disable/delete the service-account key`,
    bing: `Open the Microsoft account/app authorization settings used by Bing Webmaster Tools and revoke the grant or API key for ${target}`,
    eas: `Open Expo account security/access-token settings and revoke the token or session for ${target}`,
    app_store_connect: `Open App Store Connect > Users and Access > Integrations and revoke the API key for ${target}`,
  };
  return (
    actions[reference.provider] ??
    `Open ${reference.provider} credential/security settings and revoke the credential for ${target}`
  );
}

function localRemovalAction(reference: CredentialReference): string {
  if (reference.backend === "environment" || reference.backend === "ci") {
    return `remove ${environmentVariableForRef(reference.ref)} from the process/CI secret configuration, then rerun vh auth revoke ${reference.provider}`;
  }
  if (reference.backend === "cli_session") {
    return `repair the official ${reference.provider} CLI session/logout command, then rerun vh auth revoke ${reference.provider}`;
  }
  return `remove ${reference.ref} from backend ${reference.backend}, then rerun vh auth revoke ${reference.provider}`;
}

function credentialKind(value: string | undefined, backend: string): CredentialKind {
  const selected = value ?? (backend === "cli_session" ? "cli_session" : "api_key");
  if (!credentialKinds.includes(selected as CredentialKind)) {
    throw new Error(
      `Unsupported credential kind ${selected}; choose ${credentialKinds.join(", ")}.`,
    );
  }
  return selected as CredentialKind;
}

export function createDefaultCliServices(options: DefaultCliServicesOptions = {}): CliServices {
  const root = resolve(options.rootDir ?? process.cwd());
  const store = options.store ?? new FileWorkflowStore({ rootDir: inside(root, ".venture/runs") });
  const now = options.now ?? (() => new Date());
  const providerLifecycleStore = new FileProviderLifecycleStore(
    inside(root, ".venture/provider-lifecycle.json"),
  );
  const requirements = options.dataRequirements ?? [];
  const catalogPath = resolve(
    options.credentialCatalogPath ??
      (options.rootDir
        ? inside(root, ".venture/credentials.json")
        : defaultCredentialCatalogPath()),
  );
  let credentialCatalog = loadCredentialCatalog(catalogPath);
  const commandRunner = options.providerCommandRunner ?? new NodeCommandRunner();
  const supportedBackends = new Set(["environment", "ci", "cli_session", "onepassword"]);
  const defaultBroker = new CredentialBroker([
    new EnvironmentCredentialBackend(),
    new EnvironmentCredentialBackend({ id: "ci" }),
    new CliSessionCredentialBackend(commandRunner),
    new OnePasswordCredentialBackend({ runner: commandRunner }),
    ...(process.platform === "darwin"
      ? [new MacOSKeychainCredentialBackend({ runner: commandRunner })]
      : []),
  ]);
  if (process.platform === "darwin") supportedBackends.add("macos_keychain");
  const credentialBroker = options.credentialBroker ?? defaultBroker;
  const catalogIssues: string[] = [];
  for (const reference of credentialCatalog.references) {
    if (!options.credentialBroker && !supportedBackends.has(reference.backend)) {
      catalogIssues.push(
        `${reference.ref} uses unavailable backend ${reference.backend}; configure that backend before testing it.`,
      );
      continue;
    }
    try {
      credentialBroker.register(reference);
    } catch (error) {
      catalogIssues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const httpFetcher =
    options.dataHttpFetcher ?? new NativeHttpFetcher({ redactor: credentialBroker.redactor });
  const learningRuntime = createDefaultLearningRuntime({
    rootDir: root,
    broker: credentialBroker,
    commandRunner: options.dataCommandRunner ?? commandRunner,
    httpFetcher,
    injectedConnectors: options.dataConnectors,
    injectedRequirements: requirements,
    now,
  });

  const productCommandRunner = options.productCommandRunner ?? commandRunner;
  const buildAgentHost =
    options.buildAgentHost ??
    new CodexCliBuildAgentHost({
      rootDir: root,
      runner: new NodeCommandRunner({ env: codexBuildAgentEnvironment(process.env) }),
      redactor: credentialBroker.redactor,
    });

  const defaultProviderRuntimeContext = createOfficialProviderContext({
    commandRunner,
    httpFetcher,
    credentials: credentialBroker,
    redactor: credentialBroker.redactor,
    idempotencyLedger: new FileProviderIdempotencyLedger(
      inside(root, ".venture/provider-idempotency.json"),
    ),
  });
  const effectiveProviderRegistry = options.providerRegistry ?? providerRegistry;
  const effectiveProviderContext: ProviderExecutionContext = options.providerContext ?? {
    ...defaultProviderRuntimeContext,
    authorization: "dry_run",
  };

  const launchContextFor = (launch: LaunchState): LaunchBindingContext => ({
    rootDir: root,
    brief: launch.brief,
    definition: launch.definition,
    authorization: launch.authorization,
  });

  const reportCredentialReferences = (launch: LaunchState) => {
    const activeProviders = new Set(providerIds(launch.definition));
    return credentialBroker
      .list()
      .filter((reference) => activeProviders.has(reference.provider as ProviderId))
      .map((reference) => ({
        ref: reference.ref,
        provider: reference.provider,
        status: "registered_not_retested",
        scopes: [...reference.scopes],
        expiresAt: reference.expiresAt,
        accountId: reference.accountId,
      }));
  };

  const qualityReportLines = (): { lines: string[]; limitations: string[] } => {
    const lines: string[] = [];
    const limitations: string[] = [];
    for (const profile of ["fast", "mvp", "release"] as const) {
      const path = inside(root, `.venture/reports/quality/${profile}-latest.json`);
      if (!existsSync(path)) continue;
      try {
        const report = JSON.parse(readFileSync(path, "utf8")) as {
          results?: Array<{
            id?: unknown;
            status?: unknown;
            detail?: unknown;
            gap?: {
              missing?: unknown;
              exact_command?: unknown;
              expected_evidence?: unknown;
            } | null;
          }>;
        };
        for (const result of report.results ?? []) {
          if (
            typeof result.id !== "string" ||
            !["PASS", "FAIL", "SKIP", "NOT_APPLICABLE"].includes(String(result.status))
          ) {
            throw new Error("result has an invalid id or status");
          }
          const detail = typeof result.detail === "string" ? `; ${result.detail}` : "";
          const gap = result.gap;
          const prerequisite =
            gap && typeof gap.missing === "string" && typeof gap.exact_command === "string"
              ? `; missing ${gap.missing}; run ${gap.exact_command}; evidence ${
                  typeof gap.expected_evidence === "string" ? gap.expected_evidence : "not recorded"
                }`
              : "";
          lines.push(`${profile}/${result.id}: ${String(result.status)}${detail}${prerequisite}`);
        }
      } catch (error) {
        limitations.push(
          `${profile} quality artifact could not be parsed; no check state was inferred (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
    return { lines, limitations };
  };

  const reportInputFor = (launch: LaunchState, state: WorkflowRunState) => {
    const decision = launch.decision;
    const loopsPath = inside(root, "config/loops.yaml");
    const loops = existsSync(loopsPath)
      ? loopsSchema.parse(readStructured(loopsPath))
      : createDefaultLoopsConfig();
    const configuredLoops = Object.entries(loops.loops).map(([id, loop]) => {
      const sources =
        loop.inputs.length > 0
          ? loop.inputs
              .map(
                (input) =>
                  `${input.source}:${input.freshness_hours}h:${input.required ? "required" : "optional"}`,
              )
              .join(", ")
          : "sources unconfigured";
      return `${id}: ${loop.enabled ? "enabled" : "disabled"}; ${loop.trigger.kind} ${
        loop.trigger.expression
      }; ${sources}; autonomy ${loop.autonomy}; destination ${loop.output_destination}`;
    });
    const nextReviews = Object.entries(loops.loops)
      .filter(([, loop]) => ["daily", "weekly", "biweekly", "monthly"].includes(loop.cadence))
      .map(([id, loop]) => `${id}: ${loop.next_run_at ?? "not scheduled"}`);
    const providerConfigPath = inside(root, "config/providers.yaml");
    const providerMetadata = existsSync(providerConfigPath)
      ? Object.fromEntries(
          Object.entries(providersSchema.parse(readStructured(providerConfigPath)).providers).map(
            ([provider, configured]) => [
              provider,
              {
                accountId: configured.account_id ?? undefined,
                teamId: configured.team_id ?? undefined,
                region: configured.region ?? undefined,
              },
            ],
          ),
        )
      : {};
    const cadencePath = inside(root, "reports/learning/operating-cadence.json");
    if (existsSync(cadencePath)) {
      const cadence = JSON.parse(readFileSync(cadencePath, "utf8")) as {
        activeHypotheses?: string[];
        activeExperiments?: string[];
        activeBlockers?: string[];
      };
      for (const hypothesis of cadence.activeHypotheses ?? []) {
        nextReviews.push(`active hypothesis: ${hypothesis}`);
      }
      for (const experiment of cadence.activeExperiments ?? []) {
        nextReviews.push(`active experiment: ${experiment}`);
      }
      for (const blocker of cadence.activeBlockers ?? []) {
        nextReviews.push(`active blocker: ${blocker}`);
      }
    }
    const quality = qualityReportLines();
    return createLaunchReportInputFromRun({
      generatedAt: now().toISOString(),
      state,
      brief: {
        id: launch.brief.id,
        name: launch.brief.name,
        synthetic: launch.brief.synthetic ?? false,
        scheduledLearning: launch.brief.needs.scheduled_learning,
      },
      launch: {
        mode: decision.mode.selectedMode,
        rail:
          decision.rail.mobileStack === "none"
            ? decision.rail.appKind
            : `${decision.rail.appKind}/${decision.rail.mobileStack}`,
        paymentProvider: decision.payment.provider,
        entitlementSource: decision.payment.entitlementSource,
        activeEventPacks: launch.activeEventPacks,
        consentMode: "strict",
      },
      authorization: {
        profile: launch.authorization.profile,
        approvalRef: launch.authorization.approval_ref,
        expiresAt: launch.authorization.expires_at,
        spendCeiling: launch.authorization.max_estimated_spend,
      },
      providerByNode: PROVIDER_BY_NODE,
      providerMetadata,
      credentialReferences: reportCredentialReferences(launch),
      limitations: launch.brief.synthetic
        ? [
            "Synthetic fixture: no live provider or market state is claimed.",
            ...quality.limitations,
          ]
        : quality.limitations,
      sections: {
        checksRun: quality.lines,
        scheduledLoops: configuredLoops,
        nextReviews,
      },
    });
  };

  const persistStateReport = async (
    launch: LaunchState,
    state: WorkflowRunState,
    runtimeContext: ProviderRuntimeContext,
  ) =>
    persistLaunchReport(
      renderLaunchReport(reportInputFor(launch, state), {
        redactor: runtimeContext.redactor,
      }),
      inside(root, `reports/launch/${state.runId}`),
    );

  const bindingsFor = async (
    launch: LaunchState,
  ): Promise<{ bindings: WorkflowBindings; runtimeContext: ProviderRuntimeContext }> => {
    const launchContext = launchContextFor(launch);
    const productBindings = options.launchBindings
      ? await options.launchBindings(launchContext)
      : (await assertBuildAgentHostAvailable(buildAgentHost),
        createLaunchProductBindings({
          rootDir: root,
          brief: launch.brief,
          agentHost: buildAgentHost,
          commandRunner: productCommandRunner,
          redactor: credentialBroker.redactor,
          now,
        }));
    const reservedProductHandlers = Object.keys(productBindings.handlers ?? {}).filter(
      (handler) => handler.startsWith("provider.") || handler === "launch.report",
    );
    if (reservedProductHandlers.length > 0) {
      throw new Error(
        `Product bindings attempted to replace reserved handlers: ${reservedProductHandlers.join(", ")}. Provider effects and launch reports must use the official runtime composition.`,
      );
    }
    const missingProductHandlers = productHandlerNames(launch.definition).filter(
      (handler) => !productBindings.handlers?.[handler],
    );
    if (missingProductHandlers.length > 0) {
      throw new Error(
        `Launch apply is missing product handler(s): ${missingProductHandlers.join(", ")}; no run or external action was created.`,
      );
    }

    const providerPlanFactories = options.providerPlanFactories
      ? typeof options.providerPlanFactories === "function"
        ? await options.providerPlanFactories(launchContext)
        : options.providerPlanFactories
      : createDefaultProviderPlanFactories({
          rootDir: root,
          brief: () => launch.brief,
          definition: launch.definition,
          lifecycleStore: providerLifecycleStore,
        });
    const missingProviderFactories = providerHandlerNames(launch.definition).filter(
      (handler) => !providerPlanFactories[handler],
    );
    if (missingProviderFactories.length > 0) {
      throw new Error(
        `Launch apply is missing authorized provider plan factory/factories: ${missingProviderFactories.join(", ")}; no run or external action was created.`,
      );
    }

    const providerRuntimeContext = options.providerRuntimeContext
      ? typeof options.providerRuntimeContext === "function"
        ? await options.providerRuntimeContext(launchContext)
        : options.providerRuntimeContext
      : options.providerContext
        ? {
            transports: options.providerContext.transports,
            credentials: options.providerContext.credentials,
            redactor: options.providerContext.redactor,
            idempotencyLedger: options.providerContext.idempotencyLedger,
          }
        : defaultProviderRuntimeContext;
    if (!providerRuntimeContext.idempotencyLedger) {
      throw new Error(
        "Launch apply requires a durable provider idempotency ledger; no run or external action was created.",
      );
    }
    const policies = policiesSchema.parse(readStructured(inside(root, "config/policies.yaml")));
    const providerBindings = createProviderWorkflowBindings({
      planFactories: providerPlanFactories,
      policies,
      authorization: launch.authorization,
      context: providerRuntimeContext,
      resolveAdapter: (provider) => effectiveProviderRegistry.get(provider),
      now,
      lifecycleStore: providerLifecycleStore,
      recordEvidence: ({ evidence, workflow }) => {
        const reference = `reports/launch/${workflow.runId}/providers/${workflow.node.id}.json`;
        const path = inside(root, reference);
        writeJsonAtomic(path, evidence);
        return reference;
      },
    });
    const reportDirectoryReference = `reports/launch/${launch.authorization.run_id}`;
    const reportBindings = createLaunchReportWorkflowBinding({
      redactor: providerRuntimeContext.redactor,
      outputDirectory: inside(root, reportDirectoryReference),
      artifactReferences: {
        json: `${reportDirectoryReference}/final.json`,
        markdown: `${reportDirectoryReference}/final.md`,
      },
      input: ({ runId }) => reportInputFor(launch, store.load(runId)),
    });
    const manualBindings = {
      ...createLaunchManualBindings(),
      interruptEvidenceVerifier: createRepositoryInterruptEvidenceVerifier({
        rootDir: root,
        redactor: providerRuntimeContext.redactor,
      }),
      checkpointEvidenceVerifier: createRepositoryCheckpointEvidenceVerifier({
        rootDir: root,
        redactor: providerRuntimeContext.redactor,
      }),
    } satisfies WorkflowBindings;
    return {
      bindings: mergeBindings(productBindings, providerBindings, reportBindings, manualBindings),
      runtimeContext: providerRuntimeContext,
    };
  };

  return {
    create(request) {
      const source = isAbsolute(request.brief) ? request.brief : resolve(root, request.brief);
      const brief = founderBriefSchema.parse(readStructured(source));
      const decision = routeLaunch(brief);
      const activeEventPacks = eventPacksFor(brief, decision);
      const existing = existsSync(projectPath(root)) ? loadProject(root) : null;
      if (existing && existing.brief.id !== brief.id) {
        throw new Error(
          `This working directory already contains venture ${existing.brief.id}; refusing to retain its run, provider, mobile, and learning state for different brief ${brief.id}. Next: create the new venture in a fresh child directory, or archive and remove .venture only after reviewing its external-resource evidence.`,
        );
      }
      const synchronizedAt = now();
      const updatedContracts = synchronizeBriefContracts(
        root,
        brief,
        decision,
        activeEventPacks,
        synchronizedAt,
      );
      const state: ProjectState = {
        schemaVersion: 2,
        createdAt: existing?.createdAt ?? synchronizedAt.toISOString(),
        brief,
        decision,
        activeEventPacks,
        routerVersion: LAUNCH_ROUTER_VERSION,
      };
      writeJsonAtomic(projectPath(root), state);
      return {
        status: "created",
        projectState: ".venture/project.json",
        updatedContracts,
        briefId: brief.id,
        synthetic: brief.synthetic ?? false,
        selectedMode: decision.mode.selectedMode,
        confidence: decision.mode.confidence,
        rail: decision.rail,
        activeEventPacks,
        assumptions: decision.mode.assumptions,
        nextAction: "Run vh plan, then vh launch --dry-run.",
      } as unknown as JsonValue;
    },
    plan(request) {
      const brief = request.brief
        ? founderBriefSchema.parse(
            readStructured(
              isAbsolute(request.brief) ? request.brief : resolve(root, request.brief),
            ),
          )
        : loadProject(root).brief;
      return compileLaunchDryRun(brief) as unknown as JsonValue;
    },
    async launch(request) {
      const project = loadProject(root);
      const brief = project.brief;
      const dryRun = compileLaunchDryRun(brief);
      if (request.mode === "dry-run") return dryRun as unknown as JsonValue;
      const runId = request.runId ?? generatedRunId(brief, now());
      if (store.exists(runId)) {
        throw new Error(`Run ${runId} already exists. Next: vh resume ${runId}`);
      }
      const policies = policiesSchema.parse(readStructured(inside(root, "config/policies.yaml")));
      const definition = scopeLaunchGraphForAuthorization(
        compileLaunchGraph(brief, project.decision),
        request.authorization!,
      );
      const authorization = issueAuthorizationEnvelope({
        runId,
        profile: request.authorization!,
        providers: providerIds(definition),
        environments: requiredEnvironmentsForLaunch(definition),
        capabilities: requiredCapabilitiesForLaunch(definition),
        policies,
        approvalRef: `cli:vh-launch:${request.authorization}`,
        now: now(),
      });
      const launch: LaunchState = {
        schemaVersion: 2,
        brief,
        decision: project.decision,
        activeEventPacks: project.activeEventPacks,
        routerVersion: project.routerVersion,
        definition,
        authorization,
      };
      const runtime = await bindingsFor(launch);
      writeJsonAtomic(launchPath(root, runId), launch);
      const state = await new WorkflowExecutor({ store, bindings: runtime.bindings }).start(
        definition,
        {
          runId,
        },
      );
      await persistStateReport(launch, state, runtime.runtimeContext);
      return state as unknown as JsonValue;
    },
    async resume(request) {
      let launch = loadLaunch(root, request.runId);
      if (request.authorization) {
        const requestedProfile = request.authorization.replaceAll("-", "_");
        if (requestedProfile !== launch.authorization.profile) {
          throw new Error(
            `Run ${request.runId} was created with ${launch.authorization.profile}; renewal must use the same named profile to preserve the persisted graph scope.`,
          );
        }
        const policies = policiesSchema.parse(readStructured(inside(root, "config/policies.yaml")));
        launch = {
          ...launch,
          authorization: issueAuthorizationEnvelope({
            runId: request.runId,
            profile: request.authorization,
            providers: providerIds(launch.definition),
            environments: requiredEnvironmentsForLaunch(launch.definition),
            capabilities: requiredCapabilitiesForLaunch(launch.definition),
            policies,
            approvalRef: `cli:vh-resume:${request.authorization}`,
            now: now(),
          }),
        };
        writeJsonAtomic(launchPath(root, request.runId), launch);
      } else if (Date.parse(launch.authorization.expires_at) <= now().getTime()) {
        const state = store.load(request.runId);
        const unfinishedProviderEffects = Object.values(state.nodes).some(
          (record) =>
            record.definition.kind === "provider" &&
            !["succeeded", "compensated", "skipped"].includes(record.state),
        );
        if (unfinishedProviderEffects) {
          throw new Error(
            `Authorization envelope for ${request.runId} expired at ${launch.authorization.expires_at}. Next: vh resume ${request.runId} --authorization ${launch.authorization.profile.replaceAll("_", "-")}.`,
          );
        }
      }
      const runtime = await bindingsFor(launch);
      const executor = new WorkflowExecutor({ store, bindings: runtime.bindings });
      if (request.nodeId) {
        const evidenceArtifact = artifactReferenceSchema.parse(request.evidenceArtifact);
        if (request.resolutionKind === "checkpoint_grant") {
          if (!request.effect || !request.operationId) {
            throw new Error("A checkpoint grant requires an exact effect and operation ID.");
          }
          const evidence = loadRepositoryCheckpointEvidence({
            rootDir: root,
            evidenceArtifact,
            runId: request.runId,
            redactor: runtime.runtimeContext.redactor,
          });
          await executor.grantAuthorizationCheckpoint(request.runId, request.nodeId, {
            effect: request.effect,
            operationId: request.operationId,
            evidenceArtifact,
            approvedBy: evidence.approved_by,
            approvedAt: evidence.approved_at,
            expiresAt: launch.authorization.expires_at,
          });
        } else {
          let output: JsonValue;
          if (request.outputFile) {
            output = readStructured(
              isAbsolute(request.outputFile)
                ? request.outputFile
                : resolve(root, request.outputFile),
            ) as JsonValue;
          } else if (request.resolutionKind === "manual") {
            const evidence = readStructured(inside(root, evidenceArtifact));
            if (
              !evidence ||
              typeof evidence !== "object" ||
              Array.isArray(evidence) ||
              !("output" in evidence)
            ) {
              throw new Error(
                `Manual evidence ${evidenceArtifact} must be typed JSON with an output field, or pass --output <json-file>.`,
              );
            }
            output = (evidence as { output: JsonValue }).output;
          } else {
            output = { approved: true };
          }
          noCredentialMaterial(output);
          const resolution = {
            approvedBy: "vh-cli-user",
            note: request.note ?? "Resolved explicitly through vh resume.",
            output,
            evidenceArtifact,
          };
          if (request.resolutionKind === "approval") {
            await executor.approve(request.runId, request.nodeId, resolution);
          } else {
            await executor.completeManualAction(request.runId, request.nodeId, resolution);
          }
        }
      }
      const state = await executor.resume(launch.definition, request.runId);
      await persistStateReport(launch, state, runtime.runtimeContext);
      return state;
    },
    async cancel(runId, reason) {
      const launch = loadLaunch(root, runId);
      const runtime = await bindingsFor(launch);
      const state = await new WorkflowExecutor({
        store,
        bindings: runtime.bindings,
      }).cancel(runId, reason, launch.definition);
      await persistStateReport(launch, state, runtime.runtimeContext);
      return state;
    },
    doctor: async () => {
      const project = existsSync(projectPath(root)) ? loadProject(root) : null;
      const definition = project ? compileLaunchGraph(project.brief) : null;
      const providerInspection = await inspectDefaultProviderDoctor({
        rootDir: root,
        broker: credentialBroker,
        context: effectiveProviderContext,
        runner: commandRunner,
        registry: effectiveProviderRegistry,
        lifecycleStore: providerLifecycleStore,
        launch:
          project && definition
            ? {
                brief: project.brief,
                definition,
                factories:
                  options.providerPlanFactories &&
                  typeof options.providerPlanFactories !== "function"
                    ? options.providerPlanFactories
                    : undefined,
              }
            : undefined,
      });
      return {
        node: process.version,
        platform: process.platform,
        projectSelected: project !== null,
        knownRuns: store.listRuns().length,
        ...providerInspection,
        providerChecksStatus:
          "executed locally; remote readiness is reported only for authenticated/read-back evidence",
        providerFactoryInspection:
          typeof options.providerPlanFactories === "function"
            ? "default factories inspected; the injected context-dependent factory is resolved only for an authorized run"
            : options.providerPlanFactories
              ? "injected static factories inspected"
              : "built-in complete-or-fail factories inspected",
        credentialCatalogIssues: catalogIssues,
      } as unknown as JsonValue;
    },
    async auth(request) {
      const { action, provider } = request;
      let references = credentialBroker
        .list()
        .filter((reference) => !provider || reference.provider === provider);
      if (action === "status") {
        return {
          references: await Promise.all(
            references.map((reference) => credentialBroker.inspect(reference.ref)),
          ),
          catalogIssues,
          valuesExposed: false,
        } as unknown as JsonValue;
      }
      if (action === "test") {
        const tested = await Promise.all(
          references.map(async (reference) => {
            const tester = options.credentialTesters?.[reference.provider];
            if (tester && reference.kind !== "cli_session") {
              return {
                ref: reference.ref,
                mode: "remote_tester",
                result: await credentialBroker.test(reference.ref, tester),
              };
            }
            return {
              ref: reference.ref,
              mode: reference.kind === "cli_session" ? "official_cli_read" : "availability_only",
              result: await credentialBroker.inspect(reference.ref),
              limitation:
                reference.kind === "cli_session"
                  ? null
                  : "No provider credential tester was injected; availability is not remote authorization proof.",
            };
          }),
        );
        const adapter = provider
          ? effectiveProviderRegistry.list().find((item) => item.descriptor.id === provider)
          : undefined;
        const providerDoctor = adapter
          ? await adapter.doctor(
              { credentialRefs: references.map((reference) => reference.ref) },
              effectiveProviderContext,
            )
          : null;
        credentialCatalog = {
          ...credentialCatalog,
          references: credentialCatalog.references.map(
            (catalogReference) =>
              credentialBroker.getReference(catalogReference.ref) ?? catalogReference,
          ),
        };
        saveCredentialCatalog(credentialCatalog, catalogPath);
        return { tested, providerDoctor, valuesExposed: false } as unknown as JsonValue;
      }
      if (action === "revoke") {
        if (!provider) throw new Error("vh auth revoke requires a provider.");
        if (references.length === 0)
          throw new Error(`No credential refs are registered for ${provider}.`);
        const revoked = await Promise.all(
          references.map(async (reference) => {
            const result = await credentialBroker.revoke(reference.ref);
            const localRemoval = result.removed ? "removed" : "failed";
            const catalogReference = result.removed ? "removed" : "preserved_disabled";
            const remoteAction = providerRevocationAction(reference);
            const nextAction = result.removed
              ? `${remoteAction}, then run vh auth status and confirm the reference is absent or revoked.`
              : `Local removal failed: ${localRemovalAction(reference)}. The catalog reference was preserved in a disabled state. Separately, ${remoteAction}, then run vh auth status.`;
            return {
              ...result,
              localRemoval,
              catalogReference,
              providerSideRevocation: "manual_required",
              nextAction,
            };
          }),
        );
        const removedRefs = revoked.filter(({ removed }) => removed).map(({ ref }) => ref);
        credentialCatalog = removeCredentialReferences(credentialCatalog, removedRefs);
        for (const result of revoked.filter(({ removed }) => !removed)) {
          const disabled = credentialBroker.getReference(result.ref);
          if (disabled) credentialCatalog = upsertCredentialReference(credentialCatalog, disabled);
        }
        saveCredentialCatalog(credentialCatalog, catalogPath);
        return { provider, revoked, valuesExposed: false } as unknown as JsonValue;
      }

      if (!provider) {
        return {
          status: "provider_required",
          interactiveCliProviders: Object.keys(
            // The exact commands remain in the credential module and are never shell strings.
            { github: true, vercel: true, stripe: true, eas: true },
          ),
          registeredProviders: [...new Set(credentialBroker.list().map((item) => item.provider))],
          nextAction:
            "Run vh auth login <provider>; add --backend/--kind when not using its official CLI.",
        };
      }
      const backend =
        request.backend ?? (supportsInteractiveCliAuth(provider) ? "cli_session" : "environment");
      if (!options.credentialBroker && !supportedBackends.has(backend)) {
        throw new Error(
          `Backend ${backend} is not available on this host. Choose: ${[...supportedBackends].sort().join(", ")}.`,
        );
      }
      const ref = request.ref ?? `cred://${provider}/default`;
      const reference = {
        ref,
        provider,
        kind: credentialKind(request.kind, backend),
        backend,
        scopes: request.scopes ?? [],
      };
      if (backend === "cli_session") {
        await (options.interactiveCliLogin ?? runInteractiveCliLogin)(provider);
      }
      credentialBroker.register(reference);
      credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
      saveCredentialCatalog(credentialCatalog, catalogPath);
      references = [reference];
      const inspection = await credentialBroker.inspect(ref);
      return {
        status: inspection.status === "available" ? "authenticated" : "registered",
        reference: inspection,
        valuesExposed: false,
        nextAction:
          inspection.status === "available"
            ? `Run vh auth test ${provider}.`
            : backend === "environment" || backend === "ci"
              ? `Set ${environmentVariableForRef(ref)} in the process or CI secret store, then run vh auth test ${provider}.`
              : `Store ${ref} in backend ${backend} without placing the value in Git or argv, then run vh auth test ${provider}.`,
      } as unknown as JsonValue;
    },
    async dataSync() {
      const result = await learningRuntime.sync();
      writeJsonAtomic(inside(root, ".venture/data/latest.json"), result);
      return result as unknown as JsonValue;
    },
    learn(cadence) {
      const latestPath = inside(root, ".venture/data/latest.json");
      const sync = existsSync(latestPath)
        ? JSON.parse(readFileSync(latestPath, "utf8"))
        : learningRuntime.missingArtifact(cadence);
      const { definition, report } = learningRuntime.learn(cadence, sync);
      const artifacts = persistLearningReport({ rootDir: root, definition, report });
      const operatingCadence = learningRuntime.operatingCadence(sync);
      const operatingCadenceArtifacts = persistOperatingCadence({
        rootDir: root,
        cadence: operatingCadence,
      });
      return {
        ...report,
        artifacts,
        operatingCadence,
        operatingCadenceArtifacts,
      } as unknown as JsonValue;
    },
    async upgrade({ dryRun, releasePath }) {
      const fileSystem = createNodeMigrationFileSystem(root);
      const lockPath = inside(root, "harness.lock");
      const lock = existsSync(lockPath) ? loadHarnessLock(lockPath) : undefined;
      const release = releasePath
        ? await locateLocalHarnessRelease({ locator: releasePath, baseDir: root })
        : options.release;
      if (!release && !lock) return migrateV01ToV02({ fileSystem, dryRun, clock: now });
      if (!release) {
        return {
          status: "already_current",
          harnessVersion: lock!.harness_version,
          source: lock!.source,
          nextAction:
            "Choose and review a local release checkout, then run vh upgrade --release <local-release-root> --dry-run.",
        };
      }
      return (await applyOperationalUpgrade({
        fileSystem,
        currentLock: lock,
        release,
        commandRunner: options.upgradeCommandRunner ?? commandRunner,
        rootDir: root,
        dryRun,
        clock: now,
      })) as unknown as JsonValue;
    },
  };
}
