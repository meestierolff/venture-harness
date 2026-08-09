import type { Metadata } from "next";
import { PricingTable, type PricingPlan } from "@/components/PricingTable";
import { SampleLabel } from "@/components/SampleLabel";
import { StructuredData } from "@/components/StructuredData";
import { TruthClaim } from "@/components/TruthClaim";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Prototype pricing page demonstrating the locally tested exact-displayed-price event contract.",
  alternates: { canonical: "/pricing" },
};

/**
 * TEMPLATE PLANS — placeholders demonstrating the plumbing. A venture's
 * plans come from config/offer.yaml at bootstrap; the strings rendered
 * here are the strings stored as evidence, so they must be built from the
 * reviewed config, never hardcoded ad hoc.
 */
const TEMPLATE_PLANS: PricingPlan[] = [
  {
    key: "template_core",
    name: "Core (template placeholder)",
    monthlyPrice: "Price not set — defined in config/offer.yaml at bootstrap",
    annualPrice: "Annual price not set — defined in config/offer.yaml at bootstrap",
    features: [
      "Plan structure defined by $offer-architect",
      "Exact displayed price recorded with every exposure and selection",
      "Setup fee and annual-waiver decisions rendered from config",
    ],
    cta: "Select (records evidence)",
  },
  {
    key: "template_pilot",
    name: "Pilot (template placeholder)",
    monthlyPrice: "Pilot price not set — defined in config/offer.yaml at bootstrap",
    annualPrice: "Pilot price not set — defined in config/offer.yaml at bootstrap",
    features: [
      "Pilot terms defined in docs/product/VALIDATION.md",
      "Selection recorded as pilot intent (Layer 3)",
    ],
    cta: "Select (records evidence)",
  },
];

export default function PricingPage() {
  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: "Pricing — Venture Harness template",
          description:
            "Template pricing page; real offers and prices are defined per venture at bootstrap.",
        }}
      />
      <h1>Pricing (template demonstration)</h1>
      <p>
        <SampleLabel kind="illustrative" /> These plans are placeholders.{" "}
        <TruthClaim id="truth-000">
          Local tests verify that price-bearing prototype events carry the exact displayed price
          string
        </TruthClaim>
        . Persistence still requires a configured evidence store; this page is not proof of a sale,
        customer, or production experiment.
      </p>
      <PricingTable plans={TEMPLATE_PLANS} />
    </>
  );
}
