# PROJECT

- Status: TEMPLATE — no venture loaded
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

This file holds the current state of the venture built from this repository.
Agents read it first. It answers: what venture is this, what stage is it in,
what is the current focus, and what decision is pending.

In the template, it is intentionally empty of venture facts.

## Current venture

None. This repository is the Venture Harness template.

To start a venture:

1. Create a new repository from this template.
2. Fill in `inputs/VENTURE_BRIEF.md` and `inputs/DESIGN_BRIEF.md`.
3. Run `pnpm init:venture -- --name "<venture-name>"`.
4. Invoke the `$venture-bootstrap` skill with your coding agent.

## Stage

`template` — see `config/venture.yaml` for the stage contract. Venture stages:
`ideation → demand_validation → build | iterate | reposition | stopped`.

## Current focus

Not applicable in the template. After bootstrap, this section names the one
active plan (under `docs/plans/active/`) and the one experiment concept
currently under test.

## Pending decisions

None.

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [AGENTS.md](AGENTS.md)
- [docs/business/OFFER.md](docs/business/OFFER.md)
- [docs/product/VALIDATION.md](docs/product/VALIDATION.md)
- [docs/plans/active/](docs/plans/active/)
