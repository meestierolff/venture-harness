import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parse } from "yaml";
import { z } from "zod";
import { loadHarnessLock } from "../config/harness-lock";
import { mobileSchema } from "../config/mobile-schema";
import type { AuthorizationEnvelope } from "../config/policy-schema";
import { routeRail, type FounderBrief, type LaunchDecision } from "../launch";
import type { LaunchContract } from "../founder-launch";
import { Redactor, type CommandRunner } from "../credentials";
import {
  generateMobileScaffold,
  type MobileScaffoldRequest,
  type MobileScaffoldResult,
} from "../mobile";
import {
  WorkflowExecutionError,
  type JsonValue,
  type WorkflowBindings,
  type WorkflowCostCharge,
  type WorkflowHandlerContext,
  type WorkflowHandlerResult,
  type WorkflowReconciliationContext,
  type WorkflowReconciliationResult,
  type WorkflowRunState,
} from "../workflow";
import type {
  BuildAgentArtifactRole,
  BuildAgentCompletionArtifact,
  BuildAgentHost,
  BuildAgentResult,
} from "./build-agent-host";
import { createBuildContextManifest } from "./build-context-manifest";
import {
  launchReceiptPrimaryJourneyEvidenceSchema,
  type LaunchReceipt,
  type LaunchReceiptPrimaryJourneyEvidence,
} from "./launch-receipt";

export const PRIMARY_JOURNEY_SPEC_PATH = "tests/e2e/primary-journey.spec.ts";
export const PRIMARY_JOURNEY_CONTRACT_PATH = "tests/e2e/primary-journey.contract.json";
export const PRIMARY_JOURNEY_CLEANUP_SPEC_PATH = "tests/e2e/primary-journey-cleanup.spec.ts";

const AGENT_TASKS: Readonly<Record<string, string>> = {
  "launch.prepareRepository":
    "Complete the first and primary bounded product-build call. Inspect the selected rail and compact Launch Contract context, then create or adapt only the smallest venture-owned scaffold needed for the brief. In this same coherent pass, refine the venture proposition, implement one original accessible responsive design direction, build the declared primary journey and affected tests, and wire only the minimum privacy-safe capability-driven event instrumentation. Use only the exact reviewed dependencies and scripts already present; do not modify package.json, pnpm-lock.yaml, or config/package-execution-policy.json. If an indispensable package is absent, report that precise blocker. Include only selected-mode evidence: one validation gate for validate-first, bounded human operations for concierge-first, or real usage/failure/deletion proof for product-first. Preserve managed contracts and existing venture-owned work. Record assumptions instead of inventing non-critical detail. Do not regenerate standard infrastructure that the seed already provides. For a canonical web Launch Contract, create tests/e2e/primary-journey.spec.ts as the product-specific Playwright path, tests/e2e/primary-journey-cleanup.spec.ts as its independently runnable cleanup, and tests/e2e/primary-journey.contract.json as their machine-readable binding. The binding must contain schemaVersion 1, scope product_specific_end_to_end, the exact Launch Contract primarySuccessSignal as journeyId, the exact ordered Launch Contract primaryJourney strings as steps, both exact spec paths, launchContractPath config/launch-contract.yaml, a visibly TEST/SYNTHETIC/FIXTURE-labeled identity, required-and-verified cleanup, allowedEffects containing reversible_external_write plus transactional_email only when needed and separately authorized, and the unique complete forbidden-effect list supplied in context. Both specs must read that binding and require VH_PRIMARY_JOURNEY_RUN_ID, VH_PRIMARY_JOURNEY_NONCE, and VH_PRIMARY_JOURNEY_TEST_IDENTITY. After observed success, each desktop/mobile test prints exactly `VH_PRIMARY_JOURNEY_RESULT ` followed by JSON with schemaVersion=1, phase, the runId and nonce environment values, contract journeyId and steps, testInfo.project.name, contract identity, observedEffects, recipientCount, recipientsAllMatchTestIdentity, and forbiddenEffectsObserved=[]. Cleanup markers additionally include cleanup={state:'verified',removedWrites,remainingWrites:0} only after read-back. The cleanup spec must remove only the labeled test identity's reversible writes. A customer charge or checkout, unrelated deletion, DNS/provider configuration, bulk/cold send, recipient outside the test identity, or irreversible publication is forbidden. The seed's generic post-deploy-readonly surface check is never journey proof.",
  "launch.reviewProduct":
    "Perform the second and final normal product-build call as an independent reviewer. Exercise the primary journey and inspect proposition clarity, venture-specific design, responsive/mobile behavior, accessibility, truthfulness, labeled samples, relevant event privacy and exact displayed-price recording. Run direct affected checks, repair only observed defects, and do not broaden product scope or mutate dependency manifests/lockfiles. Return typed evidence for the reviewed core journey, affected tests, design implementation, and event instrumentation. For a canonical web Launch Contract, independently read tests/e2e/primary-journey.contract.json, confirm its journeyId and ordered steps exactly match config/launch-contract.yaml, and run both tests/e2e/primary-journey.spec.ts and tests/e2e/primary-journey-cleanup.spec.ts directly. Confirm production uses only the labeled test identity, the bounded authorized effects, and cleanup read-back; no model-authored step may widen authority. Keep the seed's generic post-deploy-readonly check separate. If a blocker remains, state it exactly instead of claiming completion.",
  "launch.designDirection":
    "Create and implement an original, accessible visual direction for the smallest core journey. Record the design thesis, tokens, responsive composition, accessibility constraints, and anti-template audit. Do not copy a reference identity or fabricate product proof.",
  "launch.buildCoreJourney":
    "Implement the smallest useful core journey declared by the brief on the selected rail. Add affected tests, label sample or synthetic data, keep public claims within PRODUCT_TRUTH, and avoid unrelated features.",
  "launch.configureEventPack":
    "Resolve and wire only the capability-driven analytics event packs needed by this core journey. Keep private form/search/user content out of analytics, require consent for third-party analytics, and include exact displayed prices on price-bearing evidence events.",
  "launch.defineValidationGate":
    "Define one bounded demand hypothesis, its primary signal, threshold, stop rule, assumptions, and evidence that would change the decision. Treat 30/60/90-day gates as optional for validate-first only. Do not require a pricing experiment without adequate traffic and decision value.",
  "launch.prepareConciergeOperations":
    "Define the smallest honest concierge delivery workflow. Specify capacity, privacy boundaries, service limits, failure escalation, human handoffs, evidence capture, and which work remains intentionally manual. Do not imply automation that does not exist.",
  "launch.defineUsageProof":
    "Connect the real core journey to bounded activation, usage, retention, quality, failure, and deletion evidence. Prefer first-party behavioral evidence, keep private content out of analytics, and do not infer causation from release timing alone.",
};

const PRIMARY_JOURNEY_OBSERVER_INSTRUCTIONS =
  " The journey contract production block must also declare readBack={method:'GET',path:'/api/<venture-specific-path>',protocol:'venture_harness_primary_journey_v1'}. Implement that read-only endpoint so the locked harness observer can independently query the exact runId, nonce, journeyId, and test-identity label after the journey and after cleanup. Journey read-back must return the exact ordered completedSteps and at least one labeled reversible write with a stable ID and verified/published state; cleanup read-back must return zero writes plus the exact removed write IDs. Wrap every immutable Launch Contract step in test.step(step) in order and perform a real browser navigation/input/control action and assertion for it; a visit plus a trivial assertion or stdout markers alone is not evidence.";

const QUALITY_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "launch.verifyLocal": ["verify:fast"],
  "launch.verifyMvp": ["verify:mvp"],
};

export const CHILD_DEPENDENCY_INSTALL_ARGS = [
  "install",
  "--frozen-lockfile",
  "--ignore-workspace",
] as const;

const DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION = 1;
const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

const packageExecutionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    packageManager: z.literal("pnpm@9.15.9"),
    scripts: z.record(z.string(), z.string()),
    dependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string()),
    pnpm: z.object({ onlyBuiltDependencies: z.array(z.string()).length(0) }).strict(),
    lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

class NonRegularFileError extends Error {}

interface DependencyInstallCheckpoint {
  schemaVersion: typeof DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION;
  packageManifest: "package.json";
  packageManifestSha256: string;
  lockfile: "pnpm-lock.yaml";
  lockfileSha256: string;
}

interface DependencyInstallReadBack extends DependencyInstallCheckpoint {
  state: "verified" | "not_applied" | "input_mismatch";
  installedModulesReadBack: boolean;
  installedLockfileReadBack: boolean;
  requiredToolingReadBack: boolean;
  message: string | null;
}

const POST_DEPLOY_SURFACE_TEST_ARGS = [
  "exec",
  "playwright",
  "test",
  "tests/e2e/post-deploy-readonly.spec.ts",
  "--retries=0",
] as const;

const POST_DEPLOY_SURFACE_SPEC_PATH = "tests/e2e/post-deploy-readonly.spec.ts";

const POST_DEPLOY_PRIMARY_JOURNEY_ARGS = [
  "exec",
  "playwright",
  "test",
  PRIMARY_JOURNEY_SPEC_PATH,
  "--retries=0",
  "--trace=on",
] as const;

const POST_DEPLOY_PRIMARY_CLEANUP_ARGS = [
  "exec",
  "playwright",
  "test",
  PRIMARY_JOURNEY_CLEANUP_SPEC_PATH,
  "--retries=0",
  "--trace=on",
] as const;
const POST_DEPLOY_PRIMARY_OBSERVER_ARGS = [
  "exec",
  "playwright",
  "test",
  POST_DEPLOY_SURFACE_SPEC_PATH,
  "--retries=0",
] as const;

const productionJourneyOperationCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("production_primary_journey"),
    deploymentUrl: z.string().url(),
    runId: z.string().min(1).max(128),
    nonce: z.string().regex(/^[a-f0-9]{48}$/u),
    journeyId: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
    identityLabel: z.string().trim().min(1).max(200),
  })
  .strict();

const PRIMARY_JOURNEY_FORBIDDEN_EFFECTS = [
  "customer_charge",
  "checkout",
  "external_delete",
  "dns_or_provider_configuration",
  "bulk_or_cold_send",
  "recipient_outside_test_identity",
  "irreversible_publication",
] as const;

const primaryJourneyTestContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.literal("product_specific_end_to_end"),
    journeyId: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
    steps: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    specPath: z.literal(PRIMARY_JOURNEY_SPEC_PATH),
    cleanupSpecPath: z.literal(PRIMARY_JOURNEY_CLEANUP_SPEC_PATH),
    launchContractPath: z.literal("config/launch-contract.yaml"),
    production: z
      .object({
        effect: z.literal("reversible_external_write"),
        identity: z
          .object({
            kind: z.literal("labeled_test_identity"),
            label: z.string().trim().min(1).max(200),
          })
          .strict(),
        cleanup: z.literal("required_and_verified"),
        readBack: z
          .object({
            method: z.literal("GET"),
            path: z.string().regex(/^\/api\/[a-z0-9][a-z0-9/_-]{0,199}$/u),
            protocol: z.literal("venture_harness_primary_journey_v1"),
          })
          .strict(),
        allowedEffects: z
          .array(z.enum(["reversible_external_write", "transactional_email"]))
          .min(1)
          .max(2),
        forbiddenEffects: z
          .array(
            z.enum([
              "customer_charge",
              "checkout",
              "external_delete",
              "dns_or_provider_configuration",
              "bulk_or_cold_send",
              "recipient_outside_test_identity",
              "irreversible_publication",
            ]),
          )
          .length(PRIMARY_JOURNEY_FORBIDDEN_EFFECTS.length),
      })
      .strict()
      .superRefine((value, context) => {
        if (!value.allowedEffects.includes(value.effect)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["allowedEffects"],
            message: "must contain the declared reversible_external_write effect",
          });
        }
        if (
          JSON.stringify([...new Set(value.forbiddenEffects)].sort()) !==
          JSON.stringify([...PRIMARY_JOURNEY_FORBIDDEN_EFFECTS].sort())
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["forbiddenEffects"],
            message: "must be the unique complete canonical forbidden-effect set",
          });
        }
      }),
  })
  .strict();

type PrimaryJourneyTestContract = z.infer<typeof primaryJourneyTestContractSchema>;

const PRIMARY_JOURNEY_MARKER_PREFIX = "VH_PRIMARY_JOURNEY_RESULT ";
const DEPLOYMENT_SURFACE_MARKER_PREFIX = "VH_DEPLOYMENT_SURFACE_RESULT ";
const PRIMARY_JOURNEY_OBSERVER_MARKER_PREFIX = "VH_PRIMARY_JOURNEY_OBSERVER_RESULT ";
const PRIMARY_JOURNEY_RUN_ID_ENV = "VH_PRIMARY_JOURNEY_RUN_ID";
const PRIMARY_JOURNEY_NONCE_ENV = "VH_PRIMARY_JOURNEY_NONCE";
const PRIMARY_JOURNEY_TEST_IDENTITY_ENV = "VH_PRIMARY_JOURNEY_TEST_IDENTITY";
const PRIMARY_JOURNEY_OBSERVER_PHASE_ENV = "VH_PRIMARY_JOURNEY_OBSERVER_PHASE";

const productionJourneyMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(["journey", "cleanup"]),
    runId: z.string().min(1).max(128),
    nonce: z.string().regex(/^[a-f0-9]{48}$/u),
    journeyId: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
    steps: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    project: z.enum(["desktop-chromium", "mobile-chromium"]),
    identity: z
      .object({ kind: z.literal("labeled_test_identity"), label: z.string().min(1).max(200) })
      .strict(),
    observedEffects: z.array(z.enum(["reversible_external_write", "transactional_email"])).max(2),
    recipientCount: z.number().int().nonnegative(),
    recipientsAllMatchTestIdentity: z.boolean(),
    forbiddenEffectsObserved: z.array(z.never()).length(0),
    cleanup: z
      .object({
        state: z.literal("verified"),
        removedWrites: z.number().int().nonnegative(),
        remainingWrites: z.literal(0),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.phase === "cleanup" && !value.cleanup) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cleanup"], message: "required" });
    }
    if (value.phase === "journey" && value.cleanup) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cleanup"],
        message: "journey marker cannot claim cleanup",
      });
    }
  });

const deploymentSurfaceMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z.enum(["desktop-chromium", "mobile-chromium"]),
    rawServerHtml: z.literal(true),
    accessibilityAxe: z.literal(true),
    accessibleNamesAndLandmarks: z.literal(true),
    keyboardFocus: z.literal(true),
    responsiveOverflow: z.literal(true),
  })
  .strict();

const primaryJourneyObserverMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(["journey_readback", "cleanup_readback"]),
    runId: z.string().min(1).max(128),
    nonce: z.string().regex(/^[a-f0-9]{48}$/u),
    journeyId: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
    identityLabel: z.string().trim().min(1).max(200),
    completedSteps: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    project: z.enum(["desktop-chromium", "mobile-chromium"]),
    writes: z.array(
      z
        .object({
          id: z.string().trim().min(1).max(200),
          label: z.string().trim().min(1).max(200),
          state: z.enum(["verified", "published"]),
        })
        .strict(),
    ),
    removedWriteIds: z.array(z.string().trim().min(1).max(200)),
    remainingWrites: z.number().int().nonnegative(),
  })
  .strict();

type PrimaryJourneyObserverMarker = z.infer<typeof primaryJourneyObserverMarkerSchema>;

