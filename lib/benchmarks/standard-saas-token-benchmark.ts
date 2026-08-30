import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { looksLikeCredentialLabeledText, looksLikeCredentialValue } from "../config/contracts";

export const STANDARD_SAAS_BENCHMARK_JSON_PATH =
  "reports/benchmarks/standard-saas-token-benchmark.json";
export const STANDARD_SAAS_BENCHMARK_MARKDOWN_PATH = "docs/audits/STANDARD_SAAS_TOKEN_BENCHMARK.md";
export const FIRST_CONTROLLED_BENCHMARK_LABEL =
  "First controlled dogfood benchmark. Not yet a universal result.";
export const STANDARD_SAAS_MAX_CALLS_PER_PATH = 2 as const;
export const STANDARD_SAAS_EXECUTION_GATE =
  "Controlled benchmark execution is unavailable until a verified source-bound dogfood bundle, its immutable held-out acceptance digest, a clean Core source SHA, both-path isolation, and append-only attempt accounting are bound into the final reviewed spec. No model call or report artifact was created.";

const SHA256 = /^[a-f0-9]{64}$/u;
const criterionId = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u);
const safeAppId = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u);
const safeRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    if (
      isAbsolute(value) ||
      value.includes("\\") ||
      value.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "benchmark paths must be normalized relative paths without traversal",
      });
    }
  });

const boundedDescription = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .superRefine((value, context) => {
    if (looksLikeCredentialValue(value) || looksLikeCredentialLabeledText(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "benchmark descriptions may not contain credential material",
      });
    }
  });

const designCriterionSchema = z
  .object({ id: criterionId, description: boundedDescription })
  .strict();

const acceptanceCriterionSchema = z
  .object({
    id: criterionId,
    description: boundedDescription,
    evaluatorId: z.literal("held_out_web_founder_alpha_v1"),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 60_000),
  })
  .strict();

const applicationSchema = z
  .object({
    appId: safeAppId,
    launchContractPath: safeRelativePath,
    launchContractSha256: z.string().regex(SHA256),
    dogfoodEvidenceBundlePath: safeRelativePath,
    dogfoodEvidenceBundleSha256: z.string().regex(SHA256),
    dogfoodLaunchReceiptSha256: z.string().regex(SHA256),
    dogfoodLocalAcceptanceSha256: z.string().regex(SHA256),
    dogfoodSourceRoots: z.array(safeRelativePath).min(1).max(20),
    designQualityCriteria: z.array(designCriterionSchema).min(1).max(100),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(100),
  })
  .strict()
  .superRefine((application, context) => {
    const ids = [
      "journey.primary",
      "success.primary",
      ...application.designQualityCriteria.map(({ id }) => id),
      ...application.acceptanceCriteria.map(({ id }) => id),
    ];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["designQualityCriteria"],
        message: "journey, success, design, and acceptance criterion IDs must be unique",
      });
    }
  });

export const standardSaasBenchmarkSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    benchmarkId: z.literal("standard-saas-token-benchmark"),
    sourceBinding: z
      .object({
        coreSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
        seedLockSha256: z.string().regex(SHA256),
        heldOutEvaluatorId: z.literal("held_out_web_founder_alpha_v1"),
        heldOutEvaluatorSha256: z.string().regex(SHA256),
        executionOrder: z.enum(["venture_harness_first", "empty_repository_first"]),
        orderSeedSha256: z.string().regex(SHA256),
      })
      .strict(),
    attemptPolicy: z
      .object({
        ledgerPath: safeRelativePath,
        appendOnly: z.literal(true),
        includeFailedAndAborted: z.literal(true),
        silentModelRetries: z.literal(0),
      })
      .strict(),
    isolationPolicy: z
      .object({
        platform: z.literal("darwin"),
        driver: z.literal("macos_sandbox_exec"),
        bothPathsAttested: z.literal(true),
        peerReadDenied: z.literal(true),
        coreAndDogfoodReadDenied: z.literal(true),
        unrelatedHomeReadDenied: z.literal(true),
        acceptanceAuthAndNetworkDenied: z.literal(true),
      })
      .strict(),
    model: z
      .object({
        provider: z.literal("openai"),
        family: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
        version: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
        id: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u),
        cliVersion: z.string().trim().min(1).max(200),
      })
      .strict(),
    maximumCallsPerPath: z.literal(STANDARD_SAAS_MAX_CALLS_PER_PATH),
    applications: z.array(applicationSchema).min(1).max(20),
  })
  .strict()
  .superRefine((spec, context) => {
    if (/REPLACE_WITH_/u.test(JSON.stringify(spec))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replace every benchmark template placeholder before validation",
      });
    }
    if (/^(?:auto|default|latest)$/iu.test(spec.model.version)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model", "version"],
        message: "model version must be exact, not an alias",
      });
    }
    if (/^(?:auto|default|latest)$/iu.test(spec.model.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model", "id"],
        message: "Codex model ID must be exact, not an alias",
      });
    }
    if (
      !spec.model.id.toLowerCase().includes(spec.model.family.toLowerCase()) ||
      !spec.model.id.toLowerCase().includes(spec.model.version.toLowerCase())
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "exact Codex model ID must contain both family and version",
      });
    }
    if (new Set(spec.applications.map(({ appId }) => appId)).size !== spec.applications.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applications"],
        message: "application IDs must be unique",
      });
    }
    const evaluatorIds = new Set(
      spec.applications.flatMap(({ acceptanceCriteria }) =>
        acceptanceCriteria.map(({ evaluatorId }) => evaluatorId),
      ),
    );
    if (evaluatorIds.size !== 1 || !evaluatorIds.has(spec.sourceBinding.heldOutEvaluatorId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceBinding", "heldOutEvaluatorId"],
        message: "every application must bind to the same held-out evaluator",
      });
    }
  });

export type StandardSaasBenchmarkSpec = z.infer<typeof standardSaasBenchmarkSpecSchema>;

export interface StandardSaasBenchmarkExecutionStatus {
  status: "blocked";
  modelCallsMade: 0;
  artifactsWritten: 0;
  nextAction: string;
}

export function standardSaasBenchmarkExecutionStatus(): StandardSaasBenchmarkExecutionStatus {
  return {
    status: "blocked",
    modelCallsMade: 0,
    artifactsWritten: 0,
    nextAction: STANDARD_SAAS_EXECUTION_GATE,
  };
}

export async function loadStandardSaasBenchmarkSpec(
  requestedPath: string,
): Promise<StandardSaasBenchmarkSpec> {
  const absolutePath = resolve(requestedPath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(
      "Benchmark spec must be a single-link regular file, not a link or special file.",
    );
  }
  if (metadata.size > 1024 * 1024) {
    throw new Error("Benchmark spec exceeds the 1 MiB validation limit.");
  }
  const canonicalPath = await realpath(absolutePath);
  const canonicalParent = await realpath(dirname(absolutePath));
  const child = relative(canonicalParent, canonicalPath);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Benchmark spec did not resolve inside its requested parent directory.");
  }
  const source = await readFile(canonicalPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Benchmark spec must contain valid JSON.");
  }
  return standardSaasBenchmarkSpecSchema.parse(value);
}
