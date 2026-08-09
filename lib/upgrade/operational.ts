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
import { ventureSeed } from "../materialization/seeds";
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

export const ORDINARY_WEB_UPGRADE_STEPS: readonly UpgradeVerificationStep[] = [
  { id: "child_verify", command: "pnpm", args: ["verify"] },
];

const ORDINARY_WEB_MIGRATION_STEP: UpgradeVerificationStep = {
  id: "child_migration_tests",
  command: "pnpm",
  args: ["test:migrations"],
};

class UpgradePreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = "UpgradePreparationError";
  }
}

interface OperationalVerificationProfile {
  steps: readonly UpgradeVerificationStep[];
  packageScripts: Readonly<Record<string, string>> | null;
}

function preparationError(message: string): UpgradePreparationError {
  return new UpgradePreparationError(
    "untrusted_upgrade_verification_profile",
    message,
    "Restore the child harness.lock, venture.manifest.json, and managed package.json to a trusted state, then rerun vh upgrade --release <local-release-root> --dry-run.",
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function packageScripts(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw preparationError("The managed child package.json is not valid JSON");
  }
  const scripts = record(record(parsed)?.scripts);
  if (!scripts) throw preparationError("The managed child package.json has no scripts object");
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      throw preparationError(`The managed child package.json script ${name} is not a string`);
    }
  }
  return scripts as Record<string, string>;
}

async function resolveOperationalVerificationProfile(options: {
  lock: HarnessLock;
  fileSystem: MigrationFileSystem;
}): Promise<OperationalVerificationProfile> {
  if (options.lock.lock_version === 1) {
    const frameworkText = await options.fileSystem.readText("config/framework.yaml");
    const frameworkDocument = frameworkText === null ? null : record(parse(frameworkText));
    const framework = record(frameworkDocument?.framework);
    const verification = record(frameworkDocument?.verification);
    if (
      framework?.name !== "venture-harness" ||
      frameworkDocument?.package_manager !== "pnpm" ||
      verification?.primary !== "pnpm verify"
    ) {
      throw preparationError(
        "The v1 lock is not backed by the canonical Venture Harness Core framework contract",
      );
    }
    return { steps: OPERATIONAL_UPGRADE_STEPS, packageScripts: null };
  }
  if (options.lock.seed.id !== "agentic-web-saas") {
    throw preparationError(
      `No fixed operational verification profile is registered for v2 seed ${options.lock.seed.id}`,
    );
  }
  if (options.lock.extensions.venture_manifest !== "venture.manifest.json") {
    throw preparationError("The v2 child lock does not select the canonical venture.manifest.json");
  }

  const manifestEntry = options.lock.managed_files.find(
    (entry) => entry.path === "venture.manifest.json",
  );
  const manifestText = await options.fileSystem.readText("venture.manifest.json");
  if (
    manifestEntry?.ownership !== "venture_owned" ||
    manifestEntry.sha256 === null ||
    manifestText === null ||
    sha256(manifestText) !== manifestEntry.sha256
  ) {
    throw preparationError(
      "The ordinary web child venture.manifest.json does not match its trusted lock hash",
    );
  }
  let manifest: Record<string, unknown> | null;
  try {
    manifest = record(JSON.parse(manifestText) as unknown);
  } catch {
    manifest = null;
  }
  const manifestSeed = record(manifest?.seed);
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.rail !== "web" ||
    manifestSeed?.id !== options.lock.seed.id ||
    manifestSeed?.version !== options.lock.seed.version
  ) {
    throw preparationError(
      "The ordinary web child manifest does not bind the seed and rail selected by harness.lock",
    );
  }

  const packageEntry = options.lock.managed_files.find((entry) => entry.path === "package.json");
  const packageText = await options.fileSystem.readText("package.json");
  if (packageEntry?.ownership !== "merge_managed" || packageText === null) {
    throw preparationError(
      "The ordinary web child requires package.json to remain a merge-managed seed file",
    );
  }
  const scripts = packageScripts(packageText);
  let registeredScripts: Readonly<Record<string, string>>;
  try {
    registeredScripts = ventureSeed(options.lock.seed.id, options.lock.seed.version).packageScripts;
  } catch {
    throw preparationError(
      `No registered script contract exists for ${options.lock.seed.id}@${options.lock.seed.version}`,
    );
  }
  for (const [name, expected] of Object.entries(registeredScripts)) {
    if (scripts[name] !== expected) {
      throw preparationError(
        `The ordinary web child ${name} script does not match ${options.lock.seed.id}@${options.lock.seed.version}`,
      );
    }
  }
  if (registeredScripts.verify !== "pnpm typecheck && pnpm test && pnpm build") {
    throw preparationError(
      `The registered ${options.lock.seed.id}@${options.lock.seed.version} verify command is not allowlisted for operational upgrades`,
    );
  }
  const steps = [...ORDINARY_WEB_UPGRADE_STEPS];
  const currentMigrationScript = scripts["test:migrations"];
  const registeredMigrationScript = registeredScripts["test:migrations"];
  if (currentMigrationScript !== undefined) {
    if (
      registeredMigrationScript === undefined ||
      currentMigrationScript !== registeredMigrationScript
    ) {
      throw preparationError(
        `The ordinary web child test:migrations script is not registered for ${options.lock.seed.id}@${options.lock.seed.version}`,
      );
    }
    steps.push(ORDINARY_WEB_MIGRATION_STEP);
  }
  return { steps, packageScripts: scripts };
}

