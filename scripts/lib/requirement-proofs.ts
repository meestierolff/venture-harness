import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";

export const TERMINAL_REQUIREMENT_STATUSES = [
  "VERIFIED_RUNTIME",
  "VERIFIED_INTEGRATION",
  "VERIFIED_FIXTURE",
  "IMPLEMENTED_LIVE_VERIFICATION_PENDING",
  "EXTERNAL_BLOCKER",
  "NOT_APPLICABLE",
  "DEFERRED_POST_ALPHA",
] as const;

export const NONTERMINAL_REQUIREMENT_STATUSES = [
  "PARTIAL",
  "STUB",
  "MISSING",
  "INCORRECT",
  "CONTRADICTED_BY_RUNTIME",
] as const;

export type TerminalRequirementStatus = (typeof TERMINAL_REQUIREMENT_STATUSES)[number];
export type NonterminalRequirementStatus = (typeof NONTERMINAL_REQUIREMENT_STATUSES)[number];
export type RequirementProofStatus = TerminalRequirementStatus | NonterminalRequirementStatus;
export type RequirementPriority = "P0" | "P1" | "P2" | "P3";

export interface RequirementBaseline {
  id: string;
  group: string;
  priority: RequirementPriority;
  requirement: string;
  status: string;
  evidence: string[];
  gap: string;
}

export interface CommandEvidenceRecord {
  id: string;
  attempt?: number;
  command: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: string;
  exitCode: number | null;
  skipped: boolean;
  evidencePath: string;
  integrityVersion?: 1;
  evidenceSha256?: string;
  evidenceBytes?: number;
  artifacts?: CommandArtifactEvidence[];
}

export interface CommandArtifactEvidence {
  path: string;
  sha256: string;
  bytes: number;
  generatedDuringCommand: true;
}

export interface RequirementCommandContract {
  command: string;
  cwd: string;
  artifacts: string[];
}

export type RequirementVerification =
  | {
      kind: "test";
      path: string;
      commandId: string;
    }
  | {
      kind: "command";
      commandId: string;
    }
  | {
      kind: "artifact";
      path: string;
      jsonPath: string;
      expected: string | number | boolean;
      commandId: string;
    }
  | {
      kind: "expected_incomplete_quality_profile";
      path: string;
      commandId: string;
      profile: "release";
      expectedStatus: "INCOMPLETE";
      allowedSkipIds: string[];
    };

export interface RequirementProof {
  id: string;
  priority: RequirementPriority;
  requirement: string;
  status: RequirementProofStatus;
  evidenceCeiling:
    | "LOCAL_RUNTIME"
    | "LOCAL_INTEGRATION"
    | "SYNTHETIC_FIXTURE"
    | "IMPLEMENTATION_ONLY"
    | "EXTERNAL_BLOCKER"
    | "NOT_APPLICABLE"
    | "DEFERRED_POST_ALPHA"
    | "NONTERMINAL_LOCAL_IMPLEMENTATION";
  evidence: string[];
  result: string;
  verification: RequirementVerification[];
  reviewedAt: string;
  reviewedBy: "codex-independent-audit";
  liveVerification?: {
    attempted: false;
    reason: string;
    command: string;
    evidenceRequired: string;
  };
  blockingGap?: {
    reason: string;
    missingExecutablePath: string;
    nextAction: string;
  };
}

export interface RequirementProofCatalog {
  schemaVersion: 2;
  branch: string;
  evidenceCeiling: "LOCAL_RUNTIME_AND_SYNTHETIC_FIXTURES";
  commandContracts: Record<string, RequirementCommandContract>;
  proofs: RequirementProof[];
}

