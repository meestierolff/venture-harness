import { describe, expect, it } from "vitest";
import {
  MetricError,
  createMemoryWinnerLoopEvidenceStore,
  createMetricSnapshot,
  listMetricSnapshots,
  recordMetricValue,
  sumComparable,
  type MetricDefinition,
  type MetricValueInput,
} from "@/lib/winner-loop";

const SCOPE = { organizationId: "org-payout-rank", ventureId: "payout-rank" } as const;
const SNAPSHOT_DIMENSIONS = {
  provider: "tiktok_content",
  externalAccountId: "tt-account-1",
  format: "talking_head",
  durationSeconds: 22,
  geography: "NL",
} as const;

const tiktokCompletion: MetricDefinition = {
  definitionId: "tiktok_content:completion_v1",
  definitionVersion: "1",
  metric: "completion",
  provider: "tiktok_content",
  unit: "ratio",
  description: "Share of impressions that reached the final frame.",
};

const metaCompletion: MetricDefinition = {
  definitionId: "meta_ads:completion_v1",
  definitionVersion: "1",
  metric: "completion",
  provider: "meta_ads",
  unit: "ratio",
  description: "Share of impressions with a ThruPlay.",
};

function value(overrides: Partial<MetricValueInput> = {}) {
  const metric = overrides.metric ?? "completion";
  const provider = overrides.provider ?? "tiktok_content";
  const definition =
    overrides.definition ??
    ({
      definitionId: `${provider}:${metric}_v1`,
      definitionVersion: "1",
      metric,
      provider,
      unit: metric === "completion" || metric === "watch_time_ratio" ? "ratio" : "count",
      description: `${provider} ${metric}`,
    } satisfies MetricDefinition);
  return recordMetricValue({
    metric,
    definition,
    provider,
    externalAccountId: "tt-account-1",
    sourceObjectId: "tt-post-1",
    availability: "available",
    value: 0.41,
    missingReason: null,
    reportingWindowStart: "2026-08-08T09:00:00.000Z",
    reportingWindowEnd: "2026-08-08T11:00:00.000Z",
    sourceTime: "2026-08-08T11:00:00.000Z",
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

  it("rejects non-finite, negative, fractional-count, and out-of-range values", () => {
    expect(() => value({ value: Number.POSITIVE_INFINITY })).toThrowError(
      expect.objectContaining({ code: "invalid_value" }) as never,
    );
    expect(() => value({ metric: "views", value: -1 })).toThrowError(
      expect.objectContaining({ code: "invalid_value" }) as never,
    );
    expect(() => value({ metric: "views", value: 1.5 })).toThrowError(
      expect.objectContaining({ code: "invalid_value" }) as never,
    );
    expect(() => value({ value: 1.01 })).toThrowError(
      expect.objectContaining({ code: "invalid_value" }) as never,
    );
    expect(() =>
      value({
        metric: "average_watch_time",
        value: -0.1,
        definition: {
          definitionId: "tiktok_content:average_watch_time_v1",
          definitionVersion: "1",
          metric: "average_watch_time",
          provider: "tiktok_content",
          unit: "seconds",
          description: "Average watch time in seconds",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_value" }) as never);
  });

  it("rejects inverted windows, pre-source fetches, and negative latency", () => {
    expect(() =>
      value({
        reportingWindowStart: "2026-08-08T12:00:00.000Z",
        reportingWindowEnd: "2026-08-08T11:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_time" }) as never);
    expect(() => value({ fetchedAt: "2026-08-08T10:59:59.000Z" })).toThrowError(
      expect.objectContaining({ code: "invalid_time" }) as never,
    );
    expect(() => value({ latencySeconds: -1 })).toThrowError(
      expect.objectContaining({ code: "invalid_time" }) as never,
    );
  });

  it("reports a missing metric as null rather than zero", () => {
    const snapshot = createMetricSnapshot({
      ...SCOPE,
      ...SNAPSHOT_DIMENSIONS,
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
      ...SCOPE,
      ...SNAPSHOT_DIMENSIONS,
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

  it("rejects persistence scope that differs from the snapshot organization", () => {
    const store = createMemoryWinnerLoopEvidenceStore();
    expect(() =>
      createMetricSnapshot(
        {
          ...SCOPE,
          ...SNAPSHOT_DIMENSIONS,
          creativeId: "cr_aaaaaaaaaaaaaaaa",
          publicationId: "pub-1",
          offsetMinutes: 120,
          capturedAt: "2026-08-08T11:15:00.000Z",
          values: [value({ metric: "views", value: 1 })],
        },
        { organizationId: "org-forged", ventureId: SCOPE.ventureId, store },
      ),
    ).toThrowError(expect.objectContaining({ code: "tenant_scope_mismatch" }) as never);
    store.close();
  });

  it("rejects a provider-account value laundered into another snapshot", () => {
    expect(() =>
      createMetricSnapshot({
        ...SCOPE,
        ...SNAPSHOT_DIMENSIONS,
        externalAccountId: "tt-account-forged",
        creativeId: "cr_aaaaaaaaaaaaaaaa",
        publicationId: "pub-1",
        offsetMinutes: 120,
        capturedAt: "2026-08-08T11:15:00.000Z",
        values: [value({ metric: "views", value: 1 })],
      }),
    ).toThrowError(expect.objectContaining({ code: "tenant_scope_mismatch" }) as never);
  });

  it("rejects invalid snapshot identity, cadence, and capture time", () => {
    const base = {
      ...SCOPE,
      ...SNAPSHOT_DIMENSIONS,
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      publicationId: "pub-1",
      offsetMinutes: 120,
      capturedAt: "2026-08-08T11:15:00.000Z",
      values: [value({ metric: "views", value: 1 })],
    };
    expect(() => createMetricSnapshot({ ...base, creativeId: "" })).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }) as never,
    );
    expect(() => createMetricSnapshot({ ...base, publicationId: "" })).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }) as never,
    );
    expect(() => createMetricSnapshot({ ...base, offsetMinutes: -30 })).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }) as never,
    );
    expect(() => createMetricSnapshot({ ...base, capturedAt: "not-a-date" })).toThrowError(
      expect.objectContaining({ code: "invalid_snapshot" }) as never,
    );
    expect(() =>
      createMetricSnapshot({ ...base, capturedAt: "2026-08-08T11:14:59.000Z" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_time" }) as never);
  });

  it("rejects a forged payload scope inside the correct evidence partition", () => {
    const store = createMemoryWinnerLoopEvidenceStore();
    store.put({
      ...SCOPE,
      kind: "metric_snapshot",
      recordId: "forged-scope",
      creativeId: "cr_aaaaaaaaaaaaaaaa",
      occurredAt: "2026-08-08T11:15:00.000Z",
      sourceRefs: [],
      payload: {
        organizationId: "org-forged",
        ventureId: SCOPE.ventureId,
        creativeId: "cr_aaaaaaaaaaaaaaaa",
        publicationId: "pub-1",
        offsetMinutes: 120,
        capturedAt: "2026-08-08T11:15:00.000Z",
        values: [value({ metric: "views", value: 1 })],
      },
    });
    expect(() => listMetricSnapshots({ ...SCOPE, store }, "cr_aaaaaaaaaaaaaaaa")).toThrowError(
      expect.objectContaining({ code: "tenant_scope_mismatch" }) as never,
    );
    store.close();
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
    expect(result.definitionId).toBe("tiktok_content:views_v1");
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

  it("rejects a value whose metric or provider differs from its definition", () => {
    expect(() => value({ metric: "views", definition: tiktokCompletion })).toThrowError(
      expect.objectContaining({ code: "definition_mismatch" }) as never,
    );
    expect(() => value({ provider: "meta_ads", definition: tiktokCompletion })).toThrowError(
      expect.objectContaining({ code: "definition_mismatch" }) as never,
    );
  });

  it("rejects a forged shared ID when provider, unit, metric, or version differs", () => {
    const canonical = value();
    const forgedDefinition: MetricDefinition = {
      ...metaCompletion,
      definitionId: canonical.definition.definitionId,
      definitionVersion: "2",
    };
    expect(() =>
      sumComparable([canonical, value({ provider: "meta_ads", definition: forgedDefinition })]),
    ).toThrowError(expect.objectContaining({ code: "incomparable_definitions" }) as never);
  });

  it("rejects duplicate metrics instead of silently overwriting evidence", () => {
    expect(() =>
      createMetricSnapshot({
        ...SCOPE,
        ...SNAPSHOT_DIMENSIONS,
        creativeId: "cr_aaaaaaaaaaaaaaaa",
        publicationId: "pub-1",
        offsetMinutes: 120,
        capturedAt: "2026-08-08T11:15:00.000Z",
        values: [value({ metric: "views", value: 1 }), value({ metric: "views", value: 999 })],
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate_metric" }) as never);
  });
});
