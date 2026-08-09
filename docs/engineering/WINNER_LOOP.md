# Winner Loop

- Status: fixture verified end to end; locally verified domain controls
- Live verification: pending for publication, paid media, attribution, and
  subscription-provider state
- Canonical runtime: `lib/winner-loop/` and `lib/winner-integrations/`
- Runtime policy: `config/growth.yaml`

## Purpose and boundary

Winner Loop turns a creative hypothesis into attributable evidence and a
bounded next recommendation. It may prepare drafts, evaluate synthetic/provider
metrics, propose a paid test, reserve an approved cap, ingest subscription
events, and prepare a fixture DistributionPR. It does not infer causal truth,
publish without the configured review boundary, spend without a human-approved
`SpendGrant`, raise a cap, or auto-scale.

## Flow

```text
hypothesis
  → immutable creative + lineage
  → render asset + tenant read-back
  → rights / claim / disclosure review
  → organic review or provider draft
  → scheduled metric snapshots
  → baseline-adjusted evaluation
  → human-reviewed paid-test proposal
  → immutable SpendGrant
  → atomic reservation + fixture/provider operation
  → attribution evidence + RevenueCat lifecycle
  → cohort/economics read
  → recommendation + fixture DistributionPR
```

## Creative identity

`creative_id` is the immutable join key. A versioned content fingerprint is for
deduplication/equivalence and never replaces identity. Material media changes
mint a derived creative with lineage. Caption, ad copy, destination, privacy,
and platform settings create a delivery variant against the same media
creative. Provider post, render, campaign, ad-group, and ad IDs map onto this
identity; they do not become it.

The SQLite ledger stores variants, delivery variants, lineage, provider-object
bindings, per-network state transitions, and history across process restart.
Identity is scoped by venture and rejects cross-venture access.

## Rights and compliance

Each versioned Creative Manifest records source assets, licenses, testimonial
consent, creator authorization, permitted channels/regions, organic/paid
approval, expiry, AI disclosure, claims, Product Truth references, reviewer,
and review event. Compliance fails closed on missing, expired, revoked, or
out-of-scope evidence. A revoked manifest cannot be silently reactivated.

Assess rights again immediately before organic publication and paid apply; a
previous review does not override revocation or expiry.

## Metrics and winner evaluation

The snapshot cadence is 30 minutes, 2 hours, 6 hours, 1 day, 3 days, and 7 days.
Every metric has provenance, availability, confidence, capture time, and
provider identifiers. Missing values remain unknown, not zero.

The evaluator compares view velocity, completion, watch time, shares, saves,
profile visits, outbound clicks, and trials with available account/format
baselines. It renormalizes over available weights and lowers confidence for
thin, missing, or stale evidence. Recommendations are `NO_SIGNAL`,
`GATHER_MORE_DATA`, `BOOST_CANDIDATE`, `PAID_TEST_CANDIDATE`,
`CREATE_VARIANTS`, `DO_NOT_BOOST`, or `FATIGUE_DETECTED`. A recommendation is
not authorization.

## Paid proposal and SpendGrant

A paid-test proposal binds material terms: venture/customer, network/account,
objective/event, creative, destination, geography/audience, currency, cap,
window, rights/disclosure state, evidence, and current safety snapshot. Any
material change creates a new proposal decision boundary.

Human approval creates a `SpendGrant` for those exact terms. Immediately before
an operation, runtime rechecks proposal status, grant integrity/expiry, creative
rights, destination, account, objective/event, current policy, and caps. A grant
cannot be forged from stale or altered material terms.

## Spend safety

Money is integer minor units. SQLite `BEGIN IMMEDIATE` reservations enforce all
of these independently:

- creative and paid-test cap;
- campaign cap;
- account daily cap;
- venture daily and monthly caps;
- customer daily and monthly caps across grants/ventures;
- emergency platform cap.

An idempotency key binds the full reservation request. Confirmed no-write
releases the reservation; unknown provider outcome moves it to pending
reconciliation and retains every cap. Settlement, incident creation, and freeze
are atomic. The controller may auto-pause on declared no-trial/no-purchase/CAC,
rights, attribution, billing, or provider-integrity signals. It never raises a
budget or starts a scale operation automatically.

