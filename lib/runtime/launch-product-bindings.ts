import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { mobileSchema } from "../config/mobile-schema";
import { routeRail, type FounderBrief } from "../launch";
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
  type WorkflowHandlerContext,
  type WorkflowHandlerResult,
  type WorkflowReconciliationContext,
  type WorkflowReconciliationResult,
} from "../workflow";
import type {
  BuildAgentArtifactRole,
  BuildAgentCompletionArtifact,
  BuildAgentHost,
  BuildAgentResult,
} from "./build-agent-host";

const AGENT_TASKS: Readonly<Record<string, string>> = {
  "launch.prepareRepository":
    "Inspect the selected rail and existing repository, then create or adapt only the smallest venture-owned scaffold needed for the brief. Resolve every package needed by the planned product into package.json and the exact child lockfile now; dependency inputs are finalized immediately after this task and later tasks may not mutate them. Preserve managed contracts and existing project-owned work. Record assumptions instead of inventing non-critical product detail.",
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

const QUALITY_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "launch.verifyLocal": ["verify:fast"],
  "launch.verifyMvp": ["verify:mvp"],
};

export const CHILD_DEPENDENCY_INSTALL_ARGS = [
  "install",
  "--frozen-lockfile",
  "--ignore-workspace",
  "--ignore-scripts",
  "--prod=false",
] as const;

const DEPENDENCY_INSTALL_CHECKPOINT_SCHEMA_VERSION = 1;

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

const POST_DEPLOY_TEST_ARGS = [
  "exec",
  "playwright",
  "test",
  "tests/e2e/post-deploy-readonly.spec.ts",
] as const;

interface AgentCompletionPolicy {
  requiredArtifactRoles: readonly BuildAgentArtifactRole[];
  relevantValidator: RegExp;
}

