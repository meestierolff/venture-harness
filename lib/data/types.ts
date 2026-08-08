export const DATA_SOURCE_IDS = [
  "gsc",
  "ga4",
  "bing_webmaster",
  "bing_ai_performance",
  "neon_commercial_evidence",
  "stripe",
  "revenuecat",
  "brevo",
  "app_store_connect_analytics",
  "release_log",
  "feedback",
  "interviews",
  "support",
] as const;

export type DataSourceId = (typeof DATA_SOURCE_IDS)[number];
export type DataQualityStatus =
  "complete" | "partial" | "sampled" | "thresholded" | "stale" | "unavailable";

export type NormalizedScalar = string | number | boolean | null;
export type NormalizedRow = Record<string, NormalizedScalar>;

export interface ReportingWindow {
  start: string;
  end: string;
}

export interface DatasetProvenance {
  source: DataSourceId;
  sourceAccount: string;
  fetchedAt: string;
  reportingWindow: ReportingWindow;
  timezone: string;
  dimensions: string[];
  quality: DataQualityStatus;
  limitations: string[];
  releaseVersion: string | null;
}

export interface NormalizedDataset {
  id: string;
  provenance: DatasetProvenance;
  rows: NormalizedRow[];
}

export interface RawProviderDataset {
  source: DataSourceId;
  sourceAccount: string;
  fetchedAt: string;
  reportingWindow: ReportingWindow;
  timezone: string;
  dimensions: string[];
  quality?: Exclude<DataQualityStatus, "stale" | "unavailable">;
  limitations?: string[];
  releaseVersion?: string | null;
  rows: Record<string, unknown>[];
}

export interface DataConnectorContext {
  now: Date;
  credentialRef?: string;
  signal?: AbortSignal;
}

export interface DataConnector {
  id: string;
  source: DataSourceId;
  transport: "provider_api" | "provider_cli" | "database" | "local" | "fixture";
  credentialRequired: boolean;
  rawExportsCommitted: false;
  fetch(context: DataConnectorContext): Promise<RawProviderDataset>;
}

export interface DataSourceRequirement {
  source: DataSourceId;
  required: boolean;
  freshnessHours: number;
}

export interface DataSyncResult {
  datasets: NormalizedDataset[];
  failures: {
    source: DataSourceId;
    code: "connector_not_configured" | "credential_missing" | "provider_failed" | "invalid_data";
    message: string;
    retryable: boolean;
    nextAction: string;
  }[];
  freshness: DataFreshnessEntry[];
}

export interface DataFreshnessEntry {
  source: DataSourceId;
  status: "fresh" | "stale" | "missing";
  fetchedAt: string | null;
  ageHours: number | null;
  freshnessHours: number;
  required: boolean;
  limitation: string | null;
}

export class DataNormalizationError extends Error {
  constructor(
    message: string,
    readonly source: DataSourceId,
  ) {
    super(message);
    this.name = "DataNormalizationError";
  }
}

export class DataConnectorNotConfiguredError extends Error {
  constructor(
    message: string,
    readonly source: DataSourceId,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = "DataConnectorNotConfiguredError";
  }
}

export class DataProviderFetchError extends Error {
  constructor(
    message: string,
    readonly source: DataSourceId,
    readonly retryable: boolean,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = "DataProviderFetchError";
  }
}
