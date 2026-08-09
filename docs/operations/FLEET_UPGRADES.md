# Fleet upgrades

- Status: fixture verified canary/batch controller
- Live verification: branch, merge, preview, production, and rollback hooks
  remain pending for real venture repositories
- Canonical runtime: `lib/fleet/`

## Preconditions

Use fleet rollout only for independently materialized ventures with a v2
`harness.lock`. A release must be represented by a content-bound Core release
manifest containing:

- version and exact `v<version>` source ref;
- pinned workflow SHA;
- changed package versions and affected capabilities;
- ordered migrations and compatible seed IDs;
- required venture checks;
- rollout risk and rollback mode;
- all managed files and their ownership.

The manifest digest binds one run to one release. Reusing the run ID for a
different digest fails. The source ref must be the exact `v<version>` tag and the
workflow ref must be an immutable 40-character SHA; mutable refs and version-tag
mismatches fail before rollout.

## Ownership behavior

| Ownership       | Fleet behavior                                                         |
| --------------- | ---------------------------------------------------------------------- |
| `core_owned`    | Update only from a trusted unchanged prior hash; local edits conflict. |
| `merge_managed` | Three-way merge non-overlapping edits; overlapping edits conflict.     |
| `venture_owned` | Preserve the venture file, including design and Service Blueprints.    |

Do not “resolve” a conflict by discarding venture work. Either preserve it as
venture-owned or review and reconcile the content and lock hash.

## Rollout sequence

1. Sort and select ventures whose seed, packages, or capabilities are affected.
2. Choose the declared canary, or the first selected venture.
3. Persist the run and planned batches.
4. For the canary: open an upgrade branch, apply the managed-file plan, run
   migrations, run venture-specific checks, deploy/verify preview, then enter
   the policy-gated merge boundary.
5. If policy permits automatic merge only for a low-risk release, merge;
   otherwise return `waiting_for_merge_approval` and pause.
6. If authorized by venture policy, deploy production and smoke-read the exact
   target version.
7. Write `last_verified_upgrade` only after every required check/read-back.
8. Continue through bounded batches only while every prior result is
   `verified` or `already_current`.

Any other canary or batch outcome pauses all later ventures.

## Failure and compensation

Before production, the controller restores the captured file snapshot and
returns `rolled_back`. After production was touched, it invokes the release's
declared compensation mode:

- `previous_release`: restore prior state only when compensation read-back
  passes;
- `forward_fix`: preserve the candidate state and report
  `forward_fix_required`.

Never claim rollback from a request acceptance. Read back deployed health and
version.

## Durable ownership and resume

Fleet state can use the in-memory fixture store or the SQLite WAL store. Only
the SQLite store supplies cross-process persistence. It creates a run without
overwriting an existing digest and acquires or renews an expiring owner lease
under `BEGIN IMMEDIATE`; a second active controller cannot advance the same run.
The record persists release digest, deterministic selection digest, status,
canary, batches, per-venture phase, branch, versions, evidence, checkpoints, and
error. Re-running a completed or paused run returns its existing record and does
not repeat hooks.

Every external hook writes a request-bound `prepared` checkpoint before
invocation and `completed` only after the result is persisted. On restart after
lease expiry, `reconcilePhase` must return one of:

- `completed`: persist its read-back evidence and do not call the hook again;
- `not_applied`: the same idempotency key may be retried;
- `unknown`: pause without repeating the hook.

The controller preserves a verified canary and earlier verified batch results
when a later venture crashes. Changing the venture selection or batch shape on
resume fails closed. Each per-venture checkpoint also binds the repository,
design fingerprint, Service Blueprint fingerprint, and original/candidate
`harness.lock` digest; a same-ID replacement target cannot inherit a prior
result or effect checkpoint.

Before any real rollout, inspect:

- affected venture list and canary;
- release digest/source/workflow SHA;
- ownership plan and conflicts;
- migration and check list;
- automatic-merge and production-deployment policy per venture;
- rollback mode and exact evidence expected from every hook.

## Fixture verification

```bash
pnpm test -- tests/fleet-controller.test.ts
```

The fixture proves two-venture canary/batch order, three ownership behaviors,
atomic run creation and leases, release/selection binding, prepared-phase
reconciliation, non-replay of completed hooks, pause-on-unknown, preservation
of earlier verified results, same-ID target-substitution rejection, high-risk
merge approval, state replay,
pause-on-failure, and compensation paths. It does not open a real branch, merge
a pull request, or deploy a venture.

## Live verification pending

For a real fleet run, record sanitized read-back evidence for the branch head,
checks, preview identity/health, merge commit, production deployment/version,
smoke result, and any compensation. Until all are observed, report the relevant
venture as pending or paused, never verified.
