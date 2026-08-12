import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build as bundle } from "esbuild";

const IMMUTABLE_GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const VH_BUILD_PROVENANCE_PATH = "bin/vh-build-provenance.json";

const ALLOWED_POST_SOURCE_EXACT_PATHS = new Set([
  VH_BUILD_PROVENANCE_PATH,
  "bin/vh.mjs",
  "docs/audits/VH_V02_CODEX_VERIFICATION.md",
  "docs/plans/active/VH_V02_CODEX_COMPLETION_MATRIX.md",
  "docs/plans/active/VH_V02_WINNER_LOOP_COMPLETION_MATRIX.md",
  "harness.lock",
  "reports/audit/commands-run.json",
  "reports/audit/founder-alpha-evidence.json",
  "reports/audit/github-readback.json",
  "reports/audit/quality-live.json",
  "reports/audit/quality-release.json",
  "reports/audit/seed-closure.json",
  "reports/audit/vh-v0.2-codex-requirement-matrix.json",
  "reports/audit/winner-loop-creative-trace.json",
]);
const SOURCE_SCOPED_AUDIT_LOG = /^[a-z0-9][a-z0-9._-]*\.attempt-[1-9][0-9]*\.log$/u;

function commandOutput(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot verify Venture Harness Core Git provenance: ${detail}`);
  }
}

function resolveGitCommit(root, sourceCommit) {
  if (!IMMUTABLE_GIT_SHA.test(sourceCommit ?? "")) {
    throw new Error(
      "The reviewed Venture Harness Core source commit must be an explicit lowercase 40-character SHA",
    );
  }
  const resolvedCommit = commandOutput(root, ["rev-parse", "--verify", `${sourceCommit}^{commit}`]);
  if (resolvedCommit !== sourceCommit) {
    throw new Error(
      `The reviewed Venture Harness Core source commit did not resolve exactly to ${sourceCommit}`,
    );
  }
  return resolvedCommit;
}

function nulSeparatedGitPaths(root, args) {
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean);
}

export function isAllowedPostSourceArtifact(path, sourceCommits = []) {
  if (ALLOWED_POST_SOURCE_EXACT_PATHS.has(path)) return true;
  if (/^(?:apps|packages)\/[^/]+\/dist\//u.test(path)) return true;
  return sourceCommits.some((commit) => {
    const prefix = `reports/audit/command-logs/${commit}/`;
    return path.startsWith(prefix) && SOURCE_SCOPED_AUDIT_LOG.test(path.slice(prefix.length));
  });
}

/**
 * Prove that the reviewed source commit still describes every executable input.
 * A second artifact-only commit may contain the bundle, lock, and sanitized
 * evidence, but source, config, workflows, dependencies, and public docs must
 * already be present in the reviewed source commit.
 */
export function assertReviewedCoreSourceState({ rootDirectory, sourceCommit }) {
  const root = resolve(rootDirectory);
  const reviewedCommit = resolveGitCommit(root, sourceCommit);
  const currentCommit = commandOutput(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", reviewedCommit, currentCommit], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `The reviewed Core source commit ${reviewedCommit} is not an ancestor of current commit ${currentCommit}. Rebuild only from the reviewed source commit followed by its artifact-only commit`,
    );
  }
  let changedPaths;
  try {
    changedPaths = new Set([
      ...nulSeparatedGitPaths(root, [
        "diff",
        "--name-only",
        "-z",
        reviewedCommit,
        currentCommit,
        "--",
      ]),
      ...nulSeparatedGitPaths(root, ["diff", "--name-only", "-z", "--"]),
      ...nulSeparatedGitPaths(root, ["diff", "--cached", "--name-only", "-z", "--"]),
      ...nulSeparatedGitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot inspect reviewed Venture Harness Core source drift: ${detail}`);
  }
  const unexpectedPaths = [...changedPaths]
    .filter((path) => !isAllowedPostSourceArtifact(path, [reviewedCommit, currentCommit]))
    .sort();
  if (unexpectedPaths.length > 0) {
    throw new Error(
      `The reviewed Core source commit ${reviewedCommit} does not contain the current executable inputs: ${unexpectedPaths.join(
        ", ",
      )}. Commit the source changes, review that commit, then run pnpm workspace:build -- --source-commit <40-character-reviewed-source-commit>`,
    );
  }
  return Object.freeze({
    sourceCommit: reviewedCommit,
    currentCommit,
    artifactOnlyChanges: Object.freeze([...changedPaths].sort()),
  });
}

export function resolveFounderCoreBuildProvenance(rootDirectory, { sourceCommit } = {}) {
  const root = resolve(rootDirectory);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const packageVersion = manifest.version;
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("venture-harness package.json must declare a version before bundling vh");
  }
  const workflowRefSha = resolveGitCommit(root, sourceCommit);
  return Object.freeze({ packageVersion, workflowRefSha });
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createVhBuildProvenance({ executable, packageVersion, sourceCommit }) {
  if (!IMMUTABLE_GIT_SHA.test(sourceCommit ?? "")) {
    throw new Error("Cannot record vh build provenance without an immutable Core source commit");
  }
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("Cannot record vh build provenance without the Core package version");
  }
  return Object.freeze({
    schemaVersion: 1,
    packageName: "venture-harness",
    packageVersion,
    coreSourceCommit: sourceCommit,
    binSha256: sha256File(executable),
  });
}

