import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";
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
import {
  providersSchema,
  type ProviderState,
  type ProvidersConfig,
} from "../config/provider-schema";
import { ventureSchema } from "../config/venture-schema";
import { analyticsSchema, offerSchema } from "../config/schemas";
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
  FileFounderStackStore,
  CodexCliIdeaSharpenerHost,
  IdeaSharpenError,
  compileFounderIdea,
  compileFounderLaunchPreparation,
  defaultFounderStackStateRoot,
  doctorFounderStackConnection,
  founderStackRoleDefinitions,
  founderBriefFromLaunchContract,
  founderSeedFor,
  decimalPriceToMinorUnits,
  loadFounderStackConnectionFile,
  loadFounderIdeaFile,
  materializeFounderVenture,
  registerFounderStackWritableCredentialRefs,
  renderFounderIdea,
  renderFounderStackProviderConfigOverrides,
  renderLaunchContractYaml,
  renderProductConstitution,
  launchContractSchema,
  launchContractDigest,
  launchDecisionFromContract,
  resolveFounderWorkflowRefSha,
  resolveFounderWorkflowRepository,
  sharpenIdea,
  founderStackCliSessionCredentialRegistrations,
  parseFounderStackConnection,
  ideaSharpenerEnvironment,
  type FounderLaunchPreparation,
  type FounderLaunchGap,
  type FounderStackConnection,
  type FounderStackRole,
  type IdeaSharpenerHost,
  type LaunchContract,
} from "../founder-launch";
import {
  VENTURES_ROOT_UNSET_MESSAGE,
  configuredVenturesRoot,
  resolveVentureOutputWithinRoot,
} from "../founder-launch/founder-config";
import {
  compileLaunchDryRun,
  compileLaunchGraph,
  createLaunchManualBindings,
  createRepositoryInterruptEvidenceVerifier,
  founderBriefSchema,
  launchBuildAgentHandlers,
  launchBuildAgentTaskCount,
  launchProviderByNode,
  launchProviderNodeOperationCeiling,
  launchOptionalProviderNodeIds,
  launchProviderOperationCeiling,
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
  assertLaunchGrantActive,
  compileVentureMaterialization,
  parseLaunchGrant,
  type LaunchEffect,
  type LaunchGrant,
  type VentureMaterializationPlan,
} from "../materialization";
import {
  providerRegistry,
  publicIdentifier,
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
  createLaunchReceipt,
  createLaunchReportInputFromRun,
  createLaunchReportWorkflowBinding,
  createOfficialProviderContext,
  createProviderWorkflowBindings,
  FileProviderIdempotencyLedger,
  FileProviderLifecycleStore,
  NativeHttpFetcher,
  loadRepositoryCheckpointEvidence,
  persistLaunchReport,
  persistLaunchReceipt,
  productCommandEnvironment,
  renderLaunchReport,
  sameRunLaunchReceiptVerification,
  type BuildAgentHost,
  type ProviderRuntimeContext,
  type ProviderWorkflowPlanRequest,
  type ProviderWorkflowPlanFactory,
} from "../runtime";
import {
  applyOperationalUpgrade,
  locateLocalHarnessRelease,
  type HarnessRelease,
} from "../upgrade";
import { OwnerPathLock } from "../security/owner-path-lock";
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
import type { CliServices, CliStackRequest } from "./types";
import { createDefaultFounderCredentialTesters } from "./default-credential-testers";
import {
  createDefaultProviderPlanFactories,
  inspectDefaultProviderDoctor,
  loadDefaultProviderConfig,
  type DefaultProviderConfigSnapshot,
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
  launchContract?: LaunchContract;
  launchContractDigest?: string;
}

interface LaunchState {
  schemaVersion: 2;
  brief: FounderBrief;
  decision: LaunchDecision;
  activeEventPacks: EventPackId[];
  routerVersion: typeof LAUNCH_ROUTER_VERSION;
  definition: WorkflowDefinition;
  authorization: AuthorizationEnvelope;
  launchGrant?: LaunchGrant;
  launchContract?: LaunchContract;
  launchContractDigest?: string;
  founderLaunchGaps?: readonly FounderLaunchGap[];
}

interface FounderLaunchTransaction {
  schemaVersion: 1;
  status: "launch_pending" | "waiting_external_action" | "succeeded" | "failed";
  sourceHash: string;
  stackProfile: "founder-default";
  stackConnectionHash: string;
  grantId: string;
  runId: string;
  planDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchBindingContext {
  rootDir: string;
  brief: FounderBrief;
  definition: WorkflowDefinition;
  authorization: AuthorizationEnvelope;
  /** Canonical founder decisions captured before any model task or provider factory runs. */
  launchContract?: LaunchContract;
}

export interface DefaultCliServicesOptions {
  rootDir?: string;
  /** Shared user state by default; project-local when rootDir is explicitly injected. */
  founderStackRoot?: string;
  /** Optional isolated base for materialized founder ventures; defaults to the CLI working root. */
  founderOutputRoot?: string;
  /** Immutable workflow revision used by newly materialized child repositories. */
  founderWorkflowRefSha?: string;
  /** owner/repository of this Core checkout; defaults to its own git origin. */
  founderWorkflowRepository?: string;
  /** Explicit fixture-only override for the canonical Golden Path. Never enable in production hosts. */
  allowFixtureFounderStack?: boolean;
  store?: WorkflowStore;
  /** Product/local/model handlers only. Provider and launch.report handlers are reserved. */
  launchBindings?: (context: LaunchBindingContext) => Promise<WorkflowBindings> | WorkflowBindings;
  /** Agent-neutral host used by the default product handlers when launchBindings is not injected. */
  buildAgentHost?: BuildAgentHost;
  /** Bounded no-provider host for `vh idea sharpen`; injectable for deterministic tests. */
  ideaSharpenerHost?: IdeaSharpenerHost;
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
  /** Hard bound for each Stack/auth read-only credential test. */
  credentialTestTimeoutMs?: number;
  interactiveCliLogin?: (provider: string) => Promise<void>;
  providerRegistry?: ProviderRegistry;
  providerContext?: ProviderExecutionContext;
  dataConnectors?: DataConnector[];
  dataRequirements?: DataSourceRequirement[];
  release?: HarnessRelease;
  now?: () => Date;
  /** Deterministic local race-injection hook used only by security regressions. */
  pathSecurityHook?: (event: string, path: string) => void;
}

const PROVIDER_BY_NODE: Readonly<Record<string, ProviderId>> = launchProviderByNode;

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
    reconcilers: Object.assign({}, ...bindings.map((binding) => binding.reconcilers ?? {})),
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
  return [
    ...new Set(
      definition.nodes
        .filter(
          (node) => node.handler && node.kind !== "provider" && node.handler !== "launch.report",
        )
        .map((node) => node.handler!),
    ),
  ].sort();
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

function safeIdeaOutputPath(root: string, requested: string, boundary: OwnerPathLock): string {
  if (!requested || isAbsolute(requested) || !requested.toLowerCase().endsWith(".md")) {
    throw new Error("vh idea sharpen --output must be a project-relative Markdown path");
  }
  const canonicalRoot = realpathSync(root);
  const lexicalTarget = resolve(canonicalRoot, requested);
  const child = relative(canonicalRoot, lexicalTarget);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("vh idea sharpen --output escapes the working directory");
  }
  const lexicalParent = dirname(lexicalTarget);
  const parentRelative = relative(canonicalRoot, lexicalParent);
  if (parentRelative) {
    resolveVentureOutputWithinRoot(canonicalRoot, parentRelative);
  }
  const parentIdentity = boundary.ensureDirectory(
    lexicalParent,
    "vh idea sharpen output directory",
  );
  const canonicalParent = realpathSync(lexicalParent);
  const parentChild = relative(canonicalRoot, canonicalParent);
  if (parentChild === ".." || parentChild.startsWith(`..${sep}`) || isAbsolute(parentChild)) {
    throw new Error("vh idea sharpen --output resolves through a directory outside the workspace");
  }
  const target = resolve(canonicalParent, lexicalTarget.slice(dirname(lexicalTarget).length + 1));
  if (existsSync(target)) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("vh idea sharpen --output must be a regular non-symlink Markdown file");
    }
  }
  if (lexicalTarget !== target) {
    throw new Error("vh idea sharpen --output resolves through an unexpected path");
  }
  boundary.assertDirectory(canonicalParent, parentIdentity, "vh idea sharpen output directory");
  return target;
}

function readStructured(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : parse(text);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function founderLaunchTransactionPath(root: string): string {
  return inside(root, ".venture/founder-launch.json");
}

function founderLaunchGrantRenewalPath(root: string, authorizationDigest: string): string {
  return inside(root, `.venture/launch-grant-renewals/${authorizationDigest}.json`);
}

function parseFounderLaunchTransaction(value: unknown): FounderLaunchTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Founder launch transaction is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "createdAt",
    "grantId",
    "planDigest",
    "runId",
    "schemaVersion",
    "sourceHash",
    "stackConnectionHash",
    "stackProfile",
    "status",
    "updatedAt",
  ];
  if (!isDeepStrictEqual(Object.keys(record).sort(), expectedKeys)) {
    throw new Error("Founder launch transaction has unknown or missing fields");
  }
  if (
    record.schemaVersion !== 1 ||
    !["launch_pending", "waiting_external_action", "succeeded", "failed"].includes(
      String(record.status),
    ) ||
    record.stackProfile !== "founder-default" ||
    typeof record.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.sourceHash) ||
    typeof record.stackConnectionHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.stackConnectionHash) ||
    typeof record.grantId !== "string" ||
    !/^lg_[a-f0-9]{26}$/u.test(record.grantId) ||
    typeof record.runId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{5,100}$/u.test(record.runId) ||
    typeof record.planDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.planDigest) ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    Number.isNaN(Date.parse(record.updatedAt)) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    throw new Error("Founder launch transaction is invalid");
  }
  return record as unknown as FounderLaunchTransaction;
}

function loadFounderLaunchTransaction(root: string): FounderLaunchTransaction {
  const path = founderLaunchTransactionPath(root);
  if (!existsSync(path)) {
    throw new Error(
      "Existing founder venture has no durable launch transaction; choose a new --output or inspect it manually before any retry.",
    );
  }
  return parseFounderLaunchTransaction(readStructured(path));
}

function saveFounderLaunchTransaction(root: string, transaction: FounderLaunchTransaction): void {
  writeJsonAtomic(founderLaunchTransactionPath(root), parseFounderLaunchTransaction(transaction));
}

function validateFounderLaunchContinuation(input: {
  childRoot: string;
  preparation: FounderLaunchPreparation;
  stackConnectionHash: string;
  workflowRefSha: string;
  workflowRepository: string;
}): {
  transaction: FounderLaunchTransaction;
  grant: LaunchGrant;
  plan: VentureMaterializationPlan;
} {
  const transaction = loadFounderLaunchTransaction(input.childRoot);
  const grantPath = inside(input.childRoot, ".venture/launch-grant.json");
  const founderInputPath = inside(input.childRoot, ".venture/founder-input.json");
  if (!existsSync(grantPath) || !existsSync(founderInputPath)) {
    throw new Error(
      "Existing founder venture is missing its immutable input or Launch Grant; no continuation was attempted.",
    );
  }
  const grant = parseLaunchGrant(readStructured(grantPath));
  const founderInputValue = readStructured(founderInputPath);
  if (
    !founderInputValue ||
    typeof founderInputValue !== "object" ||
    Array.isArray(founderInputValue)
  ) {
    throw new Error("Existing founder venture input binding is invalid");
  }
  const founderInput = founderInputValue as Record<string, unknown>;
  const expectedFounderInputKeys = [
    "assumptions",
    "briefArtifact",
    "compiledAt",
    "schemaVersion",
    "sourceHash",
    "stackProfile",
  ];
  if (
    !isDeepStrictEqual(Object.keys(founderInput).sort(), expectedFounderInputKeys) ||
    founderInput.schemaVersion !== 1 ||
    founderInput.briefArtifact !== ".venture/input/founder-brief.yaml" ||
    founderInput.compiledAt !== grant.createdAt ||
    !isDeepStrictEqual(founderInput.assumptions, input.preparation.idea.assumptionsAdded)
  ) {
    throw new Error("Existing founder venture input binding is invalid");
  }
  const persistedBrief = founderBriefSchema.parse(
    readStructured(inside(input.childRoot, String(founderInput.briefArtifact))),
  );
  const persistedProject = loadProject(input.childRoot);
  const expectedRunId = `launch-${grant.ventureSlug}-${grant.grantId.slice(3, 15)}`;
  if (
    transaction.sourceHash !== input.preparation.idea.sourceHash ||
    transaction.stackConnectionHash !== input.stackConnectionHash ||
    transaction.stackProfile !== input.preparation.stackProfile ||
    transaction.grantId !== grant.grantId ||
    transaction.runId !== expectedRunId ||
    transaction.createdAt !== grant.createdAt ||
    founderInput.sourceHash !== transaction.sourceHash ||
    founderInput.stackProfile !== transaction.stackProfile ||
    grant.ideaDigest !==
      (input.preparation.idea.launchContract
        ? launchContractDigest(input.preparation.idea.launchContract)
        : input.preparation.idea.sourceHash) ||
    grant.ventureSlug !== input.preparation.idea.brief.id ||
    grant.ventureName !== input.preparation.idea.brief.name ||
    grant.repository.owner !== input.preparation.repository.owner ||
    grant.repository.name !== input.preparation.repository.name ||
    grant.repository.visibility !== input.preparation.repository.visibility ||
    !isDeepStrictEqual(persistedBrief, input.preparation.idea.brief) ||
    !isDeepStrictEqual(persistedProject.brief, input.preparation.idea.brief)
  ) {
    throw new Error(
      "Existing founder venture does not match the current idea, Stack connection, repository, or immutable Launch Grant; no continuation was attempted.",
    );
  }
  const plan = compileVentureMaterialization({
    grant,
    at: new Date(grant.createdAt),
    coreVersion: "0.2.0",
    workflowRefSha: input.workflowRefSha,
    workflowRepository: input.workflowRepository,
    effects: [],
  });
  if (plan.planDigest !== transaction.planDigest) {
    throw new Error(
      "Existing founder venture transaction does not match its immutable materialization plan; no continuation was attempted.",
    );
  }
  return { transaction, grant, plan };
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

const CANONICAL_LAUNCH_CONTRACT_PATH = "config/launch-contract.yaml" as const;
const CANONICAL_PRODUCT_CONSTITUTION_PATH = "docs/product/PRODUCT_CONSTITUTION.md" as const;
const CANONICAL_FOUNDER_IDEA_PATH = "docs/product/idea.md" as const;
const NO_FOLLOW_FILE_FLAG = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

interface BoundFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
}

