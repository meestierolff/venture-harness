import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { providerCommandEnvironment } from "../credentials";
import { looksLikeCredentialLabeledText } from "../config/contracts";
import { OwnerPathLock, type LockedDirectoryIdentity } from "../security/owner-path-lock";
import { findCredentialMaterial } from "../../packages/core/src/index";
import { scanCredentialText } from "../../scripts/lib/release-security";

const BOOTSTRAP_PATH = ".venture-harness-bootstrap";
const BOOTSTRAP_CONTENT = Buffer.from("venture-harness-source-bootstrap-v1\n", "utf8");
const MAX_SOURCE_ENTRIES = 10_000;
const MAX_SOURCE_BLOB_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_SOURCE_PATH_BYTES = 1_024;
const MAX_SOURCE_PATH_COMPONENT_BYTES = 255;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024;
const COMMIT_MESSAGE = "chore: publish verified venture source";
const COMMIT_IDENTITY = {
  name: "Venture Harness",
  email: "venture-harness@users.noreply.github.com",
  date: "2000-01-01T00:00:00Z",
} as const;

const DIRECT_REQUEST_ENV_ALLOWLIST = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);

export type GitHubRepositoryVisibility = "private" | "public" | "internal";
export type GitTreeEntryMode = "100644" | "100755" | "120000";

export interface DirectCommandRequest {
  cwd: string;
  stdin?: Buffer | string;
  env?: Readonly<Record<string, string>>;
}

export interface DirectCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

export interface DirectCommandRunner {
  run(
    command: string,
    args: readonly string[],
    request: DirectCommandRequest,
  ): Promise<DirectCommandResult>;
}

