# Changelog

All notable changes to the Venture Harness template are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Ventures created from this template should reset this file at bootstrap.

## [Unreleased]

### Added

- Typed `validate_first`, `thin_mvp`, `product_first`, and `concierge_first`
  routing for web, iOS, cross-platform, and hybrid briefs.
- A durable, resumable workflow runtime with authorization envelopes,
  checkpoints, idempotency, redacted traces, provider lifecycle evidence, and
  human/manual interrupts.
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

### Security

- External success requires provider read-back; credentials remain outside Git
  and durable state; tracked secret/PII scans, exact price evidence, product
  truth, migration safety, and distinct destructive checkpoints remain hard
  boundaries.

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
