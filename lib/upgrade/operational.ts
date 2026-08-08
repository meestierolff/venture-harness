import { createHash } from "node:crypto";
import { stringify, parse } from "yaml";
import { harnessLockSchema, parseHarnessLock, type HarnessLock } from "../config/harness-lock";
import type { CommandRunner } from "../credentials";
import {
  defaultMigrationRegistry,
  type MigrationFileSystem,
  type MigrationPlan,
  type MigrationRegistry,
} from "../migrations";
import { planUpgrade } from "./engine";
import type {
  HarnessRelease,
  UpgradeFilePlan,
  UpgradeVerificationResult,
  UpgradeVerificationStep,
} from "./types";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(gh[pousr]_|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .slice(0, 500);
}

export const OPERATIONAL_UPGRADE_STEPS: readonly UpgradeVerificationStep[] = [
  { id: "agent_adapter_sync", command: "pnpm", args: ["agents:sync"] },
  { id: "agent_adapter_parity", command: "pnpm", args: ["agents:check"] },
  { id: "typecheck", command: "pnpm", args: ["typecheck"] },
  { id: "migration_tests", command: "pnpm", args: ["test:migrations"] },
];

export interface OperationalMigrationReport {
  id: string;
  fromVersion: string;
  toVersion: string;
  paths: string[];
  warnings: string[];
}

export interface OperationalUpgradeReport {
  status: "planned" | "applied" | "already_current" | "blocked" | "failed";
  dryRun: boolean;
  fromVersion: string;
  toVersion: string;
  migrations: OperationalMigrationReport[];
  files: UpgradeFilePlan[];
  conflicts: UpgradeFilePlan[];
  verification: UpgradeVerificationResult[];
  lockUpdated: boolean;
  rolledBack: boolean;
  error: null | { code: string; message: string; nextAction: string };
}

export interface OperationalUpgradeOptions {
  fileSystem: MigrationFileSystem;
  release: HarnessRelease;
  commandRunner: CommandRunner;
  rootDir: string;
  currentLock?: HarnessLock;
  migrationRegistry?: MigrationRegistry;
  dryRun?: boolean;
  clock?: () => Date;
}

function verificationReport(
  status: UpgradeVerificationResult["status"],
): UpgradeVerificationResult[] {
  return OPERATIONAL_UPGRADE_STEPS.map((step) => ({
    id: step.id,
    command: step.command,
    args: [...step.args],
    status,
    exitCode: null,
  }));
}

async function detectSourceVersion(options: OperationalUpgradeOptions): Promise<string> {
  if (options.currentLock) return options.currentLock.harness_version;
  const frameworkText = await options.fileSystem.readText("config/framework.yaml");
  if (frameworkText === null) {
    throw new Error("Cannot infer the unlocked source version: config/framework.yaml is missing");
  }
  const framework = parse(frameworkText) as { framework?: { version?: unknown } };
  const version = framework.framework?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Cannot infer the unlocked source version from framework.version");
  }
  return version;
}

function summarizeMigrations(plans: readonly MigrationPlan[]): OperationalMigrationReport[] {
  return plans.map((plan) => ({
    id: plan.id,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    paths: plan.changes.map((change) => change.path),
    warnings: plan.warnings,
  }));
}

function withAppliedMigrations(options: {
  lock: HarnessLock;
  plans: readonly MigrationPlan[];
  clock: () => Date;
}): HarnessLock {
  const seen = new Set(options.lock.applied_migrations.map((migration) => migration.id));
  const additions = options.plans
    .filter((plan) => !seen.has(plan.id))
    .map((plan) => ({
      id: plan.id,
      from_version: plan.fromVersion,
      to_version: plan.toVersion,
      applied_at: options.clock().toISOString(),
    }));
  return harnessLockSchema.parse({
    ...options.lock,
    applied_migrations: [...options.lock.applied_migrations, ...additions],
  });
}