function assertVerificationScriptsPreserved(options: {
  profile: OperationalVerificationProfile;
  files: readonly UpgradeFilePlan[];
  release: HarnessRelease;
  currentPackageText: string | null;
}): void {
  if (options.profile.packageScripts === null) return;
  const packagePlan = options.files.find((file) => file.path === "package.json");
  const releasePackage = options.release.files.find((file) => file.path === "package.json");
  const candidateText =
    packagePlan && releasePackage
      ? packagePlan.action === "merge"
        ? (packagePlan.resultContent ?? releasePackage.content)
        : packagePlan.action === "create" ||
            packagePlan.action === "update" ||
            packagePlan.action === "unchanged"
          ? releasePackage.content
          : options.currentPackageText
      : options.currentPackageText;
  if (candidateText === null) {
    throw preparationError("The staged ordinary web child has no managed package.json");
  }
  const candidateScripts = packageScripts(candidateText);
  const scriptNames = [
    ...new Set([...Object.keys(options.profile.packageScripts), ...Object.keys(candidateScripts)]),
  ].sort();
  const changedScript = scriptNames.find(
    (script) => candidateScripts[script] !== options.profile.packageScripts?.[script],
  );
  if (changedScript) {
    throw preparationError(
      `The release changes the trusted child ${changedScript} script; review that change separately before upgrading`,
    );
  }
}

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
  steps: readonly UpgradeVerificationStep[],
  status: UpgradeVerificationResult["status"],
): UpgradeVerificationResult[] {
  return steps.map((step) => ({
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
  verificationSteps?: readonly UpgradeVerificationStep[];
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
    verification:
      options.verification ?? verificationReport(options.verificationSteps ?? [], "not_run"),
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
  let verificationSteps: readonly UpgradeVerificationStep[] =
    options.currentLock?.lock_version === 2 ? [] : OPERATIONAL_UPGRADE_STEPS;
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
    const verificationProfile = await resolveOperationalVerificationProfile({
      lock: planningLock,
      fileSystem: chain.stagedFileSystem,
    });
    verificationSteps = verificationProfile.steps;
    const currentPackageText =
      verificationProfile.packageScripts === null
        ? null
        : await chain.stagedFileSystem.readText("package.json");
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
        verificationSteps,
        code: "managed_file_conflict",
        message: `${upgradePlan.conflicts.length} managed file conflict(s) require review.`,
        nextAction:
          "Preserve the child change as project-owned or reconcile it against the trusted local release, then rerun vh upgrade --release <local-release-root> --dry-run.",
      });
    }
    assertVerificationScriptsPreserved({
      profile: verificationProfile,
      files,
      release: options.release,
      currentPackageText,
    });

    const migrationChanges = migrationPlans.flatMap((plan) =>
      plan.changes.filter((change) => change.path !== "harness.lock"),
    );
    const releaseWrites = files.filter(
      (file) => file.action === "create" || file.action === "update" || file.action === "merge",
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
        verification: verificationReport(verificationSteps, "not_run"),
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
        verification: verificationReport(verificationSteps, "planned"),
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
    const verification = verificationReport(verificationSteps, "not_run");
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
        await options.fileSystem.writeAtomic(item.path, item.resultContent ?? releaseFile.content);
      }

      for (const [index, step] of verificationSteps.entries()) {
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
        if (managedFile.ownership === "project" || managedFile.ownership === "venture_owned") {
          continue;
        }
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
      verificationSteps,
      code: error instanceof UpgradePreparationError ? error.code : "upgrade_preparation_failed",
      message: safeMessage(error),
      nextAction:
        error instanceof UpgradePreparationError
          ? error.nextAction
          : "Use a trusted local release with a registered migration chain, repair the reported input, and rerun vh upgrade --dry-run.",
    });
  }
}
