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

export type PlatformOperationEffect = "none" | "applied" | "unknown";

export interface PlatformOperationBoundary {
  /** A stable domain status, never an unverified success claim. */
  status: string;
  /** Evidence used by the CommandBus to decide whether a failed write is safely retryable. */
  effect: PlatformOperationEffect;
  data: JsonObject;
}

export type AuthCommandAction = "login" | "status" | "test" | "revoke";
export type UpgradeCommandAction = "plan" | "dry_run" | "apply" | "status";
export type FleetCommandAction = "status" | "plan" | "rollout" | "resume";

export type AuthLoginInput = JsonObject & {
  providerId: string;
  credentialRef?: string;
  backend?: string;
  kind?: string;
  scopes: string[];
};
export type AuthInspectInput = JsonObject & {
  providerId?: string;
  credentialRef?: string;
};
export type UpgradeReleaseInput = JsonObject & { releaseLocator: string };
export type EmptyPlatformInput = JsonObject;
export type FleetStatusInput = JsonObject & { runId?: string };
export type FleetOperationInput = JsonObject & {
  runId: string;
  releaseId: string;
  ventureIds: string[];
  batchSize: number;
};

export type AuthCommandInput = AuthLoginInput | AuthInspectInput;
export type UpgradeCommandInput = UpgradeReleaseInput | EmptyPlatformInput;
export type FleetCommandInput = FleetStatusInput | FleetOperationInput;

export interface AuthCommandRuntime {
  execute(
    action: AuthCommandAction,
    input: AuthCommandInput,
    context: CommandHandlerContext,
  ): Promise<PlatformOperationBoundary> | PlatformOperationBoundary;
}

export interface UpgradeCommandRuntime {
  execute(
    action: UpgradeCommandAction,
    input: UpgradeCommandInput,
    context: CommandHandlerContext,
  ): Promise<PlatformOperationBoundary> | PlatformOperationBoundary;
}

export interface FleetCommandRuntime {
  execute(
    action: FleetCommandAction,
    input: FleetCommandInput,
    context: CommandHandlerContext,
  ): Promise<PlatformOperationBoundary> | PlatformOperationBoundary;
}

export type PlatformCommandMode = "read_only" | "local_write" | "external_write";

