import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { experimentsSchema } from "../config/schemas";
import { loopsSchema, createDefaultLoopsConfig, type LoopsConfig } from "../config/loop-schema";
import { providersSchema, type ProvidersConfig } from "../config/provider-schema";
import { ventureSchema } from "../config/venture-schema";
import type { CommandRunner, CredentialBroker } from "../credentials";
import {
  DATA_SOURCE_IDS,
  UnavailableDataConnector,
  buildFreshnessReport,
  createBingWebmasterConnector,
  createBrevoAggregateConnector,
  createGoogleAnalyticsConnector,
  createGoogleSearchConsoleConnector,
  createRevenueCatMetricsConnector,
  createStripeBalanceConnector,
  normalizeDataset,
  syncDataSources,
  type DataConnector,
  type DataSourceRequirement,
  type DataSyncResult,
} from "../data";
import type { HttpFetcher, ProviderId } from "../providers";
import {
  createDefaultDataLearningRuntime,
  buildOperatingCadence,
  type DescriptiveCandidateRule,
  type LearningCadence,
  type LearningLoopDefinition,
  type LearningMetricDefinition,
  type LearningReport,
  type OperatingCadence,
} from "../learning";
import {
  parseProviderLifecycleDocument,
  type VerifiedProviderLifecycleRecord,
} from "../runtime/provider-lifecycle-store";

const normalizedScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const dataSourceSchema = z.enum(DATA_SOURCE_IDS);
const normalizedDatasetSchema = z
  .object({
    id: z.string().min(1),
    provenance: z
      .object({
        source: dataSourceSchema,
        sourceAccount: z.string().min(1),
        fetchedAt: z.string().datetime({ offset: true }),
        reportingWindow: z
          .object({
            start: z.string().datetime({ offset: true }),
            end: z.string().datetime({ offset: true }),
          })
          .strict(),
        timezone: z.string().min(1),
        dimensions: z.array(z.string()),
        quality: z.enum(["complete", "partial", "sampled", "thresholded", "stale", "unavailable"]),
        limitations: z.array(z.string()),
        releaseVersion: z.string().nullable(),
      })
      .strict(),
    rows: z.array(z.record(normalizedScalarSchema)),
  })
  .strict();

const freshnessSchema = z
  .object({
    source: dataSourceSchema,
    status: z.enum(["fresh", "stale", "missing"]),
    fetchedAt: z.string().datetime({ offset: true }).nullable(),
    ageHours: z.number().finite().nonnegative().nullable(),
    freshnessHours: z.number().finite().positive(),
    required: z.boolean(),
    limitation: z.string().nullable(),
  })
  .strict();

export const persistedDataSyncSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["complete", "incomplete", "not_configured"]),
    generatedAt: z.string().datetime({ offset: true }),
    datasets: z.array(normalizedDatasetSchema),
    failures: z.array(
      z
        .object({
          source: dataSourceSchema,
          code: z.enum([
            "connector_not_configured",
            "credential_missing",
            "provider_failed",
            "invalid_data",
          ]),
          message: z.string().min(1),
          retryable: z.boolean(),
          nextAction: z.string().min(1),
        })
        .strict(),
    ),
    freshness: z.array(freshnessSchema),
    nextAction: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.datasets.forEach((dataset, index) => {
      try {
        const normalized = normalizeDataset({
          source: dataset.provenance.source,
          sourceAccount: dataset.provenance.sourceAccount,
          fetchedAt: dataset.provenance.fetchedAt,
          reportingWindow: dataset.provenance.reportingWindow,
          timezone: dataset.provenance.timezone,
          dimensions: dataset.provenance.dimensions,
          quality:
            dataset.provenance.quality === "stale" || dataset.provenance.quality === "unavailable"
              ? "partial"
              : dataset.provenance.quality,
          limitations: dataset.provenance.limitations,
          releaseVersion: dataset.provenance.releaseVersion,
          rows: dataset.rows,
        });
        if (normalized.id !== dataset.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["datasets", index, "id"],
            message: "dataset fingerprint does not match its normalized provenance and rows",
          });
        }
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["datasets", index],
          message: error instanceof Error ? error.message : "invalid normalized dataset",
        });
      }
    });
  });

