# Venture Harness v0.2 Codex verification

> Historical 2026-08-09 legacy-matrix snapshot. It reviews the earlier
> `sol/vh-core-v0.2-winner-loop` scope and must not be used as evidence for the
> founder-alpha assignment or the present branch. Current founder-alpha status
> is defined by `reports/audit/founder-alpha-requirements.json` and its
> source-bound final-evidence report; until that report runs, final status is
> incomplete.

- Review date: 2026-08-09
- Branch: `sol/vh-core-v0.2-winner-loop`
- Recovered starting SHA: `1ba4a22f08f356a510e0611b9081f5d16eaa2823`
- Backup reference: `backup/opus-vh-core-v0.2-1ba4a22`
- Evidence ceiling: local runtime, clean-consumer integration, and labelled synthetic fixtures
- Release hand-off: `PENDING_ROOT_FINALIZATION`

## Outcome

The reviewed proof catalog preserves a terminal classification for all 174 P0, P1, and P2 requirements: verified runtime, verified integration, verified fixture, or implemented with live verification pending. No proof introduces a `PARTIAL`, `STUB`, `MISSING`, `INCORRECT`, or `CONTRADICTED_BY_RUNTIME` status, and the original baseline counts remain explicit below. Terminal row intent is not the same thing as a final green run: the current command ledger is missing nine referenced final command IDs and its latest `final-unit-tests` attempt failed, so this document does not infer a final aggregate gate, hosted CI, push, or pull-request result.

The product-truth rule controls the language in this report: local tests support runtime, integration, and fixture claims, while `LIVE` requires authenticated production read-back. The quality-gate rule likewise treats a skipped or not-yet-run aggregate check as pending, never as a pass.

`reports/audit/requirement-proofs.json` is the reviewed source of truth for row evidence. The generated completion matrices were deliberately not re-rendered during this reconciliation pass; the root completion pass must first settle the active implementation follow-ups and final command ledger, then render and validate both generated matrices.

## Recovery and independent baseline verification

The branch was recovered at `1ba4a22f08f356a510e0611b9081f5d16eaa2823`, and a backup branch was created before repair. The historical Opus baseline at `5d9efacc8d1377e4e0da95189bdd58827806390d` contains exactly 16 commits above the recorded `origin/main`; its frozen archive reproduced 309 passing tests across 48 files, with lint, formatting, build, strict verification, and health green at that historical SHA.

Those historical claims did not prove the recovered tip or architectural completeness. At the recovered tip, lint and build failed on Winner Loop type/lint defects, strict verification failed with active-plan drift, creative identity was initially content-derived, spend concurrency and unknown-outcome handling were unsafe, D0 cohort behavior was incorrect, Fixture D bypassed required production boundaries, and the packed CLI failed in a clean consumer. The detailed claim-by-claim record is in `reports/audit/opus-claims-verification.json`.

## Requirement matrix

| Measure                               | Initial | Final |
| ------------------------------------- | ------: | ----: |
| Total requirements                    |     174 |   174 |
| P0                                    |      33 |    33 |
| P1                                    |     102 |   102 |
| P2                                    |      39 |    39 |
| VERIFIED_RUNTIME                      |       0 |    64 |
| VERIFIED_INTEGRATION                  |       0 |    61 |
| VERIFIED_FIXTURE                      |       0 |    31 |
| IMPLEMENTED_LIVE_VERIFICATION_PENDING |       0 |    18 |
| PARTIAL                               |      49 |     0 |
| MISSING                               |     117 |     0 |
| INCORRECT                             |       5 |     0 |
| CONTRADICTED_BY_RUNTIME               |       3 |     0 |

The preserved counts come from the 174-row baseline and terminal status allocation. Row-level reviewed evidence is now maintained in `reports/audit/requirement-proofs.json`; the Markdown and JSON completion matrices remain generated projections pending the root's final render.

## Architecture and runtime verdict

The repository is now a real pnpm workspace with 30 package boundaries and five application boundaries. Workspace validation reports zero dependency cycles; command contracts generate direct, REST, CLI, MCP, SDK, and UI surfaces from one catalog; the packed-consumer test covers CLI, MCP, and SDK distribution behavior.

The venture materializer requires an immutable Launch Grant before workspace or provider activity, creates only inside an empty isolated directory, selects one of three versioned seeds, writes a v2 `harness.lock`, emits a Venture Manifest, Connector Manifest, ServiceBlueprint, and venture-specific Agent Surface, and keeps advertising spend outside the Launch Grant. CompanyStack effects have deterministic fixture read-back, while authenticated GitHub, infrastructure, preview, and production read-back remain pending.

