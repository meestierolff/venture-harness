import type { CommandBus, CommandInvocationOptions } from "@venture-harness/command-bus";
import type { JsonValue } from "@venture-harness/core";

export type SdkCommandMethod = (
  input: unknown,
  options: CommandInvocationOptions,
) => Promise<JsonValue>;

export interface GeneratedSdk {
  invoke(commandId: string, input: unknown, options: CommandInvocationOptions): Promise<JsonValue>;
  commands: Record<string, Record<string, SdkCommandMethod>>;
}

export function createSdkSurface(bus: CommandBus): GeneratedSdk {
  const commands: GeneratedSdk["commands"] = {};
  for (const contract of bus.contracts()) {
    const { namespace, method } = contract.surfaces.sdk;
    commands[namespace] ??= {};
    commands[namespace][method] = (input, options) => bus.executeById(contract.id, input, options);
  }
  return {
    invoke: (commandId, input, options) => bus.executeById(commandId, input, options),
    commands,
  };
}
