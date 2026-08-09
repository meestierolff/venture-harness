---
name: learning-loops
description: Fetch normalized provider evidence and run bounded daily, weekly, biweekly, or monthly venture learning loops with freshness checks, decision rules, protected winners, limited actions, and propose/open-PR/autofix autonomy. Use for vh data sync and vh learn commands or scheduled evidence reviews; never act on absent data or autonomously change prices, claims, spend, outreach, privacy, destructive migrations, nameservers, or App Store publication.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/learning-loops/SKILL.md. Regenerate with: pnpm agents:sync -->

# learning-loops

## Purpose

Turn actual, freshness-labeled provider evidence into bounded decisions at the
right timescale without overreacting to tiny samples.

## Trigger conditions

- `vh data sync`, `vh learn daily|weekly|monthly`, a configured schedule, or a
  biweekly product review.

## When not to use

- Deciding experiment design before evidence collection.
- Generating a report from absent local CSVs without first attempting sync.

## Required inputs

Loop contract; normalized datasets; freshness/quality; release log; active
hypotheses/experiments; product truth; authorization and autonomy level.

## Documents to read

Read the venture/loop/measurement contracts, current decision log, relevant
discovery/analytics docs, and only sources activated for the loop.

## Files this skill may change

Normalized commit-safe summaries, freshness/cadence reports, dated learning
reports, proposed plans/issues/PRs, and low-risk deterministic fixes when the
configured autonomy permits them.

## Files this skill must not change

Raw provider exports by default, secret/PII data, prices, material claims,
outreach/spend/privacy, destructive migrations, nameservers, or store releases.

## Execution steps

1. Fetch each active provider source directly or record its exact auth/outage gap.
2. Normalize source/account, fetched time, window, timezone, dimensions,
   quality, sampling/threshold limits, and release version.
3. Reject stale/incompatible inputs for decisions; keep missing distinct from zero.
4. Run the selected loop's primary/guardrail metrics and predeclared rules.
5. Protect verified winners and distinguish technical bugs from conceptual tests.
6. Produce at most the configured actions (weekly default three; one active
   concept per affected journey) and respect max iterations/no-improvement stop.
7. Apply only the permitted autonomy: observe, report, propose, open PR, or
   narrowly defined low-risk autofix.
8. Update the cadence view with next dates, sources, hypotheses, experiments,
   blockers, freshness, and limitations.

## Hard rules

- No result without exposure/source data and limitations.
- No fabricated, silently zero-filled, incompatible-window, or stale evidence.
- First-party commercial records are authoritative for material outcomes.
- Daily loops prioritize health/flow defects and do not overreact to marketing noise.
- Autofix may repair verified technical/config/metadata drift only; it never
  changes price, offer, send/spend/privacy, destructive data, nameservers, or store release.

## Expected output

A dated, evidence-cited report with freshness, primary/guardrail results,
protected winners, bounded actions, limitations, autonomy effects, and next run.

## Validation

Run ingestion fixtures, missing/stale/anomaly behavior, report generation, and
scheduled workflow tests. A schedule must fetch or use explicitly labeled
fixtures before analysis.

## Failure behaviour

Report per-source failure and continue unaffected analysis. If decision inputs
are insufficient, output `insufficient evidence`, not a softened win.

## Human approval boundaries

Humans approve conceptual changes, experiment activation/results, price/claim
changes, publishing, sending, spend, privacy expansion, destructive data,
nameservers, and store release. PR creation follows configured autonomy; merge
remains human-gated unless separately and explicitly authorized.
