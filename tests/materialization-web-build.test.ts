import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseHarnessLock } from "@/lib/config/harness-lock";
import {
  compileVentureMaterialization,
  createLaunchGrant,
  materializeVenture,
  NodeMaterializationFileSystem,
  type LaunchGrantInput,
} from "@/lib/materialization";
import type { MigrationFileSystem } from "@/lib/migrations";
import { applyUpgrade, type HarnessRelease } from "@/lib/upgrade";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = new Date("2026-08-09T12:00:00.000Z");
const WORKFLOW_SHA = "a".repeat(40);
const COMMAND_TIMEOUT_MS = 120_000;

function launchGrantInput(): LaunchGrantInput {
  return {
    ownerOrganizationId: "founder-company",
    ventureName: "Payout Rank",
    ventureSlug: "payout-rank",
    ideaDigest: "b".repeat(64),
    seed: { id: "agentic-web-saas", version: "0.2.0" },
    stackProfile: { id: "founder-default", version: "0.2.0" },
    repository: { owner: "founder-company", name: "payout-rank", visibility: "private" },
    providerAccounts: [
      {
        capability: "source.repository.create",
        provider: "github",
        externalAccountId: "github-founder-company",
        ownerOrganizationId: "founder-company",
        stackClass: "company",
        ownership: "company_owned",
      },
    ],
    autonomyProfile: "owner_preview",
    allowedExternalEffects: ["repository.create"],
    modelBudget: { maxTokens: 25_000, maxMinorUnits: 0, currency: "EUR" },
    externalResourceBudget: { maxResources: 1, maxMinorUnits: 0, currency: "EUR" },
    permissions: {
      productionDeployment: false,
      domainConfiguration: false,
      liveCommerceConfiguration: false,
    },
    createdAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-10T12:00:00.000Z",
    grantedBy: { actorId: "founder-user", actorType: "founder" },
    approvalRef: "approval:web-build-fixture",
    revokedAt: null,
  };
}

function runPnpm(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = COMMAND_TIMEOUT_MS,
): string {
  const result = spawnSync("pnpm", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.error || result.status !== 0) {
    throw new Error(
      [`pnpm ${args.join(" ")} failed`, result.error?.message, output].filter(Boolean).join("\n"),
    );
  }
  return output;
}

function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  input?: string,
): string {
  const result = spawnSync("git", args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.error || result.status !== 0) {
    throw new Error(
      [`git ${args.join(" ")} failed`, result.error?.message, output].filter(Boolean).join("\n"),
    );
  }
  return result.stdout.trim();
}

