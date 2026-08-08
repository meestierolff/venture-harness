import type {
  JsonPrimitive,
  JsonValue,
  ProviderEnvironment,
  ProviderId,
  ProviderOperation,
  ProviderPlan,
  ProviderPlanRequest,
} from "./types";
import { ProviderPlanError } from "./types";

export function stableHash(value: unknown): string {
  const normalized = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return item;
  });
  let hash = 2_166_136_261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function inputString(request: ProviderPlanRequest, key: string): string {
  const value = request.inputs[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProviderPlanError(`Missing string input: ${key}`, "missing_input");
  }
  return value;
}

export function credentialInput(request: ProviderPlanRequest, key?: string): string {
  const value = key ? inputString(request, key) : request.credentialRef;
  if (typeof value !== "string" || !value.startsWith("cred://")) {
    throw new ProviderPlanError(
      `Missing credential reference${key ? `: ${key}` : ""}`,
      "missing_input",
    );
  }
  return value;
}

export function optionalString(request: ProviderPlanRequest, key: string): string | undefined {
  const value = request.inputs[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProviderPlanError(`Invalid string input: ${key}`, "invalid_input");
  }
  return value;
}

export function inputNumber(request: ProviderPlanRequest, key: string): number {
  const value = request.inputs[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderPlanError(`Missing number input: ${key}`, "missing_input");
  }
  return value;
}

export function optionalNumber(request: ProviderPlanRequest, key: string): number | undefined {
  const value = request.inputs[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderPlanError(`Invalid number input: ${key}`, "invalid_input");
  }
  return value;
}

export function inputBoolean(
  request: ProviderPlanRequest,
  key: string,
  fallback: boolean,
): boolean {
  const value = request.inputs[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ProviderPlanError(`Invalid boolean input: ${key}`, "invalid_input");
  }
  return value;
}

export function inputStrings(request: ProviderPlanRequest, key: string): string[] {
  const value = request.inputs[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProviderPlanError(`Missing string array input: ${key}`, "missing_input");
  }
  return [...value];
}

export function optionalJson(request: ProviderPlanRequest, key: string): JsonValue | undefined {
  return request.inputs[key];
}

export function hasCapability(request: ProviderPlanRequest, capability: string): boolean {
  return request.capabilities.includes(capability);
}

export function operationId(provider: ProviderId, action: string, identity: unknown): string {
  return `${provider}.${action}.${stableHash(identity)}`;
}

export function idempotencyKey(
  provider: ProviderId,
  environment: ProviderEnvironment,
  action: string,
  payload: unknown,
): string {
  return `${provider}:${environment}:${action}:${stableHash(payload)}`;
}

export function createPlan(
  provider: ProviderId,
  request: ProviderPlanRequest,
  operations: readonly ProviderOperation[],
  limitations: readonly string[] = [],
): ProviderPlan {
  const identity = {
    provider,
    environment: request.environment,
    capabilities: [...request.capabilities].sort(),
    inputs: request.inputs,
  };
  return {
    id: `plan.${provider}.${stableHash(identity)}`,
    provider,
    environment: request.environment,
    dryRun: request.dryRun ?? true,
    createdAt: new Date().toISOString(),
    operations,
    limitations,
  };
}

export function manualFields(
  fields: Readonly<Record<string, JsonPrimitive | undefined>>,
): Readonly<Record<string, JsonPrimitive>> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, JsonPrimitive] => entry[1] !== undefined,
    ),
  );
}