const statusCeiling: Readonly<Record<RequirementProofStatus, RequirementProof["evidenceCeiling"]>> =
  {
    VERIFIED_RUNTIME: "LOCAL_RUNTIME",
    VERIFIED_INTEGRATION: "LOCAL_INTEGRATION",
    VERIFIED_FIXTURE: "SYNTHETIC_FIXTURE",
    IMPLEMENTED_LIVE_VERIFICATION_PENDING: "IMPLEMENTATION_ONLY",
    EXTERNAL_BLOCKER: "EXTERNAL_BLOCKER",
    NOT_APPLICABLE: "NOT_APPLICABLE",
    DEFERRED_POST_ALPHA: "DEFERRED_POST_ALPHA",
    PARTIAL: "NONTERMINAL_LOCAL_IMPLEMENTATION",
    STUB: "NONTERMINAL_LOCAL_IMPLEMENTATION",
    MISSING: "NONTERMINAL_LOCAL_IMPLEMENTATION",
    INCORRECT: "NONTERMINAL_LOCAL_IMPLEMENTATION",
    CONTRADICTED_BY_RUNTIME: "NONTERMINAL_LOCAL_IMPLEMENTATION",
  };

const ALL_REQUIREMENT_PROOF_STATUSES = [
  ...TERMINAL_REQUIREMENT_STATUSES,
  ...NONTERMINAL_REQUIREMENT_STATUSES,
] as const;

const QUAL_013_RELEASE_COMMAND =
  "pnpm verify:release -- --report reports/audit/quality-release.json";
const QUAL_013_RELEASE_REPORT = "reports/audit/quality-release.json";
const QUAL_013_ALLOWED_RELEASE_SKIPS = ["analytics_readiness", "live_analytics_readback"] as const;

function assertRelativePath(relativePath: string, label: string): void {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("..")) {
    throw new Error(`${label} must be a repository-relative path: ${relativePath}`);
  }
}

function canonicalRepositoryRelativeCwd(value: string, label: string): string {
  if (!value || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a portable repository-relative directory: ${value}`);
  }
  const normalized = posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must stay inside the repository: ${value}`);
  }
  return normalized;
}

function assertPath(root: string, relativePath: string, label: string): string {
  assertRelativePath(relativePath, label);
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) throw new Error(`${label} does not exist: ${relativePath}`);
  return absolutePath;
}

function fileDigest(path: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function latestCommands(
  records: readonly CommandEvidenceRecord[],
): Map<string, CommandEvidenceRecord> {
  const latest = new Map<string, CommandEvidenceRecord>();
  const attempts = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.command !== "string" ||
      typeof record.status !== "string" ||
      typeof record.skipped !== "boolean" ||
      typeof record.evidencePath !== "string"
    ) {
      throw new Error("command evidence contains a malformed record");
    }
    if (!record.id.trim() || !record.command.trim()) {
      throw new Error("command evidence has an empty id or command");
    }
    if (
      record.attempt !== undefined &&
      (!Number.isSafeInteger(record.attempt) || record.attempt < 1)
    ) {
      throw new Error(`command ${record.id} has an invalid attempt`);
    }
    const attemptKey = `${record.id}:${record.attempt ?? "legacy-unversioned"}`;
    if (attempts.has(attemptKey)) {
      throw new Error(`duplicate command attempt ${attemptKey}`);
    }
    attempts.add(attemptKey);
    const previous = latest.get(record.id);
    if (
      !previous ||
      (record.attempt ?? 1) > (previous.attempt ?? 1) ||
      ((record.attempt ?? 1) === (previous.attempt ?? 1) && index > records.indexOf(previous))
    ) {
      latest.set(record.id, record);
    }
  }
  return latest;
}

