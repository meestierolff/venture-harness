# Changelog

All notable changes to the Venture Harness template are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Ventures created from this template should reset this file at bootstrap.

## [Unreleased]

All entries below describe locally or fixture-verified prototype behavior. No
live provider resource, customer result, publication, deployment, advertising
spend, or package release is implied.

### Added

- A 30-package pnpm workspace with explicit ESM/CommonJS/type exports, five app
  composition boundaries, dependency/cycle checks, atomic builds, package
  allowlists, and clean packed-consumer verification.
- One typed command catalog and command bus that generate direct, REST, CLI,
  MCP, SDK, and UI Agent Surfaces behind shared identity, tenant, subscription,
  entitlement, grant, scope, schema, request-bound idempotency, audit, event,
  and metering checks.
- Immutable Launch Grants, three versioned venture seeds, independent
  materialization, Venture/Connector manifests, and v2 locks with
  `core_owned`, `merge_managed`, and `venture_owned` behavior.
- A recursive SQLite runtime for venture/customer organizations, memberships,
  subscriptions, entitlements, Service Blueprints/Grants, agent grants,
  tenant-scoped provider connections/credentials/resources, usage reservation,
  webhook routing, offboarding, and chained audit evidence.
- Capability-first provider SDK/registry boundaries and complete lifecycle
  contracts for discover, estimate, plan, apply, read-back, reconcile, and
  compensate.
- A fixture-verified Fleet controller with release digests, affected-venture
  selection, canary-first bounded batches, venture-specific checks, pause on
  non-verified results, ownership-preserving upgrade, and rollback/forward-fix
  reporting.
- The optional Winner Loop pack: durable creative identity/lineage, rights and
  disclosure manifests, scheduled metrics, baseline-adjusted evaluation,
  exact paid proposals, human-approved Spend Grants, transactional multi-level
  caps, attribution, RevenueCat-style cohorts, a disabled-by-default first-party
  event pack, provider-incapable fixture adapters, locally tested
  transport-injected live-mode contracts, and the 34-step fixture-only
  production-boundary proof. No live-mode contract is a configured or verified
  provider integration.

- Typed `validate_first`, `thin_mvp`, `product_first`, and `concierge_first`
  routing for web, iOS, cross-platform, and hybrid briefs.
- A durable, resumable workflow runtime with authorization envelopes,
  checkpoints, request-bound idempotency, write-ahead event recovery, redacted
  traces, queues, steering/supersede, budgets/costs, bounded loops,
  reconciliation, compensation, provider lifecycle evidence, and typed
  auth/external/human interrupts.
- The `vh` command surface for auth, diagnosis, one-brief creation, planning,
  launch/resume/cancel, direct data sync, bounded learning, and versioned child
  upgrades.
- Provider-neutral credential references and dry-run/apply adapters for the
  declared GitHub, Vercel, Neon, Stripe, RevenueCat, Brevo, Google, Bing, DNS,
  EAS, and App Store Connect surfaces.
- Capability-aware fast, MVP, and release profiles; synthetic web/iOS launch
  fixtures; deterministic Expo/SwiftUI scaffolds; and desktop/mobile browser
  checks.
- Versioned v0.1-to-v0.2 config migration, managed-file lock, local release
  upgrade planning, conflict detection, verification, and rollback.

### Changed

- Progressive commitment replaces the universal validation-site and mandatory
  pricing-experiment model. Missing non-critical facts remain labeled
  assumptions instead of blocking reversible local work.
- Analytics now uses capability-selected event packs and direct normalized data
  contracts. Daily, weekly, biweekly, and monthly learning loops stop on missing
  or stale required evidence.
- The SEO/AEO skill is now a concise discovery router; the preserved v0.1
  detail, technical discovery, GEO, and ASO playbooks live in focused
  references.
- Core upgrades now distinguish the three v2 ownership classes and Fleet
  rollout preserves venture identity, design, copy, Service Blueprints, and
  provider choices instead of treating child repositories as template clones.
- Generated Agent Surfaces share one command implementation; the operational
  source CLI remains an explicit v0.2 compatibility bridge.

### Security

- External success requires provider read-back; credentials remain outside Git
  and durable state; tracked secret/PII scans, exact price evidence, product
  truth, migration safety, and distinct destructive checkpoints remain hard
  boundaries.
- Provider and spend idempotency now bind complete canonical requests. Ambiguous
  external outcomes remain reserved and blocked until read-back reconciliation;
  only confirmed no-write can release and retry.

## [0.1.0] - 2026-07-21

### Added

- Initial public template: agent-neutral constitution (AGENTS.md) with thin
  Codex, Claude Code, Gemini CLI, and GitHub Copilot adapters.
- Thirteen canonical skills under `skills/` with generated copies for Codex
  (`.agents/skills/`) and Claude Code (`.claude/skills/`).
- Deterministic script layer: skill sync, agent parity, doc/link/claim
  validation, analytics/consent/experiment verification, weekly demand
  analysis, memory appenders, framework health, public-release check.
- Three-layer analytics architecture (Vercel Web Analytics, GA4, first-party
  Neon evidence) with typed event taxonomy and strict-consent default.
- Visually neutral Next.js validation-site foundation with consent banner,
  experiment assignment, evidence API, and labeled placeholder content.
- Configuration contracts under `config/` validated with Zod schemas.
- Versioned market memory (`memory/*.jsonl`) and weekly learning loop.
- Eight Claude subagent definitions and safe optional hooks.
- Sample synthetic venture under `examples/sample-venture/`.
- CI workflows: quality, agent parity, public release, weekly analysis.
