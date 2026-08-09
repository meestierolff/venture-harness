import {
  defineRuntimeSchema,
  objectValue,
  schemaObject,
  stringValue,
  type RuntimeSchema,
} from "@venture-harness/config";
import {
  defineCommandContract,
  type CommandBus,
  type CommandContract,
  type CommandHandlerContext,
} from "@venture-harness/command-bus";
import { assertCredentialFree, type JsonObject, type JsonValue } from "@venture-harness/core";

/**
 * Production-shaped customer service input. The platform operator and venture
 * are deliberately taken from the authenticated command context rather than
 * accepted from a caller-controlled payload.
 */
export type RecursiveServiceCommandInput = JsonObject & {
  customerOrganizationId: string;
  subscriptionId: string;
  entitlementId: string;
  serviceGrantId: string;
  providerConnectionId: string;
  capability: string;
  authorizationEnvelopeId: string;
  runId: string;
  nodeId: string;
  correlationId: string;
  causationId: string;
  usageUnits: number;
  payload: JsonObject;
};

export type RecursiveServiceCommandOutput = JsonObject & {
  commandId: string;
  operatorId: string;
  ventureId: string;
  customerOrganizationId: string;
  status: "completed";
  data: JsonObject;
};

export type RecursiveServiceReconcileOutput = JsonObject & {
  commandId: string;
  executionCommandId: string;
  operatorId: string;
  ventureId: string;
  customerOrganizationId: string;
  providerOperationId: string;
  status: "completed" | "released" | "manual_required";
  data: JsonObject;
};

export type RecursiveServiceReconcileInput = JsonObject & {
  customerOrganizationId: string;
  subscriptionId: string;
  entitlementId: string;
  serviceGrantId: string;
  providerConnectionId: string;
  capability: string;
  reconciliationAuthorizationEnvelopeId: string;
  runId: string;
  nodeId: string;
  correlationId: string;
  causationId: string;
  usageUnits: number;
  payload: JsonObject;
  operationIdempotencyKey: string;
};

export interface RecursiveCommandRuntime {
  execute(
    input: RecursiveServiceCommandInput,
    context: CommandHandlerContext,
  ): Promise<RecursiveServiceCommandOutput> | RecursiveServiceCommandOutput;
  reconcile(
    input: RecursiveServiceReconcileInput,
    context: CommandHandlerContext,
    executionCommandId: string,
  ): Promise<RecursiveServiceReconcileOutput> | RecursiveServiceReconcileOutput;
}

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,254}$/u;

function exactObject(
  value: unknown,
  name: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  }
  return record;
}

function identifier(record: Record<string, unknown>, field: string): string {
  const value = stringValue(record, field)!;
  try {
    assertCredentialFree(value, field);
  } catch {
    throw new Error(`credential material is forbidden in ${field}`);
  }
  if (value !== value.trim() || !SAFE_ID.test(value)) {
    throw new Error(`${field} must be a canonical identifier of at most 255 characters`);
  }
  return value;
}

function assertJsonSafe(value: unknown, path: string): void {
  try {
    assertCredentialFree(value, path);
  } catch {
    throw new Error(`credential or non-JSON material is forbidden in ${path}`);
  }
}

const INPUT_FIELDS = [
  "customerOrganizationId",
  "subscriptionId",
  "entitlementId",
  "serviceGrantId",
  "providerConnectionId",
  "capability",
  "authorizationEnvelopeId",
  "runId",
  "nodeId",
  "correlationId",
  "causationId",
  "usageUnits",
  "payload",
] as const;
const RECONCILE_INPUT_FIELDS = INPUT_FIELDS.filter((field) => field !== "authorizationEnvelopeId");

const recursiveInput = defineRuntimeSchema<RecursiveServiceCommandInput>({
  name: "RecursiveServiceCommandInput",
  jsonSchema: schemaObject(
    {
      customerOrganizationId: { type: "string", minLength: 1, maxLength: 255 },
      subscriptionId: { type: "string", minLength: 1, maxLength: 255 },
      entitlementId: { type: "string", minLength: 1, maxLength: 255 },
      serviceGrantId: { type: "string", minLength: 1, maxLength: 255 },
      providerConnectionId: { type: "string", minLength: 1, maxLength: 255 },
      capability: { type: "string", minLength: 1, maxLength: 255 },
      authorizationEnvelopeId: { type: "string", minLength: 1, maxLength: 255 },
      runId: { type: "string", minLength: 1, maxLength: 255 },
      nodeId: { type: "string", minLength: 1, maxLength: 255 },
      correlationId: { type: "string", minLength: 1, maxLength: 255 },
      causationId: { type: "string", minLength: 1, maxLength: 255 },
      usageUnits: { type: "integer", minimum: 1 },
      payload: { type: "object" },
    },
    [...INPUT_FIELDS],
  ),
  parse(value) {
    const input = exactObject(value, "RecursiveServiceCommandInput", INPUT_FIELDS);
    if (!Number.isSafeInteger(input.usageUnits) || Number(input.usageUnits) < 1) {
      throw new Error("usageUnits must be a positive safe integer");
    }
    const payload = objectValue(input.payload, "payload") as JsonObject;
    assertJsonSafe(payload, "payload");
    return {
      customerOrganizationId: identifier(input, "customerOrganizationId"),
      subscriptionId: identifier(input, "subscriptionId"),
      entitlementId: identifier(input, "entitlementId"),
      serviceGrantId: identifier(input, "serviceGrantId"),
      providerConnectionId: identifier(input, "providerConnectionId"),
      capability: identifier(input, "capability"),
      authorizationEnvelopeId: identifier(input, "authorizationEnvelopeId"),
      runId: identifier(input, "runId"),
      nodeId: identifier(input, "nodeId"),
      correlationId: identifier(input, "correlationId"),
      causationId: identifier(input, "causationId"),
      usageUnits: Number(input.usageUnits),
      payload,
    };
  },
});

