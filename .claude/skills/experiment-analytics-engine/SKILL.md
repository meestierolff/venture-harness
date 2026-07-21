---
name: experiment-analytics-engine
description: Design, implement, verify, and analyse behavioural tracking, consent, attribution, and controlled experiments for the demand-validation phase. Use for any analytics, consent, assignment, exposure, or experiment-analysis work. Do not use for deciding what to test — that is validation-engine.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/experiment-analytics-engine/SKILL.md. Regenerate with: pnpm agents:sync -->

# experiment-analytics-engine

## Purpose

Own the measurement machinery: event taxonomy, providers, consent
implementation, experiment assignment and exposure, pricing-test
recording, commercial-intent persistence, attribution, weekly funnel
analysis, experiment reports, and analytics PII controls.

## Trigger conditions

- Implementing or changing tracking, consent, or experiment code.
- Activating an approved experiment definition.
- Analysing experiment or funnel data; preparing the analytics part of the
  weekly report.
- Any change to config/analytics.yaml or lib/analytics/.

## When not to use

- Choosing hypotheses, thresholds, or decision rules ($validation-engine).
- SEO measurement (GSC/Bing) — that is $seo-aeo-engine.

## Required inputs

- config/analytics.yaml, config/experiments.yaml (validated)
- lib/analytics/taxonomy.ts, lib/experiments.ts, lib/consent.ts
- docs/engineering/ANALYTICS.md, docs/legal/ANALYTICS_AND_CONSENT.md

## Documents to read

AGENTS.md, docs/engineering/ANALYTICS.md, BACKEND.md,
docs/product/EXPERIMENTS.md, docs/legal/ANALYTICS_AND_CONSENT.md,
config/analytics.yaml, config/experiments.yaml.

## Files this skill may change

`lib/analytics/**`, `lib/experiments.ts`, `lib/consent.ts`,
`app/api/evidence/**`, `app/api/lead/**`, tracking call sites in
`components/**` and `app/**`, `config/analytics.yaml`,
`config/experiments.yaml` (implementation fields), `tests/**`,
`docs/engineering/ANALYTICS.md`, `reports/experiments/*`,
`reports/analytics/*`.

## Files this skill must not change

`docs/product/VALIDATION.md` thresholds, `config/venture.yaml` decision
thresholds, `docs/product/PRODUCT_TRUTH.md`, `skills/**`, `AGENTS.md`.

## Execution steps

1. Maintain the three layers: Vercel Web Analytics (aggregate), GA4
   (consented behaviour), Neon (first-party commercial evidence — the
   source of truth).
2. Keep config/analytics.yaml and lib/analytics/taxonomy.ts in lockstep;
   `pnpm verify:analytics-events` must pass.
3. Implement consent per config: strict mode loads nothing third-party
   before opt-in; withdrawal disables immediately; consent events go
   first-party only.
4. Implement experiments: deterministic assignment
   (lib/experiments.ts), first-party cookie persistence, eligibility →
   assignment → exposure event order, exposure only when the variant
   renders.
5. Record pricing exactly: displayed_offer and displayed_price strings
   stored verbatim with exposures and selections; verify with
   `pnpm verify:pricing-recording`.
6. Persist high-intent evidence server-side via app/api/evidence and
   app/api/lead; submissions must succeed independently of tracking.
7. Attribution: store first- and last-touch UTM + referrer domain with
   qualified submissions and conversions.
8. Analyse weekly: funnels by layer, experiment exposures vs conversions,
   guardrails, consent-population caveats; write to reports/.
9. Report experiments only with: exposures per variant, primary metric,
   guardrails, sample limitations, and the pre-declared decision rule
   applied.

## Hard rules

- Vercel and GA4 are supporting tools; Neon is the source of truth for
  material commercial evidence.
- No personal form values, raw search text, email addresses, keystrokes,
  session replay, cursor recording, or advertising features. Ever.
- No Google Analytics before consent in strict mode; consent withdrawable.
- Exact price shown must match exact price stored.
- High-intent submissions survive analytics failures.
- Experiments have primary metrics and stopping rules before start.
- One core concept per experiment.
- No automatic publication, deployment, or winner rollout.
- No scattered gtag calls — all tracking through lib/analytics/track.ts.

## Expected output

Working, verified tracking/consent/experiment code; taxonomy and config in
lockstep; analysis reports with limitations; updated ANALYTICS.md when
behaviour changes.

## Validation

`pnpm verify` (includes verify:consent, verify:analytics-events,
verify:analytics-pii, verify:experiment-assignment,
verify:pricing-recording) plus `pnpm test`.

## Failure behaviour

If a check cannot run (e.g. no built server for raw-HTML checks), state
what, why, the missing evidence, and the exact next action. Never report
tracking as verified without the scripts having run.

## Human approval boundaries

Activating experiments (approved → running), stopping them early, and
acting on results are human decisions. This skill never rolls out winners
automatically and never enables a provider the config does not allow.
