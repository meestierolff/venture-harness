import type {
  CapabilityId,
  FounderBrief,
  LaunchDecision,
  LaunchMode,
  LaunchModeDecision,
  MobileStack,
  PaymentDecision,
  RailDecision,
  RoutingLevel,
} from "./types";
import { LaunchBriefError, founderBriefSchema } from "./types";

const levels: Record<RoutingLevel, number> = { unknown: 0, low: 1, moderate: 2, high: 3 };
const modeOrder: LaunchMode[] = ["thin_mvp", "product_first", "concierge_first", "validate_first"];

function reasonFor(mode: LaunchMode): string {
  switch (mode) {
    case "thin_mvp":
      return "The smallest useful product is reversible enough to build and learn from directly.";
    case "product_first":
      return "Real product usage or an installed app is required before value can be demonstrated honestly.";
    case "concierge_first":
      return "The outcome can be delivered honestly by a bounded concierge process before full automation.";
    case "validate_first":
      return "Build cost, risk, cold-start, or uncertainty makes a lower-cost demand test the safer first commitment.";
  }
}

function add(scores: Record<LaunchMode, number>, mode: LaunchMode, amount: number): void {
  scores[mode] += amount;
}

export function routeLaunchMode(input: FounderBrief): LaunchModeDecision {
  const brief = founderBriefSchema.parse(input);
  if (brief.deceptive_request) {
    throw new LaunchBriefError(
      "The requested product would be deceptive; revise the user promise and disclosures before building.",
      "deceptive_request",
    );
  }
  if (brief.unsafe_non_defaultable_choice) {
    throw new LaunchBriefError(
      `A material security, legal, or payment choice cannot be defaulted safely: ${brief.unsafe_non_defaultable_choice}`,
      "unsafe_choice",
    );
  }
  if (brief.indispensable_missing_credential) {
    throw new LaunchBriefError(
      `An indispensable provider credential or action is unavailable: ${brief.indispensable_missing_credential}`,
      "missing_credential",
    );
  }

  const f = brief.factors;
  const scores: Record<LaunchMode, number> = {
    validate_first: 0,
    thin_mvp: 1,
    product_first: 0,
    concierge_first: 0,
  };

  add(scores, "validate_first", levels[f.smallest_useful_build_cost]);
  add(scores, "validate_first", levels[f.smallest_useful_build_time]);
  add(scores, "thin_mvp", levels[f.reversibility]);
  add(scores, "product_first", Math.max(0, levels[f.reversibility] - 1));
  add(scores, "validate_first", levels[f.regulatory_or_safety_risk] * 2);
  add(scores, "product_first", levels[f.real_usage_required] * 2);
  add(scores, "thin_mvp", Math.max(0, levels[f.real_usage_required] - 1));
  add(scores, "validate_first", levels[f.marketplace_cold_start]);
  add(scores, "concierge_first", levels[f.marketplace_cold_start]);
  add(scores, "validate_first", levels[f.operational_burden]);
  add(scores, "thin_mvp", levels[f.founder_evidence]);
  add(scores, "product_first", levels[f.founder_evidence]);
  add(scores, "concierge_first", levels[f.concierge_delivery_fit] * 2);
  add(scores, "product_first", Math.max(0, levels[f.app_store_required] - 1) * 3);
  if (f.concierge_delivery_fit === "high" && f.regulatory_or_safety_risk !== "high") {
    add(scores, "concierge_first", 2);
  }
  if (
    f.smallest_useful_build_cost === "low" &&
    f.smallest_useful_build_time === "low" &&
    f.reversibility === "high"
  ) {
    add(scores, "thin_mvp", 4);
  }

  const ranked = modeOrder
    .map((mode) => ({ mode, score: scores[mode] }))
    .sort((a, b) => b.score - a.score || modeOrder.indexOf(a.mode) - modeOrder.indexOf(b.mode));
  const winner = ranked[0];
  const margin = winner.score - ranked[1].score;
  const confidence = Number(Math.min(0.96, 0.55 + Math.max(0, margin) * 0.07).toFixed(2));

  return {
    selectedMode: winner.mode,
    confidence,
    rationale: reasonFor(winner.mode),
    scores,
    rejectedAlternatives: ranked.slice(1).map(({ mode }) => ({
      mode,
      reason: `${reasonFor(mode)} Its routing score (${scores[mode]}) was below ${winner.mode} (${winner.score}).`,
    })),
    assumptions: [...brief.assumptions],
    evidenceThatCouldChangeChoice: [
      "A material change in smallest-useful build cost or reversibility.",
      "Evidence that real usage or an App Store artifact is indispensable.",
      "New regulatory, safety, cold-start, or operational constraints.",
      "Verified evidence that concierge delivery can or cannot produce the promised outcome honestly.",
    ],
  };
}