const recursiveReconcileInput = defineRuntimeSchema<RecursiveServiceReconcileInput>({
  name: "RecursiveServiceReconcileInput",
  jsonSchema: schemaObject(
    {
      customerOrganizationId: { type: "string", minLength: 1, maxLength: 255 },
      subscriptionId: { type: "string", minLength: 1, maxLength: 255 },
      entitlementId: { type: "string", minLength: 1, maxLength: 255 },
      serviceGrantId: { type: "string", minLength: 1, maxLength: 255 },
      providerConnectionId: { type: "string", minLength: 1, maxLength: 255 },
      capability: { type: "string", minLength: 1, maxLength: 255 },
      reconciliationAuthorizationEnvelopeId: {
        type: "string",
        minLength: 1,
        maxLength: 255,
      },
      runId: { type: "string", minLength: 1, maxLength: 255 },
      nodeId: { type: "string", minLength: 1, maxLength: 255 },
      correlationId: { type: "string", minLength: 1, maxLength: 255 },
      causationId: { type: "string", minLength: 1, maxLength: 255 },
      usageUnits: { type: "integer", minimum: 1 },
      payload: { type: "object" },
      operationIdempotencyKey: { type: "string", minLength: 1, maxLength: 255 },
    },
    [...RECONCILE_INPUT_FIELDS, "reconciliationAuthorizationEnvelopeId", "operationIdempotencyKey"],
  ),
  parse(value) {
    const input = exactObject(value, "RecursiveServiceReconcileInput", [
      ...RECONCILE_INPUT_FIELDS,
      "reconciliationAuthorizationEnvelopeId",
      "operationIdempotencyKey",
    ]);
    const base = recursiveInput.parse(
      Object.fromEntries(
        INPUT_FIELDS.map((field) => [
          field,
          field === "authorizationEnvelopeId"
            ? input.reconciliationAuthorizationEnvelopeId
            : input[field],
        ]),
      ),
    );
    const { authorizationEnvelopeId: _authorizationEnvelopeId, ...immutable } = base;
    void _authorizationEnvelopeId;
    return {
      ...immutable,
      reconciliationAuthorizationEnvelopeId: identifier(
        input,
        "reconciliationAuthorizationEnvelopeId",
      ),
      operationIdempotencyKey: identifier(input, "operationIdempotencyKey"),
    };
  },
});

function recursiveOutput(commandId: string): RuntimeSchema<RecursiveServiceCommandOutput> {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject(
      {
        commandId: { const: commandId },
        operatorId: { type: "string" },
        ventureId: { type: "string" },
        customerOrganizationId: { type: "string" },
        status: { const: "completed" },
        data: { type: "object" },
      },
      ["commandId", "operatorId", "ventureId", "customerOrganizationId", "status", "data"],
    ),
    parse(value) {
      const output = exactObject(value, `${commandId}Output`, [
        "commandId",
        "operatorId",
        "ventureId",
        "customerOrganizationId",
        "status",
        "data",
      ]);
      if (output.commandId !== commandId || output.status !== "completed") {
        throw new Error(`invalid ${commandId} output`);
      }
      const data = objectValue(output.data, "data") as JsonObject;
      assertJsonSafe(data, "data");
      return {
        commandId,
        operatorId: identifier(output, "operatorId"),
        ventureId: identifier(output, "ventureId"),
        customerOrganizationId: identifier(output, "customerOrganizationId"),
        status: "completed",
        data,
      };
    },
  });
}