function boundFileIdentity(metadata: Stats): BoundFileIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedAtMs: metadata.mtimeMs,
    changedAtMs: metadata.ctimeMs,
  };
}

function sameBoundFile(metadata: Stats, expected: BoundFileIdentity): boolean {
  return (
    metadata.dev === expected.device &&
    metadata.ino === expected.inode &&
    metadata.size === expected.size &&
    metadata.mtimeMs === expected.modifiedAtMs &&
    metadata.ctimeMs === expected.changedAtMs
  );
}

function readRegularBoundFile(root: string, reference: string, label: string): string {
  const canonicalRoot = realpathSync(root);
  const target = inside(canonicalRoot, reference);
  const relation = relative(canonicalRoot, target);
  let cursor = canonicalRoot;
  for (const component of relation.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    if (cursor === target) {
      let descriptor: number;
      try {
        descriptor = openSync(cursor, constants.O_RDONLY | NO_FOLLOW_FILE_FLAG);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`${label} is missing at ${reference}`);
        if (code === "ELOOP") {
          throw new Error(`${label} must not resolve through a symbolic link: ${reference}`);
        }
        throw error;
      }
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile()) throw new Error(`${label} must be a regular file: ${reference}`);
        const initial = boundFileIdentity(opened);
        const canonical = realpathSync(cursor);
        const pathMetadata = lstatSync(cursor);
        if (canonical !== cursor || pathMetadata.isSymbolicLink()) {
          throw new Error(`${label} must not resolve through a symbolic link: ${reference}`);
        }
        if (!sameBoundFile(pathMetadata, initial)) {
          throw new Error(`${label} changed while it was being opened: ${reference}`);
        }
        const content = readFileSync(descriptor, "utf8");
        if (!sameBoundFile(fstatSync(descriptor), initial)) {
          throw new Error(`${label} changed while it was being read: ${reference}`);
        }
        const after = lstatSync(cursor);
        if (
          realpathSync(cursor) !== cursor ||
          after.isSymbolicLink() ||
          !sameBoundFile(after, initial)
        ) {
          throw new Error(`${label} changed while it was being read: ${reference}`);
        }
        return content;
      } finally {
        closeSync(descriptor);
      }
    }
    if (!existsSync(cursor)) throw new Error(`${label} is missing at ${reference}`);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not resolve through a symbolic link: ${reference}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${label} has a non-directory path component: ${reference}`);
    }
  }
  throw new Error(`${label} is missing at ${reference}`);
}

function persistCanonicalLaunchContract(root: string, contract: LaunchContract): string[] {
  writeTextAtomic(inside(root, CANONICAL_LAUNCH_CONTRACT_PATH), renderLaunchContractYaml(contract));
  writeTextAtomic(
    inside(root, CANONICAL_PRODUCT_CONSTITUTION_PATH),
    renderProductConstitution(contract),
  );
  writeTextAtomic(inside(root, CANONICAL_FOUNDER_IDEA_PATH), renderFounderIdea(contract));
  return [
    CANONICAL_LAUNCH_CONTRACT_PATH,
    CANONICAL_PRODUCT_CONSTITUTION_PATH,
    CANONICAL_FOUNDER_IDEA_PATH,
  ];
}

function assertCanonicalLaunchContractBinding(
  root: string,
  embedded: LaunchContract,
  storedDigest: string | undefined,
): string {
  const expectedDigest = launchContractDigest(embedded);
  if (storedDigest !== expectedDigest) {
    throw new Error(
      "Persisted Launch Contract digest does not match the embedded project or launch contract",
    );
  }
  const diskContract = launchContractSchema.parse(
    parse(readRegularBoundFile(root, CANONICAL_LAUNCH_CONTRACT_PATH, "Canonical Launch Contract")),
  );
  if (
    launchContractDigest(diskContract) !== expectedDigest ||
    !isDeepStrictEqual(diskContract, embedded)
  ) {
    throw new Error("Canonical on-disk Launch Contract does not match persisted launch state");
  }
  const constitution = readRegularBoundFile(
    root,
    CANONICAL_PRODUCT_CONSTITUTION_PATH,
    "Product Constitution",
  );
  if (constitution !== renderProductConstitution(embedded)) {
    throw new Error("Product Constitution does not match the canonical Launch Contract");
  }
  const idea = compileFounderIdea(
    readRegularBoundFile(root, CANONICAL_FOUNDER_IDEA_PATH, "Canonical founder idea"),
  );
  if (!idea.launchContract || !isDeepStrictEqual(idea.launchContract, embedded)) {
    throw new Error("Canonical founder idea does not contain the persisted Launch Contract");
  }
  const manifestPath = inside(root, "venture.manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(
      readRegularBoundFile(root, "venture.manifest.json", "Venture Manifest"),
    ) as Record<string, unknown>;
    if (
      manifest.launchContractPath !== CANONICAL_LAUNCH_CONTRACT_PATH ||
      manifest.launchContractDigest !== expectedDigest
    ) {
      throw new Error("Venture Manifest does not bind the canonical Launch Contract digest");
    }
  }
  return expectedDigest;
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
  const launchContract =
    value.schemaVersion === 2 && value.launchContract
      ? launchContractSchema.parse(value.launchContract)
      : undefined;
  const contractDigest = launchContract
    ? assertCanonicalLaunchContractBinding(
        root,
        launchContract,
        value.schemaVersion === 2 ? value.launchContractDigest : undefined,
      )
    : undefined;
  if (launchContract && !isDeepStrictEqual(brief, founderBriefFromLaunchContract(launchContract))) {
    throw new Error("Project Launch Contract does not match its selected founder brief");
  }
  const canonicalDecision = launchContract
    ? launchDecisionFromContract(launchContract)
    : routeLaunch(brief);
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
  return {
    ...value,
    brief,
    decision: value.decision,
    activeEventPacks: canonicalPacks,
    ...(launchContract ? { launchContract } : {}),
    ...(contractDigest ? { launchContractDigest: contractDigest } : {}),
  };
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
  const launchGrant =
    "launchGrant" in value && value.launchGrant ? parseLaunchGrant(value.launchGrant) : undefined;
  validateWorkflow(value.definition);
  const launchContract =
    value.schemaVersion === 2 && value.launchContract
      ? launchContractSchema.parse(value.launchContract)
      : undefined;
  const contractDigest = launchContract
    ? assertCanonicalLaunchContractBinding(
        root,
        launchContract,
        value.schemaVersion === 2 ? value.launchContractDigest : undefined,
      )
    : undefined;
  if (launchContract && !isDeepStrictEqual(brief, founderBriefFromLaunchContract(launchContract))) {
    throw new Error(`Launch ${runId} Launch Contract does not match its selected founder brief`);
  }
  const canonicalDecision = launchContract
    ? launchDecisionFromContract(launchContract)
    : routeLaunch(brief);
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
      launchGrant,
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
  return {
    ...value,
    brief,
    authorization,
    launchGrant,
    activeEventPacks: canonicalPacks,
    ...(launchContract ? { launchContract } : {}),
    ...(contractDigest ? { launchContractDigest: contractDigest } : {}),
  };
}

function providerIds(definition: WorkflowDefinition): ProviderId[] {
  return [
    ...new Set(
      definition.nodes.flatMap((node) =>
        node.kind === "provider" && PROVIDER_BY_NODE[node.id] ? [PROVIDER_BY_NODE[node.id]] : [],
      ),
    ),
  ];
}

function requiredLaunchGrantEffects(
  brief: FounderBrief,
  paymentProvider: LaunchDecision["payment"]["provider"],
  definition: WorkflowDefinition,
): LaunchEffect[] {
  const effects = new Set<LaunchEffect>([
    "repository.create",
    "company_stack.provision",
    "source.push",
    "preview.deploy",
    "production.deploy",
  ]);
  if (brief.domain && definition.metadata?.initialOrigin !== "provider_url") {
    effects.add("domain.configure");
  }
  if (paymentProvider !== "none") effects.add("commerce.configure");
  if (brief.needs.scheduled_learning) effects.add("loops.schedule");
  return [...effects];
}

const FOUNDER_REVIEWED_ZERO_DIRECT_CHARGE_OPERATIONS = [
  ["github", "repository", "repository.create_from_source"],
  ["github", "actions_secret", "actions_secret.set"],
  ["github", "repository_settings", "repository.settings.update"],
  ["github", "draft_pull_request", "pull_request.create_draft"],
  ["vercel", "project", "project.create"],
  ["vercel", "project", "project.link"],
  ["vercel", "environment_variable", "environment_variable.set"],
  ["vercel", "deployment", "deployment.preview"],
  ["vercel", "deployment", "deployment.production"],
  ["vercel", "domain", "domain.add"],
  ["vercel", "web_analytics", "web_analytics.enable_manual"],
  ["neon", "project", "project.create"],
  ["neon", "branch", "branch.create"],
  ["neon", "database", "database.create"],
  ["neon", "role", "role.create"],
  ["neon", "schema_migration", "schema.migrate"],
  ["neon", "read_write_health_check", "database.read_write_health_check"],
  ["stripe", "product", "product.create"],
  ["stripe", "price", "price.create"],
  ["stripe", "webhook", "webhook_endpoint.create"],
  ["stripe", "billing_portal", "billing_portal.configuration.create"],
  ["revenuecat", "project_bootstrap", "project.bootstrap_manual"],
  ["revenuecat", "app", "app.create"],
  ["revenuecat", "entitlement", "entitlement.create"],
  ["revenuecat", "offering", "offering.create"],
  ["revenuecat", "webhook", "webhook.create"],
  ["brevo", "sending_domain", "sending_domain.create"],
  ["brevo", "sending_domain_verification", "sending_domain.authenticate"],
  ["brevo", "sender", "sender.create"],
  ["brevo", "template", "template.create"],
  ["brevo", "webhook", "webhook.create"],
  ["google", "analytics_property", "analytics_property.create"],
  ["google", "analytics_web_stream", "analytics_web_stream.create"],
  ["google", "site_verification_token", "site_verification.token.get"],
  ["google", "site_verification", "site_verification.web_resource.insert"],
  ["google", "search_console_site", "search_console.site.add"],
  ["google", "search_console_sitemap", "search_console.sitemap.submit"],
  ["bing", "site", "site.add"],
  ["bing", "sitemap", "feed.add"],
  ["bing", "url_submission", "url.submit"],
  ["dns", "record", "dns_record.change_manual"],
] as const satisfies readonly (readonly [ProviderId, string, string])[];

function configuredProviderDestination(
  providers: ProvidersConfig,
  provider: ProviderId,
  capability: string,
): string | null {
  const state = providers.providers[provider];
  if (!state) return null;
  if (provider === "github" || provider === "vercel") {
    return state.team_id ?? state.account_id;
  }
  if (provider === "neon" || provider === "revenuecat") {
    return state.external_resource_ids.organization_id ?? state.account_id;
  }
  if (provider === "google") {
    return capability.startsWith("analytics_")
      ? (state.external_resource_ids.analytics_account_id ?? state.account_id)
      : state.account_id;
  }
  if (provider === "dns") {
    return (
      state.external_resource_ids.registrar_account_id ??
      state.external_resource_ids.organization_id ??
      state.account_id
    );
  }
  return state.account_id ?? state.team_id;
}

function requiredGrantDestinations(
  definition: WorkflowDefinition,
  providers: ProvidersConfig,
): Array<{ provider: ProviderId; capability: string; externalAccountId: string }> {
  const destinations = new Map<
    string,
    { provider: ProviderId; capability: string; externalAccountId: string }
  >();
  for (const node of definition.nodes.filter(
    ({ id, kind }) => kind === "provider" || (kind === "manual_action" && id === "dns-records"),
  )) {
    const provider = PROVIDER_BY_NODE[node.id];
    if (!provider) {
      throw new Error(`Launch Grant cannot bind unknown provider node ${node.id}`);
    }
    for (const capability of node.authorization.scopes) {
      const externalAccountId = configuredProviderDestination(providers, provider, capability);
      if (!externalAccountId) {
        if (launchOptionalProviderNodeIds.has(node.id)) continue;
        throw new Error(
          `Launch Grant cannot bind ${provider}/${capability} without an exact configured account, team, organization, or registrar destination`,
        );
      }
      const key = `${provider}\u0000${capability}\u0000${externalAccountId}`;
      destinations.set(key, { provider, capability, externalAccountId });
    }
  }
  return [...destinations.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.capability.localeCompare(right.capability) ||
      left.externalAccountId.localeCompare(right.externalAccountId),
  );
}

function providerDestinationKey(input: {
  provider: string;
  capability: string;
  externalAccountId: string;
}): string {
  return `${input.provider}\u0000${input.capability}\u0000${input.externalAccountId}`;
}

function assertLaunchGrantBindsGraph(input: {
  grant: LaunchGrant;
  brief: FounderBrief;
  decision: LaunchDecision;
  launchContract?: LaunchContract;
  definition: WorkflowDefinition;
  providers: ProvidersConfig;
  at: Date;
  allowExpiredRenewal?: boolean;
}): LaunchGrant {
  const grant = parseLaunchGrant(input.grant);
  if (input.allowExpiredRenewal) {
    if (grant.revokedAt) throw new Error("Launch Grant is revoked");
    if (input.at < new Date(grant.createdAt)) throw new Error("Launch Grant is not active yet");
  } else {
    assertLaunchGrantActive(grant, input.at);
  }
  if (grant.ventureSlug !== input.brief.id || grant.ventureName !== input.brief.name) {
    throw new Error("Launch Grant venture identity does not match the selected founder brief");
  }
  if (input.launchContract && grant.ideaDigest !== launchContractDigest(input.launchContract)) {
    throw new Error("Launch Grant idea digest does not match the canonical Launch Contract");
  }
  const expectedSeed = founderSeedFor(input.brief, input.launchContract ?? null);
  if (grant.seed.id !== expectedSeed || grant.seed.version !== "0.2.0") {
    throw new Error("Launch Grant seed does not match the selected product rail");
  }
  if (grant.stackProfile.id !== "founder-default" || grant.stackProfile.version !== "0.2.0") {
    throw new Error("Launch Grant does not bind the exact founder-default@0.2.0 Stack Profile");
  }
  const github = input.providers.providers.github;
  const repositoryOwner = github?.team_id ?? github?.account_id;
  const configuredRepository = github?.external_resource_ids.repository;
  if (
    !repositoryOwner ||
    configuredRepository !== `${grant.repository.owner}/${grant.repository.name}` ||
    grant.repository.owner !== repositoryOwner ||
    grant.repository.name !== input.brief.id ||
    grant.repository.visibility !== (input.brief.repository_visibility ?? "private")
  ) {
    throw new Error(
      "Launch Grant repository owner, name, or visibility does not match the exact configured GitHub destination",
    );
  }
  const requiredDestinations = requiredGrantDestinations(input.definition, input.providers);
  const grantedDestinationKeys = grant.providerAccounts.map(providerDestinationKey);
  if (new Set(grantedDestinationKeys).size !== grantedDestinationKeys.length) {
    throw new Error("Launch Grant contains duplicate provider destination bindings");
  }
  const requiredDestinationKeys = new Set(requiredDestinations.map(providerDestinationKey));
  const grantedDestinationSet = new Set(grantedDestinationKeys);
  const missingDestinations = requiredDestinations.filter(
    (destination) => !grantedDestinationSet.has(providerDestinationKey(destination)),
  );
  const extraDestinations = grant.providerAccounts.filter(
    (destination) => !requiredDestinationKeys.has(providerDestinationKey(destination)),
  );
  if (missingDestinations.length > 0 || extraDestinations.length > 0) {
    throw new Error(
      "Launch Grant provider/capability/account destinations do not exactly match the compiled graph and current Founder Stack configuration",
    );
  }
  const requiredEffects = requiredLaunchGrantEffects(
    input.brief,
    input.decision.payment.provider,
    input.definition,
  ).sort();
  const grantedEffects = [...grant.allowedExternalEffects].sort();
  if (!isDeepStrictEqual(requiredEffects, grantedEffects)) {
    throw new Error("Launch Grant external effects do not exactly match the compiled launch");
  }
  const operationCeiling = launchProviderOperationCeiling(input.definition);
  const minimumModelInvocations = launchBuildAgentTaskCount(input.definition);
  if (!grant.modelExecutionPolicy) {
    throw new Error(
      "Canonical founder Launch Grant is missing its explicit model execution policy",
    );
  }
  if (grant.modelExecutionPolicy.maxBuildAgentTasks !== minimumModelInvocations) {
    throw new Error(
      `Launch Grant build-agent task bound ${grant.modelExecutionPolicy.maxBuildAgentTasks} does not match the ${minimumModelInvocations} compiled tasks`,
    );
  }
  if (!grant.providerOperationBudget) {
    throw new Error("Canonical founder Launch Grant is missing its provider-operation budget");
  }
  if (grant.providerOperationBudget.maxOperations !== operationCeiling) {
    throw new Error(
      `Launch Grant provider-operation ceiling ${grant.providerOperationBudget.maxOperations} does not match the compiled ceiling ${operationCeiling}`,
    );
  }
  if (input.brief.currency && grant.providerOperationBudget.currency !== input.brief.currency) {
    throw new Error("Launch Grant budget currencies do not match the founder brief");
  }
  if (grant.autonomyProfile !== "owner_live_launch") {
    throw new Error("Launch Grant does not authorize the owner live-launch autonomy profile");
  }
  if (!grant.permissions.productionDeployment) {
    throw new Error("Launch Grant does not authorize a production deployment");
  }
  if (
    input.brief.domain &&
    input.definition.metadata?.initialOrigin !== "provider_url" &&
    !grant.permissions.domainConfiguration
  ) {
    throw new Error("Launch Grant does not authorize the requested domain configuration");
  }
  if (
    grant.permissions.liveCommerceConfiguration !==
    (input.decision.payment.provider !== "none")
  ) {
    throw new Error(
      "Launch Grant commerce permission does not match the selected payment provider",
    );
  }
  return grant;
}

function assertExactPlanInput(
  target: ProviderWorkflowPlanRequest,
  key: string,
  expected: string,
): void {
  const actual = target.request.inputs[key];
  if (actual !== undefined && actual !== expected) {
    throw new Error(
      `Launch provider request ${target.provider}.${key} does not match its exact Launch Grant destination`,
    );
  }
}

function requireExactPlanInput(
  target: ProviderWorkflowPlanRequest,
  key: string,
  expected: string | number,
): void {
  if (target.request.inputs[key] !== expected) {
    throw new Error(
      `Launch provider request ${target.provider}.${key} does not match its immutable Launch Contract/Grant value`,
    );
  }
}

function founderProductionOrigin(
  dependencyOutputs: Readonly<Record<string, JsonValue | undefined>>,
  dependencyId = "initial-production-deploy",
): string {
  const dependency = dependencyOutputs[dependencyId];
  if (
    !dependency ||
    Array.isArray(dependency) ||
    typeof dependency !== "object" ||
    dependency.provider !== "vercel" ||
    dependency.state !== "verified" ||
    !Array.isArray(dependency.environments) ||
    !dependency.environments.includes("production") ||
    !Array.isArray(dependency.capabilities) ||
    !dependency.capabilities.includes("deployment") ||
    !Array.isArray(dependency.resourceRefs)
  ) {
    throw new Error(
      `Provider origin binding requires same-run verified ${dependencyId} production deployment evidence`,
    );
  }
  const origins = new Set<string>();
  for (const reference of dependency.resourceRefs) {
    if (typeof reference !== "string" || !reference.startsWith("url=")) continue;
    try {
      const url = new URL(reference.slice("url=".length));
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        isIP(hostname) !== 0 ||
        !hostname.includes(".") ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal")
      ) {
        continue;
      }
      origins.add(url.origin);
    } catch {
      // Same-run provider output is rejected rather than repaired or inferred.
    }
  }
  if (origins.size !== 1) {
    throw new Error(
      `Provider origin binding requires exactly one safe same-run ${dependencyId} production origin`,
    );
  }
  return [...origins][0]!;
}

function founderVerifiedCustomOrigin(
  brief: FounderBrief,
  dependencyOutputs: Readonly<Record<string, JsonValue | undefined>>,
): string {
  if (!brief.domain) throw new Error("Stripe custom-domain rebinding has no canonical domain");
  const origin = `https://${brief.domain}`;
  const project = dependencyOutputs["vercel-project"];
  const dns = dependencyOutputs["dns-records"];
  const verification = dependencyOutputs["verify-custom-domain"];
  const attached =
    project &&
    !Array.isArray(project) &&
    typeof project === "object" &&
    project.provider === "vercel" &&
    project.state === "verified" &&
    Array.isArray(project.capabilities) &&
    project.capabilities.includes("domain") &&
    Array.isArray(project.resourceRefs) &&
    project.resourceRefs.some((reference) => {
      if (typeof reference !== "string") return false;
      const separator = reference.indexOf("=");
      if (separator < 0 || !["domain", "site_url", "url"].includes(reference.slice(0, separator))) {
        return false;
      }
      const value = reference.slice(separator + 1);
      if (value === brief.domain) return true;
      try {
        return new URL(value).origin === origin;
      } catch {
        return false;
      }
    });
  const dnsVerified =
    dns &&
    !Array.isArray(dns) &&
    typeof dns === "object" &&
    ((dns.mode === "manual_dns" &&
      Array.isArray(dns.propagation_checks) &&
      dns.propagation_checks.length >= 2 &&
      dns.propagation_checks.every(
        (check) =>
          check && !Array.isArray(check) && typeof check === "object" && check.status === "matched",
      )) ||
      (dns.provider === "dns" && dns.state === "verified"));
  const exactJourney =
    verification &&
    !Array.isArray(verification) &&
    typeof verification === "object" &&
    verification.target === "verified_custom_domain" &&
    verification.deploymentUrl === origin;
  if (!attached || !dnsVerified || !exactJourney) {
    throw new Error(
      "Stripe custom-domain rebinding requires same-run Vercel attachment, DNS, and exact-origin journey evidence",
    );
  }
  return origin;
}

