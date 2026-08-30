import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VH_BUILD_PROVENANCE_PATH,
  assertReviewedCoreSourceState,
  buildVhExecutable,
  createVhBuildProvenance,
  loadVhBuildProvenance,
  verifyVhExecutableBuildParity,
  writeVhBuildProvenance,
} from "../scripts/build-vh-executable.mjs";

const roots: string[] = [];

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function createCoreFixture(): { root: string; sourceCommit: string } {
  const root = mkdtempSync(join(tmpdir(), "vh-generated-parity-core-"));
  roots.push(root);
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify({ name: "venture-harness", version: "0.2.0", type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(root, "scripts/vh-bundle.ts"),
    `declare const __VH_CORE_BUILD_COMMIT__: string;
declare const __VH_CORE_PACKAGE_VERSION__: string;
export const provenance = {
  packageVersion: __VH_CORE_PACKAGE_VERSION__,
  workflowRefSha: __VH_CORE_BUILD_COMMIT__,
};
`,
  );
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "generated-parity@example.invalid"]);
  git(root, ["config", "user.name", "Generated Parity Fixture"]);
  git(root, ["remote", "add", "origin", "https://github.com/venture-harness/venture-harness.git"]);
  git(root, ["add", "package.json", "scripts/vh-bundle.ts"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "source"]);
  return { root, sourceCommit: git(root, ["rev-parse", "HEAD"]) };
}

async function buildRecordedFixture(root: string, sourceCommit: string): Promise<void> {
  const executable = resolve(root, "bin/vh.mjs");
  mkdirSync(dirname(executable), { recursive: true });
  const provenance = await buildVhExecutable({
    rootDirectory: root,
    outfile: executable,
    sourceCommit,
  });
  writeVhBuildProvenance(
    resolve(root, VH_BUILD_PROVENANCE_PATH),
    createVhBuildProvenance({
      executable,
      packageVersion: provenance.packageVersion,
      sourceCommit: provenance.workflowRefSha,
      coreRepository: provenance.coreRepository,
    }),
  );
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("vh generated executable parity", () => {
  it("requires the reviewed source commit instead of inferring the caller HEAD", async () => {
    const { root } = createCoreFixture();
    await expect(
      buildVhExecutable({
        rootDirectory: root,
        outfile: resolve(root, "bin/vh.mjs"),
        sourceCommit: undefined,
      }),
    ).rejects.toThrow(/must be an explicit lowercase 40-character SHA/);
  });

  it("rebuilds byte-for-byte from a reviewed source commit after an artifact-only commit", async () => {
    const { root, sourceCommit } = createCoreFixture();
    await buildRecordedFixture(root, sourceCommit);
    git(root, ["add", "bin/vh.mjs", VH_BUILD_PROVENANCE_PATH]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "artifacts"]);
    const artifactCommit = git(root, ["rev-parse", "HEAD"]);
    expect(artifactCommit).not.toBe(sourceCommit);

    await expect(verifyVhExecutableBuildParity({ rootDirectory: root })).resolves.toMatchObject({
      status: "passed",
      packageVersion: "0.2.0",
      coreSourceCommit: sourceCommit,
      currentCommit: artifactCommit,
    });
    expect(loadVhBuildProvenance(resolve(root, VH_BUILD_PROVENANCE_PATH))).toMatchObject({
      coreSourceCommit: sourceCommit,
      binSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects executable-input drift outside the artifact allowlist", async () => {
    const { root, sourceCommit } = createCoreFixture();
    await buildRecordedFixture(root, sourceCommit);
    writeFileSync(
      resolve(root, "scripts/vh-bundle.ts"),
      `${readFileSync(resolve(root, "scripts/vh-bundle.ts"), "utf8")}export const drift = true;\n`,
    );

    await expect(verifyVhExecutableBuildParity({ rootDirectory: root })).rejects.toThrow(
      /scripts\/vh-bundle\.ts.*Commit the source changes/,
    );
  });

  it("ignores local Codex role configs without allowing untracked source", () => {
    const { root, sourceCommit } = createCoreFixture();
    mkdirSync(resolve(root, ".codex/agents"), { recursive: true });
    writeFileSync(resolve(root, ".codex/agents/security-reviewer.toml"), 'name = "local-only"\n');

    expect(assertReviewedCoreSourceState({ rootDirectory: root, sourceCommit })).toMatchObject({
      sourceCommit,
      artifactOnlyChanges: [],
    });

    writeFileSync(resolve(root, "scripts/untracked-executable.ts"), "export const drift = true;\n");
    expect(() => assertReviewedCoreSourceState({ rootDirectory: root, sourceCommit })).toThrow(
      /scripts\/untracked-executable\.ts.*Commit the source changes/,
    );
  });

  it("rejects a binary that no longer matches its immutable sidecar hash", async () => {
    const { root, sourceCommit } = createCoreFixture();
    await buildRecordedFixture(root, sourceCommit);
    writeFileSync(resolve(root, "bin/vh.mjs"), "tampered executable\n");

    await expect(verifyVhExecutableBuildParity({ rootDirectory: root })).rejects.toThrow(
      /hash .* does not match bin\/vh-build-provenance\.json/,
    );
  });

  it("rejects a co-tampered binary and sidecar that cannot be reproduced", async () => {
    const { root, sourceCommit } = createCoreFixture();
    await buildRecordedFixture(root, sourceCommit);
    const executable = resolve(root, "bin/vh.mjs");
    writeFileSync(executable, "co-tampered executable\n");
    writeVhBuildProvenance(
      resolve(root, VH_BUILD_PROVENANCE_PATH),
      createVhBuildProvenance({
        executable,
        packageVersion: "0.2.0",
        sourceCommit,
        coreRepository: "venture-harness/venture-harness",
      }),
    );

    await expect(verifyVhExecutableBuildParity({ rootDirectory: root })).rejects.toThrow(
      /not a byte-for-byte deterministic rebuild/,
    );
  });
});
