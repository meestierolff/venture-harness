---
name: harness-engineering
description: Make the repository easier for the next agent run to understand and operate - audit instruction size, doc drift, weak errors, missing tests, and promote repeated corrections into docs, config, tests, evals, scripts, or lint rules. Use when corrections repeat or friction accumulates. Do not use for venture business decisions.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/harness-engineering/SKILL.md. Regenerate with: pnpm agents:sync -->

# harness-engineering

## Purpose

Improve the launch harness itself: reduce context and operational friction,
eliminate drift, preserve upgradeability, and promote corrections into the
cheapest durable mechanism — never by endlessly growing AGENTS.md.

## Trigger conditions

- The same correction appears ≥2–3 times in memory/corrections.jsonl.
- An agent run stumbled on unclear commands, stale docs, or unverifiable
  tasks.
- Scheduled maintenance of the template.

## When not to use

- Venture business/product decisions (business skills).
- Single-instance mistakes — record them with `pnpm outcome:add` and move
  on; promotion needs recurrence.

## Required inputs

- memory/corrections.jsonl, memory/LEARNINGS.md
- Current failing or friction-causing surface (doc, script, skill).

## Documents to read

AGENTS.md, ARCHITECTURE.md, `harness.lock`, relevant ADRs,
docs/engineering/HARNESS_ENGINEERING.md, docs/plans/TECH_DEBT.md, the active
plan, and the audit checklist in HARNESS_ENGINEERING.md.

## Files this skill may change

`docs/**`, `scripts/**`, `tests/**`, `evals/**`, `skills/**` (with
`pnpm agents:sync` after), harness-owned `lib/config|migrations|workflow|providers|upgrade/**`,
`config/quality.yaml`, `eslint.config.mjs`, `AGENTS.md` (last resort, keep under
~150 lines), `.github/workflows/*`, `docs/plans/TECH_DEBT.md`.

## Files this skill must not change

`memory/*.jsonl` except via append scripts; venture business docs'
content (structure fixes fine); `LICENSE`; generated directories
(`.agents/`, `.claude/skills/`) directly.

## Execution steps

1. Run the audit checklist from docs/engineering/HARNESS_ENGINEERING.md:
   instruction size, stale docs, missing architecture, code/docs drift,
   unclear commands, weak errors, missing tests, unclear boundaries,
   unsupported claims, stale active plans, repeated corrections,
   unverifiable tasks, uninspectable analytics/experiments, untested consent
   behaviour, provider no-ops, unredacted traces, migration conflicts, graph
   resume/idempotency, fixture coverage, empty scheduled runs, and managed drift.
2. For each finding, choose the cheapest durable fix using the promotion
   table (doc < config+schema < test/script < eval < skill rule <
   AGENTS.md).
3. Implement one conceptual improvement at a time. Add an idempotent migration
   and managed-file update when the correction must reach child ventures; run
   `pnpm agents:sync` if skills changed.
4. Record what was promoted and why in memory (via `pnpm outcome:add`)
   and, when notable, memory/LEARNINGS.md.
5. Update docs/plans/TECH_DEBT.md: add discovered debt, clear repaid debt.
6. Run `pnpm verify` and the narrowest affected staged profile; use release
   verification before publishing a harness version.

## Hard rules

- Do not solve recurring failures by growing AGENTS.md; it is a map.
- Every invariant needs an offline fixture path and must fail with the exact
  next action. Live provider checks are additional evidence, never the only test.
- Scripts stay idempotent and deterministic.
- Never weaken consent, PII, or approval rules as "cleanup".

## Expected output

A small, verified improvement (doc fix, new check, promoted rule), debt
ledger updated, memory entry recorded.

## Validation

`pnpm verify` and the affected profile pass; if a new check was added, it fails
correctly when the guarded invariant is broken (demonstrate once in the test).

## Failure behaviour

If the cheapest durable fix is unclear, record the options in
docs/plans/TECH_DEBT.md with a recommendation instead of guessing; do not
land a speculative mechanism.

## Human approval boundaries

Changes to AGENTS.md hard rules, approval boundaries, or CI required
checks need human review before merge — like every merge.
