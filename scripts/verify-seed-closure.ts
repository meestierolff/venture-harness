/**
 * Prove the ordinary web seed on a clean-runner-shaped dependency store.
 *
 * Preparation is explicitly online. Verification is explicitly offline and
 * repeated in two separately materialized child repositories. No model or
 * provider operation is reachable from this script.
 */
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  compileVentureMaterialization,
  createLaunchGrant,
  materializeVenture,
  NodeMaterializationFileSystem,
  type LaunchGrantInput,
} from "../lib/materialization";
import { productCommandEnvironment } from "../lib/runtime";
import { fetchSeedDependencies } from "./seed-fetch";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const COMMAND_TIMEOUT_MS = 300_000;
const LOCAL_REPORT_PATH = ".venture/reports/quality/seed-closure-latest.json";
const AUDITED_REPORT_PATH = "reports/audit/seed-closure.json";

interface CommandEvidence {
  readonly command: string;
  readonly status: "passed";
  readonly elapsedMs: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function grantInput(index: number): LaunchGrantInput {
  const slug = `seed-closure-${index}`;
  return {
    ownerOrganizationId: "seed-closure-fixture",
    ventureName: `Seed Closure ${index}`,
    ventureSlug: slug,
    ideaDigest: sha256(slug),
    seed: { id: "agentic-web-saas", version: "0.2.0" },
    stackProfile: { id: "founder-default", version: "0.2.0" },
    repository: { owner: "seed-closure-fixture", name: slug, visibility: "private" },
    providerAccounts: [
      {
        capability: "source.repository.create",
        provider: "github",
        externalAccountId: "seed-closure-fixture",
        ownerOrganizationId: "seed-closure-fixture",
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
    createdAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-10T12:00:00.000Z",
    grantedBy: { actorId: "seed-closure-fixture", actorType: "founder" },
    approvalRef: `fixture:${slug}`,
    revokedAt: null,
  };
}

function commandEnvironment(
  cwd: string,
  storeDir: string,
  extra: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const isolatedHome = join(cwd, ".venture", "quality-command-home");
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  return {
    ...productCommandEnvironment(process.env, isolatedHome),
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    npm_config_update_notifier: "false",
    npm_config_offline: "true",
    npm_config_store_dir: storeDir,
    ...extra,
    NODE_ENV: extra.NODE_ENV ?? process.env.NODE_ENV ?? "production",
  };
}

function runPnpm(
  args: readonly string[],
  cwd: string,
  storeDir: string,
  extraEnvironment: Partial<NodeJS.ProcessEnv> = {},
): CommandEvidence {
  const started = Date.now();
  const result = spawnSync("pnpm", [...args], {
    cwd,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: commandEnvironment(cwd, storeDir, extraEnvironment),
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      [
        `pnpm ${args.join(" ")} failed in the clean child`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/broken[- ]bin|no binaries found|failed to create bin/i.test(output)) {
    throw new Error(`Clean child install emitted an unexplained binary warning:\n${output}`);
  }
  return {
    command: `pnpm ${args.join(" ")}`,
    status: "passed",
    elapsedMs: Date.now() - started,
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a seed-closure browser port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function stopServer(server: ReturnType<typeof spawn>): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const forceTimer = setTimeout(() => {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    }, 5_000);
    const finish = () => {
      clearTimeout(forceTimer);
      resolveStop();
    };
    server.once("exit", finish);
    if (server.exitCode !== null || server.signalCode !== null) {
      finish();
      return;
    }
    server.kill("SIGTERM");
  });
}

async function runPrimaryJourney(
  childRoot: string,
  storeDir: string,
  iteration: number,
  browserDirectory: string,
): Promise<CommandEvidence> {
  const expectedPublicOrigin = `https://seed-closure-${iteration}.example.invalid`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await reservePort();
    const localOrigin = `http://127.0.0.1:${port}`;
    const serverNonce = randomBytes(24).toString("hex");
    const productionEnvironment = {
      NEXT_PUBLIC_SITE_URL: expectedPublicOrigin,
      NEXT_PUBLIC_INDEXING_ENABLED: "true",
      VERCEL: "1",
      VERCEL_ENV: "production",
      PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
      VH_LOCAL_SERVER_NONCE: serverNonce,
    };
    let output = "";
    const appendOutput = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-20_000);
    };
    const server = spawn(
      process.execPath,
      [
        join(childRoot, "node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: childRoot,
        env: commandEnvironment(childRoot, storeDir, productionEnvironment),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout?.on("data", appendOutput);
    server.stderr?.on("data", appendOutput);
    let journeyEvidence: CommandEvidence | undefined;

    try {
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (server.exitCode !== null || server.signalCode !== null) {
          throw new Error(`Seed-closure production server exited before readiness:\n${output}`);
        }
        try {
          const response = await fetch(`${localOrigin}/api/health`, {
            redirect: "manual",
            signal: AbortSignal.timeout(2_000),
          });
          const health = response.ok
            ? ((await response.json().catch(() => null)) as {
                localServerNonce?: unknown;
              } | null)
            : null;
          if (health?.localServerNonce === serverNonce) {
            ready = true;
            break;
          }
        } catch {
          // The intended server is still starting; retry within the explicit deadline.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      if (!ready) {
        throw new Error(`Seed-closure production server did not become ready:\n${output}`);
      }
      journeyEvidence = runPnpm(
        ["exec", "playwright", "test", "tests/e2e/post-deploy-readonly.spec.ts", "--retries=0"],
        childRoot,
        storeDir,
        {
          ...productionEnvironment,
          PLAYWRIGHT_BASE_URL: localOrigin,
          EXPECTED_PUBLIC_ORIGIN: expectedPublicOrigin,
        },
      );
    } catch (error) {
      lastError = error;
    } finally {
      await stopServer(server);
    }

    try {
      const response = await fetch(`${localOrigin}/api/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      const health = response.ok
        ? ((await response.json().catch(() => null)) as { localServerNonce?: unknown } | null)
        : null;
      if (health?.localServerNonce === serverNonce) {
        throw new Error("Seed-closure production server still owns its port after teardown");
      }
    } catch (error) {
      if (error instanceof Error && /still owns its port/u.test(error.message)) throw error;
    }
    if (journeyEvidence) return journeyEvidence;
    if (!/EADDRINUSE|address already in use/iu.test(output) || attempt === 3) throw lastError;
  }
  throw lastError;
}

function writeReport(root: string, report: unknown): void {
  const requested = process.env.VH_SEED_CLOSURE_REPORT?.trim() || LOCAL_REPORT_PATH;
  if (requested !== LOCAL_REPORT_PATH && requested !== AUDITED_REPORT_PATH) {
    throw new Error(
      `VH_SEED_CLOSURE_REPORT must be ${LOCAL_REPORT_PATH} or ${AUDITED_REPORT_PATH}`,
    );
  }
  const target = resolve(root, requested);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.next-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), "vh-seed-closure-"));
  const storeDir = join(workspace, "empty-pnpm-store");
  const browserDirectory = join(workspace, "playwright-browsers");
  const startedAt = Date.now();
  try {
    const preparation = fetchSeedDependencies({
      seed: "agentic-web-saas",
      root,
      storeDir,
      maxAttempts: 2,
    });
    const browserPreparation = runPnpm(
      ["exec", "playwright", "install", "chromium"],
      root,
      preparation.storeDir,
      {
        NODE_ENV: "development",
        PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
        npm_config_offline: "false",
      },
    );
    const children: Array<{
      iteration: number;
      lockfileSha256: string;
      parentWorkspaceIsolated: boolean;
      commands: CommandEvidence[];
    }> = [];

    for (const iteration of [1, 2] as const) {
      const childRoot = join(workspace, `child-${iteration}`);
      const plan = compileVentureMaterialization({
        grant: createLaunchGrant(grantInput(iteration)),
        at: NOW,
        coreVersion: "0.2.0",
        workflowRefSha: "0".repeat(40),
        workflowRepository: "venture-harness/venture-harness",
      });
      await materializeVenture(plan, new NodeMaterializationFileSystem(childRoot), NOW);
      const lockfile = readFileSync(join(childRoot, "pnpm-lock.yaml"));
      const lockfileSha256 = sha256(lockfile);
      if (lockfileSha256 !== preparation.lockfileSha256) {
        throw new Error(
          `Materialized lock ${lockfileSha256} does not match prepared seed lock ${preparation.lockfileSha256}.`,
        );
      }
      const productionEnvironment = {
        NEXT_PUBLIC_SITE_URL: `https://seed-closure-${iteration}.example.invalid`,
        NEXT_PUBLIC_INDEXING_ENABLED: "true",
        VERCEL: "1",
        VERCEL_ENV: "production",
        PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
      };
      const commands = [
        runPnpm(
          [
            "install",
            "--frozen-lockfile",
            "--ignore-workspace",
            "--ignore-scripts",
            "--prod=false",
            "--offline",
            "--store-dir",
            storeDir,
          ],
          childRoot,
          storeDir,
        ),
        runPnpm(["typecheck"], childRoot, storeDir),
        runPnpm(["build"], childRoot, storeDir, productionEnvironment),
        await runPrimaryJourney(childRoot, storeDir, iteration, browserDirectory),
        runPnpm(["test"], childRoot, storeDir),
      ];
      children.push({ iteration, lockfileSha256, parentWorkspaceIsolated: true, commands });
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: "passed",
      seed: preparation.seed,
      lockfileSha256: preparation.lockfileSha256,
      preparation: {
        mode: preparation.preparationMode,
        freshEmptyStore: true,
        attempts: preparation.attempts,
        maxAttempts: 2,
        chromium: browserPreparation,
      },
      verification: {
        mode: "offline",
        frozenLockfile: true,
        lifecycleScriptsDisabled: true,
        parentWorkspaceIsolated: true,
        repetitions: children.length,
        productionBuild: true,
        primaryJourney: "playwright chromium against a local production server",
        playwrightRetries: 0,
      },
      children,
      modelCalls: 0,
      providerCalls: 0,
      elapsedMs: Date.now() - startedAt,
    };
    writeReport(root, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
