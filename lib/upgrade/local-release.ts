import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseHarnessLock } from "../config/harness-lock";
import { harnessReleaseSchema, type HarnessRelease } from "./types";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function rejectRemoteLocator(locator: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(locator)) {
    throw new Error(
      "Release locators must be local filesystem paths; URL fetching and remote execution are forbidden",
    );
  }
}

/**
 * Reads one explicitly selected local release checkout. The checkout's lock is
 * the manifest: source/ref and every managed content hash must verify before
 * any child file can be planned or written. No command is read from the release.
 */
export async function locateLocalHarnessRelease(options: {
  locator: string;
  baseDir?: string;
}): Promise<HarnessRelease> {
  rejectRemoteLocator(options.locator);
  const requestedRoot = resolve(options.baseDir ?? process.cwd(), options.locator);
  const requestedStat = await stat(requestedRoot).catch(() => null);
  if (!requestedStat?.isDirectory()) {
    throw new Error(`Local release directory does not exist: ${options.locator}`);
  }
  const releaseRoot = await realpath(requestedRoot);
  const lockPath = resolve(releaseRoot, "harness.lock");
  const lockRealPath = await realpath(lockPath).catch(() => null);
  if (lockRealPath === null || !isInside(releaseRoot, lockRealPath)) {
    throw new Error("Local release must contain a non-escaping harness.lock");
  }
  const lock = parseHarnessLock(await readFile(lockRealPath, "utf8"));
  if (lock.source.kind !== "release" || lock.source.ref !== `v${lock.harness_version}`) {
    throw new Error(
      `Local release lock must declare source release/v${lock.harness_version}; found ${lock.source.kind}/${lock.source.ref ?? "null"}`,
    );
  }
  if (lock.managed_files.length === 0) {
    throw new Error("Local release lock has no managed-file baseline");
  }

  const files: HarnessRelease["files"] = [];
  for (const entry of lock.managed_files) {
    if (entry.sha256 === null) {
      if (entry.ownership !== "project" && entry.ownership !== "venture_owned") {
        throw new Error(`Local release managed file has no trusted hash: ${entry.path}`);
      }
      files.push({ path: entry.path, ownership: entry.ownership, content: "" });
      continue;
    }
    const candidate = resolve(releaseRoot, entry.path);
    const fileStat = await lstat(candidate).catch(() => null);
    if (fileStat === null || !fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`Local release managed file is missing or not a regular file: ${entry.path}`);
    }
    const realCandidate = await realpath(candidate);
    if (!isInside(releaseRoot, realCandidate)) {
      throw new Error(`Local release managed file escapes its root: ${entry.path}`);
    }
    const content = await readFile(realCandidate, "utf8");
    if (sha256(content) !== entry.sha256) {
      throw new Error(`Local release managed hash mismatch: ${entry.path}`);
    }
    files.push({ path: entry.path, ownership: entry.ownership, content });
  }

  return harnessReleaseSchema.parse({
    version: lock.harness_version,
    configContractVersion: lock.config_contract_version,
    source: lock.source,
    files,
  });
}
