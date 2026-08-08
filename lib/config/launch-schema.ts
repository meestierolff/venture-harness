import { z } from "zod";
import {
  appKindSchema,
  extensionsSchema,
  launchModeSchema,
  mobileStackSchema,
  uniqueArray,
} from "./contracts";

const rejectedAlternativeSchema = z
  .object({
    mode: launchModeSchema,
    reason: z.string().min(1),
  })
  .strict();

const routeFactorSchema = z
  .object({
    level: z.enum(["unknown", "low", "moderate", "high"]),
    rationale: z.string().min(1),
  })
  .strict();

export const launchSchema = z
  .object({
    contract_version: z.literal(1),
    launch: z
      .object({
        selected_mode: launchModeSchema,
        confidence: z.number().min(0).max(1),
        rationale: z.string().min(1),
        rejected_alternatives: uniqueArray(rejectedAlternativeSchema),
        assumptions: uniqueArray(z.string().min(1)),
        evidence_that_could_change_choice: uniqueArray(z.string().min(1)),
        rail: z
          .object({
            app_kind: appKindSchema,
            mobile_stack: mobileStackSchema,
            rationale: z.string().min(1),
          })
          .strict(),
        routing_factors: z
          .object({
            smallest_useful_build_cost: routeFactorSchema,
            smallest_useful_build_time: routeFactorSchema,
            reversibility: routeFactorSchema,
            regulatory_or_safety_risk: routeFactorSchema,
            real_usage_required: routeFactorSchema,
            marketplace_cold_start: routeFactorSchema,
            operational_burden: routeFactorSchema,
            founder_evidence: routeFactorSchema,
            concierge_delivery_fit: routeFactorSchema,
            app_store_required: routeFactorSchema,
          })
          .strict(),
        progressive_commitment: z
          .object({
            specific_user_or_audience: z.string().min(1).nullable(),
            problem_or_job: z.string().min(1).nullable(),
            intended_outcome: z.string().min(1).nullable(),
            smallest_core_journey: z.string().min(1).nullable(),
            primary_success_signal: z.string().min(1).nullable(),
            material_constraints: uniqueArray(z.string().min(1)),
            known_truths: uniqueArray(z.string().min(1)),
            unresolved_assumptions: uniqueArray(z.string().min(1)),
            blocking_issues: uniqueArray(z.string().min(1)),
          })
          .strict(),
        extensions: extensionsSchema,
      })
      .strict(),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, alternative] of value.launch.rejected_alternatives.entries()) {
      if (alternative.mode === value.launch.selected_mode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["launch", "rejected_alternatives", index, "mode"],
          message: "the selected mode cannot also be a rejected alternative",
        });
      }
    }
  });

const unknownFactor = (rationale: string) => ({ level: "unknown" as const, rationale });

export function createDefaultLaunchConfig() {
  return launchSchema.parse({
    contract_version: 1,
    launch: {
      selected_mode: "validate_first",
      confidence: 0,
      rationale:
        "Conservative compatibility default; reroute from the founder brief before launch.",
      rejected_alternatives: [],
      assumptions: [
        "The v0.1 validation-first strategy remains active until the launch router runs.",
      ],
      evidence_that_could_change_choice: [
        "A complete founder brief and the smallest-useful-product assessment.",
      ],
      rail: {
        app_kind: "web",
        mobile_stack: "none",
        rationale: "The v0.1 harness contains a Next.js web foundation and no mobile project.",
      },
      routing_factors: {
        smallest_useful_build_cost: unknownFactor("Assess from the founder brief."),
        smallest_useful_build_time: unknownFactor("Assess from the founder brief."),
        reversibility: unknownFactor("Assess the smallest useful implementation."),
        regulatory_or_safety_risk: unknownFactor("No venture risk assessment exists yet."),
        real_usage_required: unknownFactor(
          "Determine whether usage is needed to demonstrate value.",
        ),
        marketplace_cold_start: unknownFactor("Determine whether the venture is a marketplace."),
        operational_burden: unknownFactor("Assess delivery and support burden."),
        founder_evidence: unknownFactor("No venture evidence is loaded in template state."),
        concierge_delivery_fit: unknownFactor("Assess whether concierge delivery can be honest."),
        app_store_required: unknownFactor("Determine whether an installed app is required."),
      },
      progressive_commitment: {
        specific_user_or_audience: null,
        problem_or_job: null,
        intended_outcome: null,
        smallest_core_journey: null,
        primary_success_signal: null,
        material_constraints: [],
        known_truths: [],
        unresolved_assumptions: [],
        blocking_issues: [],
      },
      extensions: {},
    },
    extensions: {},
  });
}

export type LaunchConfig = z.infer<typeof launchSchema>;
