import { z } from "zod";
import { capabilityIdSchema, extensionsSchema, providerIdSchema, uniqueArray } from "./contracts";

export const authorizationProfileIdSchema = z.enum([
  "read_only",
  "build_local",
  "preview_launch",
  "standard_launch",
  "live_commerce_launch",
  "mobile_testflight",
  "autofix_low_risk",
]);

export const riskClassSchema = z.enum(["low", "moderate", "high", "critical"]);

export const sideEffectClassSchema = z.enum([
  "none",
  "local_write",
  "git_write",
  "external_read",
  "reversible_external_write",
  "preview_deploy",
  "production_deploy",
  "live_commerce_config",
  "customer_charge",
  "transactional_email",
  "bulk_communication",
  "dns_addition",
  "nameserver_change",
  "destructive_data_change",
  "testflight_upload",
  "app_store_publication",
  "external_delete",
]);

export const environmentSchema = z.enum(["local", "test", "preview", "production"]);

const spendLimitSchema = z
  .object({
    amount: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const authorizationCapabilitySchema = z.union([
  z.literal("*"),
  capabilityIdSchema,
  z
    .string()
    .regex(
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
      "expected a stable graph or provider capability ID",
    ),
]);

export const authorizationProfileSchema = z
  .object({
    allowed_capabilities: uniqueArray(authorizationCapabilitySchema),
    allowed_side_effect_classes: uniqueArray(sideEffectClassSchema),
    allowed_risk_classes: uniqueArray(riskClassSchema),
    allowed_environments: uniqueArray(environmentSchema),
    max_estimated_spend: spendLimitSchema.default({ amount: 0, currency: "EUR" }),
    unknown_external_costs_allowed: z.boolean().default(false),
    max_email_recipients: z.number().int().nonnegative().default(0),
    production_deploy_allowed: z.boolean().default(false),
    live_products_and_prices_allowed: z.boolean().default(false),
    actual_charges_allowed: z.boolean().default(false),
    transactional_test_email_allowed: z.boolean().default(false),
    dns_additions_allowed: z.boolean().default(false),
    nameserver_changes_allowed: z.boolean().default(false),
    app_store_submission_allowed: z.boolean().default(false),
    extensions: extensionsSchema,
  })
  .strict();

export const authorizationEnvelopeSchema = z
  .object({
    run_id: z.string().regex(/^[a-z0-9][a-z0-9-]{5,100}$/),
    profile: authorizationProfileIdSchema,
    allowed_capabilities: uniqueArray(authorizationCapabilitySchema),
    allowed_side_effect_classes: uniqueArray(sideEffectClassSchema),
    providers: uniqueArray(providerIdSchema),
    environments: uniqueArray(environmentSchema),
    issued_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    max_estimated_spend: spendLimitSchema,
    unknown_external_costs_allowed: z.boolean().default(false),
    max_email_recipients: z.number().int().nonnegative(),
    production_deploy_allowed: z.boolean(),
    live_products_and_prices_allowed: z.boolean(),
    actual_charges_allowed: z.boolean(),
    transactional_test_email_allowed: z.boolean(),
    dns_additions_allowed: z.boolean(),
    nameserver_changes_allowed: z.boolean(),
    app_store_submission_allowed: z.boolean(),
    explicitly_forbidden_actions: uniqueArray(z.string().min(1).max(300)),
    approval_ref: z.string().min(1).max(300),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "authorization expiry must be after issue time",
      });
    }
    if (value.actual_charges_allowed && !value.live_products_and_prices_allowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actual_charges_allowed"],
        message: "actual charges require live product and price configuration permission",
      });
    }
  });

const profileSetSchema = z
  .object({
    read_only: authorizationProfileSchema,
    build_local: authorizationProfileSchema,
    preview_launch: authorizationProfileSchema,
    standard_launch: authorizationProfileSchema,
    live_commerce_launch: authorizationProfileSchema,
    mobile_testflight: authorizationProfileSchema,
    autofix_low_risk: authorizationProfileSchema,
  })
  .strict();

export const policiesSchema = z
  .object({
    contract_version: z.literal(1),
    authorization: z
      .object({
        default_profile: authorizationProfileIdSchema,
        profiles: profileSetSchema,
        active_envelopes: z.array(authorizationEnvelopeSchema),
        always_require_distinct_checkpoint_for: uniqueArray(sideEffectClassSchema),
        extensions: extensionsSchema,
      })
      .strict(),
    extensions: extensionsSchema,
  })
  .strict();

