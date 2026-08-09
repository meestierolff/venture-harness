import type { CommandBus, CommandInvocationOptions } from "@venture-harness/command-bus";
import type { JsonObject, JsonValue } from "@venture-harness/core";
import type { ProviderCapabilityRegistry, StackProfile } from "@venture-harness/provider-registry";
import type { WorkflowBackend } from "@venture-harness/workflow-backend-local";

export interface CommandPlanStep {
  id: string;
  commandId: string;
  input: JsonValue;
}

export interface CommandPlan {
  runId: string;
  steps: readonly CommandPlanStep[];
  providerCapabilities?: readonly string[];
}

export async function executeCommandPlan(options: {
  plan: CommandPlan;
  bus: CommandBus;
  invocation: CommandInvocationOptions;
  backend: WorkflowBackend;
  providerRegistry?: ProviderCapabilityRegistry;
  stackProfile?: StackProfile;
}): Promise<JsonObject> {
  if (options.plan.providerCapabilities?.length) {
    if (!options.providerRegistry || !options.stackProfile)
      throw new Error("provider registry and Stack Profile are required");
    for (const capability of options.plan.providerCapabilities)
      options.providerRegistry.resolve(capability, options.stackProfile);
  }
  const outputs: JsonValue[] = [];
  for (const [index, step] of options.plan.steps.entries()) {
    outputs.push(
      await options.bus.executeById(step.commandId, step.input, {
        ...options.invocation,
        idempotencyKey: `${options.invocation.idempotencyKey}:${step.id}`,
      }),
    );
    await options.backend.save({
      runId: options.plan.runId,
      tenant: options.invocation.context.tenant,
      sequence: index + 1,
      state: { completedStep: step.id, outputs },
    });
  }
  return { runId: options.plan.runId, status: "succeeded", outputs };
}