function assertFounderProviderInputSnapshot(
  launch: LaunchState,
  snapshot: DefaultProviderConfigSnapshot,
): void {
  if (!launch.launchGrant) return;
  const venture = snapshot.venture.venture;
  const expectedDomain = launch.brief.domain ?? null;
  if (
    venture.name !== launch.brief.name ||
    (venture.domain ?? null) !== expectedDomain ||
    venture.currency !== (launch.brief.currency ?? venture.currency) ||
    snapshot.offer.pricing.currency !== venture.currency ||
    venture.repository_visibility !== launch.launchGrant.repository.visibility
  ) {
    throw new Error(
      "Founder provider snapshot does not match the immutable Launch Contract/Grant venture name, domain, currency, or repository visibility; no source or provider action was started.",
    );
  }
  if (
    !isDeepStrictEqual(
      [...venture.capabilities.active].sort(),
      [...launch.decision.capabilities].sort(),
    )
  ) {
    throw new Error(
      "Founder provider snapshot capabilities do not match the immutable compiled launch graph; no source or provider action was started.",
    );
  }
  const requiredDestinations = requiredGrantDestinations(launch.definition, snapshot.providers).map(
    providerDestinationKey,
  );
  const grantedDestinations = launch.launchGrant.providerAccounts.map(providerDestinationKey);
  if (!isDeepStrictEqual([...requiredDestinations].sort(), [...grantedDestinations].sort())) {
    throw new Error(
      "Founder provider snapshot destinations do not match the immutable Launch Grant; no source or provider action was started.",
    );
  }

  if (!launch.launchContract) return;
  const contract = launchContractSchema.parse(launch.launchContract);
  const expectedPricing = {
    currency: contract.business.currency,
    monthly_price:
      contract.business.model === "subscription" ? contract.business.priceHypothesis : null,
    annual_price: null,
    one_time_price:
      contract.business.model === "one_time" || contract.business.model === "service"
        ? contract.business.priceHypothesis
        : null,
  };
  const actualPricing = {
    currency: snapshot.offer.pricing.currency,
    monthly_price: snapshot.offer.pricing.monthly_price,
    annual_price: snapshot.offer.pricing.annual_price,
    one_time_price: snapshot.offer.pricing.one_time_price,
  };
  if (!isDeepStrictEqual(actualPricing, expectedPricing)) {
    throw new Error(
      "Founder offer price does not match the immutable Launch Contract; no Stripe, source, or provider action was started.",
    );
  }
}

