import type { Metadata } from "next";
import { LeadForm } from "@/components/LeadForm";
import { SampleLabel } from "@/components/SampleLabel";
import { SectionViewTracker } from "@/components/SectionViewTracker";
import { StructuredData } from "@/components/StructuredData";
import { TruthClaim } from "@/components/TruthClaim";
import { SITE_URL } from "@/lib/site-config";

const GITHUB_QUICKSTART = "https://github.com/meestierolff/venture-harness#five-minute-quickstart";
const GITHUB_FEATURE_STATUS =
  "https://github.com/meestierolff/venture-harness/blob/main/docs/product/FEATURE_STATUS.md";

const publicClaimIds = [
  "truth-001",
  "truth-002",
  "truth-007",
  "truth-029",
  "truth-032",
  "truth-033",
  "truth-042",
] as const;

export const metadata: Metadata = {
  title: "Open-source launch factory — founder alpha",
  description:
    "Venture Harness is an open-source founder-alpha Core for locally tested Launch Contracts, focused app seeds, bounded launch plans, and conservative Launch Receipts.",
  alternates: { canonical: "/" },
  other: { "product-truth-claims": publicClaimIds.join(" ") },
};

export default function HomePage() {
  return (
    <>
      <StructuredData
        claimIds={[...publicClaimIds]}
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareSourceCode",
          name: "Venture Harness founder alpha",
          description:
            "Open-source Core with locally and fixture-tested launch contracts, focused app seeds, bounded launch plans, and conservative launch receipts. No live provider result is implied.",
          codeRepository: "https://github.com/meestierolff/venture-harness",
          license: "https://opensource.org/license/mit",
          programmingLanguage: "TypeScript",
          url: SITE_URL.toString(),
        }}
      />

      <SectionViewTracker sectionId="hero">
        <div className="hero-layout">
          <p className="hero-status">
            <span>Founder alpha</span>
            <span aria-hidden="true">/</span>
            <span>Open source</span>
          </p>

          <h1 className="hero-title">A launch path you can inspect before it touches the world.</h1>

          <p className="hero-summary">
            <TruthClaim id="truth-033">
              Venture Harness includes a locally and fixture-tested standalone app seed with
              optional advanced packs excluded by default
            </TruthClaim>
            .{" "}
            <TruthClaim id="truth-029">
              Its locally tested Launch Contract keeps the user, outcome, journey, capability map,
              truth boundaries, and not-building list in one reviewable object
            </TruthClaim>
            .
          </p>

          <p className="hero-boundary">
            <strong>Current boundary:</strong>{" "}
            <TruthClaim id="truth-042">
              the local prototype uses internally owned Codex CLI hosts with credential-free stdin
              context and a separate provider runtime; it is not a perfect OS-isolation boundary
            </TruthClaim>
            . Live dogfood and provider read-backs are not presented as complete.
          </p>

          <a className="primary-action" href={GITHUB_QUICKSTART}>
            <span>Open the five-minute quickstart</span>
            <span aria-hidden="true">↗</span>
          </a>

          <p className="hero-meta">Source checkout · Node 22.5+ · pnpm 9.15.9 · MIT</p>

          <figure className="launch-map" aria-labelledby="launch-map-title">
            <div className="launch-map__header">
              <figcaption id="launch-map-title">The idea-to-evidence rail</figcaption>
              <SampleLabel kind="illustrative" />
            </div>

            <div className="launch-map__input" aria-label="Reviewed founder input">
              <span className="launch-map__input-code">IDEA / 01</span>
              <p>One narrow user. One useful outcome. One explicit boundary.</p>
            </div>

            <ol className="launch-map__stages">
              <li>
                <span className="stage-index">01</span>
                <strong>Contract</strong>
                <small>reviewed locally</small>
              </li>
              <li>
                <span className="stage-index">02</span>
                <strong>Seed</strong>
                <small>fixture tested</small>
              </li>
              <li>
                <span className="stage-index">03</span>
                <strong>Plan</strong>
                <small>bounded effects</small>
              </li>
              <li className="stage-external">
                <span className="stage-index">04</span>
                <strong>Accounts</strong>
                <small>read-back required</small>
              </li>
              <li className="stage-receipt">
                <span className="stage-index">05</span>
                <strong>Receipt</strong>
                <small>states stay distinct</small>
              </li>
            </ol>

            <div className="launch-map__legend" aria-label="Illustration legend">
              <span>
                <i className="legend-local" /> local or fixture evidence
              </span>
              <span>
                <i className="legend-external" /> external proof boundary
              </span>
            </div>
          </figure>
        </div>
      </SectionViewTracker>

      <SectionViewTracker sectionId="how-it-works">
        <div className="page-section operating-section">
          <div className="section-heading">
            <p className="section-index">01 / Operating path</p>
            <h2>Keep every commitment reviewable.</h2>
            <p>
              The public path is deliberately narrow. Deterministic plumbing does the repeatable
              work; authorization and evidence remain visible.
            </p>
          </div>

          <ol className="operating-path">
            <li>
              <div className="path-command">
                <code>vh idea sharpen</code>
              </div>
              <div>
                <h3>Fix the decision surface</h3>
                <p>
                  Start from a complete Launch Contract. A valid contract needs no model call, and
                  malformed contract-like input fails closed.
                </p>
              </div>
              <span className="path-state">zero-model path</span>
            </li>
            <li>
              <div className="path-command">
                <code>vh launch --dry-run</code>
              </div>
              <div>
                <h3>See the work before approving it</h3>
                <p>
                  <TruthClaim id="truth-001">
                    The locally tested router selects a typed mode, rail, payment source, and
                    dry-run graph from valid input
                  </TruthClaim>
                  .
                </p>
              </div>
              <span className="path-state">no provider effect</span>
            </li>
            <li>
              <div className="path-command">
                <code>vh resume</code>
              </div>
              <div>
                <h3>Pause without pretending</h3>
                <p>
                  <TruthClaim id="truth-002">
                    The tested local runtime persists redacted state, pauses, resumes, and reuses
                    verified idempotent effects
                  </TruthClaim>
                  .
                </p>
              </div>
              <span className="path-state">same run</span>
            </li>
            <li>
              <div className="path-command">
                <code>launch-receipt.json</code>
              </div>
              <div>
                <h3>Separate requested from verified</h3>
                <p>
                  <TruthClaim id="truth-032">
                    The locally tested receipt records planned, requested, waiting, fixture, and
                    verified evidence as different states
                  </TruthClaim>
                  .
                </p>
              </div>
              <span className="path-state">sanitized evidence</span>
            </li>
          </ol>
        </div>
      </SectionViewTracker>

      <SectionViewTracker sectionId="proof">
        <div className="page-section evidence-section">
          <div className="section-heading section-heading--compact">
            <p className="section-index">02 / Evidence boundary</p>
            <h2>Founder alpha, without the theatre.</h2>
          </div>

          <div className="evidence-board">
            <div className="evidence-board__local">
              <p className="evidence-label">What the repository supports locally</p>
              <h3>A focused foundation, not a finished company.</h3>
              <p>
                <TruthClaim id="truth-033">
                  The ordinary web seed is locally and fixture tested as a standalone Next.js
                  foundation, with optional advanced packs excluded by default
                </TruthClaim>
                . The contract, dry run, workflow state, and receipt stay open for inspection.
              </p>
            </div>

            <div className="evidence-board__external">
              <p className="evidence-label">What still needs real-world proof</p>
              <ul>
                <li>A founder-owned child repository and reachable deployment</li>
                <li>Provider resources confirmed through account read-back</li>
                <li>A product-specific live journey and reviewed Core upgrade</li>
              </ul>
              <p>No customer, sale, demand signal, or production reliability result is implied.</p>
            </div>
          </div>

          <a className="text-action" href={GITHUB_FEATURE_STATUS}>
            Audit the complete feature status on GitHub <span aria-hidden="true">→</span>
          </a>
        </div>
      </SectionViewTracker>

      <SectionViewTracker sectionId="quickstart">
        <div className="page-section quickstart-section">
          <div className="quickstart-copy">
            <p className="section-index">03 / First run</p>
            <h2>Stop at the dry run first.</h2>
            <p>
              The five-minute path installs Core, validates the workspace, and prepares a
              zero-provider-effect review. Connecting accounts, building product work, and proving a
              live launch are separate steps.
            </p>
          </div>

          <div className="terminal" aria-label="Quickstart command preview">
            <div className="terminal__bar">
              <span>LOCAL / NO PROVIDER EFFECT</span>
              <span>01—04</span>
            </div>
            <pre>
              <code>
                {
                  "git clone https://github.com/meestierolff/venture-harness.git\ncd venture-harness\ncorepack enable\npnpm install --frozen-lockfile\npnpm verify:fast"
                }
              </code>
            </pre>
          </div>
        </div>
      </SectionViewTracker>

      <SectionViewTracker sectionId="apply">
        <div className="page-section prototype-section">
          <details className="prototype-lab">
            <summary>
              <span>
                <SampleLabel kind="prototype" />
                <strong>Open the local evidence-form demo</strong>
              </span>
              <span aria-hidden="true" className="summary-mark">
                +
              </span>
            </summary>
            <div className="prototype-lab__body">
              <div>
                <h2>Prototype submission path</h2>
                <p>
                  This is not a contact channel or live application.{" "}
                  <TruthClaim id="truth-007">
                    When storage is configured, the prototype attempts to save the private
                    submission before best-effort analytics; without a store, its API returns an
                    error, and form values are excluded from the analytics taxonomy
                  </TruthClaim>
                  .
                </p>
              </div>
              <LeadForm />
            </div>
          </details>
        </div>
      </SectionViewTracker>
    </>
  );
}
