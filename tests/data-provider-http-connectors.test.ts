import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import { CredentialBroker, MemoryCredentialBackend } from "@/lib/credentials";
import {
  UnavailableDataConnector,
  createGoogleSearchConsoleConnector,
  syncDataSources,
} from "@/lib/data";
import type { HttpFetcher, HttpRequest, HttpResponse } from "@/lib/providers";
import { FileWorkflowStore } from "@/lib/workflow";

const temporaryDirectories: string[] = [];
const now = new Date("2026-08-04T12:00:00.000Z");

class FixtureHttpFetcher implements HttpFetcher {
  readonly requests: HttpRequest[] = [];

  async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    if (url.hostname === "searchconsole.googleapis.com") {
      return {
        status: 200,
        body: {
          rows: [
            {
              keys: ["2026-08-03", "nld", "DESKTOP"],
              clicks: 4,
              impressions: 40,
              ctr: 0.1,
              position: 3.5,
            },
          ],
        },
      };
    }
    if (url.hostname === "analyticsdata.googleapis.com") {
      return {
        status: 200,
        body: {
          metadata: { timeZone: "Europe/Amsterdam", subjectToThresholding: false },
          rows: [
            {
              dimensionValues: [
                { value: "20260803" },
                { value: "Organic Search" },
                { value: "desktop" },
              ],
              metricValues: [{ value: "12" }, { value: "10" }, { value: "31" }],
            },
          ],
        },
      };
    }
    if (url.hostname === "ssl.bing.com") {
      return {
        status: 200,
        body: { d: [{ Date: "/Date(1785715200000)/", Clicks: 2, Impressions: 20 }] },
      };
    }
    if (url.hostname === "api.stripe.com") {
      return {
        status: 200,
        body: {
          data: [
            {
              created: 1785751200,
              available_on: 1785837600,
              currency: "eur",
              amount: 4900,
              fee: 172,
              net: 4728,
              type: "charge",
              reporting_category: "charge",
              status: "available",
              customer: "cus_private_not_normalized",
              description: "private provider field not normalized",
            },
          ],
          has_more: false,
        },
      };
    }
    if (url.hostname === "api.brevo.com") {
      return {
        status: 200,
        body: {
          requests: 10,
          delivered: 9,
          hardBounces: 1,
          softBounces: 0,
          blocked: 0,
          invalid: 0,
          spamReports: 0,
          unsubscribed: 0,
          opens: 5,
          uniqueOpens: 4,
          clicks: 2,
          uniqueClicks: 2,
        },
      };
    }
    if (url.hostname === "api.revenuecat.com") {
      return {
        status: 200,
        body: {
          object: "overview_metrics",
          currency: "EUR",
          metrics: [
            {
              id: "active_subscriptions",
              unit: "#",
              period: "P0D",
              value: 3,
              last_updated_at: 1785844800000,
              app_user_id: "private-user-not-normalized",
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected fixture URL: ${url.origin}${url.pathname}`);
  }
}

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-provider-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("official read-only provider data connectors", () => {
  it("composes verified provider config into isolated aggregate datasets", async () => {
    const directory = root();
    mkdirSync(join(directory, "config"), { recursive: true });
    writeFileSync(
      join(directory, "config/providers.yaml"),
      `contract_version: 1
providers:
  google:
    state: verified
    capability_ids: [ga4, gsc]
    external_resource_ids: { property_id: "123456789", site_url: "https://example.test/" }
    credential_ref: cred://google/read
    last_verified_at: 2026-08-04T10:00:00.000Z
    evidence_artifact_ref: reports/providers/google.json
  bing:
    state: verified
    capability_ids: [bing_webmaster]
    external_resource_ids: { site_url: "https://example.test/", auth_mode: api_key }
    credential_ref: cred://bing/read
    last_verified_at: 2026-08-04T10:00:00.000Z
    evidence_artifact_ref: reports/providers/bing.json
  stripe:
    state: verified
    capability_ids: [stripe]
    account_id: acct_fixture
    external_resource_ids: { mode: test }
    credential_ref: cred://stripe/read
    last_verified_at: 2026-08-04T10:00:00.000Z
    evidence_artifact_ref: reports/providers/stripe.json
  brevo:
    state: verified
    capability_ids: [transactional_email]
    account_id: brevo-fixture
    credential_ref: cred://brevo/read
    last_verified_at: 2026-08-04T10:00:00.000Z
    evidence_artifact_ref: reports/providers/brevo.json
  revenuecat:
    state: verified
    capability_ids: [revenuecat]
    external_resource_ids: { project_id: proj_fixture }
    credential_ref: cred://revenuecat/read
    last_verified_at: 2026-08-04T10:00:00.000Z
    evidence_artifact_ref: reports/providers/revenuecat.json
extensions: {}
`,
    );
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    for (const provider of ["google", "bing", "stripe", "brevo", "revenuecat"] as const) {
      await broker.store({
        ref: `cred://${provider}/read`,
        provider,
        kind: provider === "google" ? "oauth" : "api_key",
        backend: "memory",
        scopes: ["read"],
        value: `${provider}-fixture-secret-value`,
      });
    }
    const fetcher = new FixtureHttpFetcher();
    const services = createDefaultCliServices({
      rootDir: directory,
      store: new FileWorkflowStore({ rootDir: join(directory, ".venture/runs") }),
      credentialBroker: broker,
      dataHttpFetcher: fetcher,
      dataRequirements: [
        { source: "gsc", required: true, freshnessHours: 48 },
        { source: "ga4", required: true, freshnessHours: 48 },
        { source: "bing_webmaster", required: true, freshnessHours: 48 },
        { source: "stripe", required: true, freshnessHours: 48 },
        { source: "brevo", required: true, freshnessHours: 48 },
        { source: "revenuecat", required: true, freshnessHours: 48 },
      ],
      now: () => now,
    });

    const sync = (await services.dataSync!()) as {
      status: string;
      datasets: Array<{
        provenance: { source: string; quality: string; limitations: string[] };
        rows: Array<Record<string, unknown>>;
      }>;
      failures: unknown[];
      freshness: Array<{ source: string; status: string }>;
    };

    expect(sync.status).toBe("complete");
    expect(sync.failures).toEqual([]);
    expect(sync.datasets.map((dataset) => dataset.provenance.source).sort()).toEqual([
      "bing_webmaster",
      "brevo",
      "ga4",
      "gsc",
      "revenuecat",
      "stripe",
    ]);
    expect(sync.freshness.every((entry) => entry.status === "fresh")).toBe(true);
    expect(fetcher.requests).toHaveLength(6);
    expect(
      fetcher.requests.find(({ url }) => url.includes("searchAnalytics/query"))?.body,
    ).not.toContain('"query"');
    expect(
      fetcher.requests.find(({ url }) => url.includes("GetRankAndTrafficStats"))?.sensitiveUrl,
    ).toBe(true);
    expect(JSON.stringify(sync)).not.toMatch(
      /fixture-secret|cus_private|private provider|app_user_id|private-user/i,
    );
    expect(sync.datasets.find(({ provenance }) => provenance.source === "stripe")?.rows[0]).toEqual(
      expect.objectContaining({ gross_minor: 4900, mode: "test", currency: "eur" }),
    );
    expect(
      sync.datasets.find(({ provenance }) => provenance.source === "revenuecat")?.provenance
        .quality,
    ).toBe("partial");
  });