function immutableFounderStripePrice(input: {
  brief: FounderBrief;
  providerConfig: DefaultProviderConfigSnapshot;
  launchContract?: LaunchContract;
}): {
  productName: string;
  currency: string;
  unitAmount: number;
  recurringInterval?: "month" | "year";
} {
  const exactUnitAmount = (amount: number | null, errorMessage: string): number => {
    if (amount === null) throw new Error(errorMessage);
    try {
      const unitAmount = decimalPriceToMinorUnits(amount);
      if (unitAmount < 1) throw new Error(errorMessage);
      return unitAmount;
    } catch {
      throw new Error(errorMessage);
    }
  };
  if (input.launchContract) {
    const contract = launchContractSchema.parse(input.launchContract);
    const amount = contract.business.priceHypothesis;
    const unitAmount = exactUnitAmount(
      amount,
      "Canonical Launch Contract has no exact Stripe minor-unit amount",
    );
    return {
      productName: contract.venture.name,
      currency: contract.business.currency.toLowerCase(),
      unitAmount,
      ...(contract.business.model === "subscription"
        ? { recurringInterval: "month" as const }
        : {}),
    };
  }

  // Compatibility for an already-compiled short founder idea. The typed offer
  // snapshot is captured before any model task, so it is immutable for this
  // run even when the idea has not yet been upgraded to a Launch Contract.
  const pricing = input.providerConfig.offer.pricing;
  const candidates: Array<{
    amount: number;
    recurringInterval?: "month" | "year";
  } | null> =
    input.brief.monetization_model === "subscription"
      ? [
          pricing.monthly_price === null
            ? null
            : { amount: pricing.monthly_price, recurringInterval: "month" as const },
          pricing.annual_price === null
            ? null
            : { amount: pricing.annual_price, recurringInterval: "year" as const },
        ]
      : input.brief.monetization_model === "one_time" ||
          input.brief.monetization_model === "services"
        ? [pricing.one_time_price === null ? null : { amount: pricing.one_time_price }]
        : [];
  const selected = candidates.filter(
    (candidate): candidate is NonNullable<(typeof candidates)[number]> => candidate !== null,
  );
  if (selected.length !== 1) {
    throw new Error("Immutable founder offer snapshot has no single exact Stripe price");
  }
  const unitAmount = exactUnitAmount(
    selected[0]!.amount,
    "Immutable founder offer snapshot has no single exact Stripe price",
  );
  return {
    productName: input.brief.name,
    currency: pricing.currency.toLowerCase(),
    unitAmount,
    ...(selected[0]!.recurringInterval
      ? { recurringInterval: selected[0]!.recurringInterval }
      : {}),
  };
}

function bindFounderProviderFactories(input: {
  factories: Readonly<Record<string, ProviderWorkflowPlanFactory>>;
  definition: WorkflowDefinition;
  grant: LaunchGrant;
  providerConfig: DefaultProviderConfigSnapshot;
  brief: FounderBrief;
  launchContract?: LaunchContract;
  root: string;
  broker: CredentialBroker;
}): Readonly<Record<string, ProviderWorkflowPlanFactory>> {
  const grant = parseLaunchGrant(input.grant);
  const providers = providersSchema.parse(input.providerConfig.providers);
  const nodeByHandler = new Map(
    input.definition.nodes
      .filter((node) => node.kind === "provider" && node.handler)
      .map((node) => [node.handler!, node] as const),
  );
  return Object.fromEntries(
    Object.entries(input.factories).map(([handler, factory]) => [
      handler,
      async (workflow) => {
        const node = nodeByHandler.get(handler);
        const expectedProvider = node ? PROVIDER_BY_NODE[node.id] : undefined;
        if (!node || !expectedProvider || workflow.node.handler !== handler) {
          throw new Error(`Launch provider factory ${handler} is not bound to one compiled node`);
        }
        const target = await factory(workflow);
        if (target.provider !== expectedProvider) {
          throw new Error(
            `Launch provider factory ${handler} returned ${target.provider}, expected ${expectedProvider}`,
          );
        }
        const capabilities = [...new Set(target.request.capabilities)];
        const authorizedScopes = new Set(node.authorization.scopes);
        if (
          capabilities.length === 0 ||
          capabilities.length !== target.request.capabilities.length ||
          capabilities.some((capability) => !authorizedScopes.has(capability))
        ) {
          throw new Error(
            `Launch provider factory ${handler} requested duplicate, empty, or out-of-scope capabilities`,
          );
        }
        const configured = providers.providers[target.provider] as ProviderState | undefined;
        if (!configured) {
          throw new Error(`Launch provider ${target.provider} has no typed configuration`);
        }
        if (target.request.credentialRef !== (configured.credential_ref ?? undefined)) {
          throw new Error(
            `Launch provider ${target.provider} credential reference does not match the Founder Stack configuration`,
          );
        }
        if (target.request.credentialRef) {
          const reference = input.broker.getReference(target.request.credentialRef);
          if (!reference || reference.provider !== target.provider) {
            throw new Error(
              `Launch provider ${target.provider} credential reference is not registered to that provider`,
            );
          }
          if (
            reference.accountId &&
            configured.account_id &&
            reference.accountId !== configured.account_id
          ) {
            throw new Error(
              `Launch provider ${target.provider} credential account does not match the configured account`,
            );
          }
          if (
            target.provider === "stripe" &&
            (!configured.account_id ||
              reference.accountId !== configured.account_id ||
              reference.testStatus !== "passed" ||
              reference.testedAt === undefined ||
              reference.providerMode !== "test")
          ) {
            throw new Error(
              "Founder Stripe apply requires durable read-only proof that the exact restricted API credential is authenticated for the configured account in test mode. Next: run vh auth test stripe --ref " +
                reference.ref,
            );
          }
        }
        for (const capability of capabilities) {
          const externalAccountId = configuredProviderDestination(
            providers,
            target.provider,
            capability,
          );
          if (
            !externalAccountId ||
            !grant.providerAccounts.some(
              (destination) =>
                destination.provider === target.provider &&
                destination.capability === capability &&
                destination.externalAccountId === externalAccountId,
            )
          ) {
            throw new Error(
              `Launch provider request ${target.provider}/${capability} is outside the exact Launch Grant account destination`,
            );
          }
        }
        if (target.provider === "github") {
          assertExactPlanInput(
            target,
            "repository",
            `${grant.repository.owner}/${grant.repository.name}`,
          );
          assertExactPlanInput(target, "visibility", grant.repository.visibility);
          assertExactPlanInput(target, "sourceDirectory", resolve(input.root));
        }
        if (target.provider === "vercel") {
          const scope = configured.team_id ?? configured.account_id;
          if (scope) assertExactPlanInput(target, "scope", scope);
          assertExactPlanInput(target, "project", grant.repository.name);
          if (handler === "provider.vercel-project") {
            if (input.brief.domain) {
              requireExactPlanInput(target, "domain", input.brief.domain);
            } else if (target.request.inputs.domain !== undefined) {
              throw new Error(
                "Launch provider request introduced a domain outside the immutable founder brief",
              );
            }
          }
          if (handler === "provider.vercel-stripe-price-environment") {
            const priceId = publicIdentifier(
              workflow.dependencyOutputs["stripe-commerce"],
              "price_id",
            );
            if (!priceId) {
              throw new Error(
                "Stripe price application binding requires one same-run verified price identifier",
              );
            }
            requireExactPlanInput(target, "environmentVariableName", "STRIPE_PRICE_ID");
            requireExactPlanInput(target, "environmentPublicValue", priceId);
          }
          if (handler === "provider.vercel-stripe-price-lookup-environment") {
            const terms = immutableFounderStripePrice(input);
            const lookupKey = `vh_${input.brief.id.replaceAll("-", "_")}_${terms.currency}_${terms.unitAmount}_${terms.recurringInterval ?? "once"}`;
            requireExactPlanInput(target, "environmentVariableName", "STRIPE_PRICE_LOOKUP_KEY");
            requireExactPlanInput(target, "environmentPublicValue", lookupKey);
          }
        }
        if (target.provider === "neon" && capabilities.includes("project")) {
          const organizationId = configured.external_resource_ids.organization_id;
          if (!organizationId) {
            throw new Error(
              "Launch provider neon project creation has no exact configured organization destination",
            );
          }
          assertExactPlanInput(target, "organizationId", organizationId);
        }
        if (target.provider === "stripe") {
          const accountId = configured.account_id;
          if (!accountId || target.request.inputs.stripeAccountId !== accountId) {
            throw new Error(
              "Launch provider stripe has no exact request-bound configured account destination",
            );
          }
          requireExactPlanInput(target, "ventureSlug", input.brief.id);
          requireExactPlanInput(target, "stripeMode", "test");
          if (handler === "provider.stripe-commerce") {
            const terms = immutableFounderStripePrice(input);
            requireExactPlanInput(target, "productName", terms.productName);
            requireExactPlanInput(target, "currency", terms.currency);
            requireExactPlanInput(target, "unitAmount", terms.unitAmount);
            const interval = target.request.inputs.recurringInterval;
            if (interval !== terms.recurringInterval) {
              throw new Error(
                "Launch provider request Stripe interval does not match the immutable Launch Contract",
              );
            }
          } else if (
            handler === "provider.stripe-callbacks" ||
            handler === "provider.stripe-domain-callbacks"
          ) {
            const origin =
              handler === "provider.stripe-domain-callbacks"
                ? founderVerifiedCustomOrigin(input.brief, workflow.dependencyOutputs)
                : founderProductionOrigin(workflow.dependencyOutputs);
            requireExactPlanInput(target, "webhookUrl", `${origin}/api/stripe/webhook`);
            requireExactPlanInput(target, "portalReturnUrl", `${origin}/account`);
            const expectedWebhookRef =
              configured.external_resource_ids.webhook_secret_credential_ref;
            if (
              !expectedWebhookRef ||
              target.request.inputs.webhookSecretCredentialRef !== expectedWebhookRef
            ) {
              throw new Error(
                "Launch provider request Stripe webhook secret target does not match the immutable Founder Stack snapshot",
              );
            }
          }
        }
        if (target.provider === "google" && capabilities.includes("analytics_property")) {
          const analyticsAccount = configured.external_resource_ids.analytics_account_id;
          if (analyticsAccount) {
            assertExactPlanInput(target, "analyticsAccountId", analyticsAccount);
          }
        }
        if (target.provider === "google" && capabilities.includes("analytics_web_stream")) {
          const dependencyId = node.dependencies.includes("initial-production-deploy")
            ? "initial-production-deploy"
            : "production-deploy";
          const origin = founderProductionOrigin(workflow.dependencyOutputs, dependencyId);
          requireExactPlanInput(target, "defaultUri", `${origin}/`);
          const propertyId = publicIdentifier(
            workflow.dependencyOutputs["google-analytics-property"],
            "property_id",
          );
          if (!propertyId) {
            throw new Error(
              "GA4 stream binding requires one same-run verified analytics property identifier",
            );
          }
          requireExactPlanInput(target, "analyticsPropertyId", propertyId);
        }
        return {
          ...target,
          operationBudget: {
            maxOperations: launchProviderNodeOperationCeiling(node),
            missingCostClassification: {
              basis: "reviewed_known_zero_direct_charge",
              currency: grant.providerOperationBudget!.currency,
              ongoingAccountPlanUsageCovered: false,
              allowedOperations: FOUNDER_REVIEWED_ZERO_DIRECT_CHARGE_OPERATIONS.filter(
                ([provider, capability]) =>
                  provider === target.provider && capabilities.includes(capability),
              ).map(([provider, capability, action]) => ({ provider, capability, action })),
            },
          },
        };
      },
    ]),
  );
}

function authorizationForLaunchGrant(
  envelope: AuthorizationEnvelope,
  grant: LaunchGrant,
): AuthorizationEnvelope {
  const operationBudget = grant.providerOperationBudget;
  if (!operationBudget) {
    throw new Error("Canonical founder Launch Grant has no provider-operation budget");
  }
  let exponent: number;
  try {
    exponent =
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: operationBudget.currency,
      }).resolvedOptions().maximumFractionDigits ?? Number.NaN;
  } catch {
    throw new Error(`Launch Grant uses unsupported budget currency ${operationBudget.currency}`);
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    throw new Error(`Launch Grant uses unsupported budget currency ${operationBudget.currency}`);
  }
  const amount = operationBudget.maxDirectChargeMinorUnits / 10 ** exponent;
  if (!Number.isFinite(amount)) {
    throw new Error("Launch Grant provider direct-operation monetary ceiling is invalid");
  }
  return authorizationEnvelopeSchema.parse({
    ...envelope,
    max_estimated_spend: {
      amount,
      currency: operationBudget.currency,
    },
    unknown_external_costs_allowed: false,
  });
}

function bindWorkflowBudgetsToLaunchGrant(
  definition: WorkflowDefinition,
  grant: LaunchGrant,
): WorkflowDefinition {
  const policy = grant.modelExecutionPolicy;
  if (!policy) throw new Error("Canonical founder Launch Grant has no model execution policy");
  const taskBudgetCategory = "launch.build_agent_tasks";
  const bounded: WorkflowDefinition = {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.handler && launchBuildAgentHandlers.has(node.handler)
        ? {
            ...node,
            budgetCategory: taskBudgetCategory,
            cost: { amount: 1, unit: "tasks" },
          }
        : node,
    ),
    budgets: {
      ...definition.budgets,
      [taskBudgetCategory]: policy.maxBuildAgentTasks,
    },
  };
  validateWorkflow(bounded);
  return bounded;
}