export class NativeDirectCommandRunner implements DirectCommandRunner {
  async run(
    command: string,
    args: readonly string[],
    request: DirectCommandRequest,
  ): Promise<DirectCommandResult> {
    if (!isDirectBinary(command)) {
      throw new Error(`Refusing non-direct command binary ${JSON.stringify(command)}`);
    }
    const env: NodeJS.ProcessEnv = {
      ...providerCommandEnvironment(process.env),
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    };
    const executable = command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
    for (const [name, value] of Object.entries(request.env ?? {})) {
      if (executable !== "git" || !DIRECT_REQUEST_ENV_ALLOWLIST.has(name)) {
        throw new Error(`Refusing unsupported direct-command environment field ${name}`);
      }
      env[name] = value;
    }
    const result = spawnSync(command, [...args], {
      cwd: request.cwd,
      env,
      input: request.stdin,
      encoding: null,
      shell: false,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    if (result.error) {
      const code = "code" in result.error ? String(result.error.code) : "spawn_error";
      throw new Error(`Direct ${command} invocation failed (${code})`);
    }
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    };
  }
}

export interface LocalSourceBlob {
  path: string;
  mode: GitTreeEntryMode;
  oid: string;
  content: Buffer;
}

export interface LocalSourceSnapshot {
  treeOid: string;
  blobs: readonly LocalSourceBlob[];
}

export interface LocalSourceSnapshotLoader {
  load(rootDir: string): Promise<LocalSourceSnapshot>;
}

export interface GitHubRepositoryState {
  repository: string;
  visibility: GitHubRepositoryVisibility;
  archived: boolean;
  defaultBranch: string | null;
}

export interface GitHubBranchState {
  commitOid: string;
  treeOid: string;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: string;
  oid: string;
}

export interface GitHubSourceGateway {
  inspectRepository(repository: string): Promise<GitHubRepositoryState | null>;
  createRepository(repository: string, visibility: GitHubRepositoryVisibility): Promise<void>;
  bootstrapRepository(repository: string): Promise<void>;
  inspectBranch(repository: string, branch: string): Promise<GitHubBranchState | null>;
  inspectTree(repository: string, treeOid: string): Promise<readonly GitHubTreeEntry[]>;
  createBlob(repository: string, content: Buffer): Promise<string>;
  createTree(
    repository: string,
    entries: readonly Pick<LocalSourceBlob, "path" | "mode" | "oid">[],
  ): Promise<string>;
  createCommit(
    repository: string,
    treeOid: string,
    parentCommitOid: string,
  ): Promise<{ commitOid: string; treeOid: string }>;
  updateBranch(repository: string, branch: string, commitOid: string): Promise<void>;
}

export interface PublishGitHubSourceInput {
  repository: string;
  visibility: GitHubRepositoryVisibility;
  rootDir: string;
}

export interface VerifyGitHubSourceInput {
  repository: string;
  visibility: GitHubRepositoryVisibility;
  branch: string;
  commitOid: string;
  treeOid: string;
}

export interface GitHubSourcePublicationResult extends VerifyGitHubSourceInput {
  verified: true;
  created: boolean;
  source: "local_git_tree";
}

export interface GitHubSourcePublicationDependencies {
  gateway: GitHubSourceGateway;
  snapshots: LocalSourceSnapshotLoader;
}

export interface VerifiedGitHubWorkingRepositoryInput {
  repository: string;
  rootDir: string;
  branch: string;
  commitOid: string;
}

export interface GitHubWorkingRepositoryCloneInput {
  repository: string;
  branch: string;
  destination: string;
}

export interface GitHubWorkingRepositoryCloner {
  clone(input: GitHubWorkingRepositoryCloneInput): Promise<void>;
}

export interface VerifiedGitHubWorkingRepository {
  originUrl: string;
  branch: string;
  head: string;
  clean: true;
}

export interface VerifiedGitHubWorkingRepositoryDependencies {
  runner?: DirectCommandRunner;
  cloner?: GitHubWorkingRepositoryCloner;
  /** Deterministic local race-injection hook used only by security regressions. */
  pathSecurityHook?: (event: string, path: string) => void;
}

function isDirectBinary(binary: string): boolean {
  const trimmed = binary.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  const name = trimmed.split(/[\\/]/).at(-1)?.toLowerCase() ?? trimmed.toLowerCase();
  return !["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"].includes(name);
}

function expectSuccess(result: DirectCommandResult, label: string): Buffer {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.exitCode}; no remote state was inferred`,
    );
  }
  return result.stdout;
}

function isMissingResponse(result: DirectCommandResult): boolean {
  if (result.exitCode === 0) return false;
  return /(?:HTTP\s+404|status(?:\s+code)?\s+404|not found)/i.test(result.stderr);
}

function isEmptyRepositoryResponse(result: DirectCommandResult): boolean {
  if (result.exitCode === 0) return false;
  return /(?:HTTP\s+409|status(?:\s+code)?\s+409|git repository is empty)/i.test(result.stderr);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return one JSON object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} did not return one non-empty string`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} did not return one boolean`);
  return value;
}

function parseJson(stdout: Buffer, label: string): unknown {
  try {
    return JSON.parse(stdout.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function normalizeVisibility(value: unknown): GitHubRepositoryVisibility {
  const normalized = string(value, "GitHub repository visibility").toLowerCase();
  if (normalized !== "private" && normalized !== "public" && normalized !== "internal") {
    throw new Error(
      `GitHub returned unsupported repository visibility ${JSON.stringify(normalized)}`,
    );
  }
  return normalized;
}

function assertRepository(repository: string): void {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository) ||
    repository.endsWith(".git")
  ) {
    throw new Error(`GitHub repository must be an exact owner/name target, received ${repository}`);
  }
}

function assertVisibility(visibility: string): asserts visibility is GitHubRepositoryVisibility {
  if (visibility !== "private" && visibility !== "public" && visibility !== "internal") {
    throw new Error(`Unsupported GitHub repository visibility ${visibility}`);
  }
}

function assertBranch(branch: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(branch) || branch.endsWith(".lock")) {
    throw new Error(`GitHub default branch is not a safe exact ref: ${branch}`);
  }
}

function assertOid(oid: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(`${label} is not an exact SHA-1 object id`);
}

function githubOriginMatchesRepository(origin: string, repository: string): boolean {
  const expected = repository.toLowerCase();
  const normalized = origin
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/iu)?.[1];
  const scp = normalized.match(/^git@github\.com:([^/]+\/[^/]+)$/iu)?.[1];
  const ssh = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/iu)?.[1];
  return [https, scp, ssh].some((candidate) => candidate?.toLowerCase() === expected);
}

async function gitOutput(
  runner: DirectCommandRunner,
  cwd: string,
  args: readonly string[],
  label: string,
): Promise<string> {
  return expectSuccess(await runner.run("git", args, { cwd }), label)
    .toString("utf8")
    .trim();
}

export class GhCliGitHubWorkingRepositoryCloner implements GitHubWorkingRepositoryCloner {
  constructor(private readonly runner: DirectCommandRunner = new NativeDirectCommandRunner()) {}

  async clone(input: GitHubWorkingRepositoryCloneInput): Promise<void> {
    assertRepository(input.repository);
    assertBranch(input.branch);
    expectSuccess(
      await this.runner.run(
        "gh",
        [
          "repo",
          "clone",
          input.repository,
          input.destination,
          "--",
          "--no-checkout",
          "--single-branch",
          "--branch",
          input.branch,
        ],
        { cwd: dirname(input.destination) },
      ),
      `Clone verified GitHub repository metadata for ${input.repository}`,
    );
  }
}

/**
 * Install or verify the ordinary child working repository only after the
 * provider commit has been read back. Existing Git state is never rewritten:
 * any target, branch, HEAD, index, or worktree mismatch fails closed.
 */
export async function ensureVerifiedGitHubWorkingRepository(
  input: VerifiedGitHubWorkingRepositoryInput,
  dependencies: VerifiedGitHubWorkingRepositoryDependencies = {},
): Promise<VerifiedGitHubWorkingRepository> {
  assertRepository(input.repository);
  assertBranch(input.branch);
  assertOid(input.commitOid, "Verified GitHub commit id");
  const requestedRoot = resolve(input.rootDir);
  const requestedRootMetadata = lstatSync(requestedRoot);
  if (requestedRootMetadata.isSymbolicLink() || !requestedRootMetadata.isDirectory()) {
    throw new Error("GitHub working repository root must be a real directory");
  }
  const root = realpathSync(requestedRoot);
  const boundary = new OwnerPathLock(dirname(root), {
    label: "Verified child Git installation",
    lockName: `.git-install-${createHash("sha256").update(root).digest("hex").slice(0, 16)}.lock`,
    allowRootOwnedStickyDirectory: true,
  });
  const rootIdentity = boundary.captureDirectory(root, "GitHub working repository root");
  const runner = dependencies.runner ?? new NativeDirectCommandRunner();
  const gitPath = join(root, ".git");
  let installed = false;
  let installedGitIdentity: LockedDirectoryIdentity | null = null;

  const rootGitOutput = async (args: readonly string[], label: string): Promise<string> => {
    boundary.assertDirectory(root, rootIdentity, "GitHub working repository root");
    if (installedGitIdentity) {
      boundary.assertDirectory(gitPath, installedGitIdentity, "Child .git metadata");
    }
    const output = await gitOutput(runner, root, args, label);
    boundary.assertDirectory(root, rootIdentity, "GitHub working repository root");
    if (installedGitIdentity) {
      boundary.assertDirectory(gitPath, installedGitIdentity, "Child .git metadata");
    }
    return output;
  };

  try {
    if (!existsSync(gitPath)) {
      const parent = boundary.root.path;
      const temporaryRoot = mkdtempSync(join(parent, `.${basename(root)}-git-`));
      const temporaryIdentity = boundary.captureDirectory(
        temporaryRoot,
        "Child Git staging directory",
      );
      const cloneDirectory = join(temporaryRoot, "clone");
      try {
        const cloner = dependencies.cloner ?? new GhCliGitHubWorkingRepositoryCloner(runner);
        await cloner.clone({
          repository: input.repository,
          branch: input.branch,
          destination: cloneDirectory,
        });
        boundary.assertDirectory(temporaryRoot, temporaryIdentity, "Child Git staging directory");
        const cloneIdentity = boundary.captureDirectory(
          cloneDirectory,
          "Verified GitHub metadata clone",
        );
        const cloneGitPath = join(cloneDirectory, ".git");
        if (!existsSync(cloneGitPath) || !lstatSync(cloneGitPath).isDirectory()) {
          throw new Error("Verified GitHub metadata clone did not produce a normal .git directory");
        }
        const cloneGitIdentity = boundary.captureDirectory(
          cloneGitPath,
          "Verified GitHub metadata clone .git",
        );
        const cloneGitOutput = async (args: readonly string[], label: string): Promise<string> => {
          boundary.assertDirectory(cloneDirectory, cloneIdentity, "Verified GitHub metadata clone");
          boundary.assertDirectory(
            cloneGitPath,
            cloneGitIdentity,
            "Verified GitHub metadata clone .git",
          );
          const output = await gitOutput(runner, cloneDirectory, args, label);
          boundary.assertDirectory(cloneDirectory, cloneIdentity, "Verified GitHub metadata clone");
          boundary.assertDirectory(
            cloneGitPath,
            cloneGitIdentity,
            "Verified GitHub metadata clone .git",
          );
          return output;
        };
        const clonedHead = await cloneGitOutput(["rev-parse", "HEAD"], "Read cloned GitHub HEAD");
        if (clonedHead !== input.commitOid) {
          throw new Error(
            `Cloned GitHub HEAD ${clonedHead} does not match verified remote HEAD ${input.commitOid}`,
          );
        }
        const clonedBranch = await cloneGitOutput(
          ["symbolic-ref", "--short", "HEAD"],
          "Read cloned GitHub branch",
        );
        if (clonedBranch !== input.branch) {
          throw new Error(
            `Cloned GitHub branch ${clonedBranch} does not match verified branch ${input.branch}`,
          );
        }
        const clonedOrigin = await cloneGitOutput(
          ["remote", "get-url", "origin"],
          "Read cloned GitHub origin",
        );
        if (!githubOriginMatchesRepository(clonedOrigin, input.repository)) {
          throw new Error(
            `Cloned GitHub origin does not match the verified repository ${input.repository}`,
          );
        }
        if (existsSync(gitPath)) {
          throw new Error(
            "Child Git state appeared during verified metadata staging; refusing overwrite",
          );
        }
        dependencies.pathSecurityHook?.("before-child-git-install", gitPath);
        boundary.assertDirectory(root, rootIdentity, "GitHub working repository root");
        installedGitIdentity = boundary.renameDirectory(
          cloneGitPath,
          gitPath,
          cloneGitIdentity,
          "Verified child Git metadata install",
        );
        installed = true;
        boundary.assertDirectory(root, rootIdentity, "GitHub working repository root");
        boundary.assertDirectory(gitPath, installedGitIdentity, "Child .git metadata");
        expectSuccess(
          await runner.run("git", ["read-tree", input.commitOid], { cwd: root }),
          "Bind child Git index to verified remote tree",
        );
        boundary.assertDirectory(root, rootIdentity, "GitHub working repository root");
        boundary.assertDirectory(gitPath, installedGitIdentity, "Child .git metadata");
      } finally {
        if (existsSync(temporaryRoot)) {
          boundary.removeDirectory(temporaryRoot, temporaryIdentity, "Child Git staging directory");
        }
      }
    } else if (lstatSync(gitPath).isSymbolicLink() || !lstatSync(gitPath).isDirectory()) {
      throw new Error("Existing child .git must be a normal directory; refusing to replace it");
    } else {
      installedGitIdentity = boundary.captureDirectory(gitPath, "Existing child .git");
    }

    const topLevel = realpathSync(
      await rootGitOutput(["rev-parse", "--show-toplevel"], "Resolve child Git root"),
    );
    if (topLevel !== root)
      throw new Error(`Child Git root resolves to ${topLevel}, expected ${root}`);
    const originUrl = await rootGitOutput(["remote", "get-url", "origin"], "Read child Git origin");
    if (!githubOriginMatchesRepository(originUrl, input.repository)) {
      throw new Error(`Child Git origin does not match verified repository ${input.repository}`);
    }
    const branch = await rootGitOutput(
      ["symbolic-ref", "--short", "HEAD"],
      "Read child Git branch",
    );
    if (branch !== input.branch) {
      throw new Error(`Child Git branch ${branch} does not match verified branch ${input.branch}`);
    }
    const head = await rootGitOutput(["rev-parse", "HEAD"], "Read child Git HEAD");
    if (head !== input.commitOid) {
      throw new Error(
        `Child Git HEAD ${head} does not match verified remote HEAD ${input.commitOid}`,
      );
    }
    const remoteHead = await rootGitOutput(
      ["rev-parse", `refs/remotes/origin/${input.branch}`],
      "Read child remote-tracking HEAD",
    );
    if (remoteHead !== input.commitOid) {
      throw new Error(
        `Child remote-tracking HEAD ${remoteHead} does not match verified remote HEAD ${input.commitOid}`,
      );
    }
    const status = await rootGitOutput(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "Read child Git status",
    );
    if (status.length > 0) {
      throw new Error("Child Git working tree is not clean after verified source publication");
    }
    const privateTracked = await rootGitOutput(
      ["ls-files", "--", ".venture", "reports"],
      "Check child private runtime tracking",
    );
    if (privateTracked.length > 0) {
      throw new Error("Child Git repository tracks private runtime state or launch reports");
    }
    return { originUrl, branch, head, clean: true };
  } catch (error) {
    if (installed && installedGitIdentity) {
      try {
        boundary.assertDirectory(root, rootIdentity, "GitHub working repository root");
        boundary.removeDirectory(gitPath, installedGitIdentity, "Partially installed child .git");
      } catch {
        // Do not chase a changed path during compensation. Leave it for inspection.
      }
    }
    throw error;
  } finally {
    boundary.release();
  }
}

function gitBlobOid(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${content.byteLength}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

const CREDENTIAL_STORE_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pypirc",
  ".git-credentials",
  ".terraformrc",
  "terraform.rc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const CREDENTIAL_STORE_SUFFIXES = [
  "/.docker/config.json",
  "/.config/containers/auth.json",
  "/.config/gcloud/application_default_credentials.json",
  "/.aws/credentials",
  "/.kube/config",
  "/.cargo/credentials",
  "/.cargo/credentials.toml",
  "/.gem/credentials",
] as const;

function isCredentialStorePath(path: string): boolean {
  const normalized = `/${path.toLowerCase()}`;
  const name = normalized.split("/").at(-1) ?? "";
  return (
    CREDENTIAL_STORE_BASENAMES.has(name) ||
    CREDENTIAL_STORE_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    /(?:^|[/_.-])service[-_]?account(?:[/_.-]|$).*\.json$/u.test(normalized) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(name)
  );
}

function assertSafeSourcePath(path: string): void {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    Buffer.byteLength(path, "utf8") > MAX_SOURCE_PATH_BYTES ||
    Buffer.from(path, "utf8").toString("utf8") !== path ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part, "utf8") > MAX_SOURCE_PATH_COMPONENT_BYTES ||
        part.toLowerCase() === ".git",
    )
  ) {
    throw new Error(`Local Git tree contains an unsafe path: ${JSON.stringify(path)}`);
  }
  if (
    path === BOOTSTRAP_PATH ||
    path === ".venture" ||
    path.startsWith(".venture/") ||
    path === "reports" ||
    path.startsWith("reports/")
  ) {
    throw new Error(`Local Git tree contains reserved runtime path ${JSON.stringify(path)}`);
  }
  const basename = path.split("/").at(-1) ?? path;
  const environmentFile = /^\.env(?:\..+)?$/.test(basename);
  const exampleFile = /^\.env(?:\..+)?\.example$/.test(basename) || basename === ".env.example";
  if (environmentFile && !exampleFile) {
    throw new Error(
      `Local Git tree contains credential-prone file ${JSON.stringify(path)}; keep only reviewed example files`,
    );
  }
  if (isCredentialStorePath(path)) {
    throw new Error(
      `Local Git tree contains credential-store path ${JSON.stringify(path)}; move credentials behind cred:// references`,
    );
  }
}

