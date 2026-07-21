---
name: design-director
description: Run the original-design process for a venture from brief to audited design system — art directions, thesis, colour, typography, logo direction, signature moment, responsive composition, accessibility, anti-template audit. Use for creating or reviewing visual identity. Do not use for copy strategy or SEO structure.
---

# design-director

## Purpose

Enforce a design **process**, not a visual style: take
`inputs/DESIGN_BRIEF.md` and produce an original, accessible,
distinctly-owned design system for this venture — and audit the result
against template-slop and copying.

## Trigger conditions

- Building the validation website's design after bootstrap.
- A redesign or design review request.
- The visual-reviewer subagent flags template-like or copied design.

## When not to use

- Pure copy/content changes; SEO structure ($seo-aeo-engine); component
  plumbing with no visual identity impact.

## Required inputs

- inputs/DESIGN_BRIEF.md (non-empty), inputs/VENTURE_BRIEF.md
- docs/business/ICP.md, docs/brand/BRAND.md
- Rendered pages (browser) once implementation exists.

## Documents to read

AGENTS.md, docs/brand/DESIGN.md, BRAND.md, REFERENCES.md, COPY.md,
docs/business/ICP.md, references/anti-slop-checklist.md (in this skill),
config/quality.yaml (accessibility thresholds).

## Files this skill may change

`docs/brand/*`, `app/**` and `components/**` styling and composition,
`public/**` design assets, `PROJECT.md` (pending decisions).

## Files this skill must not change

`lib/analytics/**`, `lib/experiments.ts`, `app/api/**`, `config/*.yaml`
except via proposals, `docs/product/PRODUCT_TRUTH.md`, tracking call
sites' semantics (moving them is fine; removing them is not).

## Execution steps

1. Product analysis: what the product does and what must be understood.
2. ICP analysis: who is looking, what they distrust, what they respect.
3. Emotional outcome: the feeling ten seconds in, written down.
4. Reference-principle analysis into docs/brand/REFERENCES.md — principles
   only, never pixels.
5. Three distinct art directions, each with essence and a rough sketch of
   hero + pricing treatment.
6. Select one design thesis; record why the others lost.
7. Original colour system (contrast ≥ WCAG AA, tokens named).
8. Original typography (pairing + scale, rationale).
9. Original logo direction — not a standard icon beside a wordmark.
10. One signature product moment (the interaction people remember).
11. Meaningful product visualisation — labeled illustrative interfaces if
    the product is not yet real; never fake screenshots presented as real.
12. Desktop composition per page.
13. Re-composed mobile design — not stacked desktop sections.
14. Accessibility pass: contrast, focus states, keyboard order,
    reduced-motion.
15. Restrained motion: purpose per animation, `prefers-reduced-motion`
    respected.
16. Browser inspection of implemented pages (desktop + mobile viewports).
17. Screenshot review against the thesis.
18. Anti-template audit (references/anti-slop-checklist.md).
19. Anti-copy audit against every reference in REFERENCES.md.
20. Final refinement pass; record the system in docs/brand/DESIGN.md.

## Hard rules

Disallowed by default: generic purple AI gradients, glowing AI orbs,
arbitrary glassmorphism, six identical feature cards, random bento grids,
floating cards without purpose, generic stock illustrations, copied Framer
layouts, standard-icon-plus-wordmark presented as bespoke logo, desktop
sections merely stacked on mobile, copy competitors could use unchanged.
The design brief governs identity; this skill governs process and quality.
Sample data and demo interfaces carry visible labels.

## Expected output

Completed docs/brand/DESIGN.md (thesis, directions, system, audits),
implemented styles matching it, screenshots reviewed, accessibility
checked.

## Validation

`pnpm verify` passes; anti-slop checklist appended to DESIGN.md with every
item explicitly cleared or justified; visual-reviewer subagent pass on
rendered desktop + mobile.

## Failure behaviour

If the design brief is empty or contradicts the ICP, stop and record the
contradiction in PROJECT.md pending decisions. If an audit item fails,
iterate before sign-off — do not ship with a noted violation.

## Human approval boundaries

The founder approves the chosen art direction and the final system before
implementation effort scales. Publishing any design publicly (deploy) is
human-gated as always.
