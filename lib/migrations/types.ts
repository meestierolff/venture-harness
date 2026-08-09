import { z } from "zod";
import { semverSchema } from "../config/contracts";

export const migrationManifestSchema = z
  .object({
    id: z.string().regex(/^\d{3}-[a-z0-9-]+$/),
    from_version: semverSchema,
    to_version: semverSchema,
    reversible: z.literal(true),
    lock_update_last: z.literal(true),
    writes: z.array(z.string().min(1)).min(1),
  })
  .strict();

export interface MigrationFileSystem {
  readText(path: string): Promise<string | null>;
  writeAtomic(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface MigrationChange {
  path: string;
  content: string;
}

export interface MigrationPlan {
  id: string;
  fromVersion: string;
  toVersion: string;
  warnings: string[];
  changes: MigrationChange[];
}

export const migrationChangeReportSchema = z
  .object({
    path: z.string(),
    operation: z.enum(["create", "update", "unchanged"]),
    status: z.enum(["planned", "applied", "unchanged", "rolled_back", "rollback_failed"]),
  })
  .strict();

export const migrationReportSchema = z
  .object({
    migration_id: z.string(),
    from_version: semverSchema,
    to_version: semverSchema,
    status: z.enum(["planned", "applied", "already_current", "failed"]),
    dry_run: z.boolean(),
    started_at: z.string().datetime({ offset: true }),
    completed_at: z.string().datetime({ offset: true }),
    changes: z.array(migrationChangeReportSchema),
    warnings: z.array(z.string()),
    lock_updated: z.boolean(),
    rolled_back: z.boolean(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        next_action: z.string(),
      })
      .strict()
      .nullable(),
    rollback_errors: z.array(z.string()),
  })
  .strict();

export type MigrationReport = z.infer<typeof migrationReportSchema>;

export interface MigrationOptions {
  fileSystem: MigrationFileSystem;
  dryRun?: boolean;
  clock?: () => Date;
}

export interface MigrationPlanningOptions {
  fileSystem: MigrationFileSystem;
  clock: () => Date;
}

export interface RegisteredMigration {
  id: string;
  fromVersion: string;
  toVersion: string;
  plan(options: MigrationPlanningOptions): Promise<MigrationPlan>;
}

export interface MigrationChainPlan {
  fromVersion: string;
  toVersion: string;
  migrations: RegisteredMigration[];
  plans: MigrationPlan[];
  /** Read-only planning view after every migration plan has been applied. */
  stagedFileSystem: MigrationFileSystem;
}
