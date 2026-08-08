# RevenueCat

RevenueCat is the default entitlement source for native digital subscriptions or
purchases when the router selects it.

## Manual bootstrap

Create the RevenueCat project and restricted secret key in its dashboard, store
the key behind a `cred://...` reference, and record only the project/account ID.
This prerequisite remains manual; the adapter must not claim it created the
project.

## Planned automation

After bootstrap, the API plan covers app, deterministic entitlement, offering
and webhook resources. Development uses RevenueCat Test Store where applicable.
Apple store-product creation is a separate App Store dependency; do not mark a
product mapped until Apple and RevenueCat read-backs agree.

## Verify

Read back project/app IDs, entitlement identifier, current offering/packages,
webhook configuration and environment. Test purchase, entitlement unlock,
restore and webhook handling in the applicable Test Store/sandbox path; repeat
the required path in TestFlight before claiming readiness.

## One source of truth

Do not enable Stripe and RevenueCat as competing entitlement authorities. A
hybrid product needs an ADR naming the single entitlement source and sync/error
behavior.
