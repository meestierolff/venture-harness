import type {
  MigrationChainPlan,
  MigrationFileSystem,
  MigrationPlan,
  RegisteredMigration,
} from "./types";
import {
  planV01ToV02Migration,
  V01_TO_V02_MIGRATION_ID,
  V01_VERSION,
  V02_VERSION,
} from "./v0-1-to-v0-2";

class PlanningFileSystem implements MigrationFileSystem {
  private readonly staged = new Map<string, string | null>();

  constructor(private readonly base: MigrationFileSystem) {}

  async readText(path: string): Promise<string | null> {
    if (this.staged.has(path)) return this.staged.get(path) ?? null;
    return this.base.readText(path);
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    this.staged.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.staged.set(path, null);
  }
}

function assertDefinition(definition: RegisteredMigration): void {
  if (definition.fromVersion === definition.toVersion) {
    throw new Error(`migration ${definition.id} cannot target its source version`);
  }
}

function assertPlannedChanges(definition: RegisteredMigration, plan: MigrationPlan): void {
  const paths = plan.changes.map((change) => change.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error(`migration ${definition.id} returned duplicate paths`);
  }
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`migration ${definition.id} returned an escaping path: ${path}`);
    }
  }
  if (paths.filter((path) => path === "harness.lock").length !== 1) {
    throw new Error(`migration ${definition.id} must return exactly one harness.lock change`);
  }
}

export class MigrationRegistry {
  private readonly definitions: RegisteredMigration[];

  constructor(definitions: readonly RegisteredMigration[]) {
    this.definitions = [...definitions];
    const identities = new Set<string>();
    for (const definition of this.definitions) {
      assertDefinition(definition);
      if (identities.has(definition.id)) {
        throw new Error(`duplicate migration id: ${definition.id}`);
      }
      identities.add(definition.id);
    }
  }

  resolveChain(fromVersion: string, toVersion: string): RegisteredMigration[] {
    if (fromVersion === toVersion) return [];
    const queue: Array<{ version: string; chain: RegisteredMigration[] }> = [
      { version: fromVersion, chain: [] },
    ];
    const shortestDepth = new Map<string, number>([[fromVersion, 0]]);
    const matches: RegisteredMigration[][] = [];
    let matchDepth: number | null = null;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (matchDepth !== null && current.chain.length >= matchDepth) continue;
      const outgoing = this.definitions
        .filter((definition) => definition.fromVersion === current.version)
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const definition of outgoing) {
        const chain = [...current.chain, definition];
        if (definition.toVersion === toVersion) {
          matchDepth = chain.length;
          matches.push(chain);
          continue;
        }
        const previousDepth = shortestDepth.get(definition.toVersion);
        if (previousDepth !== undefined && previousDepth < chain.length) continue;
        shortestDepth.set(definition.toVersion, chain.length);
        queue.push({ version: definition.toVersion, chain });
      }
    }

    const shortest = matches.filter((chain) => chain.length === matchDepth);
    if (shortest.length === 0) {
      throw new Error(`no registered migration chain from ${fromVersion} to ${toVersion}`);
    }
    if (shortest.length > 1) {
      throw new Error(
        `ambiguous migration chain from ${fromVersion} to ${toVersion}: ${shortest
          .map((chain) => chain.map((migration) => migration.id).join(" -> "))
          .join(" | ")}`,
      );
    }
    return shortest[0];
  }

  async planChain(options: {
    fromVersion: string;
    toVersion: string;
    fileSystem: MigrationFileSystem;
    clock?: () => Date;
  }): Promise<MigrationChainPlan> {
    const migrations = this.resolveChain(options.fromVersion, options.toVersion);
    const stagedFileSystem = new PlanningFileSystem(options.fileSystem);
    const clock = options.clock ?? (() => new Date());
    const plans: MigrationPlan[] = [];

    for (const migration of migrations) {
      const plan = await migration.plan({ fileSystem: stagedFileSystem, clock });
      if (
        plan.id !== migration.id ||
        plan.fromVersion !== migration.fromVersion ||
        plan.toVersion !== migration.toVersion
      ) {
        throw new Error(`migration ${migration.id} returned mismatched plan metadata`);
      }
      assertPlannedChanges(migration, plan);
      plans.push(plan);
      for (const change of plan.changes) {
        await stagedFileSystem.writeAtomic(change.path, change.content);
      }
    }

    return {
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      migrations,
      plans,
      stagedFileSystem,
    };
  }
}

export const V01_TO_V02_MIGRATION: RegisteredMigration = {
  id: V01_TO_V02_MIGRATION_ID,
  fromVersion: V01_VERSION,
  toVersion: V02_VERSION,
  plan: planV01ToV02Migration,
};

export const defaultMigrationRegistry = new MigrationRegistry([V01_TO_V02_MIGRATION]);
