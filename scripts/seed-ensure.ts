/**
 * Ensure a seed's child dependency closure is present before verification.
 *
 * Preparation (`pnpm seed:fetch`) is deliberately online and the child install
 * in `runDependencyInstall` is deliberately offline. A clean checkout that ran
 * only `pnpm install --frozen-lockfile` therefore fails its first child install
 * with ERR_PNPM_NO_OFFLINE_TARBALL, because the child's closure is not the root
 * closure and no root install ever fetches it.
 *
 * This command closes that gap without weakening the boundary: it fetches only
 * when the closure has not already been prepared, so a warm checkout stays
 * entirely offline. The marker recording that preparation lives inside the pnpm
 * store itself, so discarding or relocating the store discards the claim with
 * it — a pruned store re-prepares instead of trusting a stale receipt.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  fetchSeedDependencies,
  rootStoreDirectory,
  seedDependencyFiles,
  SEED_IDS,
  type SeedFetchResult,
} from "./seed-fetch";
import type { SeedId } from "../lib/materialization";

/** Namespaced inside the store so pnpm's own layout is never shadowed. */
const MARKER_DIRECTORY = ".venture-harness-seed-closures";
const MARKER_SCHEMA_VERSION = 1;

export interface SeedEnsureResult {
  readonly seed: SeedId;
  readonly lockfileSha256: string;
  readonly storeDir: string;
  /** True when this call performed the online fetch rather than reusing it. */
  readonly prepared: boolean;
  readonly markerPath: string;
}

export function seedClosureMarkerPath(
  storeDir: string,
  seed: SeedId,
  lockfileSha256: string,
): string {
  return join(storeDir, MARKER_DIRECTORY, `${seed}-${lockfileSha256.slice(0, 16)}.json`);
}

export function ensureSeedDependencies(options: {
  seed: SeedId;
  root: string;
  storeDir?: string;
  /** Deterministic seam; the default performs the real online fetch. */
  fetch?: (input: { seed: SeedId; root: string; storeDir: string }) => SeedFetchResult;
}): SeedEnsureResult {
  const { lockfile } = seedDependencyFiles(options.seed);
  const lockfileSha256 = createHash("sha256").update(lockfile).digest("hex");
  const storeDir = options.storeDir ?? rootStoreDirectory(options.root);
  const markerPath = seedClosureMarkerPath(storeDir, options.seed, lockfileSha256);

  // The lock hash is part of the marker name, so a changed seed dependency
  // contract misses the marker and re-prepares rather than silently reusing a
  // closure that no longer matches the child's frozen lockfile.
  if (existsSync(markerPath)) {
    return { seed: options.seed, lockfileSha256, storeDir, prepared: false, markerPath };
  }

  const fetched = (options.fetch ?? fetchSeedDependencies)({
    seed: options.seed,
    root: options.root,
    storeDir,
  });
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        schemaVersion: MARKER_SCHEMA_VERSION,
        seed: options.seed,
        lockfileSha256: fetched.lockfileSha256,
        preparationMode: fetched.preparationMode,
        attempts: fetched.attempts,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { seed: options.seed, lockfileSha256, storeDir, prepared: true, markerPath };
}

function main(): void {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const json = args.includes("--json");
  const requested = args.filter((value) => !value.startsWith("--"));
  const seeds = (requested.length > 0 ? requested : ["agentic-web-saas"]) as SeedId[];
  for (const seed of seeds) {
    if (!(SEED_IDS as readonly string[]).includes(seed)) {
      console.error(`Unknown seed ${seed}. Known seeds: ${SEED_IDS.join(", ")}.`);
      process.exit(2);
    }
  }
  const root = process.cwd();
  const results = seeds.map((seed) => ensureSeedDependencies({ seed, root }));
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  for (const result of results) {
    console.log(
      result.prepared
        ? `prepared ${result.seed} child dependency closure (lock ${result.lockfileSha256.slice(0, 12)}) in ${result.storeDir}`
        : `reused prepared ${result.seed} child dependency closure (lock ${result.lockfileSha256.slice(0, 12)})`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("seed-ensure.ts")) main();