export const productionJourneyRuntimeEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.literal("product_specific_end_to_end"),
    runId: z.string().min(1).max(128),
    journeyId: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
    steps: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    identity: z
      .object({ kind: z.literal("labeled_test_identity"), label: z.string().min(1).max(200) })
      .strict(),
    journeyProjects: z.tuple([z.literal("desktop-chromium"), z.literal("mobile-chromium")]),
    cleanupProjects: z.tuple([z.literal("desktop-chromium"), z.literal("mobile-chromium")]),
    traceFiles: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(1_000),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            bytes: z.number().int().min(1_000),
          })
          .strict(),
      )
      .min(4),
    stateReadBack: z
      .object({
        observer: z.literal(POST_DEPLOY_SURFACE_SPEC_PATH),
        journeyProjects: z.tuple([z.literal("desktop-chromium"), z.literal("mobile-chromium")]),
        cleanupProjects: z.tuple([z.literal("desktop-chromium"), z.literal("mobile-chromium")]),
        writeIds: z.array(z.string().trim().min(1).max(200)).min(1),
        completedSteps: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
        remainingWrites: z.literal(0),
      })
      .strict(),
    observedEffects: z.array(z.enum(["reversible_external_write", "transactional_email"])).max(2),
    recipientCount: z.number().int().nonnegative(),
    recipientsAllMatchTestIdentity: z.literal(true),
    forbiddenEffectsObserved: z.array(z.never()).length(0),
    cleanup: z
      .object({
        state: z.literal("verified"),
        removedWrites: z.number().int().nonnegative(),
        remainingWrites: z.literal(0),
      })
      .strict(),
  })
  .strict();

export type ProductionJourneyRuntimeEvidence = z.infer<
  typeof productionJourneyRuntimeEvidenceSchema
>;

export const launchProductionVerificationOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(128),
    evidenceRef: z.string().trim().min(1).max(1_000),
    deploymentUrl: z.string().url(),
    target: z.enum(["verified_provider_production_url", "verified_custom_domain"]),
    customDomain: z
      .object({
        state: z.enum(["not_configured", "waiting", "verified"]),
        origin: z.string().url().nullable(),
      })
      .strict(),
    deploymentSurface: z
      .object({
        scope: z.literal("generic_read_only_deployment_surface"),
        command: z.array(z.string().min(1)).min(1),
        exitCode: z.literal(0),
        verified: z.literal(true),
      })
      .strict(),
    primaryJourneyEvidence: launchReceiptPrimaryJourneyEvidenceSchema,
    runtimeEvidence: productionJourneyRuntimeEvidenceSchema,
    accessibility: z
      .object({
        state: z.enum(["verified", "fixture"]),
        projects: z.tuple([z.literal("desktop-chromium"), z.literal("mobile-chromium")]),
        evidenceRef: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    rawHtml: z
      .object({
        state: z.enum(["verified", "fixture"]),
        evidenceRef: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    cleanup: z
      .object({
        state: z.literal("verified"),
        evidenceRef: z.string().trim().min(1).max(1_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [path, reference] of [
      [["primaryJourneyEvidence", "evidenceRef"], value.primaryJourneyEvidence.evidenceRef],
      [["accessibility", "evidenceRef"], value.accessibility.evidenceRef],
      [["rawHtml", "evidenceRef"], value.rawHtml.evidenceRef],
      [["cleanup", "evidenceRef"], value.cleanup.evidenceRef],
    ] as const) {
      if (reference !== value.evidenceRef) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path],
          message: "must reference this exact run-scoped production evidence artifact",
        });
      }
    }
  });

export type LaunchProductionVerificationOutput = z.infer<
  typeof launchProductionVerificationOutputSchema
>;

export function sameRunLaunchReceiptVerification(
  state: WorkflowRunState,
  customDomainConfigured: boolean,
): {
  accessibility: LaunchReceipt["verification"]["accessibility"];
  rawHtml: LaunchReceipt["verification"]["rawHtml"];
  primaryJourneyEvidence?: LaunchReceiptPrimaryJourneyEvidence;
  deploymentEvidence?: {
    state: "verified" | "fixture";
    productionUrl: string;
    customDomain: string | null;
    evidenceRef: string;
  };
} {
  const customDomainNode = state.nodes["verify-custom-domain"];
  const planned = { accessibility: "planned" as const, rawHtml: "planned" as const };
  if (
    customDomainConfigured &&
    customDomainNode &&
    customDomainNode.attempts > 0 &&
    customDomainNode.state !== "succeeded"
  ) {
    // Once the custom origin was actually selected and attempted, a failure is
    // material. Never silently fall back to earlier provider-URL evidence.
    return planned;
  }
  const nodeId =
    customDomainConfigured && customDomainNode?.state === "succeeded"
      ? "verify-custom-domain"
      : "verify-production";
  const node = state.nodes[nodeId];
  const expectedArtifact = `reports/launch/${state.runId}/product/${nodeId}.json`;
  if (
    !node ||
    node.state !== "succeeded" ||
    !node.effectVerified ||
    node.evidenceArtifact !== expectedArtifact
  ) {
    return planned;
  }
  const parsed = launchProductionVerificationOutputSchema.safeParse(node.output);
  if (
    !parsed.success ||
    parsed.data.runId !== state.runId ||
    parsed.data.evidenceRef !== expectedArtifact
  ) {
    return planned;
  }
  return {
    accessibility: parsed.data.accessibility.state,
    rawHtml: parsed.data.rawHtml.state,
    primaryJourneyEvidence: parsed.data.primaryJourneyEvidence,
    deploymentEvidence: {
      state: parsed.data.primaryJourneyEvidence.state === "fixture" ? "fixture" : "verified",
      productionUrl: parsed.data.deploymentUrl,
      customDomain:
        parsed.data.target === "verified_custom_domain" ? parsed.data.customDomain.origin : null,
      evidenceRef: parsed.data.evidenceRef,
    },
  };
}

interface AgentCompletionPolicy {
  requiredArtifactRoles: readonly BuildAgentArtifactRole[];
  relevantValidator: RegExp;
}

const COMPLETION_POLICIES: Readonly<Record<string, AgentCompletionPolicy>> = {
  "launch.prepareRepository": {
    requiredArtifactRoles: [
      "repository_scaffold",
      "managed_manifest",
      "design_record",
      "design_implementation",
      "core_journey",
      "affected_test",
      "event_contract",
      "event_instrumentation",
    ],
    relevantValidator:
      /(?:journey|e2e|playwright|design|accessib|responsive|analytics|event|consent|pii|\btest\b|verify:(?:fast|mvp)|\bbuild\b)/i,
  },
  "launch.reviewProduct": {
    requiredArtifactRoles: [
      "design_implementation",
      "core_journey",
      "affected_test",
      "event_instrumentation",
    ],
    relevantValidator:
      /(?:journey|e2e|playwright|design|accessib|responsive|analytics|event|consent|pii|\btest\b|verify:(?:fast|mvp)|\bbuild\b)/i,
  },
  "launch.designDirection": {
    requiredArtifactRoles: ["design_record", "design_implementation"],
    relevantValidator:
      /(?:design|accessib|responsive|visual|contrast|playwright|verify:mvp|validate:claims)/i,
  },
  "launch.buildCoreJourney": {
    requiredArtifactRoles: ["core_journey", "affected_test"],
    relevantValidator: /(?:journey|e2e|playwright|\btest\b|verify:(?:fast|mvp)|\bbuild\b)/i,
  },
  "launch.configureEventPack": {
    requiredArtifactRoles: ["event_contract", "event_instrumentation"],
    relevantValidator: /(?:analytics|event|consent|taxonomy|telemetry|instrument|pii|verify:fast)/i,
  },
};

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venture",
  "coverage",
  "node_modules",
  "reports",
]);

const MODEL_PROTECTED_CONTROL_PATHS = new Set([
  "harness.lock",
  "venture.manifest.json",
  "config/connectors.json",
  "config/launch-contract.yaml",
  "config/launch.yaml",
  "config/mobile.yaml",
  "config/offer.yaml",
  "config/policies.yaml",
  "config/providers.yaml",
  "config/venture.yaml",
  "docs/product/PRODUCT_CONSTITUTION.md",
  "docs/product/idea.md",
]);

const LOCK_PROTECTED_OWNERSHIPS = new Set(["core_owned", "harness", "generated"]);

const MODEL_ALLOWED_VOLATILE_PATH_PREFIXES = [
  ".venture/test-results",
  ".venture/private/test-results",
] as const;

interface RepositoryFileState {
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

type RepositorySnapshot = Map<string, string>;

interface RepositoryPreimageFile {
  content: Buffer;
  mode: number;
}

interface RepositoryPreimage {
  files: Map<string, RepositoryPreimageFile>;
  directories: Map<string, number>;
}

interface ProtectedInputSnapshot {
  entries: Map<string, string>;
  protectedPaths: Set<string>;
}

export interface LaunchProductBindingsOptions {
  rootDir: string;
  brief: FounderBrief;
  decision?: LaunchDecision;
  launchContract?: LaunchContract;
  authorization?: AuthorizationEnvelope;
  agentHost: BuildAgentHost;
  commandRunner: CommandRunner;
  redactor?: Redactor;
  now?: () => Date;
  mobileScaffold?: Pick<
    MobileScaffoldRequest,
    "bundleIdentifier" | "appScheme" | "outputDirectory"
  >;
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    return absolute;
  }
  throw new WorkflowExecutionError("UNSAFE_ARTIFACT_PATH", `Path escapes venture root: ${path}`);
}

function repositoryReference(root: string, path: string): { absolute: string; reference: string } {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build-agent path must be a canonical repository-relative reference: ${path}`,
    );
  }
  const absolute = inside(root, path);
  const reference = relative(root, absolute).split(sep).join("/");
  if (reference !== path) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build-agent path is not canonical: ${path}`,
    );
  }
  return { absolute, reference };
}

