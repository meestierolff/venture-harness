# Changelog

All notable changes to the Venture Harness template are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Ventures created from this template should reset this file at bootstrap.

## [Unreleased]

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
