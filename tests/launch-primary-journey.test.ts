import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { authorizationEnvelopeSchema } from "@/lib/config/policy-schema";
import type { CommandInvocation, CommandRunner } from "@/lib/credentials";
import { founderBriefSchema } from "@/lib/launch";
import {
  createLaunchProductBindings,
  sameRunLaunchReceiptVerification,
  type BuildAgentHost,
} from "@/lib/runtime";
import { workflowNode, type WorkflowHandlerContext, type WorkflowRunState } from "@/lib/workflow";
import type { WorkflowReconciliationContext } from "@/lib/workflow";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";

const roots: string[] = [];
const now = new Date("2026-08-12T12:00:00.000Z");
const runId = "journey-run-123";
const forbiddenEffects = [
  "customer_charge",
  "checkout",
  "external_delete",
  "dns_or_provider_configuration",
  "bulk_or_cold_send",
  "recipient_outside_test_identity",
  "irreversible_publication",
] as const;
const surfaceSpec = "// immutable core-owned raw HTML and accessibility browser checks\n";

function traceArchive(
  origin: string,
  steps: readonly string[],
  phase: "journey" | "cleanup",
): Buffer {
  const name = Buffer.from("test.trace");
  const events: Record<string, unknown>[] = [];
  for (const [index, step] of (phase === "journey"
    ? steps
    : ["verified cleanup read-back"]
  ).entries()) {
    const stepId = `step@${index}`;
    const actionId = `pw:api@${index}`;
    const expectId = `expect@${index}`;
    events.push(
      { type: "before", callId: stepId, title: step },
      {
        type: "before",
        callId: actionId,
        parentId: stepId,
        title: "page.goto",
        params: { url: origin },
      },
      { type: "after", callId: actionId },
      { type: "before", callId: expectId, parentId: stepId, title: "expect.toBeVisible" },
      { type: "after", callId: expectId },
    );
  }
  const body = Buffer.from(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`.repeat(4),
  );
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

function trivialTraceArchive(origin: string): Buffer {
  return traceArchive(origin, ["trivial assertion"], "journey");
}

const authorization = authorizationEnvelopeSchema.parse({
  run_id: runId,
  profile: "standard_launch",
  allowed_capabilities: ["product.primary_journey.verify"],
  allowed_side_effect_classes: ["reversible_external_write"],
  providers: [],
  environments: ["production"],
  issued_at: "2026-08-12T11:00:00.000Z",
  expires_at: "2026-08-12T13:00:00.000Z",
  max_estimated_spend: { amount: 0, currency: "EUR" },
  unknown_external_costs_allowed: false,
  max_email_recipients: 0,
  production_deploy_allowed: true,
  live_products_and_prices_allowed: false,
  actual_charges_allowed: false,
  transactional_test_email_allowed: false,
  dns_additions_allowed: false,
  nameserver_changes_allowed: false,
  app_store_submission_allowed: false,
  explicitly_forbidden_actions: [...forbiddenEffects],
  approval_ref: "test:primary-journey",
  extensions: {},
});

const unusedHost: BuildAgentHost = {
  id: "unused",
  inspect: async () => ({
    host: "unused",
    status: "available",
    readIsolation: "fixture_no_model_execution",
    version: "fixture",
    billingMode: "fixture_no_model_execution",
    billingEvidence: "fixture_attestation",
    nextAction: null,
  }),
  run: () => {
    throw new Error("unused");
  },
};

class EvidenceRunner implements CommandRunner {
  readonly calls: CommandInvocation[] = [];

  constructor(
    private readonly root: string,
    private readonly effect = true,
    private readonly surfaceExitCode = 0,
    private readonly emitTraces = true,
    private readonly trivialTraces = false,
    private readonly reconciliationWriteRemains = false,
  ) {}

  async run(invocation: CommandInvocation) {
    this.calls.push(invocation);
    const spec = invocation.args[3];
    if (spec === "tests/e2e/post-deploy-readonly.spec.ts") {
      const observerPhase = invocation.env?.VH_PRIMARY_JOURNEY_OBSERVER_PHASE;
      if (observerPhase) {
        const contract = launchReceiptContract();
        const writes =
          observerPhase === "journey_readback" ||
          (observerPhase === "cleanup_readback" && this.reconciliationWriteRemains)
            ? [{ id: "write-1", label: "TEST — launch-receipt-journey", state: "published" }]
            : [];
        return {
          exitCode: 0,
          stdout: ["desktop-chromium", "mobile-chromium"]
            .map(
              (project) =>
                `VH_PRIMARY_JOURNEY_OBSERVER_RESULT ${JSON.stringify({
                  schemaVersion: 1,
                  phase: observerPhase,
                  runId: invocation.env?.VH_PRIMARY_JOURNEY_RUN_ID,
                  nonce: invocation.env?.VH_PRIMARY_JOURNEY_NONCE,
                  journeyId: contract.decision.primarySuccessSignal,
                  identityLabel: "TEST — launch-receipt-journey",
                  completedSteps: contract.product.primaryJourney,
                  project,
                  writes,
                  removedWriteIds:
                    observerPhase === "cleanup_readback" && !this.reconciliationWriteRemains
                      ? ["write-1"]
                      : [],
                  remainingWrites: writes.length,
                })}`,
            )
            .join("\n"),
          stderr: "",
        };
      }
      return {
        exitCode: this.surfaceExitCode,
        stdout: ["desktop-chromium", "mobile-chromium"]
          .map(
            (project) =>
              `VH_DEPLOYMENT_SURFACE_RESULT ${JSON.stringify({
                schemaVersion: 1,
                project,
                rawServerHtml: true,
                accessibilityAxe: true,
                accessibleNamesAndLandmarks: true,
                keyboardFocus: true,
                responsiveOverflow: true,
              })}`,
          )
          .join("\n"),
        stderr: "",
      };
    }
    const phase = spec?.includes("cleanup") ? "cleanup" : "journey";
    if (this.emitTraces && invocation.env?.PLAYWRIGHT_OUTPUT_DIR) {
      for (const project of ["desktop-chromium", "mobile-chromium"]) {
        const directory = join(this.root, invocation.env.PLAYWRIGHT_OUTPUT_DIR, project);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "trace.zip"),
          this.trivialTraces
            ? trivialTraceArchive(invocation.env?.PLAYWRIGHT_BASE_URL ?? "")
            : traceArchive(
                invocation.env?.PLAYWRIGHT_BASE_URL ?? "",
                launchReceiptContract().product.primaryJourney,
                phase,
              ),
        );
      }
    }
    const contract = launchReceiptContract();
    return {
      exitCode: 0,
      stdout: ["desktop-chromium", "mobile-chromium"]
        .map(
          (project) =>
            `VH_PRIMARY_JOURNEY_RESULT ${JSON.stringify({
              schemaVersion: 1,
              phase,
              runId: invocation.env?.VH_PRIMARY_JOURNEY_RUN_ID,
              nonce: invocation.env?.VH_PRIMARY_JOURNEY_NONCE,
              journeyId: contract.decision.primarySuccessSignal,
              steps: contract.product.primaryJourney,
              project,
              identity: {
                kind: "labeled_test_identity",
                label: "TEST — launch-receipt-journey",
              },
              observedEffects:
                phase === "journey" && this.effect ? ["reversible_external_write"] : [],
              recipientCount: 0,
              recipientsAllMatchTestIdentity: true,
              forbiddenEffectsObserved: [],
              ...(phase === "cleanup"
                ? { cleanup: { state: "verified", removedWrites: 1, remainingWrites: 0 } }
                : {}),
            })}`,
        )
        .join("\n"),
      stderr: "",
    };
  }
}

function fixtureRoot(options: { tamperSurface?: boolean; duplicateForbidden?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vh-primary-journey-"));
  roots.push(root);
  mkdirSync(join(root, "tests/e2e"), { recursive: true });
  const contract = launchReceiptContract();
  const binding = {
    schemaVersion: 1,
    scope: "product_specific_end_to_end",
    journeyId: contract.decision.primarySuccessSignal,
    steps: contract.product.primaryJourney,
    specPath: "tests/e2e/primary-journey.spec.ts",
    cleanupSpecPath: "tests/e2e/primary-journey-cleanup.spec.ts",
    launchContractPath: "config/launch-contract.yaml",
    production: {
      effect: "reversible_external_write",
      identity: { kind: "labeled_test_identity", label: "TEST — launch-receipt-journey" },
      cleanup: "required_and_verified",
      readBack: {
        method: "GET",
        path: "/api/venture-harness-primary-journey",
        protocol: "venture_harness_primary_journey_v1",
      },
      allowedEffects: ["reversible_external_write"],
      forbiddenEffects: options.duplicateForbidden
        ? Array.from({ length: 7 }, () => "customer_charge")
        : forbiddenEffects,
    },
  };
  writeFileSync(
    join(root, "tests/e2e/primary-journey.contract.json"),
    `${JSON.stringify(binding)}\n`,
  );
  const boundSpec = [
    "primary-journey.contract.json",
    "VH_PRIMARY_JOURNEY_RUN_ID",
    "VH_PRIMARY_JOURNEY_NONCE",
    "VH_PRIMARY_JOURNEY_TEST_IDENTITY",
    "VH_PRIMARY_JOURNEY_RESULT",
    "test.step",
  ].join("\n");
  writeFileSync(join(root, "tests/e2e/primary-journey.spec.ts"), boundSpec);
  writeFileSync(join(root, "tests/e2e/primary-journey-cleanup.spec.ts"), boundSpec);
  writeFileSync(
    join(root, "tests/e2e/post-deploy-readonly.spec.ts"),
    options.tamperSurface ? "console.log('forged markers')\n" : surfaceSpec,
  );
  writeFileSync(
    join(root, "harness.lock"),
    stringify({
      lock_version: 1,
      harness_version: "0.2.0",
      config_contract_version: 2,
      source: { kind: "template", ref: null },
      managed_files: [
        {
          path: "tests/e2e/post-deploy-readonly.spec.ts",
          ownership: "core_owned",
          sha256: createHash("sha256").update(surfaceSpec).digest("hex"),
        },
      ],
      applied_migrations: [],
      extensions: {},
    }),
  );
  return root;
}

function context(options: { customDomain?: boolean } = {}): WorkflowHandlerContext {
  return {
    runId,
    node: workflowNode(options.customDomain ? "verify-custom-domain" : "verify-production", {
      handler: "launch.verifyProduction",
      effect: "external_reversible",
      evidence: { required: true, artifact: "reports/quality/post-deploy.json" },
    }),
    attempt: 1,
    dependencyOutputs: {
      "production-deploy": {
        provider: "vercel",
        state: "verified",
        resourceRefs: ["url=https://launch-receipt.vercel.app/"],
      },
      ...(options.customDomain
        ? {
            "vercel-project": {
              provider: "vercel",
              state: "verified",
              resourceRefs: ["domain=receipt.example.com"],
            },
            "dns-records": {
              mode: "manual_dns",
              propagation_checks: [{ status: "matched" }, { status: "matched" }],
            },
          }
        : {}),
    },
    idempotencyKey: "launch:receipt:verify-production",
    signal: new AbortController().signal,
    trace: () => undefined,
    checkpointOperation: () => undefined,
    checkpointExternalEffect: () => undefined,
  };
}

function reconciliationContext(): WorkflowReconciliationContext {
  return {
    runId,
    node: workflowNode("verify-production", {
      handler: "launch.verifyProduction",
      effect: "external_reversible",
      evidence: { required: true, artifact: "reports/quality/post-deploy.json" },
    }),
    attempt: 2,
    dependencyOutputs: {},
    idempotencyKey: "launch:receipt:verify-production",
    operation: {
      attempt: 1,
      idempotencyKey: "launch:receipt:verify-production",
      phase: "external_write_acknowledged",
      preparedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      reconcileAttempts: 1,
      checkpoint: {
        schemaVersion: 1,
        kind: "production_primary_journey",
        deploymentUrl: "https://launch-receipt.vercel.app",
        runId,
        nonce: "a".repeat(48),
        journeyId: launchReceiptContract().decision.primarySuccessSignal,
        identityLabel: "TEST — launch-receipt-journey",
      },
    },
    reason: "retry",
    signal: new AbortController().signal,
    trace: () => undefined,
  };
}

function bindings(root: string, runner: EvidenceRunner, synthetic = false, domain?: string) {
  const contract = launchReceiptContract();
  return createLaunchProductBindings({
    rootDir: root,
    brief: founderBriefSchema.parse({
      id: "launch-receipt",
      ...(synthetic ? { synthetic: true as const } : {}),
      name: "Launch Receipt",
      specific_user_or_audience: contract.venture.targetUser,
      problem_or_job: contract.venture.painfulJob,
      intended_outcome: contract.venture.desiredOutcome,
      smallest_core_journey: contract.product.primaryJourney.join(", "),
      primary_success_signal: contract.decision.primarySuccessSignal,
      ...(domain ? { domain } : {}),
      material_constraints: [],
      known_truths: [],
      assumptions: [],
      app_kind: "web",
      requested_mobile_stack: "none",
      business_model: "b2c",
      monetization_model: "subscription",
      native_digital_goods: false,
      factors: {
        smallest_useful_build_cost: "low",
        smallest_useful_build_time: "low",
        reversibility: "high",
        regulatory_or_safety_risk: "low",
        real_usage_required: "high",
        marketplace_cold_start: "low",
        operational_burden: "low",
        founder_evidence: "moderate",
        concierge_delivery_fit: "low",
        app_store_required: "low",
        deep_native_requirements: "low",
        on_device_requirements: "low",
      },
      needs: {
        authenticated_product: true,
        database: true,
        file_storage: false,
        transactional_email: false,
        lifecycle_email: false,
        feedback: false,
        analytics: false,
        search_discovery: false,
        scheduled_learning: false,
      },
      preferred_dns_provider: "manual",
      deceptive_request: false,
      unsafe_non_defaultable_choice: null,
      indispensable_missing_credential: null,
    }),
    launchContract: contract,
    authorization,
    agentHost: unusedHost,
    commandRunner: runner,
    now: () => now,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production Launch Receipt journey evidence", () => {
  it("binds real evidence to the exact run, Launch Contract, artifact, and cleanup", async () => {
    const root = fixtureRoot();
    const runner = new EvidenceRunner(root);
    const result = await bindings(root, runner).handlers!["launch.verifyProduction"](context());

    expect(result.effectVerified).toBe(true);
    expect(result.output).toMatchObject({
      schemaVersion: 1,
      runId,
      target: "verified_provider_production_url",
      primaryJourneyEvidence: {
        journeyId: "launch_receipt_published",
        state: "verified",
        evidenceRef: `reports/launch/${runId}/product/verify-production.json`,
      },
      accessibility: { state: "verified" },
      rawHtml: { state: "verified" },
      cleanup: { state: "verified" },
    });
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--retries=0"],
      [
        "exec",
        "playwright",
        "test",
        "tests/e2e/primary-journey.spec.ts",
        "--retries=0",
        "--trace=on",
      ],
      ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--retries=0"],
      [
        "exec",
        "playwright",
        "test",
        "tests/e2e/primary-journey-cleanup.spec.ts",
        "--retries=0",
        "--trace=on",
      ],
      ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--retries=0"],
    ]);

    const currentState = {
      runId,
      nodes: {
        "verify-production": {
          state: "succeeded",
          effectVerified: true,
          evidenceArtifact: result.evidenceArtifact,
          output: result.output,
        },
      },
    } as unknown as WorkflowRunState;
    expect(sameRunLaunchReceiptVerification(currentState, false)).toMatchObject({
      accessibility: "verified",
      rawHtml: "verified",
      primaryJourneyEvidence: { state: "verified" },
    });
    expect(
      sameRunLaunchReceiptVerification(
        {
          ...currentState,
          nodes: {
            "verify-production": {
              ...currentState.nodes["verify-production"],
              evidenceArtifact: "reports/launch/unrelated-old-run/product/verify-production.json",
            },
          },
        },
        false,
      ),
    ).toEqual({ accessibility: "planned", rawHtml: "planned" });
    expect(
      sameRunLaunchReceiptVerification(
        {
          ...currentState,
          nodes: {
            "verify-production": {
              ...currentState.nodes["verify-production"],
              output: { ...(result.output as object), runId: "unrelated-old-run" },
            },
          },
        },
        false,
      ),
    ).toEqual({ accessibility: "planned", rawHtml: "planned" });
  });

  it("uses fixture state only for an explicitly synthetic brief", async () => {
    const root = fixtureRoot();
    const result = await bindings(root, new EvidenceRunner(root, false), true).handlers![
      "launch.verifyProduction"
    ](context());
    expect(result.output).toMatchObject({
      primaryJourneyEvidence: { state: "fixture" },
      accessibility: { state: "fixture" },
      rawHtml: { state: "fixture" },
    });
  });

  it("runs cleanup but rejects real markers that omit the declared write effect", async () => {
    const root = fixtureRoot();
    const runner = new EvidenceRunner(root, false);
    await expect(
      bindings(root, runner).handlers!["launch.verifyProduction"](context()),
    ).rejects.toMatchObject({
      code: "POST_DEPLOY_PRIMARY_JOURNEY_FAILED",
    });
    expect(
      runner.calls.some(({ args }) => args[3] === "tests/e2e/primary-journey-cleanup.spec.ts"),
    ).toBe(true);
    expect(runner.calls.at(-1)?.env?.VH_PRIMARY_JOURNEY_OBSERVER_PHASE).toBe("cleanup_readback");
  });

  it("rejects an incomplete duplicated forbidden-effect set before commands run", async () => {
    const root = fixtureRoot({ duplicateForbidden: true });
    const runner = new EvidenceRunner(root);
    await expect(
      bindings(root, runner).handlers!["launch.verifyProduction"](context()),
    ).rejects.toMatchObject({
      code: "PRIMARY_JOURNEY_CONTRACT_INVALID",
    });
    expect(runner.calls).toEqual([]);
  });

  it("rejects a marker-only replacement of the core-owned surface spec before execution", async () => {
    const root = fixtureRoot({ tamperSurface: true });
    const runner = new EvidenceRunner(root);
    await expect(
      bindings(root, runner).handlers!["launch.verifyProduction"](context()),
    ).rejects.toMatchObject({
      code: "DEPLOYMENT_SURFACE_CONTRACT_TAMPERED",
    });
    expect(runner.calls).toEqual([]);
  });

  it("uses the verified provider URL and records a declared but pending custom domain", async () => {
    const root = fixtureRoot();
    const runner = new EvidenceRunner(root);
    const result = await bindings(root, runner, false, "receipt.example.com").handlers![
      "launch.verifyProduction"
    ](context());
    expect(result.output).toMatchObject({
      deploymentUrl: "https://launch-receipt.vercel.app",
      target: "verified_provider_production_url",
      customDomain: { state: "waiting", origin: null },
    });
    expect(runner.calls[0]?.env?.PLAYWRIGHT_BASE_URL).toBe("https://launch-receipt.vercel.app");
  });

  it("fails instead of falling back when the same-run verified custom origin is down", async () => {
    const root = fixtureRoot();
    const runner = new EvidenceRunner(root, true, 1);
    await expect(
      bindings(root, runner, false, "receipt.example.com").handlers!["launch.verifyProduction"](
        context({ customDomain: true }),
      ),
    ).rejects.toMatchObject({ code: "POST_DEPLOY_SURFACE_VERIFICATION_FAILED" });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.env?.PLAYWRIGHT_BASE_URL).toBe("https://receipt.example.com");
  });

  it("rejects perfect self-attested markers without core-observed Playwright traces", async () => {
    const root = fixtureRoot();
    const runner = new EvidenceRunner(root, true, 0, false);
    await expect(
      bindings(root, runner).handlers!["launch.verifyProduction"](context()),
    ).rejects.toMatchObject({ code: "POST_DEPLOY_PRIMARY_JOURNEY_FAILED" });
    expect(runner.calls).toHaveLength(5);
  });

  it("rejects an origin visit, trivial assertion, and perfect self-attested markers", async () => {
    const root = fixtureRoot();
    const runner = new EvidenceRunner(root, true, 0, true, true);
    await expect(
      bindings(root, runner).handlers!["launch.verifyProduction"](context()),
    ).rejects.toMatchObject({ code: "POST_DEPLOY_PRIMARY_JOURNEY_FAILED" });
    expect(runner.calls).toHaveLength(5);
  });

  it("keeps replay blocked when reconciliation cleanup markers pass but locked read-back finds a write", async () => {
    const root = fixtureRoot();
    const runner = new EvidenceRunner(root, true, 0, true, false, true);
    const result = await bindings(root, runner).reconcilers!["launch.verifyProduction"](
      reconciliationContext(),
    );
    expect(result).toMatchObject({
      status: "partially_applied",
      message: expect.stringContaining("locked observer"),
    });
    expect(runner.calls.map(({ args }) => args[3])).toEqual([
      "tests/e2e/primary-journey-cleanup.spec.ts",
      "tests/e2e/post-deploy-readonly.spec.ts",
    ]);
  });
});
