import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLaunchReceipt,
  launchReceiptSchema,
  persistLaunchReceipt,
} from "@/lib/runtime/launch-receipt";
import { renderLaunchReport } from "@/lib/runtime/launch-report";
import { compileLaunchDryRun } from "@/lib/launch";
import type { WorkflowRunState } from "@/lib/workflow";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";
import {
  founderBriefFromLaunchContract,
  launchDecisionFromContract,
  parseLaunchContractSource,
} from "@/lib/founder-launch";
import type { LaunchContract } from "@/lib/founder-launch";
import { Redactor } from "@/lib/credentials";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): WorkflowRunState {
  const contract = launchReceiptContract();
  const graph = compileLaunchDryRun(
    founderBriefFromLaunchContract(contract),
    launchDecisionFromContract(contract),
  ).graph;
  const nodes = Object.fromEntries(
    graph.nodes.map((definition) => [
      definition.id,
      {
        definition,
        state:
          definition.id === "verify-local"
            ? ("succeeded" as const)
            : definition.kind === "provider"
              ? ("waiting_for_auth" as const)
              : ("succeeded" as const),
        attempts: 1,
        effectVerified: definition.id === "verify-local",
        cost: 0,
        ...(definition.kind === "model"
          ? { output: { changedFiles: [`app/${definition.id}.tsx`] } }
          : {}),
      },
    ]),
  );
  return {
    schemaVersion: 1,
    runId: "launch-receipt-run",
    graph: { id: graph.id, name: graph.name, version: graph.version, fingerprint: "fixture" },
    status: "waiting",
    nodes,
    verifiedEffects: {},
    cache: {},
    budget: { limits: {}, consumed: {} },
    iterations: 1,
    maxIterations: 1,
    maxParallel: 4,
    eventSequence: 1,
    costs: [
      {
        entryId: "cost-1",
        nodeId: "prepare-repository",
        attempt: 1,
        loopIteration: 1,
        recordedAt: "2026-08-12T12:00:01.000Z",
        kind: "model",
        category: "product-build",
        amount: 75,
        unit: "tokens",
        inputTokens: 50,
        outputTokens: 25,
        tool: "codex_cli",
        model: "gpt-test-fixed",
        metadata: {
          cachedInputTokens: 10,
          toolCalls: 3,
          failedCommands: 1,
        },
      },
      {
        entryId: "cost-2",
        nodeId: "review-product",
        attempt: 1,
        loopIteration: 1,
        recordedAt: "2026-08-12T12:00:01.500Z",
        kind: "model",
        category: "launch.observed_model_tokens",
        amount: 75,
        unit: "tokens",
        budgeted: false,
        inputTokens: 50,
        outputTokens: 25,
        tool: "codex_cli",
        model: "gpt-test-fixed",
        metadata: {
          cachedInputTokens: 10,
          toolCalls: 3,
          failedCommands: 0,
        },
      },
    ],
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:02.000Z",
  };
}

function firstValidationAction(contract: LaunchContract) {
  return {
    action: contract.distribution.firstValidationAction,
    channel: contract.distribution.firstChannel,
    userHabitat: contract.distribution.firstUserHabitat,
    state: "planned" as const,
    execution: "human_gated" as const,
    evidenceRequired:
      "Founder-reviewed evidence that the action was performed; no result is inferred.",
  };
}

