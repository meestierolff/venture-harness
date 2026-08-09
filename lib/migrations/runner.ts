import { migrationReportSchema } from "./types";
import type { MigrationChange, MigrationOptions, MigrationPlan, MigrationReport } from "./types";

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown migration failure";
  return error.message.replace(
    /(gh[pousr]_|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]+/g,
    "$1[REDACTED]",
  );
}

function validatePlan(plan: MigrationPlan): MigrationChange[] {
  const paths = plan.changes.map((change) => change.path);
  if (new Set(paths).size !== paths.length)
    throw new Error("migration plan contains duplicate paths");
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`migration path must be repository-relative: ${path}`);
    }
  }
  const lockChanges = plan.changes.filter((change) => change.path === "harness.lock");
  if (lockChanges.length !== 1) {
    throw new Error("migration plan must contain exactly one harness.lock change");
  }
  return [...plan.changes].sort((a, b) => {
    if (a.path === "harness.lock") return 1;
    if (b.path === "harness.lock") return -1;
    return a.path.localeCompare(b.path);
  });
}

export async function applyMigrationPlan(
  plan: MigrationPlan,
  options: MigrationOptions,
): Promise<MigrationReport> {
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  let ordered: MigrationChange[];
  try {
    ordered = validatePlan(plan);
  } catch (error) {
    return migrationReportSchema.parse({
      migration_id: plan.id,
      from_version: plan.fromVersion,
      to_version: plan.toVersion,
      status: "failed",
      dry_run: options.dryRun ?? false,
      started_at: startedAt,
      completed_at: clock().toISOString(),
      changes: [],
      warnings: plan.warnings,
      lock_updated: false,
      rolled_back: false,
      error: {
        code: "invalid_migration_plan",
        message: safeErrorMessage(error),
        next_action: "Fix the migration plan; no files were changed.",
      },
      rollback_errors: [],
    });
  }

  const originals = new Map<string, string | null>();
  const changes: MigrationReport["changes"] = [];
  try {
    for (const change of ordered) {
      const original = await options.fileSystem.readText(change.path);
      originals.set(change.path, original);
      const operation =
        original === null ? "create" : original === change.content ? "unchanged" : "update";
      changes.push({
        path: change.path,
        operation,
        status: operation === "unchanged" ? "unchanged" : "planned",
      });
    }
  } catch (error) {
    return migrationReportSchema.parse({
      migration_id: plan.id,
      from_version: plan.fromVersion,
      to_version: plan.toVersion,
      status: "failed",
      dry_run: options.dryRun ?? false,
      started_at: startedAt,
      completed_at: clock().toISOString(),
      changes,
      warnings: plan.warnings,
      lock_updated: false,
      rolled_back: false,
      error: {
        code: "migration_read_failed",
        message: safeErrorMessage(error),
        next_action: "Restore readable repository files and rerun the migration.",
      },
      rollback_errors: [],
    });
  }

  const pending = changes.filter((change) => change.operation !== "unchanged");
  if (pending.length === 0) {
    return migrationReportSchema.parse({
      migration_id: plan.id,
      from_version: plan.fromVersion,
      to_version: plan.toVersion,
      status: "already_current",
      dry_run: options.dryRun ?? false,
      started_at: startedAt,
      completed_at: clock().toISOString(),
      changes,
      warnings: plan.warnings,
      lock_updated: false,
      rolled_back: false,
      error: null,
      rollback_errors: [],
    });
  }

  if (options.dryRun) {
    return migrationReportSchema.parse({
      migration_id: plan.id,
      from_version: plan.fromVersion,
      to_version: plan.toVersion,
      status: "planned",
      dry_run: true,
      started_at: startedAt,
      completed_at: clock().toISOString(),
      changes,
      warnings: plan.warnings,
      lock_updated: false,
      rolled_back: false,
      error: null,
      rollback_errors: [],
    });
  }

  const attempted: string[] = [];
  try {
    for (const change of ordered) {
      const report = changes.find((entry) => entry.path === change.path)!;
      if (report.operation === "unchanged") continue;
      attempted.push(change.path);
      await options.fileSystem.writeAtomic(change.path, change.content);
      report.status = "applied";
    }
    return migrationReportSchema.parse({
      migration_id: plan.id,
      from_version: plan.fromVersion,
      to_version: plan.toVersion,
      status: "applied",
      dry_run: false,
      started_at: startedAt,
      completed_at: clock().toISOString(),
      changes,
      warnings: plan.warnings,
      lock_updated: changes.some(
        (change) => change.path === "harness.lock" && change.status === "applied",
      ),
      rolled_back: false,
      error: null,
      rollback_errors: [],
    });
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const path of [...attempted].reverse()) {
      const report = changes.find((entry) => entry.path === path)!;
      try {
        const original = originals.get(path);
        if (original === null) await options.fileSystem.remove(path);
        else await options.fileSystem.writeAtomic(path, original!);
        report.status = "rolled_back";
      } catch (rollbackError) {
        report.status = "rollback_failed";
        rollbackErrors.push(`${path}: ${safeErrorMessage(rollbackError)}`);
      }
    }
    return migrationReportSchema.parse({
      migration_id: plan.id,
      from_version: plan.fromVersion,
      to_version: plan.toVersion,
      status: "failed",
      dry_run: false,
      started_at: startedAt,
      completed_at: clock().toISOString(),
      changes,
      warnings: plan.warnings,
      lock_updated: false,
      rolled_back: attempted.length > 0 && rollbackErrors.length === 0,
      error: {
        code: "migration_write_failed",
        message: safeErrorMessage(error),
        next_action:
          rollbackErrors.length === 0
            ? "The original files were restored; resolve the write failure and rerun."
            : "Rollback was incomplete; restore the listed files from version control before rerunning.",
      },
      rollback_errors: rollbackErrors,
    });
  }
}
