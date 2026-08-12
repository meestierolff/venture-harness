import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const founderAlphaStatuses = ["VERIFIED", "FAILED", "EXTERNAL_BLOCKER", "NOT_RUN"] as const;

export type FounderAlphaStatus = (typeof founderAlphaStatuses)[number];

type Priority = "P0" | "P1" | "P2";

interface Blocker {
  code: string;
  reason: string;
  exactAction: string;
  expectedEvidence: string;
  impact: string;
  resumeCommand: string;
}

type Verification =
  | { kind: "commands"; commandIds: string[] }
  | { kind: "external_blocker"; commandIds: string[]; blocker: Blocker }
  | { kind: "pending_external"; commandIds: string[]; expectedEvidence: string }
  | {
      kind: "github_readback";
      commandIds: [string];
      command: string;
      artifact: string;
      proof: "repositoryMetadata" | "mainRuleset" | "pullRequest" | "repositorySecurity";
    }
  | { kind: "live_profile"; commandIds: [string]; artifact: string }
  | { kind: "aggregate"; dependsOn: string[] };

export interface FounderAlphaRequirement {
  id: string;
  section: string;
  priority: Priority;
  title: string;
  implementable: boolean;
  evidence: string[];
  verification: Verification;
}

export interface FounderAlphaCatalog {
  schemaVersion: 1;
  scope: string;
  statusVocabulary: FounderAlphaStatus[];
  commandContracts: Record<string, { command: string; cwd: string }>;
  requirements: FounderAlphaRequirement[];
}

interface CommandArtifact {
  path: string;
  sha256: string;
  bytes: number;
  generatedDuringCommand: boolean;
}

interface CommandRecord {
  id: string;
  attempt: number;
  command?: string;
  cwd?: string;
  status: "PASSED" | "FAILED";
  exitCode: number;
  evidencePath: string;
  evidenceSha256: string;
  evidenceBytes: number;
  integrityVersion: number;
  outputTruncated?: boolean;
  artifacts?: CommandArtifact[];
}

export interface FounderAlphaLedger {
  schemaVersion: number;
  branch: string;
  sourceSha: string;
  sourceTree: string;
  sourceClean: boolean;
  records: CommandRecord[];
}

export interface FounderAlphaResult {
  id: string;
  section: string;
  priority: Priority;
  title: string;
  implementable: boolean;
  status: FounderAlphaStatus;
  evidence: string[];
  commandIds: string[];
  detail: string;
  blocker?: Blocker;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRepositoryPath(path: string, label: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    path.startsWith(".git/")
  ) {
    throw new Error(`${label} must be a safe repository-relative path: ${path}`);
  }
}

function readRegularFile(root: string, path: string, label: string): Buffer {
  safeRepositoryPath(path, label);
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`${label} is absent or not a regular file: ${path}`);
  }
  return readFileSync(absolute);
}

function validateCommandIntegrity(root: string, record: CommandRecord): void {
  if (
    record.integrityVersion !== 1 ||
    !Number.isSafeInteger(record.evidenceBytes) ||
    record.evidenceBytes < 0 ||
    !/^[a-f0-9]{64}$/u.test(record.evidenceSha256)
  ) {
    throw new Error(`command ${record.id} lacks integrity metadata`);
  }
  if (record.outputTruncated === true) {
    throw new Error(`command ${record.id} audit log is truncated and cannot prove completion`);
  }
  const log = readRegularFile(root, record.evidencePath, `command ${record.id} log`);
  if (log.byteLength !== record.evidenceBytes || digest(log) !== record.evidenceSha256) {
    throw new Error(`command ${record.id} log does not match its integrity metadata`);
  }
}

function latestCommands(ledger: FounderAlphaLedger): Map<string, CommandRecord> {
  const latest = new Map<string, CommandRecord>();
  for (const record of ledger.records) {
    const current = latest.get(record.id);
    if (!current || record.attempt > current.attempt) latest.set(record.id, record);
  }
  return latest;
}