const COMPLETION_POLICIES: Readonly<Record<string, AgentCompletionPolicy>> = {
  "launch.prepareRepository": {
    requiredArtifactRoles: ["repository_scaffold", "managed_manifest"],
    relevantValidator:
      /(?:scaffold|manifest|harness[-:]?lock|validate:configs|verify:(?:fast|mvp)|test[^\n]*(?:config|scaffold))/i,
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

interface RepositoryFileState {
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
}

type RepositorySnapshot = Map<string, string>;

export interface LaunchProductBindingsOptions {
  rootDir: string;
  brief: FounderBrief;
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

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  if (
    !existsSync(packagePath) ||
    !lstatSync(packagePath).isFile() ||
    !existsSync(lockPath) ||
    !lstatSync(lockPath).isFile()
  ) {
    return {
      ...expected,
      state: "input_mismatch",
      installedModulesReadBack: false,
      installedLockfileReadBack: false,
      requiredToolingReadBack: false,
      message: "The checkpointed package manifest or lockfile is missing or not a regular file.",
    };
  }

  const currentPackageSha256 = sha256(packagePath);
  const currentLockSha256 = sha256(lockPath);
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
    installedModulesReadBack &&
    existsSync(installedLockPath) &&
    lstatSync(installedLockPath).isFile() &&
    sha256(installedLockPath) === expected.lockfileSha256;
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
      if (entry.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const reference = relative(root, absolute).split(sep).join("/");
      snapshot.set(reference, sha256(absolute));
    }
  };
  visit(root);
  return snapshot;
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

function taskInstructions(handler: string, instructions: string): string {
  const policy = COMPLETION_POLICIES[handler];
  if (!policy) return instructions;
  return [
    instructions,
    `Completion evidence must include these artifact roles: ${policy.requiredArtifactRoles.join(", ")}.`,
    "For outcome=changed, report every repository file whose content changed and name at least one changed completion artifact. For outcome=already_compliant, change no repository content and cite unchanged artifacts that already satisfy every required role.",
    "The completion validator must name one directly executed, relevant check from checks; it must pass and include observed evidence.",
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
  if (!existsSync(paths.absolute) || !lstatSync(paths.absolute).isFile()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.absolute, "utf8"));
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
  const readBack = JSON.parse(readFileSync(paths.absolute, "utf8")) as {
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
  const configured = existsSync(configPath)
    ? mobileSchema.parse(parse(readFileSync(configPath, "utf8"))).mobile
    : undefined;
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

async function runAgentTask(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "brief" | "agentHost">> & {
    redactor: Redactor;
    now: () => Date;
  },
  instructions: string,
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
  const handler = context.node.handler ?? context.node.id;
  const policy = COMPLETION_POLICIES[handler];
  const before = repositorySnapshot(options.rootDir);
  let result: BuildAgentResult;
  try {
    result = options.redactor.redact(
      await options.agentHost.run({
        runId: context.runId,
        nodeId: context.node.id,
        purpose: context.node.purpose,
        instructions: taskInstructions(handler, instructions),
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
          dependencyOutputs: context.dependencyOutputs,
        } as unknown as JsonValue,
        signal: context.signal,
      }),
    );
  } catch (error) {
    const changes = repositoryChanges(before, repositorySnapshot(options.rootDir));
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
        error: options.redactor.redactText(error instanceof Error ? error.message : String(error)),
        rawPromptPersisted: false,
        rawJsonlPersisted: false,
      },
      options.redactor,
    );
    throw new WorkflowExecutionError(
      "BUILD_AGENT_FAILED",
      `Build agent failed ${context.node.id}; inspect ${evidenceArtifact}.`,
    );
  }

  const after = repositorySnapshot(options.rootDir);
  const observedChanges = repositoryChanges(before, after);
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
    context.trace({ host: options.agentHost.id, evidenceArtifact, status: result.status });
    throw new WorkflowExecutionError(
      "BUILD_AGENT_BLOCKED",
      `Build agent did not complete ${context.node.id}; inspect ${evidenceArtifact}.`,
    );
  }

  let validation: AgentCompletionValidation;
  try {
    validation = validateAgentCompletion(options.rootDir, handler, result, before, after);
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
  context.trace({ host: options.agentHost.id, evidenceArtifact, status: result.status });
  const meteredTokens = result.usage ? result.usage.inputTokens + result.usage.outputTokens : 0;
  return {
    output,
    effectVerified: true,
    evidenceArtifact,
    ...(context.node.cost.unit === "tokens" && meteredTokens > 0
      ? {
          costs: [
            {
              kind: "model" as const,
              category: context.node.budgetCategory,
              amount: meteredTokens,
              unit: "tokens",
              inputTokens: result.usage!.inputTokens,
              outputTokens: result.usage!.outputTokens,
              tool: options.agentHost.id,
              metadata: { cachedInputTokens: result.usage!.cachedInputTokens },
            },
          ],
        }
      : {}),
  };
}

async function runQualityCommand(
  options: Required<Pick<LaunchProductBindingsOptions, "rootDir" | "commandRunner">> & {
    redactor: Redactor;
    now: () => Date;
  },
  args: readonly string[],
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
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
    output: { command: ["pnpm", ...args], exitCode: result.exitCode },
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
  let checkpoint: DependencyInstallCheckpoint | null = null;

  try {
    if (!existsSync(packagePath) || !lstatSync(packagePath).isFile()) {
      throw new Error("package.json is missing or is not a regular file");
    }
    if (!existsSync(lockPath) || !lstatSync(lockPath).isFile()) {
      throw new Error("pnpm-lock.yaml is missing or is not a regular file");
    }
    packageManifestSha256 = sha256(packagePath);
    lockfileSha256 = sha256(lockPath);
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
          "pnpm exited successfully but the exact locked modules and required development tools were absent on read-back",
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
      lifecycleScriptsDisabled: true,
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
      lifecycleScriptsDisabled: true,
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
  const persisted = JSON.parse(readFileSync(paths.absolute, "utf8")) as {
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
      lifecycleScriptsDisabled: true,
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
    try {
      const url = new URL(reference.slice("url=".length));
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
        continue;
      }
      origins.add(url.origin);
    } catch {
      // A malformed provider value is never guessed at.
    }
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
    redactor: Redactor;
    now: () => Date;
  },
  context: WorkflowHandlerContext,
): Promise<WorkflowHandlerResult> {
  const startedAt = options.now().toISOString();
  const deploymentUrl = productionDeploymentUrl(context);
  const result = await options.commandRunner.run({
    command: "pnpm",
    args: POST_DEPLOY_TEST_ARGS,
    cwd: options.rootDir,
    env: {
      PLAYWRIGHT_BASE_URL: deploymentUrl,
      ...(options.brief.domain
        ? { EXPECTED_PUBLIC_ORIGIN: `https://${options.brief.domain}` }
        : {}),
    },
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
      deploymentUrl,
      command: ["pnpm", ...POST_DEPLOY_TEST_ARGS],
      checks: ["HTTPS response", "desktop read-only journey", "mobile read-only journey"],
      exitCode: result.exitCode,
      stdoutExcerpt: options.redactor.redactText(result.stdout).slice(-4_000),
      stderrExcerpt: options.redactor.redactText(result.stderr).slice(-4_000),
      limitations: [
        "This is a read-only post-deploy smoke and critical-surface check; it does not prove provider uptime or conversion behavior.",
      ],
    },
    options.redactor,
  );
  context.trace({
    command: ["pnpm", ...POST_DEPLOY_TEST_ARGS],
    deploymentUrl,
    exitCode: result.exitCode,
    evidenceArtifact,
  });
  if (result.exitCode !== 0) {
    throw new WorkflowExecutionError(
      "POST_DEPLOY_VERIFICATION_FAILED",
      `Read-only production journey checks exited ${result.exitCode}; inspect ${evidenceArtifact}.`,
    );
  }
  return {
    output: {
      deploymentUrl,
      command: ["pnpm", ...POST_DEPLOY_TEST_ARGS],
      exitCode: 0,
      verified: true,
    },
    evidenceArtifact,
  };
}

export async function assertBuildAgentHostAvailable(host: BuildAgentHost): Promise<void> {
  const inspection = await host.inspect();
  if (inspection.status !== "available") {
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
        { rootDir, brief: options.brief, agentHost: options.agentHost, redactor, now },
        instructions,
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
        { rootDir, commandRunner: options.commandRunner, redactor, now },
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
      { rootDir, commandRunner: options.commandRunner, brief: options.brief, redactor, now },
      context,
    );
  };
  return { handlers, reconcilers };
}
