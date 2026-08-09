import type { CommandRunner, CredentialBroker } from "../credentials";
import {
  createNeonCommercialEvidenceConnector,
  createReleaseLogConnector,
  syncDataSources,
  type DataConnector,
  type DataSourceRequirement,
  type DataSyncResult,
} from "../data";
import { runLearningLoop } from "./engine";
import {
  deriveDescriptiveCandidates,
  deriveLearningMetrics,
  type DescriptiveCandidateRule,
  type LearningMetricDefinition,
} from "./derive";
import type {
  LearningActionCandidate,
  LearningLoopDefinition,
  LearningMetric,
  LearningReport,
} from "./types";

export interface DefaultDataLearningRuntimeOptions {
  rootDir: string;
  broker: CredentialBroker;
  commandRunner: CommandRunner;
  timezone: string;
  neon?: {
    credentialRef: string;
    sourceAccount: string;
    windowHours?: number;
    releaseVersion?: string | null;
    required?: boolean;
  };
  releaseLog?:
    | false
    | {
        path?: string;
        sourceAccount?: string;
        windowHours?: number;
        required?: boolean;
      };
  directConnectors?: readonly {
    connector: DataConnector;
    credentialRef?: string;
  }[];
  /** Declared source freshness contracts, including sources not yet configured. */
  requirements?: DataSourceRequirement[];
  metricDefinitions?: LearningMetricDefinition[];
  candidateRules?: DescriptiveCandidateRule[];
  maximumCandidates?: number;
}

export interface DefaultDataLearningRuntime {
  connectors: DataConnector[];
  requirements: DataSourceRequirement[];
  credentialRefs: Partial<Record<DataSourceRequirement["source"], string>>;
  sync(options?: { now?: Date; signal?: AbortSignal }): Promise<DataSyncResult>;
  derive(datasets: DataSyncResult["datasets"]): {
    metrics: LearningMetric[];
    candidates: LearningActionCandidate[];
  };
  learn(args: {
    definition: LearningLoopDefinition;
    syncResult: DataSyncResult;
    now?: Date;
  }): LearningReport;
}

export function createDefaultDataLearningRuntime(
  options: DefaultDataLearningRuntimeOptions,
): DefaultDataLearningRuntime {
  const connectors: DataConnector[] = [];
  const requirementsBySource = new Map<DataSourceRequirement["source"], DataSourceRequirement>();
  const credentialRefs: Partial<Record<DataSourceRequirement["source"], string>> = {};

  if (options.neon) {
    connectors.push(
      createNeonCommercialEvidenceConnector({
        broker: options.broker,
        runner: options.commandRunner,
        sourceAccount: options.neon.sourceAccount,
        timezone: options.timezone,
        windowHours: options.neon.windowHours,
        releaseVersion: options.neon.releaseVersion,
      }),
    );
    requirementsBySource.set("neon_commercial_evidence", {
      source: "neon_commercial_evidence",
      required: options.neon.required ?? true,
      freshnessHours: options.neon.windowHours ?? 24 * 7,
    });
    credentialRefs.neon_commercial_evidence = options.neon.credentialRef;
  }

  if (options.releaseLog !== false) {
    const releaseLog = options.releaseLog ?? {};
    connectors.push(
      createReleaseLogConnector({
        rootDir: options.rootDir,
        path: releaseLog.path,
        sourceAccount: releaseLog.sourceAccount,
        timezone: options.timezone,
        windowHours: releaseLog.windowHours,
      }),
    );
    requirementsBySource.set("release_log", {
      source: "release_log",
      required: releaseLog.required ?? false,
      freshnessHours: releaseLog.windowHours ?? 24 * 30,
    });
  }

  for (const entry of options.directConnectors ?? []) {
    connectors.push(entry.connector);
    if (entry.credentialRef) credentialRefs[entry.connector.source] = entry.credentialRef;
  }

  for (const requirement of options.requirements ?? []) {
    requirementsBySource.set(requirement.source, { ...requirement });
  }
  const requirements = [...requirementsBySource.values()].sort((left, right) =>
    left.source.localeCompare(right.source),
  );

  const derive = (datasets: DataSyncResult["datasets"]) => {
    const metrics = deriveLearningMetrics(datasets, options.metricDefinitions);
    const candidates = deriveDescriptiveCandidates({
      metrics,
      rules: options.candidateRules ?? [],
      maximumCandidates: options.maximumCandidates,
    });
    return { metrics, candidates };
  };

  return {
    connectors,
    requirements,
    credentialRefs,
    sync: ({ now, signal } = {}) =>
      syncDataSources(connectors, requirements, {
        now,
        signal,
        credentialRefs,
      }),
    derive,
    learn({ definition, syncResult, now }) {
      const inputs = derive(syncResult.datasets);
      return runLearningLoop({
        definition,
        freshness: syncResult.freshness,
        metrics: inputs.metrics,
        candidates: inputs.candidates,
        now,
      });
    },
  };
}
