import { z } from "zod";
import { DATA_SOURCE_IDS } from "../data/types";
import { extensionsSchema, uniqueArray } from "./contracts";
import { sideEffectClassSchema } from "./policy-schema";

export const loopAutonomySchema = z.enum([
  "observe",
  "report",
  "propose",
  "open_pr",
  "autofix_low_risk",
]);

const loopInputSchema = z
  .object({
    source: z.enum(DATA_SOURCE_IDS),
    freshness_hours: z.number().int().positive(),
    required: z.boolean(),
  })
  .strict();

const loopMetricSchema = z
  .object({
    id: z.string().min(1),
    direction: z.enum(["increase", "decrease", "maintain", "observe"]),
  })
  .strict();

const normalizedScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const metricDefinitionSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(DATA_SOURCE_IDS),
    filter: z.record(normalizedScalarSchema).default({}),
    operation: z.enum(["sum", "count_rows"]),
    field: z.string().min(1).nullable().default(null),
    sample_size_field: z.string().min(1).nullable().default(null),
    limitation: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.operation === "sum" && !value.field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["field"],
        message: "sum metric definitions require field",
      });
    }
    if (value.operation === "count_rows" && value.field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["field"],
        message: "count_rows metric definitions must not declare field",
      });
    }
  });

const candidateRuleSchema = z
  .object({
    id: z.string().min(1),
    metric_id: z.string().min(1),
    comparator: z.enum(["lt", "lte", "gt", "gte", "eq"]),
    threshold: z.number().finite(),
    minimum_sample_size: z.number().int().nonnegative(),
    journey: z.string().min(1),
    title: z.string().min(1),
    confidence: z.number().min(0).max(1),
    risk: z.enum(["low", "moderate", "high"]),
    effect_types: uniqueArray(sideEffectClassSchema).default(["local_write"]),
    protects_winner: z.boolean().default(false),
  })
  .strict();

export const loopDefinitionSchema = z
  .object({
    cadence: z.enum(["daily", "weekly", "biweekly", "monthly"]),
    enabled: z.boolean().default(false),
    trigger: z
      .object({
        kind: z.enum(["cron", "manual", "event"]),
        expression: z.string().min(1),
      })
      .strict(),
    inputs: z.array(loopInputSchema).default([]),
    primary_metrics: z.array(loopMetricSchema).default([]),
    guardrail_metrics: z.array(loopMetricSchema).default([]),
    metric_definitions: z.array(metricDefinitionSchema).default([]),
    candidate_rules: z.array(candidateRuleSchema).default([]),
    decision_rules: uniqueArray(z.string().min(1)).default([]),
    maximum_actions: z.number().int().nonnegative().default(1),
    maximum_iterations: z.number().int().positive().default(1),
    autonomy: loopAutonomySchema.default("propose"),
    authorized_effect_types: uniqueArray(sideEffectClassSchema).default([
      "none",
      "local_write",
      "git_write",
    ]),
    output_destination: z.string().min(1),
    next_run_at: z.string().datetime({ offset: true }).nullable().default(null),
    stop_condition: z
      .string()
      .min(1)
      .default("Stop when required data is missing or stale; report the exact missing source."),
    extensions: extensionsSchema,
  })
  .strict();

export const loopsSchema = z
  .object({
    contract_version: z.literal(1),
    loops: z.record(z.string().regex(/^[a-z][a-z0-9_-]+$/), loopDefinitionSchema),
    extensions: extensionsSchema,
  })
  .strict();

function loop(
  cadence: z.infer<typeof loopDefinitionSchema>["cadence"],
  expression: string,
  output: string,
): z.input<typeof loopDefinitionSchema> {
  return {
    cadence,
    enabled: false,
    trigger: { kind: "cron", expression },
    inputs: [],
    primary_metrics: [],
    guardrail_metrics: [],
    metric_definitions: [],
    candidate_rules: [],
    decision_rules: [],
    maximum_actions: cadence === "weekly" ? 3 : 1,
    maximum_iterations: 1,
    autonomy: "propose",
    authorized_effect_types: ["none", "local_write", "git_write"],
    output_destination: output,
    next_run_at: null,
    stop_condition: "Stop when required data is missing or stale; report the exact missing source.",
    extensions: {},
  };
}

export function createDefaultLoopsConfig() {
  return loopsSchema.parse({
    contract_version: 1,
    loops: {
      daily_early_signal: loop("daily", "0 6 * * *", "reports/learning/daily"),
      weekly_growth: loop("weekly", "0 6 * * 1", "reports/learning/weekly"),
      biweekly_product: loop("biweekly", "0 7 1,15 * *", "reports/learning/biweekly"),
      monthly_strategy: loop("monthly", "0 8 1 * *", "reports/learning/monthly"),
    },
    extensions: {},
  });
}

export type LoopsConfig = z.infer<typeof loopsSchema>;
