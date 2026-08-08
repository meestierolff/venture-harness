import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Redactor } from "@/lib/credentials";
import {
  createLaunchReportInputFromRun,
  createLaunchReportWorkflowBinding,
  renderLaunchReport,
  type LaunchReportInput,
} from "@/lib/runtime";
import {
  FileWorkflowStore,
  WorkflowExecutor,
  defineWorkflow,
  workflowNode,
  type WorkflowHandlerContext,
} from "@/lib/workflow";

function reportInput(secret: string): LaunchReportInput {
  return {
    generatedAt: "2026-08-04T12:00:00.000Z",
    run: { id: "launch-synthetic-web", status: "waiting" },
    brief: { id: "synthetic-web", name: "Fixture Venture", synthetic: true },
    launch: {
      mode: "thin_mvp",
      rail: "web",
      paymentProvider: "stripe",
      entitlementSource: "stripe",
      activeEventPacks: ["core_product", "subscription", "reliability"],
      consentMode: "strict",
    },
    authorization: {
      profile: "standard_launch",
      approvalRef: "test:launch",
      expiresAt: "2026-08-04T13:00:00.000Z",
      spendCeiling: { amount: 0, currency: "EUR" },
    },
    nodes: [
      {
        id: "github-repository",
        capability: "github_repository",
        state: "succeeded",
        provider: "github",
        evidenceRef: "reports/launch/provider-github.json",
        effectVerified: true,
      },
      {
        id: "dns-records",
        capability: "dns",
        state: "waiting_for_manual_action",
        provider: "mijndomein",
        effectVerified: false,
      },
      {
        id: "resolved-action",
        capability: "test",
        state: "succeeded",
        effectVerified: true,
      },
    ],
    providers: [
      {
        provider: "github",
        capability: "repository",
        lifecycleState: "verified",
        environment: "preview",
        accountId: "fixture-account",
        teamId: "fixture-team",
        region: "eu-west",
        resourceRefs: ["example/fixture"],
        evidenceRef: `https://evidence.test/repo?token=${secret}`,
        verified: true,
      },
    ],
    manualActions: [
      {
        nodeId: "dns-records",
        resolved: false,
        action: `Add fields supplied by owner@example.test; never include ${secret}`,
        requiredFields: ["record type", "name", "value"],
        risk: "medium",
        evidenceNeeded: ["propagated DNS read-back"],
        resumeCommand: "vh resume launch-synthetic-web --node dns-records",
      },
      {
        nodeId: "resolved-action",
        resolved: true,
        action: "Already completed",
        requiredFields: [],
        risk: "low",
        evidenceNeeded: [],
        resumeCommand: "vh resume launch-synthetic-web",
      },
    ],
    credentialReferences: [
      {
        ref: "cred://github/primary",
        provider: "github",
        status: "available",
        scopes: ["repo"],
      },
    ],
    limitations: ["DNS propagation remains unverified"],
    nextCommands: ["vh status launch-synthetic-web", "vh resume launch-synthetic-web"],
    sections: {
      whatBuilt: ["Synthetic web fixture core journey"],
      repository: ["Private repository metadata read back"],
      deploymentsAndBuilds: ["Production deployment not attempted"],
      commerce: ["No commerce capability selected"],
      email: ["No email capability selected"],
      analyticsAndSearch: ["Minimum event pack configured locally"],
      asoAndTestflight: ["Not applicable to the web rail"],
      checksRun: ["fast: PASS", "live DNS: SKIP — manual prerequisite"],
      scheduledLoops: ["weekly; direct sources required"],
      nextReviews: ["weekly review after source freshness is verified"],
    },
  };
}

