# ADR-001: Progressive commitment and launch modes

- Status: accepted
- Date: 2026-08-04
- Deciders: founder `/goal`

## Context

Venture Harness v0.1 treats a 30–90 day demand-validation website as the only
safe starting point and blocks application code until a large commercial
document set and pricing experiment exist. That protects against premature
scope, but it also blocks reversible MVP work where real usage, an installed
app, or concierge delivery is the honest way to learn.

## Decision

Route every brief to one typed launch mode: `validate_first`, `thin_mvp`,
`product_first`, or `concierge_first`. Record confidence, assumptions,
rejected modes, and evidence that could change the choice. Require only an
intelligible user, problem, outcome, core journey, primary signal, material
constraints, and known truth to start. Missing non-critical facts become
explicit assumptions or backlog items.

Keep 30/60/90-day gates and controlled experiments as optional strategies.
Never relax truth, security, legal, payment, privacy, or irreversible-effect
blocks.

## Alternatives considered

| Alternative                      | Why not                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Keep validation-first universal  | It delays cheap, reversible learning and cannot serve app-store-dependent products.          |
| Let each agent choose informally | The choice would be uninspectable, inconsistent, and hard to migrate.                        |
| Always build a thin MVP          | Some offers remain safer and faster to validate through a page or honest concierge delivery. |

## Consequences

The harness can start useful work with fewer answers and must make routing
logic, assumptions, and risk explicit. Validation docs remain supported for
`validate_first`; they stop being universal launch blockers. The decision is
wrong if mode routing repeatedly creates avoidable irreversible effects or
produces less decision-quality evidence than the former process.
