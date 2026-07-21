---
name: seo-aeo-engine
description: Manage search and answer-engine visibility - route query ownership, metadata, structured data, crawlability, raw-HTML verification, weekly Search Console and Bing analysis, content consolidation, AI-referral tracking. Use for SEO/AEO work and when weekly SEO exports arrive. Do not use for writing brand copy or choosing what to sell.
---

# seo-aeo-engine

## Purpose

Make every material query own exactly one page, keep those pages
crawlable and answer-engine readable, and turn weekly Search Console /
Bing / AI-referrer data into a short list of evidenced improvements.

## Trigger conditions

- New routes or content planned; metadata/structured-data work.
- Weekly files appear in `data/seo/inbox/` (gsc-queries.csv,
  gsc-pages.csv, bing-queries.csv) or `data/analytics/inbox/ai-referrers.csv`.
- CTR, indexing, or rendering problems suspected.

## When not to use

- Brand voice and copy identity ($design-director / docs/brand/COPY.md).
- Offer or pricing decisions ($offer-architect).

## Required inputs

- docs/growth/SEO.md page register; config/content.yaml
- Weekly exports in data/seo/inbox/ (when analysing)
- A built site for raw-HTML checks (when verifying)

## Documents to read

AGENTS.md, docs/growth/SEO.md, CONTENT.md, docs/engineering/FRONTEND.md,
config/content.yaml, docs/product/PRODUCT_TRUTH.md.

## Files this skill may change

`docs/growth/SEO.md`, `docs/growth/CONTENT.md`, page metadata and
structured data in `app/**`, content drafts under `templates/content/`
conventions, `reports/seo/*`, internal links in existing pages.

## Files this skill must not change

Pricing values, offer claims (PRODUCT_TRUTH boundary), `lib/analytics/**`,
`config/*.yaml` except content additions via proposal, `skills/**`.

## Execution steps

1. Maintain the page register: page ↔ primary query ↔ intent ↔ metadata ↔
   conversion goal. One query owner per material query.
2. Keep commercial pages answer-ready: plain-HTML product and price facts,
   answer block first, canonical URL, structured data, internal links,
   entity anchoring (consistent org name, sameAs), organisation and author
   transparency. llms.txt is optional supporting documentation only.
3. Verify crawlability with `pnpm verify:seo` (static) and
   `pnpm verify:raw-html --url <site>` (rendered) for normal, Googlebot-like
   and bingbot-like user agents; require title, canonical, H1, core
   content, price text where relevant, product facts, internal links,
   structured data in the raw HTML.
4. Weekly, when inbox files exist, run `pnpm weekly` and then look for:
   impressions without a dedicated page; positions 6–20; low CTR at useful
   positions; competing pages (cannibalisation); emerging commercial
   queries; missing comparison pages; missing internal links; stale
   pricing or claims; orphan pages; impressions with no commercial value;
   bot rendering failures; Bing-specific indexing defects.
5. Propose changes as a ranked list with evidence (query, impressions,
   position, current page) and prepare PR-sized diffs.
6. Consolidate: merge/redirect competing pages rather than adding more.

## Hard rules

- Never mass-publish autonomously; publication is human-gated.
- No keyword-stuffed or auto-generated filler pages.
- Claims on pages obey PRODUCT_TRUTH.md; prices match config/offer.yaml.
- Every proposed page names its conversion goal and internal links.
- Structured data must describe reality (no fake ratings/reviews).

## Expected output

Updated page register, ranked opportunity list with evidence, prepared
diffs or drafts, reports/seo/ entry, passing crawler checks.

## Validation

`pnpm verify:seo` passes; `pnpm verify:raw-html` passes against the
running build; `pnpm validate:links` passes; register has no orphan rows.

## Failure behaviour

If inbox data is missing or malformed, report which file and which columns
were expected (see data/seo/inbox/README.md) and analyse what remains.
If raw-HTML checks cannot run (no server), say so and list the exact
command to run them.

## Human approval boundaries

Publishing pages, redirects on live domains, and robots/canonical changes
in production require human approval. The skill prepares pull requests;
humans merge.
