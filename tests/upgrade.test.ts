import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHarnessLock } from "@/lib/config/harness-lock";
import type { MigrationFileSystem } from "@/lib/migrations";
import { applyUpgrade, type HarnessRelease } from "@/lib/upgrade";

class MemoryFileSystem implements MigrationFileSystem {
  readonly files: Map<string, string>;
  readonly writes: string[] = [];
  private failAt: string | null;

  constructor(initial: Record<string, string>, failAt: string | null = null) {
    this.files = new Map(Object.entries(initial));
    this.failAt = failAt;
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    this.writes.push(path);
    if (this.failAt === path) {
      this.failAt = null;
      throw new Error(`synthetic failure at ${path}`);
    }
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const release: HarnessRelease = {
  version: "0.3.0",
  source: { kind: "release", ref: "v0.3.0" },
  files: [
    { path: "managed.txt", ownership: "harness", content: "new managed\n" },
    { path: "generated.txt", ownership: "generated", content: "new generated\n" },
    { path: "project.txt", ownership: "project", content: "template suggestion\n" },
  ],
};

function lock() {
  return createHarnessLock({
    source: { kind: "release", ref: "v0.2.0" },
    managed_files: [
      { path: "managed.txt", ownership: "harness", sha256: hash("old managed\n") },
      { path: "generated.txt", ownership: "generated", sha256: hash("old generated\n") },
      { path: "project.txt", ownership: "project", sha256: hash("founder content\n") },
    ],
  });
}

describe("central harness upgrades", () => {
  it("plans without writes, preserves project files, and applies the lock last", async () => {
    const fs = new MemoryFileSystem({
      "managed.txt": "old managed\n",
      "generated.txt": "old generated\n",
      "project.txt": "founder content\n",
      "harness.lock": "old lock\n",
    });
    const dryRun = await applyUpgrade({
      fileSystem: fs,
      currentLock: lock(),
      release,
      dryRun: true,
    });
    expect(dryRun.status).toBe("planned");
    expect(dryRun.files.find((file) => file.path === "project.txt")?.action).toBe("preserve");
    expect(fs.writes).toEqual([]);

    const applied = await applyUpgrade({ fileSystem: fs, currentLock: lock(), release });
    expect(applied.status).toBe("applied");
    expect(fs.files.get("project.txt")).toBe("founder content\n");
    expect(fs.files.get("managed.txt")).toBe("new managed\n");
    expect(fs.writes.at(-1)).toBe("harness.lock");
  });

  it("blocks when a harness-owned file diverged from its trusted hash", async () => {
    const fs = new MemoryFileSystem({
      "managed.txt": "founder edit\n",
      "generated.txt": "old generated\n",
      "project.txt": "founder content\n",
      "harness.lock": "old lock\n",
    });
    const report = await applyUpgrade({ fileSystem: fs, currentLock: lock(), release });
    expect(report.status).toBe("blocked");
    expect(report.error?.code).toBe("managed_file_conflict");
    expect(report.error?.nextAction).toContain("project-owned");
    expect(fs.writes).toEqual([]);
  });

  it("rolls back managed writes when the lock update fails", async () => {
    const initial = {
      "managed.txt": "old managed\n",
      "generated.txt": "old generated\n",
      "project.txt": "founder content\n",
      "harness.lock": "old lock\n",
    };
    const fs = new MemoryFileSystem(initial, "harness.lock");
    const report = await applyUpgrade({ fileSystem: fs, currentLock: lock(), release });
    expect(report).toMatchObject({ status: "failed", rolledBack: true, lockUpdated: false });
    expect(Object.fromEntries(fs.files)).toEqual(initial);
  });
});
