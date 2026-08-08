import { EVENTS, type Destination, type EventName } from "./taxonomy";

export const EVENT_PACK_IDS = [
  "core_product",
  "web_acquisition",
  "lead_generation",
  "onboarding",
  "authentication",
  "subscription",
  "one_time_payment",
  "content",
  "experiment",
  "mobile",
  "feedback",
  "reliability",
] as const;

export type EventPackId = (typeof EVENT_PACK_IDS)[number];
export type MeasurementStage = "build" | "launch" | "operate";

export interface EventPackDefinition {
  id: EventPackId;
  description: string;
  stages: readonly MeasurementStage[];
  capabilitiesAny: readonly string[];
  requiredDestinations: readonly Destination[];
  freshnessSources: readonly string[];
  events: readonly EventName[];
  privacy: {
    piiAllowed: false;
    rawFormValuesAllowed: false;
    exactPriceRequired: boolean;
  };
}

/**
 * The reusable vocabulary is broad; an individual venture activates only the
 * packs returned by resolveActiveEventPacks (plus explicit opt-ins).
 */
export const EVENT_PACKS = {
  core_product: {
    id: "core_product",
    description: "Smallest useful journey, proposition, consent, and authoritative outcome.",
    stages: ["build", "launch", "operate"],
    capabilitiesAny: [],
    requiredDestinations: ["neon"],
    freshnessSources: ["neon_commercial_evidence"],
    events: [
      "core_journey_started",
      "core_journey_completed",
      "hero_primary_cta_click",
      "hero_secondary_cta_click",
      "proposition_detail_open",
      "how_it_works_view",
      "use_case_view",
      "consent_banner_view",
      "analytics_accepted",
      "analytics_declined",
      "consent_settings_opened",
      "consent_changed",
      "consent_withdrawn",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: false },
  },
  web_acquisition: {
    id: "web_acquisition",
    description: "Public-site visits, routes, attribution, navigation, and return behaviour.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["public_website"],
    requiredDestinations: ["vercel", "ga4"],
    freshnessSources: ["ga4"],
    events: [
      "site_visit",
      "page_view",
      "landing_page_view",
      "route_change",
      "outbound_link_click",
      "navigation_click",
      "mobile_navigation_open",
      "return_visit",
      "repeat_pricing_view",
      "repeat_high_intent_visit",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: false },
  },
  lead_generation: {
    id: "lead_generation",
    description: "Lead or concierge intent from first form view through server confirmation.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["public_website", "feedback_intake"],
    requiredDestinations: ["ga4", "neon"],
    freshnessSources: ["ga4", "neon_commercial_evidence"],
    events: [
      "pilot_selected",
      "enterprise_contact_selected",
      "reservation_intent",
      "form_view",
      "form_started",
      "form_step_completed",
      "form_validation_error",
      "form_abandoned",
      "form_submitted",
      "form_submission_confirmed",
      "qualification_completed",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: true },
  },
  onboarding: {
    id: "onboarding",
    description: "Product onboarding and first activation without entered field values.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["authenticated_product"],
    requiredDestinations: ["neon"],
    freshnessSources: ["neon_commercial_evidence"],
    events: [
      "onboarding_started",
      "onboarding_step_completed",
      "onboarding_completed",
      "activation_completed",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: false },
  },
  authentication: {
    id: "authentication",
    description: "Authentication attempts, confirmed outcomes, and safe failure categories.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["authenticated_product"],
    requiredDestinations: ["neon"],
    freshnessSources: ["neon_commercial_evidence"],
    events: ["authentication_started", "authentication_succeeded", "authentication_failed"],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: false },
  },
  subscription: {
    id: "subscription",
    description: "Exact-price subscription checkout and server-confirmed lifecycle changes.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["stripe", "revenuecat"],
    requiredDestinations: ["neon"],
    freshnessSources: ["neon_commercial_evidence"],
    events: [
      "pricing_page_view",
      "pricing_section_view",
      "pricing_variant_exposed",
      "billing_period_changed",
      "pricing_details_open",
      "setup_fee_explanation_open",
      "guarantee_explanation_open",
      "plan_selected",
      "monthly_plan_selected",
      "annual_plan_selected",
      "checkout_intent",
      "subscription_checkout_started",
      "subscription_started",
      "subscription_renewed",
      "subscription_payment_failed",
      "subscription_canceled",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: true },
  },
  one_time_payment: {
    id: "one_time_payment",
    description: "Exact-price one-time checkout and server-confirmed payment outcome.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["stripe"],
    requiredDestinations: ["neon"],
    freshnessSources: ["neon_commercial_evidence", "stripe"],
    events: [
      "checkout_intent",
      "one_time_checkout_started",
      "one_time_payment_completed",
      "one_time_payment_failed",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: true },
  },
  content: {
    id: "content",
    description: "Intentional content, proof, samples, resources, and classified site search.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["web_seo_aeo_geo"],
    requiredDestinations: ["ga4"],
    freshnessSources: ["ga4", "gsc"],
    events: [
      "section_view",
      "proof_view",
      "sample_open",
      "sample_download",
      "demo_interaction",
      "comparison_view",
      "faq_open",
      "video_start",
      "video_complete",
      "resource_open",
      "site_search_started",
      "site_search_submitted",
      "site_search_no_results",
      "site_search_result_selected",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: false },
  },
  experiment: {
    id: "experiment",
    description: "Optional eligibility, assignment, exposure, conversion, and guardrails.",
    stages: ["operate"],
    capabilitiesAny: [],
    requiredDestinations: ["neon"],
    freshnessSources: ["neon_commercial_evidence"],
    events: [
      "hero_variant_exposed",
      "icp_variant_exposed",
      "experiment_eligible",
      "experiment_assigned",
      "experiment_exposed",
      "experiment_primary_conversion",
      "experiment_guardrail_event",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: true },
  },
  mobile: {
    id: "mobile",
    description: "Mobile app usage, release-aware core outcome, and store-subscription intent.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["app_store_connect", "eas", "ios_aso"],
    requiredDestinations: ["ga4", "neon"],
    freshnessSources: ["app_store_connect_analytics", "release_log"],
    events: [
      "mobile_app_opened",
      "mobile_core_journey_completed",
      "mobile_store_subscription_started",
    ],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: true },
  },
  feedback: {
    id: "feedback",
    description: "Feedback entry and server-confirmed de-identified classification only.",
    stages: ["launch", "operate"],
    capabilitiesAny: ["feedback_intake"],
    requiredDestinations: ["neon"],
    freshnessSources: ["feedback"],
    events: ["feedback_intake_opened", "feedback_submitted"],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: false },
  },
  reliability: {
    id: "reliability",
    description: "Runtime and critical-journey failures classified without private payloads.",
    stages: ["build", "launch", "operate"],
    capabilitiesAny: [],
    requiredDestinations: ["neon"],
    freshnessSources: ["release_log"],
    events: ["page_error", "critical_journey_failed"],
    privacy: { piiAllowed: false, rawFormValuesAllowed: false, exactPriceRequired: false },
  },
} as const satisfies Record<EventPackId, EventPackDefinition>;

