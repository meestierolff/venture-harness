import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureVerifiedGitHubWorkingRepository,
  GitLocalSourceSnapshotLoader,
  publishGitHubSource,
  publishVerifiedGitHubWorkingSource,
  verifyGitHubSource,
  type GitHubBranchState,
  type GitHubRepositoryState,
  type GitHubRepositoryVisibility,
  type GitHubSourceGateway,
  type GitHubTreeEntry,
  type GitHubWorkingRepositoryCloner,
  type LocalSourceSnapshot,
} from "@/lib/providers";

const repository = "example/venture";
const visibility: GitHubRepositoryVisibility = "private";
const bootstrapContent = Buffer.from("venture-harness-source-bootstrap-v1\n", "utf8");
const bootstrapBlobOid = createHash("sha1")
  .update(Buffer.from(`blob ${bootstrapContent.byteLength}\0`, "utf8"))
  .update(bootstrapContent)
  .digest("hex");
const bootstrapCommitOid = "1".repeat(40);
const bootstrapTreeOid = "2".repeat(40);
const sourceCommitOid = "3".repeat(40);
const sourceTreeOid = "4".repeat(40);
const sourceBlobOid = "5".repeat(40);

const snapshot: LocalSourceSnapshot = {
  treeOid: sourceTreeOid,
  blobs: [
    {
      path: "README.md",
      mode: "100644",
      oid: sourceBlobOid,
      content: Buffer.from("# Verified venture\n", "utf8"),
    },
  ],
};

class FakeGateway implements GitHubSourceGateway {
  repository: GitHubRepositoryState | null = null;
  branch: GitHubBranchState | null = null;
  treeEntries: GitHubTreeEntry[] = [];
  readonly calls: string[] = [];
  blobOid = sourceBlobOid;
  treeOid = sourceTreeOid;
  commitOid = sourceCommitOid;

  async inspectRepository(): Promise<GitHubRepositoryState | null> {
    this.calls.push("inspect_repository");
    return this.repository;
  }

  async createRepository(
    target: string,
    requestedVisibility: GitHubRepositoryVisibility,
  ): Promise<void> {
    this.calls.push("create_repository");
    this.repository = {
      repository: target,
      visibility: requestedVisibility,
      archived: false,
      defaultBranch: null,
    };
  }

  async bootstrapRepository(): Promise<void> {
    this.calls.push("bootstrap_repository");
    this.repository = {
      repository,
      visibility,
      archived: false,
      defaultBranch: "main",
    };
    this.branch = { commitOid: bootstrapCommitOid, treeOid: bootstrapTreeOid };
    this.treeEntries = [
      {
        path: ".venture-harness-bootstrap",
        mode: "100644",
        type: "blob",
        oid: bootstrapBlobOid,
      },
    ];
  }

  async inspectBranch(): Promise<GitHubBranchState | null> {
    this.calls.push("inspect_branch");
    return this.branch;
  }

  async inspectTree(): Promise<readonly GitHubTreeEntry[]> {
    this.calls.push("inspect_tree");
    return this.treeEntries;
  }

  async createBlob(): Promise<string> {
    this.calls.push("create_blob");
    return this.blobOid;
  }

  async createTree(): Promise<string> {
    this.calls.push("create_tree");
    return this.treeOid;
  }

  async createCommit(): Promise<{ commitOid: string; treeOid: string }> {
    this.calls.push("create_commit");
    return { commitOid: this.commitOid, treeOid: this.treeOid };
  }

  async updateBranch(): Promise<void> {
    this.calls.push("update_branch");
    this.branch = { commitOid: this.commitOid, treeOid: this.treeOid };
  }
}

