import { createHash } from "node:crypto";
import type { TenantRef } from "@venture-harness/core";
import { tenantKey } from "@venture-harness/core";

export interface AssetRecord {
  assetId: string;
  tenant: TenantRef;
  mediaType: string;
  sha256: string;
  bytes: Uint8Array;
}

export class InMemoryAssetVault {
  readonly #assets = new Map<string, AssetRecord>();

  put(tenant: TenantRef, assetId: string, mediaType: string, bytes: Uint8Array): AssetRecord {
    const record = {
      assetId,
      tenant: structuredClone(tenant),
      mediaType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: Uint8Array.from(bytes),
    };
    this.#assets.set(`${tenantKey(tenant)}:${assetId}`, record);
    return structuredClone(record);
  }

  get(tenant: TenantRef, assetId: string): AssetRecord | null {
    const record = this.#assets.get(`${tenantKey(tenant)}:${assetId}`);
    return record ? structuredClone(record) : null;
  }
}
