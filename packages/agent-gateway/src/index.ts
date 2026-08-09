import type { VentureRuntime } from "@venture-harness/agent-runtime";
import { createRestSurface } from "@venture-harness/api-generator";
import { createCliSurface } from "@venture-harness/cli-generator";
import { createMcpSurface } from "@venture-harness/mcp-generator";
import { createSdkSurface } from "@venture-harness/sdk-generator";
import { createUiActions } from "@venture-harness/ui";

export function createAgentGateway(runtime: VentureRuntime) {
  return {
    direct: runtime,
    rest: createRestSurface(runtime.bus),
    cli: createCliSurface(runtime.bus),
    mcp: createMcpSurface(runtime.bus),
    sdk: createSdkSurface(runtime.bus),
    ui: createUiActions(runtime.bus),
  };
}