function existingGateway(branch: GitHubBranchState): FakeGateway {
  const gateway = new FakeGateway();
  gateway.repository = {
    repository,
    visibility,
    archived: false,
    defaultBranch: "main",
  };
  gateway.branch = branch;
  return gateway;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function workingRepositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "vh-working-repository-"));
  const publisher = join(root, "publisher");
  const child = join(root, "child");
  const remote = join(root, "remote.git");
  mkdirSync(publisher);
  mkdirSync(child);
  for (const directory of [publisher, child]) {
    writeFileSync(
      join(directory, ".gitignore"),
      ".venture/\nreports/\n.env*\n!.env.example\n",
      "utf8",
    );
    writeFileSync(join(directory, "README.md"), "# Verified venture\n", "utf8");
  }
  mkdirSync(join(child, ".venture"));
  mkdirSync(join(child, "reports"));
  writeFileSync(join(child, ".venture", "state.json"), '{"private":true}\n', "utf8");
  writeFileSync(join(child, "reports", "launch.json"), '{"private":true}\n', "utf8");

  git(publisher, ["init", "--initial-branch", "main"]);
  git(publisher, ["config", "user.name", "Venture Harness Test"]);
  git(publisher, ["config", "user.email", "test@venture-harness.invalid"]);
  git(publisher, ["add", "--all"]);
  git(publisher, ["commit", "-m", "test: verified source"]);
  git(root, ["init", "--bare", remote]);
  git(publisher, ["remote", "add", "origin", remote]);
  git(publisher, ["push", "--set-upstream", "origin", "main"]);
  const commitOid = git(publisher, ["rev-parse", "HEAD"]);
  return { root, child, remote, commitOid };
}

