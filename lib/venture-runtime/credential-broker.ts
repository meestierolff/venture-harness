import { createHash } from "node:crypto";
import type { ProviderConnectionRecord, TenantScope } from "./types";
import { ProviderOperationError, VentureRuntimeError } from "./types";

interface ScopedSecret {
  ventureId: string;
  customerOrganizationId: string;
  connectionId: string;
  credentialRef: string;
  secret: string;
  revoked: boolean;
}

export function createTenantCredentialBroker() {
  const secrets = new Map<string, ScopedSecret>();
  const canaries = new Set<string>();

  function key(scope: TenantScope, connectionId: string): string {
    return createHash("sha256")
      .update(`${scope.ventureId}\u0000${scope.customerOrganizationId}\u0000${connectionId}`)
      .digest("hex");
  }

  function register(
    scope: TenantScope,
    connection: ProviderConnectionRecord,
    secret: string,
  ): void {
    if (
      connection.ventureId !== scope.ventureId ||
      connection.customerOrganizationId !== scope.customerOrganizationId
    ) {
      throw new VentureRuntimeError("credential_scope_mismatch", "credential scope mismatch");
    }
    secrets.set(key(scope, connection.connectionId), {
      ventureId: scope.ventureId,
      customerOrganizationId: scope.customerOrganizationId,
      connectionId: connection.connectionId,
      credentialRef: connection.credentialRef,
      secret,
      revoked: false,
    });
    canaries.add(secret);
  }

  function list(scope: TenantScope): readonly string[] {
    return [...secrets.values()]
      .filter(
        (entry) =>
          entry.ventureId === scope.ventureId &&
          entry.customerOrganizationId === scope.customerOrganizationId &&
          !entry.revoked,
      )
      .map((entry) => entry.credentialRef);
  }

  async function withSecret<T>(
    scope: TenantScope,
    connectionId: string,
    operation: (secret: string) => Promise<T>,
  ): Promise<T> {
    const entry = secrets.get(key(scope, connectionId));
    if (!entry || entry.revoked) {
      throw new VentureRuntimeError("credential_scope_mismatch", "credential unavailable");
    }
    try {
      const result = await operation(entry.secret);
      const observable = typeof result === "string" ? result : JSON.stringify(result);
      if (observable && redact(observable) !== observable) {
        throw new VentureRuntimeError(
          "credential_leak_detected",
          "provider adapter attempted to expose a downstream credential",
        );
      }
      return result;
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      if (error instanceof ProviderOperationError) {
        throw new ProviderOperationError(error.outcome, message);
      }
      if (error instanceof VentureRuntimeError) throw error;
      throw new Error(message);
    }
  }

  function rotate(scope: TenantScope, connectionId: string, secret: string): void {
    const entry = secrets.get(key(scope, connectionId));
    if (!entry || entry.revoked) {
      throw new VentureRuntimeError("credential_scope_mismatch", "credential unavailable");
    }
    canaries.add(entry.secret);
    canaries.add(secret);
    entry.secret = secret;
  }

  function inspect(
    scope: TenantScope,
    connectionId: string,
  ): Readonly<{ credentialRef: string; revoked: boolean }> {
    const entry = secrets.get(key(scope, connectionId));
    if (!entry) {
      throw new VentureRuntimeError("credential_scope_mismatch", "credential unavailable");
    }
    return Object.freeze({ credentialRef: entry.credentialRef, revoked: entry.revoked });
  }

  function revoke(scope: TenantScope, connectionId: string): void {
    const entry = secrets.get(key(scope, connectionId));
    if (!entry) {
      throw new VentureRuntimeError("credential_scope_mismatch", "credential unavailable");
    }
    entry.revoked = true;
  }

  function redact(value: string): string {
    let output = value;
    for (const canary of canaries) output = output.replaceAll(canary, "[REDACTED]");
    return output;
  }

  return { register, list, withSecret, rotate, inspect, revoke, redact };
}

export type TenantCredentialBroker = ReturnType<typeof createTenantCredentialBroker>;