async function writeFakeGithubCli(
  path: string,
  fixture: {
    repository: string;
    branch: string;
    commit: string;
    tree: string;
    remote: string;
    log: string;
  },
): Promise<void> {
  await writeFile(
    path,
    String.raw`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const fixture = ${JSON.stringify(fixture)};
const { repository, branch, commit, tree, remote, log } = fixture;

function fail(message) {
  process.stderr.write("fake gh rejected invocation: " + message + "\n");
  process.exit(64);
}

appendFileSync(log, JSON.stringify(args) + "\n", "utf8");

if (args[0] === "api") {
  if (args.length !== 2) fail("only exact read-only API calls are allowed");
  const path = args[1];
  if (path === "repos/" + repository) {
    process.stdout.write(JSON.stringify({
      full_name: repository,
      visibility: "private",
      archived: false,
      default_branch: branch,
    }));
    process.exit(0);
  }
  if (path === "repos/" + repository + "/git/ref/heads/" + encodeURIComponent(branch)) {
    process.stdout.write(JSON.stringify({ object: { sha: commit } }));
    process.exit(0);
  }
  if (path === "repos/" + repository + "/git/commits/" + commit) {
    process.stdout.write(JSON.stringify({ sha: commit, tree: { sha: tree } }));
    process.exit(0);
  }
  fail("unexpected API path " + path);
}

if (
  args.length === 9 &&
  args[0] === "repo" &&
  args[1] === "clone" &&
  args[2] === repository &&
  args[3] &&
  args[4] === "--" &&
  args[5] === "--no-checkout" &&
  args[6] === "--single-branch" &&
  args[7] === "--branch" &&
  args[8] === branch
) {
  const destination = args[3];
  const clone = spawnSync(
    "git",
    ["clone", "--no-checkout", "--single-branch", "--branch", branch, remote, destination],
    { encoding: "utf8", shell: false },
  );
  if (clone.error || clone.status !== 0) {
    fail("local metadata clone failed: " + (clone.error?.message || clone.stderr || clone.status));
  }
  const origin = spawnSync(
    "git",
    ["-C", destination, "remote", "set-url", "origin", "https://github.com/" + repository + ".git"],
    { encoding: "utf8", shell: false },
  );
  if (origin.error || origin.status !== 0) {
    fail("GitHub-shaped origin setup failed: " + (origin.error?.message || origin.stderr || origin.status));
  }
  process.exit(0);
}

fail("only exact API reads and the bounded metadata clone are allowed");
`,
    "utf8",
  );
  await chmod(path, 0o700);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function installedRootStore(): string {
  const modules = parse(
    readFileSync(resolve(REPOSITORY_ROOT, "node_modules/.modules.yaml"), "utf8"),
  ) as { storeDir?: unknown };
  if (typeof modules.storeDir !== "string" || modules.storeDir.length === 0) {
    throw new Error("Root frozen install did not record a pnpm content-addressable store");
  }
  return modules.storeDir;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

class DiskUpgradeFileSystem implements MigrationFileSystem {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #target(path: string): string {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`Unsafe upgrade path: ${path}`);
    }
    const target = resolve(this.#root, path);
    const child = relative(this.#root, target);
    if (!child || child === ".." || child.startsWith(`..${sep}`)) {
      throw new Error(`Upgrade path escapes child venture: ${path}`);
    }
    return target;
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(this.#target(path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    const target = this.#target(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.upgrade-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  }

  async remove(path: string): Promise<void> {
    await unlink(this.#target(path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function waitForResponse(url: string, serverOutput: () => string): Promise<Response> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Production server did not become ready: ${String(lastError)}\n${serverOutput()}`,
  );
}

describe("materialized standalone web venture", () => {
  it("executes the generated publisher and installs an exact clean local Git handoff", async () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "venture-harness-child-git-"));
    const childRoot = resolve(fixtureRoot, "child");
    const sourceGit = resolve(fixtureRoot, "source.git");
    const remoteGit = resolve(fixtureRoot, "remote.git");
    const fakeBin = resolve(fixtureRoot, "fake-bin");
    const fakeGh = resolve(fakeBin, "gh");
    const fakeGhLog = resolve(fixtureRoot, "fake-gh.jsonl");
    const repository = "founder-company/payout-rank";
    const branch = "main";

    try {
      await mkdir(childRoot, { recursive: true });
      const plan = compileVentureMaterialization({
        grant: createLaunchGrant(launchGrantInput()),
        at: NOW,
        coreVersion: "0.2.0",
        workflowRefSha: WORKFLOW_SHA,
        workflowRepository: "venture-harness/venture-harness",
      });
      const materialized = await materializeVenture(
        plan,
        new NodeMaterializationFileSystem(childRoot),
        NOW,
      );
      expect(materialized.status).toBe("materialized");

      await mkdir(resolve(childRoot, "reports/launch"), { recursive: true });
      await writeFile(
        resolve(childRoot, "reports/launch/private.json"),
        '{"fixture":"PRIVATE RUNTIME EVIDENCE"}\n',
        "utf8",
      );
      expect(existsSync(resolve(childRoot, ".venture/launch-grant.receipt.json"))).toBe(true);

      const childEnv = {
        ...process.env,
        CI: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PUBLIC_INDEXING_ENABLED: "false",
      };
      runPnpm(
        [
          "install",
          "--frozen-lockfile",
          "--ignore-workspace",
          "--offline",
          "--store-dir",
          installedRootStore(),
        ],
        childRoot,
        childEnv,
      );

      runGit(["init", "--bare", "--object-format=sha1", sourceGit], fixtureRoot);
      const snapshotEnv = {
        ...childEnv,
        GIT_DIR: sourceGit,
        GIT_WORK_TREE: childRoot,
        GIT_AUTHOR_NAME: "Venture Harness Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: "2026-08-09T12:00:00Z",
        GIT_COMMITTER_NAME: "Venture Harness Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_DATE: "2026-08-09T12:00:00Z",
      };
      runGit(["add", "-A", "--", "."], childRoot, snapshotEnv);
      const tree = runGit(["write-tree"], childRoot, snapshotEnv);
      const commit = runGit(
        ["commit-tree", tree, "-m", "fixture: exact published child source"],
        childRoot,
        snapshotEnv,
      );
      runGit(["update-ref", `refs/heads/${branch}`, commit], childRoot, snapshotEnv);
      runGit(["init", "--bare", "--object-format=sha1", remoteGit], fixtureRoot);
      runGit(
        ["--git-dir", sourceGit, "push", remoteGit, `refs/heads/${branch}:refs/heads/${branch}`],
        fixtureRoot,
      );
      runGit(["--git-dir", remoteGit, "symbolic-ref", "HEAD", `refs/heads/${branch}`], fixtureRoot);

      await mkdir(fakeBin, { recursive: true });
      await writeFakeGithubCli(fakeGh, {
        repository,
        branch,
        commit,
        tree,
        remote: remoteGit,
        log: fakeGhLog,
      });
      const publisher = spawnSync(
        "node",
        [
          "--import",
          "tsx",
          "scripts/github-publish-source.ts",
          "verify",
          "--repository",
          repository,
          "--visibility",
          "private",
          "--branch",
          branch,
          "--commit",
          commit,
          "--tree",
          tree,
        ],
        {
          cwd: childRoot,
          env: {
            ...childEnv,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          },
          encoding: "utf8",
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const publisherOutput = [publisher.stdout, publisher.stderr].filter(Boolean).join("\n");
      expect(publisher.error, publisherOutput).toBeUndefined();
      expect(publisher.status, publisherOutput).toBe(0);
      expect(publisher.stderr).toBe("");
      expect(JSON.parse(publisher.stdout)).toMatchObject({
        repository,
        visibility: "private",
        branch,
        commitOid: commit,
        treeOid: tree,
        verified: true,
        workingRepository: {
          originUrl: `https://github.com/${repository}.git`,
          branch,
          head: commit,
          clean: true,
        },
      });

      expect(lstatSync(resolve(childRoot, ".git")).isDirectory()).toBe(true);
      expect(runGit(["remote", "get-url", "origin"], childRoot)).toBe(
        `https://github.com/${repository}.git`,
      );
      expect(runGit(["symbolic-ref", "--short", "HEAD"], childRoot)).toBe(branch);
      expect(runGit(["rev-parse", "HEAD"], childRoot)).toBe(commit);
      expect(runGit(["rev-parse", `refs/remotes/origin/${branch}`], childRoot)).toBe(commit);
      expect(
        runGit(["--git-dir", remoteGit, "rev-parse", `refs/heads/${branch}`], fixtureRoot),
      ).toBe(commit);
      expect(runGit(["status", "--porcelain=v1", "--untracked-files=all"], childRoot)).toBe("");
      expect(runGit(["ls-files", "--", ".venture", "reports"], childRoot)).toBe("");
      expect(
        runGit(
          [
            "check-ignore",
            "--",
            ".venture/launch-grant.receipt.json",
            "reports/launch/private.json",
          ],
          childRoot,
        ).split("\n"),
      ).toEqual([".venture/launch-grant.receipt.json", "reports/launch/private.json"]);

      const canonicalChildRoot = realpathSync(childRoot);
      const lockPath = join(
        dirname(canonicalChildRoot),
        `.git-install-${createHash("sha256").update(canonicalChildRoot).digest("hex").slice(0, 16)}.lock`,
      );
      expect(existsSync(lockPath)).toBe(false);
      const fakeGhCalls = readFileSync(fakeGhLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(fakeGhCalls.slice(0, 3)).toEqual([
        ["api", `repos/${repository}`],
        ["api", `repos/${repository}/git/ref/heads/${branch}`],
        ["api", `repos/${repository}/git/commits/${commit}`],
      ]);
      expect(fakeGhCalls[3]).toEqual([
        "repo",
        "clone",
        repository,
        expect.stringMatching(/\/clone$/u),
        "--",
        "--no-checkout",
        "--single-branch",
        "--branch",
        branch,
      ]);
      expect(fakeGhCalls).toHaveLength(4);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("installs and builds offline, serves launch surfaces, and preserves venture-owned design on upgrade", async () => {
    const childRoot = mkdtempSync(resolve(tmpdir(), "venture-harness-web-build-"));
    let productionServer: ReturnType<typeof spawn> | null = null;
    let productionOutput = "";

    try {
      const plan = compileVentureMaterialization({
        grant: createLaunchGrant(launchGrantInput()),
        at: NOW,
        coreVersion: "0.2.0",
        workflowRefSha: WORKFLOW_SHA,
        workflowRepository: "venture-harness/venture-harness",
      });
      const materialized = await materializeVenture(
        plan,
        new NodeMaterializationFileSystem(childRoot),
        NOW,
      );
      expect(materialized.status).toBe("materialized");

      const manifest = JSON.parse(
        readFileSync(resolve(childRoot, "venture.manifest.json"), "utf8"),
      );
      const packageJson = JSON.parse(readFileSync(resolve(childRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const generatedText = plan.files.map((file) => file.content).join("\n");
      expect(
        Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }),
      ).not.toEqual(expect.arrayContaining([expect.stringMatching(/^@venture-harness(?:\/|$)/)]));
      expect(generatedText).not.toContain("@venture-harness/");
      expect(generatedText).not.toContain("ServiceBlueprint");
      expect(manifest).not.toHaveProperty("serviceBlueprints");
      expect(manifest).not.toHaveProperty("agentSurface");
      expect(existsSync(resolve(childRoot, "runtime/bootstrap.ts"))).toBe(false);
      expect(existsSync(resolve(childRoot, "service-blueprints"))).toBe(false);
      expect(packageJson.scripts).toMatchObject({
        test: "node --test tests/*.test.mjs",
        "verify:fast": "pnpm typecheck && pnpm test",
        "verify:mvp":
          "pnpm verify:fast && pnpm build && pnpm test:e2e:readonly && pnpm test:e2e:primary-journey",
        "test:e2e:readonly":
          "tsx scripts/run-local-browser-check.ts tests/e2e/post-deploy-readonly.spec.ts",
        "test:e2e:primary-journey":
          "tsx scripts/run-local-browser-check.ts tests/e2e/primary-journey.spec.ts",
      });

      const storeDirectory = installedRootStore();
      const port = await reservePort();
      const childEnv = {
        ...process.env,
        CI: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PUBLIC_INDEXING_ENABLED: "false",
        NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
      };
      runPnpm(
        [
          "install",
          "--frozen-lockfile",
          "--ignore-workspace",
          "--offline",
          "--store-dir",
          storeDirectory,
        ],
        childRoot,
        childEnv,
      );
      expect(sha256(resolve(childRoot, "pnpm-lock.yaml"))).toBe(
        plan.files.find(({ path }) => path === "pnpm-lock.yaml")?.sha256,
      );
      expect(readFileSync(resolve(childRoot, "pnpm-lock.yaml"), "utf8")).not.toContain(
        "@venture-harness/",
      );
      const publisherCheck = spawnSync(
        "node",
        ["--import", "tsx", "scripts/github-publish-source.ts"],
        { cwd: childRoot, env: childEnv, encoding: "utf8" },
      );
      expect(publisherCheck.status).toBe(1);
      expect(publisherCheck.stdout).toBe("");
      expect(publisherCheck.stderr).toContain(
        "Expected apply or verify; no provider operation was attempted",
      );
      runPnpm(["verify:fast"], childRoot, childEnv);
      runPnpm(["build"], childRoot, childEnv);
      expect(existsSync(resolve(childRoot, ".next/standalone/server.js"))).toBe(true);
      const playwrightList = runPnpm(
        ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--list"],
        childRoot,
        { ...childEnv, PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}` },
      );
      expect(playwrightList).toContain("post-deploy-readonly.spec.ts");

      productionServer = spawn(
        "pnpm",
        ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
        { cwd: childRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      productionServer.stdout?.setEncoding("utf8");
      productionServer.stderr?.setEncoding("utf8");
      productionServer.stdout?.on("data", (chunk: string) => {
        productionOutput += chunk;
      });
      productionServer.stderr?.on("data", (chunk: string) => {
        productionOutput += chunk;
      });

      const origin = `http://127.0.0.1:${port}`;
      const health = await waitForResponse(`${origin}/api/health`, () => productionOutput);
      expect(await health.json()).toEqual({
        status: "ok",
        venture: "payout-rank",
        evidence: "local_build_shape",
      });
      const primary = await fetch(`${origin}/`);
      expect(primary.status).toBe(200);
      expect(await primary.text()).toContain("Payout Rank");
      const status = await fetch(`${origin}/status`);
      expect(status.status).toBe(200);
      const statusHtml = await status.text();
      expect(statusHtml).toContain("Payout Rank is not launched yet.");
      expect(statusHtml).toMatch(/name="robots" content="noindex, nofollow"/u);
      const robots = await fetch(`${origin}/robots.txt`);
      expect(robots.status).toBe(200);
      expect(await robots.text()).toContain("Disallow: /");
      const sitemap = await fetch(`${origin}/sitemap.xml`);
      expect(sitemap.status).toBe(200);
      const sitemapText = await sitemap.text();
      expect(sitemapText).not.toContain("<loc>");
      expect(sitemapText).not.toContain("/status");

      productionServer.kill("SIGTERM");
      await once(productionServer, "exit");
      productionServer = null;

      const localServerNonce = "materialized-child-owner-check";
      productionOutput = "";
      productionServer = spawn(
        "pnpm",
        ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
        {
          cwd: childRoot,
          env: { ...childEnv, VH_LOCAL_SERVER_NONCE: localServerNonce },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      productionServer.stdout?.setEncoding("utf8");
      productionServer.stderr?.setEncoding("utf8");
      productionServer.stdout?.on("data", (chunk: string) => {
        productionOutput += chunk;
      });
      productionServer.stderr?.on("data", (chunk: string) => {
        productionOutput += chunk;
      });
      const ownedHealth = await waitForResponse(`${origin}/api/health`, () => productionOutput);
      expect(await ownedHealth.json()).toEqual({
        status: "ok",
        venture: "payout-rank",
        evidence: "local_build_shape",
        localServerNonce,
      });
      productionServer.kill("SIGTERM");
      await once(productionServer, "exit");
      productionServer = null;

      const protectedPaths = [
        "app/page.tsx",
        "src/product/identity.json",
        "src/design/theme.css",
      ] as const;
      const protectedPathSet = new Set<string>(protectedPaths);
      const originalHashes = Object.fromEntries(
        protectedPaths.map((path) => [path, sha256(resolve(childRoot, path))]),
      );
      const currentLock = parseHarnessLock(
        readFileSync(resolve(childRoot, "harness.lock"), "utf8"),
      );
      const release: HarnessRelease = {
        version: "0.2.1",
        configContractVersion: 2,
        source: { kind: "release", ref: "fixture:web-seed-0.2.1" },
        files: [
          ...protectedPaths.map((path) => ({
            path,
            ownership: "venture_owned" as const,
            content: `incoming Core replacement for ${path}\n`,
          })),
          {
            path: "runtime/core-upgrade-marker.txt",
            ownership: "core_owned",
            content: "Core 0.2.1 applied\n",
          },
        ],
      };
      const upgradeFileSystem = new DiskUpgradeFileSystem(childRoot);
      const dryRun = await applyUpgrade({
        fileSystem: upgradeFileSystem,
        currentLock,
        release,
        dryRun: true,
      });
      expect(dryRun.status).toBe("planned");
      expect(dryRun.files.filter(({ path }) => protectedPathSet.has(path))).toEqual(
        expect.arrayContaining(
          protectedPaths.map((path) => expect.objectContaining({ path, action: "preserve" })),
        ),
      );
      expect(existsSync(resolve(childRoot, "runtime/core-upgrade-marker.txt"))).toBe(false);
      expect(
        Object.fromEntries(protectedPaths.map((path) => [path, sha256(resolve(childRoot, path))])),
      ).toEqual(originalHashes);

      const applied = await applyUpgrade({
        fileSystem: upgradeFileSystem,
        currentLock,
        release,
      });
      expect(applied.status).toBe("applied");
      expect(readFileSync(resolve(childRoot, "runtime/core-upgrade-marker.txt"), "utf8")).toBe(
        "Core 0.2.1 applied\n",
      );
      expect(
        Object.fromEntries(protectedPaths.map((path) => [path, sha256(resolve(childRoot, path))])),
      ).toEqual(originalHashes);
      const upgradedLock = parseHarnessLock(
        readFileSync(resolve(childRoot, "harness.lock"), "utf8"),
      );
      expect(upgradedLock.harness_version).toBe("0.2.1");
      expect(upgradedLock.lock_version === 2 ? upgradedLock.core_version : null).toBe("0.2.1");
      expect(
        upgradedLock.managed_files
          .filter(({ path }) => protectedPathSet.has(path))
          .map(({ path, ownership, sha256: hash }) => ({ path, ownership, hash })),
      ).toEqual(
        expect.arrayContaining(
          protectedPaths.map((path) => ({
            path,
            ownership: "venture_owned",
            hash: originalHashes[path],
          })),
        ),
      );
    } finally {
      if (productionServer && productionServer.exitCode === null) {
        productionServer.kill("SIGTERM");
        await once(productionServer, "exit");
      }
      rmSync(childRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
