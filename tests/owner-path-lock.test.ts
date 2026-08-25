import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerPathLock } from "@/lib/security/owner-path-lock";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vh-owner-path-lock-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OwnerPathLock", () => {
  it("holds one private exclusive lock and releases only its exact inode", () => {
    const root = temporaryRoot();
    const first = new OwnerPathLock(root, { label: "fixture operation" });

    expect(lstatSync(first.lockPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first.lockPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      pid: process.pid,
      operation: "fixture operation",
    });
    expect(() => new OwnerPathLock(root, { label: "competing fixture operation" })).toThrow(
      /already locked/,
    );

    first.release();
    expect(existsSync(first.lockPath)).toBe(false);
    const next = new OwnerPathLock(root, { label: "next fixture operation" });
    next.release();
  });

  it("rejects a group-writable operation root", () => {
    const root = temporaryRoot();
    chmodSync(root, 0o770);

    expect(() => new OwnerPathLock(root, { label: "unsafe fixture operation" })).toThrow(
      /must not be writable by group or other users/,
    );
    expect(existsSync(join(root, ".venture-harness-owner.lock"))).toBe(false);
  });

  it("rejects a root whose parent lets another principal rename it", () => {
    const unsafeParent = temporaryRoot();
    const root = join(unsafeParent, "operation-root");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(unsafeParent, 0o770);

    expect(() => new OwnerPathLock(root, { label: "renameable fixture operation" })).toThrow(
      /parent must not permit another OS principal to rename/,
    );
    expect(existsSync(join(root, ".venture-harness-owner.lock"))).toBe(false);
  });

  it("reads only the regular file bound to its no-follow descriptor", () => {
    const root = temporaryRoot();
    const source = join(root, "source.txt");
    const alias = join(root, "alias.txt");
    writeFileSync(source, "descriptor-bound content\n", { mode: 0o600 });
    symlinkSync("source.txt", alias);
    const boundary = new OwnerPathLock(root, { label: "fixture operation" });

    expect(boundary.readRegularFile(source, { label: "fixture source", maxBytes: 1_024 })).toBe(
      "descriptor-bound content\n",
    );
    expect(() => boundary.readRegularFile(alias, { label: "fixture alias" })).toThrow(
      "fixture alias must be a regular non-symlink file",
    );

    boundary.release();
  });
});
