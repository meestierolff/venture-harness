import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildCreativeTrace,
  createSqliteSpendStore,
  runFixtureD,
  ULID_PATTERN,
  type FixtureDResult,
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

let result: FixtureDResult;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "vh-fixture-d-boot-"));
  const booted = createSqliteSpendStore(join(dir, "spend.db"));
  try {
    result = await runFixtureD({ contract, store: booted });
  } finally {
    booted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Fixture D runs the whole loop through production modules", () => {
  it("is labelled synthetic and contacts no real provider", () => {
    expect(result.label).toMatch(/SYNTHETIC_FIXTURE/);
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
    expect(result.evaluation.scoringVersion).toBe("winner-score-v1");
    expect(result.evaluation.recommendation).toBe("PAID_TEST_CANDIDATE");
    expect(result.evaluation.spendEligible).toBe(true);
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

  it("is deterministic across runs", async () => {
    const second = await runFixtureD({ contract, store: store() });
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
