import { createHash } from "node:crypto";
import { assertCredentialFree } from "@venture-harness/core";
import type { ProviderConnectionRecord, TenantScope } from "./types";
import { ProviderOperationError, VentureRuntimeError } from "./types";

interface ScopedSecret {
  operatorId: string;
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

  function assertScope(scope: TenantScope): void {
    for (const [label, value] of [
      ["operatorId", scope.operatorId],
      ["ventureId", scope.ventureId],
      ["customerOrganizationId", scope.customerOrganizationId],
    ] as const) {
      if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
        throw new VentureRuntimeError("credential_scope_mismatch", `${label} is required`);
      }
    }
  }

  function key(scope: TenantScope, connectionId: string): string {
    assertScope(scope);
    return createHash("sha256")
      .update(
        `${scope.operatorId}\u0000${scope.ventureId}\u0000${scope.customerOrganizationId}\u0000${connectionId}`,
      )
      .digest("hex");
  }

  function register(
    scope: TenantScope,
    connection: ProviderConnectionRecord,
    secret: string,
  ): void {
    if (!secret) throw new Error("credential secret must not be empty");
    if (
      connection.operatorId !== scope.operatorId ||
      connection.ventureId !== scope.ventureId ||
      connection.customerOrganizationId !== scope.customerOrganizationId
    ) {
      throw new VentureRuntimeError("credential_scope_mismatch", "credential scope mismatch");
    }
    secrets.set(key(scope, connection.connectionId), {
      operatorId: scope.operatorId,
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
    assertScope(scope);
    return [...secrets.values()]
      .filter(
        (entry) =>
          entry.operatorId === scope.operatorId &&
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
      assertSafeOutput(result);
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
    if (!secret) throw new Error("credential secret must not be empty");
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

  function revokeScope(scope: TenantScope): void {
    assertScope(scope);
    for (const entry of secrets.values()) {
      if (
        entry.operatorId === scope.operatorId &&
        entry.ventureId === scope.ventureId &&
        entry.customerOrganizationId === scope.customerOrganizationId
      ) {
        entry.revoked = true;
      }
    }
  }

  function redact(value: string): string {
    let output = value;
    for (const canary of canaries) output = output.replaceAll(canary, "[REDACTED]");
    return output;
  }

  /**
   * Scan provider-controlled values before they can enter durable state or an
   * Agent Surface. Registered canaries catch the credential currently in use;
   * structural names and well-known formats catch secondary credentials that
   * were never registered with this broker.
   */
  function assertSafeOutput(value: unknown): void {
    try {
      assertCredentialFree(value, "provider output", [...canaries]);
    } catch {
      throw new VentureRuntimeError(
        "credential_leak_detected",
        "provider output contained credential-like material",
      );
    }
  }

  return {
    register,
    list,
    withSecret,
    rotate,
    inspect,
    revoke,
    revokeScope,
    redact,
    assertSafeOutput,
  };
}

export type TenantCredentialBroker = ReturnType<typeof createTenantCredentialBroker>;