function validateCatalog(catalog: FounderAlphaCatalog, root: string): void {
  if (
    catalog.schemaVersion !== 1 ||
    catalog.scope !== "Founder-alpha completion assignment sections 5-34" ||
    JSON.stringify(catalog.statusVocabulary) !== JSON.stringify(founderAlphaStatuses)
  ) {
    throw new Error("founder-alpha requirement catalog header is invalid");
  }
  const ids = new Set<string>();
  const sections = new Set<number>();
  const referencedCommandIds = new Set<string>();
  if (!catalog.commandContracts || typeof catalog.commandContracts !== "object") {
    throw new Error("founder-alpha command contracts are required");
  }
  for (const [id, contract] of Object.entries(catalog.commandContracts)) {
    if (
      !/^[a-z0-9._-]+$/u.test(id) ||
      typeof contract?.command !== "string" ||
      contract.command.length === 0 ||
      contract.cwd !== "."
    ) {
      throw new Error(`founder-alpha command contract is invalid: ${id}`);
    }
  }
  for (const requirement of catalog.requirements) {
    if (!/^FA-[0-9]{2}(?:-[A-Z]+)?$/u.test(requirement.id) || ids.has(requirement.id)) {
      throw new Error(`founder-alpha requirement id is invalid or duplicated: ${requirement.id}`);
    }
    ids.add(requirement.id);
    const section = Number(requirement.section);
    if (!Number.isInteger(section) || section < 5 || section > 34) {
      throw new Error(`founder-alpha requirement section is outside 5-34: ${requirement.id}`);
    }
    sections.add(section);
    if (!(["P0", "P1", "P2"] as const).includes(requirement.priority)) {
      throw new Error(`founder-alpha requirement priority is invalid: ${requirement.id}`);
    }
    if (requirement.evidence.length === 0) {
      throw new Error(
        `founder-alpha requirement has no reviewed implementation evidence: ${requirement.id}`,
      );
    }
    for (const path of requirement.evidence) {
      readRegularFile(root, path, `reviewed evidence for ${requirement.id}`);
    }
    if (requirement.verification.kind === "github_readback") {
      if (
        requirement.verification.commandIds.length !== 1 ||
        requirement.verification.commandIds[0] !== "final-github-readback" ||
        requirement.verification.command !==
          "node scripts/verify-final-github-readback.mjs --output reports/audit/github-readback.json" ||
        requirement.verification.artifact !== "reports/audit/github-readback.json" ||
        !["repositoryMetadata", "mainRuleset", "pullRequest", "repositorySecurity"].includes(
          requirement.verification.proof,
        )
      ) {
        throw new Error(`${requirement.id} has a malformed GitHub read-back contract`);
      }
    }
    if ("commandIds" in requirement.verification) {
      for (const commandId of requirement.verification.commandIds) {
        referencedCommandIds.add(commandId);
      }
    }
  }
  const contractIds = Object.keys(catalog.commandContracts).sort();
  if (JSON.stringify(contractIds) !== JSON.stringify([...referencedCommandIds].sort())) {
    throw new Error("founder-alpha command contracts must exactly cover referenced command IDs");
  }
  for (const requirement of catalog.requirements) {
    if (requirement.verification.kind !== "github_readback") continue;
    const contract = catalog.commandContracts[requirement.verification.commandIds[0]];
    if (contract?.command !== requirement.verification.command || contract.cwd !== ".") {
      throw new Error(`${requirement.id} GitHub read-back command differs from its contract`);
    }
  }
  const expectedSections = Array.from({ length: 30 }, (_, index) => index + 5);
  if (JSON.stringify([...sections].sort((a, b) => a - b)) !== JSON.stringify(expectedSections)) {
    throw new Error("founder-alpha catalog must cover every assignment section from 5 through 34");
  }
  for (const requirement of catalog.requirements) {
    if (requirement.verification.kind !== "aggregate") continue;
    for (const dependency of requirement.verification.dependsOn) {
      if (!ids.has(dependency) || dependency === requirement.id) {
        throw new Error(`aggregate ${requirement.id} has an invalid dependency: ${dependency}`);
      }
    }
  }
}

