import type { CommandBus, CommandInvocationOptions } from "@venture-harness/command-bus";
import type { JsonObject, JsonValue } from "@venture-harness/core";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  commandId: string;
}

export function generateMcpTools(bus: CommandBus): McpToolDescriptor[] {
  return bus.contracts().map((contract) => ({
    name: contract.surfaces.mcp.tool,
    description: contract.description,
    inputSchema: contract.input.jsonSchema,
    commandId: contract.id,
  }));
}

export function createMcpSurface(bus: CommandBus) {
  const tools = generateMcpTools(bus);
  return {
    tools,
    async callTool(
      name: string,
      input: unknown,
      options: CommandInvocationOptions,
    ): Promise<JsonValue> {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
      return bus.executeById(tool.commandId, input, options);
    },
  };
}
