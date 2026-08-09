import {
  defineRuntimeSchema,
  objectValue,
  schemaObject,
  stringValue,
  type RuntimeSchema,
} from "@venture-harness/config";
import {
  CommandDefinitiveNoEffectError,
  defineCommandContract,
  type CommandBus,
  type CommandContract,
  type CommandHandlerContext,
} from "@venture-harness/command-bus";
import type { JsonObject, JsonValue } from "@venture-harness/core";

export const STACK_COMMAND_ACTIONS = [
  "doctor",
  "plan",
  "dry_run",
  "apply",
  "read_back",
  "reconcile",
] as const;

export type StackCommandAction = (typeof STACK_COMMAND_ACTIONS)[number];
export type StackCommandEnvironment = "local" | "preview" | "sandbox" | "production" | "testflight";

export interface StackProfileCatalogEntry extends JsonObject {
  profileId: string;
  profileVersion: string;
  label: string;
  verification: "local_contract_only" | "unconfigured";
  implementationConfigured: boolean;
  credentialState: "unconfigured" | "host_managed";
  liveVerification: "pending";
  providerEffectsConfigured: boolean;
  bindings: JsonObject;
}

export type StackSelectionInput = JsonObject & {
  profileId: string;
  profileVersion: string;
  role: string;
  providerId: string;
  capability: string;
  environment: StackCommandEnvironment;
};

export type StackOperationInput = StackSelectionInput & {
  operationId: string;
  payload: JsonObject;
};

export type StackCommandInput = StackSelectionInput | StackOperationInput;
export type StackInvocationState = boolean | "unknown";

export interface StackCommandBoundaryResult extends JsonObject {
  status: string;
  providerInvoked: StackInvocationState;
  externalEffectOccurred: StackInvocationState;
  liveVerified: boolean;
  data: JsonObject;
}

export interface StackCommandResult extends JsonObject {
  commandId: string;
  action: StackCommandAction;
  profileId: string;
  profileVersion: string;
  role: string;
  providerId: string;
  capability: string;
  status: string;
  providerInvoked: StackInvocationState;
  externalEffectOccurred: StackInvocationState;
  liveVerified: boolean;
  data: JsonObject;
}

export interface StackCommandRuntime {
  readonly catalog: readonly StackProfileCatalogEntry[];
  execute(
    action: StackCommandAction,
    input: StackCommandInput,
    context: CommandHandlerContext,
  ): Promise<StackCommandBoundaryResult> | StackCommandBoundaryResult;
}

const ENVIRONMENTS: readonly StackCommandEnvironment[] = [
  "local",
  "preview",
  "sandbox",
  "production",
  "testflight",
];
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:~-]{0,254}$/u;
const SAFE_ROLE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;
const SECRET_KEY =
  /(?:authorization|api[-_]?key|secret|password|credential|access[-_]?token|refresh[-_]?token)/iu;
const SECRET_VALUE =
  /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;

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

function safeId(record: Record<string, unknown>, field: string): string {
  const value = stringValue(record, field)!;
  if (!SAFE_ID.test(value)) {
    throw new Error(`${field} must be a safe identifier of at most 255 characters`);
  }
  return value;
}