type ProfileOverrides = Partial<z.input<typeof authorizationProfileSchema>>;

function profile(overrides: ProfileOverrides = {}): z.input<typeof authorizationProfileSchema> {
  return {
    allowed_capabilities: ["*"],
    allowed_side_effect_classes: ["none"],
    allowed_risk_classes: ["low"],
    allowed_environments: ["local"],
    max_estimated_spend: { amount: 0, currency: "EUR" },
    unknown_external_costs_allowed: false,
    max_email_recipients: 0,
    production_deploy_allowed: false,
    live_products_and_prices_allowed: false,
    actual_charges_allowed: false,
    transactional_test_email_allowed: false,
    dns_additions_allowed: false,
    nameserver_changes_allowed: false,
    app_store_submission_allowed: false,
    extensions: {},
    ...overrides,
  };
}

export function createDefaultPoliciesConfig() {
  return policiesSchema.parse({
    contract_version: 1,
    authorization: {
      default_profile: "read_only",
      profiles: {
        read_only: profile({
          allowed_side_effect_classes: ["none", "external_read"],
          allowed_environments: ["local", "test", "preview", "production"],
        }),
        build_local: profile({
          allowed_side_effect_classes: ["none", "local_write", "git_write"],
          allowed_risk_classes: ["low", "moderate"],
          allowed_environments: ["local", "test"],
        }),
        preview_launch: profile({
          allowed_side_effect_classes: [
            "none",
            "local_write",
            "git_write",
            "external_read",
            "reversible_external_write",
            "preview_deploy",
          ],
          allowed_risk_classes: ["low", "moderate", "high"],
          allowed_environments: ["local", "test", "preview"],
          unknown_external_costs_allowed: true,
        }),
        standard_launch: profile({
          allowed_side_effect_classes: [
            "none",
            "local_write",
            "git_write",
            "external_read",
            "reversible_external_write",
            "preview_deploy",
            "production_deploy",
            "transactional_email",
            "dns_addition",
          ],
          allowed_risk_classes: ["low", "moderate", "high", "critical"],
          allowed_environments: ["local", "test", "preview", "production"],
          max_email_recipients: 1,
          unknown_external_costs_allowed: true,
          production_deploy_allowed: true,
          transactional_test_email_allowed: true,
          dns_additions_allowed: true,
        }),
        live_commerce_launch: profile({
          allowed_side_effect_classes: [
            "none",
            "local_write",
            "git_write",
            "external_read",
            "reversible_external_write",
            "preview_deploy",
            "production_deploy",
            "live_commerce_config",
            "customer_charge",
            "transactional_email",
            "dns_addition",
          ],
          allowed_risk_classes: ["low", "moderate", "high", "critical"],
          allowed_environments: ["local", "test", "preview", "production"],
          max_email_recipients: 1,
          unknown_external_costs_allowed: true,
          production_deploy_allowed: true,
          live_products_and_prices_allowed: true,
          actual_charges_allowed: true,
          transactional_test_email_allowed: true,
          dns_additions_allowed: true,
        }),
        mobile_testflight: profile({
          allowed_side_effect_classes: [
            "none",
            "local_write",
            "git_write",
            "external_read",
            "reversible_external_write",
            "preview_deploy",
            "production_deploy",
            "dns_addition",
            "testflight_upload",
          ],
          allowed_risk_classes: ["low", "moderate", "high", "critical"],
          allowed_environments: ["local", "test", "preview", "production"],
          production_deploy_allowed: true,
          unknown_external_costs_allowed: true,
          dns_additions_allowed: true,
        }),
        autofix_low_risk: profile({
          allowed_side_effect_classes: ["none", "local_write", "git_write"],
          allowed_environments: ["local", "test"],
        }),
      },
      active_envelopes: [],
      always_require_distinct_checkpoint_for: [
        "external_delete",
        "destructive_data_change",
        "nameserver_change",
        "bulk_communication",
        "customer_charge",
        "app_store_publication",
      ],
      extensions: {},
    },
    extensions: {},
  });
}

export type AuthorizationEnvelope = z.infer<typeof authorizationEnvelopeSchema>;
export type PoliciesConfig = z.infer<typeof policiesSchema>;