interface SourceTreeDirectory {
  readonly directories: Map<string, SourceTreeDirectory>;
  readonly blobs: Map<string, Pick<LocalSourceBlob, "mode" | "oid">>;
}

function emptySourceTreeDirectory(): SourceTreeDirectory {
  return { directories: new Map(), blobs: new Map() };
}

function sourceTreeOid(blobs: readonly LocalSourceBlob[]): string {
  const root = emptySourceTreeDirectory();
  for (const blob of blobs) {
    const parts = blob.path.split("/");
    let directory = root;
    for (const [index, part] of parts.entries()) {
      const leaf = index === parts.length - 1;
      if (leaf) {
        if (directory.directories.has(part) || directory.blobs.has(part)) {
          throw new Error(
            `Local Git tree contains a conflicting path: ${JSON.stringify(blob.path)}`,
          );
        }
        directory.blobs.set(part, { mode: blob.mode, oid: blob.oid });
        continue;
      }
      if (directory.blobs.has(part)) {
        throw new Error(`Local Git tree contains a conflicting path: ${JSON.stringify(blob.path)}`);
      }
      let child = directory.directories.get(part);
      if (!child) {
        child = emptySourceTreeDirectory();
        directory.directories.set(part, child);
      }
      directory = child;
    }
  }

  const hashDirectory = (directory: SourceTreeDirectory): string => {
    const entries = [
      ...[...directory.blobs.entries()].map(([name, blob]) => ({
        name,
        sortName: Buffer.from(name, "utf8"),
        mode: blob.mode,
        oid: blob.oid,
      })),
      ...[...directory.directories.entries()].map(([name, child]) => ({
        name,
        sortName: Buffer.from(`${name}/`, "utf8"),
        mode: "40000",
        oid: hashDirectory(child),
      })),
    ].sort((left, right) => Buffer.compare(left.sortName, right.sortName));
    const body = Buffer.concat(
      entries.map((entry) =>
        Buffer.concat([
          Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"),
          Buffer.from(entry.oid, "hex"),
        ]),
      ),
    );
    return createHash("sha1")
      .update(Buffer.from(`tree ${body.byteLength}\0`, "utf8"))
      .update(body)
      .digest("hex");
  };

  return hashDirectory(root);
}

