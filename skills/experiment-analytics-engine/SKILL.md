---
name: experiment-analytics-engine
description: Design, implement, verify, and analyse behavioural tracking, consent, attribution, and controlled experiments for the demand-validation phase. Use for any analytics, consent, assignment, exposure, or experiment-analysis work. Do not use for deciding what to test — that is validation-engine.
---

# experiment-analytics-engine

## Purpose

Own the measurement machinery: capability-selected event packs, providers,
consent, experiment assignment/exposure, exact-price and commercial evidence,
attribution, data freshness, analysis, and analytics PII controls.

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

- config/analytics.yaml, config/experiments.yaml, venture active capabilities (validated)
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

1. Activate the smallest relevant packs from `core_product`, `web_acquisition`,
   `lead_generation`, `onboarding`, `authentication`, `subscription`,
   `one_time_payment`, `content`, `experiment`, `mobile`, `feedback`, and
   `reliability`; every core journey needs sufficient measurement.
2. Maintain aggregate, consented behavioural, and first-party commercial
   layers. First-party server-confirmed evidence is authoritative for material
   outcomes even when the selected providers differ by rail.
3. Keep config/analytics.yaml and typed taxonomy/packs in lockstep;
   `pnpm verify:analytics-events` must pass. No inactive pack is required.
4. Implement consent per config: strict mode loads nothing third-party
   before opt-in; withdrawal disables immediately; consent events go
   first-party only.
5. Implement experiments only when justified: deterministic assignment
   (lib/experiments.ts), first-party cookie persistence, eligibility →
   assignment → exposure event order, exposure only when the variant
   renders.
6. Record pricing exactly: displayed_offer and displayed_price strings
   stored verbatim with exposures and selections; verify with
   `pnpm verify:pricing-recording`.
7. Persist high-intent evidence server-side via app/api/evidence and
   app/api/lead; submissions must succeed independently of tracking.
8. Attribution: store first- and last-touch UTM + referrer domain with
   qualified submissions and conversions.
9. Normalize explicit reporting windows, timezone, source/account, fetched time,
   freshness, and sampling/threshold limitations; provider failure is visible.
10. Analyse at the configured cadence: funnels by layer, experiment exposures
    vs conversions, guardrails, consent-population caveats; write to reports/.
11. Report experiments only with: exposures per variant, primary metric,
    guardrails, sample limitations, and the pre-declared decision rule
    applied.

## Hard rules

- Aggregate and behavioral providers are supporting tools; first-party
  server-confirmed records are the source of truth for material evidence.
- No personal form values, raw search text, email addresses, keystrokes,
  session replay, cursor recording, or advertising features. Ever.
- No Google Analytics before consent in strict mode; consent withdrawable.
- Exact price shown must match exact price stored.
- High-intent submissions survive analytics failures.
- Experiments are optional and have primary metrics/stopping rules before start.
- One core concept per experiment.
- No automatic publication, deployment, or winner rollout.
- No scattered gtag calls — all tracking through lib/analytics/track.ts.

## Expected output

Working, verified tracking/consent/experiment code; taxonomy and config in
lockstep; analysis reports with limitations; updated ANALYTICS.md when
behaviour changes.

## Validation

`pnpm verify` plus the active capability profile (includes verify:consent, verify:analytics-events,
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