export type PersistedDataSync = z.infer<typeof persistedDataSyncSchema>;
type LoopContract = LoopsConfig["loops"][string];

export interface DefaultLearningRuntimeOptions {
  rootDir: string;
  broker: CredentialBroker;
  commandRunner: CommandRunner;
  httpFetcher: HttpFetcher;
  injectedConnectors?: readonly DataConnector[];
  injectedRequirements?: readonly DataSourceRequirement[];
  now?: () => Date;
}

function readYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

function loadLoops(rootDir: string): LoopsConfig {
  const path = resolve(rootDir, "config/loops.yaml");
  return existsSync(path) ? loopsSchema.parse(readYaml(path)) : createDefaultLoopsConfig();
}

function loadProviders(rootDir: string): ProvidersConfig | null {
  const path = resolve(rootDir, "config/providers.yaml");
  return existsSync(path) ? providersSchema.parse(readYaml(path)) : null;
}

function loadProviderLifecycle(rootDir: string): VerifiedProviderLifecycleRecord[] {
  const path = resolve(rootDir, ".venture/provider-lifecycle.json");
  if (!existsSync(path)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(
      "Provider lifecycle state is corrupt JSON; restore verified evidence before data sync.",
    );
  }
  return parseProviderLifecycleDocument(value);
}

function activeExperimentState(rootDir: string): {
  hypotheses: string[];
  experiments: string[];
} {
  const path = resolve(rootDir, "config/experiments.yaml");
  if (!existsSync(path)) return { hypotheses: [], experiments: [] };
  const config = experimentsSchema.parse(readYaml(path));
  const active = config.experiments.filter((experiment) =>
    ["approved", "running"].includes(experiment.status),
  );
  return {
    hypotheses: active.map((experiment) => `${experiment.id}: ${experiment.hypothesis}`),
    experiments: active
      .filter((experiment) => experiment.status === "running")
      .map((experiment) => experiment.id),
  };
}

function loadTimezone(rootDir: string): string {
  const path = resolve(rootDir, "config/venture.yaml");
  if (!existsSync(path)) return "UTC";
  return ventureSchema.parse(readYaml(path)).venture.timezone;
}

