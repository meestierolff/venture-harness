import { normalizeDataset } from "./normalize";
import type {
  DataConnector,
  DataFreshnessEntry,
  DataSourceRequirement,
  DataSyncResult,
  NormalizedDataset,
} from "./types";
import {
  DataConnectorNotConfiguredError,
  DataNormalizationError,
  DataProviderFetchError,
} from "./types";

export interface SyncOptions {
  now?: Date;
  credentialRefs?: Partial<Record<DataSourceRequirement["source"], string>>;
  signal?: AbortSignal;
}

function ageHours(now: Date, fetchedAt: string): number {
  return Math.max(0, (now.getTime() - Date.parse(fetchedAt)) / 3_600_000);
}

export function buildFreshnessReport(
  requirements: DataSourceRequirement[],
  datasets: NormalizedDataset[],
  now: Date,
): DataFreshnessEntry[] {
  return requirements.map((requirement) => {
    const candidates = datasets
      .filter((dataset) => dataset.provenance.source === requirement.source)
      .sort((a, b) => Date.parse(b.provenance.fetchedAt) - Date.parse(a.provenance.fetchedAt));
    const latest = candidates[0];
    if (!latest) {
      return {
        source: requirement.source,
        status: "missing" as const,
        fetchedAt: null,
        ageHours: null,
        freshnessHours: requirement.freshnessHours,
        required: requirement.required,
        limitation: "No normalized dataset was fetched; missing is not zero.",
      };
    }
    const age = ageHours(now, latest.provenance.fetchedAt);
    const stale = age > requirement.freshnessHours;
    return {
      source: requirement.source,
      status: stale ? ("stale" as const) : ("fresh" as const),
      fetchedAt: latest.provenance.fetchedAt,
      ageHours: Number(age.toFixed(2)),
      freshnessHours: requirement.freshnessHours,
      required: requirement.required,
      limitation: stale
        ? `Dataset age ${age.toFixed(1)}h exceeds ${requirement.freshnessHours}h.`
        : (latest.provenance.limitations[0] ?? null),
    };
  });
}

export async function syncDataSources(
  connectors: DataConnector[],
  requirements: DataSourceRequirement[],
  options: SyncOptions = {},
): Promise<DataSyncResult> {
  const now = options.now ?? new Date();
  const outcomes = await Promise.all(
    connectors.map(async (connector) => {
      const credentialRef = options.credentialRefs?.[connector.source];
      if (connector.credentialRequired && !credentialRef) {
        return {
          failure: {
            source: connector.source,
            code: "credential_missing" as const,
            message: `No credential_ref is configured for ${connector.source}.`,
            retryable: false,
            nextAction: `Run vh auth login for the provider backing ${connector.source}, then vh data sync.`,
          },
        };
      }
      try {
        const raw = await connector.fetch({ now, credentialRef, signal: options.signal });
        return { dataset: normalizeDataset(raw) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DataConnectorNotConfiguredError) {
          return {
            failure: {
              source: connector.source,
              code: "connector_not_configured" as const,
              message,
              retryable: false,
              nextAction: error.nextAction,
            },
          };
        }
        if (error instanceof DataProviderFetchError) {
          return {
            failure: {
              source: connector.source,
              code: "provider_failed" as const,
              message,
              retryable: error.retryable,
              nextAction: error.nextAction,
            },
          };
        }
        const invalid =
          error instanceof DataNormalizationError ||
          /prohibited|invalid data|timestamp|window|source account|timezone|expected/.test(message);
        return {
          failure: {
            source: connector.source,
            code: invalid ? ("invalid_data" as const) : ("provider_failed" as const),
            message,
            retryable: !invalid,
            nextAction: invalid
              ? `Fix the ${connector.source} normalization contract and rerun vh data sync.`
              : `Check provider doctor/status for ${connector.source} and retry within policy.`,
          },
        };
      }
    }),
  );
  const datasets = outcomes.flatMap((outcome) => (outcome.dataset ? [outcome.dataset] : []));
  const failures = outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
  return { datasets, failures, freshness: buildFreshnessReport(requirements, datasets, now) };
}