function assertIntegrityRecord(
  record: CommandEvidenceRecord,
  contract: RequirementCommandContract,
  root: string,
): void {
  if (record.command !== contract.command) {
    throw new Error(
      `command ${record.id} exact-command mismatch: expected ${JSON.stringify(contract.command)}, received ${JSON.stringify(record.command)}`,
    );
  }
  if (
    record.integrityVersion !== 1 ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt! < 1 ||
    typeof record.cwd !== "string" ||
    typeof record.startedAt !== "string" ||
    typeof record.endedAt !== "string" ||
    !Number.isSafeInteger(record.durationMs) ||
    record.durationMs! < 0 ||
    typeof record.evidenceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.evidenceSha256) ||
    !Number.isSafeInteger(record.evidenceBytes) ||
    record.evidenceBytes! < 0 ||
    !Array.isArray(record.artifacts)
  ) {
    throw new Error(
      `command ${record.id} uses legacy evidence without integrity metadata; rerun it with scripts/run-audit-command.mjs`,
    );
  }
  const recordedCwd = canonicalRepositoryRelativeCwd(record.cwd, `command ${record.id} cwd`);
  if (record.cwd !== recordedCwd) {
    throw new Error(`command ${record.id} cwd is not canonical: ${record.cwd}`);
  }
  const expectedCwd = canonicalRepositoryRelativeCwd(
    contract.cwd,
    `command contract ${record.id} cwd`,
  );
  if (recordedCwd !== expectedCwd) {
    throw new Error(
      `command ${record.id} cwd mismatch: expected ${expectedCwd}, received ${recordedCwd}`,
    );
  }
  const startedAt = Date.parse(record.startedAt);
  const endedAt = Date.parse(record.endedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    endedAt < startedAt ||
    endedAt - startedAt !== record.durationMs
  ) {
    throw new Error(`command ${record.id} has an invalid execution interval`);
  }
  const expectedEvidencePath = `reports/audit/command-logs/${record.id}.attempt-${record.attempt}.log`;
  if (record.evidencePath !== expectedEvidencePath) {
    throw new Error(
      `command ${record.id} evidence must be its dedicated audit log: ${expectedEvidencePath}`,
    );
  }
  const evidencePath = assertPath(root, record.evidencePath, `command ${record.id} evidence`);
  if (!lstatSync(evidencePath).isFile()) {
    throw new Error(`command ${record.id} evidence is not a regular file: ${record.evidencePath}`);
  }
  const evidenceDigest = fileDigest(evidencePath);
  if (
    evidenceDigest.sha256 !== record.evidenceSha256 ||
    evidenceDigest.bytes !== record.evidenceBytes
  ) {
    throw new Error(`command ${record.id} audit log hash or length does not match its record`);
  }

  const actualArtifacts = new Map<string, CommandArtifactEvidence>();
  for (const artifact of record.artifacts) {
    if (
      !artifact ||
      typeof artifact.path !== "string" ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.generatedDuringCommand !== true
    ) {
      throw new Error(`command ${record.id} contains malformed artifact integrity evidence`);
    }
    assertRelativePath(artifact.path, `command ${record.id} artifact`);
    if (actualArtifacts.has(artifact.path)) {
      throw new Error(`command ${record.id} repeats artifact ${artifact.path}`);
    }
    actualArtifacts.set(artifact.path, artifact);
  }
  const expectedArtifacts = new Set(contract.artifacts);
  if (
    actualArtifacts.size !== expectedArtifacts.size ||
    [...actualArtifacts.keys()].some((path) => !expectedArtifacts.has(path))
  ) {
    throw new Error(`command ${record.id} declared artifacts do not match its reviewed contract`);
  }
  for (const path of expectedArtifacts) {
    const artifact = actualArtifacts.get(path)!;
    const absolutePath = assertPath(root, path, `command ${record.id} artifact`);
    const stats = lstatSync(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`command ${record.id} artifact is not a regular file: ${path}`);
    }
    const digest = fileDigest(absolutePath);
    if (digest.sha256 !== artifact.sha256 || digest.bytes !== artifact.bytes) {
      throw new Error(
        `command ${record.id} artifact hash or length changed after execution: ${path}`,
      );
    }
  }
}

function reviewedCommand(
  commandId: string,
  commands: ReadonlyMap<string, CommandEvidenceRecord>,
  contracts: Readonly<Record<string, RequirementCommandContract>>,
  root: string,
): CommandEvidenceRecord {
  const record = commands.get(commandId);
  if (!record) throw new Error(`requirement proof references unknown command ${commandId}`);
  const contract = contracts[commandId];
  if (!contract) throw new Error(`requirement proof references unreviewed command ${commandId}`);
  assertIntegrityRecord(record, contract, root);
  return record;
}