function recursiveReconcileOutput(
  commandId: string,
  executionCommandId: string,
): RuntimeSchema<RecursiveServiceReconcileOutput> {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject(
      {
        commandId: { const: commandId },
        executionCommandId: { const: executionCommandId },
        operatorId: { type: "string" },
        ventureId: { type: "string" },
        customerOrganizationId: { type: "string" },
        providerOperationId: { type: "string" },
        status: { type: "string", enum: ["completed", "released", "manual_required"] },
        data: { type: "object" },
      },
      [
        "commandId",
        "executionCommandId",
        "operatorId",
        "ventureId",
        "customerOrganizationId",
        "providerOperationId",
        "status",
        "data",
      ],
    ),
    parse(value) {
      const output = exactObject(value, `${commandId}Output`, [
        "commandId",
        "executionCommandId",
        "operatorId",
        "ventureId",
        "customerOrganizationId",
        "providerOperationId",
        "status",
        "data",
      ]);
      if (
        output.commandId !== commandId ||
        output.executionCommandId !== executionCommandId ||
        (output.status !== "completed" &&
          output.status !== "released" &&
          output.status !== "manual_required")
      ) {
        throw new Error(`invalid ${commandId} output`);
      }
      const data = objectValue(output.data, "data") as JsonObject;
      assertJsonSafe(data, "data");
      return {
        commandId,
        executionCommandId,
        operatorId: identifier(output, "operatorId"),
        ventureId: identifier(output, "ventureId"),
        customerOrganizationId: identifier(output, "customerOrganizationId"),
        providerOperationId: identifier(output, "providerOperationId"),
        status: output.status,
        data,
      };
    },
  });
}

export interface RecursiveServiceCommandDefinition {
  id: string;
  title: string;
  description: string;
  requiredCommandScopes?: readonly string[];
  meter?: string;
}

export type RecursiveServiceCommandContract = CommandContract<
  RecursiveServiceCommandInput,
  RecursiveServiceCommandOutput
>;

export type RecursiveServiceReconcileContract = CommandContract<
  RecursiveServiceReconcileInput,
  RecursiveServiceReconcileOutput
>;

export interface RecursiveServiceReconcileDefinition {
  id: string;
  executionCommandId: string;
  title: string;
  description: string;
  requiredCommandScopes?: readonly string[];
  meter?: string;
}

export interface RecursiveServiceReconcileRegistration {
  readonly contract: RecursiveServiceReconcileContract;
  readonly executionCommandId: string;
}

/** Define one venture/Service-Blueprint command as the source of all six surfaces. */
export function defineRecursiveServiceCommand(
  definition: RecursiveServiceCommandDefinition,
): RecursiveServiceCommandContract {
  return defineCommandContract({
    id: definition.id,
    version: 1,
    title: definition.title,
    description: definition.description,
    input: recursiveInput,
    output: recursiveOutput(definition.id),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant: true,
      scopes: definition.requiredCommandScopes ?? ["service.execute"],
    },
    effect: "write",
    meter: definition.meter ?? "service_executions",
  });
}

/** Define the read-back-only recovery command paired with one service command. */
export function defineRecursiveServiceReconcileCommand(
  definition: RecursiveServiceReconcileDefinition,
): RecursiveServiceReconcileRegistration {
  const contract = defineCommandContract({
    id: definition.id,
    version: 1,
    title: definition.title,
    description: definition.description,
    input: recursiveReconcileInput,
    output: recursiveReconcileOutput(definition.id, definition.executionCommandId),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant: true,
      scopes: definition.requiredCommandScopes ?? ["service.reconcile"],
    },
    effect: "write",
    meter: definition.meter ?? "service_reconciliations",
  });
  return Object.freeze({ contract, executionCommandId: definition.executionCommandId });
}

export const recursiveServiceExecuteCommand = defineRecursiveServiceCommand({
  id: "service.execute",
  title: "Execute Customer Service",
  description:
    "Execute one customer-scoped Service Blueprint through subscription, entitlement, Service Grant, Agent Grant, provider-connection, and authorization checks.",
});

export const recursiveServiceReconcileCommand = defineRecursiveServiceReconcileCommand({
  id: "service.reconcile",
  executionCommandId: recursiveServiceExecuteCommand.id,
  title: "Reconcile Customer Service",
  description:
    "Read back one durable provider operation and settle its exact result or confirmed no-effect usage without repeating the provider operation.",
});

export const recursiveCommandContracts = [recursiveServiceExecuteCommand] as const;
export const recursiveReconcileCommandRegistrations = [recursiveServiceReconcileCommand] as const;

export function registerRecursiveCommands(
  bus: CommandBus,
  runtime: RecursiveCommandRuntime,
  contracts: readonly RecursiveServiceCommandContract[] = recursiveCommandContracts,
): void {
  for (const contract of contracts) {
    bus.register(contract, (input, context) => runtime.execute(input, context));
  }
}

export function registerRecursiveReconcileCommands(
  bus: CommandBus,
  runtime: RecursiveCommandRuntime,
  registrations: readonly RecursiveServiceReconcileRegistration[] = recursiveReconcileCommandRegistrations,
): void {
  for (const { contract, executionCommandId } of registrations) {
    bus.register(contract, (input, context) =>
      runtime.reconcile(input, context, executionCommandId),
    );
  }
}

export function recursiveCommandInputFor(commandId: string): RuntimeSchema<JsonObject> | null {
  const contract = recursiveCommandContracts.find(({ id }) => id === commandId);
  return (contract?.input as RuntimeSchema<JsonObject> | undefined) ?? null;
}

export type RecursiveCommandJsonValue = JsonValue;
