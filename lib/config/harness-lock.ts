import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { extensionsSchema, semverSchema, uniqueArray } from "./contracts";

export const managedFileOwnershipSchema = z.enum([
  "harness",
  "project",
  "generated",
  "core_owned",
  "merge_managed",
  "venture_owned",
]);

const managedFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
        message: "managed file paths must be repository-relative",
      }),
    ownership: managedFileOwnershipSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    base_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
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

const legacyHarnessLockSchema = z
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

const versionedComponentSchema = z
  .record(z.string().min(1), semverSchema)
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one versioned component is required",
  });

const ventureHarnessLockSchema = z
  .object({
    lock_version: z.literal(2),
    harness_version: semverSchema,
    core_version: semverSchema,
    config_contract_version: z.number().int().positive(),
    source: z
      .object({
        kind: z.enum(["seed", "release", "local"]),
        ref: z.string().min(1),
      })
      .strict(),
    seed: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]+$/),
        version: semverSchema,
      })
      .strict(),
    runtime_packages: versionedComponentSchema,
    provider_adapters: z.record(z.string().min(1), semverSchema),
    generators: versionedComponentSchema,
    managed_files: uniqueArray(managedFileSchema),
    applied_migrations: uniqueArray(appliedMigrationSchema),
    migration_state: z.array(z.string().min(1)),
    update_channel: z.enum(["stable", "candidate", "canary"]),
    workflow_ref_sha: z.string().regex(/^[a-f0-9]{40}$/),
    last_verified_upgrade: z.string().datetime({ offset: true }).nullable(),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((lock, context) => {
    if (lock.harness_version !== lock.core_version) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["core_version"],
        message: "core_version must equal harness_version",
      });
    }
    for (const [index, file] of lock.managed_files.entries()) {
      if (["harness", "project", "generated"].includes(file.ownership)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["managed_files", index, "ownership"],
          message: "v2 locks require core_owned, merge_managed, or venture_owned",
        });
      }
    }
  });

export const harnessLockSchema = z.union([legacyHarnessLockSchema, ventureHarnessLockSchema]);

export type HarnessLock = z.infer<typeof harnessLockSchema>;

/** Config files whose content is owned by the central harness, not a venture. */
export const HARNESS_FRAMEWORK_CONFIG_PATH = "config/framework.yaml";
export const HARNESS_OWNED_CONFIG_PATHS = [
  HARNESS_FRAMEWORK_CONFIG_PATH,
  "config/quality.yaml",
] as const;

export function createManagedFileLockEntry(options: {
  path: string;
  ownership: z.infer<typeof managedFileOwnershipSchema>;
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
  overrides: Partial<z.input<typeof legacyHarnessLockSchema>> = {},
): z.infer<typeof legacyHarnessLockSchema> {
  return legacyHarnessLockSchema.parse({
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

export function createVentureHarnessLock(
  input: Omit<z.input<typeof ventureHarnessLockSchema>, "lock_version">,
): z.infer<typeof ventureHarnessLockSchema> {
  return ventureHarnessLockSchema.parse({ lock_version: 2, ...input });
}
