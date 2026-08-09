import type { AttributionClass } from "./attribution";
import type { CohortSnapshot } from "./subscriptions";
import type { WinnerEvaluation } from "./evaluator";

/**
 * The typed contract Winner Loop hands to DistributionPR.
 *
 * Every learning carries the evidence that produced it and the limits of that
 * evidence, because a downstream PR that says "the paywall is wrong" is only
 * worth acting on if the reader can see whether the underlying attribution
 * actually supports the claim. Causal language is reserved for evidence that
 * earns it.
 */

export type ProductSurface =
  | "landing_page"
  | "onboarding"
  | "paywall"
  | "pricing_presentation"
  | "app_store_metadata"
  | "app_store_screenshots"
  | "deep_links"
  | "tracking"
  | "cta"
  | "campaign_page"
  | "product_led_creative";

export type LearningConfidence = "suggestive" | "supported" | "strong";

export interface WinnerLoopLearning {
  readonly learningId: string;
  readonly ventureId: string;
  readonly creativeIds: readonly string[];
  readonly creativeFamilyId: string | null;
  readonly hypothesis: string;
  readonly providerContext: {
    readonly provider: string;
    readonly externalAccountId: string;
  };
  readonly organicWindow: { readonly start: string; readonly end: string } | null;
  readonly paidWindow: { readonly start: string; readonly end: string } | null;
  readonly attributionClass: AttributionClass;
  readonly creativeLevelCertainty: boolean;
  readonly acquisitionEconomics: {
    readonly spendMinor: number | null;
    readonly cacMinor: number | null;
    readonly roas: number | null;
    readonly currency: string;
  };
  readonly cohorts: readonly CohortSnapshot[];
  readonly observation: string;
  readonly recommendedSurface: ProductSurface;
  readonly proposedChange: string;
  readonly measurementPlan: string;
  readonly rollback: string;
  readonly confidence: LearningConfidence;
  readonly limitations: readonly string[];
  readonly createdAt: string;
}

/**
 * Confidence is capped by attribution quality. Correlated or unknown evidence
 * can never produce a "strong" learning no matter how large the numbers are.
 */
export function learningConfidenceFor(
  attributionClass: AttributionClass,
  creativeLevelCertainty: boolean,
  sampleSubscribers: number,
): LearningConfidence {
  if (!creativeLevelCertainty) return "suggestive";
  if (attributionClass === "DETERMINISTIC" && sampleSubscribers >= 30) return "strong";
  if (attributionClass === "DETERMINISTIC" || attributionClass === "PROVIDER_ATTRIBUTED") {
    return "supported";
  }
  return "suggestive";
}

export interface BuildLearningInput {
  learningId: string;
  ventureId: string;
  evaluation: WinnerEvaluation;
  cohorts: readonly CohortSnapshot[];
  hypothesis: string;
  provider: string;
  externalAccountId: string;
  organicWindow: { start: string; end: string } | null;
  paidWindow: { start: string; end: string } | null;
  createdAt: string;
}

/**
 * Turn an evaluation plus its cohorts into a DistributionPR-consumable learning.
 * The recommended surface follows from what the evidence actually says: reach
 * without intent points at the CTA, good intent with poor conversion points at
 * the paywall.
 */
export function buildLearning(input: BuildLearningInput): WinnerLoopLearning {
  const latest = input.cohorts[input.cohorts.length - 1];
  const attributionClass = latest?.attributionClass ?? "UNKNOWN";
  const creativeLevelCertainty = latest?.creativeLevelCertainty ?? false;
  const subscribers = latest?.metrics.initialSubscribers ?? 0;
  const trialToPaid = latest?.metrics.trialToPaid ?? null;

  let surface: ProductSurface = "product_led_creative";
  let observation: string;
  let proposedChange: string;

  if (input.evaluation.recommendation === "CREATE_VARIANTS") {
    surface = "cta";
    observation =
      "The creative earns attention but the audience does not act on it; reach is not the constraint.";
    proposedChange =
      "Test a sharper call to action and a matching landing destination before spending on this hook.";
  } else if (trialToPaid !== null && trialToPaid < 0.3) {
    surface = "paywall";
    observation = `Trials start but convert at ${(trialToPaid * 100).toFixed(1)}%, so the drop is after intent, not before it.`;
    proposedChange =
      "Review paywall framing and price presentation for the audience this creative brings.";
  } else if (input.evaluation.recommendation === "PAID_TEST_CANDIDATE") {
    surface = "campaign_page";
    observation = "Organic evidence and downstream intent both clear their thresholds.";
    proposedChange = "Build a dedicated campaign destination matching this creative's promise.";
  } else {
    observation = input.evaluation.interpretation;
    proposedChange = input.evaluation.proposedNextExperiment ?? "Iterate on the hook.";
  }

  const limitations = [...new Set(input.cohorts.flatMap((cohort) => cohort.limitations))];
  if (!creativeLevelCertainty) {
    limitations.push("Do not describe this as caused by the creative; attribution is not exact.");
  }

  return Object.freeze({
    learningId: input.learningId,
    ventureId: input.ventureId,
    creativeIds: Object.freeze([input.evaluation.creativeId]),
    creativeFamilyId: input.evaluation.creativeFamilyId,
    hypothesis: input.hypothesis,
    providerContext: Object.freeze({
      provider: input.provider,
      externalAccountId: input.externalAccountId,
    }),
    organicWindow: input.organicWindow ? Object.freeze({ ...input.organicWindow }) : null,
    paidWindow: input.paidWindow ? Object.freeze({ ...input.paidWindow }) : null,
    attributionClass,
    creativeLevelCertainty,
    acquisitionEconomics: Object.freeze({
      spendMinor: latest?.metrics.spendMinor ?? null,
      cacMinor: latest?.metrics.cacMinor ?? null,
      roas: latest?.metrics.roas ?? null,
      currency: latest?.currency ?? "EUR",
    }),
    cohorts: Object.freeze([...input.cohorts]),
    observation,
    recommendedSurface: surface,
    proposedChange,
    measurementPlan: `Re-evaluate ${input.evaluation.creativeId} against the same baseline and cohort windows after the change ships.`,
    rollback: "Revert the change and restore the previous surface; no provider state is affected.",
    confidence: learningConfidenceFor(attributionClass, creativeLevelCertainty, subscribers),
    limitations: Object.freeze(limitations),
    createdAt: input.createdAt,
  });
}