describe("GitHub local-source publication", () => {
  it("snapshots a not-yet-Git child while excluding private runtime state and reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-source-snapshot-"));
    try {
      writeFileSync(join(root, "README.md"), "# Independent child\n", "utf8");
      writeFileSync(join(root, ".gitignore"), ".venture/\nreports/\n", "utf8");
      mkdirSync(join(root, ".venture"));
      mkdirSync(join(root, "reports"));
      writeFileSync(join(root, ".venture", "state.json"), '{"private":true}\n', "utf8");
      writeFileSync(join(root, "reports", "launch.json"), '{"private":true}\n', "utf8");

      const source = await new GitLocalSourceSnapshotLoader().load(root);

      expect(source.blobs.map(({ path }) => path)).toEqual([".gitignore", "README.md"]);
      expect(source.blobs.map(({ path }) => path)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(?:\.venture|reports)(?:\/|$)/u)]),
      );
      expect(source.treeOid).toMatch(/^[0-9a-f]{40}$/u);
      expect(existsSync(join(root, ".git"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses private runtime and report paths even if a child ignore file drifts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-source-private-state-"));
    try {
      writeFileSync(join(root, "README.md"), "# Unsafe child\n", "utf8");
      mkdirSync(join(root, "reports"));
      writeFileSync(join(root, "reports", "launch.json"), '{"private":true}\n', "utf8");

      await expect(new GitLocalSourceSnapshotLoader().load(root)).rejects.toThrow(
        /reserved runtime path "reports\/launch\.json"/u,
      );
      expect(existsSync(join(root, ".git"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates an empty repository, uploads the exact local Git tree, and reads it back", async () => {
    const gateway = new FakeGateway();
    const result = await publishGitHubSource(
      { repository, visibility, rootDir: "/synthetic/repository" },
      { gateway, snapshots: { load: async () => snapshot } },
    );

    expect(result).toEqual({
      repository,
      visibility,
      branch: "main",
      commitOid: sourceCommitOid,
      treeOid: sourceTreeOid,
      verified: true,
      created: true,
      source: "local_git_tree",
    });
    expect(gateway.calls).toEqual([
      "inspect_repository",
      "create_repository",
      "inspect_repository",
      "bootstrap_repository",
      "inspect_repository",
      "inspect_branch",
      "inspect_tree",
      "create_blob",
      "create_tree",
      "create_commit",
      "update_branch",
      "inspect_repository",
      "inspect_branch",
    ]);
  });

  it("does not report apply success when the verified working-repository handoff fails", async () => {
    const gateway = existingGateway({
      commitOid: sourceCommitOid,
      treeOid: sourceTreeOid,
    });
    const childRoot = mkdtempSync(join(tmpdir(), "vh-source-handoff-failure-"));
    try {
      writeFileSync(join(childRoot, "README.md"), "# Verified venture\n", "utf8");
      await expect(
        publishVerifiedGitHubWorkingSource(
          { repository, visibility, rootDir: childRoot },
          {
            gateway,
            snapshots: { load: async () => snapshot },
            cloner: {
              async clone() {
                throw new Error("synthetic clone handoff unavailable");
              },
            },
          },
        ),
      ).rejects.toThrow(/synthetic clone handoff unavailable/);
      expect(existsSync(join(childRoot, ".git"))).toBe(false);
      expect(gateway.calls).not.toEqual(expect.arrayContaining(["create_blob", "update_branch"]));
    } finally {
      rmSync(childRoot, { recursive: true, force: true });
    }
  });

  it("reconciles an already exact branch without issuing another write", async () => {
    const gateway = existingGateway({
      commitOid: sourceCommitOid,
      treeOid: sourceTreeOid,
    });
    const result = await publishGitHubSource(
      { repository, visibility, rootDir: "/synthetic/repository" },
      { gateway, snapshots: { load: async () => snapshot } },
    );

    expect(result).toMatchObject({ verified: true, created: false, treeOid: sourceTreeOid });
    expect(gateway.calls).not.toEqual(expect.arrayContaining(["create_blob", "update_branch"]));
  });

  it("fails closed instead of replacing a stale template or unrelated branch", async () => {
    const gateway = existingGateway({
      commitOid: "6".repeat(40),
      treeOid: "7".repeat(40),
    });
    gateway.treeEntries = [
      { path: "README.md", mode: "100644", type: "blob", oid: "8".repeat(40) },
    ];

    await expect(
      publishGitHubSource(
        { repository, visibility, rootDir: "/synthetic/repository" },
        { gateway, snapshots: { load: async () => snapshot } },
      ),
    ).rejects.toThrow(/already contains a different tree; refusing to overwrite/);
    expect(gateway.calls).not.toContain("update_branch");
  });

  it("rejects a blob or tree that GitHub does not hash back exactly", async () => {
    const gateway = new FakeGateway();
    gateway.blobOid = "9".repeat(40);
    await expect(
      publishGitHubSource(
        { repository, visibility, rootDir: "/synthetic/repository" },
        { gateway, snapshots: { load: async () => snapshot } },
      ),
    ).rejects.toThrow(/did not match local blob/);
    expect(gateway.calls).not.toContain("update_branch");
  });

  it("rejects read-back when the default branch no longer points at the exact commit", async () => {
    const gateway = existingGateway({
      commitOid: "a".repeat(40),
      treeOid: sourceTreeOid,
    });
    await expect(
      verifyGitHubSource(
        {
          repository,
          visibility,
          branch: "main",
          commitOid: sourceCommitOid,
          treeOid: sourceTreeOid,
        },
        gateway,
      ),
    ).rejects.toThrow(/expected exact commit/);
  });

  it("installs a normal clean child repository only from verified remote metadata", async () => {
    const fixture = workingRepositoryFixture();
    let cloneCalls = 0;
    const cloner: GitHubWorkingRepositoryCloner = {
      async clone(input) {
        cloneCalls += 1;
        git(fixture.root, [
          "clone",
          "--no-checkout",
          "--single-branch",
          "--branch",
          input.branch,
          fixture.remote,
          input.destination,
        ]);
        git(input.destination, [
          "remote",
          "set-url",
          "origin",
          `https://github.com/${input.repository}.git`,
        ]);
      },
    };

    try {
      const installed = await ensureVerifiedGitHubWorkingRepository(
        {
          repository,
          rootDir: fixture.child,
          branch: "main",
          commitOid: fixture.commitOid,
        },
        { cloner },
      );

      expect(installed).toEqual({
        originUrl: `https://github.com/${repository}.git`,
        branch: "main",
        head: fixture.commitOid,
        clean: true,
      });
      expect(existsSync(join(fixture.child, ".git"))).toBe(true);
      expect(git(fixture.child, ["rev-parse", "HEAD"])).toBe(fixture.commitOid);
      expect(git(fixture.child, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
      expect(git(fixture.child, ["ls-files", "--", ".venture", "reports"])).toBe("");
      expect(git(fixture.child, ["check-ignore", ".venture/state.json"])).toBe(
        ".venture/state.json",
      );
      expect(git(fixture.child, ["check-ignore", "reports/launch.json"])).toBe(
        "reports/launch.json",
      );

      await ensureVerifiedGitHubWorkingRepository(
        {
          repository,
          rootDir: fixture.child,
          branch: "main",
          commitOid: fixture.commitOid,
        },
        {
          cloner: {
            async clone() {
              throw new Error("idempotent verification must not clone again");
            },
          },
        },
      );
      expect(cloneCalls).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed on a mismatched clone or an unrelated existing repository", async () => {
    const fixture = workingRepositoryFixture();
    const cloner: GitHubWorkingRepositoryCloner = {
      async clone(input) {
        git(fixture.root, [
          "clone",
          "--no-checkout",
          "--single-branch",
          "--branch",
          input.branch,
          fixture.remote,
          input.destination,
        ]);
        git(input.destination, [
          "remote",
          "set-url",
          "origin",
          `https://github.com/${input.repository}.git`,
        ]);
      },
    };

    try {
      await expect(
        ensureVerifiedGitHubWorkingRepository(
          {
            repository,
            rootDir: fixture.child,
            branch: "main",
            commitOid: "f".repeat(40),
          },
          { cloner },
        ),
      ).rejects.toThrow(/does not match verified remote HEAD/);
      expect(existsSync(join(fixture.child, ".git"))).toBe(false);

      await ensureVerifiedGitHubWorkingRepository(
        {
          repository,
          rootDir: fixture.child,
          branch: "main",
          commitOid: fixture.commitOid,
        },
        { cloner },
      );
      git(fixture.child, [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/unrelated.git",
      ]);
      await expect(
        ensureVerifiedGitHubWorkingRepository({
          repository,
          rootDir: fixture.child,
          branch: "main",
          commitOid: fixture.commitOid,
        }),
      ).rejects.toThrow(/origin does not match verified repository/);
      expect(git(fixture.child, ["rev-parse", "HEAD"])).toBe(fixture.commitOid);

      git(fixture.child, ["remote", "set-url", "origin", `https://github.com/${repository}.git`]);
      writeFileSync(join(fixture.child, "README.md"), "# Local uncommitted change\n", "utf8");
      await expect(
        ensureVerifiedGitHubWorkingRepository({
          repository,
          rootDir: fixture.child,
          branch: "main",
          commitOid: fixture.commitOid,
        }),
      ).rejects.toThrow(/working tree is not clean/);
      expect(git(fixture.child, ["rev-parse", "HEAD"])).toBe(fixture.commitOid);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not install .git when the checked child is swapped before metadata rename", async () => {
    const fixture = workingRepositoryFixture();
    const outside = mkdtempSync(join(tmpdir(), "vh-working-repository-race-outside-"));
    const originalChild = join(fixture.root, "child-before-race");
    let swapped = false;
    const cloner: GitHubWorkingRepositoryCloner = {
      async clone(input) {
        git(fixture.root, [
          "clone",
          "--no-checkout",
          "--single-branch",
          "--branch",
          input.branch,
          fixture.remote,
          input.destination,
        ]);
        git(input.destination, [
          "remote",
          "set-url",
          "origin",
          `https://github.com/${input.repository}.git`,
        ]);
      },
    };

    try {
      await expect(
        ensureVerifiedGitHubWorkingRepository(
          {
            repository,
            rootDir: fixture.child,
            branch: "main",
            commitOid: fixture.commitOid,
          },
          {
            cloner,
            pathSecurityHook(event) {
              if (event !== "before-child-git-install" || swapped) return;
              swapped = true;
              renameSync(fixture.child, originalChild);
              symlinkSync(outside, fixture.child, "dir");
            },
          },
        ),
      ).rejects.toThrow(/non-symlink directory|symbolic-link alias|changed/i);
      expect(swapped).toBe(true);
      expect(existsSync(join(outside, ".git"))).toBe(false);
      expect(existsSync(join(originalChild, ".git"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
