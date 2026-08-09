import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const BOOTSTRAP_PATH = ".venture-harness-bootstrap";
const BOOTSTRAP_CONTENT = Buffer.from("venture-harness-source-bootstrap-v1\n", "utf8");
const MAX_SOURCE_ENTRIES = 10_000;
const MAX_SOURCE_BLOB_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024;
const COMMIT_MESSAGE = "chore: publish verified venture source";
const COMMIT_IDENTITY = {
  name: "Venture Harness",
  email: "venture-harness@users.noreply.github.com",
  date: "2000-01-01T00:00:00Z",
} as const;

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
    const result = spawnSync(command, [...args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
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

function gitBlobOid(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${content.byteLength}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

function assertSafeSourcePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Local Git tree contains an unsafe path: ${JSON.stringify(path)}`);
  }
  if (path === BOOTSTRAP_PATH || path.startsWith(".venture/")) {
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
}

export class GitLocalSourceSnapshotLoader implements LocalSourceSnapshotLoader {
  constructor(private readonly runner: DirectCommandRunner = new NativeDirectCommandRunner()) {}

  async load(rootDir: string): Promise<LocalSourceSnapshot> {
    const requestedRoot = realpathSync(resolve(rootDir));
    const topLevelResult = await this.runner.run("git", ["rev-parse", "--show-toplevel"], {
      cwd: requestedRoot,
    });
    const topLevel = realpathSync(
      expectSuccess(topLevelResult, "Resolve local Git repository").toString("utf8").trim(),
    );
    if (topLevel !== requestedRoot) {
      throw new Error(`Source directory must be the Git repository root (${topLevel})`);
    }
    const objectFormat = expectSuccess(
      await this.runner.run("git", ["rev-parse", "--show-object-format"], { cwd: requestedRoot }),
      "Read local Git object format",
    )
      .toString("utf8")
      .trim();
    if (objectFormat !== "sha1") {
      throw new Error(
        `GitHub source publication currently requires sha1, received ${objectFormat}`,
      );
    }

    const temporaryRoot = mkdtempSync(join(tmpdir(), "vh-github-source-"));
    if (!realpathSync(temporaryRoot).startsWith(`${realpathSync(tmpdir())}${sep}`)) {
      throw new Error("Refusing an unresolved temporary Git index path");
    }
    const indexPath = join(temporaryRoot, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      const head = await this.runner.run("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: requestedRoot,
      });
      if (head.exitCode === 0) {
        expectSuccess(
          await this.runner.run("git", ["read-tree", "HEAD"], { cwd: requestedRoot, env }),
          "Seed isolated Git index",
        );
      } else {
        expectSuccess(
          await this.runner.run("git", ["read-tree", "--empty"], { cwd: requestedRoot, env }),
          "Create isolated Git index",
        );
      }
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
            await this.runner.run("git", ["cat-file", "blob", oid], { cwd: requestedRoot }),
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
  const snapshot = await dependencies.snapshots.load(input.rootDir);
  assertOid(snapshot.treeOid, "Local source tree id");
  if (snapshot.blobs.length === 0)
    throw new Error("Refusing to publish an empty local source tree");

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
  GitHubSourcePublicationResult | Omit<GitHubSourcePublicationResult, "created" | "source">
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
    return verifyGitHubSource(
      {
        repository,
        visibility,
        branch: argValue(rest, "--branch"),
        commitOid: argValue(rest, "--commit"),
        treeOid: argValue(rest, "--tree"),
      },
      gateway,
    );
  }
  return publishGitHubSource(
    { repository, visibility, rootDir: cwd },
    { gateway, snapshots: new GitLocalSourceSnapshotLoader(runner) },
  );
}
