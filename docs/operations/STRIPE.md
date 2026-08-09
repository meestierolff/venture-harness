# Stripe

Stripe is the default commerce route for web billing and non-native goods. It is
not the entitlement source for native digital purchases unless an approved store
policy/architecture decision says so.

## Configure

The API plan can create/read back product, immutable amount/currency price,
webhook endpoint and billing portal configuration. Prefer a restricted key and
keep test and live references/resources separate. Every POST uses a stable
idempotency key plus the local ledger.

## Authorization

`standard_launch` does not imply live prices or a customer charge.
`live_commerce_launch` plus a narrowed envelope must explicitly allow live
product/price configuration, actual charge, environment and spend ceiling.

## Verify

Compare product ID/name/active state, price ID/livemode/unit amount/currency and
billing interval, webhook URL/enabled events and portal state. Run test checkout
and webhook fixture/sandbox paths, and confirm the server records the exact price
shown. A configured price is not revenue; a checkout intent is not a payment.

## Repair

Stripe prices cannot change amount or currency. Create and verify a replacement,
move the active mapping deliberately, then deactivate the old price when safe.
Never delete payment or refund history as rollback.
