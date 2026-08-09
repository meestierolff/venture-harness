import {
  commandFailureEnvelope,
  type CommandBus,
  type CommandFailureEnvelope,
  type CommandInvocationOptions,
} from "@venture-harness/command-bus";
import type { JsonValue } from "@venture-harness/core";

export * from "./operational.js";
export * from "./quality-runner.js";
export * from "./runtime-module.js";

export interface GeneratedCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: CommandFailureEnvelope;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function renderCliSuccess(value: JsonValue): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return String(value);
  const record = value as Record<string, JsonValue>;
  const heading = typeof record.commandId === "string" ? record.commandId : "command";
  const status = typeof record.status === "string" ? record.status : "completed";
  const mode = typeof record.mode === "string" ? ` (${record.mode})` : "";
  return `${heading}: ${status}${mode}`;
}

export function generateCliHelp(bus: CommandBus): string {
  return [
    "Venture Harness generated command surfaces",
    "",
    ...bus
      .contracts()
      .map(
        (contract) =>
          `  vh ${contract.surfaces.cli.tokens.join(" ")} --input <json> --context <json> --idempotency-key <key>\n      ${contract.description}`,
      ),
  ].join("\n");
}

export function createCliSurface(bus: CommandBus) {
  return {
    help: generateCliHelp(bus),
    async invoke(
      args: readonly string[],
      options?: Partial<CommandInvocationOptions>,
    ): Promise<GeneratedCliResult> {
      const contract = bus
        .contracts()
        .find(
          (candidate) =>
            candidate.surfaces.cli.tokens[0] === args[0] &&
            candidate.surfaces.cli.tokens[1] === args[1],
        );
      if (!contract) return { exitCode: 2, stdout: "", stderr: "unknown generated command" };
      try {
        const rawInput = flag(args, "--input");
        const rawContext = flag(args, "--context");
        const context = options?.context ?? (rawContext ? JSON.parse(rawContext) : undefined);
        const idempotencyKey = options?.idempotencyKey ?? flag(args, "--idempotency-key");
        if (!rawInput || !context || !idempotencyKey)
          throw new Error("--input, --context, and --idempotency-key are required");
        const output = await bus.executeById(contract.id, JSON.parse(rawInput), {
          context,
          idempotencyKey,
        });
        return { exitCode: 0, stdout: JSON.stringify(output), stderr: "" };
      } catch (error) {
        const failure = commandFailureEnvelope(error);
        const json = args.includes("--json");
        return {
          exitCode: 1,
          stdout: "",
          stderr: json ? JSON.stringify(failure) : failure.message,
          failure,
        };
      }
    },
  };
}
