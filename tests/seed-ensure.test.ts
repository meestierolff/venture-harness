import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSeedDependencies,
  seedClosureMarkerPath,
  type SeedEnsureResult,
} from "../scripts/seed-ensure";
import type { SeedFetchResult } from "../scripts/seed-fetch";

const temporaryDirectories: string[] = [];

function storeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-seed-ensure-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Records invocations so a reused closure can be proven to stay offline. */
function fetchSpy(storeDir: string) {
  const calls: string[] = [];
  const fetch = (input: { seed: string; root: string; storeDir: string }): SeedFetchResult => {
    calls.push(input.seed);
    return {
      seed: input.seed as SeedFetchResult["seed"],
      lockfileSha256: "f".repeat(64),
      storeDir,
      fetched: true,
      preparationMode: "online",
      attempts: 1,
    };
  };
  return { calls, fetch };
}

function ensure(storeDir: string, fetch: ReturnType<typeof fetchSpy>["fetch"]): SeedEnsureResult {
  return ensureSeedDependencies({
    seed: "agentic-web-saas",
    root: process.cwd(),
    storeDir,
    fetch,
  });
}

describe("seed closure preparation", () => {
  it("prepares an unprepared closure once and reuses it without fetching again", () => {
    const storeDir = storeDirectory();
    const spy = fetchSpy(storeDir);

    const first = ensure(storeDir, spy.fetch);
    expect(first.prepared).toBe(true);
    expect(spy.calls).toEqual(["agentic-web-saas"]);
    expect(existsSync(first.markerPath)).toBe(true);
    expect(JSON.parse(readFileSync(first.markerPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      seed: "agentic-web-saas",
      preparationMode: "online",
    });

    // A warm checkout must stay offline: the second call may not fetch.
    const second = ensure(storeDir, spy.fetch);
    expect(second.prepared).toBe(false);
    expect(second.markerPath).toBe(first.markerPath);
    expect(spy.calls).toEqual(["agentic-web-saas"]);
  });

  it("re-prepares after the store is discarded rather than trusting a stale receipt", () => {
    const storeDir = storeDirectory();
    const spy = fetchSpy(storeDir);

    const first = ensure(storeDir, spy.fetch);
    expect(first.prepared).toBe(true);

    // The packages live in the store, so losing the store must lose the claim.
    rmSync(storeDir, { recursive: true, force: true });

    const afterPrune = ensure(storeDir, spy.fetch);
    expect(afterPrune.prepared).toBe(true);
    expect(spy.calls).toEqual(["agentic-web-saas", "agentic-web-saas"]);
  });

  it("keys the marker on the seed lock hash so a changed contract re-prepares", () => {
    const storeDir = storeDirectory();
    const current = seedClosureMarkerPath(storeDir, "agentic-web-saas", "a".repeat(64));
    const changed = seedClosureMarkerPath(storeDir, "agentic-web-saas", "b".repeat(64));

    expect(current).not.toBe(changed);
    expect(current.startsWith(storeDir)).toBe(true);
  });
});
