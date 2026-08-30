import { link, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import * as benchmark from "@/lib/benchmarks";
import {
  STANDARD_SAAS_BENCHMARK_JSON_PATH,
  STANDARD_SAAS_BENCHMARK_MARKDOWN_PATH,
  STANDARD_SAAS_EXECUTION_GATE,
  loadStandardSaasBenchmarkSpec,
  standardSaasBenchmarkExecutionStatus,
  standardSaasBenchmarkSpecSchema,
} from "@/lib/benchmarks";

const roots: string[] = [];
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const CORE_SHA = "c".repeat(40);

function application(index: number) {
  return {
    appId: `standard-saas-${index}`,
    launchContractPath: `fixtures/benchmark/app-${index}/launch-contract.yaml`,
    launchContractSha256: SHA_A,
    dogfoodEvidenceBundlePath: `reports/dogfood/app-${index}/bundle.json`,
    dogfoodEvidenceBundleSha256: SHA_B,
    dogfoodLaunchReceiptSha256: SHA_A,
    dogfoodLocalAcceptanceSha256: SHA_B,
    dogfoodSourceRoots: [`apps/app-${index}`],
    designQualityCriteria: [
      { id: `design.app_${index}`, description: `Application ${index} has a coherent design.` },
    ],
    acceptanceCriteria: [
      {
        id: `acceptance.app_${index}`,
        description: `Application ${index} passes the immutable held-out journey.`,
        evaluatorId: "held_out_web_founder_alpha_v1" as const,
        timeoutMs: 300_000,
      },
    ],
  };
}

function spec(applicationCount = 1) {
  return {
    schemaVersion: 1 as const,
    benchmarkId: "standard-saas-token-benchmark" as const,
    sourceBinding: {
      coreSourceSha: CORE_SHA,
      seedLockSha256: SHA_A,
      heldOutEvaluatorId: "held_out_web_founder_alpha_v1" as const,
      heldOutEvaluatorSha256: SHA_B,
      executionOrder: "venture_harness_first" as const,
      orderSeedSha256: SHA_A,
    },
    attemptPolicy: {
      ledgerPath: "reports/benchmarks/standard-saas-token-attempts.jsonl",
      appendOnly: true as const,
      includeFailedAndAborted: true as const,
      silentModelRetries: 0 as const,
    },
    isolationPolicy: {
      platform: "darwin" as const,
      driver: "macos_sandbox_exec" as const,
      bothPathsAttested: true as const,
      peerReadDenied: true as const,
      coreAndDogfoodReadDenied: true as const,
      unrelatedHomeReadDenied: true as const,
      acceptanceAuthAndNetworkDenied: true as const,
    },
    model: {
      provider: "openai" as const,
      family: "gpt-5",
      version: "2026-08-01",
      id: "gpt-5-2026-08-01",
      cliVersion: "codex-cli-1.2.3",
    },
    maximumCallsPerPath: 2 as const,
    applications: Array.from({ length: applicationCount }, (_, index) => application(index + 1)),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vh-benchmark-validation-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("validation-only standard SaaS benchmark", () => {
  it("accepts exact source-bound specs for one and three applications", () => {
    expect(standardSaasBenchmarkSpecSchema.parse(spec()).applications).toHaveLength(1);
    expect(standardSaasBenchmarkSpecSchema.parse(spec(3)).applications).toHaveLength(3);
  });

  it("rejects the placeholder template and model aliases", async () => {
    const template = JSON.parse(
      await readFile("benchmarks/standard-saas-token-benchmark.template.json", "utf8"),
    );
    expect(() => standardSaasBenchmarkSpecSchema.parse(template)).toThrow();
    expect(() =>
      standardSaasBenchmarkSpecSchema.parse({
        ...spec(),
        model: { ...spec().model, version: "latest", id: "gpt-5-latest" },
      }),
    ).toThrow(/exact|alias/iu);
  });

  it("rejects traversal, credential-like descriptions, duplicate IDs, and commands", () => {
    const base = spec();
    expect(() =>
      standardSaasBenchmarkSpecSchema.parse({
        ...base,
        applications: [{ ...base.applications[0], launchContractPath: "../contract.yaml" }],
      }),
    ).toThrow(/normalized relative path/iu);
    expect(() =>
      standardSaasBenchmarkSpecSchema.parse({
        ...base,
        applications: [
          {
            ...base.applications[0],
            designQualityCriteria: [
              { id: "design.secret", description: "api_key=private-benchmark-canary" },
            ],
          },
        ],
      }),
    ).toThrow(/credential/iu);
    expect(() =>
      standardSaasBenchmarkSpecSchema.parse({
        ...base,
        applications: [base.applications[0], base.applications[0]],
      }),
    ).toThrow(/unique/iu);
    expect(() =>
      standardSaasBenchmarkSpecSchema.parse({
        ...base,
        applications: [
          {
            ...base.applications[0],
            acceptanceCriteria: [
              { ...base.applications[0]!.acceptanceCriteria[0], command: "pnpm test" },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("exports no executor or model host and reports a zero-effect blocked state", () => {
    expect("runStandardSaasBenchmark" in benchmark).toBe(false);
    expect("CodexJsonlBenchmarkHost" in benchmark).toBe(false);
    expect(standardSaasBenchmarkExecutionStatus()).toEqual({
      status: "blocked",
      modelCallsMade: 0,
      artifactsWritten: 0,
      nextAction: STANDARD_SAAS_EXECUTION_GATE,
    });
  });

  it("loads only single-link regular JSON files within their requested parent", async () => {
    const root = await temporaryRoot();
    const path = join(root, "spec.json");
    await writeFile(path, JSON.stringify(spec()), "utf8");
    await expect(loadStandardSaasBenchmarkSpec(path)).resolves.toMatchObject({
      benchmarkId: "standard-saas-token-benchmark",
    });

    const symbolic = join(root, "symbolic.json");
    await symlink(path, symbolic);
    await expect(loadStandardSaasBenchmarkSpec(symbolic)).rejects.toThrow(/single-link regular/iu);

    const hard = join(root, "hard.json");
    await link(path, hard);
    await expect(loadStandardSaasBenchmarkSpec(path)).rejects.toThrow(/single-link regular/iu);
  });

  it("rejects oversized and invalid JSON specs", async () => {
    const root = await temporaryRoot();
    const oversized = join(root, "oversized.json");
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1));
    await expect(loadStandardSaasBenchmarkSpec(oversized)).rejects.toThrow(/1 MiB/iu);
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, "{", "utf8");
    await expect(loadStandardSaasBenchmarkSpec(invalid)).rejects.toThrow(/valid JSON/iu);
  });

  it("the CLI refuses execute with no report artifact", async () => {
    const root = await temporaryRoot();
    const specPath = join(root, "spec.json");
    await writeFile(specPath, JSON.stringify(spec()), "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("scripts/run-standard-saas-token-benchmark.ts"),
        "--spec",
        specPath,
        "--execute",
        "--acknowledge-model-calls",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH } },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(STANDARD_SAAS_EXECUTION_GATE);
    await expect(readFile(join(root, STANDARD_SAAS_BENCHMARK_JSON_PATH))).rejects.toThrow();
    await expect(readFile(join(root, STANDARD_SAAS_BENCHMARK_MARKDOWN_PATH))).rejects.toThrow();
  });
});
