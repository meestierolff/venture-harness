import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { issueAuthorizationEnvelope } from "@/lib/authorization";
import { createDefaultPoliciesConfig } from "@/lib/config/policy-schema";
import { CredentialBroker, MemoryCredentialBackend, Redactor } from "@/lib/credentials";
import {
  compileLaunchGraph,
  createLaunchManualBindings,
  createRepositoryInterruptEvidenceVerifier,
  expectedDnsRecordsFromDependencies,
  founderBriefSchema,
  type FounderBrief,
} from "@/lib/launch";
import { MockProviderTransport, type ProviderId, type ProviderOperation } from "@/lib/providers";
import {
  createLaunchReportInputFromRun,
  createLaunchReportWorkflowBinding,
  createOfficialProviderContext,
  createProviderWorkflowBindings,
  FileProviderIdempotencyLedger,
  persistLaunchReport,
  renderLaunchReport,
} from "@/lib/runtime";
import {
  FileWorkflowStore,
  WorkflowExecutor,
  type JsonValue,
  type WorkflowBindings,
  type WorkflowDefinition,
  type WorkflowRunState,
} from "@/lib/workflow";
import {
  syntheticProviderByNode,
  syntheticProviderIds,
  syntheticProviderPlanFactories,
} from "./fixtures/provider/launch-runtime";

const temporaryDirectories: string[] = [];

function loadBrief(path: string): FounderBrief {
  return founderBriefSchema.parse(parse(readFileSync(path, "utf8")));
}

