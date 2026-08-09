import type { CredentialBroker, CredentialReference } from "../credentials";
import type { HttpFetcher, HttpRequest, HttpResponse } from "../providers";
import type { DataConnector, DataConnectorContext, RawProviderDataset } from "./types";
import { DataNormalizationError, DataProviderFetchError } from "./types";

interface BaseHttpConnectorOptions {
  broker: CredentialBroker;
  fetcher: HttpFetcher;
  sourceAccount: string;
  timezone: string;
  windowHours: number;
  releaseVersion?: string | null;
}

interface ProviderHttpConnectorOptions extends BaseHttpConnectorOptions {
  provider: string;
  id: string;
  source: RawProviderDataset["source"];
  request: (secret: string, context: DataConnectorContext, window: ProviderWindow) => HttpRequest;
  map: (
    response: HttpResponse,
    context: DataConnectorContext,
    window: ProviderWindow,
  ) => RawProviderDataset;
}

interface ProviderWindow {
  start: Date;
  end: Date;
  startIso: string;
  endIso: string;
  startDate: string;
  endDate: string;
}

const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function providerWindow(now: Date, windowHours: number): ProviderWindow {
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error("Direct-data windowHours must be a positive number.");
  }
  const start = new Date(now.getTime() - windowHours * 3_600_000);
  return {
    start,
    end: now,
    startIso: start.toISOString(),
    endIso: now.toISOString(),
    startDate: start.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
  };
}

function object(value: unknown, source: RawProviderDataset["source"], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DataNormalizationError(`${source} returned an invalid ${label} object.`, source);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown, source: RawProviderDataset["source"], label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DataNormalizationError(`${source} returned an invalid ${label} array.`, source);
  }
  return value;
}

function text(value: unknown, source: RawProviderDataset["source"], label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DataNormalizationError(`${source} returned an invalid ${label}.`, source);
  }
  return value;
}

function finite(value: unknown, source: RawProviderDataset["source"], label: string): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new DataNormalizationError(`${source} returned a non-numeric ${label}.`, source);
  }
  return parsed;
}

function optionalFinite(
  value: unknown,
  source: RawProviderDataset["source"],
  label: string,
): number | null {
  return value === undefined || value === null ? null : finite(value, source, label);
}

function bearerRequest(
  method: HttpRequest["method"],
  url: string,
  secret: string,
  body: unknown,
  signal?: AbortSignal,
): HttpRequest {
  return {
    method,
    url,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    sensitiveHeaders: ["authorization"],
    sensitiveUrl: false,
    signal,
  };
}

function assertCredentialProvider(
  reference: CredentialReference,
  provider: string,
  source: RawProviderDataset["source"],
): void {
  if (reference.provider !== provider) {
    throw new DataProviderFetchError(
      `${source} credential_ref belongs to ${reference.provider}, not ${provider}.`,
      source,
      false,
      `Register a least-privilege ${provider} read credential and set its cred:// reference for ${source}.`,
    );
  }
}

function createProviderHttpConnector(options: ProviderHttpConnectorOptions): DataConnector {
  return {
    id: options.id,
    source: options.source,
    transport: "provider_api",
    credentialRequired: true,
    rawExportsCommitted: false,
    async fetch(context) {
      if (!context.credentialRef) {
        throw new DataProviderFetchError(
          `credential_ref required for ${options.source}`,
          options.source,
          false,
          `Register a least-privilege ${options.provider} read credential and rerun vh data sync.`,
        );
      }
      const window = providerWindow(context.now, options.windowHours);
      return options.broker.withSecret(context.credentialRef, async (secret, reference) => {
        assertCredentialProvider(reference, options.provider, options.source);
        let response: HttpResponse;
        try {
          response = await options.fetcher.fetch(options.request(secret, context, window));
        } catch (error) {
          const safe = options.broker.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          );
          throw new DataProviderFetchError(
            `${options.source} official read failed: ${safe}`,
            options.source,
            true,
            `Check ${options.provider} status and the brokered read credential, then rerun vh data sync.`,
          );
        }
        if (response.status < 200 || response.status >= 300) {
          const retryable = TRANSIENT_HTTP_STATUS.has(response.status);
          throw new DataProviderFetchError(
            `${options.source} official read returned HTTP ${response.status}; provider response content was not persisted.`,
            options.source,
            retryable,
            retryable
              ? `Honor Retry-After or provider status, then rerun vh data sync for ${options.source}.`
              : `Run vh doctor, verify the ${options.provider} credential scope and resource identifiers, then rerun vh data sync.`,
          );
        }
        return options.map(response, context, window);
      });
    },
  };
}