function mergeRequirements(
  loops: LoopsConfig,
  injected: readonly DataSourceRequirement[],
): DataSourceRequirement[] {
  const bySource = new Map<DataSourceRequirement["source"], DataSourceRequirement>();
  for (const input of Object.values(loops.loops).flatMap((loop) => loop.inputs)) {
    const current = bySource.get(input.source);
    bySource.set(input.source, {
      source: input.source,
      required: input.required || (current?.required ?? false),
      freshnessHours: Math.min(input.freshness_hours, current?.freshnessHours ?? Infinity),
    });
  }
  for (const requirement of injected) {
    const current = bySource.get(requirement.source);
    bySource.set(requirement.source, {
      source: requirement.source,
      required: requirement.required || (current?.required ?? false),
      freshnessHours: Math.min(requirement.freshnessHours, current?.freshnessHours ?? Infinity),
    });
  }
  return [...bySource.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function loopForCadence(loops: LoopsConfig, cadence: LearningCadence): [string, LoopContract] {
  const matches = Object.entries(loops.loops).filter(([, loop]) => loop.cadence === cadence);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${cadence} learning loop, found ${matches.length}.`);
  }
  return matches[0];
}

function loopRequirements(
  loop: LoopContract,
  injected: readonly DataSourceRequirement[],
): DataSourceRequirement[] {
  const configured = loop.inputs.map((input) => ({
    source: input.source,
    required: input.required,
    freshnessHours: input.freshness_hours,
  }));
  return mergeRequirements(
    {
      contract_version: 1,
      loops: {
        selected: {
          ...loop,
          inputs: configured.map((item) => ({
            source: item.source,
            required: item.required,
            freshness_hours: item.freshnessHours,
          })),
        },
      },
      extensions: {},
    },
    injected,
  );
}

function metricDefinitions(loop: LoopContract): LearningMetricDefinition[] | undefined {
  if (loop.metric_definitions.length === 0) return undefined;
  return loop.metric_definitions.map((definition) => ({
    id: definition.id,
    source: definition.source,
    filter: definition.filter,
    value:
      definition.operation === "sum"
        ? { operation: "sum" as const, field: definition.field! }
        : { operation: "count_rows" as const },
    sampleSizeField: definition.sample_size_field ?? undefined,
    limitation: definition.limitation ?? undefined,
  }));
}

function candidateRules(loop: LoopContract): DescriptiveCandidateRule[] {
  return loop.candidate_rules.map((rule) => ({
    id: rule.id,
    metricId: rule.metric_id,
    comparator: rule.comparator,
    threshold: rule.threshold,
    minimumSampleSize: rule.minimum_sample_size,
    journey: rule.journey,
    title: rule.title,
    confidence: rule.confidence,
    risk: rule.risk,
    effectTypes: rule.effect_types,
    protectsWinner: rule.protects_winner,
  }));
}

function learningDefinition(
  id: string,
  loop: LoopContract,
  requirements: readonly DataSourceRequirement[],
): LearningLoopDefinition {
  return {
    id,
    cadence: loop.cadence,
    requiredSources: requirements
      .filter((requirement) => requirement.required)
      .map(({ source, freshnessHours }) => ({ source, freshnessHours })),
    // An unconfigured loop must stop for evidence, never report a content-free success.
    primaryMetrics:
      loop.primary_metrics.length > 0
        ? loop.primary_metrics.map((metric) => metric.id)
        : ["primary_success_signal"],
    guardrailMetrics: loop.guardrail_metrics.map((metric) => metric.id),
    decisionRules: [...loop.decision_rules],
    maximumActions: loop.maximum_actions,
    maximumIterations: loop.maximum_iterations,
    autonomy: loop.autonomy,
    authorizedEffectTypes: [...loop.authorized_effect_types],
    outputDestination: loop.output_destination,
    nextRunAt: loop.next_run_at,
    stopCondition: loop.stop_condition,
  };
}

function neonOptions(
  providers: ProvidersConfig | null,
  requirements: readonly DataSourceRequirement[],
  lifecycle: readonly VerifiedProviderLifecycleRecord[],
) {
  const requirement = requirements.find(({ source }) => source === "neon_commercial_evidence");
  const neon = providers?.providers.neon;
  const lifecycleRecords = lifecycle.filter(
    (record) =>
      record.provider === "neon" &&
      record.state === "verified" &&
      (record.capability === "database" || record.capability === "database_provisioning"),
  );
  const uniqueLifecycleValue = (type: "project_id" | "database_name") => {
    const values = new Set(
      lifecycleRecords.flatMap((record) =>
        record.resourceRefs
          .filter((reference) => reference.type === type)
          .map((reference) => reference.value),
      ),
    );
    return values.size === 1 ? [...values][0] : undefined;
  };
  if (!requirement || !neon || (neon.state !== "verified" && lifecycleRecords.length === 0)) {
    return undefined;
  }
  const credentialRef = neon.external_resource_ids.database_credential_ref ?? neon.credential_ref;
  const projectId = neon.external_resource_ids.project_id ?? uniqueLifecycleValue("project_id");
  const databaseName =
    neon.external_resource_ids.database_name ?? uniqueLifecycleValue("database_name");
  if (!credentialRef || !projectId || !databaseName) return undefined;
  return {
    credentialRef,
    sourceAccount: `${projectId}/${databaseName}`,
    windowHours: requirement.freshnessHours,
    releaseVersion: null,
    required: requirement.required,
  };
}

type DirectConnectorEntry = {
  connector: DataConnector;
  credentialRef?: string;
};

function uniqueValue(values: readonly (string | null | undefined)[]): string | undefined {
  const unique = new Set(values.filter((value): value is string => Boolean(value?.trim())));
  return unique.size === 1 ? [...unique][0] : undefined;
}

function lifecycleValues(
  lifecycle: readonly VerifiedProviderLifecycleRecord[],
  provider: ProviderId,
  capabilities: readonly string[],
  type: VerifiedProviderLifecycleRecord["resourceRefs"][number]["type"],
): string[] {
  return lifecycle
    .filter(
      (record) =>
        record.provider === provider &&
        record.state === "verified" &&
        capabilities.includes(record.capability),
    )
    .flatMap((record) =>
      record.resourceRefs
        .filter((reference) => reference.type === type)
        .map((reference) => reference.value),
    );
}

function providerVerified(
  providers: ProvidersConfig | null,
  lifecycle: readonly VerifiedProviderLifecycleRecord[],
  provider: ProviderId,
  capabilities: readonly string[],
): boolean {
  return (
    providers?.providers[provider]?.state === "verified" ||
    lifecycle.some(
      (record) => record.provider === provider && capabilities.includes(record.capability),
    )
  );
}

function unavailableConnector(
  source: DataSourceRequirement["source"],
  reason: string,
  nextAction: string,
): DirectConnectorEntry {
  return {
    connector: new UnavailableDataConnector(`${source}.not-configured`, source, reason, nextAction),
  };
}

function sourceRequirement(
  requirements: readonly DataSourceRequirement[],
  source: DataSourceRequirement["source"],
): DataSourceRequirement | undefined {
  return requirements.find((requirement) => requirement.source === source);
}

function directHttpConnectors(input: {
  providers: ProvidersConfig | null;
  lifecycle: readonly VerifiedProviderLifecycleRecord[];
  requirements: readonly DataSourceRequirement[];
  broker: CredentialBroker;
  fetcher: HttpFetcher;
  timezone: string;
}): DirectConnectorEntry[] {
  const entries: DirectConnectorEntry[] = [];
  const addUnavailable = (
    source: DataSourceRequirement["source"],
    provider: ProviderId,
    detail: string,
  ) =>
    entries.push(
      unavailableConnector(
        source,
        `${source} is declared but its official read connector is not configured: ${detail}`,
        `Run vh auth login ${provider}; obtain authorized provider read-back; record only the cred:// reference and required safe resource IDs in config/providers.yaml; then rerun vh data sync.`,
      ),
    );

  const gscRequirement = sourceRequirement(input.requirements, "gsc");
  if (gscRequirement) {
    const state = input.providers?.providers.google;
    const capabilities = ["search_console_site", "site"];
    const siteUrl = uniqueValue([
      state?.external_resource_ids.site_url,
      ...lifecycleValues(input.lifecycle, "google", capabilities, "site_url"),
    ]);
    if (!providerVerified(input.providers, input.lifecycle, "google", capabilities)) {
      addUnavailable("gsc", "google", "a verified Search Console site is required");
    } else if (!state?.credential_ref || !siteUrl) {
      addUnavailable(
        "gsc",
        "google",
        "providers.google.credential_ref and one unambiguous site_url are required",
      );
    } else {
      entries.push({
        credentialRef: state.credential_ref,
        connector: createGoogleSearchConsoleConnector({
          broker: input.broker,
          fetcher: input.fetcher,
          siteUrl,
          sourceAccount: siteUrl,
          timezone: "America/Los_Angeles",
          windowHours: gscRequirement.freshnessHours,
        }),
      });
    }
  }

  const ga4Requirement = sourceRequirement(input.requirements, "ga4");
  if (ga4Requirement) {
    const state = input.providers?.providers.google;
    const capabilities = ["analytics_property"];
    const propertyId = uniqueValue([
      state?.external_resource_ids.property_id,
      ...lifecycleValues(input.lifecycle, "google", capabilities, "property_id"),
    ]);
    if (!providerVerified(input.providers, input.lifecycle, "google", capabilities)) {
      addUnavailable("ga4", "google", "a verified GA4 property is required");
    } else if (!state?.credential_ref || !propertyId || !/^\d+$/.test(propertyId)) {
      addUnavailable(
        "ga4",
        "google",
        "providers.google.credential_ref and one numeric property_id are required",
      );
    } else {
      entries.push({
        credentialRef: state.credential_ref,
        connector: createGoogleAnalyticsConnector({
          broker: input.broker,
          fetcher: input.fetcher,
          propertyId,
          sourceAccount: propertyId,
          timezone: input.timezone,
          windowHours: ga4Requirement.freshnessHours,
        }),
      });
    }
  }

  const bingRequirement = sourceRequirement(input.requirements, "bing_webmaster");
  if (bingRequirement) {
    const state = input.providers?.providers.bing;
    const capabilities = ["site"];
    const siteUrl = uniqueValue([
      state?.external_resource_ids.site_url,
      ...lifecycleValues(input.lifecycle, "bing", capabilities, "site_url"),
    ]);
    const authMode = state?.external_resource_ids.auth_mode;
    if (!providerVerified(input.providers, input.lifecycle, "bing", capabilities)) {
      addUnavailable("bing_webmaster", "bing", "a verified Bing Webmaster site is required");
    } else if (
      !state?.credential_ref ||
      !siteUrl ||
      (authMode !== "api_key" && authMode !== "oauth")
    ) {
      addUnavailable(
        "bing_webmaster",
        "bing",
        "providers.bing.credential_ref, one site_url, and external_resource_ids.auth_mode (api_key or oauth) are required",
      );
    } else {
      entries.push({
        credentialRef: state.credential_ref,
        connector: createBingWebmasterConnector({
          broker: input.broker,
          fetcher: input.fetcher,
          siteUrl,
          authMode,
          sourceAccount: siteUrl,
          timezone: "UTC",
          windowHours: bingRequirement.freshnessHours,
        }),
      });
    }
  }

  if (sourceRequirement(input.requirements, "bing_ai_performance")) {
    addUnavailable(
      "bing_ai_performance",
      "bing",
      "Bing AI Performance has no stable provider-neutral API contract in this harness; an account-specific official export adapter must be injected",
    );
  }

  const stripeRequirement = sourceRequirement(input.requirements, "stripe");
  if (stripeRequirement) {
    const state = input.providers?.providers.stripe;
    const capabilities = ["product", "price", "webhook", "billing_portal"];
    const accountId = uniqueValue([
      state?.account_id,
      state?.external_resource_ids.account_id,
      ...lifecycleValues(input.lifecycle, "stripe", capabilities, "account_id"),
    ]);
    const mode = state?.external_resource_ids.mode;
    if (!providerVerified(input.providers, input.lifecycle, "stripe", capabilities)) {
      addUnavailable("stripe", "stripe", "verified Stripe setup read-back is required");
    } else if (!state?.credential_ref || !accountId || (mode !== "test" && mode !== "live")) {
      addUnavailable(
        "stripe",
        "stripe",
        "providers.stripe.credential_ref, account_id, and external_resource_ids.mode (test or live) are required to prevent mode mixing",
      );
    } else {
      entries.push({
        credentialRef: state.credential_ref,
        connector: createStripeBalanceConnector({
          broker: input.broker,
          fetcher: input.fetcher,
          mode,
          sourceAccount: `${accountId}:${mode}`,
          timezone: "UTC",
          windowHours: stripeRequirement.freshnessHours,
        }),
      });
    }
  }

  const brevoRequirement = sourceRequirement(input.requirements, "brevo");
  if (brevoRequirement) {
    const state = input.providers?.providers.brevo;
    const capabilities = ["sending_domain", "sender", "template", "webhook"];
    const accountId = uniqueValue([
      state?.account_id,
      state?.external_resource_ids.account_id,
      ...lifecycleValues(input.lifecycle, "brevo", capabilities, "account_id"),
    ]);
    if (!providerVerified(input.providers, input.lifecycle, "brevo", capabilities)) {
      addUnavailable("brevo", "brevo", "verified Brevo setup read-back is required");
    } else if (!state?.credential_ref || !accountId) {
      addUnavailable(
        "brevo",
        "brevo",
        "providers.brevo.credential_ref and account_id are required",
      );
    } else {
      entries.push({
        credentialRef: state.credential_ref,
        connector: createBrevoAggregateConnector({
          broker: input.broker,
          fetcher: input.fetcher,
          sourceAccount: accountId,
          timezone: input.timezone,
          windowHours: brevoRequirement.freshnessHours,
        }),
      });
    }
  }

  const revenueCatRequirement = sourceRequirement(input.requirements, "revenuecat");
  if (revenueCatRequirement) {
    const state = input.providers?.providers.revenuecat;
    const capabilities = ["app", "entitlement", "offering", "webhook"];
    const projectId = uniqueValue([
      state?.external_resource_ids.project_id,
      ...lifecycleValues(input.lifecycle, "revenuecat", capabilities, "project_id"),
    ]);
    if (!providerVerified(input.providers, input.lifecycle, "revenuecat", capabilities)) {
      addUnavailable("revenuecat", "revenuecat", "verified RevenueCat setup read-back is required");
    } else if (!state?.credential_ref || !projectId) {
      addUnavailable(
        "revenuecat",
        "revenuecat",
        "providers.revenuecat.credential_ref and one project_id are required",
      );
    } else {
      entries.push({
        credentialRef: state.credential_ref,
        connector: createRevenueCatMetricsConnector({
          broker: input.broker,
          fetcher: input.fetcher,
          projectId,
          sourceAccount: projectId,
          timezone: "UTC",
          windowHours: revenueCatRequirement.freshnessHours,
        }),
      });
    }
  }

  if (sourceRequirement(input.requirements, "app_store_connect_analytics")) {
    entries.push(
      unavailableConnector(
        "app_store_connect_analytics",
        "App Store Connect Analytics requires a pre-existing report request plus instance/segment discovery, signed JWT auth, and CSV segment parsing; data sync will not create the report request or guess a segment schema.",
        "Create the Analytics Report Request in an explicitly authorized App Store Connect operation, record its safe request/app IDs, and inject a JWT-signed report-instance/segment connector before rerunning vh data sync.",
      ),
    );
  }

  return entries;
}

