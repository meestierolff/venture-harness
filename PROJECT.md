# PROJECT

- Status: FRAMEWORK v0.2 — template, no venture loaded
- Owner: harness maintainers
- Last updated: 2026-08-04

## Purpose

Current state for agents and operators. This repository is the central Venture
Harness, not a launched child venture.

## Current state

The v0.2 implementation adds typed launch modes and capabilities, a durable
workflow runtime, credential and provider contracts, synthetic web/iOS launch
inputs, deterministic create-only Expo/SwiftUI scaffolds, normalized data
ingestion, four bounded learning cadences, versioned upgrade primitives, and
one-brief synchronization of venture, launch, mobile, and measurement
decisions. Provider composition includes local-source GitHub publication,
Vercel/Neon/Stripe plans, staged Brevo and Google DNS verification, and staged
EAS/App Store Connect read-back. The active work is
[Plan 001](docs/plans/active/001-venture-harness-v0.2.md).

No provider has been live-verified from this template. No child repository,
deployment, DNS record, payment resource, email sender, Apple app, TestFlight
build, or scheduled external job is recorded as created.

## Start a child venture

1. Copy and complete [inputs/VENTURE_BRIEF.yaml](inputs/VENTURE_BRIEF.yaml).
2. Run `vh auth login` and `vh doctor`.
3. Run `vh create --brief inputs/VENTURE_BRIEF.yaml`.
4. Inspect `vh plan` and `vh launch --dry-run`.
5. Apply only with a reviewed authorization profile.

The launch router chooses `validate_first`, `thin_mvp`, `product_first`, or
`concierge_first`. Missing non-critical detail becomes an assumption or backlog
item; the minimum progressive-commitment fields live in
[config/launch.yaml](config/launch.yaml).

## Evidence

- Typed contracts: [lib/config/](lib/config/)
- Launch routing and compilation: [lib/launch/](lib/launch/)
- Local mobile scaffold generation: [lib/mobile/](lib/mobile/)
- Durable runs: [lib/workflow/](lib/workflow/)
- Provider and credential contracts: [lib/providers/](lib/providers/),
  [lib/credentials/](lib/credentials/)
- Synthetic proofs: [fixtures/](fixtures/), [tests/](tests/)
- Upgrade lock: [harness.lock](harness.lock)

## Assumptions

- Provider transports require the founder's own accounts, scopes, credentials,
  authorization envelope, and account-specific verification.
- Generated application code remains venture-specific; the central harness
  supplies contracts and operating rails, not one visual identity.

## Unresolved questions

- Which provider paths pass live or sandbox read-back in the first authorized
  child venture?
- Which centrally managed files should ship in the first published v0.2 release
  manifest?

## Related documents

- [README.md](README.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [docs/product/PRODUCT_TRUTH.md](docs/product/PRODUCT_TRUTH.md)
- [docs/operations/FIRST_LAUNCH.md](docs/operations/FIRST_LAUNCH.md)