describe("Launch Receipt", () => {
  it("keeps the synthetic human-flow fixture on the canonical v2 schema", () => {
    const fixture = launchReceiptSchema.parse(
      JSON.parse(readFileSync("examples/idea-to-launch/launch-receipt.fixture.json", "utf8")),
    );
    const sourceContract = parseLaunchContractSource(
      readFileSync("examples/idea-to-launch/launch-contract.yaml", "utf8"),
    );

    expect(sourceContract).toBeDefined();
    expect(fixture.launchContract).toEqual(sourceContract);
    expect(fixture.build).toMatchObject({ taskCount: 0, modelCalls: 0 });
  });

  it("accounts for model work and distinguishes waiting from verified state", () => {
    const contract = launchReceiptContract();
    const decision = launchDecisionFromContract(contract);
    const receipt = createLaunchReceipt({
      state: state(),
      decision,
      launchContract: contract,
      filesRead: 7,
      verification: {
        deploymentEvidence: {
          state: "verified",
          productionUrl: "https://launch-receipt.vercel.app",
          customDomain: null,
          evidenceRef: "reports/launch/launch-receipt-run/product/verify-production.json",
        },
        primaryJourneyEvidence: {
          scope: "product_specific_end_to_end",
          journeyId: contract.decision.primarySuccessSignal,
          steps: contract.product.primaryJourney,
          state: "verified",
          evidenceRef: "reports/launch/launch-receipt-run/product/verify-production.json",
        },
      },
      report: renderLaunchReport({
        generatedAt: "2026-08-12T12:00:02.000Z",
        run: { id: "launch-receipt-run", status: "waiting" },
        brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
        launch: {
          mode: "product_first",
          rail: "web",
          paymentProvider: "stripe",
          firstValidationAction: firstValidationAction(contract),
        },
        nodes: [],
        providers: [
          {
            provider: "github",
            capability: "repository",
            lifecycleState: "verified",
            resourceRefs: ["repository_url=https://example.test/founder/launch-receipt"],
            evidenceRef: "reports/providers/github.json",
            verified: true,
          },
          {
            provider: "vercel",
            capability: "preview_deployment",
            lifecycleState: "verified",
            resourceRefs: ["url=https://preview-launch-receipt.vercel.app"],
            evidenceRef: "reports/providers/vercel-preview.json",
            verified: true,
          },
          {
            provider: "vercel",
            capability: "production_deployment",
            lifecycleState: "verified",
            resourceRefs: ["url=https://launch-receipt.vercel.app"],
            evidenceRef: "reports/providers/vercel.json",
            verified: true,
          },
          {
            provider: "vercel",
            capability: "optional_google_analytics_environment",
            lifecycleState: "waiting_for_auth",
            evidenceRef: "reports/providers/vercel-ga.json",
            verified: false,
          },
          {
            provider: "stripe",
            capability: "commerce",
            lifecycleState: "waiting_for_auth",
            evidenceRef: "reports/providers/stripe.json",
            verified: false,
          },
          {
            provider: "google",
            capability: "analytics_web_stream",
            lifecycleState: "verified",
            evidenceRef: "reports/providers/google-analytics.json",
            verified: true,
          },
          {
            provider: "google",
            capability: "analytics_event_destination",
            lifecycleState: "requested",
            evidenceRef: "reports/providers/google-analytics-event.json",
            verified: false,
          },
          {
            provider: "google",
            capability: "analytics_future_property",
            lifecycleState: "planned",
            evidenceRef: "reports/providers/google-analytics-planned.json",
            verified: false,
          },
          {
            provider: "brevo",
            capability: "transactional_email_sender",
            lifecycleState: "verified",
            evidenceRef: "reports/providers/brevo-sender.json",
            verified: true,
          },
          {
            provider: "brevo",
            capability: "transactional_email_template",
            lifecycleState: "requested",
            evidenceRef: "reports/providers/brevo-template.json",
            verified: false,
          },
          {
            provider: "google",
            capability: "search_console_site",
            lifecycleState: "waiting_for_manual_action",
            evidenceRef: "reports/providers/google-search.json",
            verified: false,
          },
        ],
        manualActions: [],
        limitations: ["Stripe test-mode read-back remains waiting."],
        nextCommands: ["vh resume launch-receipt-run"],
      }).document,
    });

    expect(() => launchReceiptSchema.parse(receipt)).not.toThrow();
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      launchContract: contract,
      venture: {
        repository: "https://example.test/founder/launch-receipt",
        productionUrl: "https://launch-receipt.vercel.app",
      },
      decision: {
        primarySuccessSignal: "launch_receipt_published",
        firstValidationAction: contract.distribution.firstValidationAction,
      },
      build: {
        buildAgent: "codex_cli (gpt-test-fixed)",
        taskCount: 2,
        modelCalls: 2,
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        totalTokens: 150,
        toolCalls: 6,
        failedCommands: 1,
        filesRead: 7,
      },
      stack: {
        github: "verified",
        vercel: "verified",
        commerce: "waiting",
        analytics: "planned",
        email: "requested",
        search: "waiting",
      },
      verification: {
        primaryJourney: "verified",
        primaryJourneyEvidence: {
          journeyId: "launch_receipt_published",
          evidenceRef: "reports/launch/launch-receipt-run/product/verify-production.json",
        },
        evidenceArtifact: "reports/launch/launch-receipt-run/product/verify-production.json",
      },
    });
    expect(receipt.manualActions).toContainEqual(
      expect.objectContaining({
        action: contract.distribution.firstValidationAction,
        impact: expect.stringContaining("planned and human-gated"),
      }),
    );
  });

  it("reports token totals unavailable when any model task lacks usage", () => {
    const contract = launchReceiptContract();
    const partialState = state();
    partialState.costs = partialState.costs?.slice(0, 1);
    const receipt = createLaunchReceipt({
      state: partialState,
      decision: launchDecisionFromContract(contract),
      launchContract: contract,
      report: renderLaunchReport({
        generatedAt: "2026-08-12T12:00:02.000Z",
        run: { id: "launch-receipt-run", status: "waiting" },
        brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
        launch: {
          mode: "product_first",
          rail: "web",
          firstValidationAction: firstValidationAction(contract),
        },
        nodes: [],
        providers: [],
        manualActions: [],
        limitations: [],
        nextCommands: [],
      }).document,
    });

    expect(receipt.build).toMatchObject({
      taskCount: 2,
      modelCalls: 2,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      toolCalls: null,
      failedCommands: null,
      filesRead: null,
    });
    expect(receipt.verification).toMatchObject({ primaryJourney: "planned" });
    expect(receipt.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Model usage is incomplete"),
        expect.stringContaining("failed-command accounting is unavailable"),
      ]),
    );
  });

  it("persists sanitized local JSON and Markdown without any upload surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-receipt-"));
    roots.push(root);
    const contract = launchReceiptContract({ synthetic: true });
    const secret = ["sk", "test", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const redactor = new Redactor();
    redactor.addSecret(secret);
    const report = renderLaunchReport({
      generatedAt: "2026-08-12T12:00:02.000Z",
      run: { id: "launch-receipt-run", status: "waiting" },
      brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: true },
      launch: {
        mode: "product_first",
        rail: "web",
        firstValidationAction: firstValidationAction(contract),
      },
      nodes: [],
      providers: [],
      manualActions: [],
      limitations: ["Synthetic fixture: no live state is claimed."],
      nextCommands: [],
    }).document;
    const receipt = createLaunchReceipt(
      {
        state: state(),
        decision: launchDecisionFromContract(contract),
        launchContract: contract,
        report: {
          ...report,
          limitations: [`Synthetic fixture: no live state is claimed. ${secret}`],
        },
      },
      { redactor },
    );

    const persisted = await persistLaunchReceipt(receipt, root);
    const json = readFileSync(persisted.jsonPath, "utf8");
    const markdown = readFileSync(persisted.markdownPath, "utf8");
    expect(json).toContain('"schemaVersion": 2');
    expect(json).toContain('"launchContract"');
    expect(json).toContain('"modelCalls": 2');
    expect(json).not.toContain(secret);
    expect(markdown).not.toContain(secret);
    expect(markdown).toContain("does not upload it or phone home");
    expect(markdown).toContain("planned and human-gated");
    expect(markdown).toContain("## Canonical Launch Contract");
    expect(markdown).toContain(`proposition: ${contract.venture.proposition}`);
    expect(markdown).toContain("privacyAndConsent: REQUIRED");
    expect(markdown).toContain("Model tasks / model calls: 2 / 2");
  });

  it("counts distinct model tasks separately from retried model calls", () => {
    const contract = launchReceiptContract();
    const retriedState = state();
    retriedState.nodes["prepare-repository"]!.attempts = 2;
    retriedState.costs?.push({
      ...retriedState.costs[0]!,
      entryId: "cost-3",
      attempt: 2,
      recordedAt: "2026-08-12T12:00:01.750Z",
    });
    const receipt = createLaunchReceipt({
      state: retriedState,
      decision: launchDecisionFromContract(contract),
      launchContract: contract,
      report: renderLaunchReport({
        generatedAt: "2026-08-12T12:00:02.000Z",
        run: { id: "launch-receipt-run", status: "waiting" },
        brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
        launch: {
          mode: "product_first",
          rail: "web",
          firstValidationAction: firstValidationAction(contract),
        },
        nodes: [],
        providers: [],
        manualActions: [],
        limitations: [],
        nextCommands: [],
      }).document,
    });

    expect(receipt.build).toMatchObject({ taskCount: 2, modelCalls: 3, retries: 1 });
  });

  it("rejects generic or unlinked journey and validation-action evidence", () => {
    const contract = launchReceiptContract();
    const report = renderLaunchReport({
      generatedAt: "2026-08-12T12:00:02.000Z",
      run: { id: "launch-receipt-run", status: "waiting" },
      brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
      launch: {
        mode: "product_first",
        rail: "web",
        firstValidationAction: {
          ...firstValidationAction(contract),
          action: "A different action",
        },
      },
      nodes: [],
      providers: [],
      manualActions: [],
      limitations: [],
      nextCommands: [],
    }).document;

    expect(() =>
      createLaunchReceipt({
        state: state(),
        report,
        decision: launchDecisionFromContract(contract),
        launchContract: contract,
      }),
    ).toThrow(/does not match the Launch Contract/);

    expect(() =>
      createLaunchReceipt({
        state: state(),
        report: renderLaunchReport({
          generatedAt: "2026-08-12T12:00:02.000Z",
          run: { id: "launch-receipt-run", status: "waiting" },
          brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
          launch: {
            mode: "product_first",
            rail: "web",
            firstValidationAction: firstValidationAction(contract),
          },
          nodes: [],
          providers: [],
          manualActions: [],
          limitations: [],
          nextCommands: [],
        }).document,
        decision: launchDecisionFromContract(contract),
        launchContract: contract,
        verification: {
          primaryJourneyEvidence: {
            scope: "product_specific_end_to_end",
            journeyId: contract.decision.primarySuccessSignal,
            steps: ["Open the homepage"],
            state: "verified",
            evidenceRef: "reports/quality/generic-smoke.json",
          },
        },
      }),
    ).toThrow(/enumerate the reviewed Launch Contract journey/);
  });

  it("requires the v2 contract and model-call fields without fabricating a v1 migration", () => {
    const contract = launchReceiptContract();
    const receipt = createLaunchReceipt({
      state: state(),
      decision: launchDecisionFromContract(contract),
      launchContract: contract,
      report: renderLaunchReport({
        generatedAt: "2026-08-12T12:00:02.000Z",
        run: { id: "launch-receipt-run", status: "waiting" },
        brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
        launch: {
          mode: "product_first",
          rail: "web",
          firstValidationAction: firstValidationAction(contract),
        },
        nodes: [],
        providers: [],
        manualActions: [],
        limitations: [],
        nextCommands: [],
      }).document,
    });
    const withoutContract: Partial<typeof receipt> = { ...receipt };
    delete withoutContract.launchContract;
    const withoutModelCalls: Partial<typeof receipt.build> = { ...receipt.build };
    delete withoutModelCalls.modelCalls;

    expect(() => launchReceiptSchema.parse({ ...receipt, schemaVersion: 1 })).toThrow();
    expect(() => launchReceiptSchema.parse(withoutContract)).toThrow();
    expect(() => launchReceiptSchema.parse({ ...receipt, build: withoutModelCalls })).toThrow();
    const syntheticSecret = ["sk", "test", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const secretBearingMismatch = structuredClone(receipt);
    secretBearingMismatch.launchContract.decision.primarySuccessSignal = syntheticSecret;
    let mismatchError: unknown;
    try {
      launchReceiptSchema.parse(secretBearingMismatch);
    } catch (error) {
      mismatchError = error;
    }
    expect(mismatchError).toBeInstanceOf(Error);
    expect((mismatchError as Error).message).not.toContain(syntheticSecret);
    expect(() =>
      createLaunchReceipt({
        state: state(),
        decision: launchDecisionFromContract(contract),
        launchContract: undefined as never,
        report: renderLaunchReport({
          generatedAt: "2026-08-12T12:00:02.000Z",
          run: { id: "launch-receipt-run", status: "waiting" },
          brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
          launch: {
            mode: "product_first",
            rail: "web",
            firstValidationAction: firstValidationAction(contract),
          },
          nodes: [],
          providers: [],
          manualActions: [],
          limitations: [],
          nextCommands: [],
        }).document,
      }),
    ).toThrow();
  });

  it("rejects credential material inside the canonical Launch Contract before redaction", () => {
    const contract = launchReceiptContract();
    const credential = ["sk", "test", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const unsafeContract = {
      ...contract,
      venture: { ...contract.venture, proposition: credential },
    } as LaunchContract;
    const redactor = new Redactor();
    redactor.addSecret(credential);

    expect(() =>
      createLaunchReceipt(
        {
          state: state(),
          decision: launchDecisionFromContract(contract),
          launchContract: unsafeContract,
          report: renderLaunchReport({
            generatedAt: "2026-08-12T12:00:02.000Z",
            run: { id: "launch-receipt-run", status: "waiting" },
            brief: { id: "launch-receipt", name: "Launch Receipt", synthetic: false },
            launch: {
              mode: "product_first",
              rail: "web",
              firstValidationAction: firstValidationAction(contract),
            },
            nodes: [],
            providers: [],
            manualActions: [],
            limitations: [],
            nextCommands: [],
          }).document,
        },
        { redactor },
      ),
    ).toThrow(/credential values are forbidden/);
  });
});
