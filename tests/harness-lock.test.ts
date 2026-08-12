import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadHarnessLock } from "@/lib/config/harness-lock";

describe("harness.lock managed manifest", () => {
  it("has a trusted hash for every declared harness/generated file", () => {
    const lock = loadHarnessLock();
    expect(lock.harness_version).toBe("0.2.0");
    expect(lock.source).toMatchObject({
      kind: "local",
      ref: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
    if (!lock.source.ref) throw new Error("founder-alpha lock source SHA is missing");
    expect(() =>
      execFileSync("git", ["merge-base", "--is-ancestor", lock.source.ref!, "HEAD"], {
        stdio: "ignore",
      }),
    ).not.toThrow();
    expect(lock.managed_files.length).toBeGreaterThan(100);
    for (const file of lock.managed_files) {
      expect(existsSync(file.path), file.path).toBe(true);
      const actual = createHash("sha256").update(readFileSync(file.path)).digest("hex");
      expect(actual, file.path).toBe(file.sha256);
    }
  });
});