  it("rejects private-looking values after provider-specific projection", async () => {
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: "cred://google/read",
      provider: "google",
      kind: "oauth",
      backend: "memory",
      scopes: ["read"],
      value: "google-private-fixture-value",
    });
    const connector = createGoogleSearchConsoleConnector({
      broker,
      fetcher: {
        async fetch() {
          return {
            status: 200,
            body: {
              rows: [
                {
                  keys: ["2026-08-03", "private@example.test", "DESKTOP"],
                  clicks: 1,
                  impressions: 2,
                  ctr: 0.5,
                  position: 1,
                },
              ],
            },
          };
        },
      },
      siteUrl: "https://example.test/",
      sourceAccount: "https://example.test/",
      timezone: "America/Los_Angeles",
      windowHours: 48,
    });

    const sync = await syncDataSources(
      [connector],
      [{ source: "gsc", required: true, freshnessHours: 48 }],
      { now, credentialRefs: { gsc: "cred://google/read" } },
    );

    expect(sync.datasets).toEqual([]);
    expect(sync.failures).toEqual([
      expect.objectContaining({ source: "gsc", code: "invalid_data", retryable: false }),
    ]);
    expect(JSON.stringify(sync)).not.toContain("private@example.test");
  });

  it("records an exact non-retryable boundary when an official flow is not composable", async () => {
    const connector = new UnavailableDataConnector(
      "app-store-connect.not-configured",
      "app_store_connect_analytics",
      "A pre-existing analytics report request and signed segment reader are required.",
      "Record the request id and inject a JWT-signed segment connector.",
    );
    const sync = await syncDataSources(
      [connector],
      [{ source: "app_store_connect_analytics", required: true, freshnessHours: 48 }],
      { now },
    );

    expect(sync.failures).toEqual([
      {
        source: "app_store_connect_analytics",
        code: "connector_not_configured",
        message: "A pre-existing analytics report request and signed segment reader are required.",
        retryable: false,
        nextAction: "Record the request id and inject a JWT-signed segment connector.",
      },
    ]);
    expect(sync.freshness[0]).toMatchObject({ status: "missing", fetchedAt: null });

    const directory = root();
    const services = createDefaultCliServices({
      rootDir: directory,
      store: new FileWorkflowStore({ rootDir: join(directory, ".venture/runs") }),
      credentialBroker: new CredentialBroker([new MemoryCredentialBackend()]),
      dataHttpFetcher: new FixtureHttpFetcher(),
      dataRequirements: [
        { source: "app_store_connect_analytics", required: true, freshnessHours: 48 },
      ],
      now: () => now,
    });
    await expect(services.dataSync!()).resolves.toMatchObject({
      status: "not_configured",
      failures: [{ code: "connector_not_configured", retryable: false }],
    });
  });
});
