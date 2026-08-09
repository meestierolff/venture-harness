import type { VentureRuntime } from "@venture-harness/agent-runtime";
import { generateOpenApi } from "@venture-harness/api-generator";

export function createCommandDocumentation(runtime: VentureRuntime) {
  return {
    app: "docs",
    title: "Venture command reference",
    openApi: generateOpenApi(runtime.bus.contracts()),
  };
}
