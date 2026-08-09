import type { Metadata } from "next";
import Link from "next/link";
import { SectionViewTracker } from "@/components/SectionViewTracker";
import { SampleLabel } from "@/components/SampleLabel";
import { StructuredData } from "@/components/StructuredData";
import { TruthClaim } from "@/components/TruthClaim";
import { LeadForm } from "@/components/LeadForm";

export const metadata: Metadata = {
  title: "Launch operating-system prototype",
  description:
    "Venture Harness v0.2: a tested local prototype for typed launch planning, resumable execution, provider operations, and evidence loops.",
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareSourceCode",
          name: "Venture Harness v0.2 prototype",
          description:
            "Open-source template with locally tested launch planning and workflow runtime. It is not evidence of a launched child venture.",
          url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
        }}
      />

      <SectionViewTracker sectionId="hero">
        <SampleLabel kind="illustrative" />
        <h1>One brief becomes a launch plan you can inspect, authorize, pause, and resume.</h1>
        <p>
          Venture Harness v0.2 is a local prototype, not proof of a live venture.{" "}
          <TruthClaim id="truth-001">
            Its tested router selects a launch mode, product rail, payment source, and dry-run graph
            from a typed founder brief
          </TruthClaim>
          .{" "}
          <TruthClaim id="truth-002">
            Its tested workflow runtime persists redacted state, pauses for manual work, resumes the
            same run, and reuses verified effects
          </TruthClaim>
          . Provider plans and end-to-end fixtures use mocks until an authorized account is read
          back; they do not claim a production deployment.
        </p>
        <p>
          <Link href="/pricing">See the pricing-evidence demo →</Link>
        </p>
      </SectionViewTracker>

      <SectionViewTracker sectionId="how-it-works">
        <h2>From progressive commitment to evidence</h2>
        <ol>
          <li>
            Give <code>vh create</code> the specific user, problem, useful outcome, smallest
            journey, success signal, constraints, truths, and assumptions.
          </li>
          <li>
            Inspect <code>vh plan</code> and <code>vh launch --dry-run</code>.
          </li>
          <li>
            Apply one time-bounded authorization profile. Reversible work may proceed; unsafe or
            genuinely manual work remains an explicit checkpoint.
          </li>
          <li>
            Verify the core journey, ingest direct data, and run bounded learning loops. A 30/60/90
            decision cadence is optional for <code>validate_first</code>, not a universal gate.
          </li>
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
        <h2>Qualification form (prototype evidence path)</h2>
        <p>
          This sample form is not a live lead channel.{" "}
          <TruthClaim id="truth-007">
            When storage is configured, the prototype attempts to save the private submission before
            best-effort analytics; without a store, its API returns an error, and form values are
            excluded from the analytics taxonomy
          </TruthClaim>
          .
        </p>
        <LeadForm />
      </SectionViewTracker>
    </>
  );
}