export function parseVhBuildProvenance(input) {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.packageName !== "venture-harness" ||
    typeof value.packageVersion !== "string" ||
    value.packageVersion.length === 0 ||
    !IMMUTABLE_GIT_SHA.test(value.coreSourceCommit ?? "") ||
    !SHA256.test(value.binSha256 ?? "") ||
    Object.keys(value).sort().join(",") !==
      "binSha256,coreSourceCommit,packageName,packageVersion,schemaVersion"
  ) {
    throw new Error(
      `Invalid ${VH_BUILD_PROVENANCE_PATH}; regenerate it with pnpm workspace:build -- --source-commit <40-character-reviewed-source-commit>`,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    packageName: value.packageName,
    packageVersion: value.packageVersion,
    coreSourceCommit: value.coreSourceCommit,
    binSha256: value.binSha256,
  });
}

export function loadVhBuildProvenance(path) {
  try {
    return parseVhBuildProvenance(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid ")) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read ${VH_BUILD_PROVENANCE_PATH}: ${detail}. Run pnpm workspace:build -- --source-commit <40-character-reviewed-source-commit>`,
    );
  }
}

export function writeVhBuildProvenance(path, provenance) {
  const validated = parseVhBuildProvenance(provenance);
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  const stagingDirectory = mkdtempSync(join(dirname(destination), ".vh-provenance-"));
  try {
    const staged = join(stagingDirectory, "provenance.json");
    writeFileSync(staged, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    renameSync(staged, destination);
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  return validated;
}

export async function buildVhExecutable({ rootDirectory, outfile, sourceCommit }) {
  const root = resolve(rootDirectory);
  const provenance = resolveFounderCoreBuildProvenance(root, { sourceCommit });
  await bundle({
    entryPoints: [resolve(root, "scripts/vh-bundle.ts")],
    outfile: resolve(outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "bundle",
    // yaml publishes a CommonJS runtime entry whose dynamic builtin requires
    // cannot be inlined safely into the ESM CLI. It is installed beside the
    // packed executable as a declared root dependency.
    external: ["yaml"],
    define: {
      __VH_CORE_BUILD_COMMIT__: JSON.stringify(provenance.workflowRefSha),
      __VH_CORE_PACKAGE_VERSION__: JSON.stringify(provenance.packageVersion),
    },
    legalComments: "none",
  });
  return provenance;
}

export async function verifyVhExecutableBuildParity({
  rootDirectory,
  executable = resolve(rootDirectory, "bin/vh.mjs"),
  provenanceFile = resolve(rootDirectory, VH_BUILD_PROVENANCE_PATH),
}) {
  const root = resolve(rootDirectory);
  const recorded = loadVhBuildProvenance(provenanceFile);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (recorded.packageVersion !== manifest.version) {
    throw new Error(
      `${VH_BUILD_PROVENANCE_PATH} records package ${recorded.packageVersion}, but package.json declares ${String(
        manifest.version,
      )}. Rebuild with the reviewed source commit before packing`,
    );
  }
  const sourceState = assertReviewedCoreSourceState({
    rootDirectory: root,
    sourceCommit: recorded.coreSourceCommit,
  });
  const installedHash = sha256File(executable);
  if (installedHash !== recorded.binSha256) {
    throw new Error(
      `bin/vh.mjs hash ${installedHash} does not match ${VH_BUILD_PROVENANCE_PATH} ${recorded.binSha256}. Rebuild from ${recorded.coreSourceCommit} before packing`,
    );
  }

  const stagingDirectory = mkdtempSync(join(tmpdir(), "vh-generated-parity-"));
  try {
    const rebuiltExecutable = join(stagingDirectory, "vh.mjs");
    await buildVhExecutable({
      rootDirectory: root,
      outfile: rebuiltExecutable,
      sourceCommit: recorded.coreSourceCommit,
    });
    const rebuiltHash = sha256File(rebuiltExecutable);
    if (
      rebuiltHash !== recorded.binSha256 ||
      !readFileSync(rebuiltExecutable).equals(readFileSync(executable))
    ) {
      throw new Error(
        `bin/vh.mjs is not a byte-for-byte deterministic rebuild of Core source ${recorded.coreSourceCommit}. Rebuild with pnpm workspace:build -- --source-commit ${recorded.coreSourceCommit}`,
      );
    }
    return Object.freeze({
      status: "passed",
      packageVersion: recorded.packageVersion,
      coreSourceCommit: recorded.coreSourceCommit,
      binSha256: recorded.binSha256,
      currentCommit: sourceState.currentCommit,
      artifactOnlyChanges: sourceState.artifactOnlyChanges,
    });
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
