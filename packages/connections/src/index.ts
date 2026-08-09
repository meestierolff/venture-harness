import type { GrantSnapshot } from "@venture-harness/core";

export function selectCommandGrant(
  grants: readonly GrantSnapshot[],
  commandId: string,
  requiredScopes: readonly string[],
  now = new Date(),
): GrantSnapshot {
  const grant = grants.find(
    (candidate) =>
      !candidate.revokedAt &&
      Date.parse(candidate.expiresAt) > now.getTime() &&
      (candidate.commandIds.includes(commandId) || candidate.commandIds.includes("*")) &&
      requiredScopes.every((scope) => candidate.scopes.includes(scope)),
  );
  if (!grant) throw new Error(`no active grant authorizes ${commandId}`);
  return grant;
}

export interface ProviderConnectionRef {
  connectionId: string;
  organizationId: string;
  ventureId: string;
  provider: string;
  credentialRef: `cred://${string}`;
  status: "active" | "revoked" | "expired";
}

export function activeConnection(connection: ProviderConnectionRef): ProviderConnectionRef {
  if (connection.status !== "active")
    throw new Error(`provider connection is ${connection.status}`);
  return connection;
}