async function rollback(
  fileSystem: MigrationFileSystem,
  paths: readonly string[],
  originals: ReadonlyMap<string, string | null>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const path of [...paths].reverse()) {
    try {
      const original = originals.get(path);
      if (original === null) await fileSystem.remove(path);
      else if (original !== undefined) await fileSystem.writeAtomic(path, original);
    } catch (error) {
      failures.push(`${path}: ${safeMessage(error)}`);
    }
  }
  return failures;
}

function failureReport(options: {
  dryRun: boolean;
  fromVersion: string;
  toVersion: string;
  migrations?: OperationalMigrationReport[];
  files?: UpgradeFilePlan[];
  conflicts?: UpgradeFilePlan[];
  verification?: UpgradeVerificationResult[];
  rolledBack?: boolean;
  code: string;
  message: string;
  nextAction: string;
}): OperationalUpgradeReport {
  return {
    status: options.conflicts?.length ? "blocked" : "failed",
    dryRun: options.dryRun,
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    migrations: options.migrations ?? [],
    files: options.files ?? [],
    conflicts: options.conflicts ?? [],
    verification: options.verification ?? verificationReport("not_run"),
    lockUpdated: false,
    rolledBack: options.rolledBack ?? false,
    error: {
      code: options.code,
      message: options.message,
      nextAction: options.nextAction,
    },
  };
}

/**
 * Applies migrations and managed release writes as one reversible local stage.
 * Fixed adapter/verification commands run after staged writes and before the
 * final lock write. Release data can never add or replace these commands.
 */
