import type {
  AnyCommandContract,
  CommandBus,
  CommandInvocationOptions,
} from "@venture-harness/command-bus";
import { commandFailureEnvelope, commandFailureHttpStatus } from "@venture-harness/command-bus";
import type { JsonObject, JsonValue } from "@venture-harness/core";

export interface RestCommandRequest extends CommandInvocationOptions {
  method: string;
  path: string;
  body: unknown;
}

export interface RestCommandResponse {
  status: number;
  body: JsonValue;
}

export function generateOpenApi(contracts: readonly AnyCommandContract[]): JsonObject {
  const paths: JsonObject = {};
  for (const contract of contracts) {
    paths[contract.surfaces.rest.path] = {
      post: {
        operationId: contract.surfaces.rest.operationId,
        summary: contract.title,
        description: contract.description,
        "x-command-id": contract.id,
        requestBody: {
          required: true,
          content: { "application/json": { schema: contract.input.jsonSchema } },
        },
        responses: {
          "200": {
            description: "Command completed",
            content: { "application/json": { schema: contract.output.jsonSchema } },
          },
        },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: "Venture Command API", version: "0.2.0" }, paths };
}

export function createRestSurface(bus: CommandBus) {
  const routes = new Map(
    bus.contracts().map((contract) => [contract.surfaces.rest.path, contract]),
  );
  return {
    openApi: generateOpenApi(bus.contracts()),
    async handle(request: RestCommandRequest): Promise<RestCommandResponse> {
      const contract = routes.get(request.path);
      if (!contract || request.method.toUpperCase() !== contract.surfaces.rest.method) {
        return { status: 404, body: { error: "command_route_not_found" } };
      }
      try {
        return {
          status: 200,
          body: await bus.executeById(contract.id, request.body, {
            context: request.context,
            idempotencyKey: request.idempotencyKey,
          }),
        };
      } catch (error) {
        const failure = commandFailureEnvelope(error);
        return {
          status: commandFailureHttpStatus(failure.code),
          body: failure,
        };
      }
    },
  };
}