## Readiness and economics

The readiness ladder is `NO_SIGNAL → TRACKING_SETUP → HIGH_INTENT_EVENT_READY →
PURCHASE_READY → VALUE_READY → SCALE_READY`. Each stage depends on healthy event
delivery/deduplication/latency, attribution, volume, value, provider eligibility,
and net economics. Value-based optimization stays off unless the Growth
Contract permits it and every prerequisite is current. `SCALE_READY` still
produces a recommendation only.

CAC affordability uses net contribution after store fee, tax, expected refunds,
and serving costs, not gross subscription price.

## Attribution, subscriptions, and cohorts

Attribution evidence is explicitly classified and confidence-labeled. Creative-
level reporting requires healthy creative evidence; weaker evidence remains
account/campaign level rather than being upgraded by inference.

The RevenueCat fixture route verifies exact raw request bytes before parsing. It
checks timestamp freshness, bounded JSON MIME/body size, current and previous
secret validity windows, optional route authorization, and exact
venture/project/environment/app binding. Invalid or stale deliveries do not
reach the event store. Event identity, ordering, duplicates/conflicts, billing
period, currency, transaction-linked refunds, aliases, and subscriber state are
serialized in SQLite across clients and restart. A voluntary cancellation or
billing issue changes renewal intent but does not revoke the entitlement before
expiration or the recorded grace boundary. Customer-support refund
notifications with a zero webhook amount are reconciled to the exact referenced
transaction instead of inventing negative revenue. App User IDs and aliases are
HMAC-pseudonymized before storage and linked only within the routed
venture/project/environment. Cohorts retain attribution class and missing-data
limitations across D0/D7/D30/D90 windows. This is fixture proof, not live
RevenueCat connectivity or deployed webhook delivery.

## Event pack and providers

The 20-event Winner Loop pack is disabled by default and writes only to
first-party evidence. It rejects private fields, credential material, and raw
creative content.

The integration layer has two deliberately different boundaries:

- Provider-incapable fixture adapters cover local rendering, organic
  draft/direct review, TikTok Spark with zero spend, aggregated attribution,
  and RevenueCat lifecycle. Each supports doctor, plan, dry-run, apply,
  read-back, verify, reconcile, redaction, and feature availability in fixture
  mode.
- Transport-injected live-mode contracts cover creative rendering, TikTok
  organic, TikTok paid/Spark, attribution, and RevenueCat. They are production-
  targeting contracts whose provider client/transport must be supplied by an
  authorized venture. Local contract tests do not configure an account or
  establish any provider effect.

No fixture adapter can contact a provider, publish, or spend.
The live-mode contract boundary is **locally verified** only; network calls,
publication, advertising spend, attribution ingestion, subscription state, and
provider read-backs remain **live verification pending**.

An effectful live-mode adapter refuses the default in-memory operation store;
only an explicitly marked test transport may use it. A durable atomic claim
binds the complete request before a production-targeting mutation, concurrent
workers share that claim, and restart reuses it. An unknown result remains
pending reconciliation and must use provider read-back without repeating the
mutation. Paid reconciliation may continue with separately authorized read
access after the write grant expires, but it never recreates spend authority.

## Fixture D

```bash
pnpm fixture:winner-loop
```

Fixture D records 34 ordered milestones through an explicit command grant, the
command bus, durable file workflow, a real isolated venture materialization,
the Winner Loop pack installer, tenant asset vault, hash-chain audit, SQLite
creative/rights/evidence/subscription/spend stores, event pack, and six
package-SDK/registry fixture-provider operations. The domain run consumes each
operation's verified read-back identifiers and reported fixture values; the SDK
is not a sidecar assertion. Its DistributionPR output is a proposal-only
fixture with evidence, limitations, measurement, and rollback; it does not
modify the source repository or contact a provider.

Expected evidence: `reports/audit/winner-loop-creative-trace.json`. Every
provider entry must say fixture-only, external effect false, spend false, and
live verified false.

## Verification

```bash
pnpm test -- tests/winner-loop*.test.ts
pnpm fixture:winner-loop
pnpm validate:claims
```

Do not relabel this subsystem live until authorized provider read-backs exist
for the exact publication, spend, attribution, and subscription boundaries.
