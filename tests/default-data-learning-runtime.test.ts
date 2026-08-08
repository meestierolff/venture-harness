import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialBroker,
  MemoryCredentialBackend,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
} from "@/lib/credentials";
import {
  createDefaultDataLearningRuntime,
  deriveLearningMetrics,
  type LearningLoopDefinition,
} from "@/lib/learning";

const temporaryDirectories: string[] = [];
const now = new Date("2026-08-04T12:00:00.000Z");
const connectionSecret =
  "postgresql://venture:super-secret-password@ep-test.neon.tech/venture?sslmode=require&channel_binding=require";

class FakeRunner implements CommandRunner {
  readonly calls: CommandInvocation[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.calls.push(invocation);
    const result = this.results.shift();
    if (!result) throw new Error("No fake command result is queued.");
    return result;
  }
}

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-default-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function brokerWithConnection() {
  const broker = new CredentialBroker([new MemoryCredentialBackend()]);
  await broker.store({
    ref: "cred://neon/commercial-read",
    provider: "neon",
    kind: "connection_string",
    backend: "memory",
    scopes: ["commercial_evidence:read"],
    value: connectionSecret,
  });
  return broker;
}

function writeReleaseLog(directory: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(directory, "reports/releases"), { recursive: true });
  writeFileSync(
    join(directory, "reports/releases/release-log.jsonl"),
    `${JSON.stringify({
      release_id: "release-020",
      released_at: "2026-08-03T10:00:00.000Z",
      release_version: "0.2.0",
      environment: "production",
      status: "succeeded",
      change_kind: "code",
      journey_id: "lead-submission",
      incident_count: 0,
      ...extra,
    })}\n`,
  );
}

