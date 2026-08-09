import type { JsonObject, JsonValue } from "@venture-harness/core";

export interface RuntimeSchema<T> {
  readonly name: string;
  readonly jsonSchema: JsonObject;
  parse(value: unknown): T;
}

export function defineRuntimeSchema<T>(schema: RuntimeSchema<T>): RuntimeSchema<T> {
  return Object.freeze(schema);
}

export function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringValue(
  record: Record<string, unknown>,
  field: string,
  options: { optional?: boolean; allowed?: readonly string[] } = {},
): string | undefined {
  const value = record[field];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a string`);
  if (options.allowed && !options.allowed.includes(value)) {
    throw new Error(`${field} must be one of ${options.allowed.join(", ")}`);
  }
  return value;
}

export function schemaObject(
  properties: Record<string, JsonObject>,
  required: string[],
): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: properties as unknown as JsonValue,
    required,
  };
}

export * from "./growth-contract.js";
