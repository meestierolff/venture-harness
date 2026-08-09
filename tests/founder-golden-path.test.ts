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
  it("runs the canonical root CLI from idea through verified launch, resume, and Core upgrade", async () => {
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
        firstApply: "waiting_external_action",
        manualDns: "verified_fixture",
        resume: "succeeded",
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
    expect(result.proof.productTasks).toEqual([
      "prepare-repository",
      "design-direction",
      "build-core-journey",
      "configure-event-pack",
    ]);
    expect(result.proof.productCommands).toEqual(
      expect.arrayContaining([
        [...CHILD_DEPENDENCY_INSTALL_ARGS],
        ["verify:fast"],
        ["verify:mvp"],
        ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts"],
      ]),
    );
    expect(new Set(result.proof.providerPlans.map(({ provider }) => provider))).toEqual(
      new Set(["github", "neon", "stripe", "brevo", "google", "bing", "vercel"]),
    );
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
  }, 120_000);
});
