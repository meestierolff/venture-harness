import type {
  DataConnector,
  DataConnectorContext,
  DataSourceId,
  RawProviderDataset,
} from "./types";
import { DataConnectorNotConfiguredError } from "./types";

export interface ConnectorDescriptor {
  source: DataSourceId;
  officialSurface: string;
  primaryTransport: DataConnector["transport"];
  credentialRequired: boolean;
  notes: string;
}

export const connectorDescriptors: Record<DataSourceId, ConnectorDescriptor> = {
  gsc: {
    source: "gsc",
    officialSurface: "Google Search Console API searchanalytics.query",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "Retain property, date window, row limits, and aggregation limitations.",
  },
  ga4: {
    source: "ga4",
    officialSurface: "Google Analytics Data API properties.runReport",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "Inspect sampling metadata and thresholding; consented population only.",
  },
  bing_webmaster: {
    source: "bing_webmaster",
    officialSurface: "Bing Webmaster API JSON GetRankAndTrafficStats",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "OAuth/API support is old and must be live-doctored before claiming freshness.",
  },
  bing_ai_performance: {
    source: "bing_ai_performance",
    officialSurface: "Bing Webmaster AI Performance export/API when account access exposes it",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "Sampled citation and grounding visibility is not exhaustive rank tracking.",
  },
  neon_commercial_evidence: {
    source: "neon_commercial_evidence",
    officialSurface: "Versioned SQL queries against venture-owned Neon Postgres",
    primaryTransport: "database",
    credentialRequired: true,
    notes: "Server-confirmed first-party commercial evidence is authoritative.",
  },
  stripe: {
    source: "stripe",
    officialSurface: "Stripe API balance_transactions list/read endpoint",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "Keep test/live modes separate and preserve exact approved price IDs/amounts.",
  },
  revenuecat: {
    source: "revenuecat",
    officialSurface: "RevenueCat API v2 projects/{project_id}/metrics/overview",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "Retain project/app/product/entitlement identifiers and rate-limit metadata.",
  },
  brevo: {
    source: "brevo",
    officialSurface: "Brevo transactional statistics aggregatedReport API",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "Do not ingest recipient addresses or message bodies into analytics datasets.",
  },
  app_store_connect_analytics: {
    source: "app_store_connect_analytics",
    officialSurface: "App Store Connect Analytics Reports API",
    primaryTransport: "provider_api",
    credentialRequired: true,
    notes: "Retain report instance, category, dimensions, window, and app version.",
  },
  release_log: {
    source: "release_log",
    officialSurface: "Versioned local release log",
    primaryTransport: "local",
    credentialRequired: false,
    notes: "Use to correlate changes, never to claim causation alone.",
  },
  feedback: {
    source: "feedback",
    officialSurface: "Venture-owned classified and de-identified feedback store",
    primaryTransport: "database",
    credentialRequired: true,
    notes: "No raw free-form text or personal fields in normalized analytics.",
  },
  interviews: {
    source: "interviews",
    officialSurface: "Human-reviewed de-identified interview classifications",
    primaryTransport: "local",
    credentialRequired: false,
    notes: "Keep raw interviews outside analytics and commit only approved de-identified themes.",
  },
  support: {
    source: "support",
    officialSurface: "Human-reviewed de-identified support classifications",
    primaryTransport: "database",
    credentialRequired: true,
    notes: "No raw messages, names, email addresses, or private content in normalized rows.",
  },
};

export type ProviderDatasetFetcher = (context: DataConnectorContext) => Promise<RawProviderDataset>;

/**
 * Executable connector shell. Provider adapters inject an official API/CLI/SQL
 * fetcher; tests inject deterministic fixtures. It never writes raw exports.
 */
export class DirectDataConnector implements DataConnector {
  readonly rawExportsCommitted = false as const;
  constructor(
    readonly id: string,
    readonly source: DataSourceId,
    readonly transport: DataConnector["transport"],
    readonly credentialRequired: boolean,
    private readonly fetcher: ProviderDatasetFetcher,
  ) {}

  async fetch(context: DataConnectorContext): Promise<RawProviderDataset> {
    if (this.credentialRequired && !context.credentialRef) {
      throw new Error(`credential_ref required for ${this.source}`);
    }
    const result = await this.fetcher(context);
    if (result.source !== this.source) {
      throw new Error(
        `connector ${this.id} returned source ${result.source}, expected ${this.source}`,
      );
    }
    return result;
  }
}

/**
 * Represents a declared provider source whose official read path cannot yet be
 * composed safely. It fails before auth or network access with one exact
 * operator action instead of silently disappearing from freshness reports.
 */
export class UnavailableDataConnector implements DataConnector {
  readonly rawExportsCommitted = false as const;
  readonly transport = "provider_api" as const;
  readonly credentialRequired = false;

  constructor(
    readonly id: string,
    readonly source: DataSourceId,
    private readonly reason: string,
    private readonly nextAction: string,
  ) {}

  async fetch(): Promise<RawProviderDataset> {
    throw new DataConnectorNotConfiguredError(this.reason, this.source, this.nextAction);
  }
}