export type PlatformCommandOutput = JsonObject & {
  commandId: string;
  mode: PlatformCommandMode;
  status: string;
  data: JsonObject;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/*-]{0,254}$/u;
const CREDENTIAL_REF = /^cred:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SECRET_VALUE =
  /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|ghp|github_pat)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;

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
  if (value !== value.trim() || !SAFE_ID.test(value)) {
    throw new Error(`${field} must be a canonical identifier of at most 255 characters`);
  }
  return value;
}

function optionalSafeId(record: Record<string, unknown>, field: string): string | undefined {
  if (record[field] === undefined) return undefined;
  return safeId(record, field);
}

function credentialRef(record: Record<string, unknown>, optional = false): string | undefined {
  const value = stringValue(record, "credentialRef", { optional });
  if (value === undefined) return undefined;
  if (!CREDENTIAL_REF.test(value)) {
    throw new Error("credentialRef must be a metadata-only cred:// reference");
  }
  return value;
}

function safeStringArray(value: unknown, field: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  const parsed = value.map((item) => item.trim());
  if (parsed.some((item) => !pattern.test(item))) {
    throw new Error(`${field} contains an invalid identifier`);
  }
  if (new Set(parsed).size !== parsed.length)
    throw new Error(`${field} must not contain duplicates`);
  return parsed;
}

function assertJsonSafe(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:password|secret|accessToken|refreshToken|apiKey|privateKey)$/iu.test(key)) {
        throw new Error(`secret-bearing output field ${path}.${key} is forbidden`);
      }
      assertJsonSafe(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`${path} must be JSON serializable`);
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    throw new Error(`credential-like value is forbidden at ${path}`);
  }
}

const authLoginInput = defineRuntimeSchema<AuthLoginInput>({
  name: "AuthLoginInput",
  jsonSchema: schemaObject(
    {
      providerId: { type: "string", minLength: 1, maxLength: 255 },
      credentialRef: { type: "string", pattern: "^cred://" },
      backend: { type: "string", minLength: 1, maxLength: 255 },
      kind: { type: "string", minLength: 1, maxLength: 255 },
      scopes: { type: "array", items: { type: "string" }, default: [] },
    },
    ["providerId"],
  ),
  parse(value) {
    const input = exactObject(value, "AuthLoginInput", [
      "providerId",
      "credentialRef",
      "backend",
      "kind",
      "scopes",
    ]);
    const parsed = {
      providerId: safeId(input, "providerId"),
      ...(credentialRef(input, true) ? { credentialRef: credentialRef(input, true) } : {}),
      ...(optionalSafeId(input, "backend") ? { backend: optionalSafeId(input, "backend") } : {}),
      ...(optionalSafeId(input, "kind") ? { kind: optionalSafeId(input, "kind") } : {}),
      scopes: input.scopes === undefined ? [] : safeStringArray(input.scopes, "scopes", SAFE_SCOPE),
    };
    assertJsonSafe(parsed, "auth.login");
    return parsed;
  },
});

const authInspectInput = defineRuntimeSchema<AuthInspectInput>({
  name: "AuthInspectInput",
  jsonSchema: schemaObject(
    {
      providerId: { type: "string", minLength: 1, maxLength: 255 },
      credentialRef: { type: "string", pattern: "^cred://" },
    },
    [],
  ),
  parse(value) {
    const input = exactObject(value, "AuthInspectInput", ["providerId", "credentialRef"]);
    return {
      ...(optionalSafeId(input, "providerId")
        ? { providerId: optionalSafeId(input, "providerId") }
        : {}),
      ...(credentialRef(input, true) ? { credentialRef: credentialRef(input, true) } : {}),
    };
  },
});

const upgradeReleaseInput = defineRuntimeSchema<UpgradeReleaseInput>({
  name: "UpgradeReleaseInput",
  jsonSchema: schemaObject({ releaseLocator: { type: "string", minLength: 1, maxLength: 4096 } }, [
    "releaseLocator",
  ]),
  parse(value) {
    const input = exactObject(value, "UpgradeReleaseInput", ["releaseLocator"]);
    const releaseLocator = stringValue(input, "releaseLocator")!.trim();
    if (releaseLocator.length > 4096 || releaseLocator.includes("\0")) {
      throw new Error("releaseLocator must be a local path of at most 4096 characters");
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(releaseLocator)) {
      throw new Error("releaseLocator must be a trusted local filesystem path, not a URL");
    }
    assertJsonSafe(releaseLocator, "releaseLocator");
    return { releaseLocator };
  },
});

const emptyPlatformInput = defineRuntimeSchema<EmptyPlatformInput>({
  name: "EmptyPlatformInput",
  jsonSchema: schemaObject({}, []),
  parse(value) {
    exactObject(value, "EmptyPlatformInput", []);
    return {};
  },
});

const fleetStatusInput = defineRuntimeSchema<FleetStatusInput>({
  name: "FleetStatusInput",
  jsonSchema: schemaObject({ runId: { type: "string", minLength: 1, maxLength: 255 } }, []),
  parse(value) {
    const input = exactObject(value, "FleetStatusInput", ["runId"]);
    const runId = optionalSafeId(input, "runId");
    if (runId) return { runId };
    return {} as FleetStatusInput;
  },
});

const fleetOperationInput = defineRuntimeSchema<FleetOperationInput>({
  name: "FleetOperationInput",
  jsonSchema: schemaObject(
    {
      runId: { type: "string", minLength: 1, maxLength: 255 },
      releaseId: { type: "string", minLength: 1, maxLength: 255 },
      ventureIds: { type: "array", items: { type: "string" }, minItems: 1 },
      batchSize: { type: "integer", minimum: 1 },
    },
    ["runId", "releaseId", "ventureIds", "batchSize"],
  ),
  parse(value) {
    const input = exactObject(value, "FleetOperationInput", [
      "runId",
      "releaseId",
      "ventureIds",
      "batchSize",
    ]);
    if (!Number.isSafeInteger(input.batchSize) || Number(input.batchSize) < 1) {
      throw new Error("batchSize must be a positive safe integer");
    }
    return {
      runId: safeId(input, "runId"),
      releaseId: safeId(input, "releaseId"),
      ventureIds: safeStringArray(input.ventureIds, "ventureIds", SAFE_ID),
      batchSize: Number(input.batchSize),
    };
  },
});

function outputSchema(commandId: string): RuntimeSchema<PlatformCommandOutput> {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject(
      {
        commandId: { const: commandId },
        mode: { type: "string", enum: ["read_only", "local_write", "external_write"] },
        status: { type: "string", minLength: 1, maxLength: 255 },
        data: { type: "object" },
      },
      ["commandId", "mode", "status", "data"],
    ),
    parse(value) {
      const output = exactObject(value, `${commandId}Output`, [
        "commandId",
        "mode",
        "status",
        "data",
      ]);
      if (output.commandId !== commandId) throw new Error(`invalid ${commandId} output`);
      const mode = stringValue(output, "mode", {
        allowed: ["read_only", "local_write", "external_write"],
      }) as PlatformCommandMode;
      const data = objectValue(output.data, "data") as JsonObject;
      assertJsonSafe(data, `${commandId}.data`);
      return { commandId, mode, status: safeId(output, "status"), data };
    },
  });
}

function platformCommand<Input extends JsonObject>(definition: {
  id: string;
  title: string;
  description: string;
  input: RuntimeSchema<Input>;
  effect: "read" | "write";
  scopes: readonly string[];
  meter?: string;
}): CommandContract<Input, PlatformCommandOutput> {
  return defineCommandContract({
    ...definition,
    version: 1,
    output: outputSchema(definition.id),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant: true,
      scopes: definition.scopes,
    },
  });
}

export const authLoginCommand = platformCommand({
  id: "auth.login",
  title: "Authenticate Provider",
  description:
    "Use an explicitly injected official login adapter and persist metadata-only credential references.",
  input: authLoginInput,
  effect: "write",
  scopes: ["auth.manage"],
  meter: "auth_mutations",
});
export const authStatusCommand = platformCommand({
  id: "auth.status",
  title: "Inspect Authentication",
  description: "Inspect credential-reference state without exposing credential values.",
  input: authInspectInput,
  effect: "read",
  scopes: ["auth.read"],
});
export const authTestCommand = platformCommand({
  id: "auth.test",
  title: "Test Authentication",
  description: "Run an injected official read check and persist sanitized test evidence.",
  input: authInspectInput,
  effect: "write",
  scopes: ["auth.test"],
  meter: "auth_tests",
});
export const authRevokeCommand = platformCommand({
  id: "auth.revoke",
  title: "Revoke Authentication",
  description: "Disable a credential reference locally and invoke only an injected revoke adapter.",
  input: authInspectInput,
  effect: "write",
  scopes: ["auth.manage"],
  meter: "auth_mutations",
});

export const upgradePlanCommand = platformCommand({
  id: "upgrade.plan",
  title: "Plan Harness Upgrade",
  description: "Plan a trusted local release without changing the project.",
  input: upgradeReleaseInput,
  effect: "read",
  scopes: ["upgrade.read"],
});
export const upgradeDryRunCommand = platformCommand({
  id: "upgrade.dry-run",
  title: "Dry Run Harness Upgrade",
  description: "Validate a trusted local release and report its reversible local changes.",
  input: upgradeReleaseInput,
  effect: "read",
  scopes: ["upgrade.read"],
});
export const upgradeApplyCommand = platformCommand({
  id: "upgrade.apply",
  title: "Apply Harness Upgrade",
  description: "Apply one trusted local release through the host upgrade transaction and checks.",
  input: upgradeReleaseInput,
  effect: "write",
  scopes: ["upgrade.apply"],
  meter: "upgrade_applies",
});
export const upgradeStatusCommand = platformCommand({
  id: "upgrade.status",
  title: "Inspect Harness Version",
  description: "Inspect the current local harness lock without locating or applying a release.",
  input: emptyPlatformInput,
  effect: "read",
  scopes: ["upgrade.read"],
});

export const fleetStatusCommand = platformCommand({
  id: "fleet.status",
  title: "Inspect Fleet Run",
  description: "Read a durable Fleet run or the sanitized configured target catalog.",
  input: fleetStatusInput,
  effect: "read",
  scopes: ["fleet.read"],
});
export const fleetPlanCommand = platformCommand({
  id: "fleet.plan",
  title: "Plan Fleet Rollout",
  description: "Resolve an exact tenant-bound release and Fleet selection without running hooks.",
  input: fleetOperationInput,
  effect: "read",
  scopes: ["fleet.read"],
});
export const fleetRolloutCommand = platformCommand({
  id: "fleet.rollout",
  title: "Roll Out Fleet Release",
  description: "Run the durable canary and batch Fleet controller through injected venture hooks.",
  input: fleetOperationInput,
  effect: "write",
  scopes: ["fleet.rollout"],
  meter: "fleet_rollouts",
});
export const fleetResumeCommand = platformCommand({
  id: "fleet.resume",
  title: "Resume Fleet Rollout",
  description: "Resume one durable Fleet run without repeating completed phase effects.",
  input: fleetOperationInput,
  effect: "write",
  scopes: ["fleet.rollout"],
  meter: "fleet_rollouts",
});

export const authCommandContracts = [
  authLoginCommand,
  authStatusCommand,
  authTestCommand,
  authRevokeCommand,
] as const;
export const upgradeCommandContracts = [
  upgradePlanCommand,
  upgradeDryRunCommand,
  upgradeApplyCommand,
  upgradeStatusCommand,
] as const;
export const fleetCommandContracts = [
  fleetStatusCommand,
  fleetPlanCommand,
  fleetRolloutCommand,
  fleetResumeCommand,
] as const;
export const platformOperationCommandContracts = [
  ...authCommandContracts,
  ...upgradeCommandContracts,
  ...fleetCommandContracts,
] as const;

function unconfigured(domain: string, action: string): PlatformOperationBoundary {
  return {
    status: "unconfigured",
    effect: "none",
    data: {
      diagnostic: {
        code: `${domain}_runtime_unconfigured`,
        message: `No trusted ${domain} runtime is configured for ${action}`,
        nextAction: `Load an explicit project-owned production runtime module with a ${domain} binding`,
      },
    },
  };
}

export const unconfiguredAuthCommandRuntime: AuthCommandRuntime = Object.freeze({
  execute: (action: AuthCommandAction) => unconfigured("auth", action),
});
export const unconfiguredUpgradeCommandRuntime: UpgradeCommandRuntime = Object.freeze({
  execute: (action: UpgradeCommandAction) => unconfigured("upgrade", action),
});
export const unconfiguredFleetCommandRuntime: FleetCommandRuntime = Object.freeze({
  execute: (action: FleetCommandAction) => unconfigured("fleet", action),
});

const FAILURE_STATUSES = new Set(["unconfigured", "context_unavailable", "blocked", "failed"]);

function failureMessage(boundary: PlatformOperationBoundary, fallback: string): string {
  const diagnostic = boundary.data.diagnostic;
  if (diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
    const record = diagnostic as JsonObject;
    const code = typeof record.code === "string" ? record.code : "platform_command_failed";
    const message = typeof record.message === "string" ? record.message : fallback;
    return `${code}: ${message}`;
  }
  return fallback;
}

function register<Input extends JsonObject, Action extends string>(options: {
  bus: CommandBus;
  contract: CommandContract<Input, PlatformCommandOutput>;
  action: Action;
  mode: PlatformCommandMode;
  invoke: (
    action: Action,
    input: Input,
    context: CommandHandlerContext,
  ) => Promise<PlatformOperationBoundary> | PlatformOperationBoundary;
}): void {
  options.bus.register(options.contract, async (input, context) => {
    const boundary = await options.invoke(options.action, input, context);
    assertJsonSafe(boundary.data, `${options.contract.id}.boundary`);
    if (FAILURE_STATUSES.has(boundary.status)) {
      const message = failureMessage(
        boundary,
        `${options.contract.id} did not complete successfully`,
      );
      if (boundary.effect === "none") {
        throw new CommandDefinitiveNoEffectError(message, "handler_failed");
      }
      throw new Error(message);
    }
    return {
      commandId: options.contract.id,
      mode: options.mode,
      status: boundary.status,
      data: boundary.data,
    };
  });
}

export function registerPlatformOperationCommands(
  bus: CommandBus,
  runtimes: {
    auth?: AuthCommandRuntime;
    upgrade?: UpgradeCommandRuntime;
    fleet?: FleetCommandRuntime;
  } = {},
): void {
  const auth = runtimes.auth ?? unconfiguredAuthCommandRuntime;
  const upgrade = runtimes.upgrade ?? unconfiguredUpgradeCommandRuntime;
  const fleet = runtimes.fleet ?? unconfiguredFleetCommandRuntime;
  register({
    bus,
    contract: authLoginCommand,
    action: "login",
    mode: "external_write",
    invoke: auth.execute.bind(auth),
  });
  register({
    bus,
    contract: authStatusCommand,
    action: "status",
    mode: "read_only",
    invoke: auth.execute.bind(auth),
  });
  register({
    bus,
    contract: authTestCommand,
    action: "test",
    mode: "local_write",
    invoke: auth.execute.bind(auth),
  });
  register({
    bus,
    contract: authRevokeCommand,
    action: "revoke",
    mode: "external_write",
    invoke: auth.execute.bind(auth),
  });
  register({
    bus,
    contract: upgradePlanCommand,
    action: "plan",
    mode: "read_only",
    invoke: upgrade.execute.bind(upgrade),
  });
  register({
    bus,
    contract: upgradeDryRunCommand,
    action: "dry_run",
    mode: "read_only",
    invoke: upgrade.execute.bind(upgrade),
  });
  register({
    bus,
    contract: upgradeApplyCommand,
    action: "apply",
    mode: "local_write",
    invoke: upgrade.execute.bind(upgrade),
  });
  register({
    bus,
    contract: upgradeStatusCommand,
    action: "status",
    mode: "read_only",
    invoke: upgrade.execute.bind(upgrade),
  });
  register({
    bus,
    contract: fleetStatusCommand,
    action: "status",
    mode: "read_only",
    invoke: fleet.execute.bind(fleet),
  });
  register({
    bus,
    contract: fleetPlanCommand,
    action: "plan",
    mode: "read_only",
    invoke: fleet.execute.bind(fleet),
  });
  register({
    bus,
    contract: fleetRolloutCommand,
    action: "rollout",
    mode: "external_write",
    invoke: fleet.execute.bind(fleet),
  });
  register({
    bus,
    contract: fleetResumeCommand,
    action: "resume",
    mode: "external_write",
    invoke: fleet.execute.bind(fleet),
  });
}

export function platformOperationInputFor(commandId: string): RuntimeSchema<JsonObject> | null {
  const contract = platformOperationCommandContracts.find(({ id }) => id === commandId);
  return (contract?.input as RuntimeSchema<JsonObject> | undefined) ?? null;
}

export type PlatformOperationJsonValue = JsonValue;