function statusFor(
  connectors: readonly DataConnector[],
  result: DataSyncResult,
): PersistedDataSync["status"] {
  if (connectors.length === 0) return "not_configured";
  if (
    result.datasets.length === 0 &&
    result.failures.length > 0 &&
    result.failures.every((failure) => failure.code === "connector_not_configured")
  ) {
    return "not_configured";
  }
  const requiredGap = result.freshness.some((entry) => entry.required && entry.status !== "fresh");
  return result.failures.length === 0 && !requiredGap ? "complete" : "incomplete";
}

function nextAction(status: PersistedDataSync["status"]): string {
  if (status === "complete") {
    return "Run vh learn <cadence>; inspect provenance, sample limits, and every proposed action.";
  }
  if (status === "not_configured") {
    return "Configure an official read-only connector in a declared loop input and its credential_ref; no fixture or missing-as-zero fallback was used.";
  }
  return "Resolve the reported connector failures or stale required sources, then rerun vh data sync; missing is not zero.";
}

function composeRuntime(
  options: DefaultLearningRuntimeOptions,
  requirements: DataSourceRequirement[],
  loop?: LoopContract,
) {
  const providers = loadProviders(options.rootDir);
  const lifecycle = loadProviderLifecycle(options.rootDir);
  const releaseRequirement = requirements.find(({ source }) => source === "release_log");
  const timezone = loadTimezone(options.rootDir);
  return createDefaultDataLearningRuntime({
    rootDir: options.rootDir,
    broker: options.broker,
    commandRunner: options.commandRunner,
    timezone,
    neon: neonOptions(providers, requirements, lifecycle),
    releaseLog: releaseRequirement
      ? {
          required: releaseRequirement.required,
          windowHours: releaseRequirement.freshnessHours,
        }
      : false,
    directConnectors: directHttpConnectors({
      providers,
      lifecycle,
      requirements,
      broker: options.broker,
      fetcher: options.httpFetcher,
      timezone,
    }),
    requirements,
    metricDefinitions: loop ? metricDefinitions(loop) : undefined,
    candidateRules: loop ? candidateRules(loop) : [],
    maximumCandidates: loop?.maximum_actions,
  });
}

