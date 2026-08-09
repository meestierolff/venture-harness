# ADR-004: Versioned managed-file upgrades

- Status: accepted
- Date: 2026-08-04
- Deciders: founder `/goal`

## Context

The v0.1 template is copied once, so child ventures cannot adopt harness fixes
without manually copying the repository and risking loss of venture-owned code
or design.

## Decision

Every venture records a harness version and `harness.lock`. Deterministic,
versioned, idempotent migrations update contracts. A managed-file manifest
records centrally owned paths and their content hashes; venture product and
design paths remain project-owned. `vh upgrade` plans changes first, detects
local divergence, applies only conflict-free managed changes, regenerates
agent adapters, verifies the result, and updates the lock last.

The target is an operator-selected local release checkout. Its own release lock
is the manifest and every managed hash is read back before planning. URL fetching
is out of scope, and a release cannot supply commands. Migration code lives in a
deterministic registry; the runtime accepts exactly one registered chain between
the locked and target versions. Managed and migration writes share a reversible
stage. The runtime executes a fixed direct-command sync/check sequence against
that stage, rechecks release hashes, and only then replaces the child lock.
For an unlocked legacy venture, a migration-produced lock is the planning
baseline. It may trust only canonical harness-owned output that the migration
itself deterministically produced. Existing paths outside that baseline fail
closed instead of being adopted implicitly.

## Alternatives considered

| Alternative                                                | Why not                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Re-copy the full template                                  | It overwrites venture work and cannot explain conflicts.                                          |
| Git submodule for the harness                              | It does not fit generated adapters or venture-local config migrations.                            |
| Force all files to remain central                          | Venture code and identity must diverge by design.                                                 |
| Fetch and execute a release URL                            | Network trust, provenance, and code execution would be hidden inside a local maintenance command. |
| Let the release declare migration or verification commands | Data from the release must not expand the executable trust boundary.                              |

## Consequences

Central corrections can reach old ventures through reviewable upgrades. The
harness must maintain migrations and managed-file hashes across releases.
Every published checkout must refresh its hash-complete baseline after adapter
sync and verification. A local release must be obtained and reviewed separately;
`vh upgrade` does not discover or fetch one. The fixed pre-lock checks do not
replace the full post-lock quality profile. Rollback is available only for
deterministic local changes; external provider effects continue to use
adapter-specific compensation and evidence.
