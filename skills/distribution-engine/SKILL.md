---
name: distribution-engine
description: Map customer habitats and build channel strategies - warm outreach, content, cold outreach, community, Reddit, partnerships - with all sending and posting human-gated. Use for distribution planning and outreach preparation. Do not use for SEO page work or for actually sending anything.
---

# distribution-engine

## Purpose

Start from the customer, not the channel: map where the exact customer
already is, order acquisition (warm → content → value-first cold → paid
after proof), prepare channel strategies and drafts, and keep every
outbound action behind human approval.

## Trigger conditions

- Bootstrap step 9; distribution planning requests.
- A validation launch approaching with no traffic plan.
- Weekly report shows acquisition volume or quality problems.

## When not to use

- On-site SEO ($seo-aeo-engine).
- Sending anything — this skill never sends.

## Required inputs

- docs/business/ICP.md (coherent), docs/growth/CHANNELS.md
- config/distribution.yaml, memory/customer-language.jsonl

## Documents to read

AGENTS.md, docs/growth/DISTRIBUTION.md, CHANNELS.md, OUTREACH.md,
CONTENT.md, docs/business/ICP.md, config/distribution.yaml,
docs/product/PRODUCT_TRUTH.md (proof assets must be real).

## Files this skill may change

`docs/growth/*`, drafts under `templates/content/` conventions,
`reports/weekly/*` (distribution sections), `PROJECT.md` pending
decisions.

## Files this skill must not change

`config/distribution.yaml` approval rules (weakening requires an ADR +
human sign-off), `app/**`, `lib/**`, `docs/product/PRODUCT_TRUTH.md`.

## Execution steps

1. Build the customer habitat map: exact customer, existing concerns,
   communities, subreddits, search queries, newsletters, trusted people,
   events, professional networks, tools used, public buying signals,
   language used. Record in CHANNELS.md.
2. Order acquisition: warm outreach → useful content → value-first cold
   outreach → paid only after proof (prerequisites written down).
3. Create per-channel strategies (Reddit, LinkedIn, X, search,
   communities, partnerships, referrals, email, direct outreach), each
   with its proof requirement before scaling.
4. For each subreddit record: audience fit, rules, accepted formats,
   self-promotion risk, title patterns, expected proof, allowed links,
   objections, comment plan, repurposing plan.
5. Draft outreach sequences and content calendar entries; attach the
   value offered and the approval owner to each.
6. Scale by More → Better → New: more of what works, better versions,
   then new channels — in that order.
7. After human-executed outreach, log results in OUTREACH.md and append
   customer language to memory via `pnpm outcome:add`.

## Hard rules

- Never post automatically. Never send messages automatically.
- Never manipulate engagement (no vote rings, fake accounts, bought
  interactions).
- Never scrape or contact people in violation of platform rules.
- No mass generic messages; personalisation from a real observation.
- Human approval before any outbound; value and proof before pitch.
- Proof assets must have PRODUCT_TRUTH.md ids.

## Expected output

Habitat map, prioritised channel strategies, Reddit map rows, drafted
sequences and calendar with approval owners, paid prerequisites, logged
learnings.

## Validation

`pnpm verify` passes; every draft names its approval owner; every
strategy names its proof requirement; config/distribution.yaml rules
untouched.

## Failure behaviour

If the ICP is too vague to map habitats, stop and route back to
$offer-architect with the specific gap. If a channel's rules cannot be
determined, mark it "rules unknown — do not use" rather than assuming.

## Human approval boundaries

Everything outbound: sending, posting, publishing, paid spend, directory
submissions. Agents draft, research, prepare, and analyse only.
