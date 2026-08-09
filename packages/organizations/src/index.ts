import type { ActorIdentity, TenantRef } from "@venture-harness/core";

export interface OrganizationMembership {
  organizationId: string;
  actorId: string;
  role: "owner" | "operator" | "member" | "agent";
  active: boolean;
}

export function assertOrganizationMembership(
  identity: ActorIdentity,
  tenant: TenantRef,
  memberships: readonly OrganizationMembership[],
): OrganizationMembership {
  const membership = memberships.find(
    (candidate) =>
      candidate.active &&
      candidate.actorId === identity.actorId &&
      candidate.organizationId === tenant.organizationId,
  );
  if (!membership) throw new Error("identity is not an active member of the tenant organization");
  return membership;
}