function loopDefinition(): LearningLoopDefinition {
  return {
    id: "weekly-direct-evidence",
    cadence: "weekly",
    requiredSources: [
      { source: "neon_commercial_evidence", freshnessHours: 24 },
      { source: "release_log", freshnessHours: 24 * 30 },
    ],
    primaryMetrics: ["primary_success_signal"],
    guardrailMetrics: [],
    decisionRules: ["Review the predeclared primary threshold descriptively."],
    maximumActions: 3,
    maximumIterations: 1,
    autonomy: "propose",
    authorizedEffectTypes: ["none", "local_write", "git_write"],
    outputDestination: "reports/learning/weekly",
    nextRunAt: null,
    stopCondition: "Stop when required evidence is missing or stale.",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("default direct-data and learning runtime", () => {
  it("syncs aggregate Neon and categorical release evidence into a complete bounded report", async () => {
    const directory = root();
    writeReleaseLog(directory);
    const broker = await brokerWithConnection();
    const runner = new FakeRunner([
      {
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
      },
    ]);
    const runtime = createDefaultDataLearningRuntime({
      rootDir: directory,
      broker,
      commandRunner: runner,
      timezone: "Europe/Amsterdam",
      neon: {
        credentialRef: "cred://neon/commercial-read",
        sourceAccount: "neon-project-fixture/production",
        windowHours: 24,
        releaseVersion: "0.2.0",
      },
      releaseLog: { required: true, windowHours: 24 * 30 },
      metricDefinitions: [
        {
          id: "primary_success_signal",
          source: "neon_commercial_evidence",
          filter: {
            record_type: "commercial",
            metric_id: "form_submission_confirmed",
          },
          value: { operation: "sum", field: "qualified_count" },
          sampleSizeField: "sample_size",
        },
      ],
      candidateRules: [
        {
          id: "review-lead-journey",
          metricId: "primary_success_signal",
          comparator: "lte",
          threshold: 5,
          minimumSampleSize: 5,
          journey: "lead-submission",
          title: "Review one lead-journey hypothesis",
          confidence: 0.8,
          risk: "moderate",
        },
      ],
      maximumCandidates: 1,
    });

    const sync = await runtime.sync({ now });
    const inputs = runtime.derive(sync.datasets);
    const report = runtime.learn({ definition: loopDefinition(), syncResult: sync, now });

    expect(sync.failures).toEqual([]);
    expect(sync.freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "neon_commercial_evidence", status: "fresh" }),
        expect.objectContaining({ source: "release_log", status: "fresh" }),
      ]),
    );
    expect(inputs.metrics).toEqual([
      expect.objectContaining({
        id: "primary_success_signal",
        value: 3,
        sampleSize: 10,
        source: "neon_commercial_evidence",
      }),
    ]);
    expect(deriveLearningMetrics(sync.datasets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "commercial.form_submission_confirmed.count",
          value: 4,
          sampleSize: 10,
        }),
        expect.objectContaining({ id: "release.total", value: 1 }),
      ]),
    );
    expect(inputs.candidates).toHaveLength(1);
    expect(inputs.candidates[0].rationale).toContain("does not establish cause");
    expect(report).toMatchObject({ status: "complete", actions: [{ disposition: "propose" }] });
    expect(JSON.stringify(sync)).toContain("€49/month");
    expect(JSON.stringify(sync)).not.toContain("super-secret-password");

    const invocation = runner.calls[0];
    expect(invocation.command).toBe("psql");
    expect(invocation.args).toContain("--no-psqlrc");
    expect(invocation.args.join(" ")).not.toContain(connectionSecret);
    expect(invocation.args.join(" ")).not.toContain("super-secret-password");
    expect(invocation.env).toMatchObject({
      PGHOST: "ep-test.neon.tech",
      PGDATABASE: "venture",
      PGUSER: "venture",
      PGPASSWORD: "super-secret-password",
      PGSSLMODE: "require",
      PGCHANNELBINDING: "require",
    });
    expect(invocation.sensitiveEnv).toContain("PGPASSWORD");
  });

  it("keeps a missing source distinct from an observed zero", async () => {
    const directory = root();
    writeReleaseLog(directory);
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    const runtime = createDefaultDataLearningRuntime({
      rootDir: directory,
      broker,
      commandRunner: new FakeRunner([]),
      timezone: "UTC",
      neon: {
        credentialRef: "cred://neon/missing",
        sourceAccount: "neon-project-fixture/production",
        windowHours: 24,
      },
      releaseLog: { required: true },
      metricDefinitions: [
        {
          id: "primary_success_signal",
          source: "neon_commercial_evidence",
          filter: { metric_id: "form_submission_confirmed" },
          value: { operation: "sum", field: "event_count" },
          sampleSizeField: "sample_size",
        },
      ],
    });

    const sync = await runtime.sync({ now });
    const inputs = runtime.derive(sync.datasets);
    const report = runtime.learn({ definition: loopDefinition(), syncResult: sync, now });

    expect(sync.freshness).toContainEqual(
      expect.objectContaining({
        source: "neon_commercial_evidence",
        status: "missing",
        fetchedAt: null,
        ageHours: null,
      }),
    );
    expect(inputs.metrics.find(({ id }) => id === "primary_success_signal")).toBeUndefined();
    expect(report.status).toBe("insufficient_evidence");
    expect(report.metrics).toEqual([]);
    expect(report.limitations.join(" ")).toContain("missing is not zero");

    const observedZero = createDefaultDataLearningRuntime({
      rootDir: directory,
      broker: await brokerWithConnection(),
      commandRunner: new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]),
      timezone: "UTC",
      neon: {
        credentialRef: "cred://neon/commercial-read",
        sourceAccount: "neon-project-fixture/production",
        windowHours: 24,
      },
      releaseLog: false,
      metricDefinitions: [
        {
          id: "primary_success_signal",
          source: "neon_commercial_evidence",
          filter: { metric_id: "form_submission_confirmed" },
          value: { operation: "sum", field: "event_count" },
          sampleSizeField: "sample_size",
        },
      ],
    });
    const zeroSync = await observedZero.sync({ now });
    expect(observedZero.derive(zeroSync.datasets).metrics).toEqual([
      expect.objectContaining({ id: "primary_success_signal", value: 0, sampleSize: 0 }),
    ]);
  });

  it("redacts a failed psql response and rejects free-form release fields", async () => {
    const directory = root();
    writeReleaseLog(directory, { message: "private release note" });
    const broker = await brokerWithConnection();
    const runner = new FakeRunner([
      {
        exitCode: 2,
        stdout: "",
        stderr: "connection failed for super-secret-password",
      },
    ]);
    const runtime = createDefaultDataLearningRuntime({
      rootDir: directory,
      broker,
      commandRunner: runner,
      timezone: "UTC",
      neon: {
        credentialRef: "cred://neon/commercial-read",
        sourceAccount: "neon-project-fixture/production",
      },
      releaseLog: { required: true },
    });

    const sync = await runtime.sync({ now });

    expect(sync.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "neon_commercial_evidence", code: "provider_failed" }),
        expect.objectContaining({ source: "release_log", code: "invalid_data" }),
      ]),
    );
    expect(JSON.stringify(sync)).not.toContain(connectionSecret);
    expect(JSON.stringify(sync)).not.toContain("super-secret-password");
    expect(sync.datasets).toEqual([]);
  });
});