function readRegularFile(path: string): Buffer;
function readRegularFile(path: string, encoding: "utf8"): string;
function readRegularFile(path: string, encoding?: "utf8"): Buffer | string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new NonRegularFileError(`${path} is not one private regular file`);
    }
    return encoding === "utf8" ? readFileSync(descriptor, encoding) : readFileSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new NonRegularFileError(`${path} is not a regular non-symlink file`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unavailableRegularFile(error: unknown): boolean {
  return (
    error instanceof NonRegularFileError ||
    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readRegularFile(path)).digest("hex");
}

function sha256IfRegular(path: string): string | null {
  try {
    return sha256(path);
  } catch (error) {
    if (unavailableRegularFile(error)) return null;
    throw error;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPackageExecutionPolicy(root: string): boolean {
  // Pre-v0.2 fixture repositories have no venture manifest and never cross the
  // generated-child publication boundary. Materialized ventures always do.
  if (!existsSync(inside(root, "venture.manifest.json"))) return false;
  const policyReference = "config/package-execution-policy.json";
  const policyPath = inside(root, policyReference);
  const packagePath = inside(root, "package.json");
  const lockfilePath = inside(root, "pnpm-lock.yaml");
  let policy: z.infer<typeof packageExecutionPolicySchema>;
  let packageManifest: Record<string, unknown>;
  try {
    policy = packageExecutionPolicySchema.parse(JSON.parse(readRegularFile(policyPath, "utf8")));
    const parsedPackage = JSON.parse(readRegularFile(packagePath, "utf8")) as unknown;
    if (!parsedPackage || typeof parsedPackage !== "object" || Array.isArray(parsedPackage)) {
      throw new Error("package.json must contain one JSON object");
    }
    packageManifest = parsedPackage as Record<string, unknown>;
  } catch {
    throw new WorkflowExecutionError(
      "PACKAGE_EXECUTION_POLICY_INVALID",
      "The generated child package execution policy or package manifest is missing or invalid.",
    );
  }
  const lock = loadHarnessLock(inside(root, "harness.lock"));
  const managedPolicy = lock.managed_files.find(({ path }) => path === policyReference);
  const actualPolicySha256 = sha256(policyPath);
  if (
    managedPolicy?.ownership !== "core_owned" ||
    managedPolicy.sha256 === null ||
    managedPolicy.sha256 !== actualPolicySha256
  ) {
    throw new WorkflowExecutionError(
      "PACKAGE_EXECUTION_POLICY_TAMPERED",
      "The package execution policy must match its Core-owned harness.lock digest.",
    );
  }
  const allowedKeys = new Set([
    "name",
    "version",
    "private",
    "type",
    "packageManager",
    "engines",
    "scripts",
    "dependencies",
    "devDependencies",
    "pnpm",
  ]);
  if (Object.keys(packageManifest).some((key) => !allowedKeys.has(key))) {
    throw new WorkflowExecutionError(
      "PACKAGE_EXECUTION_POLICY_VIOLATION",
      "package.json contains an unreviewed package-manager control field.",
    );
  }
  const expectedSurfaces = {
    packageManager: policy.packageManager,
    scripts: policy.scripts,
    dependencies: policy.dependencies,
    devDependencies: policy.devDependencies,
    pnpm: policy.pnpm,
  };
  const actualSurfaces = {
    packageManager: packageManifest.packageManager,
    scripts: packageManifest.scripts,
    dependencies: packageManifest.dependencies,
    devDependencies: packageManifest.devDependencies ?? {},
    pnpm: packageManifest.pnpm,
  };
  if (stableJson(actualSurfaces) !== stableJson(expectedSurfaces)) {
    throw new WorkflowExecutionError(
      "PACKAGE_EXECUTION_POLICY_VIOLATION",
      "Package scripts, dependencies, or lifecycle policy differ from the reviewed Core contract.",
    );
  }
  if (sha256(lockfilePath) !== policy.lockfileSha256) {
    throw new WorkflowExecutionError(
      "PACKAGE_EXECUTION_POLICY_VIOLATION",
      "pnpm-lock.yaml differs from the reviewed Core dependency graph.",
    );
  }
  return true;
}

function assertCoreOwnedSurfaceSpec(root: string): void {
  let lock: ReturnType<typeof loadHarnessLock>;
  let actual: string;
  try {
    lock = loadHarnessLock(inside(root, "harness.lock"));
    actual = sha256(inside(root, POST_DEPLOY_SURFACE_SPEC_PATH));
  } catch (error) {
    throw new WorkflowExecutionError(
      "DEPLOYMENT_SURFACE_CONTRACT_INVALID",
      `Core-owned deployment-surface contract or harness.lock is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
  const entry = lock.managed_files.find(({ path }) => path === POST_DEPLOY_SURFACE_SPEC_PATH);
  if (entry?.ownership !== "core_owned" || entry.sha256 === null || entry.sha256 !== actual) {
    throw new WorkflowExecutionError(
      "DEPLOYMENT_SURFACE_CONTRACT_TAMPERED",
      `${POST_DEPLOY_SURFACE_SPEC_PATH} must match its exact core-owned harness.lock digest before execution.`,
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
}

interface PlaywrightTraceEvidence {
  traceFiles: readonly { path: string; sha256: string; bytes: number }[];
}

function zipEntries(archive: Buffer): Map<string, Buffer> {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("trace archive has no ZIP directory");
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP directory");
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid ZIP entry");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    entries.set(
      name,
      method === 0
        ? Buffer.from(compressed)
        : method === 8
          ? inflateRawSync(compressed)
          : (() => {
              throw new Error(`unsupported ZIP compression method ${method}`);
            })(),
    );
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function traceProvesBrowserJourney(
  traces: readonly Buffer[],
  expectedOrigin: string,
  steps: readonly string[],
  phase: "journey" | "cleanup",
): boolean {
  const events = traces
    .flatMap((trace) => trace.toString("utf8").split(/\r?\n/u))
    .flatMap((line) => {
      if (!line) return [];
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const serialized = events.map((event) => JSON.stringify(event)).join("\n");
  if (!serialized.includes(expectedOrigin)) return false;
  const beforeById = new Map(
    events
      .filter(({ type, callId }) => type === "before" && typeof callId === "string")
      .map((event) => [event.callId as string, event]),
  );
  const succeeded = new Set(
    events
      .filter(
        ({ type, callId, error }) =>
          type === "after" && typeof callId === "string" && error === undefined,
      )
      .map(({ callId }) => callId as string),
  );
  const successfulAssertions = [...beforeById.entries()].filter(
    ([callId, event]) => succeeded.has(callId) && /expect|assert/iu.test(JSON.stringify(event)),
  );
  const successfulActions = [...beforeById.entries()].filter(
    ([callId, event]) =>
      succeeded.has(callId) &&
      /navigate|goto|click|fill|check|press|select|tap|request\.(?:get|post|put|patch|delete)/iu.test(
        JSON.stringify(event),
      ),
  );
  if (successfulAssertions.length < 1 || successfulActions.length < 1) return false;
  if (phase === "cleanup") return true;
  const parentContainsStep = (event: Record<string, unknown>, step: string): boolean => {
    let parentId = typeof event.parentId === "string" ? event.parentId : null;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = beforeById.get(parentId);
      if (!parent) return false;
      if (parent.title === step) return true;
      parentId = typeof parent.parentId === "string" ? parent.parentId : null;
    }
    return false;
  };
  return steps.every(
    (step) =>
      [...beforeById.values()].some(({ title }) => title === step) &&
      successfulActions.some(([, event]) => parentContainsStep(event, step)) &&
      successfulAssertions.some(([, event]) => parentContainsStep(event, step)),
  );
}

function playwrightTraceEvidence(
  root: string,
  outputReference: string,
  deploymentUrl: string,
  contract: PrimaryJourneyTestContract,
): PlaywrightTraceEvidence {
  const outputRoot = inside(root, outputReference);
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === "trace.zip") {
        const stat = lstatSync(absolute);
        if (stat.size < 1_000) continue;
        const entries = zipEntries(readRegularFile(absolute));
        const traces = [...entries.entries()]
          .filter(([name]) => name.endsWith(".trace") || name.endsWith(".network"))
          .map(([, content]) => content);
        const normalized = relative(outputRoot, absolute).split(sep).join("/");
        const phase = normalized.startsWith("journey/")
          ? "journey"
          : normalized.startsWith("cleanup/")
            ? "cleanup"
            : null;
        if (!phase || !traceProvesBrowserJourney(traces, deploymentUrl, contract.steps, phase)) {
          continue;
        }
        files.push({
          path: relative(root, absolute).split(sep).join("/"),
          sha256: sha256(absolute),
          bytes: stat.size,
        });
      }
    }
  };
  try {
    if (!lstatSync(outputRoot).isDirectory()) throw new Error("not a directory");
    visit(outputRoot);
  } catch {
    // Missing trace output is handled by the exact-count check below.
  }
  const phases = files.map(({ path }) =>
    path.includes("/journey/") ? "journey" : path.includes("/cleanup/") ? "cleanup" : "other",
  );
  if (
    phases.filter((phase) => phase === "journey").length < 2 ||
    phases.filter((phase) => phase === "cleanup").length < 2
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_TRACE_EVIDENCE_MISSING",
      "Marker-only output is not journey proof: product journey and cleanup must produce current-run Playwright traces for desktop and mobile.",
    );
  }
  return { traceFiles: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

function primaryJourneyTestContract(
  root: string,
  launchContract: LaunchContract | undefined,
): PrimaryJourneyTestContract {
  if (!launchContract) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_CONTRACT_MISSING",
      "A canonical Launch Contract is required before the product-specific primary journey can be verified.",
    );
  }
  const contractPath = inside(root, PRIMARY_JOURNEY_CONTRACT_PATH);
  const specPath = inside(root, PRIMARY_JOURNEY_SPEC_PATH);
  const cleanupSpecPath = inside(root, PRIMARY_JOURNEY_CLEANUP_SPEC_PATH);
  let parsed: PrimaryJourneyTestContract;
  let spec: string;
  let cleanupSpec: string;
  try {
    parsed = primaryJourneyTestContractSchema.parse(
      JSON.parse(readRegularFile(contractPath, "utf8")),
    );
    spec = readRegularFile(specPath, "utf8");
    cleanupSpec = readRegularFile(cleanupSpecPath, "utf8");
  } catch (error) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_CONTRACT_INVALID",
      `The product build must provide regular non-symlink ${PRIMARY_JOURNEY_SPEC_PATH}, ${PRIMARY_JOURNEY_CLEANUP_SPEC_PATH}, and ${PRIMARY_JOURNEY_CONTRACT_PATH} files: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    parsed.journeyId !== launchContract.decision.primarySuccessSignal ||
    JSON.stringify(parsed.steps) !== JSON.stringify(launchContract.product.primaryJourney)
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_CONTRACT_MISMATCH",
      "The product-specific Playwright binding does not exactly match the Launch Contract primary success signal and ordered journey steps.",
    );
  }
  const requiredRuntimeBindings = [
    "primary-journey.contract.json",
    PRIMARY_JOURNEY_RUN_ID_ENV,
    PRIMARY_JOURNEY_NONCE_ENV,
    PRIMARY_JOURNEY_TEST_IDENTITY_ENV,
    PRIMARY_JOURNEY_MARKER_PREFIX.trim(),
  ];
  if (
    requiredRuntimeBindings.some((binding) => !spec.includes(binding)) ||
    !spec.includes("test.step")
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_SPEC_UNBOUND",
      `${PRIMARY_JOURNEY_SPEC_PATH} must read its machine-readable contract and emit run-, nonce-, identity-, and project-bound runtime evidence.`,
    );
  }
  if (
    requiredRuntimeBindings.some((binding) => !cleanupSpec.includes(binding)) ||
    !cleanupSpec.includes("test.step")
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_CLEANUP_UNBOUND",
      `${PRIMARY_JOURNEY_CLEANUP_SPEC_PATH} must read the same contract and emit verified cleanup read-back for only the labeled test identity.`,
    );
  }
  return parsed;
}

function primaryJourneyEvidence(
  contract: PrimaryJourneyTestContract,
  state: "verified" | "fixture",
  evidenceRef: string,
): LaunchReceiptPrimaryJourneyEvidence {
  return launchReceiptPrimaryJourneyEvidenceSchema.parse({
    scope: contract.scope,
    journeyId: contract.journeyId,
    steps: contract.steps,
    state,
    evidenceRef,
  });
}

function assertProductionJourneyAuthorization(
  authorization: AuthorizationEnvelope | undefined,
  context: Pick<WorkflowHandlerContext, "runId">,
  now: Date,
): AuthorizationEnvelope {
  if (!authorization) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_AUTHORIZATION_MISSING",
      "Production primary-journey verification requires the current run authorization envelope.",
    );
  }
  if (
    authorization.run_id !== context.runId ||
    Date.parse(authorization.expires_at) <= now.getTime() ||
    !authorization.allowed_capabilities.includes("product.primary_journey.verify") ||
    !authorization.allowed_side_effect_classes.includes("reversible_external_write") ||
    !authorization.environments.includes("production") ||
    authorization.profile === "read_only" ||
    authorization.profile === "build_local" ||
    authorization.profile === "preview_launch"
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_AUTHORIZATION_INVALID",
      "The current run envelope does not authorize bounded reversible production primary-journey verification.",
    );
  }
  return authorization;
}

function productionJourneyMarkers(output: string) {
  try {
    return output.split(/\r?\n/u).flatMap((line) => {
      const markerIndex = line.indexOf(PRIMARY_JOURNEY_MARKER_PREFIX);
      if (markerIndex < 0) return [];
      return [
        productionJourneyMarkerSchema.parse(
          JSON.parse(line.slice(markerIndex + PRIMARY_JOURNEY_MARKER_PREFIX.length)),
        ),
      ];
    });
  } catch (error) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_RUNTIME_EVIDENCE_INVALID",
      `Product-specific production journey marker is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function validatedDeploymentSurfaceMarkers(output: string) {
  try {
    const markers = output.split(/\r?\n/u).flatMap((line) => {
      const markerIndex = line.indexOf(DEPLOYMENT_SURFACE_MARKER_PREFIX);
      if (markerIndex < 0) return [];
      return [
        deploymentSurfaceMarkerSchema.parse(
          JSON.parse(line.slice(markerIndex + DEPLOYMENT_SURFACE_MARKER_PREFIX.length)),
        ),
      ];
    });
    const projects = markers.map(({ project }) => project).sort();
    if (JSON.stringify(projects) !== JSON.stringify(["desktop-chromium", "mobile-chromium"])) {
      throw new Error("expected one exact marker from desktop-chromium and mobile-chromium");
    }
    return markers;
  } catch (error) {
    throw new WorkflowExecutionError(
      "POST_DEPLOY_SURFACE_EVIDENCE_INVALID",
      `The deployment surface did not emit exact raw-HTML and accessibility-baseline evidence: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
}