The recursive runtime persists users, customer organizations, memberships, subscriptions, entitlements, customer-owned connections and resources, Service Grants, Agent Grants, usage, webhooks, and an audit chain in SQLite. Operator identity is present in every recursive table and primary key, with venture and customer organization retained as separate tenancy dimensions; legacy or partially scoped databases fail closed until an explicit mapping repairs them. One venture-specific service command and its read-back reconciliation contract are generated across direct, REST, CLI, MCP, SDK, and UI surfaces. Unknown provider outcomes retain metering headroom and reconcile by read-back without repeating the original effect; credentials remain behind operator-, venture-, customer-, and connection-scoped `cred://` references.

The migration package now provides a durable stream-aware SQLite runner rather than only an in-memory state transform. It orders checksum-bound Core, pack, and organization-plus-venture streams, journals schema read-back atomically, rolls interrupted transactions back, serializes competing processes, and applies committed migrations once across restart. A `forward_fix` failure is terminal under its original identity: only a new dependency bound to the failed checksum may repair it, and successors wait for the repair's successful read-back.

The operating-loop package contains an explicit immutable catalog for all ten required loops: inner build, provider verification, launch, daily early signal, weekly growth, biweekly product, monthly strategy, winner metric snapshots, creative fatigue, and fleet upgrade. Each contract specifies trigger, freshness-bound inputs, primary metrics, guardrails, decision rules, action and iteration limits, autonomy, allowed effects, output, next run, and stop conditions. The SQLite execution path is tenant-bound, lease-based, restartable, and designed to reconcile ambiguous effects without replay, but the latest scoped run exposed an unsettled fencing-token regression described under focused evidence; CORE-016 therefore remains command-verification pending until that dedicated suite is green.

The workflow runtime persists node state and append-only events, handles fan-out/fan-in, bounded parallelism, waits, retries, cancellation, compensation, crash reconciliation, queues, supersession, steering, isolated workspaces, loop bounds, and model/tool budgets. Unknown external effects are reconciled before retry and are never blindly repeated.

The Fleet Controller consumes immutable release manifests, calculates affected ventures, applies three ownership classes with safe three-way merge, runs a canary before bounded batches, persists rollout state, gates high-risk merge, and compensates and pauses on canary failure. Its durable identity is the full company organization plus venture pair: same-slug ventures in different organizations retain independent hook, lease, checkpoint, and replay state, and same-ID replacement targets are rejected. Production and compensation claims require a separate health read-back for that exact target and version; after lease expiry a replacement controller reconciles completed phases without reapplying them, while an unknown read-back stays paused.

## Winner Loop verdict

Creative identity is an opaque permanent key; content fingerprints are versioned and separate; delivery-only variants keep identity, while material media changes create lineage. Creative, provider mapping, delivery, status-history, manifest, rights, and revocation state are durable and migration-backed. Legacy adoption is explicit and fail closed across all six Winner stores: creative ledger, creative manifest, evidence, subscription, spend, and paid-test proposal. A complete out-of-band ownership mapping is required, nested tenant identity is rewritten atomically, equal opaque IDs remain isolated across organizations, collisions roll back, sentinel access is removed, and financial or approval authority is invalidated so reapproval is required.

The Growth Contract is an executable policy for hypotheses, organic behavior, metric windows, scoring, economics, spend caps, readiness, attribution, cohorts, and V1 automation limits. Metric snapshots preserve provider account, source object, reporting/source/fetch times, latency, definition version, confidence, raw reference, and explicit missingness under organization-plus-venture scope. Account, format, and duration baselines accept only compatible source snapshots and retain immutable source references; conflicting revisions, future evidence, or tenant/provider/account/geography/format/duration swaps fail closed. Evaluation, attribution, cohort, and learning records restore their lineage after restart, and DistributionPR rejects foreign learning or nested cohort scope while preserving non-causal limitations.

Paid activity requires an immutable PaidTestProposal, exact human approval, current rights/disclosure review, and a separate Spend Grant. The SQLite spend ledger binds idempotency to the full request, serializes separate processes and clients, enforces creative/account/campaign/venture/customer/platform caps, retains ambiguous reservations, reconciles provider outcomes, records actual overspend, freezes the grant, supports a kill switch and automatic pause, and exposes no automatic cap increase in V1.

Attribution is explicitly classified; RevenueCat raw-body authentication, tenant routing, duplicate/conflict handling, occurrence-time ordering, refunds, billing state, currency identity, and D0/D7/D30 cohorts are covered locally. D90 is configurable without claiming mature evidence. The event pack is install- and enable-gated, first-party only, and rejects private, personal, raw creative, and credential-like properties.