const CREDENTIAL_REFERENCE = /^cred:\/\/[A-Za-z0-9][A-Za-z0-9/_:.-]*$/u;
const BENIGN_CREDENTIAL_PLACEHOLDER =
  /^(?:REPLACE(?:_WITH)?_[A-Z0-9_]+|YOUR_[A-Z0-9_]+|<[^<>\r\n]{1,80}>|\$\{[A-Z][A-Z0-9_]*(?::-[^}\r\n]*)?\}|\[(?:REDACTED|MASKED)\])$/u;
const CONFIG_LITERAL = /^[A-Za-z0-9._~+/=-]{12,}$/u;

function containsCredentialLabeledLiteral(text: string): boolean {
  for (const line of text.split(/\r?\n/u)) {
    if (!looksLikeCredentialLabeledText(line)) continue;
    const separator = line.search(/[:=]/u);
    if (separator < 0) continue;
    let literal = line
      .slice(separator + 1)
      .trim()
      .replace(/,\s*$/u, "");
    const quote = literal[0];
    if ((quote === '"' || quote === "'") && literal.at(-1) === quote) {
      literal = literal.slice(1, -1);
    }
    if (CREDENTIAL_REFERENCE.test(literal) || BENIGN_CREDENTIAL_PLACEHOLDER.test(literal)) {
      continue;
    }
    if (CONFIG_LITERAL.test(literal) && /[0-9._~+/=-]/u.test(literal)) return true;
  }
  return false;
}

/**
 * Copy and fully preflight the exact bytes that will be sent to GitHub. This
 * deliberately does not consult the release scanner's synthetic-canary
 * allowlist: live source publication rejects every detector finding.
 */
