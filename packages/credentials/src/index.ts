import type { TenantRef } from "@venture-harness/core";
import { tenantKey } from "@venture-harness/core";

export interface ScopedCredentialReference {
  ref: `cred://${string}`;
  tenant: TenantRef;
  provider: string;
  scopes: readonly string[];
  expiresAt?: string;
  revokedAt?: string;
}

export function assertCredentialAccess(
  reference: ScopedCredentialReference,
  tenant: TenantRef,
  requiredScopes: readonly string[],
  now = new Date(),
): ScopedCredentialReference {
  if (tenantKey(reference.tenant) !== tenantKey(tenant))
    throw new Error("credential tenant mismatch");
  if (reference.revokedAt) throw new Error("credential is revoked");
  if (reference.expiresAt && Date.parse(reference.expiresAt) <= now.getTime())
    throw new Error("credential is expired");
  const missing = requiredScopes.filter((scope) => !reference.scopes.includes(scope));
  if (missing.length) throw new Error(`credential scopes missing: ${missing.join(", ")}`);
  return reference;
}