function primaryJourneyObserverMarkers(output: string): PrimaryJourneyObserverMarker[] {
  try {
    return output.split(/\r?\n/u).flatMap((line) => {
      const markerIndex = line.indexOf(PRIMARY_JOURNEY_OBSERVER_MARKER_PREFIX);
      if (markerIndex < 0) return [];
      return [
        primaryJourneyObserverMarkerSchema.parse(
          JSON.parse(line.slice(markerIndex + PRIMARY_JOURNEY_OBSERVER_MARKER_PREFIX.length)),
        ),
      ];
    });
  } catch (error) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_STATE_READBACK_INVALID",
      `The locked observer emitted invalid product-state read-back: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function validatedPrimaryJourneyStateReadBack(
  journeyOutput: string,
  cleanupOutput: string,
  runId: string,
  nonce: string,
  contract: PrimaryJourneyTestContract,
) {
  const journey = primaryJourneyObserverMarkers(journeyOutput);
  const cleanup = primaryJourneyObserverMarkers(cleanupOutput);
  const expectedProjects = ["desktop-chromium", "mobile-chromium"];
  const commonInvalid = (marker: PrimaryJourneyObserverMarker) =>
    marker.runId !== runId ||
    marker.nonce !== nonce ||
    marker.journeyId !== contract.journeyId ||
    marker.identityLabel !== contract.production.identity.label ||
    JSON.stringify(marker.completedSteps) !== JSON.stringify(contract.steps);
  if (
    JSON.stringify(journey.map(({ project }) => project).sort()) !==
      JSON.stringify(expectedProjects) ||
    JSON.stringify(cleanup.map(({ project }) => project).sort()) !==
      JSON.stringify(expectedProjects) ||
    journey.some(
      (marker) =>
        commonInvalid(marker) ||
        marker.phase !== "journey_readback" ||
        marker.writes.length < 1 ||
        marker.removedWriteIds.length !== 0 ||
        marker.remainingWrites !== marker.writes.length ||
        marker.writes.some(({ label }) => label !== contract.production.identity.label),
    ) ||
    cleanup.some(
      (marker) =>
        commonInvalid(marker) ||
        marker.phase !== "cleanup_readback" ||
        marker.writes.length !== 0 ||
        marker.remainingWrites !== 0,
    )
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_STATE_READBACK_MISMATCH",
      "The locked observer must independently read back the exact contract steps and labeled writes after the journey, then zero remaining writes after cleanup on desktop and mobile.",
    );
  }
  const writeIds = [...new Set(journey.flatMap(({ writes }) => writes.map(({ id }) => id)))].sort();
  const removedWriteIds = [...new Set(cleanup.flatMap(({ removedWriteIds: ids }) => ids))].sort();
  if (
    writeIds.length < 1 ||
    journey.some(
      ({ writes }) =>
        JSON.stringify([...new Set(writes.map(({ id }) => id))].sort()) !==
        JSON.stringify(writeIds),
    ) ||
    cleanup.some(
      ({ removedWriteIds: ids }) =>
        JSON.stringify([...new Set(ids)].sort()) !== JSON.stringify(writeIds),
    ) ||
    JSON.stringify(removedWriteIds) !== JSON.stringify(writeIds)
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_STATE_CLEANUP_MISMATCH",
      "Cleanup read-back must remove the exact stable write IDs independently observed after the journey.",
    );
  }
  return {
    observer: POST_DEPLOY_SURFACE_SPEC_PATH as typeof POST_DEPLOY_SURFACE_SPEC_PATH,
    journeyProjects: expectedProjects as ["desktop-chromium", "mobile-chromium"],
    cleanupProjects: expectedProjects as ["desktop-chromium", "mobile-chromium"],
    writeIds,
    completedSteps: contract.steps,
    remainingWrites: 0 as const,
  };
}

function validatedReconciliationCleanupReadBack(
  output: string,
  runId: string,
  nonce: string,
  contract: PrimaryJourneyTestContract,
): void {
  const markers = primaryJourneyObserverMarkers(output);
  if (
    JSON.stringify(markers.map(({ project }) => project).sort()) !==
      JSON.stringify(["desktop-chromium", "mobile-chromium"]) ||
    markers.some(
      (marker) =>
        marker.phase !== "cleanup_readback" ||
        marker.runId !== runId ||
        marker.nonce !== nonce ||
        marker.journeyId !== contract.journeyId ||
        marker.identityLabel !== contract.production.identity.label ||
        JSON.stringify(marker.completedSteps) !== JSON.stringify(contract.steps) ||
        marker.writes.length !== 0 ||
        marker.remainingWrites !== 0,
    )
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_RECONCILIATION_READBACK_MISMATCH",
      "The locked observer did not independently confirm zero labeled writes after reconciliation cleanup on desktop and mobile.",
    );
  }
}

function validatedCleanupMarkers(
  output: string,
  runId: string,
  nonce: string,
  contract: PrimaryJourneyTestContract,
) {
  const markers = productionJourneyMarkers(output);
  const projects = markers.map(({ project }) => project).sort();
  if (
    JSON.stringify(projects) !== JSON.stringify(["desktop-chromium", "mobile-chromium"]) ||
    markers.some(
      (marker) =>
        marker.phase !== "cleanup" ||
        marker.runId !== runId ||
        marker.nonce !== nonce ||
        marker.journeyId !== contract.journeyId ||
        JSON.stringify(marker.steps) !== JSON.stringify(contract.steps) ||
        marker.identity.kind !== contract.production.identity.kind ||
        marker.identity.label !== contract.production.identity.label ||
        marker.recipientsAllMatchTestIdentity !== true ||
        marker.cleanup?.state !== "verified" ||
        marker.cleanup.remainingWrites !== 0,
    )
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_CLEANUP_EVIDENCE_MISMATCH",
      "Cleanup must emit one exact run-, nonce-, identity-, contract-, and project-bound zero-remaining-write read-back for desktop and mobile.",
    );
  }
  return markers;
}

function validateProductionJourneyMarkers(
  primaryOutput: string,
  cleanupOutput: string,
  runId: string,
  nonce: string,
  contract: PrimaryJourneyTestContract,
  authorization: AuthorizationEnvelope,
  fixture: boolean,
  traceEvidence: PlaywrightTraceEvidence,
  stateReadBack: ReturnType<typeof validatedPrimaryJourneyStateReadBack>,
): ProductionJourneyRuntimeEvidence {
  const primaryMarkers = productionJourneyMarkers(primaryOutput);
  const cleanupMarkers = validatedCleanupMarkers(cleanupOutput, runId, nonce, contract);
  const expectedProjects = ["desktop-chromium", "mobile-chromium"] as const;
  const allMarkers = [...primaryMarkers, ...cleanupMarkers];
  const invalidBinding = allMarkers.some(
    (marker) =>
      marker.runId !== runId ||
      marker.nonce !== nonce ||
      marker.journeyId !== contract.journeyId ||
      JSON.stringify(marker.steps) !== JSON.stringify(contract.steps) ||
      marker.identity.kind !== contract.production.identity.kind ||
      marker.identity.label !== contract.production.identity.label,
  );
  const primaryProjects = primaryMarkers.map(({ project }) => project).sort();
  const cleanupProjects = cleanupMarkers.map(({ project }) => project).sort();
  if (
    invalidBinding ||
    primaryMarkers.some(({ phase }) => phase !== "journey") ||
    cleanupMarkers.some(({ phase }) => phase !== "cleanup") ||
    JSON.stringify(primaryProjects) !== JSON.stringify([...expectedProjects].sort()) ||
    JSON.stringify(cleanupProjects) !== JSON.stringify([...expectedProjects].sort())
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_RUNTIME_EVIDENCE_MISMATCH",
      "Production journey markers must contain exactly one run-, nonce-, identity-, contract-, and project-bound journey and cleanup result for desktop and mobile.",
    );
  }
  const observedEffects = [
    ...new Set(primaryMarkers.flatMap(({ observedEffects: effects }) => effects)),
  ];
  if (
    (!fixture && !observedEffects.includes(journeyContractEffect(contract))) ||
    observedEffects.some(
      (effect) =>
        !contract.production.allowedEffects.includes(effect) ||
        !authorization.allowed_side_effect_classes.includes(effect),
    ) ||
    (observedEffects.includes("transactional_email") &&
      !authorization.transactional_test_email_allowed)
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_EFFECT_OUTSIDE_AUTHORIZATION",
      "The product journey reported an effect outside both its reviewed contract and the current run envelope.",
    );
  }
  const recipientCount = Math.max(...primaryMarkers.map(({ recipientCount }) => recipientCount), 0);
  if (
    allMarkers.some(({ recipientsAllMatchTestIdentity }) => !recipientsAllMatchTestIdentity) ||
    recipientCount > authorization.max_email_recipients ||
    (!observedEffects.includes("transactional_email") && recipientCount !== 0)
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_RECIPIENT_OUTSIDE_AUTHORIZATION",
      "Production journey recipients must be bounded by the envelope and match only the labeled test identity.",
    );
  }
  const cleanupRemovedWrites = Math.max(
    ...cleanupMarkers.map(({ cleanup }) => cleanup?.removedWrites ?? 0),
    0,
  );
  return productionJourneyRuntimeEvidenceSchema.parse({
    schemaVersion: 1,
    scope: contract.scope,
    runId,
    journeyId: contract.journeyId,
    steps: contract.steps,
    identity: contract.production.identity,
    journeyProjects: expectedProjects,
    cleanupProjects: expectedProjects,
    traceFiles: traceEvidence.traceFiles,
    stateReadBack,
    observedEffects,
    recipientCount,
    recipientsAllMatchTestIdentity: true,
    forbiddenEffectsObserved: [],
    cleanup: { state: "verified", removedWrites: cleanupRemovedWrites, remainingWrites: 0 },
  });
}

function journeyContractEffect(contract: PrimaryJourneyTestContract): "reversible_external_write" {
  return contract.production.effect;
}

function dependencyInstallCheckpoint(value: unknown): DependencyInstallCheckpoint | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION ||
    record.packageManifest !== "package.json" ||
    record.lockfile !== "pnpm-lock.yaml" ||
    typeof record.packageManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.packageManifestSha256) ||
    typeof record.lockfileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.lockfileSha256)
  ) {
    return null;
  }
  return {
    schemaVersion: DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION,
    packageManifest: "package.json",
    packageManifestSha256: record.packageManifestSha256,
    lockfile: "pnpm-lock.yaml",
    lockfileSha256: record.lockfileSha256,
  };
}

function readDependencyInstallState(
  root: string,
  expected: DependencyInstallCheckpoint,
): DependencyInstallReadBack {
  const packagePath = inside(root, expected.packageManifest);
  const lockPath = inside(root, expected.lockfile);
  const currentPackageSha256 = sha256IfRegular(packagePath);
  const currentLockSha256 = sha256IfRegular(lockPath);
  if (currentPackageSha256 === null || currentLockSha256 === null) {
    return {
      ...expected,
      state: "input_mismatch",
      installedModulesReadBack: false,
      installedLockfileReadBack: false,
      requiredToolingReadBack: false,
      message: "The checkpointed package manifest or lockfile is missing or not a regular file.",
    };
  }

  if (
    currentPackageSha256 !== expected.packageManifestSha256 ||
    currentLockSha256 !== expected.lockfileSha256
  ) {
    return {
      ...expected,
      state: "input_mismatch",
      installedModulesReadBack: false,
      installedLockfileReadBack: false,
      requiredToolingReadBack: false,
      message:
        "package.json or pnpm-lock.yaml changed after the dependency operation was checkpointed.",
    };
  }

  const modulesPath = inside(root, "node_modules");
  const installedModulesReadBack = existsSync(modulesPath) && lstatSync(modulesPath).isDirectory();
  const installedLockPath = inside(root, "node_modules/.pnpm/lock.yaml");
  const installedLockfileReadBack =
    installedModulesReadBack && sha256IfRegular(installedLockPath) === expected.lockfileSha256;
  const binaryDirectory = inside(root, "node_modules/.bin");
  const commandInstalled = (name: string) =>
    [name, `${name}.cmd`, `${name}.ps1`].some((candidate) =>
      existsSync(resolve(binaryDirectory, candidate)),
    );
  const requiredToolingReadBack =
    installedModulesReadBack && commandInstalled("tsc") && commandInstalled("playwright");
  return {
    ...expected,
    state:
      installedModulesReadBack && installedLockfileReadBack && requiredToolingReadBack
        ? "verified"
        : "not_applied",
    installedModulesReadBack,
    installedLockfileReadBack,
    requiredToolingReadBack,
    message:
      installedModulesReadBack && installedLockfileReadBack && requiredToolingReadBack
        ? null
        : "The exact child dependency installation is absent or incomplete on read-back.",
  };
}

function repositorySnapshot(root: string): RepositorySnapshot {
  const snapshot: RepositorySnapshot = new Map();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = resolve(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (metadata.isSymbolicLink()) {
        throw new WorkflowExecutionError(
          "BUILD_AGENT_UNSAFE_FILE_ENTRY",
          `Generated repository contains a symbolic link at ${relative(root, absolute).split(sep).join("/")}; model tasks require private regular files.`,
        );
      }
      if (metadata.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new WorkflowExecutionError(
          "BUILD_AGENT_UNSAFE_FILE_ENTRY",
          `Generated repository contains a non-private or non-regular entry at ${relative(root, absolute).split(sep).join("/")}.`,
        );
      }
      const reference = relative(root, absolute).split(sep).join("/");
      snapshot.set(reference, sha256(absolute));
    }
  };
  visit(root);
  return snapshot;
}

const ROLLBACK_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "node_modules",
]);
const ROLLBACK_MAX_FILE_BYTES = 16 * 1024 * 1024;
const ROLLBACK_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

function repositoryPreimage(root: string): RepositoryPreimage {
  const files = new Map<string, RepositoryPreimageFile>();
  const directories = new Map<string, number>();
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isDirectory() && ROLLBACK_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      const metadata = lstatSync(absolute);
      const reference = relative(root, absolute).split(sep).join("/");
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new WorkflowExecutionError(
          "BUILD_AGENT_UNSAFE_FILE_ENTRY",
          `Cannot establish a rollback preimage for unsafe repository entry ${reference}.`,
        );
      }
      if (metadata.isDirectory()) {
        directories.set(reference, metadata.mode & 0o777);
        visit(absolute);
        continue;
      }
      if (metadata.nlink !== 1 || metadata.size > ROLLBACK_MAX_FILE_BYTES) {
        throw new WorkflowExecutionError(
          "BUILD_AGENT_UNSAFE_FILE_ENTRY",
          `Cannot establish a private bounded rollback preimage for ${reference}.`,
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > ROLLBACK_MAX_TOTAL_BYTES) {
        throw new WorkflowExecutionError(
          "BUILD_AGENT_UNSAFE_FILE_ENTRY",
          "Repository rollback preimage exceeds the 128 MiB founder-alpha limit.",
        );
      }
      files.set(reference, {
        content: readFileSync(absolute),
        mode: metadata.mode & 0o777,
      });
    }
  };
  visit(root);
  return { files, directories };
}

function currentRollbackEntries(root: string): {
  files: Set<string>;
  directories: Set<string>;
} {
  const files = new Set<string>();
  const directories = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ROLLBACK_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      const metadata = lstatSync(absolute);
      const reference = relative(root, absolute).split(sep).join("/");
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        directories.add(reference);
        visit(absolute);
      } else {
        files.add(reference);
      }
    }
  };
  visit(root);
  return { files, directories };
}

function restoreRepositoryPreimage(root: string, preimage: RepositoryPreimage): void {
  const current = currentRollbackEntries(root);
  const removeReferences = [
    ...[...current.files].filter((reference) => !preimage.files.has(reference)),
    ...[...current.directories].filter((reference) => !preimage.directories.has(reference)),
  ].sort((left, right) => right.split("/").length - left.split("/").length);
  for (const reference of removeReferences) {
    rmSync(inside(root, reference), { recursive: true, force: true });
  }

  for (const [reference, mode] of [...preimage.directories.entries()].sort(
    ([left], [right]) => left.split("/").length - right.split("/").length,
  )) {
    const absolute = inside(root, reference);
    if (existsSync(absolute) && !lstatSync(absolute).isDirectory()) {
      rmSync(absolute, { recursive: true, force: true });
    }
    mkdirSync(absolute, { recursive: true, mode });
    chmodSync(absolute, mode);
  }

  for (const [reference, file] of preimage.files) {
    const absolute = inside(root, reference);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    if (existsSync(absolute)) {
      const metadata = lstatSync(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        rmSync(absolute, { recursive: true, force: true });
      }
    }
    const temporary = `${absolute}.rollback-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(temporary, file.content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, absolute);
      chmodSync(absolute, file.mode);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function repositoryChanges(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): RepositoryFileState[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const beforeSha256 = before.get(path) ?? null;
    const afterSha256 = after.get(path) ?? null;
    return beforeSha256 === afterSha256 ? [] : [{ path, beforeSha256, afterSha256 }];
  });
}

function protectedPathState(root: string, reference: string): string {
  const segments = reference.split("/");
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment);
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(cursor);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return "missing";
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) return `symbolic_link:${index}`;
    if (index < segments.length - 1) {
      if (!metadata.isDirectory()) return `non_directory_component:${index}`;
      continue;
    }
    if (metadata.isDirectory()) return "directory";
    if (metadata.isFile()) return `file:${sha256(cursor)}`;
    return "non_regular";
  }
  return "missing";
}

function lockDeclaredProtectedPaths(root: string): string[] {
  const lockPath = inside(root, "harness.lock");
  let value: unknown;
  try {
    value = parse(readRegularFile(lockPath, "utf8"));
  } catch {
    return [];
  }
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  const managedFiles = (value as Record<string, unknown>).managed_files;
  if (!Array.isArray(managedFiles)) return [];
  return managedFiles.flatMap((entry) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.path !== "string" ||
      typeof record.ownership !== "string" ||
      !LOCK_PROTECTED_OWNERSHIPS.has(record.ownership)
    ) {
      return [];
    }
    return [repositoryReference(root, record.path).reference];
  });
}

function protectedInputSnapshot(root: string, handler: string): ProtectedInputSnapshot {
  const protectedPaths = new Set([
    ...MODEL_PROTECTED_CONTROL_PATHS,
    ...lockDeclaredProtectedPaths(root),
    ...(handler === "launch.prepareRepository" ? [] : ["package.json", "pnpm-lock.yaml"]),
  ]);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (/^\.env(?:\.|$)/u.test(entry.name) || entry.name === ".npmrc") {
      protectedPaths.add(entry.name);
    }
  }
  const entries = new Map<string, string>();
  for (const reference of [...protectedPaths].sort()) {
    entries.set(reference, protectedPathState(root, reference));
  }

  const allowedVolatileRoot = (reference: string) =>
    MODEL_ALLOWED_VOLATILE_PATH_PREFIXES.some((prefix) => reference === prefix);
  const visitProtectedTree = (reference: string): void => {
    const state = protectedPathState(root, reference);
    // These parent directories may be created solely to hold disposable
    // Playwright results. Missing <-> directory is allowed, while a file,
    // symlink, or other non-regular replacement remains a protected mutation.
    const volatileParent =
      reference === ".venture" ||
      reference === ".venture/private" ||
      allowedVolatileRoot(reference);
    entries.set(
      reference,
      volatileParent && (state === "missing" || state === "directory")
        ? "allowed_directory"
        : state,
    );
    protectedPaths.add(reference);
    if (allowedVolatileRoot(reference)) return;
    if (state !== "directory") return;
    const directory = inside(root, reference);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      visitProtectedTree(`${reference}/${entry.name}`);
    }
  };
  visitProtectedTree(".venture");
  for (const reference of [".venture/private", ...MODEL_ALLOWED_VOLATILE_PATH_PREFIXES]) {
    if (entries.has(reference)) continue;
    const state = protectedPathState(root, reference);
    entries.set(
      reference,
      state === "missing" || state === "directory" ? "allowed_directory" : state,
    );
    protectedPaths.add(reference);
  }
  visitProtectedTree("reports");
  return { entries, protectedPaths };
}

function protectedInputViolations(
  before: ProtectedInputSnapshot,
  after: ProtectedInputSnapshot,
  reportedPaths: readonly string[],
): string[] {
  const protectedPaths = new Set([...before.protectedPaths, ...after.protectedPaths]);
  const observed = [...new Set([...before.entries.keys(), ...after.entries.keys()])].filter(
    (path) => before.entries.get(path) !== after.entries.get(path),
  );
  const reported = reportedPaths.filter(
    (path) =>
      !MODEL_ALLOWED_VOLATILE_PATH_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      ) &&
      (protectedPaths.has(path) ||
        path === ".venture" ||
        path.startsWith(".venture/") ||
        path === "reports" ||
        path.startsWith("reports/") ||
        /^\.env(?:\.|$)/u.test(path) ||
        path === ".npmrc"),
  );
  return [...new Set([...observed, ...reported])].sort();
}

function artifactRoleAllowsPath(role: BuildAgentArtifactRole, path: string): boolean {
  const productSource = /^(?:app|components|mobile|pages|public|src)\//.test(path);
  const codeOrProductSource = productSource || /^lib\//.test(path);
  switch (role) {
    case "repository_scaffold":
      return (
        productSource ||
        /^(?:package\.json|pnpm-lock\.yaml|tsconfig\.json|next\.config\.[^/]+|vite\.config\.[^/]+)$/.test(
          path,
        )
      );
    case "managed_manifest":
      return path === "harness.lock";
    case "design_record":
      return path === "docs/brand/DESIGN.md" || /^docs\/brand\/[^/]*DESIGN[^/]*\.md$/i.test(path);
    case "design_implementation":
      return (
        productSource ||
        /(?:^|\/)(?:design|styles?|theme|tokens?|ui)(?:\/|\.)/i.test(path) ||
        /\.(?:css|less|sass|scss)$/.test(path)
      );
    case "core_journey":
      return codeOrProductSource;
    case "affected_test":
      return /^(?:tests?|e2e)\//.test(path) || /(?:^|\/)[^/]+\.(?:spec|test)\.[^/]+$/.test(path);
    case "event_contract":
      return (
        path === "config/analytics.yaml" ||
        /^lib\/analytics\//.test(path) ||
        /(?:^|\/)(?:analytics|events?|taxonomy|telemetry)(?:\/|\.)/i.test(path)
      );
    case "event_instrumentation":
      return (
        productSource ||
        (/^lib\//.test(path) &&
          /(?:analytics|consent|events?|instrument|telemetry|track)/i.test(path))
      );
    case "validation_record":
      return /^(?:config|docs)\//.test(path) && /validat|experiment|hypoth/i.test(path);
    case "concierge_operations":
      return /^(?:config|docs|lib)\//.test(path) && /concierge|operation|handoff/i.test(path);
    case "usage_proof":
      return (
        /^(?:config|docs|lib|tests)\//.test(path) &&
        /usage|retention|activation|evidence/i.test(path)
      );
  }
}

