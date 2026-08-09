import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { harnessLockSchema } from "../config/harness-lock";
import type { UpgradeFilePlan, UpgradeOptions, UpgradePlan, UpgradeReport } from "./types";
import { harnessReleaseSchema } from "./types";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /(gh[pousr]_|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]+/g,
    "$1[REDACTED]",
  );
}

function mergeLines(base: string, current: string, next: string): string | null {
  const baseLines = base.split("\n");
  const currentLines = current.split("\n");
  const nextLines = next.split("\n");
  const length = Math.max(baseLines.length, currentLines.length, nextLines.length);
  const merged: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const before = baseLines[index];
    const local = currentLines[index];
    const incoming = nextLines[index];
    if (local === incoming) merged.push(local ?? "");
    else if (local === before) merged.push(incoming ?? "");
    else if (incoming === before) merged.push(local ?? "");
    else return null;
  }
  return merged.join("\n");
}

export async function planUpgrade(options: UpgradeOptions): Promise<UpgradePlan> {
  const release = harnessReleaseSchema.parse(options.release);
  const previous = new Map(options.currentLock.managed_files.map((file) => [file.path, file]));
  const files: UpgradeFilePlan[] = [];

  for (const file of release.files) {
    const currentContent = await options.fileSystem.readText(file.path);
    const currentHash = currentContent === null ? null : sha256(currentContent);
    const previousEntry = previous.get(file.path);
    const previousHash = previousEntry?.sha256 ?? null;
    const previousBaseHash = previousEntry?.base_sha256 ?? previousHash;
    const nextHash = sha256(file.content);
    let action: UpgradeFilePlan["action"];
    let reason: string;
    let resultContent = file.content;

    if (file.ownership === "project" || file.ownership === "venture_owned") {
      action = "preserve";
      reason = "venture-owned files are never replaced by a Core upgrade";
      resultContent = currentContent ?? file.content;
    } else if (currentHash === nextHash) {
      action = "unchanged";
      reason = "working tree already matches the target release";
    } else if (currentContent === null) {
      action = "create";
      reason = "managed file does not exist in the child venture";
    } else if (previousEntry && previousEntry.ownership !== file.ownership) {
      action = "conflict";
      reason = `ownership changed from ${previousEntry.ownership} to ${file.ownership}`;
    } else if (file.ownership === "merge_managed" && currentHash !== previousBaseHash) {
      if (
        previousBaseHash === null ||
        file.baseContent === undefined ||
        sha256(file.baseContent) !== previousBaseHash
      ) {
        action = "conflict";
        reason = "merge-managed file has no matching trusted three-way base";
      } else {
        const merged = mergeLines(file.baseContent, currentContent, file.content);
        if (merged === null) {
          action = "conflict";
          reason = "merge-managed file has overlapping local and Core edits";
        } else {
          action = "merge";
          reason = "non-overlapping local and Core edits merged against the trusted base";
          resultContent = merged;
        }
      }
    } else if (previousHash === null || currentHash !== previousHash) {
      action = "conflict";
      reason =
        previousHash === null
          ? "the lock has no trusted baseline hash for this existing file"
          : "the child venture changed this Core-owned file after the previous release";
    } else {
      action = "update";
      reason = "the file still matches its trusted baseline and can be replaced safely";
    }

    files.push({
      path: file.path,
      ownership: file.ownership,
      action,
      reason,
      previousHash,
      currentHash,
      nextHash,
      resultHash: sha256(resultContent),
      ...(action === "merge" ? { resultContent } : {}),
    });
  }

  const releasePaths = new Set(release.files.map((file) => file.path));
  const managedFiles = [
    ...release.files.map((file) => {
      const planned = files.find((candidate) => candidate.path === file.path)!;
      return {
        path: file.path,
        ownership: file.ownership,
        sha256:
          file.ownership === "project" || file.ownership === "venture_owned"
            ? (planned.currentHash ?? previous.get(file.path)?.sha256 ?? null)
            : planned.resultHash,
        ...(file.ownership === "merge_managed" ? { base_sha256: planned.nextHash } : {}),
      };
    }),
    ...options.currentLock.managed_files.filter((file) => !releasePaths.has(file.path)),
  ].sort((left, right) => left.path.localeCompare(right.path));

  const nextLock = harnessLockSchema.parse({
    ...options.currentLock,
    harness_version: release.version,
    ...(options.currentLock.lock_version === 2 ? { core_version: release.version } : {}),
    config_contract_version:
      release.configContractVersion ?? options.currentLock.config_contract_version,
    source: release.source,
    managed_files: managedFiles,
  });
  return {
    fromVersion: options.currentLock.harness_version,
    toVersion: release.version,
    release,
    files,
    conflicts: files.filter((file) => file.action === "conflict"),
    nextLock,
  };
}

