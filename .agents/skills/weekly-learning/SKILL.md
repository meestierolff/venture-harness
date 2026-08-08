---
name: weekly-learning
description: Compatibility entry point for the weekly demand, funnel, pricing, discovery, product, and reliability review. Use only when explicitly invoked for a weekly cadence; delegate ingestion, freshness, bounded analysis, and output to the weekly mode of $learning-loops. Never merge, deploy, publish, send, or act on missing data.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/weekly-learning/SKILL.md. Regenerate with: pnpm agents:sync -->

# weekly-learning

## Purpose

Preserve the familiar explicit weekly entry point while using the v0.2
data-aware learning-loop contract.

## Trigger conditions

- Explicit weekly review invocation or a weekly schedule.

## When not to use

- Daily health, biweekly product, monthly strategy, or unscheduled feature work.

## Required inputs

The weekly loop definition, active sources, freshness report, release log,
hypotheses/experiments, product truth, and current authorization/autonomy.

## Documents to read

Read `$learning-loops`, the current cadence/measurement docs, and
`references/v0.1-weekly-review.md` only for an old report migration.

## Files this skill may change

Weekly reports, cadence state, proposed plans/issues/PRs, and verified low-risk
fixes only when the loop autonomy permits them.

## Files this skill must not change

Raw exports, secrets/PII, prices, material claims, outreach/spend/privacy,
destructive data, nameservers, or store releases.

## Execution steps

1. Run `vh data sync`, then validate source freshness and limitations.
2. Invoke `vh learn weekly` / the weekly mode of `$learning-loops`.
3. Review acquisition, search/AEO/GEO/ASO, activation, checkout, qualified
   conversion, subscription, feedback, reliability, and protected winners only
   where active capabilities provide evidence.
4. Return at most three high-confidence actions by default, with one active
   conceptual hypothesis per affected journey and unlimited verified bug fixes.
5. Record limitations, autonomy effects, next run, and required approvals.

## Hard rules

- No result without source/exposure data, freshness, and limitations.
- Missing is not zero; no empty scheduled report is called a review.
- Do not overreact to small samples or overwrite protected winners.
- Default autonomy is propose/open PR, not publish or merge.

## Expected output

A dated weekly report with source quality, protected winners, bounded actions,
limitations, next run, and any exact blocker.

## Validation

Run weekly ingestion/report fixtures, missing/stale behavior, and the applicable
quality profile.

## Failure behaviour

Continue with unaffected sources and mark the decision `insufficient evidence`
when required inputs are absent or stale.

## Human approval boundaries

Conceptual changes, experiment decisions, prices, claims, publishing, sending,
spend, destructive effects, store actions, and merge remain human-gated.
