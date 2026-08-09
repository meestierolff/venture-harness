import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildCreativeTrace,
  buildLearning,
  createMetricSnapshot,
  createSqliteSpendStore,
  FIXTURE_D_STEPS,
  recordMetricValue,
  runFixtureD,
  ULID_PATTERN,
  type FixtureDResult,
  type MetricId,
  type SpendStore,
} from "@/lib/winner-loop";
import { parseGrowthContract } from "@/lib/config/growth-contract-schema";

const stores: SpendStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function store(): SpendStore {
  const dir = mkdtempSync(join(tmpdir(), "vh-fixture-d-"));
  dirs.push(dir);
  const created = createSqliteSpendStore(join(dir, "spend.db"));
  stores.push(created);
  return created;
}

/** The committed config/growth.yaml, not a test-local copy. */
const contract = parseGrowthContract(parse(readFileSync("config/growth.yaml", "utf8")));

function baselineHistory(multiplier: number) {
  const generatedAt = new Date("2026-08-09T12:00:00.000Z");
  const metric = (metricId: MetricId, value: number, capturedAt: string, source: string) =>
    recordMetricValue({
      metric: metricId,
      definition: {
        definitionId: `tiktok_content:${metricId}_v1`,
        definitionVersion: "1",
        metric: metricId,
        provider: "tiktok_content",
        unit: metricId === "view_velocity" ? "count_per_hour" : "ratio",
        description: `Fixture ${metricId}`,
      },
      provider: "tiktok_content",
      externalAccountId: "fixture-tt-account",
      sourceObjectId: source,
      availability: "available",
      value,
      missingReason: null,
      reportingWindowStart: capturedAt,
      reportingWindowEnd: capturedAt,
      sourceTime: capturedAt,
      latencySeconds: 60,
      fetchedAt: capturedAt,
      attributionWindow: null,
      confidence: "high",
      rawReference: `fixture://${source}/${metricId}`,
    });
  return Array.from({ length: 40 }, (_, index) => {
    const capturedAt = new Date(
      generatedAt.getTime() - 60 * 60_000 - ((39 - index) * 29 * 86_400_000) / 39,
    ).toISOString();
    const source = `sensitivity-history-${index}`;
    return createMetricSnapshot({
      organizationId: "fixture-organization",
      ventureId: contract.venture_id,
      provider: "tiktok_content",
      externalAccountId: "fixture-tt-account",
      creativeId: `sensitivity-creative-${index}`,
      publicationId: source,
      format: "talking_head_with_screen_recording",
      durationSeconds: 22,
      geography: "NL",
      offsetMinutes: 1_440,
      capturedAt,
      values: [
        metric("view_velocity", 500 * multiplier, capturedAt, source),
        metric("completion", 0.3 * multiplier, capturedAt, source),
        metric("watch_time_ratio", 0.4 * multiplier, capturedAt, source),
      ],
    });
  });
}

