import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createDefaultCliServices, type LaunchBindingContext } from "@/lib/cli/default-services";
import { runCli, type CliIo } from "@/lib/cli";
import { mobileSchema } from "@/lib/config/mobile-schema";
import { launchSchema } from "@/lib/config/launch-schema";
import { loopsSchema } from "@/lib/config/loop-schema";
import { analyticsSchema } from "@/lib/config/schemas";
import { ventureSchema } from "@/lib/config/venture-schema";
import { CredentialBroker, MemoryCredentialBackend, Redactor } from "@/lib/credentials";
import {
  launchContractDigest,
  renderFounderIdea,
  renderLaunchContractYaml,
  renderProductConstitution,
} from "@/lib/founder-launch";
import { MockProviderTransport, type ProviderOperation } from "@/lib/providers";
import { expectedDnsRecordsFromDependencies } from "@/lib/launch";
import { createOfficialProviderContext, FileProviderIdempotencyLedger } from "@/lib/runtime";
import { FileWorkflowStore, type WorkflowBindings } from "@/lib/workflow";
import { syntheticProviderPlanFactories } from "./fixtures/provider/launch-runtime";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";

const temporaryDirectories: string[] = [];

function harness(
  withProductBindings = true,
  withProviderFactories = true,
  now: () => Date = () => new Date("2026-08-04T12:00:00.000Z"),
) {
  const root = mkdtempSync(join(tmpdir(), "vh-cli-launch-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  for (const file of [
    "policies.yaml",
    "providers.yaml",
    "venture.yaml",
    "mobile.yaml",
    "launch.yaml",
    "analytics.yaml",
    "loops.yaml",
    "offer.yaml",
  ]) {
    copyFileSync(join("config", file), join(root, "config", file));
  }
  const store = new FileWorkflowStore({ rootDir: join(root, ".venture/runs") });
  const calls = new Map<string, number>();
  const launchBindings = withProductBindings
    ? ({ definition }: LaunchBindingContext) => {
        const handlers: NonNullable<WorkflowBindings["handlers"]> = {};
        for (const node of definition.nodes) {
          if (!node.handler || node.kind === "provider" || node.handler === "launch.report") {
            continue;
          }
          handlers[node.handler] = ({ runId }) => {
            calls.set(node.handler!, (calls.get(node.handler!) ?? 0) + 1);
            const evidenceArtifact = `reports/launch/${runId}/product/${node.id}.json`;
            const evidencePath = join(root, evidenceArtifact);
            mkdirSync(join(root, `reports/launch/${runId}/product`), { recursive: true });
            writeFileSync(
              evidencePath,
              `${JSON.stringify({ synthetic: true, runId, nodeId: node.id })}\n`,
            );
            return {
              output: { synthetic: true, nodeId: node.id },
              effectVerified: node.effect === "none" || node.effect === "read" ? undefined : true,
              evidenceArtifact: node.evidence.required ? evidenceArtifact : undefined,
            };
          };
        }
        return { handlers };
      }
    : undefined;
  const redactor = new Redactor();
  redactor.addSecret("synthetic-cli-secret-never-persist");
  const providerOutput = (operation: ProviderOperation): Record<string, unknown> => {
    if (operation.action.endsWith(".search_before_create")) {
      return { data: [], has_more: false };
    }
    const body = operation.http?.body;
    const bodyRecord =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const output: Record<string, unknown> = {
      fixture: true,
      id: `fixture-${operation.provider}-${operation.capability}`,
      ...(bodyRecord ?? {}),
    };
    if (operation.capability === "domain") {
      output.verification = [
        {
          type: "CNAME",
          domain: "www.fixture.example.test",
          value: "fixture.vercel-dns.test",
          ttl: 300,
        },
      ];
    }
    if (operation.capability === "sending_domain") {
      Object.assign(output, {
        domain_name: "fixture.example.test",
        dns_records: {
          brevo_code: {
            type: "TXT",
            host_name: "@",
            value: "brevo-code=fixture-public-value",
            status: false,
          },
        },
      });
    }
    if (operation.capability === "site_verification_token") {
      Object.assign(output, {
        method: "DNS_TXT",
        token: "google-site-verification=fixture-public-value",
      });
    }
    if (operation.capability === "analytics_property") output.name = "properties/987654";
    if (operation.capability === "analytics_web_stream") {
      const webStreamData =
        bodyRecord?.webStreamData &&
        typeof bodyRecord.webStreamData === "object" &&
        !Array.isArray(bodyRecord.webStreamData)
          ? (bodyRecord.webStreamData as Record<string, unknown>)
          : {};
      Object.assign(output, {
        name: "properties/987654/dataStreams/fixture",
        webStreamData: { ...webStreamData, measurementId: "G-FIXTURE123" },
      });
    }
    return output;
  };
  const cliTransport = new MockProviderTransport("cli", async (operation) => ({
    status: "succeeded",
    message: "Synthetic CLI provider apply completed",
    output: providerOutput(operation),
    verified: true,
  }));
  const httpTransport = new MockProviderTransport("http", async (operation) => ({
    status: "succeeded",
    message: "Synthetic HTTP provider apply completed",
    output: providerOutput(operation),
    verified: true,
  }));
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
    label: "Synthetic writable Stripe webhook capture target",
  });
  credentialBroker.register({
    ref: "cred://google/measurement-id",
    provider: "google",
    kind: "ci_secret",
    backend: "memory",
    label: "Synthetic writable Google measurement capture target",
  });
  const services = createDefaultCliServices({
    rootDir: root,
    store,
    launchBindings,
    providerPlanFactories: withProviderFactories
      ? ({ definition }) => syntheticProviderPlanFactories(definition)
      : undefined,
    providerRuntimeContext: createOfficialProviderContext({
      credentials: credentialBroker,
      redactor,
      idempotencyLedger: new FileProviderIdempotencyLedger(
        join(root, ".venture/provider-idempotency.json"),
      ),
      additional: [cliTransport, httpTransport],
    }),
    now,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  return {
    root,
    store,
    services,
    calls,
    providerCalls: { cli: cliTransport.calls, http: httpTransport.calls },
    io,
    stdout,
    stderr,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("default vh launch services", () => {
  it("materializes the selected brief into canonical venture and mobile contracts", async () => {
    const { root, services, store, io, stdout } = harness();

    const result = await runCli(
      ["create", "--brief", resolve("fixtures/ios-subscription/brief.yaml")],
      { services, store, io },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({
      selectedMode: "product_first",
      updatedContracts: [
        "config/venture.yaml",
        "config/launch.yaml",
        "config/mobile.yaml",
        "config/analytics.yaml",
        "config/loops.yaml",
      ],
      activeEventPacks: [
        "core_product",
        "web_acquisition",
        "subscription",
        "content",
        "mobile",
        "feedback",
        "reliability",
      ],
    });
    const venture = ventureSchema.parse(
      parse(readFileSync(join(root, "config/venture.yaml"), "utf8")),
    );
    const mobile = mobileSchema.parse(
      parse(readFileSync(join(root, "config/mobile.yaml"), "utf8")),
    );
    const launch = launchSchema.parse(
      parse(readFileSync(join(root, "config/launch.yaml"), "utf8")),
    );
    const analytics = analyticsSchema.parse(
      parse(readFileSync(join(root, "config/analytics.yaml"), "utf8")),
    ) as unknown as {
      event_packs: { active: string[] };
      core_journeys: Record<string, { active: boolean }>;
    };
    const loops = loopsSchema.parse(parse(readFileSync(join(root, "config/loops.yaml"), "utf8")));
    expect(venture.venture).toMatchObject({
      name: "Synthetic iOS Subscription",
      stage: "build",
      app_kind: "hybrid",
      launch_mode: "product_first",
      mobile_stack: "expo_react_native",
      monetization_model: "subscription",
      outcomes: {
        primary: {
          statement: expect.any(String),
          success_signal: "synthetic_practice_session_completed",
        },
      },
    });
    expect(venture.venture.capabilities.active).toEqual(
      expect.arrayContaining(["app_store_connect", "eas", "ios_aso", "revenuecat"]),
    );
    expect(mobile.mobile).toMatchObject({
      stack: "expo_react_native",
      app_scheme: "synthetic-ios-subscription",
      app_store_connect: {
        first_app_record: {
          state: "required",
          manual_action_ref: "reports/launch/<run-id>/manual/apple-first-app-record.json",
        },
      },
    });
    expect(launch.launch).toMatchObject({
      selected_mode: "product_first",
      confidence: expect.any(Number),
      rail: { app_kind: "hybrid", mobile_stack: "expo_react_native" },
      progressive_commitment: {
        specific_user_or_audience: expect.any(String),
        primary_success_signal: "synthetic_practice_session_completed",
        blocking_issues: [],
      },
    });
    expect(analytics.event_packs.active).toEqual([
      "core_product",
      "web_acquisition",
      "subscription",
      "content",
      "mobile",
      "feedback",
      "reliability",
    ]);
    expect(
      Object.entries(analytics.core_journeys)
        .filter(([, journey]) => journey.active)
        .map(([journeyId]) => journeyId),
    ).toEqual(["core_product", "subscription", "mobile", "feedback"]);
    expect(loops.loops.weekly_growth.enabled).toBe(true);
    expect(loops.loops.daily_early_signal.next_run_at).toBe("2026-08-05T05:15:00.000Z");
    expect(loops.loops.weekly_growth.next_run_at).toBe("2026-08-10T05:25:00.000Z");
    expect(loops.loops.biweekly_product.next_run_at).toBe("2026-08-15T07:00:00.000Z");
    expect(loops.loops.monthly_strategy.next_run_at).toBe("2026-09-01T05:35:00.000Z");
    expect(loops.loops.weekly_growth.inputs).toEqual(
      expect.arrayContaining([
        { source: "neon_commercial_evidence", freshness_hours: 192, required: true },
        { source: "revenuecat", freshness_hours: 192, required: true },
        { source: "release_log", freshness_hours: 192, required: true },
      ]),
    );
    const project = JSON.parse(readFileSync(join(root, ".venture/project.json"), "utf8"));
    expect(project).toMatchObject({
      schemaVersion: 2,
      routerVersion: "0.2.0",
      decision: { briefId: "synthetic-ios-subscription" },
      activeEventPacks: analytics.event_packs.active,
    });
  });

  it("fails closed before rewriting contracts when a different venture is already selected", async () => {
    const { root, services, store, io, stderr } = harness();
    expect(
      (
        await runCli(["create", "--brief", resolve("fixtures/ios-subscription/brief.yaml")], {
          services,
          store,
          io,
        })
      ).exitCode,
    ).toBe(0);

    const result = await runCli(["create", "--brief", resolve("fixtures/web-saas/brief.yaml")], {
      services,
      store,
      io,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.at(-1)).toContain("fresh child directory");
    const project = JSON.parse(readFileSync(join(root, ".venture/project.json"), "utf8"));
    expect(project.brief.id).toBe("synthetic-ios-subscription");
    const venture = ventureSchema.parse(
      parse(readFileSync(join(root, "config/venture.yaml"), "utf8")),
    );
    expect(venture.venture.name).toBe("Synthetic iOS Subscription");
  });

  it("reads v0.1 project metadata and rewrites it with a routed v0.2 snapshot", async () => {
    const { root, services, store, io } = harness();
    const briefPath = resolve("fixtures/web-saas/brief.yaml");
    expect((await runCli(["create", "--brief", briefPath], { services, store, io })).exitCode).toBe(
      0,
    );
    const projectPath = join(root, ".venture/project.json");
    const current = JSON.parse(readFileSync(projectPath, "utf8"));
    writeFileSync(
      projectPath,
      `${JSON.stringify({ schemaVersion: 1, createdAt: current.createdAt, brief: current.brief }, null, 2)}\n`,
    );

    expect((await runCli(["plan", "--json"], { services, store, io })).exitCode).toBe(0);
    expect((await runCli(["create", "--brief", briefPath], { services, store, io })).exitCode).toBe(
      0,
    );
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      routerVersion: "0.2.0",
      decision: { briefId: "synthetic-web-saas" },
    });
  });

  it("rejects project and launch metadata whose stored brief diverges from its Launch Contract", async () => {
    const { root, services, store, io, stderr } = harness();
    const ideaPath = join(root, "idea.md");
    writeFileSync(ideaPath, renderFounderIdea(launchReceiptContract()));
    expect((await runCli(["create", "--brief", ideaPath], { services, store, io })).exitCode).toBe(
      0,
    );

    const projectPath = join(root, ".venture/project.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    expect(project.launchContractDigest).toBe(launchContractDigest(launchReceiptContract()));
    expect(readFileSync(join(root, "config/launch-contract.yaml"), "utf8")).toBe(
      renderLaunchContractYaml(launchReceiptContract()),
    );
    expect(readFileSync(join(root, "docs/product/PRODUCT_CONSTITUTION.md"), "utf8")).toBe(
      renderProductConstitution(launchReceiptContract()),
    );

    const diskContractPath = join(root, "config/launch-contract.yaml");
    writeFileSync(
      diskContractPath,
      renderLaunchContractYaml({
        ...launchReceiptContract(),
        venture: {
          ...launchReceiptContract().venture,
          differentiation: "A tampered non-projected differentiator",
        },
      }),
    );
    expect((await runCli(["plan", "--json"], { services, store, io })).exitCode).toBe(1);
    expect(stderr.at(-1)).toContain("on-disk Launch Contract");
    writeFileSync(diskContractPath, renderLaunchContractYaml(launchReceiptContract()));

    const constitutionPath = join(root, "docs/product/PRODUCT_CONSTITUTION.md");
    writeFileSync(constitutionPath, "# Replaced constitution\n");
    expect((await runCli(["plan", "--json"], { services, store, io })).exitCode).toBe(1);
    expect(stderr.at(-1)).toContain("Product Constitution");
    writeFileSync(constitutionPath, renderProductConstitution(launchReceiptContract()));

    const manifestPath = join(root, "venture.manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        launchContractPath: "config/launch-contract.yaml",
        launchContractDigest: "0".repeat(64),
      })}\n`,
    );
    expect((await runCli(["plan", "--json"], { services, store, io })).exitCode).toBe(1);
    expect(stderr.at(-1)).toContain("Venture Manifest");
    rmSync(manifestPath);

    writeFileSync(
      projectPath,
      `${JSON.stringify({ ...project, brief: { ...project.brief, name: "Tampered name" } }, null, 2)}\n`,
    );
    expect((await runCli(["plan", "--json"], { services, store, io })).exitCode).toBe(1);
    expect(stderr.at(-1)).toContain("Launch Contract does not match");

    writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    const runId = "launch-contract-binding";
    expect(
      (
        await runCli(["launch", "--apply", "--authorization", "build-local", "--run-id", runId], {
          services,
          store,
          io,
        })
      ).exitCode,
    ).toBe(0);
    const metadataPath = join(root, `.venture/launches/${runId}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    writeFileSync(
      metadataPath,
      `${JSON.stringify({ ...metadata, brief: { ...metadata.brief, name: "Tampered name" } }, null, 2)}\n`,
    );

    expect((await runCli(["cancel", runId], { services, store, io })).exitCode).toBe(1);
    expect(stderr.at(-1)).toContain("Launch Contract does not match");
  });

  it("runs build-local without creating provider or manual-action nodes", async () => {
    const { services, store, io, stdout, providerCalls } = harness();
    await runCli(["create", "--brief", resolve("fixtures/web-saas/brief.yaml")], {
      services,
      store,
      io,
    });

    const result = await runCli(
      ["launch", "--apply", "--authorization", "build-local", "--run-id", "launch-build-local"],
      { services, store, io },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ status: "succeeded" });
    const state = store.load("launch-build-local");
    expect(
      Object.values(state.nodes).some(
        ({ definition }) => definition.kind === "provider" || definition.kind === "manual_action",
      ),
    ).toBe(false);
    expect(providerCalls.cli).toHaveLength(0);
    expect(providerCalls.http).toHaveLength(0);
  });

  it("renews an expired persisted envelope explicitly without changing the run graph", async () => {
    let currentTime = new Date("2026-08-04T12:00:00.000Z");
    const { root, services, store, io, stdout, stderr } = harness(true, true, () => currentTime);
    await runCli(["create", "--brief", resolve("fixtures/web-saas/brief.yaml")], {
      services,
      store,
      io,
    });
    const launched = await runCli(
      [
        "launch",
        "--apply",
        "--authorization",
        "live-commerce-launch",
        "--run-id",
        "launch-renewal",
      ],
      { services, store, io },
    );
    expect(
      launched.exitCode,
      `${stderr.join("\n")} ${JSON.stringify(
        Object.fromEntries(
          Object.entries(store.load("launch-renewal").nodes)
            .filter(([, record]) => record.state === "failed_terminal")
            .map(([id, record]) => [id, record.error]),
        ),
      )}`,
    ).toBe(0);
    expect(JSON.parse(stdout.pop()!).status).toBe("waiting");
    const launchMetadataPath = join(root, ".venture/launches/launch-renewal.json");
    const originalMetadata = JSON.parse(readFileSync(launchMetadataPath, "utf8"));
    expect(originalMetadata.authorization.allowed_capabilities).not.toContain("*");
    const originalFingerprint = store.load("launch-renewal").graph.fingerprint;

    currentTime = new Date("2026-08-04T14:00:00.000Z");
    const expired = await runCli(["resume", "launch-renewal"], { services, store, io });
    expect(expired.exitCode).toBe(1);
    expect(stderr.at(-1)).toContain("--authorization live-commerce-launch");

    const renewed = await runCli(
      ["resume", "launch-renewal", "--authorization", "live-commerce-launch"],
      { services, store, io },
    );
    expect(renewed.exitCode).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ runId: "launch-renewal", status: "waiting" });
    const renewedMetadata = JSON.parse(readFileSync(launchMetadataPath, "utf8"));
    expect(renewedMetadata.authorization).toMatchObject({
      run_id: "launch-renewal",
      profile: "live_commerce_launch",
      issued_at: "2026-08-04T14:00:00.000Z",
      expires_at: "2026-08-04T15:00:00.000Z",
      approval_ref: "cli:vh-resume:live-commerce-launch",
    });
    expect(renewedMetadata.authorization.allowed_capabilities).toEqual(
      originalMetadata.authorization.allowed_capabilities,
    );
    expect(store.load("launch-renewal").graph.fingerprint).toBe(originalFingerprint);
  });

  it("creates, plans, dry-runs, applies, resolves manual evidence, and resumes one run", async () => {
    const { root, services, store, calls, providerCalls, io, stdout, stderr } = harness();
    const brief = resolve("fixtures/web-saas/brief.yaml");

    expect((await runCli(["create", "--brief", brief], { services, store, io })).exitCode).toBe(0);
    expect(JSON.parse(stdout.pop()!).selectedMode).toBe("thin_mvp");
    mkdirSync(join(root, ".venture/reports/quality"), { recursive: true });
    writeFileSync(
      join(root, ".venture/reports/quality/mvp-latest.json"),
      `${JSON.stringify({
        results: [
          { id: "typecheck", status: "PASS", detail: "TypeScript exited 0.", gap: null },
          {
            id: "live_readback",
            status: "SKIP",
            detail: "Provider authorization is absent.",
            gap: {
              missing: "A verified synthetic provider credential reference.",
              exact_command: "pnpm vh doctor",
              expected_evidence: "Sanitized provider read-back evidence.",
            },
          },
        ],
      })}\n`,
    );

    expect((await runCli(["plan", "--json"], { services, store, io })).exitCode).toBe(0);
    expect(JSON.parse(stdout.pop()!).graph.nodes.length).toBeGreaterThan(10);
    expect((await runCli(["launch", "--dry-run"], { services, store, io })).exitCode).toBe(0);
    expect(
      JSON.parse(stdout.pop()!).manualActions.map((action: { nodeId: string }) => action.nodeId),
    ).toContain("dns-records");

    expect(
      (
        await runCli(
          [
            "launch",
            "--apply",
            "--authorization",
            "live-commerce-launch",
            "--run-id",
            "launch-synthetic-web",
          ],
          { services, store, io },
        )
      ).exitCode,
      stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(stdout.pop()!).status).toBe("waiting");
    expect(store.load("launch-synthetic-web").nodes["production-deploy"].state).toBe("succeeded");
    expect(store.load("launch-synthetic-web").nodes["verify-production"].state).toBe("succeeded");
    expect(store.load("launch-synthetic-web").nodes["launch-report"].state).toBe("succeeded");
    const waitingReportPath = join(root, "reports/launch/launch-synthetic-web/final.json");
    expect(existsSync(waitingReportPath)).toBe(true);
    expect(JSON.parse(readFileSync(waitingReportPath, "utf8"))).toMatchObject({
      overallState: "waiting",
      launch: {
        mode: "thin_mvp",
        paymentProvider: "stripe",
        entitlementSource: "stripe",
        activeEventPacks: expect.arrayContaining([
          "core_product",
          "authentication",
          "onboarding",
          "subscription",
          "reliability",
        ]),
        consentMode: "strict",
      },
      remainingManualActions: [{ nodeId: "dns-records" }],
      sections: {
        checksRun: expect.arrayContaining([
          expect.stringContaining("verify-local: succeeded"),
          expect.stringContaining("verify-launch: succeeded"),
          expect.stringContaining("verify-production: succeeded"),
        ]),
        scheduledLoops: expect.arrayContaining([
          expect.stringContaining("daily_early_signal: enabled"),
          expect.stringContaining("weekly_growth: enabled"),
          expect.stringContaining("biweekly_product: enabled"),
          expect.stringContaining("monthly_strategy: enabled"),
        ]),
        nextReviews: expect.arrayContaining([
          "daily_early_signal: 2026-08-05T05:15:00.000Z",
          "weekly_growth: 2026-08-10T05:25:00.000Z",
          "biweekly_product: 2026-08-15T07:00:00.000Z",
          "monthly_strategy: 2026-09-01T05:35:00.000Z",
        ]),
      },
    });

    const manualEvidence = "reports/launch/launch-synthetic-web/manual/dns-records.json";
    mkdirSync(join(root, "reports/launch/launch-synthetic-web/manual"), { recursive: true });
    writeFileSync(
      join(root, manualEvidence),
      `${JSON.stringify(
        {
          schema_version: 1,
          kind: "manual_action_evidence",
          run_id: "launch-synthetic-web",
          node_id: "dns-records",
          status: "verified",
          approved_by: "vh-cli-user",
          verified_at: "2026-08-04T12:00:00.000Z",
          output: {
            mode: "manual_dns",
            records: expectedDnsRecordsFromDependencies(
              Object.fromEntries(
                store
                  .load("launch-synthetic-web")
                  .nodes["dns-records"].definition.dependencies.map((dependency) => [
                    dependency,
                    store.load("launch-synthetic-web").nodes[dependency]?.output,
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
          },
          verification: ["Synthetic typed evidence only; no provider state is claimed."],
          limitations: ["Synthetic fixture."],
        },
        null,
        2,
      )}\n`,
    );
    const resumeResult = await runCli(
      ["resume", "launch-synthetic-web", "--manual", "dns-records", "--evidence", manualEvidence],
      { services, store, io },
    );
    expect(resumeResult.exitCode, stderr.join("\n")).toBe(0);
    expect(JSON.parse(stdout.pop()!).status).toBe("succeeded");
    const completedCalls = [...calls.entries()];
    const completedProviderCalls = {
      cli: providerCalls.cli.length,
      http: providerCalls.http.length,
    };
    await runCli(["resume", "launch-synthetic-web"], { services, store, io });
    expect([...calls.entries()]).toEqual(completedCalls);
    expect(providerCalls.cli).toHaveLength(completedProviderCalls.cli);
    expect(providerCalls.http).toHaveLength(completedProviderCalls.http);
    expect(JSON.parse(readFileSync(waitingReportPath, "utf8"))).toMatchObject({
      overallState: "succeeded",
      remainingManualActions: [],
    });
    expect(existsSync(join(root, "reports/launch/launch-synthetic-web/final.md"))).toBe(true);
    expect(readFileSync(waitingReportPath, "utf8")).not.toContain(
      "synthetic-cli-secret-never-persist",
    );
    expect(existsSync(join(root, "reports/launch/launch-synthetic-web/providers"))).toBe(true);
  });

  it("preserves missing provider auth as a durable wait before any provider call", async () => {
    const { root, services, store, io, stdout, providerCalls } = harness(true, false);
    await runCli(["create", "--brief", resolve("fixtures/web-saas/brief.yaml")], {
      services,
      store,
      io,
    });
    const result = await runCli(
      [
        "launch",
        "--apply",
        "--authorization",
        "live-commerce-launch",
        "--run-id",
        "launch-no-runtime",
      ],
      { services, store, io },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ status: "waiting" });
    const state = store.load("launch-no-runtime");
    expect(state.nodes["github-repository"]).toMatchObject({
      state: "waiting_for_auth",
      error: { code: "AUTH_REQUIRED" },
    });
    expect(state.nodes["github-repository"].error?.message).toContain(
      "config/providers.yaml providers.github.credential_ref",
    );
    expect(providerCalls.cli).toHaveLength(0);
    expect(providerCalls.http).toHaveLength(0);
    expect(existsSync(join(root, "reports/launch/launch-no-runtime/final.json"))).toBe(true);
    expect((await runCli(["resume", "launch-no-runtime"], { services, store, io })).exitCode).toBe(
      0,
    );
  });
});
