import type { CommandBus, CommandInvocationOptions } from "@venture-harness/command-bus";
import type { JsonValue } from "@venture-harness/core";

export interface UiCommandAction {
  actionId: string;
  label: string;
  commandId: string;
  invoke(input: unknown, options: CommandInvocationOptions): Promise<JsonValue>;
}

export function createUiActions(bus: CommandBus): UiCommandAction[] {
  return bus.contracts().map((contract) => ({
    actionId: contract.surfaces.ui.actionId,
    label: contract.surfaces.ui.label,
    commandId: contract.id,
    invoke: (input, options) => bus.executeById(contract.id, input, options),
  }));
}