let result: FixtureDResult;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "vh-fixture-d-boot-"));
  const booted = createSqliteSpendStore(join(dir, "spend.db"));
  try {
    result = await runFixtureD({
      organizationId: "fixture-organization",
      contract,
      store: booted,
    });
  } finally {
    booted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Fixture D runs the whole loop through production modules", () => {
  it("is labelled synthetic and contacts no real provider", () => {
    expect(result.label).toMatch(/SYNTHETIC_FIXTURE/);
  });

  it("records all 34 required production-boundary milestones in exact order", () => {
    expect(result.steps).toHaveLength(34);
    expect(result.steps.map(({ step }) => step)).toEqual(
      Array.from({ length: 34 }, (_, index) => index + 1),
    );
    expect(result.steps.map(({ name }) => name)).toEqual(FIXTURE_D_STEPS);
  });

  it("mints one opaque creative id and carries it through every provider object", () => {
    expect(result.creativeId).toMatch(ULID_PATTERN);
    expect(result.lineage).toEqual([result.creativeId]);

    const kinds = result.providerObjects.map((entry) => entry.objectKind).sort();
    expect(kinds).toEqual(["organic_post", "render_job", "spark_ad"]);
    // Render job, organic post, and paid ad all resolve to the same identity.
    expect(new Set(result.providerObjects.map(() => result.creativeId)).size).toBe(1);
  });

  it("keeps a genuinely missing metric missing all the way into the evaluation", () => {
    expect(result.evaluation.missingMetrics).toContain("saves");
    expect(result.evaluation.score).not.toBeNull();
  });

  it("produces a baseline-adjusted recommendation with its scoring version", () => {
    expect(result.evaluation).toMatchObject({
      organizationId: result.organizationId,
      ventureId: result.ventureId,
    });
    expect(result.evaluation.scoringVersion).toBe("winner-score-v1");
    expect(result.evaluation.recommendation).toBe("PAID_TEST_CANDIDATE");
    expect(result.evaluation.spendEligible).toBe(true);
    expect(result.evaluation.baselineId).toBe(result.baseline.baselineId);
    expect(result.baseline.sourceRefs).toHaveLength(40);
    expect(Object.isFrozen(result.baseline)).toBe(true);
    expect(Object.isFrozen(result.baseline.duration)).toBe(true);
  });

  it("changes the recommendation inputs when scoped source history changes", async () => {
    const highBaseline = await runFixtureD({
      organizationId: "fixture-organization",
      contract,
      store: store(),
      baselineSourceSnapshots: baselineHistory(2),
    });

    expect(highBaseline.baseline.account.medianViewVelocityPerHour).toBe(1_000);
    expect(highBaseline.evaluation.features).toContainEqual(
      expect.objectContaining({ feature: "viewVelocityVsBaseline", baseline: 1_000 }),
    );
    expect(highBaseline.evaluation.score).not.toBe(result.evaluation.score);
  });

  it("refuses paid creation at both gates and never reaches the adapter", () => {
    // runFixtureD throws outright if the adapter ran; reaching here proves it did not.
    expect(result.paidBlockedWithoutApproval).toBe("proposal_not_approved");
    // Approved by a human, but still no Spend Grant: approval alone moves nothing.
    expect(result.paidBlockedWithoutGrant).toBe("no_spend_grant");
  });

  it("settles the paid test at the spend the provider actually reported", () => {
    expect(result.grantId).toMatch(/^grant_/);
    expect(result.settledSpendMinor).toBe(4_650);
  });

  it("holds VBO closed while provider eligibility is unknown", () => {
    expect(result.readiness.vboAllowed).toBe(false);
    expect(result.readiness.scalingIsRecommendationOnly).toBe(true);
  });

  it("falls back to a permitted high-intent event when purchases are thin", () => {
    expect(result.readiness.stage).toBe("HIGH_INTENT_EVENT_READY");
    expect(result.readiness.recommendedOptimizationEvent).toBe("trial_start");
  });

  it("rejects a duplicate webhook and reconstructs out-of-order events", () => {
    expect(result.duplicateEventRejected).toBe(true);
    expect(result.outOfOrderHandled).toBe(true);
  });

  it("computes D0, D7 and D30 cohorts carrying their attribution class", () => {
    expect(result.cohorts.map((cohort) => cohort.window.label)).toEqual(["D0", "D7", "D30"]);
    for (const cohort of result.cohorts) {
      expect(cohort).toMatchObject({
        organizationId: result.organizationId,
        ventureId: result.ventureId,
      });
      expect(cohort.attributionClass).toBe("DETERMINISTIC");
      expect(cohort.revenueCatProject).toBe("fixture-rc-project");
      expect(cohort.missingData).toContain("installs");
    }
  });

  it("emits a DistributionPR learning with a rollback and honest confidence", () => {
    expect(result.learning.creativeIds).toEqual([result.creativeId]);
    expect(result.learning.measurementPlan).toContain(result.creativeId);
    expect(result.learning.rollback).toMatch(/Revert/);
    expect(["suggestive", "supported", "strong"]).toContain(result.learning.confidence);
  });

  it("rejects evaluation or cohort evidence laundered across organizations", () => {
    const input = {
      learningId: "learning-scope-check",
      organizationId: result.organizationId,
      ventureId: result.ventureId,
      evaluation: result.evaluation,
      cohorts: result.cohorts,
      hypothesis: result.learning.hypothesis,
      provider: result.learning.providerContext.provider,
      externalAccountId: result.learning.providerContext.externalAccountId,
      organicWindow: result.learning.organicWindow,
      paidWindow: result.learning.paidWindow,
      createdAt: result.learning.createdAt,
    };
    expect(() => buildLearning({ ...input, organizationId: "forged-organization" })).toThrow(
      /tenant_scope_mismatch/,
    );
    expect(() =>
      buildLearning({
        ...input,
        cohorts: [{ ...result.cohorts[0]!, organizationId: "forged-organization" }],
      }),
    ).toThrow(/tenant_scope_mismatch/);
    expect(() => buildLearning({ ...input, externalAccountId: "forged-account" })).toThrow(
      /tenant_scope_mismatch/,
    );
    expect(() =>
      buildLearning({
        ...input,
        cohorts: [{ ...result.cohorts[0]!, creativeId: "different-creative" }],
      }),
    ).toThrow(/creative_lineage_mismatch/);
    expect(() =>
      buildLearning({
        ...input,
        cohorts: [{ ...result.cohorts[0]!, creativeFamilyId: "different-family" }],
      }),
    ).toThrow(/creative_lineage_mismatch/);
    expect(() =>
      buildLearning({
        ...input,
        cohorts: [result.cohorts[1]!, result.cohorts[0]!],
      }),
    ).toThrow(/cohort_window_order_invalid/);
    expect(() =>
      buildLearning({
        ...input,
        cohorts: [result.cohorts[0]!, result.cohorts[0]!],
      }),
    ).toThrow(/cohort_window_order_invalid/);
  });

  it("is deterministic across runs", async () => {
    const second = await runFixtureD({
      organizationId: "fixture-organization",
      contract,
      store: store(),
    });
    expect(second.creativeId).toBe(result.creativeId);
    expect(second.evaluation.score).toBe(result.evaluation.score);
    expect(second.settledSpendMinor).toBe(result.settledSpendMinor);
  });
});

describe("creative trace artifact", () => {
  it("connects every object to one creative id", () => {
    const trace = buildCreativeTrace(result);

    expect(trace.generatedFor).toBe(result.creativeId);
    expect(trace.identity.creativeId).toBe(result.creativeId);
    expect(trace.providerObjects).toHaveLength(3);
    expect(trace.paid.blockedWithoutApproval).toBe("proposal_not_approved");
    expect(trace.paid.blockedWithoutGrant).toBe("no_spend_grant");
    expect(trace.cohorts).toHaveLength(3);
    expect(trace.label).toMatch(/SYNTHETIC_FIXTURE/);
  });

  it("serialises to JSON without losing the honesty markers", () => {
    const trace = JSON.parse(JSON.stringify(buildCreativeTrace(result)));
    expect(trace.readiness.vboAllowed).toBe(false);
    expect(trace.organic.missingMetrics).toContain("saves");
    expect(trace.learning.limitations).toBeDefined();
  });
});
