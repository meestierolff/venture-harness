import { z } from "zod";
import { artifactReferenceSchema, rejectCredentialMaterial } from "../config/contracts";

export const mobileScaffoldStackSchema = z.enum(["expo_react_native", "swiftui"]);

const boundedPlainText = (label: string, maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), `${label} must not have surrounding whitespace`)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), `${label} must not contain controls`);

export const mobileBundleIdentifierSchema = z
  .string()
  .min(3)
  .max(155)
  .regex(
    /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/,
    "expected a reverse-domain bundle identifier",
  );

export const mobileAppSchemeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9+.-]*$/, "expected a lowercase application URL scheme");

export const mobileScaffoldDirectorySchema = artifactReferenceSchema
  .refine(
    (value) => /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value),
    "scaffold directory must contain only safe repository path segments",
  )
  .refine((value) => value !== ".", "scaffold directory cannot be the repository root");

export const mobileScaffoldRequestSchema = z
  .object({
    stack: mobileScaffoldStackSchema,
    ventureId: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z][a-z0-9-]*$/),
    displayName: boundedPlainText("display name", 80),
    bundleIdentifier: mobileBundleIdentifierSchema.nullable().optional(),
    appScheme: mobileAppSchemeSchema.nullable().optional(),
    outputDirectory: mobileScaffoldDirectorySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => rejectCredentialMaterial(value, context));

export const mobileScaffoldFileSchema = z
  .object({
    path: artifactReferenceSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const mobileScaffoldManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generator: z.literal("venture-harness/mobile-scaffold"),
    templateVersion: z.literal("1.0.0"),
    stack: mobileScaffoldStackSchema,
    ventureId: z.string().min(1),
    displayName: z.string().min(1),
    outputDirectory: mobileScaffoldDirectorySchema,
    identity: z
      .object({
        bundleIdentifier: mobileBundleIdentifierSchema,
        bundleIdentifierState: z.enum(["configured", "local_placeholder"]),
        appScheme: mobileAppSchemeSchema,
        appSchemeState: z.enum(["configured", "derived"]),
      })
      .strict(),
    files: z.array(mobileScaffoldFileSchema),
    safeguards: z
      .object({
        noOverwrite: z.literal(true),
        credentialsPersisted: z.literal(false),
        signingMaterialPersisted: z.literal(false),
        submissionConfigured: z.literal(false),
      })
      .strict(),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export const mobileScaffoldResultSchema = z
  .object({
    manifest: mobileScaffoldManifestSchema,
    manifestPath: artifactReferenceSchema,
    createdFiles: z.array(artifactReferenceSchema),
    unchangedFiles: z.array(artifactReferenceSchema),
  })
  .strict();

export type MobileScaffoldStack = z.infer<typeof mobileScaffoldStackSchema>;
export type MobileScaffoldRequest = z.input<typeof mobileScaffoldRequestSchema>;
export type ParsedMobileScaffoldRequest = z.output<typeof mobileScaffoldRequestSchema>;
export type MobileScaffoldFile = z.infer<typeof mobileScaffoldFileSchema>;
export type MobileScaffoldManifest = z.infer<typeof mobileScaffoldManifestSchema>;
export type MobileScaffoldResult = z.infer<typeof mobileScaffoldResultSchema>;

export class MobileScaffoldError extends Error {
  constructor(
    readonly code: "unsafe_path" | "output_conflict" | "io_failure",
    message: string,
  ) {
    super(message);
    this.name = "MobileScaffoldError";
  }
}