export async function applyOperationalUpgrade(
  options: OperationalUpgradeOptions,
): Promise<OperationalUpgradeReport> {
  const dryRun = options.dryRun ?? false;
  const clock = options.clock ?? (() => new Date());
  let fromVersion = options.currentLock?.harness_version ?? "0.0.0";
  let migrationPlans: MigrationPlan[] = [];
  let files: UpgradeFilePlan[] = [];
  try {
    fromVersion = await detectSourceVersion(options);
    const chain = await (options.migrationRegistry ?? defaultMigrationRegistry).planChain({
      fromVersion,
      toVersion: options.release.version,
      fileSystem: options.fileSystem,
      clock,
    });
    migrationPlans = chain.plans;
    const planningLock = options.currentLock
      ? options.currentLock
      : await chain.stagedFileSystem.readText("harness.lock").then((text) => {
          if (text === null) {
            throw new Error("The migration chain did not produce a trusted harness.lock baseline");
          }
          const lock = parseHarnessLock(text);
          if (lock.harness_version !== options.release.version) {
            throw new Error(
              `The staged migration lock targets ${lock.harness_version}, not release ${options.release.version}`,
            );
          }
          return lock;
        });
    const upgradePlan = await planUpgrade({
      fileSystem: chain.stagedFileSystem,
      currentLock: planningLock,
      release: options.release,
    });
    files = upgradePlan.files;
    const migrations = summarizeMigrations(migrationPlans);
    if (upgradePlan.conflicts.length > 0) {
      return failureReport({
        dryRun,
        fromVersion,
        toVersion: options.release.version,
        migrations,
        files,
        conflicts: upgradePlan.conflicts,
        code: "managed_file_conflict",
        message: `${upgradePlan.conflicts.length} managed file conflict(s) require review.`,
        nextAction:
          "Preserve the child change as project-owned or reconcile it against the trusted local release, then rerun vh upgrade --release <local-release-root> --dry-run.",
      });
    }

    const migrationChanges = migrationPlans.flatMap((plan) =>
      plan.changes.filter((change) => change.path !== "harness.lock"),
    );
    const releaseWrites = files.filter(
      (file) => file.action === "create" || file.action === "update",
    );
    const candidateLock = withAppliedMigrations({
      lock: upgradePlan.nextLock,
      plans: migrationPlans,
      clock,
    });
    const currentLockText = await options.fileSystem.readText("harness.lock");
    const candidateLockText = stringify(candidateLock, {
      lineWidth: 100,
      sortMapEntries: false,
    });
    const hasLockChange = currentLockText !== candidateLockText;
    const hasWrites = migrationChanges.length > 0 || releaseWrites.length > 0 || hasLockChange;
    if (!hasWrites) {
      return {
        status: "already_current",
        dryRun,
        fromVersion,
        toVersion: options.release.version,
        migrations,
        files,
        conflicts: [],
        verification: verificationReport("not_run"),
        lockUpdated: false,
        rolledBack: false,
        error: null,
      };
    }
    if (dryRun) {
      return {
        status: "planned",
        dryRun: true,
        fromVersion,
        toVersion: options.release.version,
        migrations,
        files,
        conflicts: [],
        verification: verificationReport("planned"),
        lockUpdated: false,
        rolledBack: false,
        error: null,
      };
    }

    const transactionPaths = [
      ...new Set([
        ...migrationChanges.map((change) => change.path),
        ...options.release.files.map((file) => file.path),
        ...planningLock.managed_files.map((file) => file.path),
        "harness.lock",
      ]),
    ].sort();
    const originals = new Map<string, string | null>();
    for (const path of transactionPaths) {
      originals.set(path, await options.fileSystem.readText(path));
    }
    const verification = verificationReport("not_run");
    const attempted: string[] = [];

    try {
      for (const change of migrationChanges) {
        const current = await options.fileSystem.readText(change.path);
        if (current === change.content) continue;
        attempted.push(change.path);
        await options.fileSystem.writeAtomic(change.path, change.content);
      }
      for (const item of releaseWrites) {
        const releaseFile = options.release.files.find((file) => file.path === item.path)!;
        attempted.push(item.path);
        await options.fileSystem.writeAtomic(item.path, releaseFile.content);
      }

      for (const [index, step] of OPERATIONAL_UPGRADE_STEPS.entries()) {
        let result;
        try {
          result = await options.commandRunner.run({
            command: step.command,
            args: step.args,
            cwd: options.rootDir,
          });
        } catch (error) {
          verification[index] = {
            ...verification[index],
            status: "failed",
            exitCode: null,
          };
          throw error;
        }
        verification[index] = {
          ...verification[index],
          status: result.exitCode === 0 ? "passed" : "failed",
          exitCode: result.exitCode,
        };
        if (result.exitCode !== 0) {
          throw new Error(`verification ${step.id} exited ${result.exitCode}`);
        }
      }

      for (const managedFile of candidateLock.managed_files) {
        if (managedFile.ownership === "project") continue;
        const actual = await options.fileSystem.readText(managedFile.path);
        if (
          managedFile.sha256 === null ||
          actual === null ||
          sha256(actual) !== managedFile.sha256
        ) {
          throw new Error(`verified stage diverged from managed baseline: ${managedFile.path}`);
        }
      }

      attempted.push("harness.lock");
      await options.fileSystem.writeAtomic("harness.lock", candidateLockText);
      return {
        status: "applied",
        dryRun: false,
        fromVersion,
        toVersion: options.release.version,
        migrations,
        files,
        conflicts: [],
        verification,
        lockUpdated: true,
        rolledBack: false,
        error: null,
      };
    } catch (error) {
      const rollbackFailures = await rollback(options.fileSystem, transactionPaths, originals);
      const validationFailed = verification.some((result) => result.status === "failed");
      return failureReport({
        dryRun: false,
        fromVersion,
        toVersion: options.release.version,
        migrations,
        files,
        verification,
        rolledBack:
          (attempted.length > 0 || verification.some((result) => result.status !== "not_run")) &&
          rollbackFailures.length === 0,
        code: validationFailed ? "upgrade_validation_failed" : "upgrade_stage_failed",
        message: safeMessage(error),
        nextAction:
          rollbackFailures.length > 0
            ? `Rollback was incomplete (${rollbackFailures.join("; ")}); restore those files from version control before retrying.`
            : "The previous files were restored; fix the reported stage or verification failure and rerun the dry run.",
      });
    }
  } catch (error) {
    return failureReport({
      dryRun,
      fromVersion,
      toVersion: options.release.version,
      migrations: summarizeMigrations(migrationPlans),
      files,
      code: "upgrade_preparation_failed",
      message: safeMessage(error),
      nextAction:
        "Use a trusted local release with a registered migration chain, repair the reported input, and rerun vh upgrade --dry-run.",
    });
  }
}
