# Stripe

Stripe is the default commerce route for web billing and non-native goods. It is
not the entitlement source for native digital purchases unless an approved store
policy/architecture decision says so.

## Official guidance and CLI

The assignment's list-only discovery command remains useful for inspecting
Stripe's current skill catalog without choosing an install target:

```bash
npx skills add https://docs.stripe.com --list
```

The 2026-08-12 read-only machine-catalog inspection listed seven official Stripe
skills and installed nothing: `connect-recommend`, `stripe-apps`,
`stripe-best-practices`, `stripe-directory`, `stripe-docs`, `stripe-projects`,
and `upgrade-stripe`. The catalog and inspected skill manifest did not declare a
redistribution license. The separate `stripe/ai` repository is MIT licensed,
but that does not establish a license for content served from
`docs.stripe.com`. Recheck both the catalog and the exact material's license
before a later install; discovery is not installation or an endorsement of
every skill for this harness.

Stripe's current first-party quickstart recommends installing the current
Stripe CLI and running `stripe agent setup`; it can install Stripe's agent
plugin or skills into the founder's selected agent environment. The generic
skills-compatible alternative is `npx skills add https://docs.stripe.com`.
Install and update behavior belongs to those external tools and must be checked
at execution time. None of these commands is part of repository setup: do not
vendor discovered or installed third-party content into `skills/**`,
`.agents/**`, or another tracked path. Venture Harness's canonical local skills
remain under `skills/**`.

Stripe currently documents this agent-first CLI setup:

```bash
npm install -g @stripe/cli
stripe agent setup
```

The assignment's supported Homebrew setup on macOS remains:

```bash
brew install stripe/stripe-cli/stripe
stripe login
```

`vh stack connect founder-default` checks the official CLI with bounded GETs,
retains only install/auth status, safe account ID and `mode: test`, and never
reads or copies the CLI's underlying key or config. The CLI session is useful
for inspection and local webhook work. The REST provider adapter separately
needs a restricted **test-mode** API-key reference in the credential broker;
the value is collected through hidden input, never argv or Stack state. See
[Stripe agents](https://docs.stripe.com/agents),
[Stripe skills](https://docs.stripe.com/skills.md), and
[Stripe CLI install](https://docs.stripe.com/cli/install).

If the CLI session is unavailable, the bounded API doctor can use the explicit
restricted test-key fallback; the command accepts only the reference and reads
the value from hidden input:

```bash
vh auth login stripe \
  --ref cred://stripe/founder-default \
  --kind restricted_api_key
```

## Configure

The API plan searches before create and then creates or locates exactly one
venture-scoped product, immutable amount/currency price, webhook endpoint and,
when selected, billing portal configuration. It binds deterministic
`venture_harness_*` metadata, a stable product identity, a stable price lookup
key, Stripe-native idempotency and the durable local ledger. Search ambiguity,
pagination before a conclusive match, duplicate deterministic identities, or
an exact identity with drift fails closed. Immediately before every mutation,
the adapter uses the same resolved secret for bounded `/v1/account` and
`/v1/balance` reads; the account must match the reviewed `account_id` and balance
must prove `livemode: false` during founder-alpha dogfood. Every resource is read
back, including the billing portal's mode. The adapter exposes no charge,
capture, PaymentIntent, Checkout Session or refund capability.

## Authorization

`standard_launch` does not imply live prices or a customer charge.
`live_commerce_launch` plus a narrowed envelope must explicitly allow live
product/price configuration, actual charge, environment and spend ceiling.

## Verify

Compare product ID/name/active state, price ID/livemode/unit amount/currency and
the exact recurring-versus-one-time shape, webhook URL/enabled events and portal
state/mode. Run test checkout and webhook fixture/sandbox paths, and confirm the
server records the exact price shown. A configured price is not revenue; a
checkout intent is not a payment.

For local webhook delivery, run Stripe's official CLI against the app's chosen
port:

```bash
stripe listen \
  --forward-to localhost:<port>/api/stripe/webhook
```

The endpoint signing secret belongs in the credential broker or deployment
secret store, never Git. The server must give the official Stripe library the
exact raw request bytes and `Stripe-Signature` header before parsing or trusting
the event. After signature verification, atomically deduplicate event IDs and
reconcile current Stripe object state; do not apply embedded event state by
arrival order because Stripe does not guarantee event ordering. A checkout
success redirect is browser navigation, not fulfillment evidence. Fulfillment
must follow a verified webhook and current-state reconciliation. The reusable
fixture contract is `lib/providers/stripe-webhook.ts`; its memory store is
fixture-only and production must provide a durable transactional store. See
[Stripe webhooks](https://docs.stripe.com/webhooks) and
[signature verification](https://docs.stripe.com/webhooks/signature).

## Repair

Stripe prices cannot change amount or currency. Create and verify a replacement,
move the active mapping deliberately, then deactivate the old price when safe.
Never delete payment or refund history as rollback.
