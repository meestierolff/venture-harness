# SECURITY

Repository disclosure policy lives in [/SECURITY.md](../../SECURITY.md). This
document defines launch-runtime trust boundaries.

## Credentials

- Repository config stores only logical `cred://provider/label` references.
- The credential broker maps references to a local system keychain, a read-only
  CI environment mapping, optional 1Password backend, official CLI session, or
  an in-memory test backend.
- Account IDs, scopes, expiry and availability are inspectable; values are not.
- Direct CLI/API transports receive a value only for one call and redact output,
  errors, state and reports.
- Generated database passwords, webhook secrets and private keys must be placed
  directly in the broker—not copied through a report.
- Production credentials are venture-specific and never copied to another app.

## Authorization

A tool login and a run authorization envelope are independent requirements.
The envelope restricts capabilities, side-effect classes, providers,
environments, expiry, estimated spend, recipients and forbidden actions. Tool
permission alone does not authorize a provider effect.

For launch runs, the envelope capability list is narrowed from the profile to
the exact provider-operation capabilities declared by the persisted graph.
Estimated cost is reserved in workflow state before transport and accumulated
across nodes and attempts. Unknown-cost external writes fail closed unless the
profile explicitly opts into `unknown_external_costs_allowed`; customer charges
still require an exact estimate.

Deletion, destructive production data changes, nameserver replacement, bulk or
cold sending, spend-cap overruns, unapproved customer charges and irreversible
App Store publication always need a distinct checkpoint.

For a supported dangerous provider effect, the executor persists the exact run,
node, effect, operation, and request time before any provider transport runs. A
repository-scoped typed approval issues one expiring grant. The executor records
issuance, atomically persists consumption before transport, and refuses to reuse
either a grant or its evidence artifact; a retry requires a later approval.

A checkpoint does not widen the run's provider, environment, capability, risk,
spend, recipient, or expiry ceiling. Spend overruns and other actions outside
that ceiling currently remain blocked until an operator creates a newly scoped
authorization envelope; the one-shot CLI does not amend an envelope.

An expired persisted launch is not renewed implicitly. If unfinished provider
effects remain, `vh resume <run-id> --authorization <same-profile>` is required;
renewal keeps the same run and graph and writes a new bounded envelope with an
explicit CLI approval reference. Switching profiles during renewal is rejected.

## Runtime surfaces

| Surface          | Control                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| Public input     | strict schema, unknown-field rejection, size/rate limits                 |
| Private payloads | first-party store only; no analytics/log copy                            |
| Workflow state   | JSON-safe definitions, atomic writes, mode 0600, redaction               |
| Provider call    | no shell interpolation; stable idempotency; bounded retry                |
| Provider result  | classify errors; read back; extract secrets before persistence           |
| CI               | references/env mappings only; no committed secret or cross-venture reuse |
| Upgrades         | ownership hashes, conflict stop, atomic writes and lock last             |

## Rotation and revocation

Rotate by creating/testing a replacement reference, updating the provider or
environment mapping, verifying the dependent journey, then revoking the old
reference. See [CREDENTIAL_ROTATION.md](../operations/CREDENTIAL_ROTATION.md).

## Known limits

The local broker and adapters have synthetic test evidence; this template has
not completed a production provider security review or live credential test.

## Related

- [../operations/PROVIDER_AUTHENTICATION.md](../operations/PROVIDER_AUTHENTICATION.md)
- [RELIABILITY.md](RELIABILITY.md)
- [../legal/ANALYTICS_AND_CONSENT.md](../legal/ANALYTICS_AND_CONSENT.md)
