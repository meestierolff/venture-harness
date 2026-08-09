import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  publishGitHubSource,
  verifyGitHubSource,
  type GitHubBranchState,
  type GitHubRepositoryState,
  type GitHubRepositoryVisibility,
  type GitHubSourceGateway,
  type GitHubTreeEntry,
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

describe("GitHub local-source publication", () => {
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
});
