import { launchContractSchema, type LaunchContract } from "@/lib/founder-launch";

export function launchReceiptContract(overrides: Partial<LaunchContract> = {}): LaunchContract {
  const base: LaunchContract = {
    schemaVersion: 1,
    venture: {
      name: "Launch Receipt",
      slug: "launch-receipt",
      oneSentenceThesis:
        "A truthful launch checklist and shareable receipt for indie SaaS founders.",
      targetUser: "Indie hackers preparing a small SaaS launch",
      painfulJob: "Launch requirements and proof are scattered across tools and notes",
      desiredOutcome: "Publish one honest read-only launch receipt",
      proposition:
        "Turn scattered launch requirements into one evidence-aware checklist and shareable receipt",
      differentiation: "Evidence status is explicit instead of implied by a checked box",
      founderAdvantage: "The founder has direct experience launching independent SaaS products",
    },
    product: {
      oneCoreFeature:
        "An authenticated persisted launch checklist with one public read-only receipt",
      primaryJourney: [
        "Sign in with email",
        "Create one launch checklist",
        "Edit checklist items and persist their state",
        "Publish the launch receipt",
        "Open the public read-only receipt",
      ],
      primaryCta: "Publish receipt",
      explicitNotBuilding: [
        "Project-management suite",
        "Customer organizations",
        "Customer Agent Surface",
        "Winner Loop or DistributionPR",
      ],
      designThesis:
        "A precise paper-ledger interface with evidence stamps and one memorable publish transition.",
      trustRequirements: [
        "Authentication",
        "Persisted state",
        "Analytics for the success signal without private checklist content",
        "Accessible mobile layout",
      ],
    },
    business: {
      model: "subscription",
      priceHypothesis: 9,
      currency: "EUR",
      paymentProvider: "stripe",
      commercialCommitmentEvent:
        "Non-transactional price interest recorded for the displayed EUR 9 monthly amount",
    },
    distribution: {
      firstChannel: "Warm founder outreach",
      firstUserHabitat: "Indie SaaS founder communities",
      initialMessage: "Turn scattered launch proof into one honest receipt.",
      firstValidationAction: "Ask ten relevant founders to complete and publish one receipt",
    },
    decision: {
      launchMode: "product_first",
      primarySuccessSignal: "launch_receipt_published",
      reviewDate: "2026-09-12",
      continueRule: "Continue when relevant founders publish real receipts",
      changeRule: "Change the journey when users start but cannot publish",
      stopRule: "Stop when the target founders do not value a shareable receipt",
    },
    truth: {
      facts: ["The founder supplied this rough product idea"],
      assumptions: ["A small monthly subscription may fit the workflow"],
      inferences: ["A public receipt is the smallest credible shareable outcome"],
      contradictions: [],
      unknowns: ["Whether founders will pay EUR 9 per month"],
      externalEvidence: [],
    },
    agentNative: {
      customerAgentSurfaceRequired: false,
      serviceBlueprintRequired: false,
      outcomeCommands: [],
    },
    capabilities: {
      frontend: "REQUIRED",
      backend: "REQUIRED",
      database: "REQUIRED",
      authentication: "REQUIRED",
      authorization: "REQUIRED",
      payments: "REQUIRED",
      entitlements: "REQUIRED",
      transactionalEmail: "NOT_APPLICABLE",
      analytics: "REQUIRED",
      privacyAndConsent: "REQUIRED",
      seo: "NOT_APPLICABLE",
      aeo: "NOT_APPLICABLE",
      geo: "NOT_APPLICABLE",
      agentSurface: "NOT_APPLICABLE",
      scheduledLearning: "NOT_APPLICABLE",
    },
  };
  return launchContractSchema.parse({ ...base, ...overrides });
}