function mergeConnectors(
  defaults: readonly DataConnector[],
  injected: readonly DataConnector[],
): DataConnector[] {
  const bySource = new Map(defaults.map((connector) => [connector.source, connector]));
  for (const connector of injected) bySource.set(connector.source, connector);
  return [...bySource.values()].sort((left, right) => left.source.localeCompare(right.source));
}

export function createDefaultLearningRuntime(options: DefaultLearningRuntimeOptions) {
  const currentTime = options.now ?? (() => new Date());
  const injectedRequirements = options.injectedRequirements ?? [];
  const injectedConnectors = options.injectedConnectors ?? [];

  return {
    async sync(): Promise<PersistedDataSync> {
      const loops = loadLoops(options.rootDir);
      const requirements = mergeRequirements(loops, injectedRequirements);
      const runtime = composeRuntime(options, requirements);
      const connectors = mergeConnectors(runtime.connectors, injectedConnectors);
      const at = currentTime();
      const result =
        connectors.length > 0
          ? await syncDataSources(connectors, requirements, {
              now: at,
              credentialRefs: runtime.credentialRefs,
            })
          : {
              datasets: [],
              failures: [],
              freshness: buildFreshnessReport(requirements, [], at),
            };
      const status = statusFor(connectors, result);
      return persistedDataSyncSchema.parse({
        schemaVersion: 1,
        status,
        generatedAt: at.toISOString(),
        ...result,
        nextAction: nextAction(status),
      });
    },

    learn(
      cadence: LearningCadence,
      persisted: unknown,
    ): { definition: LearningLoopDefinition; report: LearningReport } {
      const loops = loadLoops(options.rootDir);
      const [id, loop] = loopForCadence(loops, cadence);
      const requirements = loopRequirements(loop, injectedRequirements);
      const definition = learningDefinition(id, loop, requirements);
      const sync = persistedDataSyncSchema.parse(persisted);
      const runtime = composeRuntime(options, requirements, loop);
      return {
        definition,
        report: runtime.learn({ definition, syncResult: sync, now: currentTime() }),
      };
    },

    missingArtifact(cadence: LearningCadence): PersistedDataSync {
      const loops = loadLoops(options.rootDir);
      const [, loop] = loopForCadence(loops, cadence);
      const requirements = loopRequirements(loop, injectedRequirements);
      const at = currentTime();
      return persistedDataSyncSchema.parse({
        schemaVersion: 1,
        status: "not_configured",
        generatedAt: at.toISOString(),
        datasets: [],
        failures: [],
        freshness: buildFreshnessReport(requirements, [], at),
        nextAction:
          "Run vh data sync after configuring direct read-only connectors; missing is not zero.",
      });
    },

    operatingCadence(persisted: unknown): OperatingCadence {
      const loops = loadLoops(options.rootDir);
      const sync = persistedDataSyncSchema.parse(persisted);
      const definitions = Object.entries(loops.loops).map(([id, loop]) =>
        learningDefinition(id, loop, loopRequirements(loop, injectedRequirements)),
      );
      const active = activeExperimentState(options.rootDir);
      const configurationBlockers =
        sync.status === "complete" ? [] : [`data_sync:${sync.status}; ${sync.nextAction}`];
      return buildOperatingCadence({
        loops: definitions,
        freshness: sync.freshness,
        activeHypotheses: active.hypotheses,
        activeExperiments: active.experiments,
        activeBlockers: [
          ...configurationBlockers,
          ...sync.failures.map(
            (failure) => `${failure.source}: ${failure.code}; ${failure.nextAction}`,
          ),
        ],
        now: currentTime(),
      });
    },
  };
}