Fixture D now traverses the command bus, durable graph, fixture provider lifecycle, SQLite stores, asset vault, hash-chain audit, event pack, budget ledger, attribution, cohorts, and DistributionPR proposal generation under one full organization-plus-venture `TenantRef`. Equal fixture-provider keys remain isolated across organizations after restart, and legacy fixture state without organization scope is rejected. Its committed trace contains 34 ordered milestones and explicitly states that no provider was contacted.

## Security and public-release evidence

Local runtime tests cover OAuth state, S256 PKCE, exact redirect allowlists, single-use callbacks, raw-byte route-bound webhook authentication with freshness and rotation, exact-host HTTPS SSRF policy, upload size and MIME signatures, storage-root containment, shell-free provider command execution, audit-chain tamper detection, and secret rejection/redaction.

The repository includes exact allowlisted Gitleaks fixtures, current-tree and history scan configuration, pinned GitHub Actions, CodeQL, dependency review, Dependabot, public-release checks, governance, contributing, conduct, security, threat-model, provider-boundary, and open-source-readiness documents. Hosted CodeQL, dependency-review, Dependabot, branch protection, and push protection require GitHub read-back after push and are not claimed here.

The quality contract now places workspace build, export/graph validation, and packed clean-consumer verification in distinct phases: build at phase 2, workspace contract at phase 3, and pack/CLI/MCP/SDK consumer checks at phase 4. The release profile also retains compatibility, public-release, format, lint, type, unit, migration, provider, fixture, graph, analytics, and production-build checks. A failed check or unresolved live read-back yields `FAIL` or `INCOMPLETE` with a nonzero exit; the implementation does not turn a skip into a pass. The final `final-workspace-build` and `final-verify-release` command records are still pending.

## Independently reproduced focused evidence

The documentation slice independently ran this architecture-focused suite:

```text
pnpm exec vitest run --testTimeout=20000 --no-file-parallelism \
  tests/workspace-boundaries.test.ts \
  tests/command-surfaces-parity.test.ts \
  tests/materialization.test.ts \
  tests/venture-runtime.test.ts \
  tests/provider-idempotency-safety.test.ts \
  tests/workflow-runtime.test.ts \
  tests/workflow-control-plane.test.ts \
  tests/workflow-durable-recovery.test.ts \
  tests/fleet-controller.test.ts \
  tests/winner-loop-creative-persistence.test.ts \
  tests/winner-loop-spend-safety.test.ts \
  tests/winner-loop-integrations.test.ts \
  tests/winner-loop-fixture-d.test.ts \
  tests/winner-loop-fixture-runtime.test.ts \
  tests/security-boundaries.test.ts \
  tests/security-release.test.ts
```

At the then-current source, that earlier slice passed 16 files and 181 tests with zero failures, including 13/13 command-surface tests and the explicit shared command-grant expiry control. The current ledger also records `final-workspace-check` and the packed clean-consumer suite as passed. Those earlier results are retained as historical focused evidence, not substituted for the final full-suite rerun after later source edits.

The proof-catalog refresh then ran this narrower current-source suite without writing to `commands-run.json`:

```text
pnpm exec vitest run --testTimeout=30000 --no-file-parallelism \
  tests/operating-loop-runtime.test.ts \
  tests/migrations.test.ts \
  tests/fleet-controller.test.ts \
  tests/winner-loop-legacy-adoption-contract.test.ts \
  tests/winner-loop-legacy-adoption.test.ts \
  tests/winner-loop-creative-persistence.test.ts \
  tests/winner-loop-metrics.test.ts \
  tests/winner-loop-evaluator.test.ts \
  tests/winner-loop-integrations.test.ts \
  tests/winner-loop-fixture-runtime.test.ts \
  tests/quality-profiles.test.ts
```

Current result: 10 files and 173 tests passed; `tests/operating-loop-runtime.test.ts` passed 6/10 and failed 4/10. Three failures reported `effectful loop action is missing its fencing attempt token`; the atomic SQLite owner/tenant-isolation case timed out at 30 seconds and surfaced the same unhandled error. A companion run of `tests/packaged-quality-command.test.ts` passed 3/4 and failed because active `upgrade.apply` routing now returns `requires --release <trusted-local-release-root>` while the still-moving test expected the command to be unknown. Neither failure is presented as a pass; both require settled source plus a fresh final command record.

Scoped artifact validation passed JSON parsing for all edited reports, Prettier check for the catalog/reports/document, and `pnpm typecheck`. The `pnpm validate:docs` and `pnpm validate:claims` wrappers could not open the sandboxed `tsx` IPC pipe (`listen EPERM`); invoking the same checked-in scripts with `node --import tsx` passed all documentation and claim checks. The command-bound proof-catalog validator and matrix renderer were intentionally not run because their final ledger prerequisites are unresolved and the root requested that generated matrices remain untouched.

