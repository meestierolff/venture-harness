# Rollback

Rollback is provider- and effect-specific. Prefer a verified forward repair when
reversal would destroy evidence or create a larger outage.

## Before apply

The dry run records reversibility, compensation, current state, resource IDs,
previous values where safe, and expected read-back. Destructive data changes,
external deletes and nameserver replacement require a distinct checkpoint.

## Common paths

| Effect                   | Recovery                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| local/managed files      | atomic restore from captured original; keep failure report                                       |
| Vercel deployment        | restore the prior verified deployment/alias; re-run smoke checks                                 |
| additive DNS record      | restore only the previous record value/TTL; verify authoritative DNS                             |
| Stripe/RevenueCat config | deactivate or remap only after checking live entitlements; never delete transaction history      |
| Brevo sender/template    | disable or restore prior version; do not send as a rollback test without authorization           |
| Neon schema              | run reviewed down/forward migration; never erase commercial evidence to match code               |
| TestFlight build         | stop distribution or upload a fixed build; TestFlight rollback is not App Store rollback         |
| harness upgrade          | engine restores attempted managed files if write/lock update fails; conflicts stop before writes |

## Validate recovery

Read provider state back, run the affected critical journey and record what was
restored, what remains, data-loss risk, evidence references and next review. A
compensation hook failure leaves the run degraded/failed; it is not hidden.
