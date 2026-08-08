/**
 * Zod schemas for the config/ contracts. Scripts and the app import from
 * here so configuration stays typed end to end. Schemas are strict on the
 * fields the harness relies on and tolerant (`passthrough`) elsewhere, so
 * ventures can extend configs without forking the schemas.
 */
import { z } from "zod";
import { launchSchema } from "./launch-schema";
import { loopsSchema } from "./loop-schema";
import { mobileSchema } from "./mobile-schema";
import { policiesSchema } from "./policy-schema";
import { providersSchema } from "./provider-schema";
import { ventureSchema } from "./venture-schema";

export {
  appKindSchema,
  capabilityIdSchema,
  credentialReferenceSchema,
  knownCapabilityIdSchema,
  launchModeSchema,
  mobileStackSchema,
  openCapabilityIdSchema,
} from "./contracts";
export { harnessLockSchema, loadHarnessLock, parseHarnessLock } from "./harness-lock";
export { launchSchema } from "./launch-schema";
export { loopsSchema } from "./loop-schema";
export { mobileSchema } from "./mobile-schema";
export {
  authorizationEnvelopeSchema,
  authorizationProfileIdSchema,
  authorizationProfileSchema,
  policiesSchema,
  sideEffectClassSchema,
} from "./policy-schema";
export {
  providerLifecycleStateSchema,
  providerStateSchema,
  providersSchema,
  providerTransportSchema,
} from "./provider-schema";
export { legacyVentureSchema, ventureSchema, ventureV02Schema } from "./venture-schema";

export const frameworkSchema = z
  .object({
    framework: z.object({
      name: z.string().min(1),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      public_template: z.boolean(),
      license: z.string(),
    }),
    supported_agents: z.array(z.string()).min(1),
    package_manager: z.literal("pnpm"),
    generated_paths: z.array(z.string()).min(1),
    sync_excludes: z.object({
      claude: z.array(z.string()),
      codex: z.array(z.string()),
    }),
    verification: z.object({ primary: z.string() }).passthrough(),
  })
  .passthrough();

export const offerSchema = z
  .object({
    icp: z.object({ description: z.string().nullable() }).passthrough(),
    offer: z.object({ sentence: z.string().nullable() }).passthrough(),
    pricing: z
      .object({
        currency: z.string(),
        monthly_price: z.number().nullable(),
        annual_price: z.number().nullable(),
        implementation_fee: z.number().nullable(),
      })
      .passthrough(),
    economics: z
      .object({
        cac_assumption: z.number().nullable(),
        delivery_cost_monthly: z.number().nullable(),
        payback_target_days: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export const experimentVariantSchema = z.object({
  key: z.string().min(1),
  weight: z.number().gt(0).lte(1),
  displayed_offer: z.string().min(1),
  displayed_price: z.string().min(1),
});

export const experimentSchema = z
  .object({
    id: z.string().regex(/^exp-\d{3}-[a-z0-9-]+$/),
    name: z.string().min(1),
    owner: z.string().min(1),
    status: z.enum(["draft", "approved", "running", "stopped", "decided"]),
    type: z.enum(["icp", "hero", "proof", "cta", "pricing", "fake_door"]),
    hypothesis: z.string().min(20),
    routes: z.array(z.string()).min(1),
    activation_event: z.string().min(1),
    exposure_event: z.string().min(1),
    variants: z.array(experimentVariantSchema).min(2),
    primary_metric: z.string().min(1),
    secondary_metrics: z.array(z.string()),
    guardrails: z.array(z.object({ metric: z.string(), rule: z.string() })),
    min_duration_days: z.number().int().min(1),
    max_duration_days: z.number().int().min(1),
    min_observations_per_variant: z.number().int().min(1),
    stop_rule: z.string().min(10),
    result: z.string().nullable(),
    limitations: z.string().nullable(),
    final_decision: z.enum(["adopt", "reject", "rerun", "inconclusive"]).nullable(),
  })
  .passthrough();

export const experimentsSchema = z
  .object({
    defaults: z.object({}).passthrough(),
    experiments: z.array(experimentSchema),
  })
  .passthrough();

export const analyticsEventSchema = z.object({
  purpose: z.string().min(5),
  trigger: z.string().min(3),
  destinations: z.array(z.enum(["vercel", "ga4", "neon"])),
  consent: z.enum(["none", "analytics"]),
  props: z.array(z.string()),
  neon: z.boolean(),
  experiment: z.boolean(),
});

export const analyticsSchema = z
  .object({
    providers: z.record(z.object({ layer: z.number(), purpose: z.string() }).passthrough()),
    consent: z.object({
      default_mode: z.enum(["strict", "basic"]),
      google_analytics: z.enum(["opt_in", "opt_out"]),
      vercel_analytics: z.enum(["opt_in", "opt_out"]),
      allow_withdrawal: z.literal(true),
      settings_link_required: z.literal(true),
    }),
    collection: z.object({
      track_material_behaviour: z.literal(true),
      collect_keystrokes: z.literal(false),
      collect_mouse_movement: z.literal(false),
      session_replay: z.literal(false),
      send_form_values_to_analytics: z.literal(false),
      send_search_text_to_third_parties: z.literal(false),
      send_email_to_analytics: z.literal(false),
      enable_advertising_features: z.literal(false),
    }),
    prohibited_properties: z.array(z.string()).min(5),
    events: z.record(analyticsEventSchema),
  })
  .passthrough();

const qualityGapSchema = z
  .object({
    why: z.string().min(10),
    missing: z.string().min(10),
    exact_command: z.string().min(3),
    expected_evidence: z.string().min(10),
  })
  .strict();

const qualityCheckSchema = z
  .object({
    kind: z.enum([
      "command",
      "changed_format",
      "changed_lint",
      "changed_tests",
      "tracked_secret_scan",
      "analytics_readiness",
      "raw_html",
      "manual",
      "provider_readback",
    ]),
    phase: z.number().int().positive(),
    command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    when_paths: z.array(z.string().min(1)).min(1).optional(),
    provider: z.string().min(1).optional(),
    gap: qualityGapSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (["manual", "provider_readback"].includes(value.kind) && !value.gap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gap"],
        message: `${value.kind} checks require an actionable gap`,
      });
    }
    if (value.kind === "provider_readback" && !value.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "provider_readback checks require a provider",
      });
    }
  });

