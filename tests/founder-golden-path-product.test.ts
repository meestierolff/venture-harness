import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { founderBriefSchema } from "@/lib/launch";
import {
  compileVentureMaterialization,
  createLaunchGrant,
  materializeVenture,
  NodeMaterializationFileSystem,
} from "@/lib/materialization";
import { CHILD_DEPENDENCY_INSTALL_ARGS, createLaunchProductBindings } from "@/lib/runtime";
import { workflowNode, type WorkflowHandlerContext } from "@/lib/workflow";
import {
  FounderGoldenPathBuildAgentFixture,
  FounderGoldenPathProductCommandFixture,
} from "./fixtures/founder-golden-path-product";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-08-09T12:00:00.000Z");

function temporaryDirectory(label: string): string {
  const path = mkdtempSync(join(tmpdir(), label));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("founder Golden Path product fixture", () => {
  it("builds and directly tests the fixture-labeled primary journey in an ordinary child", async () => {
    const childRoot = temporaryDirectory("vh-founder-product-child-");
    const grant = createLaunchGrant({
      ownerOrganizationId: "fixture-founder-org",
      ventureName: "Exception Desk",
      ventureSlug: "exception-desk",
      ideaDigest: "b".repeat(64),
      seed: { id: "agentic-web-saas", version: "0.2.0" },
      stackProfile: { id: "founder-default", version: "0.2.0" },
      repository: {
        owner: "fixture-founder-org",
        name: "exception-desk",
        visibility: "private",
      },
      providerAccounts: [
        {
          capability: "source.repository.create",
          provider: "github",
          externalAccountId: "fixture-github-org",
          ownerOrganizationId: "fixture-founder-org",
          stackClass: "company",
          ownership: "company_owned",
        },
      ],
      autonomyProfile: "owner_live_launch",
      allowedExternalEffects: ["repository.create", "source.push"],
      modelBudget: { maxTokens: 100_000, maxMinorUnits: 0, currency: "EUR" },
      externalResourceBudget: { maxResources: 2, maxMinorUnits: 0, currency: "EUR" },
      permissions: {
        productionDeployment: true,
        domainConfiguration: false,
        liveCommerceConfiguration: false,
      },
      createdAt: NOW.toISOString(),
      expiresAt: "2026-08-10T12:00:00.000Z",
      grantedBy: { actorId: "fixture-founder", actorType: "founder" },
      approvalRef: "fixture:founder-product-test",
      revokedAt: null,
    });
    const plan = compileVentureMaterialization({
      grant,
      at: NOW,
      coreVersion: "0.2.0",
      workflowRefSha: "a".repeat(40),
      workflowRepository: "venture-harness/venture-harness",
    });
    await materializeVenture(plan, new NodeMaterializationFileSystem(childRoot), NOW);

    const commands = new FounderGoldenPathProductCommandFixture(childRoot);
    const host = new FounderGoldenPathBuildAgentFixture(childRoot);
    const installBindings = createLaunchProductBindings({
      rootDir: childRoot,
      brief: founderBriefSchema.parse(parse(readFileSync("fixtures/web-saas/brief.yaml", "utf8"))),
      agentHost: host,
      commandRunner: commands,
      now: () => NOW,
    });
    const installContext: WorkflowHandlerContext = {
      runId: "fixture-founder-install",
      node: workflowNode("install-dependencies", {
        handler: "launch.installDependencies",
        effect: "local_write",
        evidence: { required: true, artifact: "reports/quality/dependency-install.json" },
      }),
      attempt: 1,
      dependencyOutputs: {},
      idempotencyKey: "fixture-founder-install:dependencies",
      signal: new AbortController().signal,
      trace: () => undefined,
    };
    const installed = await installBindings.handlers!["launch.installDependencies"](installContext);
    expect(installed).toMatchObject({
      effectVerified: true,
      output: {
        command: ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
        installedModulesReadBack: true,
      },
    });
    expect(
      JSON.parse(
        readFileSync(
          join(
            childRoot,
            "reports/launch/fixture-founder-install/product/install-dependencies.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      command: ["pnpm", ...CHILD_DEPENDENCY_INSTALL_ARGS],
      frozenLockfile: true,
      lifecycleScriptsDisabled: true,
      installedModulesReadBack: true,
    });

    for (const nodeId of ["prepare-repository", "review-product"]) {
      const response = await host.run({
        runId: "fixture-founder-run",
        nodeId,
        purpose: `Fixture task ${nodeId}`,
        instructions: "Execute the bounded local fixture task.",
        context: {},
      });
      expect(response).toMatchObject({
        status: "completed",
        completion: {
          outcome: nodeId === "prepare-repository" ? "changed" : "already_compliant",
        },
      });
      expect(response.checks).toEqual([
        expect.objectContaining({ status: "passed", evidence: expect.stringContaining("pass") }),
      ]);
    }

    expect(host.invocations).toEqual(["prepare-repository", "review-product"]);
    expect(readFileSync(join(childRoot, "app/page.tsx"), "utf8")).toContain("ExceptionDeskClient");
    expect(readFileSync(join(childRoot, "src/product/founder-contract.json"), "utf8")).toContain(
      '"fixture": true',
    );
    expect(existsSync(join(childRoot, "runtime/bootstrap.ts"))).toBe(false);
    expect(JSON.parse(readFileSync(join(childRoot, "package.json"), "utf8"))).not.toHaveProperty(
      "dependencies.@venture-harness/core",
    );

    const local = await commands.run({ command: "pnpm", args: ["verify:fast"], cwd: childRoot });
    const build = await commands.run({ command: "pnpm", args: ["build"], cwd: childRoot });
    const deployed = await commands.run({
      command: "pnpm",
      args: ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--retries=0"],
      cwd: childRoot,
      env: {
        PLAYWRIGHT_BASE_URL: "https://exception-desk-abc.fixture.vercel.app",
      },
    });
    expect(local.exitCode, `${local.stdout}\n${local.stderr}`).toBe(0);
    expect(build.exitCode, `${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync(join(childRoot, "node_modules/next"))).toBe(true);
    expect(existsSync(join(childRoot, ".next/standalone/server.js"))).toBe(true);
    expect(deployed.stdout).toContain("local_product_command_boundary");
    expect(commands.invocations).toEqual([
      expect.objectContaining({ args: [...CHILD_DEPENDENCY_INSTALL_ARGS], deploymentUrl: null }),
      expect.objectContaining({ args: ["verify:fast"], deploymentUrl: null }),
      expect.objectContaining({ args: ["build"], deploymentUrl: null }),
      expect.objectContaining({
        args: [
          "exec",
          "playwright",
          "test",
          "tests/e2e/post-deploy-readonly.spec.ts",
          "--retries=0",
        ],
        deploymentUrl: "https://exception-desk-abc.fixture.vercel.app",
      }),
    ]);

    const replay = await host.run({
      runId: "fixture-founder-run-replay",
      nodeId: "prepare-repository",
      purpose: "Fixture replay",
      instructions: "Verify without rewriting.",
      context: {},
    });
    expect(replay).toMatchObject({
      changedFiles: [],
      completion: { outcome: "already_compliant" },
    });
  }, 120_000);
});
