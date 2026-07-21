# ARCHITECTURE

How the Venture Harness is put together and why. For the venture lifecycle
itself, see [docs/product/VALIDATION.md](docs/product/VALIDATION.md).

## Layers

```
┌────────────────────────────────────────────────────────────┐
│ Adapters (thin, per-agent)                                 │
│ CLAUDE.md · GEMINI.md · .github/copilot-instructions.md    │
│ .agents/skills/ · .claude/skills/  (generated, committed)  │
├────────────────────────────────────────────────────────────┤
│ Canon (agent-neutral source of truth)                      │
│ AGENTS.md · skills/ · docs/ · config/ · memory/ · evals/   │
├────────────────────────────────────────────────────────────┤
│ Plumbing (deterministic, no model calls)                   │
│ scripts/ · tests/ · .github/workflows/                     │
├────────────────────────────────────────────────────────────┤
│ Product foundation (visually neutral, operationally full)  │
│ app/ · components/ · lib/ · public/                        │
└────────────────────────────────────────────────────────────┘
```

Rules of the layering:

- Adapters may point down into the canon; they never hold unique rules.
- Skills are procedures; current venture state lives in `docs/` and
  `config/`, never inside a skill.
- Scripts encode every transformation that must be reproducible: skill
  syncing, parity checking, validation, aggregation, calculators.
- The product foundation imports its contracts (event taxonomy, experiment
  definitions, consent policy) from `lib/` + `config/`, so checks can verify
  code against configuration.

## Skill distribution

`skills/<name>/` is canonical. `pnpm agents:sync`
([scripts/sync-agent-skills.ts](scripts/sync-agent-skills.ts)) copies each
skill to `.agents/skills/<name>/` (Codex) and `.claude/skills/<name>/`
(Claude Code), inserting a generated-file marker after the frontmatter and
excluding target-irrelevant files (Codex metadata is not copied to Claude).
Copies are committed so agents need no build step. `pnpm agents:check`
recomputes expected output and fails on drift, stale folders, duplicate
names, or adapter/doc contradictions. No symlinks — the tree works on
macOS, Linux, Windows, and GitHub Actions.

## Data flows

**Demand evidence (runtime):**

```
visitor → app/ pages
  ├─ Layer 1: Vercel Web Analytics (aggregate, consent-gated per config)
  ├─ Layer 2: GA4 via lib/analytics/track.ts (opt-in, PII-free, typed events)
  └─ Layer 3: app/api/evidence → Neon (assignments, exposures, exact prices,
              qualified submissions; JSONL fallback in dev only)
```

**Learning loop (weekly):**

```
data/seo/inbox/*.csv + data/analytics/inbox/*.csv + Neon exports + memory/*.jsonl
  → scripts/run-weekly-demand-analysis.ts → reports/weekly/YYYY-Www.md
  → $weekly-learning skill proposes ONE change → human review → merge
  → outcome appended to memory/ via scripts/append-outcome.ts
```

Memory files are append-only JSONL, committed to git, so market outcomes are
versioned alongside the code that produced them.

## Experiment model

Experiments are declared in [config/experiments.yaml](config/experiments.yaml)
(schema in [lib/config/schemas.ts](lib/config/schemas.ts)). Assignment is
deterministic — `hash(visitorId, experimentId) → variant` in
[lib/experiments.ts](lib/experiments.ts) — persisted in a first-party cookie,
recorded server-side as `experiment_assigned`, and `experiment_exposed` fires
only when a variant actually renders. The exact offer and price displayed are
stored with every exposure and conversion so analysis never reconstructs them.
One core concept changes per experiment; stopping rules are declared before
start.

## Safety architecture

Self-improvement is proposal-based. Agents may write to
`docs/plans/active/`, open PR-shaped proposals via
`scripts/propose-improvement.ts`, and append to `memory/`. They may not:
send, publish, charge, deploy, merge, or enable scheduled external actions.
Those boundaries appear in AGENTS.md (constitution), each SKILL.md (approval
boundaries section), subagent definitions, and are re-checked by
`scripts/public-release-check.ts` before any public push.

## Why these defaults

- **Next.js App Router** — server-rendered HTML for crawlers and answer
  engines by default; one framework from validation site to real product.
- **Neon per venture** — cheap branchable Postgres; evidence isolation
  between ventures is a hard rule, so shared storage is not an option.
- **Committed generated skills** — agents discover skills by reading files;
  requiring a build step would break half the agent ecosystem.
- **YAML config + Zod** — hypotheses (pricing, thresholds, allocation) must
  be reviewable in diffs, not buried in code.
- **JSONL memory** — append-only, diff-friendly, trivially parseable by both
  scripts and agents.

## Decision records

Architectural decisions with alternatives and consequences live in
[docs/decisions/](docs/decisions/index.md).
