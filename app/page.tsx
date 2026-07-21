import type { Metadata } from "next";
import Link from "next/link";
import { SectionViewTracker } from "@/components/SectionViewTracker";
import { SampleLabel } from "@/components/SampleLabel";
import { StructuredData } from "@/components/StructuredData";
import { TruthClaim } from "@/components/TruthClaim";
import { LeadForm } from "@/components/LeadForm";

export const metadata: Metadata = {
  title: "Validation-site foundation",
  description:
    "The Venture Harness validation-site foundation: consent, typed analytics, experiments, and first-party evidence — awaiting a venture's identity.",
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "Venture Harness template",
          description:
            "Template validation-site foundation. Replaced at venture bootstrap with the venture's own organization data.",
          url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
        }}
      />

      <SectionViewTracker sectionId="hero">
        <h1>This is the validation-site foundation, waiting for a venture.</h1>
        <p>
          Everything operational already works on this page:{" "}
          <TruthClaim id="truth-000">
            consent-gated analytics, a typed event taxonomy, deterministic experiment assignment,
            and first-party evidence recording that stores the exact price a visitor was shown
          </TruthClaim>
          . What it deliberately lacks is an identity — the <code>$venture-bootstrap</code> and{" "}
          <code>$design-director</code> skills replace this copy and design with the venture&apos;s
          own.
        </p>
        <p>
          <Link href="/pricing">See the pricing-evidence demo →</Link>
        </p>
      </SectionViewTracker>

      <SectionViewTracker sectionId="how-it-works">
        <h2>How a venture uses this page</h2>
        <ol>
          <li>
            Fill in the briefs under <code>inputs/</code>.
          </li>
          <li>Run the bootstrap skill — it refuses to build before the offer is coherent.</li>
          <li>Replace this placeholder with the venture&apos;s hero, proof, pricing, and form.</li>
          <li>Run it for 30–90 days as a measured commercial experiment.</li>
        </ol>
      </SectionViewTracker>

      <SectionViewTracker sectionId="proof">
        <h2>Proof section</h2>
        <p>
          <SampleLabel kind="illustrative" /> A real venture places verifiable proof here — each
          claim wrapped in a <code>TruthClaim</code> that must trace to the product-truth register.
          The template ships none, because fabricating proof is the first thing this framework
          forbids.
        </p>
      </SectionViewTracker>

      <SectionViewTracker sectionId="apply">
        <h2>Qualification form (live demo of the evidence path)</h2>
        <p>
          Submissions persist server-side before any analytics fires, and entered values never reach
          third-party analytics. In template state, submissions land in the local dev fallback.
        </p>
        <LeadForm />
      </SectionViewTracker>
    </>
  );
}