export function routeRail(brief: FounderBrief): RailDecision {
  let mobileStack: MobileStack = brief.requested_mobile_stack;
  if (brief.app_kind === "web") mobileStack = "none";
  else if (mobileStack === "auto") {
    mobileStack =
      brief.factors.deep_native_requirements === "high" ||
      brief.factors.on_device_requirements === "high"
        ? "swiftui"
        : "expo_react_native";
  }
  const rationale =
    mobileStack === "swiftui"
      ? "SwiftUI is selected for Apple-first deep native or on-device requirements."
      : mobileStack === "expo_react_native"
        ? "Expo React Native is selected for fast iteration, common device APIs, and shared TypeScript logic."
        : "The venture uses the default server-rendered Next.js web rail.";
  return { appKind: brief.app_kind, mobileStack, rationale };
}

export function routePayment(brief: FounderBrief): PaymentDecision {
  if (brief.monetization_model === "none" || brief.monetization_model === "lead_generation") {
    return {
      provider: "none",
      entitlementSource: "none",
      rationale: "No paid entitlement is active.",
    };
  }
  const mobile = brief.app_kind !== "web";
  if (mobile && brief.native_digital_goods) {
    return {
      provider: "revenuecat",
      entitlementSource: "revenuecat",
      rationale:
        "RevenueCat is the single entitlement source for native digital purchases; Test Store is used in development.",
    };
  }
  return {
    provider: "stripe",
    entitlementSource: "stripe",
    rationale:
      "Stripe is selected for the web or non-native payment flow and remains traceable to approved offer prices.",
  };
}

export function resolveCapabilities(
  brief: FounderBrief,
  rail: RailDecision,
  payment: PaymentDecision,
): CapabilityId[] {
  const active = new Set<CapabilityId>(["public_website"]);
  if (brief.needs.authenticated_product) active.add("authenticated_product");
  if (brief.needs.database) active.add("database");
  if (brief.needs.file_storage) active.add("file_storage");
  if (brief.needs.transactional_email) active.add("transactional_email");
  if (brief.needs.lifecycle_email) active.add("lifecycle_email");
  if (brief.needs.feedback) active.add("feedback_intake");
  if (brief.needs.analytics) {
    active.add("ga4");
    active.add("vercel_analytics");
  }
  if (brief.needs.search_discovery) {
    active.add("gsc");
    active.add("bing_webmaster");
    active.add("web_seo_aeo_geo");
  }
  if (brief.needs.scheduled_learning) active.add("scheduled_learning_loops");
  if (payment.provider === "stripe") active.add("stripe");
  if (payment.provider === "revenuecat") active.add("revenuecat");
  if (rail.appKind !== "web") {
    active.add("app_store_connect");
    active.add("ios_aso");
    if (rail.mobileStack === "expo_react_native") active.add("eas");
  }
  return [...active].sort();
}

export function routeLaunch(raw: FounderBrief): LaunchDecision {
  const brief = founderBriefSchema.parse(raw);
  const mode = routeLaunchMode(brief);
  const rail = routeRail(brief);
  const payment = routePayment(brief);
  return {
    briefId: brief.id,
    mode,
    rail,
    payment,
    capabilities: resolveCapabilities(brief, rail, payment),
  };
}