function commandState(
  root: string,
  latest: Map<string, CommandRecord>,
  commandIds: readonly string[],
  commandContracts: FounderAlphaCatalog["commandContracts"],
): { status: "PASSED" | "FAILED" | "NOT_RUN"; detail: string } {
  const records = commandIds.map((id) => latest.get(id));
  const absent = commandIds.filter((_, index) => !records[index]);
  if (absent.length > 0) {
    return { status: "NOT_RUN", detail: `Audited commands not run: ${absent.join(", ")}.` };
  }
  for (const record of records as CommandRecord[]) {
    validateCommandIntegrity(root, record);
    const contract = commandContracts[record.id];
    if (!contract || record.command !== contract.command || record.cwd !== contract.cwd) {
      return {
        status: "FAILED",
        detail: `Audited command does not match its reviewed command/cwd contract: ${record.id}.`,
      };
    }
  }
  const failed = (records as CommandRecord[]).filter(
    ({ status, exitCode }) => status !== "PASSED" || exitCode !== 0,
  );
  if (failed.length > 0) {
    return {
      status: "FAILED",
      detail: `Latest audited command attempts failed: ${failed.map(({ id }) => id).join(", ")}.`,
    };
  }
  return { status: "PASSED", detail: `Audited commands passed: ${commandIds.join(", ")}.` };
}

function aggregateStatus(dependencies: FounderAlphaResult[]): FounderAlphaStatus {
  if (dependencies.some(({ status }) => status === "FAILED")) return "FAILED";
  if (dependencies.some(({ status }) => status === "NOT_RUN")) return "NOT_RUN";
  if (dependencies.some(({ status }) => status === "EXTERNAL_BLOCKER")) {
    return "EXTERNAL_BLOCKER";
  }
  return "VERIFIED";
}

function liveProfileResult(
  root: string,
  latest: Map<string, CommandRecord>,
  commandContracts: FounderAlphaCatalog["commandContracts"],
  requirement: FounderAlphaRequirement & {
    verification: Extract<Verification, { kind: "live_profile" }>;
  },
): Pick<FounderAlphaResult, "status" | "detail"> {
  const commandId = requirement.verification.commandIds[0];
  const record = latest.get(commandId);
  if (!record) return { status: "NOT_RUN", detail: `Audited command not run: ${commandId}.` };
  validateCommandIntegrity(root, record);
  const contract = commandContracts[commandId];
  if (!contract || record.command !== contract.command || record.cwd !== contract.cwd) {
    return {
      status: "FAILED",
      detail: `Audited command does not match its reviewed command/cwd contract: ${commandId}.`,
    };
  }
  const artifact = record.artifacts?.find(({ path }) => path === requirement.verification.artifact);
  if (!artifact || !artifact.generatedDuringCommand) {
    return { status: "FAILED", detail: `The ${commandId} attempt lacks its declared live report.` };
  }
  const bytes = readRegularFile(root, artifact.path, `${commandId} live report`);
  if (bytes.byteLength !== artifact.bytes || digest(bytes) !== artifact.sha256) {
    throw new Error(`${commandId} live report does not match its integrity metadata`);
  }
  const report = JSON.parse(bytes.toString("utf8")) as {
    status?: unknown;
    results?: Array<{
      status?: unknown;
      gap?: {
        origin?: unknown;
        provider?: unknown;
        missing?: unknown;
        exact_command?: unknown;
        expected_evidence?: unknown;
        account_scope?: unknown;
        impact?: unknown;
        vercel_url_availability?: unknown;
        resume_command?: unknown;
      };
    }>;
  };
  if (record.status === "PASSED" && record.exitCode === 0 && report.status === "PASS") {
    return { status: "VERIFIED", detail: "The authenticated live profile passed." };
  }
  if (record.status === "FAILED" && record.exitCode === 1 && report.status === "INCOMPLETE") {
    const skips = (report.results ?? []).filter(({ status }) => status === "SKIP");
    if (skips.length === 0) {
      return {
        status: "FAILED",
        detail: "The incomplete live profile did not identify a skipped provider prerequisite.",
      };
    }
    const incompleteGap = skips.find(
      ({ gap }) =>
        gap?.origin !== "external" ||
        [
          gap.provider,
          gap?.missing,
          gap?.exact_command,
          gap?.expected_evidence,
          gap?.account_scope,
          gap?.impact,
          gap?.vercel_url_availability,
          gap?.resume_command,
        ].some((value) => typeof value !== "string" || value.trim().length === 0),
    );
    if (incompleteGap) {
      return {
        status: "FAILED",
        detail: "The incomplete live profile omitted required actionable provider-gap evidence.",
      };
    }
    return {
      status: "EXTERNAL_BLOCKER",
      detail: `The live profile executed and reported ${skips.length} explicit provider prerequisite gap(s).`,
    };
  }
  return {
    status: "FAILED",
    detail: `The live profile and audited command disagree (${String(report.status)}/${record.status}/${record.exitCode}).`,
  };
}

