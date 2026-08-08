# ADR-003: Provider-neutral credential references and authorization envelopes

- Status: accepted
- Date: 2026-08-04
- Deciders: founder `/goal`

## Context

Providers do not share one authentication model. The harness must support
OAuth tokens, API keys, JWT/private keys, official CLI sessions, service
accounts, and CI secrets without committing or logging credential values.
Per-action prompts also create launch friction without adding safety when a
founder has already authorized a bounded session.

## Decision

Repository config stores only `credential_ref`. Secret values live in a
pluggable backend: system keychain locally, environment variables in CI,
optional 1Password CLI, or in-memory storage in tests. Official CLI sessions
remain owned by their CLI when that CLI securely handles authentication and
refresh.

Authorize effects with expiring, run-bound envelopes that constrain providers,
capabilities, environments, effect classes, spend, recipients, deployment,
commerce, DNS, and App Store actions. A separate checkpoint remains mandatory
for deletion, destructive production data changes, nameserver replacement,
bulk/cold communication, excess spend, unapproved charges, and irreversible
store publication.

## Alternatives considered

| Alternative                             | Why not                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| OAuth for every provider                | Several providers use keys, JWTs, service accounts, or CLI sessions instead.      |
| Encrypted secrets in Git                | Encryption metadata and key distribution still create cross-venture leakage risk. |
| Environment variables for all local use | They are easy to leak through shells, subprocesses, and diagnostics.              |
| Prompt before every effect              | It obscures material risk among repetitive low-risk confirmations.                |

## Consequences

Credentials can be tested and revoked without disclosure, local and CI trust
boundaries stay separate, and logs require centralized redaction. Live apply
is unavailable when a backend or envelope cannot satisfy an adapter exactly;
the CLI must report the missing scope or action instead of silently falling
back.
