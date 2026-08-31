import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSyntheticFounderGoldenPath } from "./fixtures/synthetic-founder-golden-path";
import { CHILD_DEPENDENCY_INSTALL_ARGS } from "@/lib/runtime";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic founder Golden Path", () => {
  it("runs the canonical root CLI from idea through provider-URL launch, replay, and Core upgrade", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "vh-founder-golden-path-"));
    temporaryDirectories.push(rootDir);
    const result = await runSyntheticFounderGoldenPath({ rootDir });

    expect(result).toMatchObject({
      status: "verified_fixture",
      fixtureLabel: "synthetic-founder-golden-path",
      workflowStatus: "succeeded",
      lifecycle: {
        stackDoctor: "ready",
        ideaCompile: "ready",
        launchGrant: "issued_for_apply",
        firstApply: "succeeded",
        customDomain: "deferred_nonblocking",
        replay: "idempotent",
        coreUpgrade: "0.2.0_to_0.2.1",
      },
      proof: {
        officialTransports: {
          cli: "CommandProviderTransport",
          http: "HttpProviderTransport",
        },
        migration: { command: "psql", cwd: result.childRoot, readBack: true },
        primaryJourney: {
          signal: "invoice_draft_confirmed",
          directTests: "passed",
        },
        upgrade: { dryRun: "planned", apply: "applied" },
        secretsPersisted: false,
      },
    });
    expect(result.proof.rootCliArgv).toContainEqual([
      "launch",
      "--idea",
      "./idea.md",
      "--stack",
      "founder-default",
      "--production",
      "--apply",
      "--non-interactive",
      "--output",
      "ventures/exception-desk",
      "--json",
    ]);
    expect(result.proof.productTasks).toEqual(["prepare-repository", "review-product"]);
    expect(result.proof.productCommands).toEqual(
      expect.arrayContaining([
        [...CHILD_DEPENDENCY_INSTALL_ARGS],
        ["typecheck"],
        ["build"],
        ["test:e2e:readonly"],
        ["test"],
        ["verify:fast"],
        ["verify:mvp"],
        ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--retries=0"],
        [
          "exec",
          "playwright",
          "test",
          "tests/e2e/primary-journey.spec.ts",
          "--retries=0",
          "--trace=on",
        ],
      ]),
    );
    expect(new Set(result.proof.providerPlans.map(({ provider }) => provider))).toEqual(
      new Set(["github", "neon", "stripe", "vercel"]),
    );
    expect(result.proof.deployment.customDomain).toBeNull();
    expect(result.proof.deployment.environmentVariables).toHaveLength(5);
    expect(result.proof.upgrade.preservedPaths).toEqual(
      expect.arrayContaining([
        "app/page.tsx",
        "app/exception-desk-client.tsx",
        "src/product/exception-desk.mjs",
        "src/analytics/exception-desk-events.mjs",
      ]),
    );
    const report = JSON.parse(readFileSync(result.launchReport.json, "utf8")) as {
      overallState: string;
      brief: { synthetic: boolean };
      limitations: string[];
      remainingManualActions: unknown[];
    };
    expect(report).toMatchObject({
      overallState: "succeeded",
      brief: { synthetic: true },
      remainingManualActions: [],
    });
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Synthetic fixture"),
        expect.stringContaining("ongoing provider account-plan usage is not covered"),
        expect.stringContaining("no model was invoked"),
      ]),
    );
    expect(readFileSync(result.launchReport.markdown, "utf8")).toContain(
      "reviewed direct-operation ceiling 0 EUR; ongoing account-plan usage excluded",
    );
    const persistedLaunch = JSON.parse(
      readFileSync(join(result.childRoot, `.venture/launches/${result.runId}.json`), "utf8"),
    ) as {
      authorization: {
        profile: string;
        live_products_and_prices_allowed: boolean;
        actual_charges_allowed: boolean;
      };
    };
    expect(persistedLaunch.authorization).toMatchObject({
      profile: "live_commerce_launch",
      live_products_and_prices_allowed: false,
      actual_charges_allowed: false,
    });
  }, 120_000);

  it("persists a GitHub auth wait and resumes idempotently through the exact same founder command", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "vh-founder-auth-resume-"));
    temporaryDirectories.push(rootDir);
    const result = await runSyntheticFounderGoldenPath({
      rootDir,
      githubAuthWaitResume: true,
    });

    expect(result.lifecycle).toMatchObject({
      launchGrant: "issued_for_apply",
      firstApply: "waiting_for_auth",
      authResume: "same_command_succeeded",
      replay: "idempotent",
    });
    expect(result.proof.blockingResume).toEqual({
      waitingNode: "github-repository",
      sameChildIdentity: true,
      materializationUnchanged: true,
      sameRunId: true,
      sameLaunchGrant: true,
      completedProviderOperationsPreserved: true,
      buildCallsPreserved: true,
      replayZeroEffect: true,
    });
    const exactApply = [
      "launch",
      "--idea",
      "./idea.md",
      "--stack",
      "founder-default",
      "--production",
      "--apply",
      "--non-interactive",
      "--output",
      "ventures/exception-desk",
      "--json",
    ];
    expect(
      result.proof.rootCliArgv.filter(
        (argv) => JSON.stringify(argv) === JSON.stringify(exactApply),
      ),
    ).toHaveLength(3);
  }, 120_000);
});
