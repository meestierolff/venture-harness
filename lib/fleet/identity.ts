import { tenantKey, type TenantRef } from "@venture-harness/core";

export interface FleetTargetIdentity extends TenantRef {
  organizationId: string;
  ventureId: string;
}

export function fleetTargetIdentity(target: FleetTargetIdentity): FleetTargetIdentity {
  tenantKey(target);
  return {
    organizationId: target.organizationId,
    ventureId: target.ventureId,
  };
}

export function fleetTargetKey(target: FleetTargetIdentity): string {
  return tenantKey(target);
}
