import { z } from "zod";
import {
  artifactReferenceSchema,
  credentialReferenceSchema,
  extensionsSchema,
  mobileStackSchema,
  rejectCredentialMaterial,
  uniqueArray,
} from "./contracts";

export const mobileSchema = z
  .object({
    contract_version: z.literal(1),
    mobile: z
      .object({
        stack: mobileStackSchema,
        rationale: z.string().min(1),
        bundle_identifier: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9.-]+$/)
          .nullable(),
        app_scheme: z
          .string()
          .regex(/^[a-z][a-z0-9+.-]*$/)
          .nullable(),
        app_store_connect: z
          .object({
            team_id: z.string().min(1).nullable(),
            app_id: z.string().min(1).nullable(),
            sku: z.string().min(1).nullable(),
            primary_language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
            credential_ref: credentialReferenceSchema.nullable(),
            first_app_record: z
              .object({
                state: z.enum(["not_required", "required", "waiting", "complete"]),
                manual_action_ref: artifactReferenceSchema.nullable(),
              })
              .strict(),
          })
          .strict(),
        eas: z
          .object({
            project_id: z.string().min(1).nullable(),
            credential_ref: credentialReferenceSchema.nullable(),
            build_profiles: uniqueArray(z.enum(["development", "preview", "production"])),
            submit_enabled: z.boolean(),
          })
          .strict(),
        signing: z
          .object({
            credential_ref: credentialReferenceSchema.nullable(),
            certificates_in_git_forbidden: z.literal(true),
          })
          .strict(),
        metadata_artifact_ref: artifactReferenceSchema.nullable(),
        screenshot_flow_artifact_ref: artifactReferenceSchema.nullable(),
        extensions: extensionsSchema,
      })
      .strict(),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    rejectCredentialMaterial(value, ctx);
    const firstRecord = value.mobile.app_store_connect.first_app_record;
    if (
      (firstRecord.state === "required" || firstRecord.state === "waiting") &&
      !firstRecord.manual_action_ref
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mobile", "app_store_connect", "first_app_record", "manual_action_ref"],
        message: `${firstRecord.state} first app record requires a manual_action_ref`,
      });
    }
    if (value.mobile.stack === "none" && firstRecord.state !== "not_required") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mobile", "app_store_connect", "first_app_record", "state"],
        message: "a venture without a mobile rail cannot require an App Store record",
      });
    }
  });

export function createDefaultMobileConfig() {
  return mobileSchema.parse({
    contract_version: 1,
    mobile: {
      stack: "none",
      rationale: "The migrated v0.1 venture has no mobile project; reroute before mobile work.",
      bundle_identifier: null,
      app_scheme: null,
      app_store_connect: {
        team_id: null,
        app_id: null,
        sku: null,
        primary_language: "en",
        credential_ref: null,
        first_app_record: { state: "not_required", manual_action_ref: null },
      },
      eas: {
        project_id: null,
        credential_ref: null,
        build_profiles: ["development", "preview", "production"],
        submit_enabled: false,
      },
      signing: { credential_ref: null, certificates_in_git_forbidden: true },
      metadata_artifact_ref: null,
      screenshot_flow_artifact_ref: null,
      extensions: {},
    },
    extensions: {},
  });
}

export type MobileConfig = z.infer<typeof mobileSchema>;