async function assertFounderBuildAgentHostPolicy(
  host: BuildAgentHost,
  grant: LaunchGrant,
): Promise<void> {
  await assertBuildAgentHostAvailable(host);
  const inspection = await host.inspect();
  const policy = grant.modelExecutionPolicy;
  if (!policy) throw new Error("Canonical founder Launch Grant has no model execution policy");
  if (policy.mode === "fixture_no_model_execution") {
    if (
      inspection.billingMode !== "fixture_no_model_execution" ||
      inspection.billingEvidence !== "fixture_attestation"
    ) {
      throw new Error(
        "Fixture founder launch requires an explicit no-model build-host attestation; no child or provider effect was created.",
      );
    }
    return;
  }
  if (
    inspection.billingMode !== "chatgpt_subscription" ||
    inspection.billingEvidence !== "codex_login_status"
  ) {
    throw new Error(
      "Founder production launch requires `codex login status` to attest ChatGPT subscription use; API-key or unknown billing is blocked before child creation and provider transport.",
    );
  }
}

function configureFounderProviderTargets(
  root: string,
  connection: FounderStackConnection,
  preparation: FounderLaunchPreparation,
): void {
  const path = inside(root, "config/providers.yaml");
  const current = providersSchema.parse(readStructured(path));
  const rendered = renderFounderStackProviderConfigOverrides(connection, {
    ventureSlug: preparation.idea.brief.id,
    domain: preparation.idea.brief.domain,
  });
  const repository = `${preparation.repository.owner}/${preparation.repository.name}`;
  const exactLaunchIds: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    github: { repository, repository_intent: "create_from_source" },
    vercel: { project: preparation.idea.brief.id, project_intent: "create" },
    neon: { project_name: preparation.idea.brief.id, project_intent: "create" },
    bing: { site_intent: "create" },
  };
  const providers = Object.fromEntries(
    Object.entries(current.providers).map(([providerId, state]) => {
      const override = rendered.providers[providerId as keyof typeof rendered.providers];
      if (!override) return [providerId, state];
      return [
        providerId,
        {
          ...state,
          ...override,
          capability_ids: state.capability_ids,
          external_resource_ids: {
            ...state.external_resource_ids,
            ...override.external_resource_ids,
            ...(exactLaunchIds[providerId] ?? {}),
          },
          evidence_artifact_ref: null,
          error_code: null,
          error_message: null,
          retryable: null,
          next_action: null,
          manual_action_ref: null,
          extensions: state.extensions,
        },
      ];
    }),
  );
  writeYamlAtomic(path, providersSchema.parse({ ...current, providers }));
}

function configureFounderOffer(root: string, preparation: FounderLaunchPreparation): void {
  const path = inside(root, "config/offer.yaml");
  const current = offerSchema.parse(readStructured(path));
  const brief = preparation.idea.brief;
  const next = offerSchema.parse({
    ...current,
    icp: { ...current.icp, description: brief.specific_user_or_audience },
    offer: { ...current.offer, sentence: brief.intended_outcome },
    pricing: {
      ...current.pricing,
      currency: preparation.idea.commercialTerms.currency,
      monthly_price: preparation.idea.commercialTerms.monthlyPrice,
      annual_price: preparation.idea.commercialTerms.annualPrice,
      one_time_price: preparation.idea.commercialTerms.oneTimePrice,
    },
  });
  writeYamlAtomic(path, next);
}