const qualityProfileSchema = z
  .object({
    description: z.string().min(10),
    checks: z.array(z.string().min(1)).min(1),
  })
  .strict();

const qualityCapabilityProfileSchema = z
  .object({
    fast: z.array(z.string().min(1)).optional(),
    mvp: z.array(z.string().min(1)).optional(),
    release: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const qualitySchema = z
  .object({
    required_commands: z
      .object({
        always: z.array(z.string().min(1)).min(5),
        ci_additional: z.array(z.string().min(1)),
      })
      .strict(),
    profiles: z
      .object({
        fast: qualityProfileSchema,
        mvp: qualityProfileSchema,
        release: qualityProfileSchema,
      })
      .strict(),
    checks: z.record(z.string().min(1), qualityCheckSchema),
    capability_checks: z.record(z.string().min(1), qualityCapabilityProfileSchema),
    required_documents: z.array(z.string().min(1)).min(1),
    thresholds: z
      .object({
        performance: z
          .object({
            lcp_ms: z.number().positive(),
            cls: z.number().nonnegative(),
            inp_ms: z.number().positive(),
          })
          .strict(),
        accessibility: z
          .object({
            standard: z.string().min(1),
            min_contrast_normal_text: z.number().positive(),
            min_contrast_large_text: z.number().positive(),
            keyboard_navigable: z.boolean(),
          })
          .strict(),
        crawler: z
          .object({
            raw_html_must_contain: z.array(z.string().min(1)).min(1),
            user_agents: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      })
      .strict(),
    release_checks: z
      .object({
        no_secrets: z.boolean(),
        no_real_pii: z.boolean(),
        no_unlabeled_synthetic_data: z.boolean(),
        license_present: z.boolean(),
        generated_dirs_in_sync: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const knownChecks = new Set(Object.keys(value.checks));
    for (const [profile, definition] of Object.entries(value.profiles)) {
      for (const check of definition.checks) {
        if (!knownChecks.has(check)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", profile, "checks"],
            message: `references unknown check ${check}`,
          });
        }
      }
    }
    for (const [capability, profiles] of Object.entries(value.capability_checks)) {
      for (const [profile, checks] of Object.entries(profiles)) {
        for (const check of checks ?? []) {
          if (!knownChecks.has(check)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["capability_checks", capability, profile],
              message: `references unknown check ${check}`,
            });
          }
        }
      }
    }
  });

export const contentSchema = z
  .object({
    banned_phrases: z.array(z.string()).min(1),
    answer_block_rules: z.object({ max_words: z.number() }).passthrough(),
  })
  .passthrough();

export const distributionSchema = z
  .object({
    channel_priority: z.array(z.string()).min(2),
    approval: z
      .object({
        human_approval_required_for: z.array(z.string()).min(3),
      })
      .passthrough(),
    outreach_rules: z
      .object({
        automated_sending: z.literal("forbidden"),
        mass_generic_messages: z.literal("forbidden"),
      })
      .passthrough(),
    posting_rules: z
      .object({
        automated_posting: z.literal("forbidden"),
        engagement_manipulation: z.literal("forbidden"),
      })
      .passthrough(),
  })
  .passthrough();

export const configSchemas = {
  "config/framework.yaml": frameworkSchema,
  "config/venture.yaml": ventureSchema,
  "config/launch.yaml": launchSchema,
  "config/providers.yaml": providersSchema,
  "config/policies.yaml": policiesSchema,
  "config/loops.yaml": loopsSchema,
  "config/mobile.yaml": mobileSchema,
  "config/offer.yaml": offerSchema,
  "config/experiments.yaml": experimentsSchema,
  "config/analytics.yaml": analyticsSchema,
  "config/quality.yaml": qualitySchema,
  "config/content.yaml": contentSchema,
  "config/distribution.yaml": distributionSchema,
} as const;