function githubReadbackResult(
  root: string,
  ledger: FounderAlphaLedger,
  latest: Map<string, CommandRecord>,
  requirement: FounderAlphaRequirement & {
    verification: Extract<Verification, { kind: "github_readback" }>;
  },
): Pick<FounderAlphaResult, "status" | "detail"> {
  const commandId = requirement.verification.commandIds[0];
  const record = latest.get(commandId);
  if (!record) return { status: "NOT_RUN", detail: `Audited command not run: ${commandId}.` };
  validateCommandIntegrity(root, record);
  if (
    record.command !== requirement.verification.command ||
    record.cwd !== "." ||
    record.status !== "PASSED" ||
    record.exitCode !== 0
  ) {
    return { status: "FAILED", detail: `Latest audited command attempt failed: ${commandId}.` };
  }
  if (
    record.artifacts?.length !== 1 ||
    record.artifacts[0]?.path !== requirement.verification.artifact
  ) {
    return {
      status: "FAILED",
      detail: `The ${commandId} attempt does not match its reviewed artifact contract.`,
    };
  }
  const artifact = record.artifacts?.find(({ path }) => path === requirement.verification.artifact);
  if (!artifact || !artifact.generatedDuringCommand) {
    return {
      status: "FAILED",
      detail: `The ${commandId} attempt lacks its declared GitHub read-back artifact.`,
    };
  }
  const bytes = readRegularFile(root, artifact.path, `${commandId} GitHub read-back`);
  if (bytes.byteLength !== artifact.bytes || digest(bytes) !== artifact.sha256) {
    throw new Error(`${commandId} GitHub read-back does not match its integrity metadata`);
  }
  const report = JSON.parse(bytes.toString("utf8")) as {
    schemaVersion?: unknown;
    status?: unknown;
    source?: { repository?: unknown; branch?: unknown; sha?: unknown; tree?: unknown };
    proofs?: Record<string, unknown>;
  };
  if (
    report.schemaVersion !== 1 ||
    report.status !== "VERIFIED" ||
    report.source?.repository !== "meestierolff/venture-harness" ||
    report.source?.branch !== ledger.branch ||
    report.source?.sha !== ledger.sourceSha ||
    report.source?.tree !== ledger.sourceTree ||
    report.proofs?.[requirement.verification.proof] !== true ||
    report.proofs?.requiredChecks !== true
  ) {
    return {
      status: "FAILED",
      detail: `The ${commandId} artifact is not a verified read-back for this exact source revision and proof.`,
    };
  }
  return {
    status: "VERIFIED",
    detail: `Source-bound GitHub read-back verified ${requirement.verification.proof}.`,
  };
}

