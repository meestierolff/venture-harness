import { z } from "zod";

/** Canonical Growth Contract parser shared by the root runtime and packages. */
const providerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, "expected a stable provider ID");

const extensionsSchema = z.record(z.unknown()).default({});

function uniqueArray<T extends z.ZodTypeAny>(item: T) {
  return z.array(item).refine((values) => new Set(values).size === values.length, {
    message: "values must be unique",
  });
}

const minorUnits = z.number().int().nonnegative();
const ratio = z.number().min(0).max(1);
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "expected an ISO 4217 currency code");

export const GROWTH_CONTRACT_VERSION = 2;

export const optimizationEventSchema = z.enum([
  "install",
  "onboarding_complete",
  "paywall_view",
  "trial_start",
  "purchase",
  "subscription_active",
  "value",
]);

export const goalSchema = z
  .object({
    primary_event: optimizationEventSchema,
    secondary_events: uniqueArray(optimizationEventSchema).default([]),
    current_optimization_event: optimizationEventSchema,
    allowed_fallback_events: uniqueArray(optimizationEventSchema).default([]),
  })
  .strict();

export const economicsSchema = z
  .object({
    currency: currencyCode,
    subscription_price_minor: minorUnits,
    billing_period: z.enum(["weekly", "monthly", "quarterly", "annual"]),
    store_fee_rate: ratio,
    tax_rate: ratio,
    refund_rate: ratio,
    variable_serving_cost_minor: minorUnits,
    creative_generation_cost_minor: minorUnits,
    expected_subscriber_lifetime_months: z.number().positive(),
    target_cac_minor: minorUnits,
    hard_max_cac_minor: minorUnits,
    payback_target_days: z.number().int().positive(),
    minimum_contribution_margin_minor: minorUnits,
    d7_retention_floor: ratio,
    d30_retention_floor: ratio,
    d90_retention_floor: ratio,
    refund_rate_ceiling: ratio,
  })
  .strict()
  .refine((value) => value.hard_max_cac_minor >= value.target_cac_minor, {
    message: "hard_max_cac_minor must be at least target_cac_minor",
    path: ["hard_max_cac_minor"],
  });

export const organicSchema = z
  .object({
    allowed_providers: uniqueArray(providerIdSchema),
    allowed_accounts: uniqueArray(z.string().min(1)),
    max_accounts: z.number().int().positive(),
    max_posts_per_account_per_day: z.number().int().positive(),
    duplicate_content_policy: z.enum(["forbid", "allow_across_accounts", "allow_with_variation"]),
    default_review_mode: z
      .enum(["AUTOMATIC_WITHIN_POLICY", "REVIEW_BEFORE_PUBLISH", "PLATFORM_DRAFT"])
      .default("REVIEW_BEFORE_PUBLISH"),
    snapshot_cadence_minutes: uniqueArray(z.number().int().positive()),
    ai_disclosure_required: z.boolean().default(true),
  })
  .strict();

export const paidSchema = z
  .object({
    allowed_networks: uniqueArray(z.enum(["tiktok_paid", "meta_paid"])),
    allowed_accounts: uniqueArray(z.string().min(1)),
    allowed_objectives: uniqueArray(z.string().min(1)),
    allowed_events: uniqueArray(optimizationEventSchema),
    test_budget_minor: minorUnits,
    per_creative_cap_minor: minorUnits,
    daily_account_cap_minor: minorUnits,
    daily_venture_cap_minor: minorUnits,
    monthly_venture_cap_minor: minorUnits,
    daily_customer_cap_minor: minorUnits,
    monthly_customer_cap_minor: minorUnits,
    emergency_platform_cap_minor: minorUnits,
    approval_threshold_minor: minorUnits.default(0),
    auto_pause_allowed: z.boolean().default(true),
    auto_scale_allowed: z.literal(false).default(false),
    vbo_policy: z.enum(["forbidden", "requires_value_ready", "allowed"]).default("forbidden"),
    stop_conditions: z
      .object({
        max_spend_without_trial_minor: minorUnits,
        max_spend_without_purchase_minor: minorUnits,
        max_cac_breach_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.test_budget_minor >= value.per_creative_cap_minor, {
    message: "test_budget_minor must be at least per_creative_cap_minor",
    path: ["test_budget_minor"],
  });

export const complianceSchema = z
  .object({
    rights_required: z.boolean().default(true),
    ai_disclosure_required: z.boolean().default(true),
    prohibited_claims: uniqueArray(z.string().min(1)).default([]),
    allowed_geographies: uniqueArray(z.string().min(2)),
    restricted_audiences: uniqueArray(z.string().min(1)).default([]),
    restricted_categories: uniqueArray(z.string().min(1)).default([]),
    provider_policy_state: z.enum(["unknown", "clear", "warned", "restricted"]).default("unknown"),
  })
  .strict();

export const growthContractSchema = z
  .object({
    contract_version: z.literal(GROWTH_CONTRACT_VERSION),
    venture_id: z.string().min(1),
    goal: goalSchema,
    economics: economicsSchema,
    organic: organicSchema,
    paid: paidSchema,
    compliance: complianceSchema,
    extensions: extensionsSchema,
  })
  .strict();

export type GrowthContract = z.infer<typeof growthContractSchema>;
export type GrowthEconomics = z.infer<typeof economicsSchema>;
export type OptimizationEvent = z.infer<typeof optimizationEventSchema>;

export function netContributionPerSubscriberMinor(economics: GrowthEconomics): number {
  const gross = economics.subscription_price_minor;
  const afterStore = gross * (1 - economics.store_fee_rate);
  const afterTax = afterStore * (1 - economics.tax_rate);
  const afterRefunds = afterTax * (1 - economics.refund_rate);
  const periodsPerMonth =
    economics.billing_period === "weekly"
      ? 4.345
      : economics.billing_period === "monthly"
        ? 1
        : economics.billing_period === "quarterly"
          ? 1 / 3
          : 1 / 12;
  const periods = economics.expected_subscriber_lifetime_months * periodsPerMonth;
  const revenue = afterRefunds * periods;
  const cost = economics.variable_serving_cost_minor * periods;
  return Math.round(revenue - cost);
}

export function cacIsAffordable(economics: GrowthEconomics, cacMinor: number): boolean {
  if (cacMinor > economics.hard_max_cac_minor) return false;
  const net = netContributionPerSubscriberMinor(economics);
  return net - cacMinor >= economics.minimum_contribution_margin_minor;
}

/** Deterministic, in-memory v1→v2 migration. The input is never mutated. */
export function migrateGrowthContract(value: unknown): GrowthContract {
  const current = growthContractSchema.safeParse(value);
  if (current.success) return current.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw current.error;
  }
  const legacy = value as Record<string, unknown>;
  const legacyPaid = legacy.paid;
  if (
    legacy.contract_version !== 1 ||
    !legacyPaid ||
    typeof legacyPaid !== "object" ||
    Array.isArray(legacyPaid)
  ) {
    throw current.error;
  }
  const paidRecord = legacyPaid as Record<string, unknown>;
  const legacyBudget = paidRecord.per_creative_test_budget_minor;
  const paidWithoutLegacyBudget = { ...paidRecord };
  delete paidWithoutLegacyBudget.per_creative_test_budget_minor;
  return growthContractSchema.parse({
    ...legacy,
    contract_version: GROWTH_CONTRACT_VERSION,
    paid: {
      ...paidWithoutLegacyBudget,
      test_budget_minor: legacyBudget,
      per_creative_cap_minor: legacyBudget,
    },
  });
}

export function parseGrowthContract(value: unknown): GrowthContract {
  return migrateGrowthContract(value);
}
