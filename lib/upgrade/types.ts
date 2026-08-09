import { z } from "zod";
import type { HarnessLock } from "../config/harness-lock";
import type { MigrationFileSystem } from "../migrations";

export const upgradeOwnershipSchema = z.enum([
  "harness",
  "project",
  "generated",
  "core_owned",
  "merge_managed",
  "venture_owned",
]);
export type UpgradeOwnership = z.infer<typeof upgradeOwnershipSchema>;

const relativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "upgrade paths must be repository-relative",
  });

export const managedReleaseFileSchema = z
  .object({
    path: relativePathSchema,
    ownership: upgradeOwnershipSchema,
    content: z.string(),
    baseContent: z.string().optional(),
  })
  .strict();

export const harnessReleaseSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    configContractVersion: z.number().int().positive().optional(),
    source: z
      .object({
        kind: z.enum(["template", "release", "local"]),
        ref: z.string().min(1).nullable(),
      })
      .strict(),
    files: z.array(managedReleaseFileSchema),
  })
  .strict()
  .superRefine((release, context) => {
    const seen = new Set<string>();
    for (const [index, file] of release.files.entries()) {
      if (seen.has(file.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: `duplicate managed path: ${file.path}`,
        });
      }
      seen.add(file.path);
    }
  });

export type HarnessRelease = z.infer<typeof harnessReleaseSchema>;

export interface UpgradeFilePlan {
  path: string;
  ownership: UpgradeOwnership;
  action: "create" | "update" | "merge" | "unchanged" | "preserve" | "conflict";
  reason: string;
  previousHash: string | null;
  currentHash: string | null;
  nextHash: string;
  resultHash: string;
  resultContent?: string;
}

export interface UpgradePlan {
  fromVersion: string;
  toVersion: string;
  release: HarnessRelease;
  files: UpgradeFilePlan[];
  conflicts: UpgradeFilePlan[];
  nextLock: HarnessLock;
}

export interface UpgradeReport {
  status: "planned" | "applied" | "already_current" | "blocked" | "failed";
  dryRun: boolean;
  fromVersion: string;
  toVersion: string;
  files: UpgradeFilePlan[];
  conflicts: UpgradeFilePlan[];
  lockUpdated: boolean;
  rolledBack: boolean;
  error: null | { code: string; message: string; nextAction: string };
}

export interface UpgradeVerificationStep {
  id: string;
  command: string;
  args: readonly string[];
}

export interface UpgradeVerificationResult {
  id: string;
  command: string;
  args: string[];
  status: "planned" | "passed" | "failed" | "not_run";
  exitCode: number | null;
}

export interface UpgradeOptions {
  fileSystem: MigrationFileSystem;
  currentLock: HarnessLock;
  release: HarnessRelease;
  dryRun?: boolean;
}