export interface MeasurementContext {
  capabilities: readonly string[];
  appKind: "web" | "mobile_ios" | "mobile_cross_platform" | "hybrid";
  monetizationModel: string;
  leadJourney?: boolean;
  experimentRunning?: boolean;
  explicitPacks?: readonly EventPackId[];
}

export function resolveActiveEventPacks(context: MeasurementContext): EventPackId[] {
  const capabilities = new Set(context.capabilities);
  const active = new Set<EventPackId>(["core_product", "reliability"]);
  if (capabilities.has("public_website")) active.add("web_acquisition");
  if (capabilities.has("web_seo_aeo_geo")) active.add("content");
  if (capabilities.has("authenticated_product")) {
    active.add("authentication");
    active.add("onboarding");
  }
  if (context.leadJourney || ["lead_generation", "services"].includes(context.monetizationModel)) {
    active.add("lead_generation");
  }
  if (
    ["subscription", "hybrid"].includes(context.monetizationModel) &&
    (capabilities.has("stripe") || capabilities.has("revenuecat"))
  ) {
    active.add("subscription");
  }
  if (["one_time", "hybrid"].includes(context.monetizationModel) && capabilities.has("stripe")) {
    active.add("one_time_payment");
  }
  if (context.appKind !== "web") active.add("mobile");
  if (capabilities.has("feedback_intake")) active.add("feedback");
  if (context.experimentRunning) active.add("experiment");
  for (const pack of context.explicitPacks ?? []) active.add(pack);
  return EVENT_PACK_IDS.filter((pack) => active.has(pack));
}

export const CORE_JOURNEYS = {
  core_product: {
    requiredPacks: ["core_product"],
    startEvents: ["core_journey_started"],
    outcomeEvents: ["core_journey_completed"],
  },
  lead_generation: {
    requiredPacks: ["lead_generation"],
    startEvents: ["form_started"],
    outcomeEvents: ["form_submission_confirmed", "qualification_completed"],
  },
  authenticated_product: {
    requiredPacks: ["authentication", "onboarding"],
    startEvents: ["authentication_started", "onboarding_started"],
    outcomeEvents: ["authentication_succeeded", "activation_completed"],
  },
  subscription: {
    requiredPacks: ["subscription"],
    startEvents: ["subscription_checkout_started"],
    outcomeEvents: ["subscription_started"],
  },
  one_time_payment: {
    requiredPacks: ["one_time_payment"],
    startEvents: ["one_time_checkout_started"],
    outcomeEvents: ["one_time_payment_completed"],
  },
  mobile: {
    requiredPacks: ["mobile"],
    startEvents: ["mobile_app_opened"],
    outcomeEvents: ["mobile_core_journey_completed"],
  },
  feedback: {
    requiredPacks: ["feedback"],
    startEvents: ["feedback_intake_opened"],
    outcomeEvents: ["feedback_submitted"],
  },
} as const satisfies Record<
  string,
  {
    requiredPacks: readonly EventPackId[];
    startEvents: readonly EventName[];
    outcomeEvents: readonly EventName[];
  }
