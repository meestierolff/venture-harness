---
name: venture-bootstrap
description: Turn an ideation brief and design brief into a coherent venture repository and measurable validation-website plan. Use when starting a new venture from filled-in inputs/ briefs, or when project docs are template-empty. Do not use for redesigns, new experiments, or feature work on an already-bootstrapped venture.
---

# venture-bootstrap

## Purpose

Convert `inputs/VENTURE_BRIEF.md` and `inputs/DESIGN_BRIEF.md` into a
coherent set of project documents, configuration, and an active execution
plan — and refuse to let application code be written before the venture's
commercial logic is coherent.

## Trigger conditions

- A new repository created from the template with filled-in briefs.
- `PROJECT.md` still says "TEMPLATE — no venture loaded".
- The founder asks to "start", "bootstrap", or "set up" the venture.

## When not to use

- The venture is already bootstrapped (PROJECT.md names a venture) — use
  the specific skill for the change instead.
- The briefs are empty — stop and ask the founder to fill them in; do not
  invent a venture.

## Required inputs

- `inputs/VENTURE_BRIEF.md` (non-empty)
- `inputs/DESIGN_BRIEF.md` (non-empty)
- `inputs/RESEARCH.md` (optional)
- Current project documents and codebase state.

## Documents to read

AGENTS.md, PROJECT.md, all of `docs/business/`, `docs/product/`,
`docs/brand/BRAND.md`, `docs/growth/DISTRIBUTION.md`,
`docs/engineering/ANALYTICS.md`, `config/*.yaml`,
`references/bootstrap-blockers.md` (in this skill).

## Files this skill may change

`PROJECT.md`, `docs/business/*`, `docs/product/*`, `docs/brand/*`,
`docs/growth/*`, `config/venture.yaml`, `config/offer.yaml`,
`config/experiments.yaml`, `config/analytics.yaml` (event additions only),
`docs/plans/active/*`, `memory/*.jsonl` (via append scripts only).

## Files this skill must not change

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `skills/**`, `scripts/**`,
`.agents/**`, `.claude/**`, `app/**`, `components/**`, `lib/**`
(no application code during bootstrap), `.github/**`, `LICENSE`.

## Execution steps

1. Read the briefs and research. List every claim they make, tagged
   fact / belief / hope.
2. Interrogate: identify contradictions, missing evidence, assumptions,
   unsupported claims, unpriced service work, unclear target users,
   unmeasurable goals, missing qualification criteria, and missing launch
   infrastructure. Write the list into PROJECT.md → Pending decisions.
3. Run `$offer-architect` to produce OFFER/ICP/PRICING/ECONOMICS/
   COMPETITION and `config/offer.yaml`, including the deterministic
   thirty-day cash calculation.
4. Run `$validation-engine` to produce VALIDATION.md: demand hypotheses,
   thresholds, qualification rule, 30/60/90-day gates, stop rules — and
   fill the validation block of `config/venture.yaml`.
5. Define the behavioural event map: confirm every journey in
   USER_JOURNEYS.md is covered by events in `config/analytics.yaml`;
   propose additions if the venture needs them (one PR-sized change).
6. Set consent mode and confirm the analytics/consent plan against
   `docs/legal/ANALYTICS_AND_CONSENT.md`.
7. Define at least one pricing experiment in `config/experiments.yaml`
   (status: draft) with variants carrying exact displayed offers/prices.
8. Draft brand/design foundations: BRAND.md identity table from the design
   brief; leave DESIGN.md system decisions to `$design-director`.
9. Draft SEO plan (page register rows for planned routes) and distribution
   plan (habitat map skeleton with the founder's known channels).
10. Write the launch-readiness checklist state into `config/venture.yaml`
    (infrastructure block, all false) covering domain, Vercel, Neon, GA4,
    Google Search Console, Bing Webmaster Tools.
11. Write the 30-to-90-day validation plan and weekly review instructions
    into VALIDATION.md, referencing `pnpm weekly`.
12. Replace `docs/plans/active/000-adopt-harness.md` with the venture's
    first real plan (design + build the validation website).
13. Update PROJECT.md: venture summary, stage `demand_validation`
    (pre-launch), current focus, pending decisions.
14. Run `pnpm verify`; fix anything it reports.

## Hard rules

- Do not write application code until ALL of these are coherent: ICP,
  pain, measurable outcome, offer, first useful result, pricing
  hypothesis, thirty-day cash hypothesis, validation event taxonomy,
  analytics architecture, consent mode, at least one pricing experiment
  hypothesis, product-truth boundaries, and an active plan.
- Never invent facts the briefs do not contain — record gaps as open
  questions instead.
- Every number in config comes from the briefs, research, or an explicit
  labeled assumption.
- Reject generic ICPs; force narrowing before proceeding.

## Expected output

Coherent PROJECT.md, business docs, product docs (incl. product truth
boundaries), brand and design briefs, SEO plan, distribution plan,
analytics and consent plan, experiment plan with ≥1 pricing experiment,
30-to-90-day validation plan, launch-readiness checklist, architecture
notes if deviating from defaults, and one active execution plan.

## Validation

`pnpm verify` passes; `pnpm validate:docs` shows no template-state
required docs; the bootstrap-blocker list in
`references/bootstrap-blockers.md` is empty or every remaining item is in
PROJECT.md → Pending decisions.

## Failure behaviour

If a blocker cannot be resolved from the briefs: stop, list the blocker
under PROJECT.md → Pending decisions with the exact question the founder
must answer, and report per AGENTS.md progress rules. Never fill the gap
with invention.

## Human approval boundaries

Bootstrap writes documents and config only. It never: registers domains,
creates cloud resources, sends messages, publishes, charges, deploys, or
merges. The founder reviews and approves the bootstrap output before any
build work starts.
