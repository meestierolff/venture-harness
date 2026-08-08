import { describe, expect, it } from "vitest";
import {
  MetricError,
  createMetricSnapshot,
  recordMetricValue,
  sumComparable,
  type MetricDefinition,
  type MetricValueInput,
} from "@/lib/winner-loop";

const tiktokCompletion: MetricDefinition = {
  definitionId: "tiktok_content:completion_v1",
  metric: "completion",
  provider: "tiktok_content",
  unit: "ratio",
  description: "Share of impressions that reached the final frame.",
};

const metaCompletion: MetricDefinition = {
  definitionId: "meta_ads:completion_v1",
  metric: "completion",
  provider: "meta_ads",
  unit: "ratio",
  description: "Share of impressions with a ThruPlay.",
};

function value(overrides: Partial<MetricValueInput> = {}) {
  return recordMetricValue({
    metric: "completion",
    definition: tiktokCompletion,
    provider: "tiktok_content",
    externalAccountId: "tt-account-1",
    sourceObjectId: "tt-post-1",
    availability: "available",
    value: 0.41,
    missingReason: null,
    reportingWindowStart: "2026-08-08T09:00:00.000Z",
    reportingWindowEnd: "2026-08-08T11:00:00.000Z",
    latencySeconds: 900,
    fetchedAt: "2026-08-08T11:15:00.000Z",
    attributionWindow: null,
    confidence: "high",
    rawReference: "artifacts/tiktok/post-1-2h.json",
    ...overrides,
  });
}

describe("missing is not zero", () => {
  it("refuses a missing metric that still carries a value", () => {
    expect(() =>
      value({ availability: "not_supported_by_provider", value: 0, missingReason: "n/a" }),
    ).toThrowError(expect.objectContaining({ code: "value_without_availability" }) as never);
  });

  it("refuses an available metric with no value", () => {
    expect(() => value({ availability: "available", value: null })).toThrowError(MetricError);
  });

  it("requires a stated reason for every missing metric", () => {
    expect(() =>
      value({ availability: "permission_denied", value: null, missingReason: null }),
    ).toThrowError(expect.objectContaining({ code: "missing_without_reason" }) as never);
  });

  it("reports a missing metric as null rather than zero", () => {
    const snapshot = createMetricSnapshot({
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      publicationId: "pub-1",
      offsetMinutes: 120,
      capturedAt: "2026-08-08T11:15:00.000Z",
      values: [
        value({ metric: "views", availability: "available", value: 12_000 }),
        value({
          metric: "saves",
          availability: "not_supported_by_provider",
          value: null,
          missingReason: "endpoint does not expose saves for this account type",
        }),
      ],
    });

    expect(snapshot.valueOf("views")).toBe(12_000);
    expect(snapshot.valueOf("saves")).toBeNull();
    expect(snapshot.valueOf("saves")).not.toBe(0);
    expect(snapshot.missing(["views", "saves", "shares"])).toEqual(["saves", "shares"]);
    expect(snapshot.isComplete(["views", "saves"])).toBe(false);
    expect(snapshot.isComplete(["views"])).toBe(true);
  });

  it("distinguishes a measured zero from an absent measurement", () => {
    const snapshot = createMetricSnapshot({
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      publicationId: "pub-1",
      offsetMinutes: 120,
      capturedAt: "2026-08-08T11:15:00.000Z",
      values: [value({ metric: "purchases", availability: "available", value: 0 })],
    });

    expect(snapshot.valueOf("purchases")).toBe(0);
    expect(snapshot.missing(["purchases"])).toEqual([]);
    expect(snapshot.get("purchases")?.available).toBe(true);
  });
});

describe("provider-scoped definitions", () => {
  it("refuses to combine metrics carrying different definitions", () => {
    expect(() =>
      sumComparable([
        value({ definition: tiktokCompletion }),
        value({ definition: metaCompletion, provider: "meta_ads" }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "incomparable_definitions" }) as never);
  });

  it("sums values that share one definition and counts what was missing", () => {
    const result = sumComparable([
      value({ metric: "views", availability: "available", value: 1_000 }),
      value({ metric: "views", availability: "available", value: 500 }),
      value({
        metric: "views",
        availability: "fetch_failed",
        value: null,
        missingReason: "provider returned 503",
      }),
    ]);

    expect(result.total).toBe(1_500);
    expect(result.missing).toBe(1);
    expect(result.definitionId).toBe("tiktok_content:completion_v1");
  });

  it("returns null rather than zero when every input was missing", () => {
    const result = sumComparable([
      value({
        metric: "views",
        availability: "fetch_failed",
        value: null,
        missingReason: "provider returned 503",
      }),
    ]);

    expect(result.total).toBeNull();
    expect(result.missing).toBe(1);
  });
});
