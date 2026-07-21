---
name: product-truth
description: Maintain the PRODUCT_TRUTH.md claims register and audit every public surface - homepage, pricing, metadata, structured data, emails, onboarding, samples, consent text - against it. Use when claims change, before launch, and before anything is published. Do not use for writing marketing copy.
---

# product-truth

## Purpose

Keep one honest register of what the product can do, and make every
public claim trace to it. Statuses: LIVE, CONCIERGE, PROTOTYPE, PLANNED,
UNDER REVIEW, UNVERIFIED.

## Trigger conditions

- Any capability claim is added, changed, or implemented.
- Pre-launch and pre-publication audits.
- The product-truth-auditor subagent or `pnpm validate:claims` reports a
  mismatch.

## When not to use

- Writing new copy (that work references the register; it does not edit
  it as a side effect).

## Required inputs

- docs/product/PRODUCT_TRUTH.md, the implementation evidence for any
  claim under review (code, tests, delivery records).

## Documents to read

AGENTS.md, docs/product/PRODUCT_TRUTH.md, PRODUCT.md,
docs/brand/COPY.md, config/content.yaml, the public surfaces themselves
(app/ pages, metadata, structured data).

## Files this skill may change

`docs/product/PRODUCT_TRUTH.md`, `docs/product/PRODUCT.md` capability
table, flagged wording on public surfaces (`app/**`, `components/**`,
`docs/brand/COPY.md`) to bring them inside allowed wording.

## Files this skill must not change

Prices and offer structure (route to $offer-architect), experiment
definitions, `lib/analytics/**`, `skills/**`.

## Execution steps

1. For each claim: record claim, status, evidence (link/path, not prose),
   owner, last verified date, allowed wording, forbidden wording.
2. Verify evidence before assigning LIVE: run the test, view the
   delivery record, or downgrade to UNDER REVIEW.
3. Inspect all surfaces: homepage, pricing, feature pages, metadata,
   structured data, emails, onboarding, sample interfaces, consent text,
   analytics claims. Compare wording against allowed/forbidden lists.
4. CONCIERGE claims must disclose human delivery; PROTOTYPE claims must
   carry labels; PLANNED claims use future tense only and never imply
   availability; UNDER REVIEW and UNVERIFIED must not appear publicly.
5. File mismatches as fixes (bring copy inside allowed wording) or as
   register updates (evidence now supports more) — never silently relax
   forbidden wording.
6. Run `pnpm validate:claims`.

## Hard rules

- No claim without evidence gets LIVE.
- Verification dates are real dates of real checks.
- Sample data, illustrative interfaces, prototypes, concierge services,
  and planned functionality are labeled on the surface itself.
- Structured data claims (ratings, counts) follow the same register.

## Expected output

An accurate register; public surfaces whose wording matches it; a list of
downgrades/upgrades made and why.

## Validation

`pnpm validate:claims` passes; every register row has all eight fields;
no UNVERIFIED/UNDER REVIEW claim on a public surface.

## Failure behaviour

Evidence that cannot be verified downgrades the claim and flags every
surface using it. When in doubt between two statuses, choose the weaker
one and record the missing evidence.

## Human approval boundaries

Upgrading a claim to LIVE based on judgement (not automated evidence)
requires human confirmation. Publishing changed public wording follows
the standard human-gated publication rule.