## Evidence artifacts

| Artifact                                              | Purpose                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `reports/audit/requirement-proofs.json`               | Reviewed evidence and command binding for all 174 rows        |
| `reports/audit/vh-v0.2-codex-requirement-matrix.json` | Machine-readable initial and final requirement statuses       |
| `reports/audit/opus-claims-verification.json`         | Independent historical claim audit                            |
| `reports/audit/stubs-and-dead-code.json`              | Stub, disabled-test, empty-boundary, package, and cycle audit |
| `reports/audit/golden-paths.json`                     | Four required end-to-end paths and evidence ceilings          |
| `reports/audit/negative-controls.json`                | Twenty required fail-closed controls                          |
| `reports/audit/winner-loop-creative-trace.json`       | Sanitized 34-step Fixture D trace                             |
| `reports/audit/fleet-upgrade-success.json`            | Sanitized successful two-venture rollout fixture              |
| `reports/audit/fleet-canary-failure.json`             | Sanitized canary failure, compensation, and pause fixture     |
| `reports/audit/commands-run.json`                     | Exact final command attempts, exits, skips, and logs          |

## Live verification still pending

No real repository, infrastructure resource, DNS record, product, price, email, App Store record, TestFlight build, creative render, social post, ad, attribution export, RevenueCat project, spend, charge, customer record, or Fleet registry was created or mutated. Live provider rows require the founder's credentials and authorization envelope, then provider read-back evidence through the documented doctor/plan/dry-run/apply/read-back/verify/reconcile lifecycle.

Local implementation follow-ups are also pending. The auth/upgrade/Fleet CLI work and its packaged-command assertions, plus the fresh persisted recursive Agent Grant expiry case, were still moving during this evidence pass and are not claimed as settled. `NEG-005` continues to describe the separately verified shared command-grant expiry control from `tests/command-surfaces-parity.test.ts`; it must not be misread as final evidence for the fresh recursive follow-up. The operating-loop fencing-token failures above likewise require repair and a green dedicated rerun before the root finalization.

## Final aggregate hand-off

The proof catalog references 17 distinct final command IDs. The current ledger has seven with a latest pass, nine absent, and one with a latest failure. The exact unresolved IDs are below; pending and failed are not pass.

| Command ID              | Current ledger state         | Required root action                                                |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `final-unit-tests`      | `FAILED` at latest attempt 2 | Settle all source, run `pnpm test`, and record the complete result. |
| `final-e2e`             | `ABSENT_FROM_LEDGER`         | Run and record `pnpm test:e2e`.                                     |
| `final-frozen-install`  | `ABSENT_FROM_LEDGER`         | Run and record `pnpm install --frozen-lockfile`.                    |
| `final-raw-html`        | `ABSENT_FROM_LEDGER`         | Run the built-server raw-HTML check and record its evidence.        |
| `final-release-check`   | `ABSENT_FROM_LEDGER`         | Run and record `pnpm release:check`.                                |
| `final-verify`          | `ABSENT_FROM_LEDGER`         | Run and record `pnpm verify`.                                       |
| `final-verify-fast`     | `ABSENT_FROM_LEDGER`         | Run and record `pnpm verify:fast`.                                  |
| `final-verify-mvp`      | `ABSENT_FROM_LEDGER`         | Run and record `pnpm verify:mvp`.                                   |
| `final-verify-release`  | `ABSENT_FROM_LEDGER`         | Run and record `pnpm verify:release`; live skips remain incomplete. |
| `final-workspace-build` | `ABSENT_FROM_LEDGER`         | Run and record `pnpm workspace:build` after source settles.         |

The current passing records for `final-fixture-d`, `final-gitleaks-history`, `final-gitleaks-tree`, `final-synthetic-launch`, `final-test-controls`, `final-workspace-check`, and `final-workspace-pack-consumer` do not substitute for any unresolved ID. `final-typecheck`, `final-prod-audit`, `final-agent-sync`, and the audit documentation/link checks are also recorded as passing, but are not among the 17 command IDs used by row proofs.

Hosted GitHub Actions, the pushed remote branch, draft pull request, and final clean-tree evidence remain placeholders for the root completion pass. The root must update this section from recorded evidence after the final commands, regenerate the matrices, validate the proof catalog, and must not infer provider or hosted-CI success from local results.

Green local evidence does not authorize deployment, publication, sending, spending, charging, merging, or any other external effect.