export function renderFounderAlphaEvidence(options: {
  root: string;
  catalog: FounderAlphaCatalog;
  ledger: FounderAlphaLedger;
  generatedAt?: string;
  catalogPath?: string;
}): {
  schemaVersion: 1;
  generatedAt: string;
  scope: string;
  branch: string;
  sourceSha: string;
  sourceTree: string;
  sourceClean: true;
  catalog: string;
  catalogSha256: string;
  commandEvidence: string;
  statusVocabulary: readonly FounderAlphaStatus[];
  counts: Record<FounderAlphaStatus, number>;
  allImplementablePrioritiesProven: boolean;
  unprovenImplementableIds: string[];
  reportStatus: "COMPLETE" | "INCOMPLETE";
  classification: "FOUNDER ALPHA READY" | "FOUNDER ALPHA CODE-READY, DOGFOOD BLOCKED" | null;
  requirements: FounderAlphaResult[];
} {
  const { root, catalog, ledger } = options;
  if (ledger.schemaVersion !== 3 || ledger.sourceClean !== true) {
    throw new Error("founder-alpha evidence requires a source-bound schema 3 command ledger");
  }
  validateCatalog(catalog, root);
  const latest = latestCommands(ledger);
  const results: FounderAlphaResult[] = [];
  const byId = new Map<string, FounderAlphaResult>();

  for (const requirement of catalog.requirements) {
    const base = {
      id: requirement.id,
      section: requirement.section,
      priority: requirement.priority,
      title: requirement.title,
      implementable: requirement.implementable,
      evidence: requirement.evidence,
    };
    let result: FounderAlphaResult;
    const verification = requirement.verification;
    if (verification.kind === "aggregate") {
      const dependencies = verification.dependsOn.map((id) => {
        const dependency = byId.get(id);
        if (!dependency)
          throw new Error(`aggregate ${requirement.id} depends on an unevaluated row: ${id}`);
        return dependency;
      });
      const status = aggregateStatus(dependencies);
      result = {
        ...base,
        status,
        commandIds: [],
        detail: `Derived from ${verification.dependsOn.join(", ")}: ${status}.`,
      };
    } else if (verification.kind === "live_profile") {
      result = {
        ...base,
        ...liveProfileResult(root, latest, catalog.commandContracts, {
          ...requirement,
          verification,
        }),
        commandIds: verification.commandIds,
      };
    } else if (verification.kind === "github_readback") {
      result = {
        ...base,
        ...githubReadbackResult(root, ledger, latest, { ...requirement, verification }),
        commandIds: verification.commandIds,
      };
    } else {
      const state = commandState(root, latest, verification.commandIds, catalog.commandContracts);
      if (state.status === "NOT_RUN") {
        result = {
          ...base,
          status: "NOT_RUN",
          commandIds: verification.commandIds,
          detail: state.detail,
        };
      } else if (state.status === "FAILED") {
        result = {
          ...base,
          status: "FAILED",
          commandIds: verification.commandIds,
          detail: state.detail,
        };
      } else if (verification.kind === "external_blocker") {
        result = {
          ...base,
          status: "EXTERNAL_BLOCKER",
          commandIds: verification.commandIds,
          detail: verification.blocker.reason,
          blocker: verification.blocker,
        };
      } else if (verification.kind === "pending_external") {
        result = {
          ...base,
          status: "NOT_RUN",
          commandIds: verification.commandIds,
          detail: `External read-back has not run: ${verification.expectedEvidence}.`,
        };
      } else {
        result = {
          ...base,
          status: "VERIFIED",
          commandIds: verification.commandIds,
          detail: state.detail,
        };
      }
    }
    results.push(result);
    byId.set(result.id, result);
  }

  const counts = Object.fromEntries(
    founderAlphaStatuses.map((status) => [
      status,
      results.filter((row) => row.status === status).length,
    ]),
  ) as Record<FounderAlphaStatus, number>;
  const unprovenImplementableIds = results
    .filter(({ implementable, status }) => implementable && status !== "VERIFIED")
    .map(({ id }) => id);
  const allImplementablePrioritiesProven = unprovenImplementableIds.length === 0;
  const allVerified = results.every(({ status }) => status === "VERIFIED");
  const onlyExternalRemainder = results.every(
    ({ status }) => status === "VERIFIED" || status === "EXTERNAL_BLOCKER",
  );
  const classification = allVerified
    ? "FOUNDER ALPHA READY"
    : allImplementablePrioritiesProven && onlyExternalRemainder
      ? "FOUNDER ALPHA CODE-READY, DOGFOOD BLOCKED"
      : null;
  const catalogPath = options.catalogPath ?? "reports/audit/founder-alpha-requirements.json";
  const catalogBytes = readRegularFile(root, catalogPath, "founder-alpha catalog");

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scope: catalog.scope,
    branch: ledger.branch,
    sourceSha: ledger.sourceSha,
    sourceTree: ledger.sourceTree,
    sourceClean: true,
    catalog: catalogPath,
    catalogSha256: digest(catalogBytes),
    commandEvidence: "reports/audit/commands-run.json",
    statusVocabulary: founderAlphaStatuses,
    counts,
    allImplementablePrioritiesProven,
    unprovenImplementableIds,
    reportStatus: classification === null ? "INCOMPLETE" : "COMPLETE",
    classification,
    requirements: results,
  };
}
