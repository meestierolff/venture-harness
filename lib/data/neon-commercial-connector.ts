import { z } from "zod";
import {
  assertDirectCommand,
  type CommandInvocation,
  type CommandRunner,
  type CredentialBroker,
} from "../credentials";
import { DataNormalizationError, type DataConnector, type RawProviderDataset } from "./types";

const aggregateRowSchema = z
  .object({
    record_type: z.enum(["commercial", "product"]),
    metric_id: z.string().min(1).max(200),
    event_count: z.number().int().nonnegative(),
    sample_size: z.number().int().nonnegative(),
    qualified_count: z.number().int().nonnegative(),
    price_contexts: z.array(
      z
        .object({
          plan_key: z.string().max(200).nullable(),
          displayed_price: z.string().min(1).max(200),
          billing_period: z.string().max(100).nullable(),
        })
        .strict(),
    ),
    release_versions: z.array(z.string().min(1).max(200)),
  })
  .strict();

export const NEON_COMMERCIAL_EVIDENCE_SQL = String.raw`
with bounds as (
  select
    (:'window_start')::timestamptz as window_start,
    (:'window_end')::timestamptz as window_end
),
commercial as (
  select
    'commercial'::text as record_type,
    event as metric_id,
    count(*)::bigint as event_count,
    count(distinct visitor_id)::bigint as sample_size,
    count(*) filter (where qualified is true)::bigint as qualified_count,
    coalesce(
      jsonb_agg(
        distinct jsonb_build_object(
          'plan_key', plan_key,
          'displayed_price', displayed_price,
          'billing_period', billing_period
        )
      ) filter (where displayed_price is not null),
      '[]'::jsonb
    ) as price_contexts,
    coalesce(
      jsonb_agg(distinct release_version) filter (where release_version is not null),
      '[]'::jsonb
    ) as release_versions
  from commercial_events, bounds
  where occurred_at >= bounds.window_start and occurred_at < bounds.window_end
  group by event
),
product as (
  select
    'product'::text as record_type,
    event as metric_id,
    count(*)::bigint as event_count,
    count(distinct visitor_id)::bigint as sample_size,
    0::bigint as qualified_count,
    '[]'::jsonb as price_contexts,
    coalesce(
      jsonb_agg(distinct release_version) filter (where release_version is not null),
      '[]'::jsonb
    ) as release_versions
  from product_events, bounds
  where occurred_at >= bounds.window_start and occurred_at < bounds.window_end
  group by event
)
select json_build_object(
  'record_type', record_type,
  'metric_id', metric_id,
  'event_count', event_count,
  'sample_size', sample_size,
  'qualified_count', qualified_count,
  'price_contexts', price_contexts,
  'release_versions', release_versions
)::text
from (
  select * from commercial
  union all
  select * from product
) evidence
order by record_type, metric_id;
`.trim();

export interface NeonCommercialEvidenceConnectorOptions {
  broker: CredentialBroker;
  runner: CommandRunner;
  sourceAccount: string;
  timezone: string;
  windowHours?: number;
  releaseVersion?: string | null;
  binary?: string;
}

function decoded(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Neon connection string has invalid ${label} encoding.`);
  }
}

function postgresEnvironment(secret: string): Readonly<Record<string, string | undefined>> {
  let url: URL;
  try {
    url = new URL(secret);
  } catch {
    throw new Error("Neon credential must be a postgres:// or postgresql:// connection string.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Neon credential must be a postgres:// or postgresql:// connection string.");
  }
  const database = decoded(url.pathname.replace(/^\//, ""), "database");
  if (!database) throw new Error("Neon connection string must name a database.");

  const environment: Record<string, string | undefined> = {
    DATABASE_URL: undefined,
    PGSERVICE: undefined,
    PGPASSFILE: undefined,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: database,
    PGUSER: decoded(url.username, "username"),
    PGPASSWORD: decoded(url.password, "password"),
    PGAPPNAME: "venture-harness-data-sync",
    PGOPTIONS: "",
  };
  const sslMode = url.searchParams.get("sslmode");
  const channelBinding = url.searchParams.get("channel_binding");
  const connectTimeout = url.searchParams.get("connect_timeout");
  if (sslMode) environment.PGSSLMODE = sslMode;
  if (channelBinding) environment.PGCHANNELBINDING = channelBinding;
  if (connectTimeout) environment.PGCONNECT_TIMEOUT = connectTimeout;
  return environment;
}

function parseRows(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new DataNormalizationError(
          `Neon aggregate row ${index + 1} is not valid JSON.`,
          "neon_commercial_evidence",
        );
      }
      const result = aggregateRowSchema.safeParse(parsed);
      if (!result.success) {
        throw new DataNormalizationError(
          `Neon aggregate row ${index + 1} violates the allowlisted evidence shape: ${result.error.issues
            .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
            .join("; ")}`,
          "neon_commercial_evidence",
        );
      }
      return result.data;
    });
}

function reportingWindow(now: Date, windowHours: number) {
  return {
    start: new Date(now.getTime() - windowHours * 3_600_000).toISOString(),
    end: now.toISOString(),
  };
}

export function createNeonCommercialEvidenceConnector(
  options: NeonCommercialEvidenceConnectorOptions,
): DataConnector {
  const binary = options.binary ?? "psql";
  assertDirectCommand(binary);
  const windowHours = options.windowHours ?? 24 * 7;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error("Neon evidence windowHours must be a positive finite number.");
  }
  return {
    id: "neon-commercial-evidence",
    source: "neon_commercial_evidence",
    transport: "database",
    credentialRequired: true,
    rawExportsCommitted: false,
    async fetch(context): Promise<RawProviderDataset> {
      if (!context.credentialRef) throw new Error("credential_ref required for Neon evidence");
      const window = reportingWindow(context.now, windowHours);
      const result = await options.broker.withSecret(context.credentialRef, async (secret) => {
        const env = postgresEnvironment(secret);
        for (const key of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const) {
          const value = env[key];
          if (value) options.broker.redactor.addSecret(value);
        }
        const invocation: CommandInvocation = {
          command: binary,
          args: [
            "--no-psqlrc",
            "--no-align",
            "--tuples-only",
            "--quiet",
            "--set=ON_ERROR_STOP=1",
            `--set=window_start=${window.start}`,
            `--set=window_end=${window.end}`,
            "--command",
            NEON_COMMERCIAL_EVIDENCE_SQL,
          ],
          env,
          sensitiveEnv: Object.keys(env),
          signal: context.signal,
        };
        return options.runner.run(invocation);
      });
      if (result.exitCode !== 0) {
        const detail = options.broker.redactor
          .redactText(result.stderr || result.stdout)
          .trim()
          .slice(0, 2_000);
        throw new Error(
          `Neon aggregate query exited ${result.exitCode}${detail ? `: ${detail}` : ""}`,
        );
      }
      return {
        source: "neon_commercial_evidence",
        sourceAccount: options.sourceAccount,
        fetchedAt: context.now.toISOString(),
        reportingWindow: window,
        timezone: options.timezone,
        dimensions: ["record_type", "metric_id", "price_contexts", "release_versions"],
        quality: "complete",
        limitations: [
          "Aggregate counts only; no visitor identifiers, submissions, attribution payloads, or free-form content were selected.",
          "Observed counts and release groupings are descriptive and do not establish causation.",
        ],
        releaseVersion: options.releaseVersion ?? null,
        rows: parseRows(result.stdout),
      };
    },
  };
}