function handlerContext(): WorkflowHandlerContext {
  return {
    runId: "launch-synthetic-web",
    node: workflowNode("launch-report", {
      handler: "launch.report",
      capability: "launch.report",
      evidence: { required: true, artifact: "reports/launch/final.json" },
    }),
    attempt: 1,
    dependencyOutputs: {},
    idempotencyKey: "launch:synthetic-web:report",
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

describe("sanitized launch report", () => {
  it("extracts only allowlisted verified provider facts from durable node output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-launch-report-facts-"));
    const store = new FileWorkflowStore({ rootDir: join(directory, "runs") });
    const definition = defineWorkflow({
      id: "report-facts",
      name: "Report facts",
      version: "1",
      nodes: [
        workflowNode("github-repository", {
          kind: "provider",
          handler: "provider.github-repository",
          transport: "api",
          capability: "github_repository",
          effect: "external_reversible",
          evidence: { required: true },
        }),
      ],
      maxParallel: 1,
      maxIterations: 4,
      budgets: {},
    });
    const state = await new WorkflowExecutor({
      store,
      bindings: {
        handlers: {
          "provider.github-repository": () => ({
            output: {
              provider: "github",
              planId: "github-plan",
              state: "verified",
              environments: ["preview"],
              capabilities: ["repository"],
              operations: [],
              resourceRefs: [
                "repository=example/fixture",
                "account_id=fixture-owner",
                "team_id=fixture-team",
                "region=eu",
              ],
              ignoredProviderBody: { arbitrary: "must-not-enter-the-report" },
              checks: [],
            },
            effectVerified: true,
            evidenceArtifact: "reports/launch/report-facts/providers/github-repository.json",
          }),
        },
      },
    }).start(definition, { runId: "report-facts-run" });

    const input = createLaunchReportInputFromRun({
      generatedAt: "2026-08-04T12:00:00.000Z",
      state,
      brief: { id: "fixture", name: "Fixture", synthetic: true },
      launch: { mode: "thin_mvp", rail: "web" },
      providerByNode: { "github-repository": "github" },
    });
    const report = renderLaunchReport(input);

    expect(report.document.providers[0]).toMatchObject({
      provider: "github",
      capability: "repository",
      lifecycleState: "verified",
      environment: "preview",
      accountId: "fixture-owner",
      teamId: "fixture-team",
      region: "eu",
      resourceRefs: [
        "account_id=fixture-owner",
        "region=eu",
        "repository=example/fixture",
        "team_id=fixture-team",
      ],
      verified: true,
    });
    expect(report.document.sections.repository[0]).toContain("example/fixture");
    expect(report.json).not.toContain("must-not-enter-the-report");
  });

  it("renders every contract section and keeps only genuinely unresolved actions", () => {
    const secret = "launch-report-secret";
    const redactor = new Redactor();
    redactor.addSecret(secret);
    const report = renderLaunchReport(reportInput(secret), { redactor });

    expect(report.document).toMatchObject({
      schemaVersion: 1,
      run: { id: "launch-synthetic-web", status: "waiting" },
      brief: { id: "synthetic-web", synthetic: true },
      launch: { mode: "thin_mvp", rail: "web" },
      overallState: "waiting",
    });
    expect(report.document.remainingManualActions.map(({ nodeId }) => nodeId)).toEqual([
      "dns-records",
    ]);
    expect(report.markdown).toContain("## Provider resources");
    expect(report.markdown).toContain("Payment / entitlement source: stripe / stripe");
    expect(report.markdown).toContain("core_product, reliability, subscription / strict");
    expect(report.markdown).toContain("account fixture-account");
    expect(report.markdown).toContain("## Active credential references");
    expect(report.markdown).toContain("## Scheduled loops");
    expect(report.markdown).toContain("## Next commands");
    expect(`${report.json}\n${report.markdown}`).not.toContain(secret);
    expect(`${report.json}\n${report.markdown}`).not.toContain("owner@example.test");
    expect(report.markdown).toContain("[REDACTED PII]");
    expect(report.json).toContain("token=[REDACTED]");
  });

  it("persists and reads back deterministic JSON and Markdown atomically through the workflow binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-launch-report-"));
    const secret = "persisted-report-secret";
    const redactor = new Redactor();
    redactor.addSecret(secret);
    const binding = createLaunchReportWorkflowBinding({
      redactor,
      outputDirectory: directory,
      input: async () => reportInput(secret),
    });

    const result = await binding.handlers!["launch.report"](handlerContext());
    const [json, markdown, files] = await Promise.all([
      readFile(join(directory, "final.json"), "utf8"),
      readFile(join(directory, "final.md"), "utf8"),
      readdir(directory),
    ]);

    expect(result.effectVerified).toBe(true);
    expect(result.evidenceArtifact).toBe(join(directory, "final.json"));
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, overallState: "waiting" });
    expect(markdown).toContain("# Launch report: Fixture Venture / launch-synthetic-web");
    expect(files.sort()).toEqual(["final.json", "final.md"]);
    expect(`${json}\n${markdown}`).not.toContain(secret);
  });
});