function assertNoSecrets(value: unknown, path = "value", allowReferences = false): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`, allowReferences));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const reference = allowReferences && /(?:ref|reference)s?$/iu.test(key);
      if (SECRET_KEY.test(key) && !reference) {
        throw new Error(`secret-bearing field ${path}.${key} is forbidden`);
      }
      assertNoSecrets(entry, `${path}.${key}`, allowReferences);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    throw new Error(`credential-like value is forbidden at ${path}`);
  }
}

function parseSelection(value: unknown, name: string): StackSelectionInput {
  const input = exactObject(value, name, [
    "profileId",
    "profileVersion",
    "role",
    "providerId",
    "capability",
    "environment",
  ]);
  const role = stringValue(input, "role")!;
  if (!SAFE_ROLE.test(role)) throw new Error("role must be a namespaced capability role");
  const parsed: StackSelectionInput = {
    profileId: safeId(input, "profileId"),
    profileVersion: safeId(input, "profileVersion"),
    role,
    providerId: safeId(input, "providerId"),
    capability: safeId(input, "capability"),
    environment: stringValue(input, "environment", {
      allowed: ENVIRONMENTS,
    }) as StackCommandEnvironment,
  };
  assertNoSecrets(parsed);
  return parsed;
}

function parseOperation(value: unknown, name: string): StackOperationInput {
  const input = exactObject(value, name, [
    "profileId",
    "profileVersion",
    "role",
    "providerId",
    "capability",
    "environment",
    "operationId",
    "payload",
  ]);
  const selection = parseSelection(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "operationId" && key !== "payload"),
    ),
    name,
  );
  const parsed: StackOperationInput = {
    ...selection,
    operationId: safeId(input, "operationId"),
    payload: objectValue(input.payload, "payload") as JsonObject,
  };
  assertNoSecrets(parsed, name, true);
  return parsed;
}

const selectionInput = defineRuntimeSchema<StackSelectionInput>({
  name: "StackSelectionInput",
  jsonSchema: schemaObject(
    {
      profileId: { type: "string", minLength: 1, maxLength: 255 },
      profileVersion: { type: "string", minLength: 1, maxLength: 255 },
      role: { type: "string", minLength: 3, maxLength: 255 },
      providerId: { type: "string", minLength: 1, maxLength: 255 },
      capability: { type: "string", minLength: 1, maxLength: 255 },
      environment: { type: "string", enum: [...ENVIRONMENTS] },
    },
    ["profileId", "profileVersion", "role", "providerId", "capability", "environment"],
  ),
  parse(value) {
    return parseSelection(value, "StackSelectionInput");
  },
});

const operationInput = defineRuntimeSchema<StackOperationInput>({
  name: "StackOperationInput",
  jsonSchema: schemaObject(
    {
      ...(selectionInput.jsonSchema.properties as JsonObject),
      operationId: { type: "string", minLength: 1, maxLength: 255 },
      payload: { type: "object" },
    },
    [
      "profileId",
      "profileVersion",
      "role",
      "providerId",
      "capability",
      "environment",
      "operationId",
      "payload",
    ],
  ),
  parse(value) {
    return parseOperation(value, "StackOperationInput");
  },
});

function outputSchema(commandId: string): RuntimeSchema<StackCommandResult> {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject(
      {
        commandId: { const: commandId },
        action: { type: "string", enum: [...STACK_COMMAND_ACTIONS] },
        profileId: { type: "string" },
        profileVersion: { type: "string" },
        role: { type: "string" },
        providerId: { type: "string" },
        capability: { type: "string" },
        status: { type: "string" },
        providerInvoked: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
        externalEffectOccurred: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
        liveVerified: { type: "boolean" },
        data: { type: "object" },
      },
      [
        "commandId",
        "action",
        "profileId",
        "profileVersion",
        "role",
        "providerId",
        "capability",
        "status",
        "providerInvoked",
        "externalEffectOccurred",
        "liveVerified",
        "data",
      ],
    ),
    parse(value) {
      const output = exactObject(value, `${commandId}Output`, [
        "commandId",
        "action",
        "profileId",
        "profileVersion",
        "role",
        "providerId",
        "capability",
        "status",
        "providerInvoked",
        "externalEffectOccurred",
        "liveVerified",
        "data",
      ]);
      if (output.commandId !== commandId) throw new Error(`invalid ${commandId} output`);
      const providerInvoked = output.providerInvoked;
      const externalEffectOccurred = output.externalEffectOccurred;
      if (typeof providerInvoked !== "boolean" && providerInvoked !== "unknown") {
        throw new Error("providerInvoked must be boolean or unknown");
      }
      if (typeof externalEffectOccurred !== "boolean" && externalEffectOccurred !== "unknown") {
        throw new Error("externalEffectOccurred must be boolean or unknown");
      }
      if (typeof output.liveVerified !== "boolean") throw new Error("liveVerified must be boolean");
      const data = objectValue(output.data, "data") as JsonObject;
      assertNoSecrets(data, "data", true);
      return {
        commandId,
        action: stringValue(output, "action", {
          allowed: STACK_COMMAND_ACTIONS,
        }) as StackCommandAction,
        profileId: stringValue(output, "profileId")!,
        profileVersion: stringValue(output, "profileVersion")!,
        role: stringValue(output, "role")!,
        providerId: stringValue(output, "providerId")!,
        capability: stringValue(output, "capability")!,
        status: stringValue(output, "status")!,
        providerInvoked,
        externalEffectOccurred,
        liveVerified: output.liveVerified,
        data,
      };
    },
  });
}

function stackCommand<Input extends StackCommandInput>(definition: {
  id: string;
  title: string;
  description: string;
  input: RuntimeSchema<Input>;
  grant: boolean;
  scopes: readonly string[];
  effect: "read" | "write";
}): CommandContract<Input, StackCommandResult> {
  const { grant, scopes, ...contract } = definition;
  return defineCommandContract({
    ...contract,
    version: 1,
    output: outputSchema(definition.id),
    requirements: { activeSubscription: false, entitlements: [], grant, scopes },
  });
}

export const stackDoctorCommand = stackCommand({
  id: "stack.doctor",
  title: "Inspect Stack Capability",
  description: "Inspect the exact provider adapter selected by an attested Stack Profile.",
  input: selectionInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "read",
});

export const stackPlanCommand = stackCommand({
  id: "stack.plan",
  title: "Plan Stack Capability",
  description: "Build a no-effect provider plan through an exact versioned Stack Profile binding.",
  input: operationInput,
  grant: false,
  scopes: [],
  effect: "read",
});

export const stackDryRunCommand = stackCommand({
  id: "stack.dry-run",
  title: "Dry Run Stack Capability",
  description: "Exercise a selected adapter plan locally without executing a provider effect.",
  input: operationInput,
  grant: false,
  scopes: [],
  effect: "read",
});

export const stackApplyCommand = stackCommand({
  id: "stack.apply",
  title: "Apply Stack Capability",
  description:
    "Apply an authorized profile-bound provider plan with durable command and provider idempotency.",
  input: operationInput,
  grant: true,
  scopes: ["provider.apply"],
  effect: "write",
});

export const stackReadBackCommand = stackCommand({
  id: "stack.read-back",
  title: "Read Back Stack Capability",
  description: "Read back the exact stored profile-bound operation without repeating its effect.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write",
});

export const stackReconcileCommand = stackCommand({
  id: "stack.reconcile",
  title: "Reconcile Stack Capability",
  description:
    "Reconcile a previously attempted profile-bound operation through its durable provider ledger.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write",
});

export const stackOperationCommandContracts = [
  stackDoctorCommand,
  stackPlanCommand,
  stackDryRunCommand,
  stackApplyCommand,
  stackReadBackCommand,
  stackReconcileCommand,
] as const;

const unconfiguredCatalog: readonly StackProfileCatalogEntry[] = Object.freeze([
  Object.freeze({
    profileId: "local-safe",
    profileVersion: "0.2.0",
    label: "Local safe",
    verification: "unconfigured",
    implementationConfigured: false,
    credentialState: "unconfigured",
    liveVerification: "pending",
    providerEffectsConfigured: false,
    bindings: {},
  }),
]);

export const unconfiguredStackCommandRuntime: StackCommandRuntime = Object.freeze({
  catalog: unconfiguredCatalog,
  execute(action: StackCommandAction, input: StackCommandInput): StackCommandBoundaryResult {
    return {
      status: "unconfigured",
      providerInvoked: false,
      externalEffectOccurred: false,
      liveVerified: false,
      data: {
        action,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        role: input.role,
        providerId: input.providerId,
        capability: input.capability,
        externalRequestMade: false,
        fixtureFallbackUsed: false,
        diagnostic: {
          code: "stack_runtime_unconfigured",
          message: "No authorized Stack Profile provider runtime is injected",
          nextAction:
            "Inject the repository provider bridge with exact grants and durable idempotency stores",
        },
      },
    };
  },
});

function commandResult(
  commandId: string,
  action: StackCommandAction,
  input: StackCommandInput,
  boundary: StackCommandBoundaryResult,
): StackCommandResult {
  return {
    commandId,
    action,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    role: input.role,
    providerId: input.providerId,
    capability: input.capability,
    status: boundary.status,
    providerInvoked: boundary.providerInvoked,
    externalEffectOccurred: boundary.externalEffectOccurred,
    liveVerified: boundary.liveVerified,
    data: boundary.data,
  };
}

function register<Input extends StackCommandInput>(
  bus: CommandBus,
  runtime: StackCommandRuntime,
  contract: CommandContract<Input, StackCommandResult>,
  action: StackCommandAction,
): void {
  bus.register(contract, async (input, handler) => {
    let boundary: StackCommandBoundaryResult;
    try {
      boundary = await runtime.execute(action, input, handler);
    } catch {
      throw new Error(
        "The Stack Profile runtime failed without a verified outcome; reconcile before retry",
      );
    }
    const direct = boundary.data.diagnostic;
    const nested =
      boundary.data.result &&
      typeof boundary.data.result === "object" &&
      !Array.isArray(boundary.data.result)
        ? (boundary.data.result as JsonObject).diagnostic
        : undefined;
    const diagnostic = direct ?? nested;
    const failureStatuses = new Set([
      "unconfigured",
      "runtime_failed",
      "context_unavailable",
      "blocked",
      "failed",
      "idempotency_conflict",
    ]);
    if (
      failureStatuses.has(boundary.status) &&
      diagnostic &&
      typeof diagnostic === "object" &&
      !Array.isArray(diagnostic)
    ) {
      const record = diagnostic as JsonObject;
      const code = typeof record.code === "string" ? record.code : "stack_command_failed";
      const message =
        typeof record.message === "string"
          ? record.message
          : "The Stack Profile command did not complete successfully";
      const failure = `${code}: ${message}`;
      if (boundary.externalEffectOccurred === false) {
        throw new CommandDefinitiveNoEffectError(failure, "handler_failed");
      }
      throw new Error(failure);
    }
    return commandResult(contract.id, action, input, boundary);
  });
}

export function registerStackOperationCommands(
  bus: CommandBus,
  runtime: StackCommandRuntime = unconfiguredStackCommandRuntime,
): void {
  register(bus, runtime, stackDoctorCommand, "doctor");
  register(bus, runtime, stackPlanCommand, "plan");
  register(bus, runtime, stackDryRunCommand, "dry_run");
  register(bus, runtime, stackApplyCommand, "apply");
  register(bus, runtime, stackReadBackCommand, "read_back");
  register(bus, runtime, stackReconcileCommand, "reconcile");
}

export function summarizeStackContract(commandId: string): JsonObject {
  const contract = stackOperationCommandContracts.find((candidate) => candidate.id === commandId);
  if (!contract) throw new Error(`unknown Stack Profile command: ${commandId}`);
  return {
    id: contract.id,
    title: contract.title,
    description: contract.description,
    surfaces: contract.surfaces as unknown as JsonValue,
  };
}
