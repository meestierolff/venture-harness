import { z } from "zod";
import {
  appKindSchema,
  capabilityIdSchema,
  launchModeSchema,
  mobileStackSchema,
  uniqueArray,
} from "../config/contracts";
import type { EventPackId } from "../analytics";
import type { WorkflowDefinition } from "../workflow";

export const routingLevelSchema = z.enum(["unknown", "low", "moderate", "high"]);

export const founderBriefSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    synthetic: z.literal(true).optional(),
    name: z.string().min(1),
    specific_user_or_audience: z.string().min(1),
    problem_or_job: z.string().min(1),
    intended_outcome: z.string().min(1),
    smallest_core_journey: z.string().min(1),
    primary_success_signal: z.string().min(1),
    material_constraints: uniqueArray(z.string().min(1)),
    known_truths: uniqueArray(z.string().min(1)),
    assumptions: uniqueArray(z.string().min(1)),
    app_kind: appKindSchema,
    requested_mobile_stack: mobileStackSchema,
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
      "none",
      "subscription",
      "one_time",
      "usage_based",
      "transaction_fee",
      "lead_generation",
      "services",
      "hybrid",
    ]),
    native_digital_goods: z.boolean(),
    target_market: z.string().min(1).nullable().optional(),
    domain: z
      .string()
      .regex(/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/)
      .nullable()
      .optional(),
    locale: z
      .string()
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    timezone: z.string().min(1).optional(),
    repository_visibility: z.enum(["private", "public"]).optional(),
    bundle_identifier: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9.-]+$/)
      .nullable()
      .optional(),
    app_scheme: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]*$/)
      .nullable()
      .optional(),
    factors: z
      .object({
        smallest_useful_build_cost: routingLevelSchema,
        smallest_useful_build_time: routingLevelSchema,
        reversibility: routingLevelSchema,
        regulatory_or_safety_risk: routingLevelSchema,
        real_usage_required: routingLevelSchema,
        marketplace_cold_start: routingLevelSchema,
        operational_burden: routingLevelSchema,
        founder_evidence: routingLevelSchema,
        concierge_delivery_fit: routingLevelSchema,
        app_store_required: routingLevelSchema,
        deep_native_requirements: routingLevelSchema,
        on_device_requirements: routingLevelSchema,
      })
      .strict(),
    needs: z
      .object({
        authenticated_product: z.boolean(),
        database: z.boolean(),
        file_storage: z.boolean(),
        transactional_email: z.boolean(),
        lifecycle_email: z.boolean(),
        feedback: z.boolean(),
        analytics: z.boolean(),
        search_discovery: z.boolean(),
        scheduled_learning: z.boolean(),
      })
      .strict(),
    preferred_dns_provider: z.enum(["mijndomein", "manual", "provider_api", "delegated"]),
    deceptive_request: z.boolean().default(false),
    unsafe_non_defaultable_choice: z.string().min(1).nullable().default(null),
    indispensable_missing_credential: z.string().min(1).nullable().default(null),
  })
  .strict();

export type FounderBrief = z.infer<typeof founderBriefSchema>;
export type RoutingLevel = z.infer<typeof routingLevelSchema>;

export type LaunchMode = z.infer<typeof launchModeSchema>;
export type ProductRail = z.infer<typeof appKindSchema>;
export type MobileStack = z.infer<typeof mobileStackSchema>;
export type CapabilityId = z.infer<typeof capabilityIdSchema>;
export type PaymentProvider = "none" | "stripe" | "revenuecat";

export interface RejectedLaunchMode {
  mode: LaunchMode;
  reason: string;
}

export interface LaunchModeDecision {
  selectedMode: LaunchMode;
  confidence: number;
  rationale: string;
  scores: Record<LaunchMode, number>;
  rejectedAlternatives: RejectedLaunchMode[];
  assumptions: string[];
  evidenceThatCouldChangeChoice: string[];
}

export interface RailDecision {
  appKind: ProductRail;
  mobileStack: MobileStack;
  rationale: string;
}

export interface PaymentDecision {
  provider: PaymentProvider;
  rationale: string;
  entitlementSource: "none" | "stripe" | "revenuecat";
}

export interface LaunchDecision {
  briefId: string;
  mode: LaunchModeDecision;
  rail: RailDecision;
  payment: PaymentDecision;
  capabilities: CapabilityId[];
}

export interface DryRunResource {
  provider: string;
  resource: string;
  environment: string;
  estimatedCost: number | "unknown";
}

export interface LaunchDryRun {
  synthetic: boolean;
  decision: LaunchDecision;
  eventPacks: EventPackId[];
  graph: WorkflowDefinition;
  resources: DryRunResource[];
  manualActions: {
    nodeId: string;
    purpose: string;
    requiredFields: readonly string[];
    effect: string;
    risk: "medium" | "high";
    rollback: string;
    completionEvidence: readonly string[];
    evidencePath: string;
  }[];
  criticalPath: string[];
  parallelLayers: string[][];
  authorizationRequirements: string[];
  verificationCommands: string[];
}

export class LaunchBriefError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_brief" | "deceptive_request" | "unsafe_choice" | "missing_credential",
  ) {
    super(message);
    this.name = "LaunchBriefError";
  }
}
