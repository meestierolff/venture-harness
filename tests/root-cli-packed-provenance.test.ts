import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseHarnessLock } from "@/lib/config/harness-lock";
import {
  NodeMaterializationFileSystem,
  compileVentureMaterialization,
  createLaunchGrant,
  materializeVenture,
} from "@/lib/materialization";
import {
  VH_BUILD_PROVENANCE_PATH,
  buildVhExecutable,
  createVhBuildProvenance,
  loadVhBuildProvenance,
  writeVhBuildProvenance,
} from "../scripts/build-vh-executable.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryProvenancePath = resolve(repositoryRoot, VH_BUILD_PROVENANCE_PATH);
const currentCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const coreCommit = existsSync(repositoryProvenancePath)
  ? loadVhBuildProvenance(repositoryProvenancePath).coreSourceCommit
  : currentCommit;
const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("packed root vh provenance", () => {
  it("materializes harness.lock from the embedded Core build commit outside the caller Git repository", async () => {
    const staging = temporaryRoot("vh-packed-provenance-package-");
    const packDirectory = temporaryRoot("vh-packed-provenance-tarball-");
    const consumer = temporaryRoot("vh-packed-provenance-consumer-");
    const installed = resolve(consumer, "node_modules/venture-harness");
    const executable = resolve(staging, "bin/vh.mjs");
    mkdirSync(dirname(executable), { recursive: true });
    const provenance = await buildVhExecutable({
      rootDirectory: repositoryRoot,
      outfile: executable,
      sourceCommit: coreCommit,
    });
    expect(provenance).toMatchObject({
      packageVersion: "0.2.0",
      workflowRefSha: coreCommit,
    });
    writeVhBuildProvenance(
      resolve(staging, VH_BUILD_PROVENANCE_PATH),
      createVhBuildProvenance({
        executable,
        packageVersion: provenance.packageVersion,
        sourceCommit: provenance.workflowRefSha,
      }),
    );

    writeFileSync(
      resolve(staging, "package.json"),
      `${JSON.stringify(
        {
          name: "venture-harness",
          version: provenance.packageVersion,
          type: "module",
          bin: { vh: "bin/vh.mjs" },
          files: ["bin/vh.mjs", VH_BUILD_PROVENANCE_PATH],
          dependencies: { yaml: "^2.7.0" },
        },
        null,
        2,
      )}\n`,
    );
    execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], {
      cwd: staging,
      stdio: "pipe",
    });
    const tarball = readdirSync(packDirectory).find((name) => name.endsWith(".tgz"));
    expect(tarball).toBeDefined();
    mkdirSync(installed, { recursive: true });
    execFileSync(
      "tar",
      ["-xzf", resolve(packDirectory, tarball!), "-C", installed, "--strip-components=1"],
      { stdio: "pipe" },
    );
    symlinkSync(
      realpathSync(resolve(repositoryRoot, "node_modules/yaml")),
      resolve(consumer, "node_modules/yaml"),
    );

    execFileSync("git", ["init", "--quiet"], { cwd: consumer });
    execFileSync("git", ["config", "user.email", "packed-provenance@example.invalid"], {
      cwd: consumer,
    });
    execFileSync("git", ["config", "user.name", "Packed Provenance Fixture"], {
      cwd: consumer,
    });
    writeFileSync(resolve(consumer, "caller.txt"), "unrelated caller repository\n");
    execFileSync("git", ["add", "caller.txt"], { cwd: consumer });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "decoy"], {
      cwd: consumer,
    });
    const callerCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: consumer,
      encoding: "utf8",
    }).trim();
    expect(callerCommit).not.toBe(coreCommit);

    const installedExecutable = resolve(installed, "bin/vh.mjs");
    expect(loadVhBuildProvenance(resolve(installed, VH_BUILD_PROVENANCE_PATH))).toMatchObject({
      packageVersion: "0.2.0",
      coreSourceCommit: coreCommit,
    });
    const help = spawnSync(process.execPath, [installedExecutable, "--help"], {
      cwd: consumer,
      encoding: "utf8",
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("Venture Harness CLI");

    const packed = (await import(
      `${pathToFileURL(installedExecutable).href}?test=${Date.now()}`
    )) as typeof import("../scripts/vh-bundle");
    expect(packed.founderCoreBuildProvenance()).toEqual({
      packageName: "venture-harness",
      packageVersion: "0.2.0",
      workflowRefSha: coreCommit,
    });

    writeFileSync(resolve(consumer, "idea.md"), "# Packed provenance fixture\n");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const childRoot = resolve(consumer, "packed-provenance");
    const previousDirectory = process.cwd();
    try {
      process.chdir(consumer);
      const exitCode = await packed.runVhShell(
        [
          "launch",
          "--idea",
          "./idea.md",
          "--stack",
          "founder-default",
          "--production",
          "--apply",
          "--non-interactive",
          "--output",
          "packed-provenance",
          "--json",
        ],
        {
          io: {
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line),
          },
          founderServicesFactory: (options) => ({
            founderLaunch: async (request) => {
              expect(request.output).toBe("packed-provenance");
              expect(options.founderWorkflowRefSha).toBe(coreCommit);
              const at = new Date("2026-08-09T12:00:00.000Z");
              const grant = createLaunchGrant({
                ownerOrganizationId: "packed-founder",
                ventureName: "Packed Provenance",
                ventureSlug: "packed-provenance",
                ideaDigest: "a".repeat(64),
                seed: { id: "agentic-web-saas", version: "0.2.0" },
                stackProfile: { id: "founder-default", version: "0.2.0" },
                repository: {
                  owner: "packed-founder",
                  name: "packed-provenance",
                  visibility: "private",
                },
                providerAccounts: [],
                autonomyProfile: "owner_live_launch",
                allowedExternalEffects: ["repository.create"],
                modelBudget: { maxTokens: 1, maxMinorUnits: 0, currency: "EUR" },
                externalResourceBudget: {
                  maxResources: 1,
                  maxMinorUnits: 0,
                  currency: "EUR",
                },
                permissions: {
                  productionDeployment: false,
                  domainConfiguration: false,
                  liveCommerceConfiguration: false,
                },
                createdAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2027-01-01T00:00:00.000Z",
                grantedBy: { actorId: "packed-founder", actorType: "founder" },
                approvalRef: "fixture:packed-provenance",
                revokedAt: null,
              });
              const plan = compileVentureMaterialization({
                grant,
                at,
                coreVersion: provenance.packageVersion,
                workflowRefSha: options.founderWorkflowRefSha!,
                effects: [],
              });
              await materializeVenture(plan, new NodeMaterializationFileSystem(childRoot), at);
              return { status: "succeeded", childRoot };
            },
          }),
        },
      );
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(previousDirectory);
    }

    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ status: "succeeded", childRoot });
    const lock = parseHarnessLock(readFileSync(resolve(childRoot, "harness.lock"), "utf8"));
    expect(lock.lock_version).toBe(2);
    if (lock.lock_version !== 2) throw new Error("expected a v2 child harness.lock");
    expect(lock.workflow_ref_sha).toBe(coreCommit);
    expect(lock.workflow_ref_sha).not.toBe(callerCommit);
  }, 30_000);
});
