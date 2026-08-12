import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
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
          "--ignore-scripts",
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
      expect(await status.text()).toContain("Payout Rank is not launched yet.");
      const robots = await fetch(`${origin}/robots.txt`);
      expect(robots.status).toBe(200);
      expect(await robots.text()).toContain("Disallow: /");
      const sitemap = await fetch(`${origin}/sitemap.xml`);
      expect(sitemap.status).toBe(200);
      const sitemapText = await sitemap.text();
      expect(sitemapText).toContain(`<loc>${origin}/</loc>`);
      expect(sitemapText).toContain(`<loc>${origin}/status</loc>`);

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
