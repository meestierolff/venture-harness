import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncScheduledAnalyticsFixture } from "@/lib/analytics";
import { buildWeeklyReport } from "@/scripts/run-weekly-demand-analysis";

describe("weekly normalized aggregation", () => {
  it("runs a labeled synthetic sync through normalized provenance and freshness", () => {
    const result = syncScheduledAnalyticsFixture(new Date("2026-08-04T12:00:00.000Z"));
    expect(result.failures).toEqual([]);
    expect(result.datasets.map((dataset) => dataset.provenance.source)).toEqual([
      "gsc",
      "ga4",
      "neon_commercial_evidence",
    ]);
    expect(
      result.datasets.every((dataset) => dataset.provenance.limitations[0].includes("SYNTHETIC")),
    ).toBe(true);
    expect(result.freshness.every((entry) => entry.status === "fresh")).toBe(true);
  });

  it("keeps null and absent data visibly missing and applies no report thresholds", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-weekly-"));
    const sync = syncScheduledAnalyticsFixture(new Date("2026-08-04T12:00:00.000Z"));
    sync.datasets[0].rows.push({ query_cluster: "synthetic-missing", clicks: null });
    const report = buildWeeklyReport(root, {
      week: "2026-W32",
      ...sync,
      fixture: true,
      dataDir: "data",
      includeLegacyFallback: true,
    });
    expect(report).toContain("SYNTHETIC FIXTURE");
    expect(report).toContain("synthetic-missing");
    expect(report).toContain("missing");
    expect(report).toContain("applies no opportunity, CTR, traffic, or commercial thresholds");
    expect(report).not.toContain("(none)");
  });

  it("labels an absent direct sync and legacy inbox as missing rather than zero", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-weekly-empty-"));
    const report = buildWeeklyReport(root, {
      week: "2026-W32",
      datasets: [],
      freshness: [],
      failures: [],
      fixture: false,
      dataDir: "data",
      includeLegacyFallback: true,
    });
    expect(report).toContain("MISSING — no dataset was available");
    expect(report).toContain("MISSING — no freshness ledger was supplied");
    expect(report).toContain("MISSING (not zero entries)");
  });

  it("contains no old hardcoded opportunity or zero-coercion rules", () => {
    const source = readFileSync("scripts/run-weekly-demand-analysis.ts", "utf8");
    expect(source).not.toMatch(/position\s*>?=\s*6/);
    expect(source).not.toMatch(/impressions\s*>?=\s*(10|20)/);
    expect(source).not.toMatch(/Number\([^)]*\?\?\s*0\)/);
  });
});