function validateSourceSnapshot(snapshot: LocalSourceSnapshot): LocalSourceSnapshot {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Local source snapshot is malformed");
  }
  const treeOid = snapshot.treeOid;
  const snapshotBlobs = snapshot.blobs;
  if (!Array.isArray(snapshotBlobs)) {
    throw new Error("Local source snapshot is malformed");
  }
  assertOid(treeOid, "Local source tree id");
  if (snapshotBlobs.length === 0) {
    throw new Error("Refusing to publish an empty local source tree");
  }
  if (snapshotBlobs.length > MAX_SOURCE_ENTRIES) {
    throw new Error(`Local source tree exceeds the ${MAX_SOURCE_ENTRIES} entry safety limit`);
  }

  const exactPaths = new Set<string>();
  const portablePaths = new Set<string>();
  const validatedBlobs: LocalSourceBlob[] = [];
  let totalBytes = 0;
  for (const [index, candidate] of snapshotBlobs.entries()) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Local source snapshot entry ${index} is malformed`);
    }
    const { path, mode, oid } = candidate;
    if (typeof path !== "string") {
      throw new Error(`Local source snapshot entry ${index} has no safe path`);
    }
    assertSafeSourcePath(path);
    if (exactPaths.has(path)) {
      throw new Error(`Local Git tree contains duplicate path ${JSON.stringify(path)}`);
    }
    exactPaths.add(path);
    const portablePath = path.normalize("NFC").toLowerCase();
    if (portablePaths.has(portablePath)) {
      throw new Error(`Local Git tree contains an ambiguous path ${JSON.stringify(path)}`);
    }
    portablePaths.add(portablePath);
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      throw new Error(`Local Git tree entry ${JSON.stringify(path)} has an unsupported mode`);
    }
    assertOid(oid, `Local blob id for ${path}`);
    const candidateContent = candidate.content;
    if (!Buffer.isBuffer(candidateContent)) {
      throw new Error(`Local source blob ${JSON.stringify(path)} is not one exact byte buffer`);
    }

    const content = Buffer.from(candidateContent);
    if (content.byteLength > MAX_SOURCE_BLOB_BYTES) {
      throw new Error(
        `Local source blob ${JSON.stringify(path)} exceeds the ${MAX_SOURCE_BLOB_BYTES} byte safety limit`,
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error(
        `Local source tree exceeds the ${MAX_SOURCE_TOTAL_BYTES} byte aggregate safety limit`,
      );
    }
    if (gitBlobOid(content) !== oid) {
      throw new Error(`Local source blob ${JSON.stringify(path)} does not match its object id`);
    }

    const text = content.toString("utf8");
    const findings = scanCredentialText(path, text);
    const broadFinding = findCredentialMaterial(text);
    const categories = new Set<string>(findings.map((finding) => finding.rule));
    if (broadFinding) categories.add(broadFinding.kind);
    if (containsCredentialLabeledLiteral(text)) categories.add("credential_labeled_text");
    if (categories.size > 0) {
      throw new Error(
        `Local source blob ${JSON.stringify(path)} contains credential-like content (${[...categories].sort().join(", ")})`,
      );
    }
    validatedBlobs.push(Object.freeze({ path, mode, oid, content }));
  }

  const computedTreeOid = sourceTreeOid(validatedBlobs);
  if (computedTreeOid !== treeOid) {
    throw new Error("Local source tree id does not match its exact validated entries");
  }
  return Object.freeze({
    treeOid,
    blobs: Object.freeze(validatedBlobs),
  });
}

export class GitLocalSourceSnapshotLoader implements LocalSourceSnapshotLoader {
  constructor(private readonly runner: DirectCommandRunner = new NativeDirectCommandRunner()) {}

  async load(rootDir: string): Promise<LocalSourceSnapshot> {
    const unresolvedRoot = resolve(rootDir);
    const metadata = lstatSync(unresolvedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Local source root must be a real directory");
    }
    const requestedRoot = realpathSync(unresolvedRoot);

    const temporaryRoot = mkdtempSync(join(tmpdir(), "vh-github-source-"));
    if (!realpathSync(temporaryRoot).startsWith(`${realpathSync(tmpdir())}${sep}`)) {
      throw new Error("Refusing an unresolved temporary Git index path");
    }
    const gitDirectory = join(temporaryRoot, "source.git");
    const env = { GIT_DIR: gitDirectory, GIT_WORK_TREE: requestedRoot };
    try {
      expectSuccess(
        await this.runner.run("git", ["init", "--bare", "--object-format=sha1", gitDirectory], {
          cwd: requestedRoot,
        }),
        "Initialize isolated source repository",
      );
      expectSuccess(
        await this.runner.run("git", ["add", "-A", "--", "."], {
          cwd: requestedRoot,
          env,
        }),
        "Snapshot local source into isolated Git index",
      );
      const treeOid = expectSuccess(
        await this.runner.run("git", ["write-tree"], { cwd: requestedRoot, env }),
        "Write isolated local source tree",
      )
        .toString("utf8")
        .trim();
      assertOid(treeOid, "Local source tree id");
      const tree = expectSuccess(
        await this.runner.run("git", ["ls-tree", "-r", "-z", "--full-tree", treeOid], {
          cwd: requestedRoot,
          env,
        }),
        "List isolated local source tree",
      );
      const records = tree.toString("utf8").split("\0").filter(Boolean);
      if (records.length === 0) throw new Error("Refusing to publish an empty local source tree");
      if (records.length > MAX_SOURCE_ENTRIES) {
        throw new Error(`Local source tree exceeds the ${MAX_SOURCE_ENTRIES} entry safety limit`);
      }
      const contentByOid = new Map<string, Buffer>();
      const blobs: LocalSourceBlob[] = [];
      let totalBytes = 0;
      for (const record of records) {
        const separator = record.indexOf("\t");
        if (separator < 0) throw new Error("Local Git tree returned a malformed entry");
        const [mode, type, oid] = record.slice(0, separator).split(" ");
        const path = record.slice(separator + 1);
        if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
          throw new Error(
            `Local Git tree entry ${JSON.stringify(path)} is not a supported file, executable, or symlink blob`,
          );
        }
        assertSafeSourcePath(path);
        assertOid(oid, `Local blob id for ${path}`);
        let content = contentByOid.get(oid);
        if (!content) {
          content = expectSuccess(
            await this.runner.run("git", ["cat-file", "blob", oid], {
              cwd: requestedRoot,
              env,
            }),
            `Read local blob for ${path}`,
          );
          if (content.byteLength > MAX_SOURCE_BLOB_BYTES) {
            throw new Error(
              `Local source blob ${JSON.stringify(path)} exceeds the ${MAX_SOURCE_BLOB_BYTES} byte safety limit`,
            );
          }
          if (gitBlobOid(content) !== oid) {
            throw new Error(`Local blob ${JSON.stringify(path)} did not hash back to ${oid}`);
          }
          contentByOid.set(oid, content);
        }
        totalBytes += content.byteLength;
        if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
          throw new Error(
            `Local source tree exceeds the ${MAX_SOURCE_TOTAL_BYTES} byte aggregate safety limit`,
          );
        }
        blobs.push({ path, mode: mode as GitTreeEntryMode, oid, content });
      }
      return { treeOid, blobs };
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export class GhCliGitHubSourceGateway implements GitHubSourceGateway {
  constructor(
    private readonly rootDir: string,
    private readonly runner: DirectCommandRunner = new NativeDirectCommandRunner(),
  ) {}

  async inspectRepository(repository: string): Promise<GitHubRepositoryState | null> {
    assertRepository(repository);
    const result = await this.gh(["api", `repos/${repository}`]);
    if (isMissingResponse(result)) return null;
    const response = object(
      parseJson(expectSuccess(result, "Read GitHub repository"), "GitHub repository"),
      "GitHub repository",
    );
    const fullName = string(response.full_name, "GitHub repository full_name");
    if (fullName.toLowerCase() !== repository.toLowerCase()) {
      throw new Error(`GitHub read-back returned ${fullName}, expected ${repository}`);
    }
    const defaultBranch =
      response.default_branch === null || response.default_branch === undefined
        ? null
        : string(response.default_branch, "GitHub default branch");
    if (defaultBranch) assertBranch(defaultBranch);
    return {
      repository: fullName,
      visibility: normalizeVisibility(response.visibility),
      archived: boolean(response.archived, "GitHub repository archived"),
      defaultBranch,
    };
  }

  async createRepository(
    repository: string,
    visibility: GitHubRepositoryVisibility,
  ): Promise<void> {
    assertRepository(repository);
    assertVisibility(visibility);
    expectSuccess(
      await this.gh(["repo", "create", repository, `--${visibility}`]),
      `Create GitHub repository ${repository}`,
    );
  }

  async bootstrapRepository(repository: string): Promise<void> {
    const response = object(
      parseJson(
        expectSuccess(
          await this.gh(
            [
              "api",
              `repos/${repository}/contents/${BOOTSTRAP_PATH}`,
              "--method",
              "PUT",
              "--input",
              "-",
            ],
            Buffer.from(
              JSON.stringify({
                message: "chore: initialize source publication",
                content: BOOTSTRAP_CONTENT.toString("base64"),
              }),
              "utf8",
            ),
          ),
          `Initialize empty GitHub repository ${repository}`,
        ),
        "GitHub bootstrap response",
      ),
      "GitHub bootstrap response",
    );
    const content = object(response.content, "GitHub bootstrap content");
    const oid = string(content.sha, "GitHub bootstrap blob id");
    if (oid !== gitBlobOid(BOOTSTRAP_CONTENT)) {
      throw new Error("GitHub bootstrap blob did not hash back to the trusted marker");
    }
  }

  async inspectBranch(repository: string, branch: string): Promise<GitHubBranchState | null> {
    assertBranch(branch);
    const ref = await this.gh(["api", `repos/${repository}/git/ref/heads/${branch}`]);
    if (isMissingResponse(ref) || isEmptyRepositoryResponse(ref)) return null;
    const refResponse = object(
      parseJson(expectSuccess(ref, `Read GitHub branch ${branch}`), "GitHub branch"),
      "GitHub branch",
    );
    const commitOid = string(
      object(refResponse.object, "GitHub branch object").sha,
      "GitHub branch commit id",
    );
    assertOid(commitOid, "GitHub branch commit id");
    const commitResponse = object(
      parseJson(
        expectSuccess(
          await this.gh(["api", `repos/${repository}/git/commits/${commitOid}`]),
          `Read GitHub commit ${commitOid}`,
        ),
        "GitHub commit",
      ),
      "GitHub commit",
    );
    const treeOid = string(
      object(commitResponse.tree, "GitHub commit tree").sha,
      "GitHub commit tree id",
    );
    assertOid(treeOid, "GitHub commit tree id");
    return { commitOid, treeOid };
  }

  async inspectTree(repository: string, treeOid: string): Promise<readonly GitHubTreeEntry[]> {
    assertOid(treeOid, "GitHub tree id");
    const response = object(
      parseJson(
        expectSuccess(
          await this.gh(["api", `repos/${repository}/git/trees/${treeOid}?recursive=1`]),
          `Read GitHub tree ${treeOid}`,
        ),
        "GitHub tree",
      ),
      "GitHub tree",
    );
    if (response.truncated !== false) {
      throw new Error("GitHub tree read-back was truncated and cannot prove exact state");
    }
    if (!Array.isArray(response.tree)) throw new Error("GitHub tree did not return an entry list");
    return response.tree.map((entry, index) => {
      const item = object(entry, `GitHub tree entry ${index}`);
      return {
        path: string(item.path, `GitHub tree entry ${index} path`),
        mode: string(item.mode, `GitHub tree entry ${index} mode`),
        type: string(item.type, `GitHub tree entry ${index} type`),
        oid: string(item.sha, `GitHub tree entry ${index} id`),
      };
    });
  }

  async createBlob(repository: string, content: Buffer): Promise<string> {
    const response = object(
      parseJson(
        expectSuccess(
          await this.gh(
            ["api", `repos/${repository}/git/blobs`, "--method", "POST", "--input", "-"],
            Buffer.from(
              JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
              "utf8",
            ),
          ),
          "Create GitHub blob",
        ),
        "GitHub blob",
      ),
      "GitHub blob",
    );
    const oid = string(response.sha, "GitHub blob id");
    assertOid(oid, "GitHub blob id");
    return oid;
  }

  async createTree(
    repository: string,
    entries: readonly Pick<LocalSourceBlob, "path" | "mode" | "oid">[],
  ): Promise<string> {
    const response = object(
      parseJson(
        expectSuccess(
          await this.gh(
            ["api", `repos/${repository}/git/trees`, "--method", "POST", "--input", "-"],
            Buffer.from(
              JSON.stringify({
                tree: entries.map(({ path, mode, oid }) => ({
                  path,
                  mode,
                  type: "blob",
                  sha: oid,
                })),
              }),
              "utf8",
            ),
          ),
          "Create GitHub source tree",
        ),
        "GitHub source tree",
      ),
      "GitHub source tree",
    );
    const oid = string(response.sha, "GitHub source tree id");
    assertOid(oid, "GitHub source tree id");
    return oid;
  }

  async createCommit(
    repository: string,
    treeOid: string,
    parentCommitOid: string,
  ): Promise<{ commitOid: string; treeOid: string }> {
    assertOid(treeOid, "GitHub source tree id");
    assertOid(parentCommitOid, "GitHub parent commit id");
    const response = object(
      parseJson(
        expectSuccess(
          await this.gh(
            ["api", `repos/${repository}/git/commits`, "--method", "POST", "--input", "-"],
            Buffer.from(
              JSON.stringify({
                message: COMMIT_MESSAGE,
                tree: treeOid,
                parents: [parentCommitOid],
                author: COMMIT_IDENTITY,
                committer: COMMIT_IDENTITY,
              }),
              "utf8",
            ),
          ),
          "Create GitHub source commit",
        ),
        "GitHub source commit",
      ),
      "GitHub source commit",
    );
    const commitOid = string(response.sha, "GitHub source commit id");
    const returnedTreeOid = string(
      object(response.tree, "GitHub source commit tree").sha,
      "GitHub source commit tree id",
    );
    assertOid(commitOid, "GitHub source commit id");
    assertOid(returnedTreeOid, "GitHub source commit tree id");
    return { commitOid, treeOid: returnedTreeOid };
  }

  async updateBranch(repository: string, branch: string, commitOid: string): Promise<void> {
    assertBranch(branch);
    assertOid(commitOid, "GitHub source commit id");
    expectSuccess(
      await this.gh(
        [
          "api",
          `repos/${repository}/git/refs/heads/${branch}`,
          "--method",
          "PATCH",
          "--input",
          "-",
        ],
        Buffer.from(JSON.stringify({ sha: commitOid, force: false }), "utf8"),
      ),
      `Advance GitHub branch ${branch}`,
    );
  }

  private gh(args: readonly string[], stdin?: Buffer): Promise<DirectCommandResult> {
    return this.runner.run("gh", args, { cwd: this.rootDir, stdin });
  }
}

function assertRepositoryState(
  state: GitHubRepositoryState,
  repository: string,
  visibility: GitHubRepositoryVisibility,
): void {
  if (state.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `GitHub repository read-back returned ${state.repository}, expected ${repository}`,
    );
  }
  if (state.visibility !== visibility) {
    throw new Error(
      `GitHub repository ${repository} is ${state.visibility}, expected ${visibility}; refusing to change visibility implicitly`,
    );
  }
  if (state.archived) {
    throw new Error(`GitHub repository ${repository} is archived and cannot receive source`);
  }
}

async function bootstrapTreeIsTrusted(
  gateway: GitHubSourceGateway,
  repository: string,
  treeOid: string,
): Promise<boolean> {
  const entries = await gateway.inspectTree(repository, treeOid);
  return (
    entries.length === 1 &&
    entries[0]?.path === BOOTSTRAP_PATH &&
    entries[0]?.mode === "100644" &&
    entries[0]?.type === "blob" &&
    entries[0]?.oid === gitBlobOid(BOOTSTRAP_CONTENT)
  );
}

export async function verifyGitHubSource(
  input: VerifyGitHubSourceInput,
  gateway: GitHubSourceGateway,
): Promise<Omit<GitHubSourcePublicationResult, "created" | "source">> {
  assertRepository(input.repository);
  assertVisibility(input.visibility);
  assertBranch(input.branch);
  assertOid(input.commitOid, "Expected GitHub commit id");
  assertOid(input.treeOid, "Expected GitHub tree id");
  const repository = await gateway.inspectRepository(input.repository);
  if (!repository)
    throw new Error(`GitHub repository ${input.repository} was not found on read-back`);
  assertRepositoryState(repository, input.repository, input.visibility);
  if (repository.defaultBranch !== input.branch) {
    throw new Error(
      `GitHub default branch read-back returned ${repository.defaultBranch ?? "none"}, expected ${input.branch}`,
    );
  }
  const branch = await gateway.inspectBranch(input.repository, input.branch);
  if (!branch) throw new Error(`GitHub branch ${input.branch} was not found on read-back`);
  if (branch.commitOid !== input.commitOid) {
    throw new Error(
      `GitHub branch ${input.branch} points to ${branch.commitOid}, expected exact commit ${input.commitOid}`,
    );
  }
  if (branch.treeOid !== input.treeOid) {
    throw new Error(
      `GitHub commit ${input.commitOid} points to tree ${branch.treeOid}, expected exact local tree ${input.treeOid}`,
    );
  }
  return { ...input, verified: true };
}

export async function publishGitHubSource(
  input: PublishGitHubSourceInput,
  dependencies: GitHubSourcePublicationDependencies,
): Promise<GitHubSourcePublicationResult> {
  assertRepository(input.repository);
  assertVisibility(input.visibility);
  const snapshot = validateSourceSnapshot(await dependencies.snapshots.load(input.rootDir));

  let repository = await dependencies.gateway.inspectRepository(input.repository);
  let created = false;
  if (!repository) {
    await dependencies.gateway.createRepository(input.repository, input.visibility);
    created = true;
    repository = await dependencies.gateway.inspectRepository(input.repository);
    if (!repository) {
      throw new Error(
        `GitHub accepted creation of ${input.repository}, but exact repository read-back is unavailable`,
      );
    }
  }
  assertRepositoryState(repository, input.repository, input.visibility);

  let branchName = repository.defaultBranch;
  let branch = branchName
    ? await dependencies.gateway.inspectBranch(input.repository, branchName)
    : null;
  if (!branch) {
    await dependencies.gateway.bootstrapRepository(input.repository);
    repository = await dependencies.gateway.inspectRepository(input.repository);
    if (!repository) throw new Error(`GitHub bootstrap for ${input.repository} was not readable`);
    assertRepositoryState(repository, input.repository, input.visibility);
    branchName = repository.defaultBranch;
    if (!branchName) {
      throw new Error(`GitHub bootstrap for ${input.repository} did not create a default branch`);
    }
    branch = await dependencies.gateway.inspectBranch(input.repository, branchName);
    if (!branch) {
      throw new Error(`GitHub bootstrap branch ${branchName} was not readable`);
    }
  }
  assertBranch(branchName!);

  if (branch.treeOid === snapshot.treeOid) {
    const verification = await verifyGitHubSource(
      {
        repository: input.repository,
        visibility: input.visibility,
        branch: branchName!,
        commitOid: branch.commitOid,
        treeOid: snapshot.treeOid,
      },
      dependencies.gateway,
    );
    return { ...verification, created, source: "local_git_tree" };
  }

  if (!(await bootstrapTreeIsTrusted(dependencies.gateway, input.repository, branch.treeOid))) {
    throw new Error(
      `GitHub repository ${input.repository} already contains a different tree; refusing to overwrite it. Choose a new empty repository or verify and migrate the existing repository explicitly`,
    );
  }

  const uploaded = new Set<string>();
  for (const blob of snapshot.blobs) {
    if (uploaded.has(blob.oid)) continue;
    const remoteOid = await dependencies.gateway.createBlob(input.repository, blob.content);
    if (remoteOid !== blob.oid) {
      throw new Error(`GitHub blob read-back ${remoteOid} did not match local blob ${blob.oid}`);
    }
    uploaded.add(blob.oid);
  }
  const remoteTreeOid = await dependencies.gateway.createTree(
    input.repository,
    snapshot.blobs.map(({ path, mode, oid }) => ({ path, mode, oid })),
  );
  if (remoteTreeOid !== snapshot.treeOid) {
    throw new Error(
      `GitHub tree read-back ${remoteTreeOid} did not match exact local tree ${snapshot.treeOid}`,
    );
  }
  const commit = await dependencies.gateway.createCommit(
    input.repository,
    remoteTreeOid,
    branch.commitOid,
  );
  if (commit.treeOid !== snapshot.treeOid) {
    throw new Error(
      `GitHub source commit points to ${commit.treeOid}, expected exact local tree ${snapshot.treeOid}`,
    );
  }
  await dependencies.gateway.updateBranch(input.repository, branchName!, commit.commitOid);
  const verification = await verifyGitHubSource(
    {
      repository: input.repository,
      visibility: input.visibility,
      branch: branchName!,
      commitOid: commit.commitOid,
      treeOid: snapshot.treeOid,
    },
    dependencies.gateway,
  );
  return { ...verification, created, source: "local_git_tree" };
}

export async function publishVerifiedGitHubWorkingSource(
  input: PublishGitHubSourceInput,
  dependencies: GitHubSourcePublicationDependencies & VerifiedGitHubWorkingRepositoryDependencies,
): Promise<GitHubSourcePublicationResult & { workingRepository: VerifiedGitHubWorkingRepository }> {
  const publication = await publishGitHubSource(input, dependencies);
  const workingRepository = await ensureVerifiedGitHubWorkingRepository(
    {
      repository: input.repository,
      rootDir: input.rootDir,
      branch: publication.branch,
      commitOid: publication.commitOid,
    },
    dependencies,
  );
  return { ...publication, workingRepository };
}

function argValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args[index + 1]!.startsWith("--")) {
    throw new Error(`Missing required ${name} value`);
  }
  return args[index + 1]!;
}

export async function runGitHubSourcePublicationCli(
  args: readonly string[],
  options: { cwd?: string; runner?: DirectCommandRunner } = {},
): Promise<
  | GitHubSourcePublicationResult
  | (Omit<GitHubSourcePublicationResult, "created" | "source"> & {
      workingRepository: VerifiedGitHubWorkingRepository;
    })
> {
  const [command, ...rest] = args;
  if (command !== "apply" && command !== "verify") {
    throw new Error("Expected apply or verify; no provider operation was attempted");
  }
  const repository = argValue(rest, "--repository");
  const visibility = argValue(rest, "--visibility");
  assertVisibility(visibility);
  const cwd = realpathSync(resolve(options.cwd ?? process.cwd()));
  const runner = options.runner ?? new NativeDirectCommandRunner();
  const gateway = new GhCliGitHubSourceGateway(cwd, runner);
  if (command === "verify") {
    const verification = await verifyGitHubSource(
      {
        repository,
        visibility,
        branch: argValue(rest, "--branch"),
        commitOid: argValue(rest, "--commit"),
        treeOid: argValue(rest, "--tree"),
      },
      gateway,
    );
    const workingRepository = await ensureVerifiedGitHubWorkingRepository(
      {
        repository,
        rootDir: cwd,
        branch: verification.branch,
        commitOid: verification.commitOid,
      },
      { runner },
    );
    return { ...verification, workingRepository };
  }
  // Apply returns the verified remote reconciliation identifiers before any
  // local `.git` mutation. The provider read-back command below installs and
  // verifies the working repository, so a local Git failure can be retried
  // without losing an already-created remote commit behind an ambiguous exit.
  return publishGitHubSource(
    { repository, visibility, rootDir: cwd },
    {
      gateway,
      snapshots: new GitLocalSourceSnapshotLoader(runner),
    },
  );
}
