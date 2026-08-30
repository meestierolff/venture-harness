# FOUNDER PRINCIPLES

- Status: FOUNDER ALPHA OPERATING PRINCIPLES
- Owner: harness maintainers
- Last updated: 2026-08-12

## Purpose

Keep a first venture narrow enough to launch, honest enough to learn from, and
simple enough to stop. These principles guide the Launch Contract and the
founder-default rail. They are decision rules, not evidence of demand, product
quality, token savings, or live provider state.

## Principles

### 1. Make a small bet

Bound the initial scope, time, provider effects, and downside before building.
State what is outside the bet. A small bet should be cheap to learn from and
safe to stop; it need not be trivial.

### 2. Choose one user

Name one narrow initial user in a real situation. Adjacent audiences can remain
assumptions until observed evidence shows that they belong in the same product.

### 3. Solve one painful job

Describe the progress that user is trying to make and the friction blocking it.
Prefer a specific, consequential job over a broad persona or a catalogue of
features.

### 4. Deliver one outcome

Define one useful change the user should experience. Make it concrete enough to
review without turning it into an unsupported promise of results.

### 5. Build one core feature

Build the shortest credible path from the painful job to the outcome. Add
supporting features only when that path, safety, accessibility, or verification
requires them.

### 6. Include one commitment surface

Ask for one meaningful, explicit action such as a request, booking, signup,
purchase, or publication. Match the action to the business model, show any price
exactly, and never use a dark pattern to manufacture commitment.

### 7. Choose one initial distribution channel

Start in one place where the initial user already pays attention. Keep sending,
posting, publication, and spend human-gated; a channel plan is not observed
distribution.

### 8. Set one review date

Choose the date and evidence threshold before launch. A review date prevents an
open-ended build and makes unresolved assumptions visible rather than silently
permanent.

### 9. Use a boring default stack

Prefer the supported founder-default Stack when it can satisfy the contract.
Diverge only for a concrete product, safety, legal, or provider requirement—not
for novelty.

### 10. Launch before building a platform

Ship the narrow product and learn from its real use before adding marketplaces,
multi-product abstractions, customer connection hubs, or broad Agent Surfaces.
Enable an advanced pack only when the contract demonstrates its need.

### 11. Measure observed behavior

Use consented product events, completed commitment actions, public-journey
checks, and provider read-backs. Do not substitute plans, request acceptance,
fixtures, traffic assumptions, or founder enthusiasm for observed behavior.

### 12. Continue, change or stop

Write all three decision rules before evidence arrives. Continue only within the
reviewed boundary, change the named hypothesis when the signal is informative,
and stop when the threshold or safety rule says to stop.

### 13. Automate repeated setup

Turn repeated, well-understood plumbing into deterministic code, templates, and
checks. Keep the first unfamiliar instance inspectable so the harness automates
what was actually learned rather than a guessed universal workflow.

### 14. Reserve model tokens for unique judgement

Use models for ambiguous product, research, design, and synthesis decisions.
Use schemas and deterministic code for parsing, routing, transforms, policy,
redaction, and verification. Measure comparable runs; never promise that a
smaller token count alone means a better or cheaper outcome.

## Applying the principles

`vh idea sharpen` deterministically validates an existing complete Launch
Contract in founder alpha. Rough-prose sharpening and product-build model work
are unavailable until Core owns an audited outer read-isolation driver. The
contract records one user, job, outcome, proposition hypothesis, core feature,
journey, commitment surface, initial channel, success signal, review date,
explicit not-building list, truth boundaries, and `continue`, `change`, or
`stop` rules. Its strict 15-field capability map classifies every facet as
`REQUIRED`, `DEFERRED`, or `NOT_APPLICABLE`; local invariants reject incoherent
dependencies. Supported projections feed routing, rendering, the canonical
digest, and journey binding. Authentication and authorization stay distinct in
that map; when either is REQUIRED, the existing `authenticated_product` routed
bundle must implement both the session boundary and the declared access rules.
None of this substitutes for founder review or
proves commercial fit or live provider state.

The founder-default Stack and versioned seeds implement the repeated setup. The
sanitized idea-usage artifact and local Launch Receipt make available model
usage, retries, verification states, and unresolved actions inspectable. Missing
measurements remain missing rather than being estimated as success.

## Evidence

- The [Launch Contract schema and projection](../../lib/founder-launch/launch-contract.ts)
  encode the bounded review surface.
- The [Launch Contract tests](../../tests/launch-contract.test.ts) verify schema,
  rendering, and deterministic projection behavior locally.
- The [idea pipeline](../../lib/founder-launch/idea-sharpener.ts) and
  [its tests](../../tests/idea-sharpener.test.ts) prove the zero-model contract
  path and exercise call accounting only through fixture hosts; public model
  execution remains unavailable.
- The [Launch Receipt](../../lib/runtime/launch-receipt.ts) and
  [its tests](../../tests/launch-receipt.test.ts) preserve honest waiting,
  fixture, and verified states in local sanitized artifacts.
- Public method influences are credited in [SOURCES.md](../../SOURCES.md).

This evidence supports local implementation behavior only. The first real
founder launch, user commitment, and review decision remain externally
unverified.

## Assumptions

- “One” means the first focused bet, not a permanent ban on later expansion.
- A commitment surface need not be a payment; its form follows the reviewed
  business model and truth boundaries.
- The founder reviews the Launch Contract, dry run, provider destinations, and
  any manual action before granting effects.

## Unresolved questions

- Which user, commitment action, channel, and review threshold will the first
  real founder Launch Contract select?
- Which observed friction from that launch should become the next deterministic
  automation, if any?

## Related documents

- [README](../../README.md)
- [Product Truth](PRODUCT_TRUTH.md)
- [Feature status](FEATURE_STATUS.md)
- [Founder quickstart](../public/FOUNDER_QUICKSTART.md)
- [Sources and prior art](../../SOURCES.md)