function passedCommand(
  commandId: string,
  commands: ReadonlyMap<string, CommandEvidenceRecord>,
  contracts: Readonly<Record<string, RequirementCommandContract>>,
  root: string,
): CommandEvidenceRecord {
  const record = reviewedCommand(commandId, commands, contracts, root);
  if (record.status !== "PASSED" || record.exitCode !== 0 || record.skipped) {
    throw new Error(`requirement proof references non-passing command ${commandId}`);
  }
  return record;
}

function jsonValueAtPath(value: unknown, path: string): unknown {
  if (!path.trim()) throw new Error("artifact jsonPath must not be empty");
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      throw new Error(`artifact JSON path is absent: ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function commandCoversTest(command: string, testPath: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  const workspaceSuite = new Set([
    "tests/workspace-boundaries.test.ts",
    "tests/command-surfaces-parity.test.ts",
    "tests/workspace-pack.test.ts",
  ]);
  return (
    normalized.includes(testPath) ||
    /(?:^|\s)pnpm\s+(?:run\s+)?test(?:\s|$)/u.test(normalized) ||
    (/(?:^|\s)pnpm\s+(?:run\s+)?test:workspace(?:\s|$)/u.test(normalized) &&
      workspaceSuite.has(testPath)) ||
    (/vitest\s+run(?:\s|$)/u.test(normalized) && !normalized.includes("tests/"))
  );
}

function assertArtifactDeclared(
  command: CommandEvidenceRecord,
  path: string,
  proofId: string,
): void {
  if (!command.artifacts?.some((artifact) => artifact.path === path)) {
    throw new Error(
      `${proofId} artifact ${path} was not declared and hashed by command ${command.id}`,
    );
  }
}

interface QualityGap {
  why: string;
  missing: string;
  exact_command: string;
  expected_evidence: string;
}

interface QualityResultEvidence {
  id: string;
  status: "PASS" | "FAIL" | "SKIP" | "NOT_APPLICABLE";
  gap: QualityGap | null;
}

interface QualityReportEvidence {
  profile: string;
  generated_at: string;
  results: QualityResultEvidence[];
  summary: Record<QualityResultEvidence["status"], number>;
  passed: boolean;
  executed_checks_passed: boolean;
  status: string;
}

function validateExpectedIncompleteQualityProfile(options: {
  proof: RequirementProof;
  verification: Extract<RequirementVerification, { kind: "expected_incomplete_quality_profile" }>;
  command: CommandEvidenceRecord;
  root: string;
}): void {
  const { proof, verification, command, root } = options;
  if (
    proof.id !== "QUAL-013" ||
    verification.commandId !== "final-verify-release" ||
    verification.path !== QUAL_013_RELEASE_REPORT ||
    verification.profile !== "release" ||
    verification.expectedStatus !== "INCOMPLETE" ||
    command.command !== QUAL_013_RELEASE_COMMAND
  ) {
    throw new Error(
      `${proof.id} expected-incomplete quality proof is restricted to the canonical QUAL-013 release command and report`,
    );
  }
  if (proof.status !== "EXTERNAL_BLOCKER" || proof.evidenceCeiling !== "EXTERNAL_BLOCKER") {
    throw new Error(
      `${proof.id} expected-incomplete release proof requires EXTERNAL_BLOCKER status and ceiling`,
    );
  }
  if (command.status !== "FAILED" || command.exitCode !== 1 || command.skipped) {
    throw new Error(
      `${proof.id} expected-incomplete release proof requires FAILED exit 1 without a skipped command`,
    );
  }
  if (!proof.evidence.includes(verification.path)) {
    throw new Error(`${proof.id} quality report is absent from its implementation evidence`);
  }
  assertArtifactDeclared(command, verification.path, proof.id);
  const reportPath = assertPath(root, verification.path, `${proof.id} quality report`);
  if (!lstatSync(reportPath).isFile()) {
    throw new Error(`${proof.id} quality report is not a regular file: ${verification.path}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as QualityReportEvidence;
  if (
    report.profile !== verification.profile ||
    report.status !== verification.expectedStatus ||
    report.passed !== false ||
    report.executed_checks_passed !== true ||
    !Array.isArray(report.results) ||
    !report.summary ||
    typeof report.summary !== "object"
  ) {
    throw new Error(`${proof.id} quality report is not a truthful release INCOMPLETE result`);
  }
  const generatedAt = Date.parse(report.generated_at);
  const startedAt = Date.parse(command.startedAt!);
  const endedAt = Date.parse(command.endedAt!);
  if (!Number.isFinite(generatedAt) || generatedAt < startedAt || generatedAt > endedAt) {
    throw new Error(`${proof.id} quality report was not generated during its recorded command`);
  }
  if (
    !Array.isArray(verification.allowedSkipIds) ||
    verification.allowedSkipIds.length === 0 ||
    new Set(verification.allowedSkipIds).size !== verification.allowedSkipIds.length ||
    verification.allowedSkipIds.some((id) => !id.trim())
  ) {
    throw new Error(`${proof.id} must name a non-empty unique allowlist of release SKIPs`);
  }
  if (
    [...verification.allowedSkipIds].sort().join("\n") !==
    [...QUAL_013_ALLOWED_RELEASE_SKIPS].sort().join("\n")
  ) {
    throw new Error(`${proof.id} release SKIP allowlist differs from the reviewed external gaps`);
  }
  const resultIds = new Set<string>();
  const counts: Record<QualityResultEvidence["status"], number> = {
    PASS: 0,
    FAIL: 0,
    SKIP: 0,
    NOT_APPLICABLE: 0,
  };
  const skippedIds: string[] = [];
  for (const result of report.results) {
    if (
      !result ||
      typeof result.id !== "string" ||
      !result.id.trim() ||
      !["PASS", "FAIL", "SKIP", "NOT_APPLICABLE"].includes(result.status)
    ) {
      throw new Error(`${proof.id} quality report contains a malformed result`);
    }
    if (resultIds.has(result.id)) {
      throw new Error(`${proof.id} quality report repeats check ${result.id}`);
    }
    resultIds.add(result.id);
    counts[result.status]++;
    if (result.status === "FAIL") {
      throw new Error(`${proof.id} quality report contains failed check ${result.id}`);
    }
    if (result.status !== "SKIP") continue;
    skippedIds.push(result.id);
    const gap = result.gap;
    if (
      !gap ||
      typeof gap.why !== "string" ||
      !gap.why.trim() ||
      typeof gap.missing !== "string" ||
      !gap.missing.trim() ||
      typeof gap.exact_command !== "string" ||
      !gap.exact_command.trim() ||
      typeof gap.expected_evidence !== "string" ||
      !gap.expected_evidence.trim()
    ) {
      throw new Error(`${proof.id} skipped check ${result.id} lacks the four required gap fields`);
    }
  }
  for (const status of ["PASS", "FAIL", "SKIP", "NOT_APPLICABLE"] as const) {
    if (
      !Number.isSafeInteger(report.summary[status]) ||
      report.summary[status] !== counts[status]
    ) {
      throw new Error(`${proof.id} quality report summary does not match its ${status} results`);
    }
  }
  if (counts.FAIL !== 0 || counts.SKIP === 0) {
    throw new Error(`${proof.id} quality report must be incomplete only because named checks SKIP`);
  }
  if ([...skippedIds].sort().join("\n") !== [...verification.allowedSkipIds].sort().join("\n")) {
    throw new Error(`${proof.id} quality report SKIPs do not exactly match its reviewed allowlist`);
  }
}

function validateVerification(
  proof: RequirementProof,
  verification: RequirementVerification,
  commands: ReadonlyMap<string, CommandEvidenceRecord>,
  contracts: Readonly<Record<string, RequirementCommandContract>>,
  root: string,
): void {
  if (verification.kind === "expected_incomplete_quality_profile") {
    const command = reviewedCommand(verification.commandId, commands, contracts, root);
    validateExpectedIncompleteQualityProfile({ proof, verification, command, root });
    return;
  }
  const command = passedCommand(verification.commandId, commands, contracts, root);
  if (verification.kind === "command") return;
  if (!proof.evidence.includes(verification.path)) {
    throw new Error(`${proof.id} verification path is absent from its implementation evidence`);
  }
  if (verification.kind === "test") {
    const absolutePath = assertPath(root, verification.path, `${proof.id} test`);
    if (!lstatSync(absolutePath).isFile() || !/\.test\.[cm]?[jt]sx?$/u.test(verification.path)) {
      throw new Error(`${proof.id} test proof is not a test file: ${verification.path}`);
    }
    if (!commandCoversTest(command.command, verification.path)) {
      throw new Error(
        `${proof.id} command ${verification.commandId} does not cover ${verification.path}`,
      );
    }
    return;
  }
  const artifactPath = assertPath(root, verification.path, `${proof.id} artifact`);
  if (!lstatSync(artifactPath).isFile()) {
    throw new Error(`${proof.id} artifact proof is not a file: ${verification.path}`);
  }
  assertArtifactDeclared(command, verification.path, proof.id);
  const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;
  const actual = jsonValueAtPath(parsed, verification.jsonPath);
  if (actual !== verification.expected) {
    throw new Error(
      `${proof.id} artifact assertion failed at ${verification.jsonPath}: expected ${JSON.stringify(verification.expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function validateLiveHandoff(proof: RequirementProof): void {
  const live = proof.liveVerification;
  if (
    !live ||
    live.attempted !== false ||
    !live.reason.trim() ||
    !live.command.trim() ||
    !live.evidenceRequired.trim()
  ) {
    throw new Error(`${proof.id} lacks an explicit live-verification handoff`);
  }
  if (!proof.verification.some(({ kind }) => kind === "test")) {
    throw new Error(`${proof.id} live-pending implementation lacks a deterministic test proof`);
  }
  const authOrStatusRequirement = /(?:auth|status)/iu.test(proof.requirement);
  const genericDoctorOnly = /^(?:pnpm\s+)?vh\s+doctor(?:\s+--json)?$/u.test(live.command.trim());
  if (genericDoctorOnly && !authOrStatusRequirement) {
    throw new Error(`${proof.id} uses a generic doctor-only live handoff`);
  }
  const effectAndReadBack =
    /(?:\bapply\b|\blaunch\b)/u.test(live.command) &&
    /(?:\bverify\b|\bstatus\b|\bread-back\b)/u.test(live.command);
  const authInspection =
    authOrStatusRequirement &&
    /\bauth\s+test\b/u.test(live.command) &&
    /\bdoctor\b/u.test(live.command);
  const hostedCiReadBack =
    /(?:CodeQL|dependency review|Dependabot)/iu.test(proof.requirement) &&
    /\bgh\s+(?:run\s+list|pr\s+checks)\b/u.test(live.command);
  if (!effectAndReadBack && !authInspection && !hostedCiReadBack) {
    throw new Error(`${proof.id} live handoff has no executable effect/read-back path`);
  }
  const gatewayLifecycle = /\bvh\s+(?:provider|stack)\s+(?:doctor|apply|read-back)\b/u.test(
    live.command,
  );
  if (gatewayLifecycle) {
    const lifecycleInvocations = [
      ...live.command.matchAll(
        /\bvh\s+(provider|stack)\s+(doctor|apply|read-back)\b([^&;]*?)(?=\s*(?:&&|;|$))/gu,
      ),
    ];
    const actions = new Set(lifecycleInvocations.map((match) => match[2]));
    if (!actions.has("apply") || !actions.has("read-back")) {
      throw new Error(`${proof.id} gateway handoff lacks canonical apply/read-back commands`);
    }
    for (const match of lifecycleInvocations) {
      const surface = match[1]!;
      const action = match[2]!;
      const argumentsText = match[3]!;
      for (const flag of ["--input", "--context", "--idempotency-key"] as const) {
        if (!new RegExp(`(?:^|\\s)${flag}(?:\\s|$)`, "u").test(argumentsText)) {
          throw new Error(`${proof.id} ${surface} ${action} handoff omits ${flag}`);
        }
      }
      if (
        !/(?:\$VH_[A-Z0-9]+(?:_[A-Z0-9]+){2,}_(?:SELECTION|OPERATION)_JSON|"?\{[^\n]*"?(?:providerId|feature))/u.test(
          argumentsText,
        )
      ) {
        throw new Error(`${proof.id} ${surface} ${action} handoff is not capability-specific`);
      }
    }
  }
  const requiredEvidenceTerms = [
    [
      "object identifier",
      /\b(?:object|resource|run|workflow|repository|deployment|account|project|job)\s+(?:id|identifier)\b/iu,
    ],
    ["state", /\bstate\b/iu],
    ["ownership", /\bownership\b/iu],
    ["read-back", /\bread-back\b/iu],
  ] as const;
  for (const [label, pattern] of requiredEvidenceTerms) {
    if (!pattern.test(live.evidenceRequired)) {
      throw new Error(`${proof.id} live evidence handoff does not name ${label}`);
    }
  }
}

export function validateAndApplyRequirementProofs(options: {
  root: string;
  baselines: readonly RequirementBaseline[];
  catalog: RequirementProofCatalog;
  commands: readonly CommandEvidenceRecord[];
  expectedBranch?: string;
  requireComplete?: boolean;
}): RequirementBaseline[] {
  const { root, baselines, catalog, commands, expectedBranch, requireComplete = true } = options;
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.proofs)) {
    throw new Error("requirement proof catalog is malformed");
  }
  if (catalog.schemaVersion !== 2) throw new Error("unsupported requirement proof schema");
  if (catalog.evidenceCeiling !== "LOCAL_RUNTIME_AND_SYNTHETIC_FIXTURES") {
    throw new Error("requirement proof catalog overstates its evidence ceiling");
  }
  if (
    !catalog.commandContracts ||
    typeof catalog.commandContracts !== "object" ||
    Array.isArray(catalog.commandContracts)
  ) {
    throw new Error("requirement proof catalog lacks reviewed command contracts");
  }
  for (const [commandId, contract] of Object.entries(catalog.commandContracts)) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/u.test(commandId) ||
      !contract ||
      typeof contract.command !== "string" ||
      !contract.command.trim() ||
      typeof contract.cwd !== "string" ||
      !contract.cwd.trim() ||
      !Array.isArray(contract.artifacts) ||
      contract.artifacts.some((artifact) => typeof artifact !== "string")
    ) {
      throw new Error(`requirement proof catalog contains malformed command contract ${commandId}`);
    }
    if (new Set(contract.artifacts).size !== contract.artifacts.length) {
      throw new Error(`command contract ${commandId} repeats a declared artifact`);
    }
    canonicalRepositoryRelativeCwd(contract.cwd, `command contract ${commandId} cwd`);
    for (const artifact of contract.artifacts) {
      assertRelativePath(artifact, `command contract ${commandId} artifact`);
    }
  }
  if (
    !catalog.branch.trim() ||
    (expectedBranch !== undefined && catalog.branch !== expectedBranch)
  ) {
    throw new Error(
      `requirement proof catalog branch mismatch: expected ${expectedBranch ?? "a non-empty branch"}, received ${catalog.branch}`,
    );
  }
  const duplicateBaselineIds = baselines
    .map(({ id }) => id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateBaselineIds.length > 0) {
    throw new Error(
      `duplicate requirement baselines: ${[...new Set(duplicateBaselineIds)].join(", ")}`,
    );
  }
  const baselineIds = new Set(baselines.map(({ id }) => id));
  const proofs = new Map<string, RequirementProof>();
  for (const proof of catalog.proofs) {
    if (
      !proof ||
      typeof proof.id !== "string" ||
      typeof proof.requirement !== "string" ||
      typeof proof.result !== "string" ||
      !Array.isArray(proof.evidence) ||
      !Array.isArray(proof.verification)
    ) {
      throw new Error("requirement proof catalog contains a malformed proof");
    }
    if (proofs.has(proof.id)) throw new Error(`duplicate requirement proof ${proof.id}`);
    if (!baselineIds.has(proof.id)) throw new Error(`unknown requirement proof ${proof.id}`);
    proofs.set(proof.id, proof);
  }
  const latest = latestCommands(commands);
  const result = baselines.map((baseline) => {
    const proof = proofs.get(baseline.id);
    if (!proof) return { ...baseline, evidence: [...baseline.evidence] };
    if (proof.priority !== baseline.priority || proof.requirement !== baseline.requirement) {
      throw new Error(`${proof.id} proof is bound to a different requirement or priority`);
    }
    if (!ALL_REQUIREMENT_PROOF_STATUSES.includes(proof.status)) {
      throw new Error(`${proof.id} uses an unknown proof status`);
    }
    if (statusCeiling[proof.status] !== proof.evidenceCeiling) {
      throw new Error(`${proof.id} status does not match its evidence ceiling`);
    }
    if (
      proof.reviewedBy !== "codex-independent-audit" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(proof.reviewedAt)
    ) {
      throw new Error(`${proof.id} is missing an independent dated review`);
    }
    if (!proof.result.trim()) throw new Error(`${proof.id} is missing its audited result`);
    if (proof.evidence.length === 0) throw new Error(`${proof.id} has no implementation evidence`);
    if (new Set(proof.evidence).size !== proof.evidence.length) {
      throw new Error(`${proof.id} repeats an implementation evidence path`);
    }
    for (const evidence of proof.evidence) assertPath(root, evidence, `${proof.id} evidence`);
    if (proof.verification.length === 0) throw new Error(`${proof.id} has no verification proof`);
    const verificationKeys = proof.verification.map((verification) => {
      if (verification.kind === "command") return `command:${verification.commandId}`;
      return `${verification.kind}:${verification.path}:${verification.commandId}`;
    });
    if (new Set(verificationKeys).size !== verificationKeys.length) {
      throw new Error(`${proof.id} repeats a verification proof`);
    }
    for (const verification of proof.verification) {
      validateVerification(proof, verification, latest, catalog.commandContracts, root);
    }
    if (
      proof.status === "VERIFIED_FIXTURE" &&
      !proof.verification.some(
        (verification) =>
          verification.kind === "artifact" || /(?:fixture|synthetic)/u.test(verification.commandId),
      )
    ) {
      throw new Error(`${proof.id} synthetic-fixture ceiling lacks fixture-specific verification`);
    }
    if (proof.status === "IMPLEMENTED_LIVE_VERIFICATION_PENDING") {
      validateLiveHandoff(proof);
    } else if (proof.liveVerification) {
      throw new Error(`${proof.id} may not attach a live-verification handoff to ${proof.status}`);
    }
    if (NONTERMINAL_REQUIREMENT_STATUSES.includes(proof.status as NonterminalRequirementStatus)) {
      const gap = proof.blockingGap;
      if (
        !gap ||
        !gap.reason.trim() ||
        !gap.missingExecutablePath.trim() ||
        !gap.nextAction.trim()
      ) {
        throw new Error(`${proof.id} non-terminal proof lacks an explicit blocking gap`);
      }
    } else if (proof.blockingGap) {
      throw new Error(
        `${proof.id} may not attach a blocking gap to terminal status ${proof.status}`,
      );
    }
    return {
      ...baseline,
      status: proof.status,
      evidence: [...proof.evidence],
      gap: proof.result,
    };
  });
  if (requireComplete) {
    const missing = result.filter(({ id }) => !proofs.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Requirements lack validated proofs: ${missing.map(({ id }) => id).join(", ")}`,
      );
    }
  }
  if (requireComplete) {
    const referencedCommandIds = new Set(
      catalog.proofs.flatMap((proof) =>
        proof.verification.map((verification) => verification.commandId),
      ),
    );
    const unusedCommandContracts = Object.keys(catalog.commandContracts).filter(
      (commandId) => !referencedCommandIds.has(commandId),
    );
    if (unusedCommandContracts.length > 0) {
      throw new Error(
        `requirement proof catalog has unused command contracts: ${unusedCommandContracts.join(", ")}`,
      );
    }
  }
  return result;
}
