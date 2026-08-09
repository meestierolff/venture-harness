import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOperatingCadence,
  persistLearningReport,
  renderOperatingCadenceMarkdown,
  runLearningLoop,
  type LearningLoopDefinition,
} from "@/lib/learning";
import type { DataFreshnessEntry } from "@/lib/data";

const definition: LearningLoopDefinition = {
  id: "weekly-growth",
  cadence: "weekly",
  requiredSources: [{ source: "neon_commercial_evidence", freshnessHours: 24 }],
  primaryMetrics: ["activation"],
  guardrailMetrics: ["error_rate"],
  decisionRules: ["Propose only when confidence >= 0.70."],
  maximumActions: 3,
  maximumIterations: 1,
  autonomy: "autofix_low_risk",
  authorizedEffectTypes: ["local_write", "git_write", "metadata_repair"],
  outputDestination: "reports/learning/weekly",
  nextRunAt: "2026-08-10T06:00:00.000Z",
  stopCondition: "Stop on stale required evidence.",
};

const fresh: DataFreshnessEntry[] = [
  {
    source: "neon_commercial_evidence",
    status: "fresh",
    fetchedAt: "2026-08-04T08:00:00.000Z",
    ageHours: 4,
    freshnessHours: 24,
    required: true,
    limitation: null,
  },
];

const metrics = [
  {
    id: "activation",
    value: 0.42,
    sampleSize: 24,
    source: "neon_commercial_evidence" as const,
    window: { start: "2026-07-28", end: "2026-08-03" },
  },
];

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("learning loops", () => {
  it("refuses to act when required evidence is stale or missing", () => {
    const report = runLearningLoop({
      definition,
      freshness: [{ ...fresh[0], status: "stale" }],
      metrics,
      candidates: [
        {
          id: "change-onboarding",
          journey: "onboarding",
          kind: "conceptual_hypothesis",
          title: "Change onboarding",
          rationale: "Synthetic candidate",
          evidenceRefs: ["synthetic"],
          confidence: 0.9,
          risk: "moderate",
          effectTypes: ["local_write"],
          protectsWinner: false,
        },
      ],
      now: new Date("2026-08-04T12:00:00.000Z"),
    });
    expect(report.status).toBe("insufficient_evidence");
    expect(report.actions).toHaveLength(0);
    expect(report.limitations[0]).toContain("missing is not zero");
  });

  it("caps conceptual actions, permits verified bug fixes, and narrows autofix", () => {
    const candidates = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `bug-${index}`,
        journey: "reliability",
        kind: "verified_bug_fix" as const,
        title: `Fix bug ${index}`,
        rationale: "Reproduced by fixture",
        evidenceRefs: [`fixture-${index}`],
        confidence: 0.99,
        risk: "low" as const,
        effectTypes: ["local_write"],
        protectsWinner: false,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `concept-${index}`,
        journey: `journey-${index}`,
        kind: "conceptual_hypothesis" as const,
        title: `Concept ${index}`,
        rationale: "Synthetic evidence",
        evidenceRefs: [`evidence-${index}`],
        confidence: 0.9 - index * 0.01,
        risk: "moderate" as const,
        effectTypes: ["local_write"],
        protectsWinner: false,
      })),
      {
        id: "unsafe-metadata",
        journey: "pricing",
        kind: "metadata_repair" as const,
        title: "Change a price",
        rationale: "Forbidden autofix check",
        evidenceRefs: ["synthetic"],
        confidence: 0.95,
        risk: "low" as const,
        effectTypes: ["price_change"],
        protectsWinner: false,
      },
    ];
    const report = runLearningLoop({ definition, freshness: fresh, metrics, candidates });
    expect(report.actions.filter((action) => action.kind === "verified_bug_fix")).toHaveLength(5);
    expect(report.actions.filter((action) => action.kind !== "verified_bug_fix")).toHaveLength(3);
    expect(
      report.actions
        .filter((action) => action.kind === "verified_bug_fix")
        .every((action) => action.disposition === "autofix_low_risk"),
    ).toBe(true);
    const unsafe = report.actions.find((action) => action.id === "unsafe-metadata");
    if (unsafe) expect(unsafe.disposition).toBe("propose");
  });

  it("builds a visible cadence with missing required sources", () => {
    const cadence = buildOperatingCadence({
      loops: [
        definition,
        { ...definition, id: "daily", cadence: "daily", nextRunAt: "2026-08-05T06:00:00.000Z" },
        {
          ...definition,
          id: "biweekly",
          cadence: "biweekly",
          nextRunAt: "2026-08-15T07:00:00.000Z",
        },
      ],
      freshness: [{ ...fresh[0], status: "missing", fetchedAt: null, ageHours: null }],
      activeHypotheses: ["hypothesis-b", "hypothesis-a"],
      activeExperiments: [],
      activeBlockers: ["auth:neon"],
      now: new Date("2026-08-04T12:00:00.000Z"),
    });
    expect(cadence.nextDailyReview).toBe("2026-08-05T06:00:00.000Z");
    expect(cadence.nextBiweeklyReview).toBe("2026-08-15T07:00:00.000Z");
    expect(cadence.missingDataSources).toEqual(["neon_commercial_evidence"]);
    expect(cadence.activeHypotheses).toEqual(["hypothesis-a", "hypothesis-b"]);
    expect(renderOperatingCadenceMarkdown(cadence)).toContain(
      "Next biweekly review: 2026-08-15T07:00:00.000Z",
    );
  });

  it("persists immutable and latest JSON/Markdown reports under the declared destination", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-learning-report-"));
    temporaryDirectories.push(root);
    const report = runLearningLoop({
      definition,
      freshness: fresh,
      metrics,
      candidates: [],
      now: new Date("2026-08-04T12:00:00.000Z"),
    });

    const artifacts = persistLearningReport({ rootDir: root, definition, report });

    expect(artifacts.latestJson).toBe("reports/learning/weekly/latest.json");
    expect(artifacts.latestMarkdown).toBe("reports/learning/weekly/latest.md");
    expect(existsSync(join(root, artifacts.json))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, artifacts.latestJson), "utf8"))).toEqual(report);
    expect(readFileSync(join(root, artifacts.latestMarkdown), "utf8")).toContain(
      "# weekly learning report",
    );
  });

  it("refuses a learning report destination outside the venture root", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-learning-report-"));
    temporaryDirectories.push(root);
    const report = runLearningLoop({ definition, freshness: fresh, metrics, candidates: [] });
    expect(() =>
      persistLearningReport({
        rootDir: root,
        definition: { ...definition, outputDestination: "../escape" },
        report,
      }),
    ).toThrow(/escapes the venture root/);
  });
});