function directCheck(command: string): boolean {
  return (
    /^(?:(?:pnpm|npm|yarn|bun|npx|node|deno|swiftc|xcodebuild|cargo|gradle)(?:\s|$)|\.\/scripts\/|scripts\/)/.test(
      command.trim(),
    ) && !/[;&|`$<>]/.test(command)
  );
}

function taskInstructions(
  handler: string,
  instructions: string,
  capabilitiesRequired: readonly string[] = [],
): string {
  const policy = COMPLETION_POLICIES[handler];
  const discoveryRequired = capabilitiesRequired.includes("web_seo_aeo_geo");
  return [
    instructions,
    discoveryRequired
      ? "SEO/AEO/GEO is REQUIRED. Read config/seo.yaml, skills/seo-aeo-engine/SKILL.md, and its technical-discovery reference. Keep one truthful canonical owner per user task; require unique accurate metadata, raw-HTML answers and limitations, self-canonicals, safe sitemap exclusions, page-appropriate parseable visible-fact JSON-LD (or record why no schema type is truthful), and explicit verified-production indexing opt-in. Do not invent queries, traffic, citations, ratings, reviews, people, or provider state."
      : "SEO/AEO/GEO is not selected for this task. Do not add discovery infrastructure or enable indexing.",
    ...(policy
      ? [
          `Completion evidence must include these artifact roles: ${policy.requiredArtifactRoles.join(", ")}.`,
          "For outcome=changed, report every repository file whose content changed and name at least one changed completion artifact. For outcome=already_compliant, change no repository content and cite unchanged artifacts that already satisfy every required role.",
          "The completion validator must name one directly executed, relevant check from checks; it must pass and include observed evidence.",
        ]
      : []),
  ].join("\n\n");
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new WorkflowExecutionError(
      "UNSAFE_ARTIFACT_PATH",
      `${label} cannot be used in a launch evidence path: ${value}`,
    );
  }
  return value;
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

function artifactPaths(root: string, context: WorkflowHandlerContext) {
  const runId = safeSegment(context.runId, "run ID");
  const nodeId = safeSegment(context.node.id, "node ID");
  const reference = `reports/launch/${runId}/product/${nodeId}.json`;
  return { reference, absolute: inside(root, reference) };
}

function dependencyInstallEvidencePaths(
  root: string,
  runIdInput: string,
  nodeIdInput = "install-dependencies",
) {
  const runId = safeSegment(runIdInput, "run ID");
  const nodeId = safeSegment(nodeIdInput, "dependency install node ID");
  const reference = `reports/launch/${runId}/product/${nodeId}.json`;
  return { reference, absolute: inside(root, reference) };
}

function dependencyReconciliationEvidencePaths(
  root: string,
  runIdInput: string,
  nodeIdInput: string,
) {
  const runId = safeSegment(runIdInput, "run ID");
  const nodeId = safeSegment(nodeIdInput, "dependency install node ID");
  const reference = `reports/launch/${runId}/product/${nodeId}.reconcile.json`;
  return { reference, absolute: inside(root, reference) };
}

function checkpointFromInstallEvidence(
  root: string,
  runId: string,
  nodeId: string,
): DependencyInstallCheckpoint | null {
  const paths = dependencyInstallEvidencePaths(root, runId, nodeId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readRegularFile(paths.absolute, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.runId !== runId || record.nodeId !== nodeId) return null;
  return dependencyInstallCheckpoint({
    schemaVersion: DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION,
    packageManifest: record.packageManifest,
    packageManifestSha256: record.packageManifestSha256,
    lockfile: record.lockfile,
    lockfileSha256: record.lockfileSha256,
  });
}

function verifiedChangedFiles(root: string, changedFiles: readonly string[]): string[] {
  const seen = new Set<string>();
  return changedFiles.map((path) => {
    const { absolute, reference } = repositoryReference(root, path);
    if (seen.has(reference)) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_EVIDENCE_INVALID",
        `Build agent reported changed file ${path} more than once.`,
      );
    }
    seen.add(reference);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_EVIDENCE_INVALID",
        `Build agent reported changed file ${path}, but it does not exist after the task.`,
      );
    }
    return reference;
  });
}

interface AgentCompletionValidation {
  changedFiles: string[];
  artifacts: BuildAgentCompletionArtifact[];
  repositoryChanges: RepositoryFileState[];
  validator: { checkCommand: string; evidence: string };
}

function validateAgentCompletion(
  root: string,
  handler: string,
  result: BuildAgentResult,
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  launchContract?: LaunchContract,
): AgentCompletionValidation {
  if (!result.completion) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent completed ${handler} without typed completion evidence.`,
    );
  }

  const changedFiles = verifiedChangedFiles(root, result.changedFiles);
  const changes = repositoryChanges(before, after);
  const changedPaths = new Set(changes.map(({ path }) => path));
  const reportedPaths = new Set(changedFiles);
  const deletedPaths = changes
    .filter(({ afterSha256 }) => afterSha256 === null)
    .map(({ path }) => path);
  if (deletedPaths.length > 0) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent deleted repository files without a typed deletion contract: ${deletedPaths.join(", ")}.`,
    );
  }

  const unreported = changes.map(({ path }) => path).filter((path) => !reportedPaths.has(path));
  const unchanged = changedFiles.filter((path) => !changedPaths.has(path));
  if (unreported.length > 0 || unchanged.length > 0) {
    const details = [
      ...(unreported.length > 0 ? [`unreported changes: ${unreported.join(", ")}`] : []),
      ...(unchanged.length > 0 ? [`unchanged reported files: ${unchanged.join(", ")}`] : []),
    ].join("; ");
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent before/after hash validation failed for ${handler}: ${details}.`,
    );
  }

  if (result.completion.outcome === "changed") {
    if (changedFiles.length === 0 || changes.length === 0) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_EVIDENCE_INVALID",
        `Build agent declared changed completion for ${handler}, but no repository content changed.`,
      );
    }
  } else if (changedFiles.length > 0 || changes.length > 0) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent declared already_compliant for ${handler}, but repository content changed.`,
    );
  }

  const artifacts = result.completion.artifacts.map(({ path, role }) => {
    const { absolute, reference } = repositoryReference(root, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_EVIDENCE_INVALID",
        `Build agent completion artifact ${path} does not exist as a regular file.`,
      );
    }
    if (!artifactRoleAllowsPath(role, reference)) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_EVIDENCE_INVALID",
        `Build agent artifact ${path} cannot satisfy role ${role}.`,
      );
    }
    return { path: reference, role };
  });

  const policy = COMPLETION_POLICIES[handler];
  for (const role of policy?.requiredArtifactRoles ?? []) {
    if (!artifacts.some((artifact) => artifact.role === role)) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_EVIDENCE_INVALID",
        `Build agent completion for ${handler} is missing required artifact role ${role}.`,
      );
    }
  }
  if (launchContract && ["launch.prepareRepository", "launch.reviewProduct"].includes(handler)) {
    for (const path of [
      PRIMARY_JOURNEY_SPEC_PATH,
      PRIMARY_JOURNEY_CLEANUP_SPEC_PATH,
      PRIMARY_JOURNEY_CONTRACT_PATH,
    ]) {
      if (
        !artifacts.some((artifact) => artifact.role === "affected_test" && artifact.path === path)
      ) {
        throw new WorkflowExecutionError(
          "BUILD_AGENT_EVIDENCE_INVALID",
          `Build agent completion for ${handler} must report ${path} as an affected_test artifact.`,
        );
      }
    }
    primaryJourneyTestContract(root, launchContract);
  }
  if (
    result.completion.outcome === "changed" &&
    !artifacts.some(({ path }) => reportedPaths.has(path))
  ) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent changed files for ${handler}, but none of its completion artifacts changed.`,
    );
  }
  if (
    result.completion.outcome === "already_compliant" &&
    artifacts.some(
      ({ path }) => before.get(path) === undefined || before.get(path) !== after.get(path),
    )
  ) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent already_compliant artifacts for ${handler} were not present unchanged before the task.`,
    );
  }

  const checkCommand = result.completion.validator.checkCommand;
  const validator = result.checks.find(({ command }) => command === checkCommand);
  if (
    !directCheck(checkCommand) ||
    validator?.status !== "passed" ||
    !validator.evidence?.trim() ||
    (policy && !policy.relevantValidator.test(checkCommand))
  ) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent completion validator for ${handler} must be a relevant direct passed check with non-empty evidence.`,
    );
  }

  return {
    changedFiles,
    artifacts,
    repositoryChanges: changes,
    validator: { checkCommand, evidence: validator.evidence },
  };
}