export async function applyUpgrade(options: UpgradeOptions): Promise<UpgradeReport> {
  let plan: UpgradePlan;
  try {
    plan = await planUpgrade(options);
  } catch (error) {
    return {
      status: "failed",
      dryRun: options.dryRun ?? false,
      fromVersion: options.currentLock.harness_version,
      toVersion: options.release.version,
      files: [],
      conflicts: [],
      lockUpdated: false,
      rolledBack: false,
      error: {
        code: "upgrade_plan_invalid",
        message: safeMessage(error),
        nextAction: "Fix the release manifest or unreadable managed file; no files were changed.",
      },
    };
  }

  if (plan.conflicts.length > 0) {
    return {
      status: "blocked",
      dryRun: options.dryRun ?? false,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      files: plan.files,
      conflicts: plan.conflicts,
      lockUpdated: false,
      rolledBack: false,
      error: {
        code: "managed_file_conflict",
        message: `${plan.conflicts.length} managed file conflict(s) require review.`,
        nextAction:
          "Keep the child change and mark the file project-owned, or reconcile it with the release and refresh its trusted lock hash; then rerun vh upgrade --dry-run.",
      },
    };
  }

  const writable = plan.files.filter(
    (file) => file.action === "create" || file.action === "update" || file.action === "merge",
  );
  const lockText = `${stringify(plan.nextLock, { lineWidth: 100, sortMapEntries: false })}`;
  const currentLockText = await options.fileSystem.readText("harness.lock");
  const targetLockHash = sha256(lockText);
  const currentLockHash = currentLockText === null ? null : sha256(currentLockText);
  if (writable.length === 0 && currentLockHash === targetLockHash) {
    return {
      status: "already_current",
      dryRun: options.dryRun ?? false,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      files: plan.files,
      conflicts: [],
      lockUpdated: false,
      rolledBack: false,
      error: null,
    };
  }

  if (options.dryRun) {
    return {
      status: "planned",
      dryRun: true,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      files: plan.files,
      conflicts: [],
      lockUpdated: false,
      rolledBack: false,
      error: null,
    };
  }

  const originals = new Map<string, string | null>();
  const attempted: string[] = [];
  try {
    for (const item of writable) {
      const releaseFile = plan.release.files.find((file) => file.path === item.path)!;
      originals.set(item.path, await options.fileSystem.readText(item.path));
      attempted.push(item.path);
      await options.fileSystem.writeAtomic(item.path, item.resultContent ?? releaseFile.content);
    }
    originals.set("harness.lock", currentLockText);
    attempted.push("harness.lock");
    await options.fileSystem.writeAtomic("harness.lock", lockText);
    return {
      status: "applied",
      dryRun: false,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      files: plan.files,
      conflicts: [],
      lockUpdated: true,
      rolledBack: false,
      error: null,
    };
  } catch (error) {
    let rollbackFailed = false;
    for (const path of [...attempted].reverse()) {
      try {
        const original = originals.get(path);
        if (original === null) await options.fileSystem.remove(path);
        else if (original !== undefined) await options.fileSystem.writeAtomic(path, original);
      } catch {
        rollbackFailed = true;
      }
    }
    return {
      status: "failed",
      dryRun: false,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      files: plan.files,
      conflicts: [],
      lockUpdated: false,
      rolledBack: attempted.length > 0 && !rollbackFailed,
      error: {
        code: "upgrade_write_failed",
        message: safeMessage(error),
        nextAction: rollbackFailed
          ? "Rollback was incomplete; restore the attempted files from version control before retrying."
          : "The previous files were restored; resolve the write failure and rerun vh upgrade --dry-run.",
      },
    };
  }
}