function harness(
  definition: WorkflowDefinition,
  brief: FounderBrief,
  runId: string,
  authorizationProfile: "live-commerce-launch" | "mobile-testflight",
  failProvider?: ProviderId,
) {
  const directory = mkdtempSync(join(tmpdir(), "vh-launch-fixture-"));
  temporaryDirectories.push(directory);
  const store = new FileWorkflowStore({
    rootDir: join(directory, "runs"),
    secrets: ["synthetic-secret-never-persist"],
  });
  const calls = new Map<string, number>();
  const handlers: NonNullable<WorkflowBindings["handlers"]> = {};
  for (const node of definition.nodes) {
    if (!node.handler || node.kind === "provider" || node.handler === "launch.report") continue;
    handlers[node.handler] = ({ runId, trace }) => {
      calls.set(node.handler!, (calls.get(node.handler!) ?? 0) + 1);
      trace({ diagnostic: "synthetic-secret-never-persist" });
      const evidenceArtifact = `reports/launch/${runId}/product/${node.id}.json`;
      const evidencePath = join(directory, evidenceArtifact);
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(
        evidencePath,
        `${JSON.stringify({ synthetic: true, runId, nodeId: node.id })}\n`,
      );
      return {
        output: {
          fixture: true,
          nodeId: node.id,
          credentialEcho: "synthetic-secret-never-persist",
        },
        effectVerified: node.effect !== "none" && node.effect !== "read" ? true : undefined,
        evidenceArtifact: node.evidence.required ? evidenceArtifact : undefined,
      };
    };
  }
  const redactor = new Redactor();
  redactor.addSecret("synthetic-secret-never-persist");
  const syntheticProviderState = new Map<string, Record<string, unknown>>();
  const transportHandler = async (operation: ProviderOperation) => {
    if (operation.provider === failProvider) {
      return {
        status: "failed" as const,
        providerCode: "terminal_auth",
        message: "Synthetic provider rejected synthetic-secret-never-persist",
        retryable: false,
      };
    }
    if (operation.provider === "stripe" && operation.action.endsWith(".search_before_create")) {
      return {
        status: "succeeded" as const,
        message: "Synthetic deterministic search found no existing Stripe resource",
        output: { data: [], has_more: false },
        verified: true,
      };
    }
    const baseOutput = {
      fixture: true,
      provider: operation.provider,
      operation_id: operation.id,
      id: `synthetic-${operation.provider}-${operation.id.replace(/[^a-z0-9]+/gi, "-")}`,
      resource_id: `synthetic-${operation.provider}-${operation.id.replace(/[^a-z0-9]+/gi, "-")}`,
    };
    const output = {
      ...baseOutput,
      ...(operation.capability === "domain"
        ? {
            verification: [
              {
                type: "CNAME",
                domain: "www.fixture.example.test",
                value: "fixture.vercel-dns.test",
                ttl: 300,
              },
            ],
          }
        : {}),
      ...(operation.capability === "sending_domain"
        ? {
            domain_name: "fixture.example.test",
            dns_records: {
              brevo_code: {
                type: "TXT",
                host_name: "@",
                value: "brevo-code=fixture-public-value",
                status: false,
              },
              dkim_record: {
                type: "TXT",
                host_name: "mail._domainkey",
                value: "v=DKIM1; p=fixture-public-key",
                status: false,
              },
            },
          }
        : {}),
      ...(operation.capability === "webhook" ? { secret: "synthetic-secret-never-persist" } : {}),
      ...(operation.capability === "site_verification_token"
        ? { method: "DNS_TXT", token: "google-site-verification=fixture-public-value" }
        : {}),
      ...(operation.capability === "analytics_property" ? { name: "properties/987654" } : {}),
      ...(operation.capability === "analytics_web_stream"
        ? {
            name: "properties/987654/dataStreams/123456",
            webStreamData: { measurementId: "G-FIXTURE123" },
          }
        : {}),
      ...(operation.capability === "ios_build"
        ? {
            id: "eas-build-fixture",
            appVersion: "0.1.0",
            appBuildVersion: "1",
            platform: "IOS",
            status: "FINISHED",
            buildProfile: "production",
          }
        : {}),
      ...(operation.capability === "build_processing"
        ? {
            data: [
              {
                type: "builds",
                id: "asc-build-fixture",
                attributes: { version: "1", processingState: "VALID" },
              },
            ],
          }
        : {}),
      ...(operation.capability === "testflight_group"
        ? { data: { type: "betaGroups", id: "beta-group-fixture" } }
        : {}),
    };
    syntheticProviderState.set(operation.idempotencyKey, output);
    return {
      status: "succeeded" as const,
      message: "Synthetic provider operation completed; stateful read-back is required",
      output,
      verified: false,
    };
  };
  const readBackHandler = async (operation: ProviderOperation) => {
    const evidence = syntheticProviderState.get(operation.idempotencyKey);
    return evidence
      ? {
          operationId: operation.id,
          status: "matched" as const,
          message: "Synthetic provider state matched the requested idempotency key",
          evidence,
        }
      : {
          operationId: operation.id,
          status: "mismatched" as const,
          message: "Synthetic provider state was absent",
        };
  };
  const cliTransport = new MockProviderTransport("cli", transportHandler, readBackHandler);
  const httpTransport = new MockProviderTransport("http", transportHandler, readBackHandler);
  const credentialBroker = new CredentialBroker([new MemoryCredentialBackend()], redactor);
  credentialBroker.register({
    ref: "cred://neon/database",
    provider: "neon",
    kind: "connection_string",
    backend: "memory",
    label: "Synthetic writable Neon capture target",
  });
  credentialBroker.register({
    ref: "cred://stripe/webhook-secret",
    provider: "stripe",
    kind: "ci_secret",
    backend: "memory",
    label: "Synthetic writable Stripe capture target",
  });
  credentialBroker.register({
    ref: "cred://google/measurement-id",
    provider: "google",
    kind: "ci_secret",
    backend: "memory",
    label: "Synthetic writable Google capture target",
  });
  const providerContext = createOfficialProviderContext({
    credentials: credentialBroker,
    redactor,
    idempotencyLedger: new FileProviderIdempotencyLedger(join(directory, "provider-ledger.json")),
    additional: [cliTransport, httpTransport],
  });
  const policies = createDefaultPoliciesConfig();
  const authorization = issueAuthorizationEnvelope({
    runId,
    profile: authorizationProfile,
    providers: syntheticProviderIds(definition),
    environments: ["local", "test", "preview", "production"],
    policies,
    approvalRef: `synthetic-fixture:${authorizationProfile}`,
    now: new Date("2026-08-04T12:00:00.000Z"),
  });
  const providerBindings = createProviderWorkflowBindings({
    planFactories: syntheticProviderPlanFactories(definition),
    policies,
    authorization,
    context: providerContext,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    recordEvidence: ({ evidence, workflow }) => {
      const reference = `reports/launch/${workflow.runId}/providers/${workflow.node.id}.json`;
      const path = join(directory, reference);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
      return reference;
    },
  });
  const reportInput = (state: WorkflowRunState) =>
    createLaunchReportInputFromRun({
      generatedAt: "2026-08-04T12:00:00.000Z",
      state,
      brief: {
        id: brief.id,
        name: brief.name,
        synthetic: true,
        scheduledLearning: brief.needs.scheduled_learning,
      },
      launch: {
        mode: String(definition.metadata?.launchMode ?? "unknown"),
        rail: String(definition.metadata?.appKind ?? "unknown"),
      },
      authorization: {
        profile: authorization.profile,
        approvalRef: authorization.approval_ref,
        expiresAt: authorization.expires_at,
        spendCeiling: authorization.max_estimated_spend,
      },
      providerByNode: syntheticProviderByNode(definition),
      limitations: ["Synthetic fixture: no live provider state is claimed."],
    });
  const outputDirectory = join(directory, "reports", "launch", runId);
  const reportBindings = createLaunchReportWorkflowBinding({
    redactor,
    outputDirectory,
    input: ({ runId: activeRunId }) => reportInput(store.load(activeRunId)),
  });
  const manualBindings = createLaunchManualBindings();
  const executor = new WorkflowExecutor({
    store,
    bindings: {
      handlers: {
        ...handlers,
        ...providerBindings.handlers,
        ...reportBindings.handlers,
      },
      reconcilers: providerBindings.reconcilers,
      validators: manualBindings.validators,
      interruptEvidenceVerifier: createRepositoryInterruptEvidenceVerifier({
        rootDir: directory,
        redactor,
      }),
      secrets: ["synthetic-secret-never-persist"],
    },
    sleep: async () => undefined,
  });
  const persistReport = (state: WorkflowRunState) =>
    persistLaunchReport(renderLaunchReport(reportInput(state), { redactor }), outputDirectory);
  return {
    directory,
    outputDirectory,
    store,
    calls,
    providerOperations: () => [...cliTransport.calls, ...httpTransport.calls],
    executor,
    persistReport,
  };
}

