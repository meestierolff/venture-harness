import { z } from "zod";
import {
  artifactReferenceSchema,
  capabilityIdSchema,
  credentialReferenceSchema,
  extensionsSchema,
  providerIdSchema,
  rejectCredentialMaterial,
  uniqueArray,
} from "./contracts";

export const providerLifecycleStateSchema = z.enum([
  "unconfigured",
  "auth_required",
  "planned",
  "applying",
  "waiting_manual_action",
  "configured",
  "verified",
  "degraded",
  "failed",
  "disabled",
]);

export const providerTransportSchema = z.enum([
  "none",
  "mcp",
  "cli",
  "rest_api",
  "graphql_api",
  "manual",
]);

export const providerStateSchema = z
  .object({
    state: providerLifecycleStateSchema.default("unconfigured"),
    capability_ids: uniqueArray(capabilityIdSchema),
    external_resource_ids: z.record(z.string().min(1).max(300)).default({}),
    account_id: z.string().min(1).max(300).nullable().default(null),
    team_id: z.string().min(1).max(300).nullable().default(null),
    region: z.string().min(1).max(100).nullable().default(null),
    selected_transport: providerTransportSchema.default("none"),
    credential_ref: credentialReferenceSchema.nullable().default(null),
    required_scopes: uniqueArray(z.string().min(1).max(200)).default([]),
    last_verified_at: z.string().datetime({ offset: true }).nullable().default(null),
    evidence_artifact_ref: artifactReferenceSchema.nullable().default(null),
    error_code: z.string().min(1).max(100).nullable().default(null),
    error_message: z.string().min(1).max(1_000).nullable().default(null),
    retryable: z.boolean().nullable().default(null),
    next_action: z.string().min(1).max(1_000).nullable().default(null),
    manual_action_ref: artifactReferenceSchema.nullable().default(null),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    rejectCredentialMaterial(value, ctx);
    if ((value.state === "failed" || value.state === "degraded") && !value.error_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error_code"],
        message: `${value.state} provider state requires an error_code`,
      });
    }
    if (value.state === "waiting_manual_action" && !value.manual_action_ref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manual_action_ref"],
        message: "waiting_manual_action requires a manual_action_ref",
      });
    }
    if (value.state === "verified" && (!value.last_verified_at || !value.evidence_artifact_ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "verified state requires last_verified_at and evidence_artifact_ref",
      });
    }
  });

export const providersSchema = z
  .object({
    contract_version: z.literal(1),
    providers: z.record(providerIdSchema, providerStateSchema),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine(rejectCredentialMaterial);

type ProviderSeed = {
  capability_ids: z.input<typeof capabilityIdSchema>[];
  selected_transport?: z.infer<typeof providerTransportSchema>;
};

export function createProviderState(seed: ProviderSeed): z.input<typeof providerStateSchema> {
  return {
    state: "unconfigured",
    capability_ids: seed.capability_ids,
    external_resource_ids: {},
    account_id: null,
    team_id: null,
    region: null,
    selected_transport: seed.selected_transport ?? "none",
    credential_ref: null,
    required_scopes: [],
    last_verified_at: null,
    evidence_artifact_ref: null,
    error_code: null,
    error_message: null,
    retryable: null,
    next_action: null,
    manual_action_ref: null,
    extensions: {},
  };
}

export function createDefaultProvidersConfig() {
  return providersSchema.parse({
    contract_version: 1,
    providers: {
      github: createProviderState({ capability_ids: [] }),
      vercel: createProviderState({ capability_ids: ["public_website", "vercel_analytics"] }),
      neon: createProviderState({ capability_ids: ["database"] }),
      stripe: createProviderState({ capability_ids: ["stripe"] }),
      revenuecat: createProviderState({ capability_ids: ["revenuecat"] }),
      brevo: createProviderState({
        capability_ids: ["transactional_email", "lifecycle_email"],
      }),
      google: createProviderState({ capability_ids: ["ga4", "gsc"] }),
      bing: createProviderState({ capability_ids: ["bing_webmaster"] }),
      dns: createProviderState({
        capability_ids: ["public_website"],
        selected_transport: "manual",
      }),
      mijndomein: createProviderState({
        capability_ids: ["public_website"],
        selected_transport: "manual",
      }),
      app_store_connect: createProviderState({ capability_ids: ["app_store_connect", "ios_aso"] }),
      eas: createProviderState({ capability_ids: ["eas"] }),
    },
    extensions: {},
  });
}

export type ProviderState = z.infer<typeof providerStateSchema>;
export type ProvidersConfig = z.infer<typeof providersSchema>;
