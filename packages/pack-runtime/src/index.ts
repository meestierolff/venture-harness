import type { AnyCommandContract } from "@venture-harness/command-bus";
import type { JsonObject } from "@venture-harness/core";

export interface PackManifest {
  id: string;
  version: string;
  commands: readonly AnyCommandContract[];
  migrations: readonly string[];
  contributions: JsonObject;
}

export function definePack(manifest: PackManifest): PackManifest {
  if (!/^[a-z][a-z0-9-]+$/.test(manifest.id)) throw new Error(`invalid pack id: ${manifest.id}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
    throw new Error(`invalid pack version: ${manifest.version}`);
  const commandIds = manifest.commands.map(({ id }) => id);
  if (new Set(commandIds).size !== commandIds.length)
    throw new Error("pack commands must be unique");
  return Object.freeze({ ...manifest });
}

export class InMemoryPackRegistry {
  readonly #installed = new Map<string, PackManifest>();
  install(manifest: PackManifest): "installed" | "already_installed" {
    const pack = definePack(manifest);
    const current = this.#installed.get(pack.id);
    if (current?.version === pack.version) return "already_installed";
    this.#installed.set(pack.id, pack);
    return "installed";
  }
  uninstall(id: string): boolean {
    return this.#installed.delete(id);
  }
  list(): PackManifest[] {
    return [...this.#installed.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}
