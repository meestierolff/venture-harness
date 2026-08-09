import type { VentureRuntime } from "@venture-harness/agent-runtime";
import { executeCommandPlan } from "@venture-harness/orchestrator";

export function createWorker(runtime: VentureRuntime) {
  return {
    app: "worker",
    execute: (options: Omit<Parameters<typeof executeCommandPlan>[0], "bus">) =>
      executeCommandPlan({ ...options, bus: runtime.bus }),
  };
}
