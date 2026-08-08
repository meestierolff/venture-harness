import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import {
  CredentialBroker,
  MemoryCredentialBackend,
  type CommandInvocation,
  type CommandRunner,
} from "@/lib/credentials";
import { FileWorkflowStore } from "@/lib/workflow";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("default CLI learning reports", () => {
  it("persists an honest insufficient-evidence report when no direct data is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-cli-learning-"));
    temporaryDirectories.push(root);
    const services = createDefaultCliServices({
      rootDir: root,
      store: new FileWorkflowStore({ rootDir: join(root, ".venture/runs") }),
      dataRequirements: [
        { source: "neon_commercial_evidence", required: true, freshnessHours: 24 },
      ],
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    const sync = (await services.dataSync!()) as { status: string; freshness: unknown[] };
    expect(sync.status).toBe("not_configured");
    expect(sync.freshness).toHaveLength(1);
    expect(existsSync(join(root, ".venture/data/latest.json"))).toBe(true);

    const result = (await services.learn!("weekly")) as {
      status: string;
      limitations: string[];
      artifacts: { json: string; markdown: string; latestJson: string };
      operatingCadence: { missingDataSources: string[]; activeBlockers: string[] };
      operatingCadenceArtifacts: { json: string; markdown: string };
    };

    expect(result.status).toBe("insufficient_evidence");
    expect(result.limitations.join(" ")).toContain("missing is not zero");
    expect(result.artifacts.latestJson).toBe("reports/learning/weekly/latest.json");
    expect(existsSync(join(root, result.artifacts.json))).toBe(true);
    expect(existsSync(join(root, result.artifacts.markdown))).toBe(true);
    expect(result.operatingCadence.missingDataSources).toEqual(["neon_commercial_evidence"]);
    expect(result.operatingCadence.activeBlockers).toEqual([
      expect.stringContaining("data_sync:not_configured"),
    ]);
    expect(existsSync(join(root, result.operatingCadenceArtifacts.json))).toBe(true);
    expect(existsSync(join(root, result.operatingCadenceArtifacts.markdown))).toBe(true);

    const biweekly = (await services.learn!("biweekly")) as {
      status: string;
      artifacts: { latestJson: string };
    };
    expect(biweekly.status).toBe("insufficient_evidence");
    expect(biweekly.artifacts.latestJson).toBe("reports/learning/biweekly/latest.json");
    expect(existsSync(join(root, biweekly.artifacts.latestJson))).toBe(true);
  });

  it("composes verified Neon and release-log config into a complete sync and bounded report", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-cli-learning-configured-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, ".venture"), { recursive: true });
    mkdirSync(join(root, "reports/releases"), { recursive: true });
    writeFileSync(
      join(root, "config/loops.yaml"),
      `contract_version: 1
loops:
  weekly_growth:
    cadence: weekly
    enabled: true
    trigger: { kind: cron, expression: "25 5 * * 1" }
    inputs:
      - { source: neon_commercial_evidence, freshness_hours: 24, required: true }
      - { source: release_log, freshness_hours: 720, required: true }
    primary_metrics:
      - { id: primary_success_signal, direction: increase }
    metric_definitions:
      - id: primary_success_signal
        source: neon_commercial_evidence
        filter: { record_type: commercial, metric_id: form_submission_confirmed }
        operation: sum
        field: qualified_count
        sample_size_field: sample_size
        limitation: null
    candidate_rules:
      - id: review-lead-journey
        metric_id: primary_success_signal
        comparator: lte
        threshold: 5
        minimum_sample_size: 5
        journey: lead-submission
        title: Review one lead-journey hypothesis
        confidence: 0.8
        risk: moderate
    maximum_actions: 1
    autonomy: propose
    output_destination: reports/learning/weekly
extensions: {}
`,
    );
    writeFileSync(
      join(root, "config/providers.yaml"),
      `contract_version: 1
providers:
  neon:
    state: unconfigured
    capability_ids: [database]
    external_resource_ids:
      database_credential_ref: cred://neon/database
    selected_transport: cli
    credential_ref: cred://neon/database
extensions: {}
`,
    );
    writeFileSync(
      join(root, ".venture/provider-lifecycle.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            provider: "neon",
            environment: "production",
            capability: "database",
            state: "verified",
            planId: "plan.neon.database",
            verifiedAt: "2026-08-04T10:00:00.000Z",
            resourceRefs: [
              { type: "project_id", value: "project-fixture" },
              { type: "database_name", value: "venture" },
            ],
          },
        ],
      })}\n`,
    );
    writeFileSync(
      join(root, "reports/releases/release-log.jsonl"),
      `${JSON.stringify({
        release_id: "release-020",
        released_at: "2026-08-03T10:00:00.000Z",
        release_version: "0.2.0",
        environment: "production",
        status: "succeeded",
        change_kind: "code",
        journey_id: "lead-submission",
        incident_count: 0,
      })}\n`,
    );

    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: "cred://neon/database",
      provider: "neon",
      kind: "connection_string",
      backend: "memory",
      scopes: ["commercial_evidence:read"],
      value: "postgresql://venture:test-password@ep-test.neon.tech/venture?sslmode=require",
    });
    const calls: CommandInvocation[] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            record_type: "commercial",
            metric_id: "form_submission_confirmed",
            event_count: 4,
            sample_size: 10,
            qualified_count: 3,
            price_contexts: [
              { plan_key: "pilot", displayed_price: "€49/month", billing_period: "monthly" },
            ],
            release_versions: ["0.2.0"],
          })}\n`,
          stderr: "",
        };
      },
    };
    const services = createDefaultCliServices({
      rootDir: root,
      store: new FileWorkflowStore({ rootDir: join(root, ".venture/runs") }),
      credentialBroker: broker,
      dataCommandRunner: runner,
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    const sync = (await services.dataSync!()) as {
      status: string;
      datasets: unknown[];
      failures: unknown[];
    };
    const result = (await services.learn!("weekly")) as {
      status: string;
      metrics: { id: string; value: number }[];
      actions: { id: string; disposition: string }[];
      artifacts: { latestJson: string };
      operatingCadence: { missingDataSources: string[]; activeBlockers: string[] };
      operatingCadenceArtifacts: { markdown: string };
    };

    expect(sync).toMatchObject({ status: "complete", failures: [] });
    expect(sync.datasets).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "complete",
      metrics: [{ id: "primary_success_signal", value: 3 }],
      actions: [{ id: "review-lead-journey", disposition: "propose" }],
    });
    expect(existsSync(join(root, result.artifacts.latestJson))).toBe(true);
    expect(result.operatingCadence).toMatchObject({
      missingDataSources: [],
      activeBlockers: [],
    });
    expect(existsSync(join(root, result.operatingCadenceArtifacts.markdown))).toBe(true);
    expect(JSON.stringify({ sync, result })).not.toContain("test-password");

    const latestDataPath = join(root, ".venture/data/latest.json");
    const tampered = JSON.parse(readFileSync(latestDataPath, "utf8")) as {
      datasets: { rows: Record<string, unknown>[] }[];
    };
    tampered.datasets[0].rows[0].email = "private@example.test";
    writeFileSync(latestDataPath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => services.learn!("weekly")).toThrow(/prohibited private field/i);
  });
});
