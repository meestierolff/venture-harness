import { z } from "zod";
import {
  appKindSchema,
  extensionsSchema,
  knownCapabilityIdSchema,
  launchModeSchema,
  mobileStackSchema,
  openCapabilityIdSchema,
  semverSchema,
  uniqueArray,
} from "./contracts";

export const legacyVentureSchema = z
  .object({
    venture: z
      .object({
        name: z.string().nullable(),
        domain: z.string().nullable(),
        stage: z.enum([
          "template",
          "ideation",
          "demand_validation",
          "build",
          "iterate",
          "reposition",
          "stopped",
        ]),
        language: z.string(),
        currency: z.string(),
        timezone: z.string(),
      })
      .passthrough(),
    validation: z
      .object({
        minimum_days: z.number().int().min(1),
        target_days: z.number().int().min(1),
        maximum_days: z.number().int().min(1),
        launch_date: z.string().nullable(),
        primary_conversion: z.string().nullable(),
        build_threshold: z.string().nullable(),
        stop_threshold: z.string().nullable(),
      })
      .passthrough(),
    infrastructure: z.record(z.boolean()),
  })
  .passthrough();

const outcomeSchema = z
  .object({
    statement: z.string().min(1).nullable(),
    success_signal: z.string().min(1).nullable(),
  })
  .strict();

export const ventureV02Schema = z
  .object({
    venture: z
      .object({
        name: z.string().nullable(),
        legal_name: z.string().nullable(),
        domain: z.string().nullable(),
        market: z.string().nullable(),
        target_market: z.string().nullable(),
        language: z.string().min(2),
        locale: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
        timezone: z.string().min(1),
        stage: z.enum([
          "template",
          "ideation",
          "demand_validation",
          "build",
          "iterate",
          "reposition",
          "stopped",
        ]),
        repository_visibility: z.enum(["private", "public"]),
        production_status: z.enum([
          "none",
          "preview_live",
          "validation_site_live",
          "product_live",
          "testflight_live",
        ]),
        harness_version: semverSchema,
        app_kind: appKindSchema,
        launch_mode: launchModeSchema,
        business_model: z.enum([
          "unselected",
          "b2b",
          "b2c",
          "b2b2c",
          "marketplace",
          "internal",
          "nonprofit",
        ]),
        monetization_model: z.enum([
          "unselected",
          "none",
          "subscription",
          "one_time",
          "usage_based",
          "transaction_fee",
          "lead_generation",
          "services",
          "hybrid",
        ]),
        risk_profile: z.enum(["unassessed", "low", "moderate", "high", "regulated"]),
        privacy_profile: z.enum([
          "unassessed",
          "minimal",
          "standard",
          "sensitive",
          "special_category",
        ]),
        mobile_stack: mobileStackSchema,
        outcomes: z
          .object({
            primary: outcomeSchema,
            secondary: z.array(outcomeSchema),
          })
          .strict(),
        capabilities: z
          .object({
            active: uniqueArray(knownCapabilityIdSchema),
            open: uniqueArray(openCapabilityIdSchema),
          })
          .strict(),
        extensions: extensionsSchema,
      })
      // Older ventures may carry project-specific venture fields. The migration
      // preserves them while new extension fields should use `extensions`.
      .passthrough(),
    // Kept as an optional strategy for validate_first and as a compatibility
    // surface for v0.1 tooling. It is no longer a universal launch gate.
    validation: legacyVentureSchema.shape.validation,
    // Deprecated compatibility view. Provider lifecycle state lives in
    // config/providers.yaml; this record is retained until downstream scripts migrate.
    infrastructure: z.record(z.boolean()),
    extensions: extensionsSchema,
  })
  .passthrough();

export const ventureSchema = ventureV02Schema;

export type VentureV02 = z.infer<typeof ventureV02Schema>;
