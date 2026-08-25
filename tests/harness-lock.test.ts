import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeManagedTreeDigest, loadHarnessLock } from "@/lib/config/harness-lock";

describe("harness.lock managed manifest", () => {
  it("has a trusted hash for every declared harness/generated file", () => {
    const lock = loadHarnessLock();
    expect(lock.harness_version).toBe("0.2.0");
    if (lock.lock_version !== 1) throw new Error("the Core lock must remain a v1 local lock");
    expect(lock.source).toMatchObject({
      kind: "local",
      ref: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });

    // The lock and the executable must name the same reviewed source commit,
    // so the byte-for-byte rebuild proved in vh-generated-parity covers both.
    const provenance = JSON.parse(readFileSync("bin/vh-build-provenance.json", "utf8")) as {
      coreSourceCommit: string;
    };
    expect(lock.source.ref).toBe(provenance.coreSourceCommit);

    // Provenance is asserted by content, not by ancestry: squash-merging keeps
    // the reviewed tree but discards the reviewed commit from main's history.
    expect(lock.source.tree_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeManagedTreeDigest(lock.managed_files)).toBe(lock.source.tree_digest);

    expect(lock.managed_files.length).toBeGreaterThan(100);
    for (const file of lock.managed_files) {
      expect(existsSync(file.path), file.path).toBe(true);
      const actual = createHash("sha256").update(readFileSync(file.path)).digest("hex");
      expect(actual, file.path).toBe(file.sha256);
    }
  });
});
