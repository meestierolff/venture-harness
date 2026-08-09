import type { JsonObject, JsonValue, TenantRef } from "@venture-harness/core";
import type { ScopedCredentialReference } from "@venture-harness/credentials";

export interface CapabilityDescriptor {
  id: string;
  schemaVersion: number;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  environments: readonly string[];
  requiredScopes: readonly string[];
  rateClass: string;
  concurrencyGroup: string;
  timeoutMs: number;
  redactionPaths: readonly string[];
  unknownOutcome: "read_back_then_retry" | "manual_reconcile";
}

export interface CapabilityRequest {
  capability: string;
  tenant: TenantRef;
  environment: string;
  input: JsonObject;
  idempotencyKey: string;
  credential?: ScopedCredentialReference;
}

export interface CapabilityResult {
  state: "planned" | "applied" | "verified" | "unknown" | "failed" | "compensated";
  output?: JsonValue;
  evidence?: JsonObject;
  retryable: boolean;
}

export interface ProviderCapabilityAdapter {
  providerId: string;
  capabilities: readonly CapabilityDescriptor[];
  discover(request: CapabilityRequest): Promise<JsonObject>;
  estimate(
    request: CapabilityRequest,
  ): Promise<{ amount: number; currency: string; known: boolean }>;
  plan(request: CapabilityRequest): Promise<JsonObject>;
  apply(request: CapabilityRequest, plan: JsonObject): Promise<CapabilityResult>;
  readBack(request: CapabilityRequest, result: CapabilityResult): Promise<CapabilityResult>;
  reconcile(request: CapabilityRequest): Promise<CapabilityResult>;
  compensate(request: CapabilityRequest, result: CapabilityResult): Promise<CapabilityResult>;
}

export function defineCapability(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(descriptor.id))
    throw new Error(`invalid capability id: ${descriptor.id}`);
  if (descriptor.schemaVersion < 1 || descriptor.timeoutMs < 1)
    throw new Error("capability version and timeout must be positive");
  return Object.freeze({ ...descriptor });
}