async function resolveAllManualActions(
  rootDir: string,
  executor: WorkflowExecutor,
  definition: WorkflowDefinition,
  initial: WorkflowRunState,
  afterResume?: (state: WorkflowRunState) => Promise<unknown>,
): Promise<WorkflowRunState> {
  let state = initial;
  let resumptions = 0;
  while (state.status === "waiting") {
    const waiting = Object.values(state.nodes).filter(
      (record) => record.state === "waiting_for_manual_action",
    );
    expect(
      waiting.length,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(state.nodes).map(([nodeId, record]) => [
            nodeId,
            { state: record.state, error: record.error },
          ]),
        ),
      ),
    ).toBeGreaterThan(0);
    for (const record of waiting) {
      const output = (
        record.definition.id === "dns-records"
          ? {
              mode: "manual_dns",
              records: expectedDnsRecordsFromDependencies(
                Object.fromEntries(
                  record.definition.dependencies.map((dependency) => [
                    dependency,
                    executor.getState(state.runId).nodes[dependency]?.output,
                  ]),
                ),
              ),
              preserved_existing_mail_records: true,
              preserved_nameservers: true,
              propagation_checks: [
                {
                  resolver: "fixture-resolver-one",
                  checked_at: "2026-08-04T12:00:00.000Z",
                  status: "matched",
                },
                {
                  resolver: "fixture-resolver-two",
                  checked_at: "2026-08-04T12:00:00.000Z",
                  status: "matched",
                },
              ],
            }
          : {
              app_name: "Synthetic Subscription Fixture",
              bundle_identifier: "test.example.synthetic.subscription",
              sku: "SYNTHETIC-FIXTURE-001",
              primary_language: "en-US",
              apple_app_id: "1234567890",
              team_id: "SYNTH12345",
              provider_state: "configured",
              verified_at: "2026-08-04T12:00:00.000Z",
            }
      ) as JsonValue;
      const evidenceArtifact = `reports/launch/${state.runId}/manual/${record.definition.id}.json`;
      const evidencePath = join(rootDir, evidenceArtifact);
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(
        evidencePath,
        `${JSON.stringify(
          {
            schema_version: 1,
            kind: "manual_action_evidence",
            run_id: state.runId,
            node_id: record.definition.id,
            status: "verified",
            approved_by: "synthetic-fixture",
            verified_at: "2026-08-04T12:00:00.000Z",
            output,
            verification: ["Synthetic typed fixture evidence; no external action occurred."],
            limitations: ["Synthetic fixture: this is not provider or DNS proof."],
          },
          null,
          2,
        )}\n`,
      );
      await executor.completeManualAction(state.runId, record.definition.id, {
        approvedBy: "synthetic-fixture",
        note: "Synthetic output only; no external action occurred.",
        output,
        evidenceArtifact,
      });
    }
    state = await executor.resume(definition, state.runId);
    await afterResume?.(state);
    resumptions += 1;
    expect(resumptions).toBeLessThan(10);
  }
  return state;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic launch fixtures", () => {
  for (const fixture of ["web-saas", "ios-subscription"]) {
    it(`executes, pauses, resumes, and remains idempotent for ${fixture}`, async () => {
      const brief = loadBrief(`fixtures/${fixture}/brief.yaml`);
      const definition = compileLaunchGraph(brief, undefined, {
        initialOrigin: "custom_domain",
      });
      const runId = `fixture-${fixture}`;
      const authorizationProfile =
        fixture === "web-saas" ? "live-commerce-launch" : "mobile-testflight";
      const {
        directory,
        outputDirectory,
        store,
        calls,
        providerOperations,
        executor,
        persistReport,
      } = harness(definition, brief, runId, authorizationProfile);

      let state = await executor.start(definition, { runId });
      expect(
        state.status,
        JSON.stringify({
          failed: Object.fromEntries(
            Object.entries(state.nodes)
              .filter(([, record]) => record.state === "failed_terminal")
              .map(([id, record]) => [id, record.error]),
          ),
          relevantEvents: store
            .readEvents(state.runId)
            .filter((event) =>
              ["stripe-callbacks", "google-analytics-stream"].includes(event.nodeId ?? ""),
            ),
        }),
      ).toBe("waiting");
      await persistReport(state);
      expect(JSON.parse(readFileSync(join(outputDirectory, "final.json"), "utf8"))).toMatchObject({
        overallState: "waiting",
      });
      state = await resolveAllManualActions(directory, executor, definition, state, persistReport);

      expect(
        state.status,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(state.nodes)
              .filter(([, record]) => record.state === "failed_terminal")
              .map(([id, record]) => [id, record.error]),
          ),
        ),
      ).toBe("succeeded");
      expect(state.nodes["verify-production"]).toMatchObject({
        state: "succeeded",
        output: { fixture: true, nodeId: "verify-production" },
      });
      expect(state.nodes["launch-report"].state).toBe("succeeded");
      expect(Object.values(state.nodes).every((record) => record.state === "succeeded")).toBe(true);
      const callsAtCompletion = [...calls.entries()];
      const providerCallsAtCompletion = providerOperations().length;
      const persistedAtCompletion = store.load(state.runId);
      expect(await executor.resume(definition, state.runId)).toEqual(persistedAtCompletion);
      expect([...calls.entries()]).toEqual(callsAtCompletion);
      expect(providerOperations()).toHaveLength(providerCallsAtCompletion);

      const exercisedCapabilities = new Set(
        providerOperations().map(({ provider, capability }) => `${provider}:${capability}`),
      );
      if (fixture === "web-saas") {
        for (const expected of [
          "github:repository",
          "neon:project",
          "neon:branch",
          "neon:database",
          "neon:role",
          "neon:schema_migration",
          "neon:read_write_health_check",
          "stripe:product",
          "stripe:price",
          "stripe:webhook",
          "stripe:billing_portal",
          "brevo:sending_domain",
          "brevo:sending_domain_verification",
          "brevo:sender",
          "brevo:template",
          "brevo:webhook",
          "google:analytics_property",
          "google:analytics_web_stream",
          "google:site_verification_token",
          "google:site_verification",
          "google:search_console_site",
          "google:search_console_sitemap",
          "bing:site",
          "bing:sitemap",
          "bing:url_submission",
          "vercel:project",
          "vercel:environment_variable",
          "vercel:deployment",
          "vercel:domain",
        ]) {
          expect(exercisedCapabilities, `missing full synthetic operation ${expected}`).toContain(
            expected,
          );
        }
      } else {
        for (const expected of [
          "revenuecat:app",
          "revenuecat:entitlement",
          "revenuecat:offering",
          "revenuecat:webhook",
          "eas:ios_build",
          "eas:app_store_connection",
          "eas:ios_submit",
          "app_store_connect:build_processing",
          "app_store_connect:testflight_group",
          "app_store_connect:build_group_assignment",
        ]) {
          expect(exercisedCapabilities, `missing full synthetic operation ${expected}`).toContain(
            expected,
          );
        }
      }

      const finalReport = JSON.parse(readFileSync(join(outputDirectory, "final.json"), "utf8"));
      expect(finalReport).toMatchObject({
        run: { id: runId, status: "succeeded" },
        overallState: "succeeded",
        remainingManualActions: [],
      });
      expect(finalReport.providers.length).toBeGreaterThan(0);
      expect(existsSync(join(outputDirectory, "final.md"))).toBe(true);

      const stateText = JSON.stringify(store.load(state.runId));
      const eventsText = JSON.stringify(store.readEvents(state.runId));
      const reportText = `${readFileSync(join(outputDirectory, "final.json"), "utf8")}\n${readFileSync(join(outputDirectory, "final.md"), "utf8")}`;
      expect(stateText).not.toContain("synthetic-secret-never-persist");
      expect(eventsText).not.toContain("synthetic-secret-never-persist");
      expect(reportText).not.toContain("synthetic-secret-never-persist");
      expect(stateText).toContain("[REDACTED]");
      expect(eventsText).toContain("[REDACTED]");
    });
  }

  it("fails honestly while preserving independent verified provider effects", async () => {
    const brief = loadBrief("fixtures/web-saas/brief.yaml");
    const definition = compileLaunchGraph(brief, undefined, {
      initialOrigin: "custom_domain",
    });
    const runId = "fixture-provider-failure";
    const { outputDirectory, providerOperations, executor, persistReport } = harness(
      definition,
      brief,
      runId,
      "live-commerce-launch",
      "stripe",
    );

    const state = await executor.start(definition, { runId });
    await persistReport(state);

    expect(state.status).toBe("failed");
    expect(state.nodes["stripe-commerce"]).toMatchObject({
      state: "failed_terminal",
      effectVerified: false,
      error: { code: "provider_failed", retryable: false },
    });
    expect(state.nodes["github-repository"].state).toBe("succeeded");
    expect(state.nodes["launch-report"].state).toBe("skipped");
    const stripeOperations = providerOperations().filter(({ provider }) => provider === "stripe");
    expect(stripeOperations).toHaveLength(1);
    expect(stripeOperations[0]).toMatchObject({
      action: "product.create.search_before_create",
      effectClass: "read",
    });
    expect(JSON.parse(readFileSync(join(outputDirectory, "final.json"), "utf8"))).toMatchObject({
      run: { id: runId, status: "failed" },
      overallState: "failed",
    });
    expect(readFileSync(join(outputDirectory, "final.md"), "utf8")).toContain(
      "## Known limitations",
    );
  });
});
