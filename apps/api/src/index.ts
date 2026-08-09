import type { VentureRuntime } from "@venture-harness/agent-runtime";
import { createRestSurface } from "@venture-harness/api-generator";

export function createApiApplication(runtime: VentureRuntime) {
  return { app: "api", surface: createRestSurface(runtime.bus) };
}
