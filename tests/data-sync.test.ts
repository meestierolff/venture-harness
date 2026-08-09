import { describe, expect, it } from "vitest";
import {
  DataNormalizationError,
  DirectDataConnector,
  normalizeDataset,
  syncDataSources,
  type RawProviderDataset,
} from "@/lib/data";

function raw(overrides: Partial<RawProviderDataset> = {}): RawProviderDataset {
  return {
    source: "gsc",
    sourceAccount: "sc-domain:synthetic.example",
    fetchedAt: "2026-08-04T08:00:00.000Z",
    reportingWindow: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-31T23:59:59.000Z" },
    timezone: "Europe/Amsterdam",
    dimensions: ["query", "page"],
    quality: "complete",
    limitations: [],
    releaseVersion: "synthetic-1",
    rows: [{ query_category: "invoice exceptions", clicks: 4, impressions: 20 }],
    ...overrides,
  };
}

describe("normalized provider data", () => {
  it("retains provenance and keeps missing values distinct from zero", () => {
    const dataset = normalizeDataset(raw({ rows: [{ clicks: 0 }, { impressions: undefined }] }));
    expect(dataset.provenance).toMatchObject({
      source: "gsc",
      sourceAccount: "sc-domain:synthetic.example",
      timezone: "Europe/Amsterdam",
      releaseVersion: "synthetic-1",
    });
    expect(dataset.rows).toEqual([{ clicks: 0 }, { impressions: null }]);
  });

  it("rejects private fields before they reach normalized analytics", () => {
    expect(() => normalizeDataset(raw({ rows: [{ email: "person@example.invalid" }] }))).toThrow(
      DataNormalizationError,
    );
    expect(() =>
      normalizeDataset(raw({ rows: [{ safe_wrapper: { message: "private free text" } }] })),
    ).toThrow(DataNormalizationError);
    expect(() => normalizeDataset(raw({ rows: [{ category: "person@example.invalid" }] }))).toThrow(
      DataNormalizationError,
    );
  });

  it("syncs sources independently and reports missing credentials/provider outages", async () => {
    const good = new DirectDataConnector("gsc-fixture", "gsc", "fixture", true, async () => raw());
    const failed = new DirectDataConnector(
      "bing-fixture",
      "bing_webmaster",
      "fixture",
      false,
      async () => {
        throw new Error("synthetic provider outage");
      },
    );
    const result = await syncDataSources(
      [good, failed],
      [
        { source: "gsc", required: true, freshnessHours: 24 },
        { source: "bing_webmaster", required: false, freshnessHours: 24 },
        { source: "stripe", required: true, freshnessHours: 24 },
      ],
      { now: new Date("2026-08-04T12:00:00.000Z"), credentialRefs: { gsc: "memory://gsc" } },
    );
    expect(result.datasets).toHaveLength(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        source: "bing_webmaster",
        code: "provider_failed",
        retryable: true,
      }),
    ]);
    expect(result.freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "gsc", status: "fresh" }),
        expect.objectContaining({ source: "stripe", status: "missing" }),
      ]),
    );
  });
});
