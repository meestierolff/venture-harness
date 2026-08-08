import { normalizeDataset } from "../data/normalize";
import { buildFreshnessReport } from "../data/sync";
import type { DataSyncResult, RawProviderDataset } from "../data/types";

/**
 * Synthetic scheduled-sync smoke fixture. It exercises the same normalized
 * contracts as direct connectors and is always labeled; it is never market
 * evidence and never substitutes for a live provider read-back.
 */
export function syncScheduledAnalyticsFixture(now = new Date()): DataSyncResult {
  const end = now.toISOString();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
  const shared = {
    fetchedAt: end,
    reportingWindow: { start, end },
    timezone: "UTC",
    quality: "complete" as const,
    limitations: [
      "SYNTHETIC fixture for scheduled data-pipeline verification; not market evidence.",
    ],
    releaseVersion: "fixture-v0.2",
  };
  const raw: RawProviderDataset[] = [
    {
      ...shared,
      source: "gsc",
      sourceAccount: "synthetic:gsc-property",
      dimensions: ["query_cluster", "country"],
      rows: [{ query_cluster: "synthetic-core-job", country: "NL", impressions: 24, clicks: 3 }],
    },
    {
      ...shared,
      source: "ga4",
      sourceAccount: "synthetic:ga4-property",
      dimensions: ["journey", "channel"],
      rows: [{ journey: "synthetic-core", channel: "organic", starts: 8, completions: 2 }],
    },
    {
      ...shared,
      source: "neon_commercial_evidence",
      sourceAccount: "synthetic:neon-project",
      dimensions: ["journey", "outcome"],
      rows: [{ journey: "synthetic-core", outcome: "fixture-confirmed", count: 1 }],
    },
  ];
  const datasets = raw.map(normalizeDataset);
  const freshness = buildFreshnessReport(
    [
      { source: "gsc", required: true, freshnessHours: 24 },
      { source: "ga4", required: true, freshnessHours: 24 },
      { source: "neon_commercial_evidence", required: true, freshnessHours: 24 },
    ],
    datasets,
    now,
  );
  return { datasets, freshness, failures: [] };
}
