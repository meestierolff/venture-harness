import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { authorizationEnvelopeSchema } from "../config/policy-schema";
import { parseHarnessLock } from "../config/harness-lock";
import {
  founderBriefFromLaunchContract,
  launchContractDigest,
  launchContractSchema,
  launchDecisionFromContract,
} from "../founder-launch";
import { founderBriefSchema, launchProviderByNode, type LaunchDecision } from "../launch";
import { parseLaunchGrant, type LaunchGrant } from "../materialization";
import { providerIds, providerPublicOutputsSchema, type ProviderId } from "../providers";
import {
  validateWorkflow,
  workflowFingerprint,
  type WorkflowEvent,
  type WorkflowDefinition,
  type WorkflowNodeRecord,
  type WorkflowRunState,
} from "../workflow";
import { launchProductionVerificationOutputSchema } from "./launch-product-bindings";
import { parseLaunchReportDocument, type LaunchReportDocument } from "./launch-report";
import { createLaunchReceipt, launchReceiptSchema } from "./launch-receipt";
import { parseProviderLifecycleDocument } from "./provider-lifecycle-store";

const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export const dogfoodEvidenceArtifactRoles = [
  "canonical_launch_contract",
  "harness_lock",
  "venture_manifest",
  "launch_grant",
  "launch_metadata",
  "workflow_state",
  "workflow_events",
  "provider_lifecycle",
  "launch_report",
  "launch_receipt",
  "provider_evidence",
  "production_verification",
] as const;

const dogfoodArtifactSchema = z
  .object({
    role: z.enum(dogfoodEvidenceArtifactRoles),
    nodeId: z.string().regex(SAFE_PATH_SEGMENT).optional(),
    provider: z.enum(providerIds).optional(),
    path: z.string().min(1).max(1_000),
    sourcePath: z.string().min(1).max(1_000),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role === "provider_evidence" && (!value.nodeId || !value.provider)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider evidence requires an exact nodeId and provider",
      });
    }
    if (value.role !== "provider_evidence" && value.provider !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only provider evidence may carry a provider field",
      });
    }
  });

export const dogfoodEvidenceBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    ventureId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
    runId: z.string().regex(RUN_ID),
    harnessSourceSha: z.string().regex(GIT_SHA),
    launchContractDigest: z.string().regex(SHA256),
    graphFingerprint: z.string().regex(SHA256),
    source: z
      .object({
        repository: z.string().min(1).max(1_000),
        branch: z.string().min(1).max(300),
        commitSha: z.string().regex(GIT_SHA),
        treeSha: z.string().regex(GIT_SHA),
        clean: z.literal(true),
      })
      .strict(),
    artifacts: z.array(dogfoodArtifactSchema).min(10).max(200),
  })
  .strict();

export type DogfoodEvidenceBundleManifest = z.infer<typeof dogfoodEvidenceBundleManifestSchema>;

