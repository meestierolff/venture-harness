import { createHash } from "node:crypto";
import { z } from "zod";
import { harnessReleaseSchema, managedReleaseFileSchema, type HarnessRelease } from "../upgrade";
import type { CoreReleaseManifest } from "./types";

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const releaseBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    version: semver,
    sourceRef: z.string().regex(/^v\d+\.\d+\.\d+$/),
    workflowRefSha: z.string().regex(/^[a-f0-9]{40}$/),
    changedPackages: z.record(z.string().min(1), z.object({ from: semver, to: semver }).strict()),
    affectedCapabilities: z.array(z.string().min(1)),
    migrations: z.array(z.string().regex(/^\d{3}-[a-z0-9-]+$/)),
    compatibility: z
      .object({ minimumCoreVersion: semver, seedIds: z.array(z.string().min(1)).min(1) })
      .strict(),
    requiredChecks: z.array(z.string().min(1)).min(1),
    rolloutRisk: z.enum(["low", "medium", "high"]),
    rollback: z
      .object({
        mode: z.enum(["previous_release", "forward_fix"]),
        version: semver.nullable(),
      })
      .strict(),
    files: z.array(managedReleaseFileSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceRef !== `v${value.version}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRef"],
        message: "release sourceRef must be the exact version tag",
      });
    }
    if (Object.keys(value.changedPackages).length === 0 && value.files.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "release must change at least one package or managed file",
      });
    }
    if (value.rollback.mode === "previous_release") {
      if (value.rollback.version === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rollback", "version"],
          message: "previous_release rollback requires an exact prior version",
        });
      } else {
        const target = value.version.split(".").map(Number);
        const rollback = value.rollback.version.split(".").map(Number);
        const comparison = rollback.findIndex((part, index) => part !== target[index]);
        if (comparison === -1 || (rollback[comparison] ?? 0) > (target[comparison] ?? 0)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["rollback", "version"],
            message: "previous_release rollback version must be older than the target release",
          });
        }
      }
    }
    if (value.rollback.mode === "forward_fix" && value.rollback.version !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollback", "version"],
        message: "forward_fix rollback cannot declare a replacement version",
      });
    }
  });

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type CoreReleaseInput = z.input<typeof releaseBodySchema>;

export function createCoreReleaseManifest(input: CoreReleaseInput): CoreReleaseManifest {
  const body = releaseBodySchema.parse(input);
  const digest = createHash("sha256").update(stable(body)).digest("hex");
  return Object.freeze({ ...body, digest }) as CoreReleaseManifest;
}

export function asHarnessRelease(release: CoreReleaseManifest): HarnessRelease {
  return harnessReleaseSchema.parse({
    version: release.version,
    configContractVersion: 2,
    source: { kind: "release", ref: release.sourceRef },
    files: release.files,
  });
}