>;

export type CoreJourneyId = keyof typeof CORE_JOURNEYS;

/**
 * A journey is active only when every pack needed to measure its start and
 * authoritative outcome is active. This keeps quality checks and generated
 * config derived from the same routing decision as the event packs.
 */
export function resolveActiveCoreJourneys(activePacks: readonly EventPackId[]): CoreJourneyId[] {
  const active = new Set(activePacks);
  return (Object.keys(CORE_JOURNEYS) as CoreJourneyId[]).filter((journeyId) =>
    CORE_JOURNEYS[journeyId].requiredPacks.every((pack) => active.has(pack)),
  );
}

export interface MeasurementValidationInput {
  activePacks: readonly EventPackId[];
  activeJourneys: readonly CoreJourneyId[];
  configuredDestinations: readonly Destination[];
  freshness: Readonly<Record<string, "fresh" | "stale" | "missing">>;
}

export interface MeasurementIssue {
  code:
    | "pack_missing"
    | "journey_start_missing"
    | "journey_outcome_missing"
    | "destination_unconfigured"
    | "commercial_outcome_not_first_party"
    | "freshness_unknown";
  message: string;
  nextAction: string;
}

export function validateMeasurementPlan(input: MeasurementValidationInput): MeasurementIssue[] {
  const activePacks = new Set(input.activePacks);
  const activeEvents = new Set<EventName>(
    input.activePacks.flatMap((pack) => [...EVENT_PACKS[pack].events]),
  );
  const configuredDestinations = new Set(input.configuredDestinations);
  const issues: MeasurementIssue[] = [];

  for (const journeyId of input.activeJourneys) {
    const journey = CORE_JOURNEYS[journeyId];
    for (const pack of journey.requiredPacks) {
      if (!activePacks.has(pack)) {
        issues.push({
          code: "pack_missing",
          message: `${journeyId} requires active event pack ${pack}.`,
          nextAction: `Activate ${pack}; inactive packs remain optional.`,
        });
      }
    }
    if (!journey.startEvents.some((event) => activeEvents.has(event))) {
      issues.push({
        code: "journey_start_missing",
        message: `${journeyId} has no active start event.`,
        nextAction: `Activate a pack containing one of: ${journey.startEvents.join(", ")}.`,
      });
    }
    const activeOutcomes = journey.outcomeEvents.filter((event) => activeEvents.has(event));
    if (activeOutcomes.length === 0) {
      issues.push({
        code: "journey_outcome_missing",
        message: `${journeyId} has no active outcome event.`,
        nextAction: `Activate a pack containing one of: ${journey.outcomeEvents.join(", ")}.`,
      });
    }
    for (const event of activeOutcomes) {
      if (!EVENTS[event].neon) {
        issues.push({
          code: "commercial_outcome_not_first_party",
          message: `${journeyId} outcome ${event} lacks first-party persistence.`,
          nextAction: `Add a neon leg to ${event}; provider analytics remains supporting evidence.`,
        });
      }
    }
  }

  const requiredDestinations = new Set<Destination>();
  const requiredFreshness = new Set<string>();
  for (const pack of input.activePacks) {
    EVENT_PACKS[pack].requiredDestinations.forEach((destination) =>
      requiredDestinations.add(destination),
    );
    EVENT_PACKS[pack].freshnessSources.forEach((source) => requiredFreshness.add(source));
  }
  for (const destination of requiredDestinations) {
    if (!configuredDestinations.has(destination)) {
      issues.push({
        code: "destination_unconfigured",
        message: `Active event packs require ${destination}, but it is not configured.`,
        nextAction: `Configure and verify the ${destination} destination or deactivate the dependent pack.`,
      });
    }
  }
  for (const source of requiredFreshness) {
    if (!(source in input.freshness)) {
      issues.push({
        code: "freshness_unknown",
        message: `Data freshness for ${source} is unknown.`,
        nextAction: `Run vh data sync and retain a freshness status for ${source}; missing is not zero.`,
      });
    }
  }
  return issues;
}

export function eventNamesForPacks(packs: readonly EventPackId[]): EventName[] {
  const selected = new Set<EventName>();
  for (const pack of packs) EVENT_PACKS[pack].events.forEach((event) => selected.add(event));
  return Object.keys(EVENTS).filter((event): event is EventName =>
    selected.has(event as EventName),
  );
}
