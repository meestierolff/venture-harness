import type { VentureRuntime } from "@venture-harness/agent-runtime";
import { createUiActions } from "@venture-harness/ui";

export function createControlPlaneModel(runtime: VentureRuntime) {
  return {
    app: "control-plane",
    actions: createUiActions(runtime.bus).map(({ actionId, label, commandId }) => ({
      actionId,
      label,
      commandId,
    })),
  };
}
