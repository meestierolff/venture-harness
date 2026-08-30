import type { VentureRuntime } from "../../packages/agent-runtime/src/index";
import type { CommandExecutionContext, JsonValue } from "../../packages/core/src/index";
import type { ProviderRegistryLaunchEffectExecutor } from "./provider-effects";
import type { LaunchEffectEvidence, MaterializationFileSystem } from "./types";
import type { LaunchGrant } from "./types";
import {
  compileVentureMaterialization,
  executeLaunchEffects,
  materializeVenture,
} from "./materializer";

export interface OnePromptLaunchResult {
  command: JsonValue;
  grantId: string;
  ventureId: string;
  planDigest: string;
  materializedFiles: readonly string[];
  evidence: readonly LaunchEffectEvidence[];
  advertisingSpendAuthorized: false;
}

export interface OnePromptLaunchStore {
  get(key: string): OnePromptLaunchResult | null;
  getCheckpoint(key: string): OnePromptLaunchCheckpoint | null;
  put(key: string, requestDigest: string, value: OnePromptLaunchResult): void;
  checkpoint(key: string, requestDigest: string, value: OnePromptLaunchCheckpoint): void;
  requestDigest(key: string): string | null;
}

export interface OnePromptLaunchCheckpoint {
  command: JsonValue;
  grantId: string;
  ventureId: string;
  planDigest: string;
  materializedFiles: readonly string[];
  evidence: readonly LaunchEffectEvidence[];
}

export function createMemoryOnePromptLaunchStore(): OnePromptLaunchStore {
  const records = new Map<
    string,
    {
      requestDigest: string;
      value?: OnePromptLaunchResult;
      checkpoint?: OnePromptLaunchCheckpoint;
    }
  >();
  const assertBound = (key: string, requestDigest: string) => {
    const prior = records.get(key);
    if (prior && prior.requestDigest !== requestDigest) {
      throw new Error("launch idempotency key is already bound to another materialization plan");
    }
    return prior;
  };
  return {
    get: (key) => {
      const value = records.get(key)?.value;
      return value ? structuredClone(value) : null;
    },
    getCheckpoint: (key) => {
      const value = records.get(key)?.checkpoint;
      return value ? structuredClone(value) : null;
    },
    requestDigest: (key) => records.get(key)?.requestDigest ?? null,
    put(key, requestDigest, value) {
      const prior = assertBound(key, requestDigest);
      records.set(key, {
        requestDigest,
        checkpoint: prior?.checkpoint,
        value: structuredClone(value),
      });
    },
    checkpoint(key, requestDigest, value) {
      const prior = assertBound(key, requestDigest);
      records.set(key, {
        requestDigest,
        value: prior?.value,
        checkpoint: structuredClone(value),
      });
    },
  };
}

export async function executeOnePromptVentureLaunch(input: {
  runtime: VentureRuntime;
  commandContext: CommandExecutionContext;
  commandIdempotencyKey: string;
  grant: LaunchGrant;
  at: Date;
  coreVersion: string;
  workflowRefSha: string;
  workflowRepository: string;
  fileSystem: MaterializationFileSystem;
  providerEffectExecutor: ProviderRegistryLaunchEffectExecutor;
  store: OnePromptLaunchStore;
  priorEvidence?: readonly LaunchEffectEvidence[];
}): Promise<OnePromptLaunchResult> {
  const command = await input.runtime.execute(
    "launch.execute",
    {
      launchId: input.grant.grantId,
      mode: input.grant.permissions.productionDeployment ? "production" : "preview",
      dryRun: false,
    },
    {
      context: input.commandContext,
      idempotencyKey: input.commandIdempotencyKey,
    },
  );
  const plan = compileVentureMaterialization({
    grant: input.grant,
    at: input.at,
    coreVersion: input.coreVersion,
    workflowRefSha: input.workflowRefSha,
    workflowRepository: input.workflowRepository,
  });
  const scopedKey = `${input.commandContext.tenant.organizationId}:${input.commandContext.tenant.ventureId}:${input.grant.grantId}:${input.commandIdempotencyKey}`;
  const priorDigest = input.store.requestDigest(scopedKey);
  if (priorDigest !== null) {
    if (priorDigest !== plan.planDigest) {
      throw new Error("launch idempotency key conflicts with a different materialization plan");
    }
  }
  input.providerEffectExecutor.prepare(plan);
  const expectedFiles = plan.files.map(({ path }) => path);
  const assertStoredLaunchBound = (stored: OnePromptLaunchCheckpoint) => {
    if (
      stored.grantId !== input.grant.grantId ||
      stored.ventureId !== plan.manifest.ventureId ||
      stored.planDigest !== plan.planDigest ||
      JSON.stringify(stored.materializedFiles) !== JSON.stringify(expectedFiles)
    ) {
      throw new Error("Stored launch state is not bound to this materialization plan");
    }
  };
  const completed = input.store.get(scopedKey);
  if (completed) {
    assertStoredLaunchBound(completed);
    if (
      completed.advertisingSpendAuthorized !== false ||
      completed.evidence.length !== plan.effects.length
    ) {
      throw new Error("Stored launch result is incomplete");
    }
    const verifiedEvidence = await Promise.all(
      completed.evidence.map((item) => input.providerEffectExecutor.validateEvidence(plan, item)),
    );
    if (verifiedEvidence.some((item, index) => item.effect !== plan.effects[index])) {
      throw new Error("Stored launch evidence order does not match the launch plan");
    }
    return Object.freeze({
      ...completed,
      command,
      evidence: Object.freeze(verifiedEvidence),
      advertisingSpendAuthorized: false,
    });
  }
  let checkpoint = input.store.getCheckpoint(scopedKey);
  if (checkpoint) assertStoredLaunchBound(checkpoint);
  if (!checkpoint) {
    const materialized = await materializeVenture(plan, input.fileSystem, input.at);
    checkpoint = Object.freeze({
      command,
      grantId: input.grant.grantId,
      ventureId: plan.manifest.ventureId,
      planDigest: plan.planDigest,
      materializedFiles: materialized.files,
      evidence: Object.freeze([]),
    });
    input.store.checkpoint(scopedKey, plan.planDigest, checkpoint);
  }
  let checkpointEvidence = [...checkpoint.evidence];
  const evidence = await executeLaunchEffects({
    plan,
    executor: input.providerEffectExecutor,
    at: input.at,
    priorEvidence: checkpoint.evidence.length > 0 ? checkpoint.evidence : input.priorEvidence,
    onEvidence: (item) => {
      checkpointEvidence = [
        ...checkpointEvidence.filter((candidate) => candidate.effect !== item.effect),
        item,
      ];
      input.store.checkpoint(scopedKey, plan.planDigest, {
        ...checkpoint!,
        evidence: Object.freeze(checkpointEvidence),
      });
    },
  });
  const result: OnePromptLaunchResult = Object.freeze({
    command,
    grantId: input.grant.grantId,
    ventureId: plan.manifest.ventureId,
    planDigest: plan.planDigest,
    materializedFiles: checkpoint.materializedFiles,
    evidence,
    advertisingSpendAuthorized: false,
  });
  input.store.put(scopedKey, plan.planDigest, result);
  return result;
}