const verifiedProviderEvidenceSchema = z
  .object({
    provider: z.enum(providerIds),
    planId: z.string().regex(/^plan\.[a-z][a-z0-9_-]*\.[a-z0-9]+$/u),
    state: z.literal("verified"),
    environments: z.array(z.string().min(1).max(100)).min(1).max(20),
    capabilities: z.array(z.string().min(1).max(200)).min(1).max(100),
    operations: z
      .array(
        z
          .object({
            id: z.string().min(1).max(300),
            action: z.string().min(1).max(300),
            capability: z.string().min(1).max(200),
            environment: z.string().min(1).max(100),
            status: z.literal("matched"),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    resourceRefs: z.array(z.string().min(1).max(1_000)).max(100),
    publicOutputs: providerPublicOutputsSchema,
    checks: z
      .array(
        z
          .object({
            operationId: z.string().min(1).max(300),
            status: z.literal("matched"),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

type VerifiedProviderEvidenceDocument = z.infer<typeof verifiedProviderEvidenceSchema>;

const launchMetadataSchema = z
  .object({
    schemaVersion: z.literal(2),
    brief: founderBriefSchema,
    decision: z.custom<LaunchDecision>((value) =>
      Boolean(value && typeof value === "object" && !Array.isArray(value)),
    ),
    activeEventPacks: z.array(z.string().min(1).max(200)).max(100),
    routerVersion: z.literal("0.2.0"),
    definition: z.custom<WorkflowDefinition>((value) =>
      Boolean(value && typeof value === "object" && !Array.isArray(value)),
    ),
    authorization: authorizationEnvelopeSchema,
    launchGrant: z.custom<LaunchGrant>((value) =>
      Boolean(value && typeof value === "object" && !Array.isArray(value)),
    ),
    launchContract: launchContractSchema,
    launchContractDigest: z.string().regex(SHA256),
    founderLaunchGaps: z.array(z.unknown()).optional(),
  })
  .strict();

const ventureManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    ventureId: z.string().min(1).max(100),
    ventureName: z.string().min(1).max(200),
    ventureSlug: z.string().min(1).max(100),
    ownerOrganizationId: z.string().min(1).max(500),
    repository: z
      .object({
        owner: z.string().min(1).max(300),
        name: z.string().min(1).max(300),
        visibility: z.enum(["private", "public"]),
      })
      .strict(),
    seed: z.object({ id: z.string(), version: z.string() }).strict(),
    stackProfile: z.object({ id: z.string(), version: z.string() }).strict(),
    rail: z.enum(["web", "ios", "hybrid"]),
    coreVersion: z.string().min(1).max(100),
    launchContractDigest: z.string().regex(SHA256),
    launchContractPath: z.literal("config/launch-contract.yaml"),
    serviceBlueprints: z.array(z.string()).optional(),
    connectorManifest: z.string().min(1),
    agentSurface: z
      .object({
        cli: z.string(),
        mcpPrefix: z.string(),
        sdkPackage: z.string(),
        restPrefix: z.string(),
      })
      .strict()
      .optional(),
    companyResourcesOwnedBy: z.string().min(1),
    advertisingSpendAuthorized: z.literal(false),
  })
  .strict();

const providerCheckpointSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("provider_plan"),
    provider: z.enum(providerIds),
    digest: z.string().regex(SHA256),
    ledgerBinding: z.string().regex(SHA256),
    snapshot: z
      .object({
        target: z
          .object({
            provider: z.enum(providerIds),
            request: z.record(z.unknown()),
            operationBudget: z.unknown().optional(),
          })
          .strict(),
        plan: z
          .object({
            id: z.string().min(1).max(300),
            provider: z.enum(providerIds),
            environment: z.string().min(1).max(100),
            dryRun: z.literal(false),
            operations: z.array(z.record(z.unknown())).min(1).max(100),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

interface BundleArtifactBytes {
  role: (typeof dogfoodEvidenceArtifactRoles)[number];
  nodeId?: string;
  provider?: ProviderId;
  sourcePath: string;
  bytes: Buffer;
}

export interface ExportDogfoodEvidenceBundleOptions {
  ventureRoot: string;
  runId: string;
  outputDirectory: string;
  harnessSourceSha: string;
  now?: () => Date;
}

export interface VerifyDogfoodEvidenceBundleOptions {
  manifestPath: string;
  requiredProviders: readonly string[];
  requiredReceiptStates: readonly string[];
}

export interface VerifiedDogfoodEvidenceBundle {
  manifest: DogfoodEvidenceBundleManifest;
  report: LaunchReportDocument;
  productionUrl: string;
  providers: Record<string, number>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(path: string, label: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.startsWith(".git/")
  ) {
    throw new Error(`${label} is not a safe relative path: ${path}`);
  }
  return path;
}

function readRegularBoundFile(rootInput: string, pathInput: string, label: string): Buffer {
  const root = realpathSync(rootInput);
  const path = safeRelativePath(pathInput, label);
  const target = resolve(root, path);
  const relation = relative(root, target);
  if (relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) {
    throw new Error(`${label} leaves its trusted root`);
  }
  let cursor = root;
  for (const part of relation.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`${label} traverses a symbolic link`);
    if (cursor !== target && !metadata.isDirectory()) {
      throw new Error(`${label} has a non-directory parent component`);
    }
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(target, constants.O_RDONLY | NO_FOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizedRepository(value: string): string {
  const trimmed = value.trim().replace(/\.git$/u, "");
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/u.exec(trimmed);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/u.exec(trimmed);
  if (sshUrl) return `https://github.com/${sshUrl[1]}/${sshUrl[2]}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Dogfood source origin must be a GitHub repository URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Dogfood source origin must be a credential-free GitHub HTTPS URL");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/$/u, "")}`;
}

function resourceMap(evidence: VerifiedProviderEvidenceDocument): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const reference of evidence.resourceRefs) {
    const separator = reference.indexOf("=");
    if (separator < 1) throw new Error(`${evidence.provider} has a malformed resource reference`);
    const type = reference.slice(0, separator);
    const value = reference.slice(separator + 1);
    if (!value) throw new Error(`${evidence.provider} has an empty ${type} reference`);
    result.set(type, [...(result.get(type) ?? []), value]);
  }
  return result;
}

function oneResource(
  evidence: VerifiedProviderEvidenceDocument,
  type: string,
  required = true,
): string | null {
  const values = [...new Set(resourceMap(evidence).get(type) ?? [])];
  if (values.length === 0 && !required) return null;
  if (values.length !== 1) {
    throw new Error(`${evidence.provider} must expose exactly one ${type} resource reference`);
  }
  return values[0]!;
}

function safeHttps(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`${label} must be one origin-only credential-free HTTPS URL`);
  }
  return url;
}

function workflowState(input: unknown, runId: string): WorkflowRunState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Dogfood workflow state root is invalid");
  }
  const state = input as WorkflowRunState;
  if (
    state.schemaVersion !== 1 ||
    state.runId !== runId ||
    !state.graph ||
    !SHA256.test(state.graph.fingerprint) ||
    !state.nodes ||
    typeof state.nodes !== "object" ||
    Array.isArray(state.nodes) ||
    !state.verifiedEffects ||
    typeof state.verifiedEffects !== "object" ||
    Array.isArray(state.verifiedEffects) ||
    !Number.isSafeInteger(state.eventSequence) ||
    state.eventSequence < 1 ||
    state.pendingEvent !== undefined
  ) {
    throw new Error("Dogfood workflow state header or durable effect state is invalid");
  }
  return state;
}

function workflowEvents(bytes: Buffer, runId: string, state: WorkflowRunState): WorkflowEvent[] {
  const events = bytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const event = parseJson(Buffer.from(line), `Workflow event ${index + 1}`) as WorkflowEvent;
      if (event.runId !== runId || event.sequence !== index + 1) {
        throw new Error(`Workflow event ${index + 1} is not bound to ${runId}`);
      }
      return event;
    });
  if (events.length !== state.eventSequence) {
    throw new Error("Workflow state sequence does not match the complete event log");
  }
  return events;
}

function validateCheckpoint(
  nodeId: string,
  node: WorkflowNodeRecord,
  evidence: VerifiedProviderEvidenceDocument,
): z.infer<typeof providerCheckpointSchema> {
  const parsed = providerCheckpointSchema.parse(node.operation?.checkpoint);
  if (
    node.operation?.phase !== "verified" ||
    parsed.provider !== evidence.provider ||
    parsed.snapshot.target.provider !== evidence.provider ||
    parsed.snapshot.plan.provider !== evidence.provider ||
    parsed.snapshot.plan.id !== evidence.planId
  ) {
    throw new Error(`${nodeId} provider checkpoint does not match its verified evidence`);
  }
  if (sha256(canonicalJson(parsed.snapshot)) !== parsed.digest) {
    throw new Error(`${nodeId} provider checkpoint digest is invalid`);
  }
  const checkpointOperations = parsed.snapshot.plan.operations.map((operation) => ({
    id: operation.id,
    action: operation.action,
    capability: operation.capability,
    environment: operation.environment,
  }));
  if (
    checkpointOperations.some(
      (operation) =>
        typeof operation.id !== "string" ||
        typeof operation.action !== "string" ||
        typeof operation.capability !== "string" ||
        typeof operation.environment !== "string",
    ) ||
    !isDeepStrictEqual(
      checkpointOperations,
      evidence.operations.map((operation) => {
        // The per-operation status is deliberately dropped: the bundle reports
        // verified state at the evidence level, not per request.
        const { status, ...withoutStatus } = operation;
        void status;
        return withoutStatus;
      }),
    ) ||
    !isDeepStrictEqual(
      [...new Set(checkpointOperations.map(({ environment }) => environment))].sort(),
      [...evidence.environments].sort(),
    ) ||
    !isDeepStrictEqual(
      [...new Set(checkpointOperations.map(({ capability }) => capability))].sort(),
      [...evidence.capabilities].sort(),
    )
  ) {
    throw new Error(`${nodeId} provider operations differ from their immutable checkpoint`);
  }
  const matchedIds = evidence.checks.map(({ operationId }) => operationId).sort();
  const operationIds = evidence.operations.map(({ id }) => id).sort();
  if (!isDeepStrictEqual(matchedIds, operationIds)) {
    throw new Error(
      `${nodeId} provider checks do not match every immutable operation exactly once`,
    );
  }
  return parsed;
}

function artifactByRole(
  manifest: DogfoodEvidenceBundleManifest,
  role: (typeof dogfoodEvidenceArtifactRoles)[number],
): DogfoodEvidenceBundleManifest["artifacts"] {
  return manifest.artifacts.filter((artifact) => artifact.role === role);
}

function onlyArtifact(
  manifest: DogfoodEvidenceBundleManifest,
  role: Exclude<(typeof dogfoodEvidenceArtifactRoles)[number], "provider_evidence">,
): DogfoodEvidenceBundleManifest["artifacts"][number] {
  const matches = artifactByRole(manifest, role);
  if (matches.length !== 1) throw new Error(`Dogfood bundle needs exactly one ${role} artifact`);
  return matches[0]!;
}

function listedBytes(
  bundleRoot: string,
  artifact: DogfoodEvidenceBundleManifest["artifacts"][number],
): Buffer {
  const bytes = readRegularBoundFile(bundleRoot, artifact.path, `Bundle artifact ${artifact.path}`);
  if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
    throw new Error(`Bundle artifact ${artifact.path} does not match its length and digest`);
  }
  return bytes;
}

function exactBundleFiles(bundleRoot: string, manifest: DogfoodEvidenceBundleManifest): void {
  const actual: string[] = [];
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const reference = prefix ? `${prefix}/${entry.name}` : entry.name;
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Dogfood bundle contains a symlink: ${reference}`);
      if (entry.isDirectory()) visit(path, reference);
      else if (entry.isFile()) actual.push(reference);
      else throw new Error(`Dogfood bundle contains a non-file entry: ${reference}`);
    }
  };
  visit(bundleRoot);
  const expected = ["manifest.json", ...manifest.artifacts.map(({ path }) => path)].sort();
  if (!isDeepStrictEqual(actual.sort(), expected)) {
    throw new Error("Dogfood bundle contains missing, duplicate, or unlisted files");
  }
}

export function readDogfoodEvidenceBundleManifest(
  manifestPath: string,
): DogfoodEvidenceBundleManifest {
  const absolute = resolve(manifestPath);
  if (basename(absolute) !== "manifest.json") {
    throw new Error("Dogfood evidence entry point must be named manifest.json");
  }
  const root = realpathSync(dirname(absolute));
  return dogfoodEvidenceBundleManifestSchema.parse(
    parseJson(
      readRegularBoundFile(root, "manifest.json", "Dogfood bundle manifest"),
      "Dogfood bundle manifest",
    ),
  );
}

function receiptPathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function verifyReportBinding(
  report: LaunchReportDocument,
  state: WorkflowRunState,
  launch: z.infer<typeof launchMetadataSchema>,
): void {
  if (
    report.run.id !== state.runId ||
    report.run.status !== state.status ||
    report.brief.synthetic ||
    report.brief.id !== launch.brief.id ||
    report.brief.name !== launch.brief.name ||
    report.launch.mode !== launch.decision.mode.selectedMode ||
    report.launch.rail !== launch.decision.rail.appKind ||
    report.authorization?.profile !== launch.authorization.profile ||
    report.authorization?.approvalRef !== launch.authorization.approval_ref ||
    report.authorization?.expiresAt !== launch.authorization.expires_at
  ) {
    throw new Error("Launch Report is not bound to the canonical launch metadata and workflow run");
  }
  const reportNodes = new Map(report.nodes.map((node) => [node.id, node]));
  if (reportNodes.size !== Object.keys(state.nodes).length) {
    throw new Error("Launch Report does not cover every workflow node exactly once");
  }
  for (const [nodeId, record] of Object.entries(state.nodes)) {
    const outcome = reportNodes.get(nodeId);
    if (
      !outcome ||
      outcome.capability !== record.definition.capability ||
      outcome.state !== record.state ||
      outcome.effectVerified !== record.effectVerified ||
      outcome.evidenceRef !== record.evidenceArtifact ||
      outcome.errorCode !== record.error?.code ||
      outcome.provider !== launchProviderByNode[nodeId as keyof typeof launchProviderByNode]
    ) {
      throw new Error(`Launch Report node ${nodeId} differs from durable workflow state`);
    }
  }
}

function verifyProviderInvariants(
  provider: string,
  evidenceByNode: Map<string, VerifiedProviderEvidenceDocument>,
  checkpoints: Map<string, z.infer<typeof providerCheckpointSchema>>,
  manifest: DogfoodEvidenceBundleManifest,
  report: LaunchReportDocument,
  productionUrl: string,
  launch: z.infer<typeof launchMetadataSchema>,
): number {
  const entries = [...evidenceByNode.entries()].filter(
    ([, evidence]) => evidence.provider === provider,
  );
  if (entries.length === 0) throw new Error(`Dogfood bundle lacks verified ${provider} evidence`);
  const requiredNode = (nodeId: string): VerifiedProviderEvidenceDocument => {
    const evidence = evidenceByNode.get(nodeId);
    if (!evidence || evidence.provider !== provider) {
      throw new Error(`Dogfood bundle lacks exact ${provider} node ${nodeId}`);
    }
    return evidence;
  };
  if (provider === "github") {
    const evidence = requiredNode("github-repository");
    const refs = resourceMap(evidence);
    const expectedRepository = `${launch.launchGrant.repository.owner}/${launch.launchGrant.repository.name}`;
    const repositoryValues = [
      ...(refs.get("repository") ?? []),
      ...(refs.get("repository_url") ?? []),
    ].map((value) => value.replace(/^https:\/\/github\.com\//u, "").replace(/\.git$/u, ""));
    if (
      launch.launchGrant.repository.visibility !== "private" ||
      !repositoryValues.includes(expectedRepository) ||
      oneResource(evidence, "branch") !== manifest.source.branch ||
      oneResource(evidence, "commit_oid") !== manifest.source.commitSha ||
      oneResource(evidence, "tree_oid") !== manifest.source.treeSha ||
      oneResource(evidence, "visibility") !== "private"
    ) {
      throw new Error("GitHub evidence does not match the private local source branch/commit/tree");
    }
  } else if (provider === "vercel") {
    const evidence = requiredNode("production-deploy");
    if (
      !evidence.environments.includes("production") ||
      !evidence.capabilities.includes("deployment") ||
      oneResource(evidence, "url") !== productionUrl ||
      !oneResource(evidence, "deployment_id")
    ) {
      throw new Error("Vercel evidence is not an exact production deployment read-back");
    }
    safeHttps(productionUrl, "Verified Vercel production URL");
  } else if (provider === "neon") {
    const evidence = requiredNode("neon-database");
    for (const capability of ["project", "schema_migration", "read_write_health_check"]) {
      if (!evidence.capabilities.includes(capability)) {
        throw new Error(`Neon evidence lacks verified ${capability}`);
      }
    }
    oneResource(evidence, "project_id");
    oneResource(evidence, "database_name");
    if (!evidence.environments.includes("production")) {
      throw new Error("Neon evidence is not bound to the production database environment");
    }
  } else if (provider === "stripe") {
    const commerce = requiredNode("stripe-commerce");
    const callbacks = requiredNode("stripe-callbacks");
    for (const evidence of [commerce, callbacks]) {
      if (!evidence.environments.every((environment) => environment === "sandbox")) {
        throw new Error("Stripe evidence contains a non-sandbox operation");
      }
      if (oneResource(evidence, "livemode") !== "false") {
        throw new Error("Stripe evidence lacks exact test-mode read-back");
      }
      if (
        evidence.operations.some(({ action, capability }) =>
          /charge|payment_intent|checkout/u.test(`${action} ${capability}`),
        )
      ) {
        throw new Error("Stripe dogfood evidence contains a charge or checkout operation");
      }
    }
    oneResource(commerce, "product_id");
    oneResource(commerce, "price_id");
    oneResource(commerce, "lookup_key");
    const expectedMinor = Math.round((launch.launchContract.business.priceHypothesis ?? 0) * 100);
    if (
      oneResource(commerce, "amount_minor") !== String(expectedMinor) ||
      oneResource(commerce, "currency")?.toUpperCase() !==
        launch.launchContract.business.currency ||
      !callbacks.capabilities.includes("webhook") ||
      !callbacks.capabilities.includes("billing_portal") ||
      oneResource(callbacks, "url") !== productionUrl ||
      launch.authorization.actual_charges_allowed ||
      launch.authorization.live_products_and_prices_allowed
    ) {
      throw new Error(
        "Stripe product/price/callback evidence differs from the test-mode Launch Contract",
      );
    }
  }
  for (const [nodeId] of entries) {
    if (!checkpoints.has(nodeId)) throw new Error(`${provider} node ${nodeId} lacks a checkpoint`);
    const outcome = report.providers.find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.evidenceRef === `reports/launch/${manifest.runId}/providers/${nodeId}.json`,
    );
    if (!outcome?.verified || outcome.lifecycleState !== "verified") {
      throw new Error(`Launch Report does not preserve verified ${provider} node ${nodeId}`);
    }
  }
  return entries.length;
}

export function verifyDogfoodEvidenceBundle(
  options: VerifyDogfoodEvidenceBundleOptions,
): VerifiedDogfoodEvidenceBundle {
  const manifestAbsolute = resolve(options.manifestPath);
  const bundleRoot = realpathSync(dirname(manifestAbsolute));
  const manifest = readDogfoodEvidenceBundleManifest(manifestAbsolute);
  exactBundleFiles(bundleRoot, manifest);
  if (new Set(manifest.artifacts.map(({ path }) => path)).size !== manifest.artifacts.length) {
    throw new Error("Dogfood bundle artifact paths must be unique");
  }
  for (const artifact of manifest.artifacts) listedBytes(bundleRoot, artifact);

  const contract = launchContractSchema.parse(
    parseYaml(
      listedBytes(bundleRoot, onlyArtifact(manifest, "canonical_launch_contract")).toString("utf8"),
    ),
  );
  const harnessLock = parseHarnessLock(
    listedBytes(bundleRoot, onlyArtifact(manifest, "harness_lock")).toString("utf8"),
  );
  const contractDigest = launchContractDigest(contract);
  const ventureManifest = ventureManifestSchema.parse(
    parseJson(
      listedBytes(bundleRoot, onlyArtifact(manifest, "venture_manifest")),
      "Venture manifest",
    ),
  );
  const grant = parseLaunchGrant(
    parseJson(listedBytes(bundleRoot, onlyArtifact(manifest, "launch_grant")), "Launch Grant"),
  );
  const launch = launchMetadataSchema.parse(
    parseJson(
      listedBytes(bundleRoot, onlyArtifact(manifest, "launch_metadata")),
      "Launch metadata",
    ),
  );
  const embeddedGrant = parseLaunchGrant(launch.launchGrant);
  validateWorkflow(launch.definition);
  const fingerprint = workflowFingerprint(launch.definition);
  if (
    contractDigest !== manifest.launchContractDigest ||
    harnessLock.lock_version !== 2 ||
    harnessLock.workflow_ref_sha !== manifest.harnessSourceSha ||
    launch.launchContractDigest !== contractDigest ||
    launchContractDigest(launch.launchContract) !== contractDigest ||
    grant.ideaDigest !== contractDigest ||
    embeddedGrant.ideaDigest !== contractDigest ||
    ventureManifest.launchContractDigest !== contractDigest ||
    ventureManifest.launchContractPath !== "config/launch-contract.yaml" ||
    manifest.ventureId !== ventureManifest.ventureId ||
    grant.ventureSlug !== contract.venture.slug ||
    ventureManifest.ventureSlug !== contract.venture.slug ||
    launch.authorization.run_id !== manifest.runId ||
    fingerprint !== manifest.graphFingerprint ||
    !isDeepStrictEqual(launch.launchContract, contract) ||
    !isDeepStrictEqual(embeddedGrant, grant) ||
    !isDeepStrictEqual(launch.brief, founderBriefFromLaunchContract(contract)) ||
    !isDeepStrictEqual(launch.decision, launchDecisionFromContract(contract))
  ) {
    throw new Error(
      "Dogfood bundle Launch Contract, Grant, manifest, graph, or authorization binding is invalid",
    );
  }

  const state = workflowState(
    parseJson(listedBytes(bundleRoot, onlyArtifact(manifest, "workflow_state")), "Workflow state"),
    manifest.runId,
  );
  if (
    state.graph.id !== launch.definition.id ||
    state.graph.version !== launch.definition.version ||
    state.graph.fingerprint !== fingerprint
  ) {
    throw new Error("Workflow state graph differs from the immutable launch definition");
  }
  const events = workflowEvents(
    listedBytes(bundleRoot, onlyArtifact(manifest, "workflow_events")),
    manifest.runId,
    state,
  );
  const lifecycle = parseProviderLifecycleDocument(
    parseJson(
      listedBytes(bundleRoot, onlyArtifact(manifest, "provider_lifecycle")),
      "Provider lifecycle state",
    ),
  );
  const report = parseLaunchReportDocument(
    parseJson(listedBytes(bundleRoot, onlyArtifact(manifest, "launch_report")), "Launch Report"),
  );
  verifyReportBinding(report, state, launch);
  const receipt = launchReceiptSchema.parse(
    parseJson(listedBytes(bundleRoot, onlyArtifact(manifest, "launch_receipt")), "Launch Receipt"),
  );

  const evidenceByNode = new Map<string, VerifiedProviderEvidenceDocument>();
  const checkpoints = new Map<string, z.infer<typeof providerCheckpointSchema>>();
  for (const artifact of artifactByRole(manifest, "provider_evidence")) {
    const nodeId = artifact.nodeId!;
    const provider = artifact.provider!;
    const expectedReference = `reports/launch/${manifest.runId}/providers/${nodeId}.json`;
    if (artifact.sourcePath !== expectedReference) {
      throw new Error(`${nodeId} provider artifact is not at its exact run-scoped source path`);
    }
    const evidence = verifiedProviderEvidenceSchema.parse(
      parseJson(listedBytes(bundleRoot, artifact), `${provider} evidence for ${nodeId}`),
    );
    const node = state.nodes[nodeId];
    if (
      evidence.provider !== provider ||
      !node ||
      node.definition.kind !== "provider" ||
      launchProviderByNode[nodeId as keyof typeof launchProviderByNode] !== provider ||
      node.state !== "succeeded" ||
      !node.effectVerified ||
      node.evidenceArtifact !== expectedReference ||
      !isDeepStrictEqual(node.output, evidence) ||
      !isDeepStrictEqual(state.verifiedEffects[nodeId]?.output, evidence) ||
      state.verifiedEffects[nodeId]?.evidenceArtifact !== expectedReference ||
      !events.some(
        ({ type, nodeId: eventNode }) => type === "node_succeeded" && eventNode === nodeId,
      )
    ) {
      throw new Error(`${nodeId} provider evidence is not bound to the durable verified effect`);
    }
    const checkpoint = validateCheckpoint(nodeId, node, evidence);
    const expectedLifecycle = evidence.operations.map(({ capability, environment }) =>
      lifecycle.find(
        (record) =>
          record.provider === provider &&
          record.environment === environment &&
          record.capability === capability &&
          record.planId === evidence.planId &&
          isDeepStrictEqual(
            record.resourceRefs.map(({ type, value }) => `${type}=${value}`).sort(),
            [...evidence.resourceRefs].sort(),
          ),
      ),
    );
    if (expectedLifecycle.some((record) => !record)) {
      throw new Error(`${nodeId} provider evidence differs from durable lifecycle read-back state`);
    }
    evidenceByNode.set(nodeId, evidence);
    checkpoints.set(nodeId, checkpoint);
  }

  const verificationArtifact = onlyArtifact(manifest, "production_verification");
  const verificationNodeId = verificationArtifact.nodeId;
  if (!verificationNodeId) throw new Error("Production verification artifact requires a nodeId");
  const verificationNode = state.nodes[verificationNodeId];
  const verificationDocument = parseJson(
    listedBytes(bundleRoot, verificationArtifact),
    "Production verification evidence",
  ) as Record<string, unknown>;
  const verificationOutput = launchProductionVerificationOutputSchema.parse(
    verificationDocument.output,
  );
  if (
    !verificationNode ||
    !["verify-production", "verify-custom-domain"].includes(verificationNodeId) ||
    verificationNode.state !== "succeeded" ||
    !verificationNode.effectVerified ||
    verificationNode.evidenceArtifact !== verificationArtifact.sourcePath ||
    verificationDocument.runId !== manifest.runId ||
    verificationDocument.nodeId !== verificationNodeId ||
    verificationOutput.runId !== manifest.runId ||
    verificationOutput.evidenceRef !== verificationArtifact.sourcePath ||
    !isDeepStrictEqual(verificationNode.output, verificationOutput) ||
    !isDeepStrictEqual(state.verifiedEffects[verificationNodeId]?.output, verificationOutput) ||
    state.verifiedEffects[verificationNodeId]?.evidenceArtifact !==
      verificationArtifact.sourcePath ||
    !events.some(({ type, nodeId }) => type === "node_succeeded" && nodeId === verificationNodeId)
  ) {
    throw new Error("Production journey evidence is not bound to the same durable workflow run");
  }
  const productionUrl = safeHttps(
    verificationOutput.deploymentUrl,
    "Production verification deployment URL",
  ).toString();

  const providerCounts: Record<string, number> = {};
  for (const provider of options.requiredProviders) {
    if (!providerIds.includes(provider as (typeof providerIds)[number])) {
      throw new Error(`Unknown required dogfood provider: ${provider}`);
    }
    providerCounts[provider] = verifyProviderInvariants(
      provider,
      evidenceByNode,
      checkpoints,
      manifest,
      report,
      productionUrl,
      launch,
    );
  }

  const regeneratedReceipt = createLaunchReceipt({
    state,
    report,
    decision: launch.decision,
    launchContract: contract,
    launchGrant: grant,
    launchGaps: launch.founderLaunchGaps as never,
    verification: {
      accessibility: verificationOutput.accessibility.state,
      rawHtml: verificationOutput.rawHtml.state,
      primaryJourneyEvidence: verificationOutput.primaryJourneyEvidence,
      deploymentEvidence: {
        state:
          verificationOutput.primaryJourneyEvidence.state === "fixture" ? "fixture" : "verified",
        productionUrl: verificationOutput.deploymentUrl,
        customDomain:
          verificationOutput.target === "verified_custom_domain"
            ? verificationOutput.customDomain.origin
            : null,
        evidenceRef: verificationOutput.evidenceRef,
      },
    },
  });
  if (!isDeepStrictEqual(receipt, regeneratedReceipt)) {
    throw new Error("Launch Receipt is not the exact deterministic projection of this bundle run");
  }
  if (
    receipt.venture.productionUrl !== productionUrl ||
    normalizedRepository(receipt.venture.repository) !== manifest.source.repository ||
    receipt.verification.primaryJourney !== "verified" ||
    receipt.verification.accessibility !== "verified" ||
    receipt.verification.rawHtml !== "verified"
  ) {
    throw new Error("Launch Receipt does not preserve the exact verified source, URL, and journey");
  }
  for (const path of options.requiredReceiptStates) {
    if (receiptPathValue(receipt, path) !== "verified") {
      throw new Error(`Launch Receipt state ${path} is not verified`);
    }
  }
  return { manifest, report, productionUrl, providers: providerCounts };
}

function bundleTargetPath(artifact: BundleArtifactBytes): string {
  switch (artifact.role) {
    case "provider_evidence":
      return `artifacts/providers/${artifact.nodeId}.json`;
    case "production_verification":
      return `artifacts/product/${artifact.nodeId}.json`;
    case "workflow_events":
      return "artifacts/workflow-events.jsonl";
    case "canonical_launch_contract":
      return "artifacts/canonical-launch-contract.yaml";
    case "harness_lock":
      return "artifacts/harness.lock";
    default:
      return `artifacts/${artifact.role.replaceAll("_", "-")}.json`;
  }
}

function writeExclusive(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}

export function exportDogfoodEvidenceBundle(
  options: ExportDogfoodEvidenceBundleOptions,
): DogfoodEvidenceBundleManifest {
  if (!RUN_ID.test(options.runId)) throw new Error("Dogfood run ID is invalid");
  if (!GIT_SHA.test(options.harnessSourceSha)) {
    throw new Error("Dogfood export requires the exact 40-character reviewed Harness source SHA");
  }
  const ventureRoot = realpathSync(options.ventureRoot);
  if (!statSync(join(ventureRoot, ".git")).isDirectory()) {
    throw new Error("Dogfood venture must be a normal local Git repository");
  }
  if (git(ventureRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("Dogfood source worktree must be clean before evidence export");
  }
  const source = {
    repository: normalizedRepository(git(ventureRoot, ["remote", "get-url", "origin"])),
    branch: git(ventureRoot, ["branch", "--show-current"]),
    commitSha: git(ventureRoot, ["rev-parse", "HEAD"]),
    treeSha: git(ventureRoot, ["rev-parse", "HEAD^{tree}"]),
    clean: true as const,
  };
  if (!source.branch || !GIT_SHA.test(source.commitSha) || !GIT_SHA.test(source.treeSha)) {
    throw new Error("Dogfood source branch, commit, or tree could not be read back");
  }

  const fixed: BundleArtifactBytes[] = [
    ["canonical_launch_contract", "config/launch-contract.yaml"],
    ["harness_lock", "harness.lock"],
    ["venture_manifest", "venture.manifest.json"],
    ["launch_grant", ".venture/launch-grant.json"],
    ["launch_metadata", `.venture/launches/${options.runId}.json`],
    ["workflow_state", `.venture/runs/${options.runId}/state.json`],
    ["workflow_events", `.venture/runs/${options.runId}/events.jsonl`],
    ["provider_lifecycle", ".venture/provider-lifecycle.json"],
    ["launch_report", `reports/launch/${options.runId}/final.json`],
    ["launch_receipt", `reports/launch/${options.runId}/receipt.json`],
  ].map(([role, sourcePath]) => ({
    role: role as BundleArtifactBytes["role"],
    sourcePath,
    bytes: readRegularBoundFile(ventureRoot, sourcePath, `${role} source`),
  }));
  const state = workflowState(
    parseJson(fixed.find(({ role }) => role === "workflow_state")!.bytes, "Workflow state"),
    options.runId,
  );
  const providerArtifacts: BundleArtifactBytes[] = Object.entries(state.nodes)
    .filter(([, node]) => node.definition.kind === "provider" && node.state === "succeeded")
    .map(([nodeId, node]) => {
      const provider = launchProviderByNode[nodeId as keyof typeof launchProviderByNode];
      const sourcePath = node.evidenceArtifact;
      if (!provider || !sourcePath) {
        throw new Error(`Succeeded provider node ${nodeId} lacks a mapped evidence artifact`);
      }
      return {
        role: "provider_evidence" as const,
        nodeId,
        provider: provider as (typeof providerIds)[number],
        sourcePath,
        bytes: readRegularBoundFile(ventureRoot, sourcePath, `${nodeId} provider evidence`),
      };
    });
  const verificationNodeId =
    state.nodes["verify-custom-domain"]?.state === "succeeded"
      ? "verify-custom-domain"
      : "verify-production";
  const verificationNode = state.nodes[verificationNodeId];
  if (!verificationNode?.evidenceArtifact) {
    throw new Error("Dogfood run has no successful production verification evidence");
  }
  const artifacts = [
    ...fixed,
    ...providerArtifacts,
    {
      role: "production_verification" as const,
      nodeId: verificationNodeId,
      sourcePath: verificationNode.evidenceArtifact,
      bytes: readRegularBoundFile(
        ventureRoot,
        verificationNode.evidenceArtifact,
        "Production verification evidence",
      ),
    },
  ];
  const launch = launchMetadataSchema.parse(
    parseJson(fixed.find(({ role }) => role === "launch_metadata")!.bytes, "Launch metadata"),
  );
  const manifest: DogfoodEvidenceBundleManifest = dogfoodEvidenceBundleManifestSchema.parse({
    schemaVersion: 1,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    ventureId: ventureManifestSchema.parse(
      parseJson(fixed.find(({ role }) => role === "venture_manifest")!.bytes, "Venture manifest"),
    ).ventureId,
    runId: options.runId,
    harnessSourceSha: options.harnessSourceSha,
    launchContractDigest: launchContractDigest(launch.launchContract),
    graphFingerprint: workflowFingerprint(launch.definition),
    source,
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      ...(artifact.nodeId ? { nodeId: artifact.nodeId } : {}),
      ...(artifact.provider ? { provider: artifact.provider } : {}),
      path: bundleTargetPath(artifact),
      sourcePath: artifact.sourcePath,
      bytes: artifact.bytes.byteLength,
      sha256: sha256(artifact.bytes),
    })),
  });
  const output = resolve(options.outputDirectory);
  if (existsSync(output)) {
    throw new Error(
      `Dogfood evidence output already exists; review and move it before re-export: ${output}`,
    );
  }
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const staging = join(
    dirname(output),
    `.${basename(output)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const [index, artifact] of artifacts.entries()) {
      writeExclusive(join(staging, manifest.artifacts[index]!.path), artifact.bytes);
    }
    writeExclusive(
      join(staging, "manifest.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );
    verifyDogfoodEvidenceBundle({
      manifestPath: join(staging, "manifest.json"),
      requiredProviders: [
        "github",
        "vercel",
        "neon",
        ...(launch.launchContract.business.paymentProvider === "stripe" ? ["stripe"] : []),
      ],
      requiredReceiptStates: [
        "verification.repository",
        "verification.deployment",
        ...(launch.brief.needs.database ? ["verification.database"] : []),
        ...(launch.launchContract.business.paymentProvider === "stripe"
          ? ["verification.commerce"]
          : []),
        "verification.primaryJourney",
        "verification.accessibility",
        "verification.rawHtml",
      ],
    });
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}
