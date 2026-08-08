# Plan 001: Venture Harness v0.2

- Status: active
- Owner: harness maintainers
- Created: 2026-08-04
- Authorised by: founder `/goal` received 2026-08-04

## Goal

Turn the v0.1 validation template into a tested, agent-neutral launch operating
system for web, iOS, and hybrid MVPs without weakening truth, privacy, price,
secret, migration, accessibility, or verification boundaries.

## Scope and authorization

The founder authorised repository inspection, local implementation, tests,
commits, a pushed branch, and a draft pull request. This run may use mocks and
official dry-run surfaces, but it may not create or delete production provider
resources, deploy production, change DNS, send email, charge anyone, submit an
App Store release, or merge the pull request. Those remain explicit runtime
authorization-envelope effects.

## Vertical slices

1. Record the v0.1-to-v0.2 decisions and migrate typed configuration.
2. Add credentials, authorization, provider contracts, and redaction.
3. Add the durable graph runtime and the `vh` CLI.
4. Add launch-mode and product-rail routing plus provider plans/adapters.
5. Add staged verification, event packs, ingestion, and learning loops.
6. Add web SaaS and iOS subscription fixtures with resume/idempotency tests.
7. Refactor canonical skills, regenerate adapters, and update operating docs.
8. Run release verification, audit claims, commit, and open a draft PR.

## Graph

The executable work decomposition is
[`001-venture-harness-v0.2.graph.yaml`](001-venture-harness-v0.2.graph.yaml).
Every edge names data consumed downstream. Parallel nodes have disjoint primary
outputs; integration happens in one node after their validators pass.

## Completion criteria

- Both synthetic fixtures compile, dry-run, execute mock/local nodes, pause at
  honest manual nodes, resume, and rerun without duplicate effects.
- v0.1 configuration upgrades idempotently and the lock updates only after
  verification.
- `vh doctor`, `plan`, `launch`, `status`, `resume`, `cancel`, `explain`,
  `data sync`, `learn`, and `upgrade` have executable help and tested paths.
- Applicable fast, MVP, and release checks pass; skipped live checks identify
  the credential, command, and expected evidence.
- Canonical skills and generated adapters have parity.
- No secret, real PII, fabricated provider state, or unverified public claim is
  committed.
- The work is committed and a draft PR is opened when GitHub auth permits.

## Stop conditions

Stop only for an external prerequisite that cannot be represented as a manual
action, a required destructive effect outside the authorization above, or a
failure that remains terminal after its bounded retry and documented safe
alternatives.