function publicFounderPreparation(
  preparation: FounderLaunchPreparation,
  extra: Record<string, JsonValue> = {},
): JsonValue {
  return {
    schemaVersion: preparation.schemaVersion,
    status: preparation.status,
    mode: preparation.executionMode,
    ventureSlug: preparation.idea.brief.id,
    selectedVentureType: preparation.selectedVentureType,
    stackProfile: preparation.stackProfile,
    selectedProviders: preparation.selectedProviders,
    repository: preparation.repository,
    resources: preparation.resources,
    environmentVariables: preparation.environmentVariables,
    migrations: preparation.migrations,
    domain: preparation.domain,
    setup: preparation.setup,
    estimatedExternalEffects: preparation.estimatedExternalEffects,
    launchGrant: {
      status: preparation.grantDisposition,
      grantId: preparation.launchGrant.grantId,
      expiresAt: preparation.launchGrant.expiresAt,
      allowedExternalEffects: preparation.launchGrant.allowedExternalEffects,
      providerDestinationCount: preparation.launchGrant.providerAccounts.length,
      providerOperationBudget: preparation.launchGrant.providerOperationBudget ?? null,
      modelExecutionPolicy: preparation.launchGrant.modelExecutionPolicy ?? null,
    },
    materialization: {
      planDigest: preparation.materialization.planDigest,
      fileCount: preparation.materialization.files.length,
      files: preparation.materialization.files.map(({ path, ownership }) => ({ path, ownership })),
      externalEffects: preparation.materialization.effects,
    },
    graphDryRun: preparation.graphDryRun as unknown as JsonValue,
    blockers: preparation.blockers,
    launchGaps: preparation.launchGaps,
    exactFinalCommand: preparation.exactFinalCommand,
    externalEffectsOccurred: false,
    ...extra,
  } as unknown as JsonValue;
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

function mergeFounderStackRoleRepair(
  current: FounderStackConnection | null,
  next: FounderStackConnection,
  request: Pick<
    CliStackRequest,
    "updatedRoles" | "replaceOptionalRoles" | "updateWritableCredentialBackend"
  >,
): FounderStackConnection {
  if (!current || request.updatedRoles === undefined) return parseFounderStackConnection(next);
  if (
    next.ownerOrganizationId !== current.ownerOrganizationId &&
    next.ownerOrganizationId !== "founder"
  ) {
    throw new Error("Founder Stack profile belongs to another organization");
  }
  const updated = new Set(request.updatedRoles);
  const roles = Object.fromEntries(
    (Object.keys(founderStackRoleDefinitions) as FounderStackRole[]).map((role) => [
      role,
      updated.has(role) ? next.roles[role] : current.roles[role],
    ]),
  ) as FounderStackConnection["roles"];
  const selectedOptionalRoles = request.replaceOptionalRoles
    ? next.selectedOptionalRoles
    : [
        ...new Set([
          ...current.selectedOptionalRoles,
          ...next.selectedOptionalRoles.filter((role) => updated.has(role)),
        ]),
      ];
  return parseFounderStackConnection({
    ...current,
    inspectedCliSessions: next.inspectedCliSessions,
    roles,
    selectedOptionalRoles,
    writableCredentialBackend: request.updateWritableCredentialBackend
      ? next.writableCredentialBackend
      : current.writableCredentialBackend,
    launchDefaults: {
      neon: updated.has("database.postgres")
        ? next.launchDefaults.neon
        : current.launchDefaults.neon,
      stripe: updated.has("commerce.web")
        ? next.launchDefaults.stripe
        : current.launchDefaults.stripe,
      brevo: updated.has("email.transactional")
        ? next.launchDefaults.brevo
        : current.launchDefaults.brevo,
      google: updated.has("growth.google")
        ? next.launchDefaults.google
        : current.launchDefaults.google,
      bing: updated.has("search.bing") ? next.launchDefaults.bing : current.launchDefaults.bing,
      dns: updated.has("dns.records") ? next.launchDefaults.dns : current.launchDefaults.dns,
    },
  });
}

function validateFounderStackCredentialWrites(
  request: CliStackRequest,
  connection: FounderStackConnection,
): void {
  const permittedRoles = new Set<FounderStackRole>(
    request.updatedRoles ?? (Object.keys(founderStackRoleDefinitions) as FounderStackRole[]),
  );
  const seen = new Set<string>();
  for (const pending of request.credentialWrites ?? []) {
    if (seen.has(pending.reference)) {
      throw new Error(`Duplicate Stack credential write for ${pending.reference}`);
    }
    seen.add(pending.reference);
    const role = (Object.keys(founderStackRoleDefinitions) as FounderStackRole[]).find(
      (candidate) =>
        permittedRoles.has(candidate) &&
        founderStackRoleDefinitions[candidate].providerId === pending.provider &&
        connection.roles[candidate].credentialRef === pending.reference,
    );
    if (!role) {
      throw new Error(
        `Stack credential write ${pending.reference} is not bound to one refreshed provider role`,
      );
    }
    const expectedKind: CredentialKind =
      pending.provider === "stripe"
        ? "restricted_api_key"
        : pending.provider === "google"
          ? "oauth"
          : "api_key";
    if (pending.kind !== expectedKind) {
      throw new Error(`Stack credential write for ${role} has the wrong credential kind`);
    }
    const metadata = connection.roles[role];
    if (pending.accountId !== undefined && pending.accountId !== metadata.accountId) {
      throw new Error("Stack credential write has mismatched account metadata for " + role);
    }
    if (
      pending.scopes.length !== metadata.scopes.length ||
      pending.scopes.some((scope) => !metadata.scopes.includes(scope))
    ) {
      throw new Error("Stack credential write has mismatched scope metadata for " + role);
    }
  }
}

export function createDefaultCliServices(options: DefaultCliServicesOptions = {}): CliServices {
  const root = resolve(options.rootDir ?? process.cwd());
  const store = options.store ?? new FileWorkflowStore({ rootDir: inside(root, ".venture/runs") });
  const now = options.now ?? (() => new Date());
  const providerLifecycleStore = new FileProviderLifecycleStore(
    inside(root, ".venture/provider-lifecycle.json"),
  );
  const founderStackStore = new FileFounderStackStore(
    options.founderStackRoot ??
      (options.rootDir ? inside(root, ".venture/founder-stacks") : defaultFounderStackStateRoot()),
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
  const credentialTestTimeoutMs = options.credentialTestTimeoutMs ?? 15_000;
  if (
    !Number.isSafeInteger(credentialTestTimeoutMs) ||
    credentialTestTimeoutMs < 1 ||
    credentialTestTimeoutMs > 60_000
  ) {
    throw new Error("Credential test timeout must be an integer from 1 to 60000 milliseconds");
  }
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
  const defaultCredentialTesters = (connection: FounderStackConnection | null) =>
    createDefaultFounderCredentialTesters({ fetcher: httpFetcher, connection });
  const boundedCredentialTester = (
    provider: string,
    tester: CredentialTester,
  ): CredentialTester => {
    return async (secret, reference) => {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const failed = (message: string) => ({ ok: false as const, message });
      const result = Promise.resolve()
        .then(() => tester(secret, reference, { signal: controller.signal }))
        .catch(() => failed(`${provider} credential read-only probe was unavailable`));
      const deadline = new Promise<Awaited<ReturnType<CredentialTester>>>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(failed(`${provider} credential read-only probe timed out`));
        }, credentialTestTimeoutMs);
      });
      try {
        return await Promise.race([result, deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
  };
  const testCredential = (ref: string, provider: string, tester: CredentialTester) =>
    credentialBroker.test(ref, boundedCredentialTester(provider, tester));
  const testFounderStackCredentials = async (connection: FounderStackConnection) => {
    const testers = defaultCredentialTesters(connection);
    const refs = [
      ...new Set(
        Object.values(connection.roles).flatMap((role) =>
          role.credentialRef ? [role.credentialRef] : [],
        ),
      ),
    ];
    for (const ref of refs) {
      const reference = credentialBroker.getReference(ref);
      if (!reference || reference.kind === "cli_session") continue;
      const tester = options.credentialTesters?.[reference.provider] ?? testers[reference.provider];
      if (tester) await testCredential(ref, reference.provider, tester);
    }
    for (const reference of credentialBroker.list()) {
      credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
    }
    saveCredentialCatalog(credentialCatalog, catalogPath);
  };
  const learningRuntime = createDefaultLearningRuntime({
    rootDir: root,
    broker: credentialBroker,
    commandRunner: options.dataCommandRunner ?? commandRunner,
    httpFetcher,
    injectedConnectors: options.dataConnectors,
    injectedRequirements: requirements,
    now,
  });

  const productRuntimeHome = inside(root, ".venture/product-command-home");
  mkdirSync(productRuntimeHome, { recursive: true, mode: 0o700 });
  const productCommandRunner =
    options.productCommandRunner ??
    new NodeCommandRunner({ env: productCommandEnvironment(process.env, productRuntimeHome) });
  const buildAgentHost =
    options.buildAgentHost ??
    new CodexCliBuildAgentHost({
      rootDir: root,
      runner: new NodeCommandRunner({ env: codexBuildAgentEnvironment(process.env) }),
      redactor: credentialBroker.redactor,
    });
  const ideaSharpenerHost =
    options.ideaSharpenerHost ??
    new CodexCliIdeaSharpenerHost({
      runner: new NodeCommandRunner({ env: ideaSharpenerEnvironment(process.env) }),
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
    ...(launch.launchContract ? { launchContract: launch.launchContract } : {}),
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

  const qualityReportLines = (
    state: WorkflowRunState,
  ): { lines: string[]; limitations: string[] } => {
    const lines: string[] = [];
    const limitations: string[] = [];
    for (const nodeId of ["verify-local", "verify-mvp", "verify-launch", "verify-production"]) {
      const node = state.nodes[nodeId];
      if (!node) continue;
      const output = node.output;
      const command =
        output &&
        typeof output === "object" &&
        !Array.isArray(output) &&
        Array.isArray(output.command)
          ? output.command.filter((part): part is string => typeof part === "string").join(" ")
          : null;
      lines.push(
        `${nodeId}: ${node.state}${command ? `; ${command}` : ""}${
          node.evidenceArtifact ? `; evidence ${node.evidenceArtifact}` : ""
        }`,
      );
      if (node.state !== "succeeded") {
        limitations.push(`${nodeId} did not succeed in this run; no quality pass was inferred.`);
      }
    }
    if (lines.length === 0) limitations.push("No same-run quality node output was recorded.");
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
    const quality = qualityReportLines(state);
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
        ...(launch.launchContract
          ? {
              firstValidationAction: {
                action: launch.launchContract.distribution.firstValidationAction,
                channel: launch.launchContract.distribution.firstChannel,
                userHabitat: launch.launchContract.distribution.firstUserHabitat,
                state: "planned" as const,
                execution: "human_gated" as const,
                evidenceRequired:
                  "Founder-reviewed evidence that the action was performed; no outreach, response, demand, or conversion result is inferred.",
              },
            }
          : {}),
      },
      authorization: {
        profile: launch.authorization.profile,
        approvalRef: launch.authorization.approval_ref,
        expiresAt: launch.authorization.expires_at,
        spendCeiling: launch.authorization.max_estimated_spend,
        ...(launch.launchGrant?.providerOperationBudget
          ? { spendScope: "reviewed_direct_provider_operations_only" as const }
          : {}),
      },
      providerByNode: PROVIDER_BY_NODE,
      providerMetadata,
      credentialReferences: reportCredentialReferences(launch),
      limitations: [
        ...(launch.brief.synthetic
          ? ["Synthetic fixture: no live provider or market state is claimed."]
          : []),
        ...(launch.launchGrant?.providerOperationBudget
          ? [
              `Provider direct-operation estimate: ${launch.launchGrant.providerOperationBudget.maxDirectChargeMinorUnits} minor units ${launch.launchGrant.providerOperationBudget.currency} (${launch.launchGrant.providerOperationBudget.estimateBasis}); ongoing provider account-plan usage is not covered.`,
            ]
          : []),
        ...(launch.launchGrant?.modelExecutionPolicy
          ? [
              launch.launchGrant.modelExecutionPolicy.mode === "chatgpt_subscription_non_metered"
                ? `Build-agent execution is bounded to ${launch.launchGrant.modelExecutionPolicy.maxBuildAgentTasks} ChatGPT-subscription tasks; token usage is observational and no token or monetary hard ceiling is claimed.`
                : `Fixture build execution is bounded to ${launch.launchGrant.modelExecutionPolicy.maxBuildAgentTasks} deterministic tasks and attests that no model was invoked.`,
            ]
          : []),
        ...(launch.founderLaunchGaps ?? []).map(
          (gap) =>
            `${gap.code}: ${gap.message} Next: ${gap.nextAction}. State: ${gap.state}; blocksLaunch=false.`,
        ),
        ...quality.limitations,
      ],
      sections: {
        checksRun: quality.lines,
        scheduledLoops: configuredLoops,
        nextReviews,
      },
    });
  };

  const receiptVerification = (
    launch: LaunchState,
    state: WorkflowRunState,
  ): NonNullable<Parameters<typeof createLaunchReceipt>[0]["verification"]> =>
    sameRunLaunchReceiptVerification(state, Boolean(launch.brief.domain));

  const persistStateReport = async (
    launch: LaunchState,
    state: WorkflowRunState,
    runtimeContext: ProviderRuntimeContext,
  ) => {
    const outputDirectory = inside(root, `reports/launch/${state.runId}`);
    const report = renderLaunchReport(reportInputFor(launch, state), {
      redactor: runtimeContext.redactor,
    });
    const persistedReport = await persistLaunchReport(report, outputDirectory);
    const receipt = createLaunchReceipt(
      {
        state,
        report: persistedReport.document,
        decision: launch.decision,
        launchContract: launch.launchContract,
        launchGrant: launch.launchGrant,
        launchGaps: launch.founderLaunchGaps,
        verification: receiptVerification(launch, state),
      },
      { redactor: runtimeContext.redactor },
    );
    const persistedReceipt = await persistLaunchReceipt(receipt, outputDirectory);
    return { report: persistedReport, receipt: persistedReceipt };
  };

  const bindingsFor = async (
    launch: LaunchState,
  ): Promise<{ bindings: WorkflowBindings; runtimeContext: ProviderRuntimeContext }> => {
    const launchContext = launchContextFor(launch);
    // Capture every provider-facing input before a model task can run. Founder
    // bindings below retain this typed snapshot for the full run/resume turn.
    const providerConfigSnapshot = launch.launchGrant ? loadDefaultProviderConfig(root) : undefined;
    if (providerConfigSnapshot) assertFounderProviderInputSnapshot(launch, providerConfigSnapshot);
    const productBindings = options.launchBindings
      ? await options.launchBindings(launchContext)
      : (await (launch.launchGrant
          ? assertFounderBuildAgentHostPolicy(buildAgentHost, launch.launchGrant)
          : assertBuildAgentHostAvailable(buildAgentHost)),
        createLaunchProductBindings({
          rootDir: root,
          brief: launch.brief,
          decision: launch.decision,
          launchContract: launch.launchContract,
          authorization: launch.authorization,
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

    const providerBrief: FounderBrief =
      launch.definition.metadata?.initialOrigin === "provider_url" && launch.brief.domain
        ? { ...launch.brief, domain: null }
        : launch.brief;
    const providerLaunchContext: LaunchBindingContext = {
      ...launchContext,
      brief: providerBrief,
    };
    const unboundedProviderPlanFactories = options.providerPlanFactories
      ? typeof options.providerPlanFactories === "function"
        ? await options.providerPlanFactories(providerLaunchContext)
        : options.providerPlanFactories
      : createDefaultProviderPlanFactories({
          rootDir: root,
          brief: providerBrief,
          definition: launch.definition,
          ...(providerConfigSnapshot ? { configSnapshot: providerConfigSnapshot } : {}),
          ...(launch.launchContract ? { launchContract: launch.launchContract } : {}),
          lifecycleStore: providerLifecycleStore,
        });
    const providerPlanFactories = launch.launchGrant
      ? bindFounderProviderFactories({
          factories: unboundedProviderPlanFactories,
          definition: launch.definition,
          grant: launch.launchGrant,
          providerConfig: providerConfigSnapshot!,
          brief: providerBrief,
          ...(launch.launchContract ? { launchContract: launch.launchContract } : {}),
          root,
          broker: credentialBroker,
        })
      : unboundedProviderPlanFactories;
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
    async ideaSharpen(request) {
      const boundary = new OwnerPathLock(root, {
        label: "vh idea sharpen",
        lockName: ".vh-idea-sharpen.lock",
      });
      try {
        const source =
          request.input === "-"
            ? readFileSync(0, "utf8")
            : boundary.readRegularFile(inside(root, request.input), {
                label: "vh idea sharpen --input",
                maxBytes: 100_000,
              });
        const outputPath = safeIdeaOutputPath(root, request.output, boundary);
        const outputReference = relative(realpathSync(root), outputPath);
        const baseOutput = outputReference.slice(0, -3);
        const constitutionPath = safeIdeaOutputPath(
          root,
          `${baseOutput}.product-constitution.md`,
          boundary,
        );
        const usagePath = inside(root, `${baseOutput}.usage.json`);
        const contractPath = inside(root, `${baseOutput}.launch-contract.yaml`);
        let result;
        try {
          result = await sharpenIdea(source, { host: ideaSharpenerHost, now });
        } catch (error) {
          if (error instanceof IdeaSharpenError) {
            boundary.writeFileAtomic(
              usagePath,
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  command: "idea.sharpen",
                  status: "failed",
                  sourceDigest: createHash("sha256").update(source).digest("hex"),
                  ...error.accounting,
                  transcriptStored: false,
                  providerEffects: false,
                },
                null,
                2,
              )}\n`,
              "vh idea sharpen failed usage",
            );
          }
          throw error;
        }
        boundary.writeFileAtomic(outputPath, result.ideaMarkdown, "vh idea sharpen output");
        boundary.writeFileAtomic(
          constitutionPath,
          result.productConstitutionMarkdown,
          "vh idea sharpen Product Constitution",
        );
        boundary.writeFileAtomic(
          contractPath,
          renderLaunchContractYaml(result.launchContract),
          "vh idea sharpen Launch Contract",
        );
        boundary.writeFileAtomic(
          usagePath,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              command: "idea.sharpen",
              status: result.status,
              sourceDigest: createHash("sha256").update(source).digest("hex"),
              output: outputReference,
              productConstitution: `${baseOutput}.product-constitution.md`,
              launchContract: `${baseOutput}.launch-contract.yaml`,
              ...result.accounting,
              transcriptStored: false,
              providerEffects: false,
            },
            null,
            2,
          )}\n`,
          "vh idea sharpen usage",
        );
        return {
          schemaVersion: 1,
          status: result.status,
          output: outputReference,
          productConstitution: `${baseOutput}.product-constitution.md`,
          launchContract: `${baseOutput}.launch-contract.yaml`,
          usage: `${baseOutput}.usage.json`,
          ...result.accounting,
          transcriptStored: false,
          providerEffects: false,
          repositoryCreated: false,
          deploymentCreated: false,
          nextAction: `Review ${baseOutput}.launch-contract.yaml, then run vh launch --idea ${outputReference} --stack founder-default --production --dry-run --non-interactive --json.`,
        } as unknown as JsonValue;
      } finally {
        boundary.release();
      }
    },
    async founderLaunch(request) {
      let founderPathBoundary: OwnerPathLock | null = null;
      const connection = founderStackStore.load(request.stackProfile);
      if (!connection) {
        return {
          schemaVersion: 1,
          status: "blocked",
          mode: request.mode,
          stackProfile: request.stackProfile,
          blockers: [
            {
              code: "stack_role_not_ready",
              message: "Founder Stack profile founder-default has not been created.",
              nextAction:
                "Run vh stack create founder-default --file <connection.json>, then vh stack doctor founder-default.",
            },
          ],
          externalEffectsOccurred: false,
          exactFinalCommand:
            "vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive",
        } as unknown as JsonValue;
      }
      const stackDoctor = await doctorFounderStackConnection({
        connection,
        context: { ...effectiveProviderContext, authorization: "dry_run" },
        registry: effectiveProviderRegistry,
        now,
      });
      const ideaSource = loadFounderIdeaFile(request.idea, root);
      const workflowRefSha = resolveFounderWorkflowRefSha(root, options.founderWorkflowRefSha);
      const workflowRepository = resolveFounderWorkflowRepository(
        root,
        options.founderWorkflowRepository,
      );
      // A venture is an independent product with its own Git history, so it is
      // never materialized inside the Core checkout by default. An explicit
      // founderOutputRoot (tests and fixtures) wins; otherwise the founder's
      // configured ventures root decides, and an unset root is fatal rather
      // than a silent write into Core.
      const venturesRoot = options.founderOutputRoot ?? configuredVenturesRoot({ coreRoot: root });
      if (!venturesRoot) throw new Error(VENTURES_ROOT_UNSET_MESSAGE);
      const canonicalVenturesRoot = realpathSync(resolve(venturesRoot));
      founderPathBoundary =
        request.mode === "apply"
          ? new OwnerPathLock(canonicalVenturesRoot, {
              label: "Founder venture operation",
            })
          : null;
      try {
        const preparation = compileFounderLaunchPreparation({
          ideaSource,
          ideaPath: request.idea,
          stack: connection,
          stackDoctor,
          baseDir: canonicalVenturesRoot,
          output: request.output,
          workflowRefSha,
          workflowRepository,
          executionMode: request.mode,
          production: request.production,
          nonInteractive: request.nonInteractive,
          at: now(),
          allowFixtureStack: options.allowFixtureFounderStack ?? false,
        });
        if (request.mode === "dry-run" || preparation.status === "blocked") {
          return publicFounderPreparation(preparation);
        }
        if (!founderPathBoundary) {
          throw new Error("Founder apply requires an active ventures-root owner lock");
        }
        const childRoot = resolveVentureOutputWithinRoot(
          canonicalVenturesRoot,
          relative(canonicalVenturesRoot, preparation.repository.localDirectory),
        );
        const stagingRoot = `${childRoot}.vh-staging-${preparation.launchGrant.grantId.slice(3, 15)}`;
        const stackConnectionHash = sha256Json(connection);

        const childOptions = (child: string): DefaultCliServicesOptions => ({
          rootDir: child,
          founderStackRoot: founderStackStore.rootDir,
          founderOutputRoot: options.founderOutputRoot,
          founderWorkflowRefSha: options.founderWorkflowRefSha,
          founderWorkflowRepository: options.founderWorkflowRepository,
          allowFixtureFounderStack: options.allowFixtureFounderStack,
          launchBindings: options.launchBindings,
          buildAgentHost: options.buildAgentHost,
          ideaSharpenerHost: options.ideaSharpenerHost,
          productCommandRunner: options.productCommandRunner,
          providerCommandRunner: options.providerCommandRunner,
          dataCommandRunner: options.dataCommandRunner,
          dataHttpFetcher: options.dataHttpFetcher,
          upgradeCommandRunner: options.upgradeCommandRunner,
          providerPlanFactories: options.providerPlanFactories,
          providerRuntimeContext: options.providerRuntimeContext,
          credentialBroker,
          credentialCatalogPath: catalogPath,
          credentialTesters: options.credentialTesters,
          interactiveCliLogin: options.interactiveCliLogin,
          providerRegistry: options.providerRegistry,
          providerContext: options.providerContext,
          dataConnectors: options.dataConnectors,
          dataRequirements: options.dataRequirements,
          release: options.release,
          now,
          pathSecurityHook: options.pathSecurityHook,
        });

        let effectivePreparation = preparation;
        let materialized: {
          status: "materialized";
          files: readonly string[];
          planDigest: string;
        };
        let transaction: FounderLaunchTransaction;
        let workflow: WorkflowRunState | null = null;
        let buildHostPreflighted = false;
        let writableTargetsRegistered = false;
        let pendingFounderGrantRenewal = false;
        let childIdentity = existsSync(childRoot)
          ? founderPathBoundary.captureDirectory(childRoot, "Founder venture child")
          : null;
        const childStore = new FileWorkflowStore({ rootDir: inside(childRoot, ".venture/runs") });

        // Recheck the canonical boundary immediately before either continuation
        // or creation. A dry-run path decision must not become authority to
        // follow a symlink introduced before apply.
        resolveVentureOutputWithinRoot(
          canonicalVenturesRoot,
          relative(canonicalVenturesRoot, childRoot),
        );
        if (existsSync(childRoot)) {
          options.pathSecurityHook?.("before-founder-continuation", childRoot);
          founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
          const continuation = validateFounderLaunchContinuation({
            childRoot,
            preparation,
            stackConnectionHash,
            workflowRefSha,
            workflowRepository,
          });
          founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
          transaction = continuation.transaction;
          effectivePreparation = {
            ...preparation,
            launchGrant: continuation.grant,
            materialization: continuation.plan,
          };
          materialized = {
            status: "materialized",
            files: continuation.plan.files.map(({ path }) => path),
            planDigest: continuation.plan.planDigest,
          };
          if (childStore.exists(transaction.runId)) {
            founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
            workflow = childStore.load(transaction.runId);
            founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
          } else if (transaction.status !== "launch_pending") {
            throw new Error(
              `Founder launch transaction is ${transaction.status} but workflow ${transaction.runId} is missing; no continuation was attempted.`,
            );
          } else if (now().getTime() >= Date.parse(continuation.grant.expiresAt)) {
            pendingFounderGrantRenewal = true;
          }
        } else {
          resolveVentureOutputWithinRoot(
            canonicalVenturesRoot,
            relative(canonicalVenturesRoot, stagingRoot),
          );
          if (existsSync(stagingRoot)) {
            throw new Error(
              `Founder launch staging directory already exists: ${stagingRoot}. Inspect that interrupted local materialization before retrying; no provider effect was started by this invocation.`,
            );
          }
          if (!options.launchBindings) {
            await assertFounderBuildAgentHostPolicy(buildAgentHost, preparation.launchGrant);
            buildHostPreflighted = true;
          }
          const registeredTargets = await registerFounderStackWritableCredentialRefs(
            connection,
            {
              ventureSlug: preparation.idea.brief.id,
              domain: preparation.idea.brief.domain,
            },
            credentialBroker,
          );
          for (const target of registeredTargets.inspections) {
            const reference = credentialBroker.getReference(target.ref);
            if (reference) {
              credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
            }
          }
          saveCredentialCatalog(credentialCatalog, catalogPath);
          writableTargetsRegistered = true;

          materialized = await materializeFounderVenture(preparation, stagingRoot);
          const stagingIdentity = founderPathBoundary.captureDirectory(
            stagingRoot,
            "Founder venture staging directory",
          );
          const briefArtifact = ".venture/input/founder-brief.yaml";
          writeYamlAtomic(inside(stagingRoot, briefArtifact), preparation.idea.brief);
          const contractArtifact = preparation.idea.launchContract
            ? "config/launch-contract.yaml"
            : null;
          if (preparation.idea.launchContract && contractArtifact) {
            writeTextAtomic(
              inside(stagingRoot, contractArtifact),
              renderLaunchContractYaml(preparation.idea.launchContract),
            );
            writeTextAtomic(
              inside(stagingRoot, "docs/product/PRODUCT_CONSTITUTION.md"),
              renderProductConstitution(preparation.idea.launchContract),
            );
            writeTextAtomic(
              inside(stagingRoot, "docs/product/idea.md"),
              renderFounderIdea(preparation.idea.launchContract),
            );
          }
          writeJsonAtomic(inside(stagingRoot, ".venture/founder-input.json"), {
            schemaVersion: 1,
            compiledAt: preparation.launchGrant.createdAt,
            sourceHash: preparation.idea.sourceHash,
            briefArtifact,
            assumptions: preparation.idea.assumptionsAdded,
            stackProfile: preparation.stackProfile,
          });
          writeJsonAtomic(
            inside(stagingRoot, ".venture/launch-grant.json"),
            preparation.launchGrant,
          );
          transaction = {
            schemaVersion: 1,
            status: "launch_pending",
            sourceHash: preparation.idea.sourceHash,
            stackProfile: preparation.stackProfile,
            stackConnectionHash,
            grantId: preparation.launchGrant.grantId,
            runId: `launch-${preparation.idea.brief.id}-${preparation.launchGrant.grantId.slice(3, 15)}`,
            planDigest: preparation.materialization.planDigest,
            createdAt: preparation.launchGrant.createdAt,
            updatedAt: now().toISOString(),
          };
          saveFounderLaunchTransaction(stagingRoot, transaction);
          const stagingServices = createDefaultCliServices(childOptions(stagingRoot));
          if (!stagingServices.create)
            throw new Error("Founder child create service is unavailable");
          await stagingServices.create({ brief: contractArtifact ?? briefArtifact, json: true });
          configureFounderProviderTargets(stagingRoot, connection, preparation);
          configureFounderOffer(stagingRoot, preparation);
          mkdirSync(dirname(childRoot), { recursive: true, mode: 0o700 });
          resolveVentureOutputWithinRoot(
            canonicalVenturesRoot,
            relative(canonicalVenturesRoot, childRoot),
          );
          resolveVentureOutputWithinRoot(
            canonicalVenturesRoot,
            relative(canonicalVenturesRoot, stagingRoot),
          );
          options.pathSecurityHook?.("before-founder-staging-rename", childRoot);
          childIdentity = founderPathBoundary.renameDirectory(
            stagingRoot,
            childRoot,
            stagingIdentity,
            "Founder venture staging commit",
          );
        }

        if (!workflow) {
          founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
          if (!options.launchBindings && !buildHostPreflighted) {
            await assertFounderBuildAgentHostPolicy(
              buildAgentHost,
              effectivePreparation.launchGrant,
            );
          }
          if (!writableTargetsRegistered) {
            const registeredTargets = await registerFounderStackWritableCredentialRefs(
              connection,
              {
                ventureSlug: effectivePreparation.idea.brief.id,
                domain: effectivePreparation.idea.brief.domain,
              },
              credentialBroker,
            );
            for (const target of registeredTargets.inspections) {
              const reference = credentialBroker.getReference(target.ref);
              if (reference) {
                credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
              }
            }
            saveCredentialCatalog(credentialCatalog, catalogPath);
          }
        }

        const authorization =
          effectivePreparation.idea.brief.app_kind !== "web" &&
          effectivePreparation.idea.brief.app_kind !== "hybrid"
            ? "mobile-testflight"
            : effectivePreparation.graphDryRun.decision.payment.provider === "none"
              ? "standard-launch"
              : "live-commerce-launch";
        const runId = transaction.runId;
        if (!workflow) {
          founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
          const childServices = createDefaultCliServices(childOptions(childRoot));
          if (!childServices.launch) throw new Error("Founder child launch service is unavailable");
          try {
            workflow = (await childServices.launch({
              mode: "apply",
              authorization,
              runId,
              json: true,
              launchGrant: effectivePreparation.launchGrant,
              founderLaunchGaps: effectivePreparation.launchGaps,
              ...(pendingFounderGrantRenewal ? { pendingFounderGrantRenewal: true as const } : {}),
            })) as unknown as WorkflowRunState;
          } catch (error) {
            if (childStore.exists(runId)) {
              const persisted = childStore.load(runId);
              const persistedStatus: FounderLaunchTransaction["status"] =
                persisted.status === "succeeded"
                  ? "succeeded"
                  : persisted.status === "waiting"
                    ? "waiting_external_action"
                    : ["failed", "cancelled", "superseded"].includes(persisted.status)
                      ? "failed"
                      : "launch_pending";
              transaction = {
                ...transaction,
                status: persistedStatus,
                updatedAt: new Date(
                  Math.max(Date.parse(transaction.updatedAt), now().getTime()),
                ).toISOString(),
              };
              saveFounderLaunchTransaction(childRoot, transaction);
            }
            throw error;
          } finally {
            for (const reference of credentialBroker.list()) {
              credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
            }
            saveCredentialCatalog(credentialCatalog, catalogPath);
          }
        } else if (workflow.status === "waiting") {
          founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
          const childServices = createDefaultCliServices(childOptions(childRoot));
          if (!childServices.resume) throw new Error("Founder child resume service is unavailable");
          try {
            workflow = await childServices.resume({ runId });
            founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
          } catch (error) {
            if (childStore.exists(runId)) {
              const persisted = childStore.load(runId);
              const persistedStatus: FounderLaunchTransaction["status"] =
                persisted.status === "succeeded"
                  ? "succeeded"
                  : persisted.status === "waiting"
                    ? "waiting_external_action"
                    : ["failed", "cancelled", "superseded"].includes(persisted.status)
                      ? "failed"
                      : "launch_pending";
              transaction = {
                ...transaction,
                status: persistedStatus,
                updatedAt: new Date(
                  Math.max(Date.parse(transaction.updatedAt), now().getTime()),
                ).toISOString(),
              };
              saveFounderLaunchTransaction(childRoot, transaction);
            }
            throw error;
          } finally {
            for (const reference of credentialBroker.list()) {
              credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
            }
            saveCredentialCatalog(credentialCatalog, catalogPath);
          }
        }

        const transactionStatus: FounderLaunchTransaction["status"] =
          workflow.status === "succeeded"
            ? "succeeded"
            : workflow.status === "waiting"
              ? "waiting_external_action"
              : ["failed", "cancelled", "superseded"].includes(workflow.status)
                ? "failed"
                : "launch_pending";
        transaction = {
          ...transaction,
          status: transactionStatus,
          updatedAt: new Date(
            Math.max(Date.parse(transaction.updatedAt), now().getTime()),
          ).toISOString(),
        };
        founderPathBoundary.assertDirectory(childRoot, childIdentity!, "Founder venture child");
        saveFounderLaunchTransaction(childRoot, transaction);
        const status = workflow.status === "waiting" ? "waiting_external_action" : workflow.status;
        const nextAction =
          workflow.status === "waiting"
            ? `From ${childRoot}, run vh resume ${runId} with the exact evidence or renewed authorization shown in the launch report.`
            : workflow.status === "succeeded"
              ? `Read reports/launch/${runId}/final.md inside ${childRoot}.`
              : `From ${childRoot}, inspect vh status ${runId} and the launch report before retrying.`;
        return publicFounderPreparation(effectivePreparation, {
          status,
          childRoot,
          runId,
          workflowStatus: workflow.status,
          materialized: {
            status: materialized.status,
            planDigest: materialized.planDigest,
            fileCount: materialized.files.length,
          },
          launchReport: {
            json: `reports/launch/${runId}/final.json`,
            markdown: `reports/launch/${runId}/final.md`,
          },
          launchReceipt: {
            json: `reports/launch/${runId}/receipt.json`,
            markdown: `reports/launch/${runId}/receipt.md`,
          },
          externalEffectsOccurred: Object.keys(workflow.verifiedEffects).length > 0,
          nextAction,
        });
      } finally {
        founderPathBoundary?.release();
      }
    },
    create(request) {
      const source = isAbsolute(request.brief) ? request.brief : resolve(root, request.brief);
      const compiledIdea = compileFounderIdea(readFileSync(source, "utf8"));
      const brief = compiledIdea.brief;
      const decision = compiledIdea.launchContract
        ? launchDecisionFromContract(compiledIdea.launchContract)
        : routeLaunch(brief);
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
      const canonicalArtifacts = compiledIdea.launchContract
        ? persistCanonicalLaunchContract(root, compiledIdea.launchContract)
        : [];
      const contractDigest = compiledIdea.launchContract
        ? launchContractDigest(compiledIdea.launchContract)
        : undefined;
      const state: ProjectState = {
        schemaVersion: 2,
        createdAt: existing?.createdAt ?? synchronizedAt.toISOString(),
        brief,
        decision,
        activeEventPacks,
        routerVersion: LAUNCH_ROUTER_VERSION,
        ...(compiledIdea.launchContract ? { launchContract: compiledIdea.launchContract } : {}),
        ...(contractDigest ? { launchContractDigest: contractDigest } : {}),
      };
      writeJsonAtomic(projectPath(root), state);
      return {
        status: "created",
        projectState: ".venture/project.json",
        updatedContracts: [...updatedContracts, ...canonicalArtifacts],
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
      if (request.brief) {
        const source = isAbsolute(request.brief) ? request.brief : resolve(root, request.brief);
        const idea = compileFounderIdea(readFileSync(source, "utf8"));
        return compileLaunchDryRun(
          idea.brief,
          idea.launchContract ? launchDecisionFromContract(idea.launchContract) : undefined,
        ) as unknown as JsonValue;
      }
      const project = loadProject(root);
      return compileLaunchDryRun(project.brief, project.decision) as unknown as JsonValue;
    },
    async launch(request) {
      const project = loadProject(root);
      const brief = project.brief;
      const compilationOptions = request.launchGrant
        ? ({ initialOrigin: "provider_url" } as const)
        : undefined;
      const dryRun = compileLaunchDryRun(brief, project.decision, compilationOptions);
      if (request.mode === "dry-run") return dryRun as unknown as JsonValue;
      const runId = request.runId ?? generatedRunId(brief, now());
      if (store.exists(runId)) {
        throw new Error(`Run ${runId} already exists. Next: vh resume ${runId}`);
      }
      const policies = policiesSchema.parse(readStructured(inside(root, "config/policies.yaml")));
      const providers = providersSchema.parse(
        readStructured(inside(root, "config/providers.yaml")),
      );
      const launchAt = now();
      let definition = scopeLaunchGraphForAuthorization(
        compileLaunchGraph(brief, project.decision, compilationOptions),
        request.authorization!,
      );
      const pendingFounderTransaction = request.pendingFounderGrantRenewal
        ? loadFounderLaunchTransaction(root)
        : undefined;
      if (request.pendingFounderGrantRenewal) {
        if (!request.launchGrant) {
          throw new Error("Pending founder Grant renewal requires the original Launch Grant");
        }
        const storedGrant = parseLaunchGrant(
          readStructured(inside(root, ".venture/launch-grant.json")),
        );
        if (
          pendingFounderTransaction?.status !== "launch_pending" ||
          pendingFounderTransaction.runId !== runId ||
          pendingFounderTransaction.grantId !== request.launchGrant.grantId ||
          !isDeepStrictEqual(storedGrant, request.launchGrant) ||
          launchAt.getTime() < Date.parse(request.launchGrant.expiresAt)
        ) {
          throw new Error(
            "Pending founder Grant renewal does not match an expired launch_pending transaction",
          );
        }
      }
      const launchGrant = request.launchGrant
        ? assertLaunchGrantBindsGraph({
            grant: request.launchGrant,
            brief,
            decision: project.decision,
            ...(project.launchContract ? { launchContract: project.launchContract } : {}),
            definition,
            providers,
            at: launchAt,
            allowExpiredRenewal: request.pendingFounderGrantRenewal === true,
          })
        : undefined;
      if (launchGrant) {
        definition = bindWorkflowBudgetsToLaunchGrant(definition, launchGrant);
        const expectedProfile =
          brief.app_kind !== "web" && brief.app_kind !== "hybrid"
            ? "mobile_testflight"
            : project.decision.payment.provider === "none"
              ? "standard_launch"
              : "live_commerce_launch";
        if (request.authorization!.replaceAll("-", "_") !== expectedProfile) {
          throw new Error(
            `One-prompt Launch Grant requires authorization profile ${expectedProfile.replaceAll("_", "-")}`,
          );
        }
      }
      const issuedAuthorization = issueAuthorizationEnvelope({
        runId,
        profile: request.authorization!,
        providers: providerIds(definition),
        environments: requiredEnvironmentsForLaunch(definition),
        capabilities: requiredCapabilitiesForLaunch(definition),
        policies,
        approvalRef: launchGrant
          ? request.pendingFounderGrantRenewal
            ? `launch-grant-pre-run-renewal:${launchGrant.grantId}:${sha256Json(
                pendingFounderTransaction,
              ).slice(0, 24)}`
            : `launch-grant:${launchGrant.grantId}`
          : `cli:vh-launch:${request.authorization}`,
        now: launchAt,
      });
      const authorization = launchGrant
        ? authorizationForLaunchGrant(issuedAuthorization, launchGrant)
        : issuedAuthorization;
      const launch: LaunchState = {
        schemaVersion: 2,
        brief,
        decision: project.decision,
        activeEventPacks: project.activeEventPacks,
        routerVersion: project.routerVersion,
        definition,
        authorization,
        ...(launchGrant ? { launchGrant } : {}),
        ...(request.founderLaunchGaps ? { founderLaunchGaps: request.founderLaunchGaps } : {}),
        ...(project.launchContract ? { launchContract: project.launchContract } : {}),
        ...(project.launchContractDigest
          ? { launchContractDigest: project.launchContractDigest }
          : {}),
      };
      if (launchGrant && request.pendingFounderGrantRenewal && pendingFounderTransaction) {
        const authorizationDigest = sha256Json(authorization);
        writeJsonAtomic(founderLaunchGrantRenewalPath(root, authorizationDigest), {
          schemaVersion: 1,
          kind: "founder_pre_run_envelope_renewal",
          runId,
          profile: authorization.profile,
          originalGrantId: launchGrant.grantId,
          originalGrantDigest: sha256Json(launchGrant),
          transactionDigest: sha256Json(pendingFounderTransaction),
          authorizationDigest,
          approvalRef: authorization.approval_ref,
          renewedAt: authorization.issued_at,
          expiresAt: authorization.expires_at,
        });
      }
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
      const persistedState = store.load(request.runId);
      const unfinishedProviderEffects = Object.values(persistedState.nodes).some(
        (record) =>
          record.definition.kind === "provider" &&
          !["succeeded", "compensated", "skipped"].includes(record.state),
      );
      if (request.authorization) {
        const requestedProfile = request.authorization.replaceAll("-", "_");
        if (requestedProfile !== launch.authorization.profile) {
          throw new Error(
            `Run ${request.runId} was created with ${launch.authorization.profile}; renewal must use the same named profile to preserve the persisted graph scope.`,
          );
        }
        const policies = policiesSchema.parse(readStructured(inside(root, "config/policies.yaml")));
        const renewedAt = now();
        if (launch.launchGrant) {
          const providers = providersSchema.parse(
            readStructured(inside(root, "config/providers.yaml")),
          );
          assertLaunchGrantBindsGraph({
            grant: launch.launchGrant,
            brief: launch.brief,
            decision: launch.decision,
            ...(launch.launchContract ? { launchContract: launch.launchContract } : {}),
            definition: launch.definition,
            providers,
            at: renewedAt,
            allowExpiredRenewal: true,
          });
        }
        const issuedAuthorization = issueAuthorizationEnvelope({
          runId: request.runId,
          profile: request.authorization,
          providers: providerIds(launch.definition),
          environments: requiredEnvironmentsForLaunch(launch.definition),
          capabilities: requiredCapabilitiesForLaunch(launch.definition),
          policies,
          approvalRef: launch.launchGrant
            ? `launch-grant-renewal:${launch.launchGrant.grantId}:cli:${request.authorization}`
            : `cli:vh-resume:${request.authorization}`,
          now: renewedAt,
        });
        launch = {
          ...launch,
          authorization: launch.launchGrant
            ? authorizationForLaunchGrant(issuedAuthorization, launch.launchGrant)
            : issuedAuthorization,
        };
        writeJsonAtomic(launchPath(root, request.runId), launch);
      } else {
        if (launch.launchGrant && unfinishedProviderEffects) {
          const checkedAt = now();
          if (checkedAt >= new Date(launch.launchGrant.expiresAt)) {
            throw new Error(
              `Launch Grant ${launch.launchGrant.grantId} expired at ${launch.launchGrant.expiresAt}. Next: vh resume ${request.runId} --authorization ${launch.authorization.profile.replaceAll("_", "-")} to issue a fresh run envelope within the immutable Grant scope.`,
            );
          }
          assertLaunchGrantActive(launch.launchGrant, checkedAt);
        }
        if (Date.parse(launch.authorization.expires_at) <= now().getTime()) {
          if (unfinishedProviderEffects) {
            throw new Error(
              `Authorization envelope for ${request.runId} expired at ${launch.authorization.expires_at}. Next: vh resume ${request.runId} --authorization ${launch.authorization.profile.replaceAll("_", "-")}.`,
            );
          }
        }
      }
      const runtime = await bindingsFor(launch);
      const executor = new WorkflowExecutor({ store, bindings: runtime.bindings });
      for (const [nodeId, record] of Object.entries(persistedState.nodes)) {
        if (record.state !== "waiting_for_auth" || record.definition.kind !== "provider") continue;
        await executor.refreshAuthorization(request.runId, nodeId, {
          authorizedBy: "vh-cli-user",
          note: "Re-probe requested through vh resume because the provider prerequisite may now be resolved outside the run; the provider factory must verify readiness before any effect.",
        });
      }
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
    async stack(request) {
      if (request.action === "connect") {
        if (!request.connection) {
          throw new Error("vh stack connect founder-default requires a credential-free draft");
        }
        const connection = mergeFounderStackRoleRepair(
          founderStackStore.load(request.profileId),
          request.connection,
          request,
        );
        validateFounderStackCredentialWrites(request, connection);
        for (const pending of request.credentialWrites ?? []) {
          if (pending.backend !== "macos_keychain" && pending.backend !== "onepassword") {
            throw new Error("Stack credential writes require macos_keychain or onepassword");
          }
          const value = await pending.readValue();
          if (!value) throw new Error(`No credential value was entered for ${pending.provider}`);
          const reference = await credentialBroker.store({
            ref: pending.reference,
            provider: pending.provider,
            kind: pending.kind,
            backend: pending.backend,
            scopes: pending.scopes,
            ...(pending.accountId ? { accountId: pending.accountId } : {}),
            value,
          });
          credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
          // A successful durable secret write must never be left without its
          // credential-free catalog reference if a later role fails.
          saveCredentialCatalog(credentialCatalog, catalogPath);
        }
        const saved = founderStackStore.save(connection);
        for (const registration of founderStackCliSessionCredentialRegistrations(saved)) {
          const reference = credentialBroker.register(registration);
          credentialCatalog = upsertCredentialReference(credentialCatalog, reference);
        }
        saveCredentialCatalog(credentialCatalog, catalogPath);
        await testFounderStackCredentials(saved);
        return (await doctorFounderStackConnection({
          connection: saved,
          context: { ...effectiveProviderContext, authorization: "dry_run" },
          registry: effectiveProviderRegistry,
          now,
        })) as unknown as JsonValue;
      }
      if (request.action === "create") {
        if (!request.file) {
          throw new Error("vh stack create founder-default requires --file <connection.json>");
        }
        const connection = loadFounderStackConnectionFile(request.file, { baseDir: root });
        const saved = founderStackStore.save(connection);
        return {
          status: "created",
          schemaVersion: saved.schemaVersion,
          profileId: saved.profileId,
          ownerOrganizationId: saved.ownerOrganizationId,
          roleCount: Object.keys(saved.roles).length,
          fixtureOnly: saved.writableCredentialBackend.mode === "fixture",
          valuesExposed: false,
          externalEffects: false,
          nextCommand: "vh stack doctor founder-default",
        } as unknown as JsonValue;
      }
      const connection = founderStackStore.load(request.profileId);
      if (connection && (!options.providerContext || options.dataHttpFetcher !== undefined)) {
        await testFounderStackCredentials(connection);
      }
      return (await doctorFounderStackConnection({
        connection,
        context: { ...effectiveProviderContext, authorization: "dry_run" },
        registry: effectiveProviderRegistry,
        now,
      })) as unknown as JsonValue;
    },
    doctor: async () => {
      const project = existsSync(projectPath(root)) ? loadProject(root) : null;
      const definition = project ? compileLaunchGraph(project.brief, project.decision) : null;
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
        .filter(
          (reference) =>
            (!provider || reference.provider === provider) &&
            (!request.ref || reference.ref === request.ref),
        );
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
        const founderConnection = founderStackStore.load("founder-default");
        const builtInTesters = defaultCredentialTesters(founderConnection);
        const tested = await Promise.all(
          references.map(async (reference) => {
            const tester =
              options.credentialTesters?.[reference.provider] ?? builtInTesters[reference.provider];
            if (tester && reference.kind !== "cli_session") {
              return {
                ref: reference.ref,
                mode: "remote_tester",
                result: await testCredential(reference.ref, reference.provider, tester),
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
        const allPassed =
          tested.length > 0 &&
          tested.every(({ mode, result }) => {
            const outcome = result as { ok?: unknown; status?: unknown };
            return mode === "remote_tester"
              ? outcome.ok === true
              : mode === "official_cli_read" && outcome.status === "available";
          });
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
        return { tested, allPassed, providerDoctor, valuesExposed: false } as unknown as JsonValue;
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
        request.backend ??
        (["github", "vercel", "eas"].includes(provider) && supportsInteractiveCliAuth(provider)
          ? "cli_session"
          : process.platform === "darwin"
            ? "macos_keychain"
            : "onepassword");
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
        credentialBroker.register(reference);
      } else if (backend === "macos_keychain" || backend === "onepassword") {
        if (!request.readValue) {
          throw new Error(
            `vh auth login ${provider} requires an interactive hidden prompt for backend ${backend}; rerun the same command in a terminal without --json.`,
          );
        }
        const value = await request.readValue();
        if (!value) throw new Error(`No credential value was entered for ${provider}.`);
        await credentialBroker.store({ ...reference, value });
      } else {
        credentialBroker.register(reference);
      }
      const storedReference = credentialBroker.getReference(ref) ?? reference;
      credentialCatalog = upsertCredentialReference(credentialCatalog, storedReference);
      saveCredentialCatalog(credentialCatalog, catalogPath);
      references = [storedReference];
      const inspection = await credentialBroker.inspect(ref);
      return {
        status:
          inspection.status !== "available"
            ? "registered"
            : backend === "cli_session"
              ? "authenticated"
              : "credential_stored_not_tested",
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
