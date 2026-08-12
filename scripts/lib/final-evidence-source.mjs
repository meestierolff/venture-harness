import { spawnSync } from "node:child_process";

export const FINAL_EVIDENCE_LEDGER_PATH = "reports/audit/commands-run.json";
export const FINAL_EVIDENCE_LOG_DIRECTORY = "reports/audit/command-logs/";

export function finalEvidenceLogDirectory(sourceSha) {
  assertSourceValue(sourceSha, "log source SHA", /^[a-f0-9]{40,64}$/u);
  return `${FINAL_EVIDENCE_LOG_DIRECTORY}${sourceSha}/`;
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `final evidence requires a Git checkout (${args.join(" ")} failed): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function assertSourceValue(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`final-evidence ${label} is absent or malformed`);
  }
}

export function readFinalEvidenceSource(root, env = process.env) {
  const repositoryRoot = git(root, ["rev-parse", "--show-toplevel"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const attachedBranch = git(root, ["branch", "--show-current"]);
  const expectedSha = env.VH_EVIDENCE_SOURCE_SHA?.trim() || undefined;
  const expectedBranch = env.VH_EVIDENCE_SOURCE_BRANCH?.trim() || undefined;
  const branch = expectedBranch ?? attachedBranch;

  if (repositoryRoot !== root) {
    throw new Error(`final evidence must run from the repository root: ${repositoryRoot}`);
  }
  assertSourceValue(head, "source SHA", /^[a-f0-9]{40,64}$/u);
  assertSourceValue(tree, "source tree", /^[a-f0-9]{40,64}$/u);
  assertSourceValue(branch, "source branch", /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
  if (branch.includes("..") || branch.endsWith("/") || branch.includes("//")) {
    throw new Error(`final-evidence source branch is malformed: ${branch}`);
  }
  if (expectedSha !== undefined && expectedSha !== head) {
    throw new Error(
      `final-evidence source SHA mismatch: expected ${expectedSha}, received ${head}`,
    );
  }
  if (attachedBranch && expectedBranch !== undefined && attachedBranch !== expectedBranch) {
    throw new Error(
      `final-evidence source branch mismatch: expected ${expectedBranch}, received ${attachedBranch}`,
    );
  }
  return { branch, sourceSha: head, sourceTree: tree };
}

export function changedSourcePaths(root) {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(`unable to inspect final-evidence source drift: ${result.stderr.trim()}`);
  }

  const entries = result.stdout.split("\0");
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4) throw new Error("git returned malformed source-drift evidence");
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/u.test(status)) {
      const originalPath = entries[index + 1];
      if (!originalPath) throw new Error("git returned a malformed rename/copy source path");
      paths.push(originalPath);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function pathIsAllowed(path, allowedPaths) {
  return allowedPaths.some((allowed) =>
    allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
  );
}

export function assertFinalEvidenceSource(options) {
  const { root, expected, allowedPaths = [] } = options;
  const actual = readFinalEvidenceSource(root, {
    ...process.env,
    VH_EVIDENCE_SOURCE_SHA: expected.sourceSha,
    VH_EVIDENCE_SOURCE_BRANCH: expected.branch,
  });
  if (actual.sourceTree !== expected.sourceTree) {
    throw new Error(
      `final-evidence source tree mismatch: expected ${expected.sourceTree}, received ${actual.sourceTree}`,
    );
  }
  const changed = changedSourcePaths(root);
  const unexpected = changed.filter((path) => !pathIsAllowed(path, allowedPaths));
  if (unexpected.length > 0) {
    throw new Error(`final-evidence source drift detected: ${unexpected.join(", ")}`);
  }
  return actual;
}

export function createFinalEvidenceLedger(source, initializedAt = new Date().toISOString()) {
  return {
    schemaVersion: 3,
    branch: source.branch,
    sourceSha: source.sourceSha,
    sourceTree: source.sourceTree,
    sourceClean: true,
    initializedAt,
    records: [],
  };
}

export function validateFinalEvidenceLedger(ledger) {
  if (
    !ledger ||
    ledger.schemaVersion !== 3 ||
    ledger.sourceClean !== true ||
    !Array.isArray(ledger.records)
  ) {
    throw new Error(
      "commands-run ledger must be initialized as source-bound schema 3 before audited commands run",
    );
  }
  assertSourceValue(ledger.branch, "ledger branch", /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
  assertSourceValue(ledger.sourceSha, "ledger source SHA", /^[a-f0-9]{40,64}$/u);
  assertSourceValue(ledger.sourceTree, "ledger source tree", /^[a-f0-9]{40,64}$/u);
  if (
    typeof ledger.initializedAt !== "string" ||
    !Number.isFinite(Date.parse(ledger.initializedAt))
  ) {
    throw new Error("commands-run ledger has an invalid initialization time");
  }
  for (const record of ledger.records) {
    if (
      typeof record?.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(record.id) ||
      !Number.isSafeInteger(record.attempt) ||
      record.attempt < 1
    ) {
      throw new Error("commands-run ledger contains malformed command identity metadata");
    }
    if (
      record.sourceBranch !== ledger.branch ||
      record?.sourceSha !== ledger.sourceSha ||
      record?.sourceTree !== ledger.sourceTree
    ) {
      throw new Error(`command ${record?.id ?? "<unknown>"} is bound to another source revision`);
    }
    const expectedLogPath = `${finalEvidenceLogDirectory(ledger.sourceSha)}${record.id}.attempt-${record.attempt}.log`;
    if (record.evidencePath !== expectedLogPath) {
      throw new Error(
        `command ${record.id} log is not scoped to its immutable source revision: ${expectedLogPath}`,
      );
    }
  }
  return ledger;
}

export function finalEvidenceOutputPaths(ledger, extraPaths = []) {
  const artifactPaths = ledger.records.flatMap((record) =>
    Array.isArray(record.artifacts) ? record.artifacts.map(({ path }) => path) : [],
  );
  return [
    FINAL_EVIDENCE_LEDGER_PATH,
    ...ledger.records.map((record) => record.evidencePath),
    ...artifactPaths,
    ...extraPaths,
  ];
}
