/**
 * Prepare a seed's child dependency closure.
 *
 * A materialized venture is deliberately independent: it has its own
 * `package.json` and its own `pnpm-lock.yaml`, and it installs with
 * `--ignore-workspace`. Its dependency closure is therefore *not* the root
 * closure, and a root `pnpm install --frozen-lockfile` never fetches it. Any
 * child install that runs offline then fails on the first package the root does
 * not happen to share — `caniuse-lite` was the one CI hit.
 *
 * This command resolves that closure from the seed's own lockfile and fetches
 * it into the pnpm content-addressable store, so a clean checkout can prepare
 * exactly what a child install needs before any product or provider work runs.
 *
 * It is idempotent: `pnpm fetch` against an already-populated store is a no-op,
 * and the reported lock hash lets CI key a cache that invalidates precisely when
 * the seed's dependency contract changes.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { compileVentureMaterialization, createLaunchGrant } from "../lib/materialization";
import type { LaunchGrantInput, SeedId } from "../lib/materialization";

const SEED_IDS = [
  "agentic-web-saas",
  "agentic-ios-subscription",
  "hybrid-agentic-service",
] as const;

export interface SeedFetchResult {
  readonly seed: SeedId;
  readonly lockfileSha256: string;
  readonly storeDir: string;
  readonly fetched: boolean;
  readonly preparationMode: "online";
  readonly attempts: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * A grant is required to compile a plan, but nothing here is executed against a
 * provider: the plan is used only to read the seed's own dependency files.
 */
function preparationGrant(seed: SeedId): LaunchGrantInput {
  return {
    ownerOrganizationId: "seed-preparation",
    ventureName: "Seed Preparation",
    ventureSlug: "seed-preparation",
    ideaDigest: "0".repeat(64),
    seed: { id: seed, version: "0.2.0" },
    stackProfile: { id: "founder-default", version: "0.2.0" },
    repository: { owner: "seed-preparation", name: "seed-preparation", visibility: "private" },
    providerAccounts: [
      {
        capability: "source.repository.create",
        provider: "github",
        externalAccountId: "seed-preparation",
        ownerOrganizationId: "seed-preparation",
        stackClass: "company",
        ownership: "company_owned",
      },
    ],
    autonomyProfile: "owner_preview",
    allowedExternalEffects: ["repository.create"],
    modelBudget: { maxTokens: 1, maxMinorUnits: 0, currency: "EUR" },
    externalResourceBudget: { maxResources: 1, maxMinorUnits: 0, currency: "EUR" },
    permissions: {
      productionDeployment: false,
      domainConfiguration: false,
      liveCommerceConfiguration: false,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2036-01-01T00:00:00.000Z",
    grantedBy: { actorId: "seed-preparation", actorType: "founder" },
    approvalRef: "approval:seed-dependency-preparation",
    revokedAt: null,
  } as LaunchGrantInput;
}

/** The store the root install actually recorded, so every consumer agrees. */
export function rootStoreDirectory(root: string): string {
  const modules = parse(readFileSync(join(root, "node_modules/.modules.yaml"), "utf8")) as {
    storeDir?: unknown;
  };
  if (typeof modules.storeDir !== "string" || !modules.storeDir) {
    throw new Error(
      "No pnpm store was recorded by the root install. Next: run pnpm install --frozen-lockfile, then rerun pnpm seed:fetch.",
    );
  }
  return modules.storeDir;
}

export function seedDependencyFiles(seed: SeedId): {
  packageManifest: string;
  lockfile: string;
} {
  const plan = compileVentureMaterialization({
    grant: createLaunchGrant(preparationGrant(seed)),
    at: new Date("2026-01-01T00:00:00.000Z"),
    coreVersion: "0.2.0",
    workflowRefSha: "0".repeat(40),
  });
  const find = (path: string): string => {
    const file = plan.files.find((entry) => entry.path === path);
    if (!file) throw new Error(`seed ${seed} does not materialize ${path}`);
    return file.content;
  };
  return { packageManifest: find("package.json"), lockfile: find("pnpm-lock.yaml") };
}

export function fetchSeedDependencies(options: {
  seed: SeedId;
  root: string;
  storeDir?: string;
  maxAttempts?: number;
}): SeedFetchResult {
  const { packageManifest, lockfile } = seedDependencyFiles(options.seed);
  const storeDir = options.storeDir ?? rootStoreDirectory(options.root);
  const lockfileSha256 = sha256(lockfile);
  // `pnpm fetch` reads only the lockfile, so the closure is exactly what the
  // child's frozen install will later resolve — not an approximation of it.
  const workspace = mkdtempSync(join(tmpdir(), `vh-seed-fetch-${options.seed}-`));
  try {
    writeFileSync(join(workspace, "package.json"), packageManifest);
    writeFileSync(join(workspace, "pnpm-lock.yaml"), lockfile);
    const isolatedHome = join(workspace, ".home");
    mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    mkdirSync(storeDir, { recursive: true });
    const maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) {
      throw new Error("Seed dependency preparation maxAttempts must be 1 or 2.");
    }
    let lastFailure = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const fetched = spawnSync("pnpm", ["fetch", "--store-dir", storeDir], {
        cwd: workspace,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
        env: {
          // The child verification contract includes dev tooling (typecheck,
          // build, and journey tests), so preparation must not inherit a
          // production-only dependency filter from the parent environment.
          NODE_ENV: "development",
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          TMP: process.env.TMP,
          TEMP: process.env.TEMP,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          CI: process.env.CI ?? "1",
          SystemRoot: process.env.SystemRoot,
          PATHEXT: process.env.PATHEXT,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          npm_config_userconfig: join(isolatedHome, ".npmrc"),
          NPM_CONFIG_USERCONFIG: join(isolatedHome, ".npmrc"),
          npm_config_update_notifier: "false",
        },
      });
      if (fetched.status === 0 && !fetched.error) {
        return {
          seed: options.seed,
          lockfileSha256,
          storeDir,
          fetched: true,
          preparationMode: "online",
          attempts: attempt,
        };
      }
      lastFailure = [
        `pnpm fetch exited ${fetched.status ?? "on timeout"}`,
        fetched.error?.message,
        fetched.stdout,
        fetched.stderr,
      ]
        .filter(Boolean)
        .join("\n");
    }
    throw new Error(
      `Seed dependency preparation failed for ${options.seed} after ${maxAttempts} bounded attempt(s).\n` +
        `${lastFailure}\n` +
        `Next: run pnpm seed:fetch ${options.seed} with network access, then rerun the child install.`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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
  const results = seeds.map((seed) => fetchSeedDependencies({ seed, root }));
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  for (const result of results) {
    console.log(
      `prepared ${result.seed} child dependency closure (lock ${result.lockfileSha256.slice(0, 12)}) in ${result.storeDir}`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("seed-fetch.ts")) main();
