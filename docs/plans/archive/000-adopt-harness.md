# Plan 000: Adopt the harness

- Status: archived (superseded by Venture Harness v0.2 work)
- Owner: founder
- Created: 2026-07-21
- Archived: 2026-08-04

## Goal

Take this repository from template state to a bootstrapped venture ready
for design and build of the validation website.

## Steps

1. Fill in `inputs/VENTURE_BRIEF.md` — honest, specific, unpolished. (human)
2. Fill in `inputs/DESIGN_BRIEF.md`. (human)
3. Optionally seed `inputs/RESEARCH.md` with sourced evidence. (human)
4. Run `pnpm init:venture -- --name "<venture-name>"`. (human)
5. Invoke `$venture-bootstrap`. It will interrogate the briefs, surface
   gaps, and produce the business/product/brand/growth documents, the
   validation plan, the event map, and the first active plan. (agent)
6. Review everything the bootstrap produced; resolve its listed
   contradictions and open questions. (human)

## Done when

- `PROJECT.md` describes the venture, not the template.
- `pnpm verify` passes.
- A new active plan exists for building the validation website.

## Out of scope

Application code, design implementation, deployment — all gated behind a
coherent bootstrap. This restriction was superseded for harness v0.2 by the
progressive-commitment decision recorded in ADR-001.