function persistEvidence(
  root: string,
  context: WorkflowHandlerContext,
  evidence: unknown,
  redactor: Redactor,
): string {
  const paths = artifactPaths(root, context);
  writeJsonAtomic(paths.absolute, redactor.redact(evidence));
  const readBack = JSON.parse(readRegularFile(paths.absolute, "utf8")) as {
    runId?: string;
    nodeId?: string;
  };
  if (readBack.runId !== context.runId || readBack.nodeId !== context.node.id) {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Launch evidence read-back failed for ${context.node.id}.`,
    );
  }
  return paths.reference;
}

function hostOutput(result: BuildAgentResult): JsonValue {
  return {
    status: result.status,
    summary: result.summary,
    changedFiles: result.changedFiles,
    checks: result.checks,
    limitations: result.limitations,
    completion: result.completion,
    host: "build_agent",
    usage: result.usage ?? null,
  } as unknown as JsonValue;
}

function configuredMobileScaffold(
  root: string,
  brief: FounderBrief,
  explicit: LaunchProductBindingsOptions["mobileScaffold"],
): LaunchProductBindingsOptions["mobileScaffold"] {
  const configPath = inside(root, "config/mobile.yaml");
  let configured: ReturnType<typeof mobileSchema.parse>["mobile"] | undefined;
  try {
    configured = mobileSchema.parse(parse(readRegularFile(configPath, "utf8"))).mobile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    bundleIdentifier:
      explicit?.bundleIdentifier ??
      configured?.bundle_identifier ??
      brief.bundle_identifier ??
      undefined,
    appScheme: explicit?.appScheme ?? configured?.app_scheme ?? brief.app_scheme ?? brief.id,
    outputDirectory: explicit?.outputDirectory,
  };
}

async function runMobileScaffoldTask(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "brief">> & {
    redactor: Redactor;
    now: () => Date;
    mobileScaffold?: LaunchProductBindingsOptions["mobileScaffold"];
  },
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
  const rail = routeRail(options.brief);
  if (rail.mobileStack === "none" || rail.mobileStack === "auto") {
    throw new WorkflowExecutionError(
      "MOBILE_SCAFFOLD_ROUTE_INVALID",
      `The mobile scaffold handler requires a concrete mobile stack; received ${rail.mobileStack}.`,
    );
  }

  let result: MobileScaffoldResult;
  try {
    const scaffold = configuredMobileScaffold(
      options.rootDir,
      options.brief,
      options.mobileScaffold,
    );
    result = generateMobileScaffold(options.rootDir, {
      stack: rail.mobileStack,
      ventureId: options.brief.id,
      displayName: options.brief.name,
      bundleIdentifier: scaffold?.bundleIdentifier,
      appScheme: scaffold?.appScheme,
      outputDirectory: scaffold?.outputDirectory,
    });
  } catch (error) {
    const evidenceArtifact = persistEvidence(
      options.rootDir,
      context,
      {
        schemaVersion: 1,
        runId: context.runId,
        nodeId: context.node.id,
        handler: context.node.handler,
        host: "repo_native_mobile_scaffold",
        startedAt,
        finishedAt: options.now().toISOString(),
        status: "failed",
        stack: rail.mobileStack,
        error: options.redactor.redactText(error instanceof Error ? error.message : String(error)),
      },
      options.redactor,
    );
    throw new WorkflowExecutionError(
      "MOBILE_SCAFFOLD_FAILED",
      `Mobile scaffold generation failed; inspect ${evidenceArtifact}.`,
    );
  }

  const verifiedFiles = [result.manifestPath, ...result.manifest.files.map(({ path }) => path)];
  verifiedChangedFiles(options.rootDir, verifiedFiles);
  const output = {
    status: "completed",
    summary:
      result.createdFiles.length > 0
        ? `Created the ${result.manifest.stack} local prototype scaffold without overwriting existing files.`
        : `Verified the existing ${result.manifest.stack} local prototype scaffold without changing files.`,
    changedFiles: result.createdFiles,
    unchangedFiles: result.unchangedFiles,
    checks: [
      {
        command: "repo-native mobile scaffold schema, create-only preflight, and hash read-back",
        status: "passed",
        evidence: result.manifestPath,
      },
    ],
    limitations: result.manifest.limitations,
    host: "repo_native_mobile_scaffold",
    scaffold: {
      stack: result.manifest.stack,
      outputDirectory: result.manifest.outputDirectory,
      manifestPath: result.manifestPath,
      identity: result.manifest.identity,
      safeguards: result.manifest.safeguards,
    },
  } as unknown as JsonValue;
  const evidenceArtifact = persistEvidence(
    options.rootDir,
    context,
    {
      schemaVersion: 1,
      runId: context.runId,
      nodeId: context.node.id,
      handler: context.node.handler,
      host: "repo_native_mobile_scaffold",
      startedAt,
      finishedAt: options.now().toISOString(),
      result: output,
      verifiedChangedFiles: verifiedFiles,
      rawPromptPersisted: false,
      rawJsonlPersisted: false,
    },
    options.redactor,
  );
  context.trace({
    host: "repo_native_mobile_scaffold",
    evidenceArtifact,
    stack: result.manifest.stack,
  });
  return { output, effectVerified: true, evidenceArtifact };
}

type AgentTaskOptions = Required<
  Pick<LaunchProductBindingsOptions, "rootDir" | "brief" | "agentHost">
> &
  Pick<LaunchProductBindingsOptions, "decision" | "launchContract"> & {
    redactor: Redactor;
    now: () => Date;
  };

async function runAgentTask(
  options: AgentTaskOptions,
  instructions: string,
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const preimage = repositoryPreimage(options.rootDir);
  try {
    return await runAgentTaskUncommitted(options, instructions, context);
  } catch (error) {
    try {
      restoreRepositoryPreimage(options.rootDir, preimage);
    } catch (rollbackError) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_ROLLBACK_FAILED",
        `Build-agent work was rejected, but exact repository rollback failed: ${options.redactor.redactText(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        )}. Stop before any source or provider effect and restore the child from its last verified source snapshot.`,
      );
    }
    let evidenceArtifact: string | null = null;
    try {
      evidenceArtifact = persistEvidence(
        options.rootDir,
        context,
        {
          schemaVersion: 1,
          runId: context.runId,
          nodeId: context.node.id,
          handler: context.node.handler,
          host: options.agentHost.id,
          finishedAt: options.now().toISOString(),
          status: "rolled_back_after_failure",
          rollbackRestored: true,
          originalErrorCode:
            error instanceof WorkflowExecutionError ? error.code : "BUILD_AGENT_FAILED",
          error: options.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
          rawPromptPersisted: false,
          rawJsonlPersisted: false,
        },
        options.redactor,
      );
    } catch {
      // Rollback is the safety invariant. A failed evidence write stays loud in
      // the final error without re-applying rejected repository mutations.
    }
    const suffix = evidenceArtifact
      ? ` Rejected repository changes were restored; inspect ${evidenceArtifact}.`
      : " Rejected repository changes were restored, but rollback evidence could not be written.";
    if (error instanceof WorkflowExecutionError) {
      throw new WorkflowExecutionError(error.code, `${error.message}${suffix}`, {
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
    throw new WorkflowExecutionError(
      "BUILD_AGENT_FAILED",
      `${options.redactor.redactText(error instanceof Error ? error.message : String(error))}${suffix}`,
    );
  }
}

async function runAgentTaskUncommitted(
  options: AgentTaskOptions,
  instructions: string,
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
  const handler = context.node.handler ?? context.node.id;
  const policy = COMPLETION_POLICIES[handler];
  const contextManifest = createBuildContextManifest({
    rootDir: options.rootDir,
    brief: options.brief,
    runId: context.runId,
    nodeId: context.node.id,
    capabilitiesRequired: options.decision?.capabilities,
    paymentProvider: options.decision?.payment.provider,
    requireCanonicalContract: options.launchContract !== undefined,
    agentNative: options.launchContract?.agentNative,
  });
  const contextManifestReference = `reports/launch/${safeSegment(
    context.runId,
    "run ID",
  )}/context/${safeSegment(context.node.id, "node ID")}.json`;
  writeJsonAtomic(
    inside(options.rootDir, contextManifestReference),
    options.redactor.redact(contextManifest),
  );
  const before = repositorySnapshot(options.rootDir);
  const protectedBefore = protectedInputSnapshot(options.rootDir, handler);
  let result: BuildAgentResult;
  try {
    result = options.redactor.redact(
      await options.agentHost.run({
        runId: context.runId,
        nodeId: context.node.id,
        purpose: context.node.purpose,
        instructions: taskInstructions(handler, instructions, contextManifest.capabilitiesRequired),
        context: {
          brief: options.brief,
          node: {
            id: context.node.id,
            capability: context.node.capability,
            effect: context.node.effect,
            completion: context.node.completion.description,
          },
          completionEvidence: policy
            ? {
                outcomes: ["changed", "already_compliant"],
                requiredArtifactRoles: policy.requiredArtifactRoles,
                validator: "one relevant direct passed check with observed evidence",
              }
            : null,
          contextManifest,
          contextManifestArtifact: contextManifestReference,
        } as unknown as JsonValue,
        signal: context.signal,
      }),
    );
  } catch (error) {
    const after = repositorySnapshot(options.rootDir);
    const changes = repositoryChanges(before, after);
    const protectedAfter = protectedInputSnapshot(options.rootDir, handler);
    const protectedViolations = protectedInputViolations(protectedBefore, protectedAfter, []);
    const evidenceArtifact = persistEvidence(
      options.rootDir,
      context,
      {
        schemaVersion: 1,
        runId: context.runId,
        nodeId: context.node.id,
        handler: context.node.handler,
        host: options.agentHost.id,
        startedAt,
        finishedAt: options.now().toISOString(),
        status: "failed",
        repositoryChanges: changes,
        protectedInputViolations: protectedViolations,
        error: options.redactor.redactText(error instanceof Error ? error.message : String(error)),
        rawPromptPersisted: false,
        rawJsonlPersisted: false,
      },
      options.redactor,
    );
    if (protectedViolations.length > 0) {
      throw new WorkflowExecutionError(
        "BUILD_AGENT_PROTECTED_INPUT_MUTATION",
        `Build agent changed protected launch input(s) during ${context.node.id}: ${protectedViolations.join(", ")}. No source or provider node may continue; inspect ${evidenceArtifact}.`,
      );
    }
    throw new WorkflowExecutionError(
      "BUILD_AGENT_FAILED",
      `Build agent failed ${context.node.id}; inspect ${evidenceArtifact}.`,
    );
  }

  const after = repositorySnapshot(options.rootDir);
  const observedChanges = repositoryChanges(before, after);
  const protectedAfter = protectedInputSnapshot(options.rootDir, handler);
  const protectedViolations = protectedInputViolations(
    protectedBefore,
    protectedAfter,
    result.changedFiles,
  );
  if (protectedViolations.length > 0) {
    const evidenceArtifact = persistEvidence(
      options.rootDir,
      context,
      {
        schemaVersion: 1,
        runId: context.runId,
        nodeId: context.node.id,
        handler: context.node.handler,
        host: options.agentHost.id,
        startedAt,
        finishedAt: options.now().toISOString(),
        status: "protected_input_mutation",
        result: hostOutput(result),
        repositoryChanges: observedChanges,
        protectedInputViolations: protectedViolations,
        rawPromptPersisted: false,
        rawJsonlPersisted: false,
      },
      options.redactor,
    );
    throw new WorkflowExecutionError(
      "BUILD_AGENT_PROTECTED_INPUT_MUTATION",
      `Build agent changed or reported protected launch input(s) during ${context.node.id}: ${protectedViolations.join(", ")}. No source or provider node may continue; inspect ${evidenceArtifact}.`,
    );
  }
  if (result.status === "blocked" || result.checks.some((check) => check.status === "failed")) {
    const evidenceArtifact = persistEvidence(
      options.rootDir,
      context,
      {
        schemaVersion: 1,
        runId: context.runId,
        nodeId: context.node.id,
        handler: context.node.handler,
        host: options.agentHost.id,
        startedAt,
        finishedAt: options.now().toISOString(),
        status: "blocked",
        result: hostOutput(result),
        repositoryChanges: observedChanges,
        eventTypes: result.eventTypes,
        rawPromptPersisted: false,
        rawJsonlPersisted: false,
      },
      options.redactor,
    );
    context.trace({
      host: options.agentHost.id,
      evidenceArtifact,
      contextManifestArtifact: contextManifestReference,
      status: result.status,
    });
    throw new WorkflowExecutionError(
      "BUILD_AGENT_BLOCKED",
      `Build agent did not complete ${context.node.id}; inspect ${evidenceArtifact}.`,
    );
  }

  let validation: AgentCompletionValidation;
  try {
    validation = validateAgentCompletion(
      options.rootDir,
      handler,
      result,
      before,
      after,
      options.launchContract,
    );
  } catch (error) {
    const evidenceArtifact = persistEvidence(
      options.rootDir,
      context,
      {
        schemaVersion: 1,
        runId: context.runId,
        nodeId: context.node.id,
        handler: context.node.handler,
        host: options.agentHost.id,
        startedAt,
        finishedAt: options.now().toISOString(),
        status: "invalid_evidence",
        result,
        repositoryChanges: observedChanges,
        error: options.redactor.redactText(error instanceof Error ? error.message : String(error)),
        rawPromptPersisted: false,
        rawJsonlPersisted: false,
      },
      options.redactor,
    );
    throw new WorkflowExecutionError(
      "BUILD_AGENT_EVIDENCE_INVALID",
      `Build agent evidence for ${context.node.id} was invalid; inspect ${evidenceArtifact}.`,
    );
  }
  const normalizedResult: BuildAgentResult = {
    ...result,
    changedFiles: validation.changedFiles,
    completion: result.completion
      ? { ...result.completion, artifacts: validation.artifacts }
      : null,
  };
  const output = hostOutput(normalizedResult);
  const evidenceArtifact = persistEvidence(
    options.rootDir,
    context,
    {
      schemaVersion: 1,
      runId: context.runId,
      nodeId: context.node.id,
      handler: context.node.handler,
      host: options.agentHost.id,
      startedAt,
      finishedAt: options.now().toISOString(),
      result: output,
      eventTypes: result.eventTypes,
      verifiedChangedFiles: validation.repositoryChanges,
      verifiedCompletionArtifacts: validation.artifacts,
      completionValidator: validation.validator,
      rawPromptPersisted: false,
      rawJsonlPersisted: false,
    },
    options.redactor,
  );
  context.trace({
    host: options.agentHost.id,
    evidenceArtifact,
    contextManifestArtifact: contextManifestReference,
    status: result.status,
  });
  const meteredTokens = result.usage ? result.usage.inputTokens + result.usage.outputTokens : 0;
  const observedUsageCost: WorkflowCostCharge | null = result.usage
    ? {
        kind: "model",
        category:
          context.node.cost.unit === "tokens"
            ? context.node.budgetCategory
            : "launch.observed_model_tokens",
        amount: meteredTokens,
        unit: "tokens",
        budgeted: context.node.cost.unit === "tokens",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        tool: options.agentHost.id,
        ...(result.usage.model ? { model: result.usage.model } : {}),
        metadata: {
          usageObservation: true,
          cachedInputTokens: result.usage.cachedInputTokens,
          contextFileCount: contextManifest.selectedFiles.length,
          contextEstimatedTokens: contextManifest.estimatedTotalTokens,
          contextTokenCap: contextManifest.tokenCap,
          contextSelectionTruncated: contextManifest.selectionTruncated,
          ...(result.usage.toolCalls === undefined ? {} : { toolCalls: result.usage.toolCalls }),
          ...(result.usage.failedCommands === undefined
            ? {}
            : { failedCommands: result.usage.failedCommands }),
        },
      }
    : null;
  const costs: WorkflowCostCharge[] = [];
  if (context.node.cost.unit !== "tokens") {
    costs.push({
      kind: "model",
      category: context.node.budgetCategory,
      amount: context.node.cost.amount,
      unit: context.node.cost.unit,
      budgeted: true,
    });
  }
  if (observedUsageCost) costs.push(observedUsageCost);
  return {
    output,
    effectVerified: true,
    evidenceArtifact,
    ...(costs.length > 0 ? { costs } : {}),
  };
}

async function runQualityCommand(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "commandRunner">> & {
    brief: FounderBrief;
    launchContract?: LaunchContract;
    redactor: Redactor;
    now: () => Date;
  },
  args: readonly string[],
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
  const packageExecutionPolicyVerified = assertPackageExecutionPolicy(options.rootDir);
  const isMvp = args.length === 1 && args[0] === "verify:mvp";
  const journeyContract = isMvp
    ? primaryJourneyTestContract(options.rootDir, options.launchContract)
    : null;
  const result = await options.commandRunner.run({
    command: "pnpm",
    args,
    cwd: options.rootDir,
    signal: context.signal,
  });
  const evidenceArtifact = persistEvidence(
    options.rootDir,
    context,
    {
      schemaVersion: 1,
      runId: context.runId,
      nodeId: context.node.id,
      handler: context.node.handler,
      startedAt,
      finishedAt: options.now().toISOString(),
      command: ["pnpm", ...args],
      packageExecutionPolicyVerified,
      ...(journeyContract
        ? {
            primaryJourneyContract: {
              scope: journeyContract.scope,
              journeyId: journeyContract.journeyId,
              steps: journeyContract.steps,
              specPath: journeyContract.specPath,
              cleanupSpecPath: journeyContract.cleanupSpecPath,
            },
          }
        : {}),
      exitCode: result.exitCode,
      stdoutExcerpt: options.redactor.redactText(result.stdout).slice(-4_000),
      stderrExcerpt: options.redactor.redactText(result.stderr).slice(-4_000),
    },
    options.redactor,
  );
  context.trace({ command: ["pnpm", ...args], exitCode: result.exitCode, evidenceArtifact });
  if (result.exitCode !== 0) {
    throw new WorkflowExecutionError(
      "QUALITY_CHECK_FAILED",
      `${["pnpm", ...args].join(" ")} exited ${result.exitCode}; inspect ${evidenceArtifact}.`,
    );
  }
  return {
    output: {
      command: ["pnpm", ...args],
      exitCode: result.exitCode,
      ...(journeyContract ? { primaryJourneyContractChecked: true } : {}),
    },
    evidenceArtifact,
  };
}

async function runDependencyInstall(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "commandRunner">> & {
    redactor: Redactor;
    now: () => Date;
    checkpointOperation: boolean;
    waitOnFailure: boolean;
  },
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
  const packagePath = inside(options.rootDir, "package.json");
  const lockPath = inside(options.rootDir, "pnpm-lock.yaml");
  let result: Awaited<ReturnType<CommandRunner["run"]>> | null = null;
  let invocationError: string | null = null;
  let packageManifestSha256: string | null = null;
  let lockfileSha256: string | null = null;
  let installedModulesReadBack = false;
  let installedLockfileReadBack = false;
  let requiredToolingReadBack = false;
  let packageExecutionPolicyVerified = false;
  let checkpoint: DependencyInstallCheckpoint | null = null;

  try {
    packageExecutionPolicyVerified = assertPackageExecutionPolicy(options.rootDir);
    packageManifestSha256 = sha256IfRegular(packagePath);
    if (packageManifestSha256 === null) {
      throw new Error("package.json is missing or is not a regular file");
    }
    lockfileSha256 = sha256IfRegular(lockPath);
    if (lockfileSha256 === null) {
      throw new Error("pnpm-lock.yaml is missing or is not a regular file");
    }
    checkpoint = {
      schemaVersion: DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION,
      packageManifest: "package.json",
      packageManifestSha256,
      lockfile: "pnpm-lock.yaml",
      lockfileSha256,
    };
    if (options.checkpointOperation) {
      context.checkpointOperation?.(checkpoint as unknown as JsonValue);
    }
    result = await options.commandRunner.run({
      command: "pnpm",
      args: CHILD_DEPENDENCY_INSTALL_ARGS,
      cwd: options.rootDir,
      signal: context.signal,
    });
    if (result.exitCode === 0) {
      const readBack = readDependencyInstallState(options.rootDir, checkpoint);
      installedModulesReadBack = readBack.installedModulesReadBack;
      installedLockfileReadBack = readBack.installedLockfileReadBack;
      requiredToolingReadBack = readBack.requiredToolingReadBack;
      if (readBack.state === "input_mismatch") {
        throw new Error(readBack.message ?? "the frozen dependency inputs changed");
      }
      if (readBack.state !== "verified") {
        throw new Error(
          `pnpm exited successfully but dependency read-back was incomplete (modules=${readBack.installedModulesReadBack}, installedLock=${readBack.installedLockfileReadBack}, requiredTooling=${readBack.requiredToolingReadBack})`,
        );
      }
    }
  } catch (error) {
    invocationError = options.redactor.redactText(
      error instanceof Error ? error.message : String(error),
    );
  }

  const evidenceArtifact = persistEvidence(
    options.rootDir,
    context,
    {
      schemaVersion: 1,
      runId: context.runId,
      nodeId: context.node.id,
      handler: context.node.handler,
      startedAt,
      finishedAt: options.now().toISOString(),
      command: ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      packageManifest: "package.json",
      packageManifestSha256,
      lockfile: "pnpm-lock.yaml",
      lockfileSha256,
      frozenLockfile: true,
      parentWorkspaceIgnored: true,
      lifecycleScriptsDisabled: packageExecutionPolicyVerified,
      packageExecutionPolicyVerified,
      installedModulesReadBack,
      installedLockfileReadBack,
      requiredToolingReadBack,
      exitCode: result?.exitCode ?? null,
      stdoutExcerpt: options.redactor.redactText(result?.stdout ?? "").slice(-4_000),
      stderrExcerpt: options.redactor.redactText(result?.stderr ?? "").slice(-4_000),
      invocationError,
    },
    options.redactor,
  );
  context.trace({
    command: ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
    exitCode: result?.exitCode ?? null,
    evidenceArtifact,
  });
  if (!result || result.exitCode !== 0 || invocationError) {
    const reason = invocationError ?? `pnpm exited ${result?.exitCode ?? "without a result"}`;
    if (checkpoint && options.waitOnFailure && context.checkpointOperation) {
      return {
        wait: {
          kind: "external",
          reason: `Frozen child dependency install failed (${reason}); repair local package-manager or registry availability, then resume the same run. Inspect ${evidenceArtifact}.`,
        },
        evidenceArtifact,
      };
    }
    throw new WorkflowExecutionError(
      "DEPENDENCY_INSTALL_FAILED",
      `Frozen child dependency install failed (${reason}); inspect ${evidenceArtifact}. No source publish or deployment node can start from this failed dependency.`,
    );
  }
  return {
    output: {
      command: ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      exitCode: 0,
      packageManifest: "package.json",
      packageManifestSha256,
      lockfile: "pnpm-lock.yaml",
      lockfileSha256,
      frozenLockfile: true,
      installedModulesReadBack: true,
      installedLockfileReadBack: true,
      requiredToolingReadBack: true,
      lifecycleScriptsDisabled: packageExecutionPolicyVerified,
      packageExecutionPolicyVerified,
    },
    effectVerified: true,
    evidenceArtifact,
  };
}

function persistDependencyReconciliationEvidence(
  root: string,
  context: WorkflowReconciliationContext,
  readBack: DependencyInstallReadBack,
  redactor: Redactor,
  now: () => Date,
): string {
  const paths = dependencyReconciliationEvidencePaths(root, context.runId, context.node.id);
  writeJsonAtomic(
    paths.absolute,
    redactor.redact({
      runId: context.runId,
      nodeId: context.node.id,
      handler: context.node.handler,
      reason: context.reason,
      observedAt: now().toISOString(),
      ...readBack,
    }),
  );
  const persisted = JSON.parse(readRegularFile(paths.absolute, "utf8")) as {
    runId?: string;
    nodeId?: string;
    state?: string;
  };
  if (
    persisted.runId !== context.runId ||
    persisted.nodeId !== context.node.id ||
    persisted.state !== readBack.state
  ) {
    throw new WorkflowExecutionError(
      "DEPENDENCY_RECONCILIATION_EVIDENCE_INVALID",
      "Dependency reconciliation evidence failed atomic read-back.",
    );
  }
  return paths.reference;
}

function reconcileDependencyInstall(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir">> & {
    redactor: Redactor;
    now: () => Date;
  },
  context: WorkflowReconciliationContext,
): WorkflowReconciliationResult {
  const checkpoint = dependencyInstallCheckpoint(context.operation.checkpoint);
  if (!checkpoint) {
    return {
      status: "failed",
      code: "DEPENDENCY_CHECKPOINT_INVALID",
      message:
        "The dependency operation has no valid immutable package/lock checkpoint; start a deliberate new launch instead of guessing at mutable local state.",
    };
  }
  const readBack = readDependencyInstallState(options.rootDir, checkpoint);
  const packageExecutionPolicyVerified = assertPackageExecutionPolicy(options.rootDir);
  const evidenceArtifact = persistDependencyReconciliationEvidence(
    options.rootDir,
    context,
    readBack,
    options.redactor,
    options.now,
  );
  context.trace({
    dependencyReconciliation: readBack.state,
    evidenceArtifact,
  });
  if (readBack.state === "input_mismatch") {
    return {
      status: "failed",
      code: "DEPENDENCY_INPUT_CHANGED",
      message:
        readBack.message ??
        "The package manifest or lockfile no longer matches the checkpointed install inputs.",
    };
  }
  if (readBack.state === "not_applied") return { status: "not_applied" };
  return {
    status: "verified",
    output: {
      command: ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      exitCode: 0,
      packageManifest: checkpoint.packageManifest,
      packageManifestSha256: checkpoint.packageManifestSha256,
      lockfile: checkpoint.lockfile,
      lockfileSha256: checkpoint.lockfileSha256,
      frozenLockfile: true,
      installedModulesReadBack: true,
      installedLockfileReadBack: true,
      requiredToolingReadBack: true,
      lifecycleScriptsDisabled: packageExecutionPolicyVerified,
      packageExecutionPolicyVerified,
      reconciled: true,
    },
    evidenceArtifact,
  };
}

function dependencyCheckpointForHandler(
  root: string,
  context: WorkflowHandlerContext,
): { checkpoint: DependencyInstallCheckpoint | null; expected: boolean; nodeId: string } {
  for (const nodeId of ["finalize-dependencies", "install-dependencies"] as const) {
    const direct = context.dependencyOutputs[nodeId];
    if (direct && !Array.isArray(direct) && typeof direct === "object") {
      const checkpoint = dependencyInstallCheckpoint({
        schemaVersion: DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION,
        packageManifest: direct.packageManifest,
        packageManifestSha256: direct.packageManifestSha256,
        lockfile: direct.lockfile,
        lockfileSha256: direct.lockfileSha256,
      });
      return { checkpoint, expected: true, nodeId };
    }
  }
  for (const nodeId of ["finalize-dependencies", "install-dependencies"] as const) {
    const paths = dependencyInstallEvidencePaths(root, context.runId, nodeId);
    if (existsSync(paths.absolute)) {
      return {
        checkpoint: checkpointFromInstallEvidence(root, context.runId, nodeId),
        expected: true,
        nodeId,
      };
    }
  }
  return { checkpoint: null, expected: false, nodeId: "install-dependencies" };
}

async function ensureCurrentDependencyInstall(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "commandRunner">> & {
    redactor: Redactor;
    now: () => Date;
  },
  context: WorkflowHandlerContext,
): Promise<void> {
  const selected = dependencyCheckpointForHandler(options.rootDir, context);
  // Isolated handler unit tests do not construct the launch graph. The real web
  // graph always supplies the direct install output or its durable evidence.
  if (!selected.expected) return;
  if (!selected.checkpoint) {
    throw new WorkflowExecutionError(
      "DEPENDENCY_CHECKPOINT_INVALID",
      "The prior dependency-install evidence is missing or malformed; no product or quality command was started.",
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
  const readBack = readDependencyInstallState(options.rootDir, selected.checkpoint);
  if (readBack.state === "input_mismatch") {
    throw new WorkflowExecutionError(
      "DEPENDENCY_INPUT_CHANGED",
      `${readBack.message ?? "Dependency inputs changed."} No product or quality command was started.`,
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
  if (readBack.state === "verified") return;

  const installContext: WorkflowHandlerContext = {
    ...context,
    node: {
      ...context.node,
      id: selected.nodeId,
      handler: "launch.installDependencies",
      effect: "local_write",
    },
    dependencyOutputs: {},
    idempotencyKey: `${context.runId}:${selected.nodeId}:repair`,
  };
  try {
    await runDependencyInstall(
      {
        ...options,
        checkpointOperation: false,
        waitOnFailure: false,
      },
      installContext,
    );
  } catch (error) {
    throw new WorkflowExecutionError(
      "DEPENDENCY_REPAIR_FAILED",
      `The checkpointed child dependencies were absent and the bounded reinstall failed; no product or quality command was started. ${
        error instanceof Error ? error.message : String(error)
      }`,
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
}

function safeHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const privateIpv4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
      url.hostname,
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      privateIpv4 ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname.endsWith(".local")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function verifiedCustomDomain(context: WorkflowHandlerContext, domain: string): string {
  const expected = new URL(`https://${domain}`).origin;
  if (expected !== `https://${domain}`) {
    throw new WorkflowExecutionError(
      "POST_DEPLOY_DOMAIN_INVALID",
      "The Launch Contract custom domain is not one canonical HTTPS hostname.",
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
  const project = context.dependencyOutputs["vercel-project"];
  const dns = context.dependencyOutputs["dns-records"];
  const refs =
    project && typeof project === "object" && !Array.isArray(project)
      ? (project as Record<string, unknown>).resourceRefs
      : null;
  const attached =
    Array.isArray(refs) &&
    refs.some((reference) => {
      if (typeof reference !== "string") return false;
      const separator = reference.indexOf("=");
      if (separator < 0 || !["domain", "site_url", "url"].includes(reference.slice(0, separator))) {
        return false;
      }
      const value = reference.slice(separator + 1);
      return value === domain || safeHttpsOrigin(value) === expected;
    });
  if (!attached || !dns || typeof dns !== "object" || Array.isArray(dns)) {
    throw new WorkflowExecutionError(
      "POST_DEPLOY_CUSTOM_DOMAIN_UNVERIFIED",
      "Custom-domain verification requires same-run Vercel attachment and DNS propagation read-back before any journey is attempted.",
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
  return expected;
}

function productionDeploymentUrl(context: WorkflowHandlerContext): string {
  const dependency = context.dependencyOutputs["production-deploy"];
  if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
    throw new WorkflowExecutionError(
      "POST_DEPLOY_URL_MISSING",
      "Production verification requires the verified production-deploy output.",
    );
  }
  const resourceRefs = (dependency as Record<string, unknown>).resourceRefs;
  if (!Array.isArray(resourceRefs)) {
    throw new WorkflowExecutionError(
      "POST_DEPLOY_URL_MISSING",
      "Production deployment read-back did not expose an allowlisted URL resource reference.",
    );
  }
  const origins = new Set<string>();
  for (const reference of resourceRefs) {
    if (typeof reference !== "string" || !reference.startsWith("url=")) continue;
    const origin = safeHttpsOrigin(reference.slice("url=".length));
    if (origin) origins.add(origin);
  }
  if (origins.size !== 1) {
    throw new WorkflowExecutionError(
      "POST_DEPLOY_URL_AMBIGUOUS",
      `Production deployment read-back must provide one exact safe HTTPS origin; found ${origins.size}.`,
    );
  }
  return [...origins][0]!;
}

async function runPostDeployVerification(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "commandRunner">> & {
    brief: FounderBrief;
    launchContract?: LaunchContract;
    authorization?: AuthorizationEnvelope;
    redactor: Redactor;
    now: () => Date;
  },
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
  const customDomainVerification = context.node.id === "verify-custom-domain";
  const deploymentUrl = customDomainVerification
    ? verifiedCustomDomain(context, options.brief.domain ?? "")
    : productionDeploymentUrl(context);
  const target = customDomainVerification
    ? ("verified_custom_domain" as const)
    : ("verified_provider_production_url" as const);
  const customDomain = {
    state: customDomainVerification
      ? ("verified" as const)
      : options.brief.domain
        ? ("waiting" as const)
        : ("not_configured" as const),
    origin: customDomainVerification ? deploymentUrl : null,
  };
  const journeyContract = primaryJourneyTestContract(options.rootDir, options.launchContract);
  assertCoreOwnedSurfaceSpec(options.rootDir);
  const authorization = assertProductionJourneyAuthorization(
    options.authorization,
    context,
    options.now(),
  );
  if (
    journeyContract.production.allowedEffects.some(
      (effect) =>
        !authorization.allowed_side_effect_classes.includes(effect) ||
        (effect === "transactional_email" && !authorization.transactional_test_email_allowed),
    )
  ) {
    throw new WorkflowExecutionError(
      "PRIMARY_JOURNEY_CONTRACT_OUTSIDE_AUTHORIZATION",
      "The reviewed product journey contract requests an effect outside the current run envelope.",
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }
  const nonce = randomBytes(24).toString("hex");
  const traceOutputReference = `.venture/private/test-results/${safeSegment(
    context.runId,
    "run ID",
  )}/${safeSegment(context.node.id, "node ID")}-${nonce}`;
  const commandEnvironment = {
    PLAYWRIGHT_BASE_URL: deploymentUrl,
    [PRIMARY_JOURNEY_RUN_ID_ENV]: context.runId,
    [PRIMARY_JOURNEY_NONCE_ENV]: nonce,
    [PRIMARY_JOURNEY_TEST_IDENTITY_ENV]: journeyContract.production.identity.label,
    EXPECTED_PUBLIC_ORIGIN: deploymentUrl,
  };
  const surfaceResult = await options.commandRunner.run({
    command: "pnpm",
    args: POST_DEPLOY_SURFACE_TEST_ARGS,
    cwd: options.rootDir,
    env: { ...commandEnvironment, PLAYWRIGHT_OUTPUT_DIR: `${traceOutputReference}/surface` },
    signal: context.signal,
  });
  let surfaceEvidenceError: string | null = null;
  if (surfaceResult.exitCode === 0) {
    try {
      validatedDeploymentSurfaceMarkers(surfaceResult.stdout);
    } catch (error) {
      surfaceEvidenceError = error instanceof Error ? error.message : String(error);
    }
  }
  if (surfaceResult.exitCode !== 0 || surfaceEvidenceError !== null) {
    const evidenceArtifact = persistEvidence(
      options.rootDir,
      context,
      {
        schemaVersion: 1,
        runId: context.runId,
        nodeId: context.node.id,
        handler: context.node.handler,
        startedAt,
        finishedAt: options.now().toISOString(),
        deploymentUrl,
        target,
        customDomain,
        deploymentSurface: {
          scope: "generic_read_only_deployment_surface",
          command: ["pnpm", ...POST_DEPLOY_SURFACE_TEST_ARGS],
          exitCode: surfaceResult.exitCode,
          stdoutExcerpt: options.redactor.redactText(surfaceResult.stdout).slice(-4_000),
          stderrExcerpt: options.redactor.redactText(surfaceResult.stderr).slice(-4_000),
          evidenceError:
            surfaceEvidenceError === null
              ? null
              : options.redactor.redactText(surfaceEvidenceError),
        },
        primaryJourney: { state: "not_run", reason: "deployment surface failed" },
      },
      options.redactor,
    );
    throw new WorkflowExecutionError(
      "POST_DEPLOY_SURFACE_VERIFICATION_FAILED",
      `The generic production surface, raw-HTML, and desktop/mobile accessibility baseline did not produce exact passing evidence; inspect ${evidenceArtifact}.`,
      { details: { effectOutcome: "confirmed_no_write" } },
    );
  }

  const operationCheckpoint = {
    schemaVersion: 1,
    kind: "production_primary_journey" as const,
    deploymentUrl,
    runId: context.runId,
    nonce,
    journeyId: journeyContract.journeyId,
    identityLabel: journeyContract.production.identity.label,
  };
  context.checkpointOperation?.(operationCheckpoint);
  context.checkpointExternalEffect?.(operationCheckpoint);
  let primaryResult: Awaited<ReturnType<CommandRunner["run"]>> | null = null;
  let primaryError: unknown;
  try {
    primaryResult = await options.commandRunner.run({
      command: "pnpm",
      args: POST_DEPLOY_PRIMARY_JOURNEY_ARGS,
      cwd: options.rootDir,
      env: { ...commandEnvironment, PLAYWRIGHT_OUTPUT_DIR: `${traceOutputReference}/journey` },
      signal: context.signal,
    });
  } catch (error) {
    primaryError = error;
  }
  let journeyReadBackResult: Awaited<ReturnType<CommandRunner["run"]>> | null = null;
  try {
    assertCoreOwnedSurfaceSpec(options.rootDir);
    journeyReadBackResult = await options.commandRunner.run({
      command: "pnpm",
      args: POST_DEPLOY_PRIMARY_OBSERVER_ARGS,
      cwd: options.rootDir,
      env: {
        ...commandEnvironment,
        [PRIMARY_JOURNEY_OBSERVER_PHASE_ENV]: "journey_readback",
        PLAYWRIGHT_OUTPUT_DIR: `${traceOutputReference}/journey-readback`,
      },
      signal: context.signal,
    });
  } catch (error) {
    primaryError ??= error;
  }
  let cleanupResult: Awaited<ReturnType<CommandRunner["run"]>> | null = null;
  let cleanupError: unknown;
  try {
    cleanupResult = await options.commandRunner.run({
      command: "pnpm",
      args: POST_DEPLOY_PRIMARY_CLEANUP_ARGS,
      cwd: options.rootDir,
      env: { ...commandEnvironment, PLAYWRIGHT_OUTPUT_DIR: `${traceOutputReference}/cleanup` },
    });
  } catch (error) {
    cleanupError = error;
  }
  let cleanupReadBackResult: Awaited<ReturnType<CommandRunner["run"]>> | null = null;
  if (cleanupResult?.exitCode === 0) {
    try {
      assertCoreOwnedSurfaceSpec(options.rootDir);
      cleanupReadBackResult = await options.commandRunner.run({
        command: "pnpm",
        args: POST_DEPLOY_PRIMARY_OBSERVER_ARGS,
        cwd: options.rootDir,
        env: {
          ...commandEnvironment,
          [PRIMARY_JOURNEY_OBSERVER_PHASE_ENV]: "cleanup_readback",
          PLAYWRIGHT_OUTPUT_DIR: `${traceOutputReference}/cleanup-readback`,
        },
        signal: context.signal,
      });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  const evidenceReference = artifactPaths(options.rootDir, context).reference;
  let runtimeEvidence: ProductionJourneyRuntimeEvidence | null = null;
  let runtimeEvidenceError: string | null = null;
  if (
    primaryResult?.exitCode === 0 &&
    journeyReadBackResult?.exitCode === 0 &&
    cleanupResult?.exitCode === 0 &&
    cleanupReadBackResult?.exitCode === 0
  ) {
    try {
      const traceEvidence = playwrightTraceEvidence(
        options.rootDir,
        traceOutputReference,
        deploymentUrl,
        journeyContract,
      );
      const stateReadBack = validatedPrimaryJourneyStateReadBack(
        journeyReadBackResult.stdout,
        cleanupReadBackResult.stdout,
        context.runId,
        nonce,
        journeyContract,
      );
      runtimeEvidence = validateProductionJourneyMarkers(
        primaryResult.stdout,
        cleanupResult.stdout,
        context.runId,
        nonce,
        journeyContract,
        authorization,
        options.brief.synthetic ?? false,
        traceEvidence,
        stateReadBack,
      );
    } catch (error) {
      runtimeEvidenceError = error instanceof Error ? error.message : String(error);
    }
  }
  const evidenceState = options.brief.synthetic ? "fixture" : "verified";
  const journeyEvidence = runtimeEvidence
    ? primaryJourneyEvidence(journeyContract, evidenceState, evidenceReference)
    : null;
  const output =
    runtimeEvidence && journeyEvidence
      ? launchProductionVerificationOutputSchema.parse({
          schemaVersion: 1,
          runId: context.runId,
          evidenceRef: evidenceReference,
          deploymentUrl,
          target,
          customDomain,
          deploymentSurface: {
            scope: "generic_read_only_deployment_surface",
            command: ["pnpm", ...POST_DEPLOY_SURFACE_TEST_ARGS],
            exitCode: 0,
            verified: true,
          },
          primaryJourneyEvidence: journeyEvidence,
          runtimeEvidence,
          accessibility: {
            state: evidenceState,
            projects: ["desktop-chromium", "mobile-chromium"],
            evidenceRef: evidenceReference,
          },
          rawHtml: { state: evidenceState, evidenceRef: evidenceReference },
          cleanup: { state: "verified", evidenceRef: evidenceReference },
        })
      : null;
  const evidenceArtifact = persistEvidence(
    options.rootDir,
    context,
    {
      schemaVersion: 1,
      runId: context.runId,
      nodeId: context.node.id,
      handler: context.node.handler,
      startedAt,
      finishedAt: options.now().toISOString(),
      deploymentUrl,
      target,
      customDomain,
      deploymentSurface: {
        scope: "generic_read_only_deployment_surface",
        command: ["pnpm", ...POST_DEPLOY_SURFACE_TEST_ARGS],
        exitCode: surfaceResult.exitCode,
        verifiedChecks: {
          rawServerHtml: true,
          accessibilityAxe: true,
          accessibleNamesAndLandmarks: true,
          keyboardFocus: true,
          responsiveOverflow: true,
          projects: ["desktop-chromium", "mobile-chromium"],
        },
        stdoutExcerpt: options.redactor.redactText(surfaceResult.stdout).slice(-4_000),
        stderrExcerpt: options.redactor.redactText(surfaceResult.stderr).slice(-4_000),
      },
      primaryJourney: {
        command: ["pnpm", ...POST_DEPLOY_PRIMARY_JOURNEY_ARGS],
        exitCode: primaryResult?.exitCode ?? null,
        stdoutExcerpt: options.redactor.redactText(primaryResult?.stdout ?? "").slice(-4_000),
        stderrExcerpt: options.redactor.redactText(primaryResult?.stderr ?? "").slice(-4_000),
        runnerError:
          primaryError === undefined
            ? null
            : options.redactor.redactText(
                primaryError instanceof Error ? primaryError.message : String(primaryError),
              ),
        evidence: journeyEvidence,
      },
      cleanup: {
        command: ["pnpm", ...POST_DEPLOY_PRIMARY_CLEANUP_ARGS],
        exitCode: cleanupResult?.exitCode ?? null,
        stdoutExcerpt: options.redactor.redactText(cleanupResult?.stdout ?? "").slice(-4_000),
        stderrExcerpt: options.redactor.redactText(cleanupResult?.stderr ?? "").slice(-4_000),
        runnerError:
          cleanupError === undefined
            ? null
            : options.redactor.redactText(
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              ),
      },
      stateReadBack: {
        observerCommand: ["pnpm", ...POST_DEPLOY_PRIMARY_OBSERVER_ARGS],
        journeyExitCode: journeyReadBackResult?.exitCode ?? null,
        cleanupExitCode: cleanupReadBackResult?.exitCode ?? null,
        journeyStdoutExcerpt: options.redactor
          .redactText(journeyReadBackResult?.stdout ?? "")
          .slice(-4_000),
        cleanupStdoutExcerpt: options.redactor
          .redactText(cleanupReadBackResult?.stdout ?? "")
          .slice(-4_000),
      },
      runtimeEvidence,
      runtimeEvidenceError:
        runtimeEvidenceError === null ? null : options.redactor.redactText(runtimeEvidenceError),
      output,
      limitations: [
        "The generic read-only check proves only deployment surface, raw server HTML, responsive semantics, canonical metadata, and crawlability; it is not primary-journey evidence.",
        "A passing product-specific journey proves only the declared path in this tested environment; it does not prove customer demand, provider uptime, or conversion behavior.",
      ],
    },
    options.redactor,
  );
  context.trace({
    surfaceCommand: ["pnpm", ...POST_DEPLOY_SURFACE_TEST_ARGS],
    primaryJourneyCommand: ["pnpm", ...POST_DEPLOY_PRIMARY_JOURNEY_ARGS],
    cleanupCommand: ["pnpm", ...POST_DEPLOY_PRIMARY_CLEANUP_ARGS],
    deploymentUrl,
    target,
    customDomain,
    surfaceExitCode: surfaceResult.exitCode,
    primaryJourneyExitCode: primaryResult?.exitCode ?? null,
    cleanupExitCode: cleanupResult?.exitCode ?? null,
    journeyReadBackExitCode: journeyReadBackResult?.exitCode ?? null,
    cleanupReadBackExitCode: cleanupReadBackResult?.exitCode ?? null,
    evidenceArtifact,
  });
  if (
    !primaryResult ||
    primaryResult.exitCode !== 0 ||
    !cleanupResult ||
    cleanupResult.exitCode !== 0 ||
    !journeyReadBackResult ||
    journeyReadBackResult.exitCode !== 0 ||
    !cleanupReadBackResult ||
    cleanupReadBackResult.exitCode !== 0 ||
    !journeyEvidence ||
    !runtimeEvidence ||
    !output
  ) {
    const cleanupVerified = (() => {
      if (cleanupResult?.exitCode !== 0) return false;
      try {
        validatedCleanupMarkers(cleanupResult.stdout, context.runId, nonce, journeyContract);
        return true;
      } catch {
        return false;
      }
    })();
    throw new WorkflowExecutionError(
      "POST_DEPLOY_PRIMARY_JOURNEY_FAILED",
      `The product-specific production journey or its cleanup did not produce exact verified runtime evidence; inspect ${evidenceArtifact}.`,
      cleanupVerified
        ? { details: { effectOutcome: "confirmed_no_write" } }
        : { retryable: true, details: { effectOutcome: "unknown" } },
    );
  }
  return {
    output,
    effectVerified: true,
    evidenceArtifact,
  };
}

async function reconcilePostDeployVerification(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "commandRunner">> & {
    launchContract?: LaunchContract;
    authorization?: AuthorizationEnvelope;
    now: () => Date;
  },
  context: WorkflowReconciliationContext,
): Promise<WorkflowReconciliationResult> {
  if (!context.operation.checkpoint) return { status: "not_applied" };
  let checkpoint: z.infer<typeof productionJourneyOperationCheckpointSchema>;
  let contract: PrimaryJourneyTestContract;
  try {
    checkpoint = productionJourneyOperationCheckpointSchema.parse(context.operation.checkpoint);
    contract = primaryJourneyTestContract(options.rootDir, options.launchContract);
    assertProductionJourneyAuthorization(options.authorization, context, options.now());
  } catch (error) {
    return {
      status: "failed",
      code:
        error instanceof WorkflowExecutionError
          ? error.code
          : "PRIMARY_JOURNEY_RECONCILIATION_INVALID",
      message: error instanceof Error ? error.message : String(error),
      effectState: "unknown",
    };
  }
  if (
    checkpoint.runId !== context.runId ||
    checkpoint.journeyId !== contract.journeyId ||
    checkpoint.identityLabel !== contract.production.identity.label
  ) {
    return {
      status: "failed",
      code: "PRIMARY_JOURNEY_RECONCILIATION_MISMATCH",
      message:
        "Refusing cleanup because the persisted operation target no longer matches the immutable journey contract.",
      effectState: "unknown",
    };
  }
  const reconciliationEnvironment = {
    PLAYWRIGHT_BASE_URL: checkpoint.deploymentUrl,
    EXPECTED_PUBLIC_ORIGIN: checkpoint.deploymentUrl,
    [PRIMARY_JOURNEY_RUN_ID_ENV]: checkpoint.runId,
    [PRIMARY_JOURNEY_NONCE_ENV]: checkpoint.nonce,
    [PRIMARY_JOURNEY_TEST_IDENTITY_ENV]: checkpoint.identityLabel,
  };
  const result = await options.commandRunner.run({
    command: "pnpm",
    args: POST_DEPLOY_PRIMARY_CLEANUP_ARGS,
    cwd: options.rootDir,
    env: reconciliationEnvironment,
    signal: context.signal,
  });
  context.trace({
    command: ["pnpm", ...POST_DEPLOY_PRIMARY_CLEANUP_ARGS],
    exitCode: result.exitCode,
    reconciliation: true,
  });
  if (result.exitCode !== 0) {
    return {
      status: "partially_applied",
      message: `Production primary-journey cleanup exited ${result.exitCode}; no replay is permitted until cleanup read-back succeeds.`,
    };
  }
  try {
    validatedCleanupMarkers(result.stdout, checkpoint.runId, checkpoint.nonce, contract);
    assertCoreOwnedSurfaceSpec(options.rootDir);
  } catch (error) {
    return {
      status: "partially_applied",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let observerResult: Awaited<ReturnType<CommandRunner["run"]>>;
  try {
    observerResult = await options.commandRunner.run({
      command: "pnpm",
      args: POST_DEPLOY_PRIMARY_OBSERVER_ARGS,
      cwd: options.rootDir,
      env: {
        ...reconciliationEnvironment,
        [PRIMARY_JOURNEY_OBSERVER_PHASE_ENV]: "cleanup_readback",
        PLAYWRIGHT_OUTPUT_DIR: `.venture/private/test-results/${safeSegment(
          context.runId,
          "run ID",
        )}/${safeSegment(context.node.id, "node ID")}-${checkpoint.nonce}/reconcile-readback`,
      },
      signal: context.signal,
    });
  } catch (error) {
    return {
      status: "partially_applied",
      message: `Locked cleanup observer failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  context.trace({
    command: ["pnpm", ...POST_DEPLOY_PRIMARY_OBSERVER_ARGS],
    exitCode: observerResult.exitCode,
    phase: "cleanup_readback",
    reconciliation: true,
  });
  if (observerResult.exitCode !== 0) {
    return {
      status: "partially_applied",
      message: `Locked cleanup observer exited ${observerResult.exitCode}; replay remains forbidden.`,
    };
  }
  try {
    validatedReconciliationCleanupReadBack(
      observerResult.stdout,
      checkpoint.runId,
      checkpoint.nonce,
      contract,
    );
  } catch (error) {
    return {
      status: "partially_applied",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: "not_applied" };
}

export async function assertBuildAgentHostAvailable(host: BuildAgentHost): Promise<void> {
  const inspection = await host.inspect();
  if (inspection.status !== "available" || inspection.readIsolation === "unavailable") {
    throw new WorkflowExecutionError(
      "BUILD_AGENT_UNAVAILABLE",
      `${inspection.nextAction ?? `${inspection.host} is unavailable.`} No run or external action was created.`,
    );
  }
}

export function createLaunchProductBindings(
  options: LaunchProductBindingsOptions,
): WorkflowBindings {
  const rootDir = resolve(options.rootDir);
  const redactor = options.redactor ?? new Redactor();
  const now = options.now ?? (() => new Date());
  const handlers: NonNullable<WorkflowBindings["handlers"]> = {};
  const reconcilers: NonNullable<WorkflowBindings["reconcilers"]> = {};
  const rail = routeRail(options.brief);

  for (const [handler, instructions] of Object.entries(AGENT_TASKS)) {
    handlers[handler] = async (context) => {
      if (rail.appKind === "web") {
        await ensureCurrentDependencyInstall(
          { rootDir, commandRunner: options.commandRunner, redactor, now },
          context,
        );
      }
      return runAgentTask(
        {
          rootDir,
          brief: options.brief,
          agentHost: options.agentHost,
          redactor,
          now,
          ...(options.decision ? { decision: options.decision } : {}),
          ...(options.launchContract ? { launchContract: options.launchContract } : {}),
        },
        ["launch.prepareRepository", "launch.reviewProduct"].includes(handler)
          ? instructions + PRIMARY_JOURNEY_OBSERVER_INSTRUCTIONS
          : instructions,
        context,
      );
    };
  }
  handlers["launch.installDependencies"] = (context) =>
    runDependencyInstall(
      {
        rootDir,
        commandRunner: options.commandRunner,
        redactor,
        now,
        checkpointOperation: true,
        waitOnFailure: true,
      },
      context,
    );
  reconcilers["launch.installDependencies"] = (context) =>
    reconcileDependencyInstall({ rootDir, redactor, now }, context);
  if (rail.mobileStack !== "none") {
    handlers["launch.prepareRepository"] = (context) =>
      runMobileScaffoldTask(
        {
          rootDir,
          brief: options.brief,
          redactor,
          now,
          mobileScaffold: options.mobileScaffold,
        },
        context,
      );
  }
  for (const [handler, args] of Object.entries(QUALITY_COMMANDS)) {
    handlers[handler] = async (context) => {
      if (rail.appKind === "web") {
        await ensureCurrentDependencyInstall(
          { rootDir, commandRunner: options.commandRunner, redactor, now },
          context,
        );
      }
      return runQualityCommand(
        {
          rootDir,
          commandRunner: options.commandRunner,
          brief: options.brief,
          ...(options.launchContract ? { launchContract: options.launchContract } : {}),
          redactor,
          now,
        },
        args,
        context,
      );
    };
  }
  handlers["launch.verifyProduction"] = async (context) => {
    if (rail.appKind === "web") {
      await ensureCurrentDependencyInstall(
        { rootDir, commandRunner: options.commandRunner, redactor, now },
        context,
      );
    }
    return runPostDeployVerification(
      {
        rootDir,
        commandRunner: options.commandRunner,
        brief: options.brief,
        ...(options.launchContract ? { launchContract: options.launchContract } : {}),
        ...(options.authorization ? { authorization: options.authorization } : {}),
        redactor,
        now,
      },
      context,
    );
  };
  reconcilers["launch.verifyProduction"] = (context) =>
    reconcilePostDeployVerification(
      {
        rootDir,
        commandRunner: options.commandRunner,
        ...(options.launchContract ? { launchContract: options.launchContract } : {}),
        ...(options.authorization ? { authorization: options.authorization } : {}),
        now,
      },
      context,
    );
  return { handlers, reconcilers };
}
