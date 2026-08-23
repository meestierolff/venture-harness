import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LockedDirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
}

export interface OwnerPathLockOptions {
  readonly label: string;
  readonly lockName?: string;
}

const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function fileIdentity(metadata: Stats): FileIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedAtMs: metadata.mtimeMs,
    changedAtMs: metadata.ctimeMs,
  };
}

function sameFileIdentity(metadata: Stats, expected: FileIdentity): boolean {
  return (
    metadata.dev === expected.device &&
    metadata.ino === expected.inode &&
    metadata.size === expected.size &&
    metadata.mtimeMs === expected.modifiedAtMs &&
    metadata.ctimeMs === expected.changedAtMs
  );
}

function sameNodeIdentity(metadata: Stats, expected: FileIdentity): boolean {
  return metadata.dev === expected.device && metadata.ino === expected.inode;
}

function sameRenamedFileIdentity(metadata: Stats, expected: FileIdentity): boolean {
  return (
    metadata.dev === expected.device &&
    metadata.ino === expected.inode &&
    metadata.size === expected.size &&
    metadata.mtimeMs === expected.modifiedAtMs
  );
}

function assertOwnerControlled(metadata: Stats, label: string): void {
  const uid = currentUid();
  if (uid !== null && metadata.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be writable by group or other users`);
  }
}

function assertDirectoryMetadata(metadata: Stats, label: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real non-symlink directory`);
  }
  assertOwnerControlled(metadata, label);
}

function assertRootRenameProtected(path: string, rootMetadata: Stats, label: string): void {
  const parent = dirname(path);
  if (parent === path) return;
  const parentMetadata = lstatSync(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`${label} parent must be a real non-symlink directory`);
  }
  const writableByAnotherPrincipal = (parentMetadata.mode & 0o022) !== 0;
  const stickyDirectory = (parentMetadata.mode & 0o1000) !== 0;
  const uid = currentUid();
  const stickyProtectsEntry = stickyDirectory && uid !== null && rootMetadata.uid === uid;
  if (writableByAnotherPrincipal && !stickyProtectsEntry) {
    throw new Error(
      `${label} parent must not permit another OS principal to rename the protected root`,
    );
  }
}

function directoryIdentity(path: string, metadata: Stats): LockedDirectoryIdentity {
  return Object.freeze({ path, device: metadata.dev, inode: metadata.ino });
}

function sameDirectoryIdentity(metadata: Stats, expected: LockedDirectoryIdentity): boolean {
  return metadata.dev === expected.device && metadata.ino === expected.inode;
}

/**
 * A portable cooperative filesystem boundary for local founder operations.
 *
 * Node does not expose descriptor-relative openat2/renameat primitives. This
 * boundary therefore combines an exclusive owner-only lock with canonical
 * containment and inode revalidation immediately before and after every
 * pathname mutation. The protected root and every used directory must be
 * current-user-owned and not group/world writable. A malicious process running
 * as the same OS user can ignore the cooperative lock; descriptor-relative
 * syscalls would be required to eliminate the final kernel pathname race.
 */
export class OwnerPathLock {
  readonly root: LockedDirectoryIdentity;
  readonly lockPath: string;

  readonly #label: string;
  readonly #requestedRoot: string;
  readonly #lockDescriptor: number;
  #lockIdentity: FileIdentity | null = null;
  #released = false;

  constructor(rootDir: string, options: OwnerPathLockOptions) {
    const requested = resolve(rootDir);
    const canonical = realpathSync(requested);
    const rootMetadata = lstatSync(canonical);
    assertDirectoryMetadata(rootMetadata, `${options.label} root`);
    assertRootRenameProtected(canonical, rootMetadata, `${options.label} root`);
    this.root = directoryIdentity(canonical, rootMetadata);
    this.#label = options.label;
    this.#requestedRoot = requested;

    const lockName = options.lockName ?? ".venture-harness-owner.lock";
    if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.lock$/u.test(lockName)) {
      throw new Error(`${options.label} lock name is invalid`);
    }
    this.lockPath = join(canonical, lockName);

