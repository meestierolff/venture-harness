import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { extensionsSchema, semverSchema, uniqueArray } from "./contracts";

const managedFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
        message: "managed file paths must be repository-relative",
      }),
    ownership: z.enum(["harness", "project", "generated"]),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

const appliedMigrationSchema = z
  .object({
    id: z.string().regex(/^\d{3}-[a-z0-9-]+$/),
    from_version: semverSchema,
    to_version: semverSchema,
    applied_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const harnessLockSchema = z
  .object({
    lock_version: z.literal(1),
    harness_version: semverSchema,
    config_contract_version: z.number().int().positive(),
    source: z
      .object({
        kind: z.enum(["template", "release", "local"]),
        ref: z.string().min(1).nullable(),
      })
      .strict(),
    managed_files: uniqueArray(managedFileSchema),
    applied_migrations: uniqueArray(appliedMigrationSchema),
    extensions: extensionsSchema,
  })
  .strict();

export type HarnessLock = z.infer<typeof harnessLockSchema>;

/** Config files whose content is owned by the central harness, not a venture. */
export const HARNESS_FRAMEWORK_CONFIG_PATH = "config/framework.yaml";
export const HARNESS_OWNED_CONFIG_PATHS = [
  HARNESS_FRAMEWORK_CONFIG_PATH,
  "config/quality.yaml",
] as const;

export function createManagedFileLockEntry(options: {
  path: string;
  ownership: "harness" | "project" | "generated";
  content: string;
}): HarnessLock["managed_files"][number] {
  return managedFileSchema.parse({
    path: options.path,
    ownership: options.ownership,
    sha256: createHash("sha256").update(options.content).digest("hex"),
  });
}

export function parseHarnessLock(text: string): HarnessLock {
  return harnessLockSchema.parse(parse(text));
}

export function loadHarnessLock(path = "harness.lock"): HarnessLock {
  return parseHarnessLock(readFileSync(resolve(path), "utf8"));
}

export function createHarnessLock(
  overrides: Partial<z.input<typeof harnessLockSchema>> = {},
): HarnessLock {
  return harnessLockSchema.parse({
    lock_version: 1,
    harness_version: "0.2.0",
    config_contract_version: 2,
    source: { kind: "template", ref: null },
    managed_files: [],
    applied_migrations: [],
    extensions: {},
    ...overrides,
  });
}