function baseDataset(
  options: BaseHttpConnectorOptions,
  context: DataConnectorContext,
  window: ProviderWindow,
): Pick<
  RawProviderDataset,
  "sourceAccount" | "fetchedAt" | "reportingWindow" | "timezone" | "releaseVersion"
> {
  return {
    sourceAccount: options.sourceAccount,
    fetchedAt: context.now.toISOString(),
    reportingWindow: { start: window.startIso, end: window.endIso },
    timezone: options.timezone,
    releaseVersion: options.releaseVersion ?? null,
  };
}

export interface GoogleSearchConsoleConnectorOptions extends BaseHttpConnectorOptions {
  siteUrl: string;
}

export function createGoogleSearchConsoleConnector(
  options: GoogleSearchConsoleConnectorOptions,
): DataConnector {
  const rowLimit = 25_000;
  return createProviderHttpConnector({
    ...options,
    id: "gsc.search-analytics",
    provider: "google",
    source: "gsc",
    request: (secret, context, window) =>
      bearerRequest(
        "POST",
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(options.siteUrl)}/searchAnalytics/query`,
        secret,
        {
          startDate: window.startDate,
          endDate: window.endDate,
          dimensions: ["date", "country", "device"],
          rowLimit,
          dataState: "final",
        },
        context.signal,
      ),
    map(response, context, window) {
      const body = object(response.body, "gsc", "response");
      const providerRows = array(body.rows, "gsc", "rows");
      const rows = providerRows.map((value, index) => {
        const row = object(value, "gsc", `rows[${index}]`);
        const keys = array(row.keys, "gsc", `rows[${index}].keys`);
        if (keys.length !== 3) {
          throw new DataNormalizationError(
            `gsc row ${index} did not match the requested aggregate dimensions.`,
            "gsc",
          );
        }
        return {
          date: text(keys[0], "gsc", `rows[${index}].date`),
          country: text(keys[1], "gsc", `rows[${index}].country`),
          device: text(keys[2], "gsc", `rows[${index}].device`),
          clicks: finite(row.clicks, "gsc", `rows[${index}].clicks`),
          impressions: finite(row.impressions, "gsc", `rows[${index}].impressions`),
          ctr: finite(row.ctr, "gsc", `rows[${index}].ctr`),
          position: finite(row.position, "gsc", `rows[${index}].position`),
        };
      });
      const truncated = rows.length >= rowLimit;
      return {
        source: "gsc",
        ...baseDataset(options, context, window),
        dimensions: ["date", "country", "device"],
        quality: truncated ? "partial" : "complete",
        limitations: [
          "Search Console returns aggregate, privacy-filtered data and can omit low-volume rows.",
          "Raw query text and page URLs are deliberately excluded from this learning dataset.",
          ...(truncated
            ? [`The ${rowLimit}-row response may be truncated; pagination is not inferred.`]
            : []),
        ],
        rows,
      };
    },
  });
}

export interface GoogleAnalyticsConnectorOptions extends BaseHttpConnectorOptions {
  propertyId: string;
}

function ga4Date(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value;
}

export function createGoogleAnalyticsConnector(
  options: GoogleAnalyticsConnectorOptions,
): DataConnector {
  const propertyId = options.propertyId.replace(/^properties\//, "");
  if (!/^\d+$/.test(propertyId)) {
    throw new Error("GA4 propertyId must be the numeric property identifier.");
  }
  return createProviderHttpConnector({
    ...options,
    id: "ga4.run-report",
    provider: "google",
    source: "ga4",
    request: (secret, context, window) =>
      bearerRequest(
        "POST",
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
        secret,
        {
          dateRanges: [{ startDate: window.startDate, endDate: window.endDate }],
          dimensions: [
            { name: "date" },
            { name: "sessionDefaultChannelGroup" },
            { name: "deviceCategory" },
          ],
          metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "eventCount" }],
          keepEmptyRows: false,
          limit: "100000",
        },
        context.signal,
      ),
    map(response, context, window) {
      const body = object(response.body, "ga4", "response");
      const providerRows = array(body.rows, "ga4", "rows");
      const rows = providerRows.map((value, index) => {
        const row = object(value, "ga4", `rows[${index}]`);
        const dimensions = array(row.dimensionValues, "ga4", `rows[${index}].dimensionValues`);
        const metrics = array(row.metricValues, "ga4", `rows[${index}].metricValues`);
        if (dimensions.length !== 3 || metrics.length !== 3) {
          throw new DataNormalizationError(
            `ga4 row ${index} did not match the requested aggregate dimensions and metrics.`,
            "ga4",
          );
        }
        const dimension = (position: number) =>
          text(
            object(dimensions[position], "ga4", `rows[${index}].dimensionValues[${position}]`)
              .value,
            "ga4",
            `rows[${index}].dimensionValues[${position}].value`,
          );
        const metric = (position: number) =>
          finite(
            object(metrics[position], "ga4", `rows[${index}].metricValues[${position}]`).value,
            "ga4",
            `rows[${index}].metricValues[${position}].value`,
          );
        return {
          date: ga4Date(dimension(0)),
          channel_group: dimension(1),
          device_category: dimension(2),
          sessions: metric(0),
          total_users: metric(1),
          event_count: metric(2),
        };
      });
      const metadata = optionalObject(body.metadata);
      const sampling = Array.isArray(metadata?.samplingMetadatas)
        ? metadata.samplingMetadatas.length > 0
        : false;
      const thresholded = metadata?.subjectToThresholding === true;
      const responseTimezone =
        typeof metadata?.timeZone === "string" && metadata.timeZone.length > 0
          ? metadata.timeZone
          : options.timezone;
      return {
        source: "ga4",
        ...baseDataset({ ...options, timezone: responseTimezone }, context, window),
        dimensions: ["date", "channel_group", "device_category"],
        quality: thresholded ? "thresholded" : sampling ? "sampled" : "complete",
        limitations: [
          "GA4 contains only the consented population configured for the property.",
          "Provider thresholding, sampling, data retention, and current-day lag can limit comparisons.",
          ...(sampling ? ["GA4 response metadata reported sampling."] : []),
          ...(thresholded ? ["GA4 response metadata reported thresholding."] : []),
        ],
        rows,
      };
    },
  });
}

export interface BingWebmasterConnectorOptions extends BaseHttpConnectorOptions {
  siteUrl: string;
  authMode: "api_key" | "oauth";
}

function bingDate(value: unknown): string {
  if (typeof value === "string") {
    const dotNet = value.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
    if (dotNet) return new Date(Number(dotNet[1])).toISOString();
    if (Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  throw new DataNormalizationError("bing_webmaster returned an invalid Date.", "bing_webmaster");
}

export function createBingWebmasterConnector(
  options: BingWebmasterConnectorOptions,
): DataConnector {
  return createProviderHttpConnector({
    ...options,
    id: "bing.rank-and-traffic",
    provider: "bing",
    source: "bing_webmaster",
    request(secret, context) {
      const url = new URL("https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats");
      url.searchParams.set("siteUrl", options.siteUrl);
      const headers: Record<string, string> = {};
      const sensitiveHeaders: string[] = [];
      if (options.authMode === "oauth") {
        headers.Authorization = `Bearer ${secret}`;
        sensitiveHeaders.push("authorization");
      } else {
        url.searchParams.set("apikey", secret);
      }
      return {
        method: "GET",
        url: url.toString(),
        headers,
        sensitiveHeaders,
        sensitiveUrl: options.authMode === "api_key",
        signal: context.signal,
      };
    },
    map(response, context, window) {
      const body = object(response.body, "bing_webmaster", "response");
      const providerRows = array(body.d, "bing_webmaster", "d");
      const rows = providerRows.map((value, index) => {
        const row = object(value, "bing_webmaster", `d[${index}]`);
        return {
          date: bingDate(row.Date),
          clicks: finite(row.Clicks, "bing_webmaster", `d[${index}].Clicks`),
          impressions: finite(row.Impressions, "bing_webmaster", `d[${index}].Impressions`),
        };
      });
      return {
        source: "bing_webmaster",
        ...baseDataset(options, context, window),
        dimensions: ["date"],
        quality: "partial",
        limitations: [
          "The legacy GetRankAndTrafficStats method chooses its own coverage; the configured reporting window records the sync observation window, not a server-side filter.",
          "Bing Webmaster API availability is legacy and must be live-doctored per account.",
          "This aggregate connector does not fetch query or page text.",
        ],
        rows,
      };
    },
  });
}

export interface StripeBalanceConnectorOptions extends BaseHttpConnectorOptions {
  mode: "test" | "live";
}

export function createStripeBalanceConnector(
  options: StripeBalanceConnectorOptions,
): DataConnector {
  const limit = 100;
  return createProviderHttpConnector({
    ...options,
    id: "stripe.balance-transactions",
    provider: "stripe",
    source: "stripe",
    request(secret, context, window) {
      const basic = Buffer.from(`${secret}:`).toString("base64");
      options.broker.redactor.addSecret(basic);
      const url = new URL("https://api.stripe.com/v1/balance_transactions");
      url.searchParams.set("created[gte]", String(Math.floor(window.start.getTime() / 1_000)));
      url.searchParams.set("created[lte]", String(Math.floor(window.end.getTime() / 1_000)));
      url.searchParams.set("limit", String(limit));
      return {
        method: "GET",
        url: url.toString(),
        headers: { Authorization: `Basic ${basic}` },
        sensitiveHeaders: ["authorization"],
        sensitiveUrl: false,
        signal: context.signal,
      };
    },
    map(response, context, window) {
      const body = object(response.body, "stripe", "response");
      const providerRows = array(body.data, "stripe", "data");
      const rows = providerRows.map((value, index) => {
        const row = object(value, "stripe", `data[${index}]`);
        return {
          created_at: new Date(
            finite(row.created, "stripe", `data[${index}].created`) * 1_000,
          ).toISOString(),
          available_at:
            optionalFinite(row.available_on, "stripe", `data[${index}].available_on`) === null
              ? null
              : new Date(Number(row.available_on) * 1_000).toISOString(),
          currency: text(row.currency, "stripe", `data[${index}].currency`),
          gross_minor: finite(row.amount, "stripe", `data[${index}].amount`),
          fee_minor: finite(row.fee, "stripe", `data[${index}].fee`),
          net_minor: finite(row.net, "stripe", `data[${index}].net`),
          type: text(row.type, "stripe", `data[${index}].type`),
          reporting_category:
            typeof row.reporting_category === "string" ? row.reporting_category : null,
          status: typeof row.status === "string" ? row.status : null,
          mode: options.mode,
        };
      });
      const truncated = body.has_more === true;
      return {
        source: "stripe",
        ...baseDataset(options, context, window),
        dimensions: ["created_at", "currency", "type", "reporting_category", "mode"],
        quality: truncated ? "partial" : "complete",
        limitations: [
          `Stripe ${options.mode} mode is isolated from the other mode; values are integer minor currency units.`,
          "Customer, source, description, and payment payload fields are deliberately discarded before normalization.",
          ...(truncated
            ? [
                `Stripe reported has_more after ${limit} balance transactions; this sync is partial.`,
              ]
            : []),
        ],
        rows,
      };
    },
  });
}

export function createBrevoAggregateConnector(options: BaseHttpConnectorOptions): DataConnector {
  return createProviderHttpConnector({
    ...options,
    id: "brevo.transactional-aggregate",
    provider: "brevo",
    source: "brevo",
    request(secret, context, window) {
      const url = new URL("https://api.brevo.com/v3/smtp/statistics/aggregatedReport");
      url.searchParams.set("startDate", window.startDate);
      url.searchParams.set("endDate", window.endDate);
      return {
        method: "GET",
        url: url.toString(),
        headers: { "api-key": secret },
        sensitiveHeaders: ["api-key"],
        sensitiveUrl: false,
        signal: context.signal,
      };
    },
    map(response, context, window) {
      const body = object(response.body, "brevo", "response");
      const safeMetric = (key: string) => optionalFinite(body[key], "brevo", key);
      return {
        source: "brevo",
        ...baseDataset(options, context, window),
        dimensions: ["reporting_window"],
        quality: "complete",
        limitations: [
          "Brevo transactional delivery aggregates do not prove inbox placement or human reading.",
          "Recipient addresses, message bodies, event payloads, and campaign content are never requested.",
          "Date boundaries follow the configured venture timezone and must be compared with the Brevo account setting.",
        ],
        rows: [
          {
            requests: safeMetric("requests"),
            delivered: safeMetric("delivered"),
            hard_bounces: safeMetric("hardBounces"),
            soft_bounces: safeMetric("softBounces"),
            blocked: safeMetric("blocked"),
            invalid: safeMetric("invalid"),
            spam_reports: safeMetric("spamReports"),
            unsubscribed: safeMetric("unsubscribed"),
            opens: safeMetric("opens"),
            unique_opens: safeMetric("uniqueOpens"),
            clicks: safeMetric("clicks"),
            unique_clicks: safeMetric("uniqueClicks"),
          },
        ],
      };
    },
  });
}

export interface RevenueCatMetricsConnectorOptions extends BaseHttpConnectorOptions {
  projectId: string;
  currency?: string;
}

export function createRevenueCatMetricsConnector(
  options: RevenueCatMetricsConnectorOptions,
): DataConnector {
  return createProviderHttpConnector({
    ...options,
    id: "revenuecat.overview-metrics",
    provider: "revenuecat",
    source: "revenuecat",
    request(secret, context) {
      const url = new URL(
        `https://api.revenuecat.com/v2/projects/${encodeURIComponent(options.projectId)}/metrics/overview`,
      );
      if (options.currency) url.searchParams.set("currency", options.currency.toUpperCase());
      return bearerRequest("GET", url.toString(), secret, undefined, context.signal);
    },
    map(response, context, window) {
      const body = object(response.body, "revenuecat", "response");
      const providerRows = array(body.metrics, "revenuecat", "metrics");
      const currency =
        typeof body.currency === "string" ? body.currency : (options.currency ?? null);
      const rows = providerRows.map((value, index) => {
        const row = object(value, "revenuecat", `metrics[${index}]`);
        return {
          metric_id: text(row.id, "revenuecat", `metrics[${index}].id`),
          unit: typeof row.unit === "string" ? row.unit : null,
          period: typeof row.period === "string" ? row.period : null,
          value: finite(row.value, "revenuecat", `metrics[${index}].value`),
          currency,
          last_updated_at:
            typeof row.last_updated_at_iso8601 === "string"
              ? row.last_updated_at_iso8601
              : optionalFinite(
                    row.last_updated_at,
                    "revenuecat",
                    `metrics[${index}].last_updated_at`,
                  ) === null
                ? null
                : new Date(Number(row.last_updated_at)).toISOString(),
        };
      });
      return {
        source: "revenuecat",
        ...baseDataset(options, context, window),
        dimensions: ["metric_id", "period", "currency"],
        quality: "partial",
        limitations: [
          "RevenueCat overview metrics are point-in-time project summaries; each metric period and last_updated_at must be interpreted separately from the requested observation window.",
          "Customer and purchase-level APIs are deliberately not called, so no app-user identifiers enter the normalized dataset.",
          "Some overview metrics may be cached or delayed by the provider.",
        ],
        rows,
      };
    },
  });
}