    try {
      this.#lockDescriptor = openSync(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `${options.label} is already locked. If no operation is active, inspect and remove ${this.lockPath} before retrying.`,
        );
      }
      throw error;
    }

    try {
      fchmodSync(this.#lockDescriptor, 0o600);
      const metadata = fstatSync(this.#lockDescriptor);
      this.#lockIdentity = fileIdentity(metadata);
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`${options.label} lock is not one private regular file`);
      }
      assertOwnerControlled(metadata, `${options.label} lock`);
      writeFileSync(
        this.#lockDescriptor,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, operation: options.label })}\n`,
        "utf8",
      );
      fsyncSync(this.#lockDescriptor);
      this.#lockIdentity = fileIdentity(fstatSync(this.#lockDescriptor));
      this.assertRoot();
      const pathMetadata = lstatSync(this.lockPath);
      if (!sameFileIdentity(pathMetadata, this.#lockIdentity)) {
        throw new Error(`${options.label} lock path changed during acquisition`);
      }
    } catch (error) {
      closeSync(this.#lockDescriptor);
      try {
        const current = lstatSync(this.lockPath);
        if (this.#lockIdentity && sameNodeIdentity(current, this.#lockIdentity)) {
          unlinkSync(this.lockPath);
        }
      } catch {
        // A mismatched path is deliberately left for manual inspection.
      }
      this.#released = true;
      throw error;
    }
  }

  assertRoot(): void {
    if (this.#released) throw new Error(`${this.#label} lock has already been released`);
    const metadata = lstatSync(this.root.path);
    assertDirectoryMetadata(metadata, `${this.#label} root`);
    if (
      !sameDirectoryIdentity(metadata, this.root) ||
      realpathSync(this.root.path) !== this.root.path
    ) {
      throw new Error(`${this.#label} root changed while the owner lock was held`);
    }
  }

  #relative(path: string, label: string, allowRoot = false): string {
    const absolute = this.#canonicalPath(path);
    const child = relative(this.root.path, absolute);
    if (
      (!allowRoot && child === "") ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      isAbsolute(child)
    ) {
      throw new Error(`${label} escapes the locked ${this.#label} root`);
    }
    return child;
  }

  #canonicalPath(path: string): string {
    const absolute = resolve(path);
    const throughRequestedRoot = relative(this.#requestedRoot, absolute);
    if (
      throughRequestedRoot === "" ||
      (throughRequestedRoot !== ".." &&
        !throughRequestedRoot.startsWith(`..${sep}`) &&
        !isAbsolute(throughRequestedRoot))
    ) {
      return resolve(this.root.path, throughRequestedRoot);
    }
    return absolute;
  }

  #assertExistingAncestors(path: string, label: string, includeLeaf: boolean): void {
    this.assertRoot();
    const child = this.#relative(path, label, true);
    if (child === "") return;
    const parts = child.split(sep);
    const count = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
    let cursor = this.root.path;
    for (let index = 0; index < count; index += 1) {
      cursor = join(cursor, parts[index]!);
      let metadata: Stats;
      try {
        metadata = lstatSync(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      assertDirectoryMetadata(metadata, `${label} ancestor ${cursor}`);
      const canonical = realpathSync(cursor);
      if (canonical !== cursor) {
        throw new Error(`${label} must not traverse a symbolic-link alias`);
      }
    }
    this.assertRoot();
  }

  captureDirectory(path: string, label: string): LockedDirectoryIdentity {
    const absolute = this.#canonicalPath(path);
    this.#relative(absolute, label, true);
    this.#assertExistingAncestors(absolute, label, true);
    const metadata = lstatSync(absolute);
    assertDirectoryMetadata(metadata, label);
    if (realpathSync(absolute) !== absolute) {
      throw new Error(`${label} must not traverse a symbolic-link alias`);
    }
    return directoryIdentity(absolute, metadata);
  }

  assertDirectory(path: string, expected: LockedDirectoryIdentity, label: string): void {
    if (this.#canonicalPath(path) !== expected.path) {
      throw new Error(`${label} path changed unexpectedly`);
    }
    const current = this.captureDirectory(path, label);
    if (current.device !== expected.device || current.inode !== expected.inode) {
      throw new Error(`${label} changed while the owner lock was held`);
    }
  }

  ensureDirectory(path: string, label: string): LockedDirectoryIdentity {
    const absolute = this.#canonicalPath(path);
    this.#relative(absolute, label, true);
    this.#assertExistingAncestors(absolute, label, true);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    return this.captureDirectory(absolute, label);
  }

  assertMissing(path: string, label: string): void {
    const absolute = this.#canonicalPath(path);
    this.#relative(absolute, label);
    this.#assertExistingAncestors(absolute, label, false);
    if (existsSync(absolute)) throw new Error(`${label} already exists`);
    this.assertRoot();
  }

  readRegularFile(path: string, options: { label: string; maxBytes?: number }): string {
    const absolute = this.#canonicalPath(path);
    this.#relative(absolute, options.label);
    this.#assertExistingAncestors(absolute, options.label, false);
    let descriptor: number;
    try {
      descriptor = openSync(absolute, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`${options.label} must be a regular non-symlink file`);
      }
      throw error;
    }
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile()) {
        throw new Error(`${options.label} must be a regular non-symlink file`);
      }
      assertOwnerControlled(opened, options.label);
      if (options.maxBytes !== undefined && opened.size > options.maxBytes) {
        throw new Error(`${options.label} exceeds the ${options.maxBytes}-byte limit`);
      }
      const initial = fileIdentity(opened);
      this.assertRoot();
      const canonical = realpathSync(absolute);
      this.#relative(canonical, options.label);
      const pathMetadata = lstatSync(absolute);
      if (canonical !== absolute || pathMetadata.isSymbolicLink()) {
        throw new Error(`${options.label} must be a regular non-symlink file`);
      }
      if (!sameFileIdentity(pathMetadata, initial)) {
        throw new Error(`${options.label} changed after validation`);
      }
      const content = readFileSync(descriptor, "utf8");
      if (!sameFileIdentity(fstatSync(descriptor), initial)) {
        throw new Error(`${options.label} changed while it was being read`);
      }
      return content;
    } finally {
      closeSync(descriptor);
    }
  }

  writeFileAtomic(path: string, content: string, label: string): void {
    const absolute = this.#canonicalPath(path);
    this.#relative(absolute, label);
    const parent = this.ensureDirectory(dirname(absolute), `${label} parent`);
    if (existsSync(absolute)) {
      const existing = lstatSync(absolute);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`${label} target must be a regular non-symlink file`);
      }
      assertOwnerControlled(existing, `${label} target`);
    }

    const temporary = join(
      parent.path,
      `.${basename(absolute)}.next-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    let temporaryIdentity: FileIdentity | null = null;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
      temporaryIdentity = fileIdentity(fstatSync(descriptor));
      closeSync(descriptor);
      descriptor = null;

      this.assertDirectory(parent.path, parent, `${label} parent`);
      if (existsSync(absolute)) {
        const current = lstatSync(absolute);
        if (current.isSymbolicLink() || !current.isFile()) {
          throw new Error(`${label} target changed before commit`);
        }
        assertOwnerControlled(current, `${label} target`);
      }
      this.assertDirectory(parent.path, parent, `${label} parent`);
      renameSync(temporary, absolute);
      this.assertDirectory(parent.path, parent, `${label} parent`);
      const committed = lstatSync(absolute);
      if (!temporaryIdentity || !sameRenamedFileIdentity(committed, temporaryIdentity)) {
        throw new Error(`${label} target changed during atomic commit`);
      }
      temporaryIdentity = null;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      if (temporaryIdentity) {
        try {
          this.assertDirectory(parent.path, parent, `${label} cleanup parent`);
          const current = lstatSync(temporary);
          if (sameFileIdentity(current, temporaryIdentity)) unlinkSync(temporary);
        } catch {
          // Never chase a changed cleanup path. A private temp may remain for inspection.
        }
      }
    }
  }

  renameDirectory(
    source: string,
    target: string,
    expectedSource: LockedDirectoryIdentity,
    label: string,
  ): LockedDirectoryIdentity {
    const absoluteSource = this.#canonicalPath(source);
    const absoluteTarget = this.#canonicalPath(target);
    this.#relative(absoluteSource, `${label} source`);
    this.#relative(absoluteTarget, `${label} target`);
    this.assertDirectory(absoluteSource, expectedSource, `${label} source`);
    const sourceParent = this.captureDirectory(dirname(absoluteSource), `${label} source parent`);
    const targetParent = this.ensureDirectory(dirname(absoluteTarget), `${label} target parent`);
    this.assertMissing(absoluteTarget, `${label} target`);
    this.assertDirectory(sourceParent.path, sourceParent, `${label} source parent`);
    this.assertDirectory(targetParent.path, targetParent, `${label} target parent`);
    renameSync(absoluteSource, absoluteTarget);
    this.assertDirectory(sourceParent.path, sourceParent, `${label} source parent`);
    this.assertDirectory(targetParent.path, targetParent, `${label} target parent`);
    const installed = this.captureDirectory(absoluteTarget, `${label} target`);
    if (
      installed.device !== expectedSource.device ||
      installed.inode !== expectedSource.inode ||
      existsSync(absoluteSource)
    ) {
      throw new Error(`${label} directory identity changed during rename`);
    }
    return installed;
  }

  removeDirectory(path: string, expected: LockedDirectoryIdentity, label: string): void {
    const absolute = this.#canonicalPath(path);
    this.#relative(absolute, label);
    this.assertDirectory(absolute, expected, label);
    const parent = this.captureDirectory(dirname(absolute), `${label} parent`);
    this.assertDirectory(parent.path, parent, `${label} parent`);
    rmSync(absolute, { recursive: true, force: false });
    this.assertDirectory(parent.path, parent, `${label} parent`);
    if (existsSync(absolute)) throw new Error(`${label} still exists after removal`);
  }

  release(): void {
    if (this.#released) return;
    let releaseError: unknown;
    try {
      this.assertRoot();
      const pathMetadata = lstatSync(this.lockPath);
      if (!this.#lockIdentity || !sameFileIdentity(pathMetadata, this.#lockIdentity)) {
        throw new Error(`${this.#label} lock path changed before release`);
      }
      closeSync(this.#lockDescriptor);
      const afterClose = lstatSync(this.lockPath);
      if (!sameFileIdentity(afterClose, this.#lockIdentity)) {
        throw new Error(`${this.#label} lock path changed during release`);
      }
      unlinkSync(this.lockPath);
    } catch (error) {
      releaseError = error;
      try {
        closeSync(this.#lockDescriptor);
      } catch {
        // The descriptor may already have been closed before a later check failed.
      }
    } finally {
      this.#released = true;
    }
    if (releaseError) throw releaseError;
  }
}
