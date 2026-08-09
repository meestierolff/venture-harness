import { createHash } from "node:crypto";
import { stableJson, type JsonObject, type JsonValue } from "@venture-harness/core";
import {
  ProductionLoopRuntime,
  type LoopRunRecord,
  type VentureLoopId,
} from "@venture-harness/loops";
import type { LearningRunInput, OperationalCommandOutput } from "./operational.js";
import type { CommandHandlerContext } from "@venture-harness/command-bus";

export const LEARNING_CADENCE_LOOP_IDS = Object.freeze({
  daily: "daily_early_signal",
  weekly: "weekly_growth",
  biweekly: "biweekly_product",
  monthly: "monthly_strategy",
} as const satisfies Record<LearningRunInput["cadence"], VentureLoopId>);

function runId(input: LearningRunInput, handler: CommandHandlerContext): string {
  const binding = stableJson({
    cadence: input.cadence,
    commandId: handler.commandId,
    idempotencyKey: handler.idempotencyKey,
    tenant: {
      organizationId: handler.context.tenant.organizationId,
      ventureId: handler.context.tenant.ventureId,
    },
  });
  return `learn-${input.cadence}-${createHash("sha256").update(binding).digest("hex").slice(0, 32)}`;
}

function sourceEvidenceRefs(run: LoopRunRecord): readonly string[] {
  return [
    ...new Set(
      run.evaluations.flatMap(({ sources }) => sources.flatMap(({ evidenceRefs }) => evidenceRefs)),
    ),
  ].sort();
}

function learningOutput(
  cadence: LearningRunInput["cadence"],
  run: LoopRunRecord,
): OperationalCommandOutput {
  if (run.actions.some(({ action }) => action.effect !== "none")) {
    throw new Error("report/propose learning cadences cannot apply effects");
  }
  if (run.status === "running" || run.status === "waiting_for_reconciliation") {
    throw new Error("report/propose learning cadence did not reach a terminal result");
  }
  return {
    commandId: "learn.run",
    mode: "local_write",
    status: run.status,
    data: {
      cadence,
      loopId: run.loopId,
      runId: run.runId,
      trigger: run.trigger as unknown as JsonValue,
      stopReason: run.stopReason,
      completionSatisfied: run.evaluations.at(-1)?.completionSatisfied === true,
      iterationCount: run.evaluations.length,
      actions: run.actions as unknown as JsonValue,
      actionsApplied: 0,
      evidenceRefs: sourceEvidenceRefs(run) as unknown as JsonValue,
      limitations: run.limitations as unknown as JsonValue,
      output: run.output as unknown as JsonValue,
      updatedAt: run.updatedAt,
      externalEffects: false,
    } satisfies JsonObject,
  };
}

/**
 * Reach the concrete durable provider-evidence runtime from the canonical
 * command handler. The runtime is deliberately optional at composition time;
 * callers without one retain the truthful unconfigured result.
 */
export async function runLearningCadence(
  runtime: ProductionLoopRuntime,
  input: LearningRunInput,
  handler: CommandHandlerContext,
): Promise<OperationalCommandOutput> {
  const loopId = LEARNING_CADENCE_LOOP_IDS[input.cadence];
  const run = await runtime.run({
    loopId,
    tenant: handler.context.tenant,
    runId: runId(input, handler),
  });
  if (run.loopId !== loopId) throw new Error("learning loop returned a different cadence");
  return learningOutput(input.cadence, run);
}
