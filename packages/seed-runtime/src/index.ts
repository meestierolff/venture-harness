import type { AssetRecord } from "@venture-harness/assets";
import type { TenantRef } from "@venture-harness/core";

export type SeedRail = "web" | "ios" | "hybrid";
export type SeedFileOwnership = "core-owned" | "merge-managed" | "venture-owned";

export interface SeedFile {
  path: string;
  content: string;
  ownership: SeedFileOwnership;
}

export interface VentureSeed {
  id: string;
  version: string;
  rail: SeedRail;
  files: readonly SeedFile[];
}

export interface AssetVaultWriter {
  put(tenant: TenantRef, assetId: string, mediaType: string, bytes: Uint8Array): AssetRecord;
}

export function planSeedMaterialization(seed: VentureSeed): SeedFile[] {
  if (!/^\d+\.\d+\.\d+$/.test(seed.version)) throw new Error("seed version must be semver");
  const seen = new Set<string>();
  return seed.files.map((file) => {
    if (file.path.startsWith("/") || file.path.split("/").includes(".."))
      throw new Error(`unsafe seed path: ${file.path}`);
    if (seen.has(file.path)) throw new Error(`duplicate seed path: ${file.path}`);
    seen.add(file.path);
    return { ...file };
  });
}

export function recordSeedManifest(vault: AssetVaultWriter, tenant: TenantRef, seed: VentureSeed) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ id: seed.id, version: seed.version, rail: seed.rail }),
  );
  return vault.put(tenant, `seed-${seed.id}-${seed.version}`, "application/json", bytes);
}
