# BACKEND

The backend rail is capability-driven. A public-only venture may not need a
database; a venture that records material evidence, auth state, webhooks or
entitlements does.

## Evidence storage

The existing web foundation writes typed experiment, consent and commercial
events through [../../lib/evidence-store.ts](../../lib/evidence-store.ts).
Personal submission payloads are isolated from analytics. Production requires a
venture-owned database; development may use the gitignored JSONL fallback only
when explicitly enabled.

Rules:

- persist a qualified submission before best-effort analytics;
- store exact displayed prices rather than reconstructing them;
- keep private payloads out of analytics and normalized data;
- use one database per venture and least-privilege roles;
- reject unknown input and rate-limit public endpoints.

## Executable migrations only

Database schemas must be applied from versioned executable SQL files and tracked
in a migration ledger. SQL copied only from prose is not a launch artifact. A
Neon plan may create a project, branch, database and role, but it must not call
the backend `verified` until the applicable SQL migration files run and a
read/write health check succeeds.

At this revision, the repository's committed
[001-v0-1-to-v0-2 migration](../../migrations/001-v0-1-to-v0-2.yaml) upgrades
harness config—not the Neon evidence schema. If no executable database migration
is present for a child venture, the launch report must state that gap instead of
asking the operator to paste the former example schema.

## Migration evidence

Record migration ID, checksum, environment, start/end time, result and safe
rollback/forward-repair path. Destructive production migrations require a
distinct checkpoint even when the broader run has launch authorization.

## Provider credentials

Connection strings and generated role passwords go directly to the credential
broker. Repository config and reports keep only `cred://...` references and
non-secret project/database/role IDs.

## Related

- [ANALYTICS.md](ANALYTICS.md)
- [SECURITY.md](SECURITY.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)
- [../operations/NEON.md](../operations/NEON.md)
