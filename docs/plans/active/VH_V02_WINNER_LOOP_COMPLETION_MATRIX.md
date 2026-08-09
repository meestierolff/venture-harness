# Venture Harness v0.2 + Winner Loop — completion matrix

- Branch: `sol/vh-core-v0.2-winner-loop`
- Baseline SHA at start of completion run: `5d9efacc8d1377e4e0da95189bdd58827806390d`
- Backup tag: `backup/pre-completion-5d9efac`
- `origin/main`: `de69705a5b1b4404771c66cf169a6cbcf885fb3a`

## Baseline verification

| Claim from previous run      | Verified | Evidence                                          |
| ---------------------------- | -------- | ------------------------------------------------- |
| 16 reviewable commits        | yes      | `git rev-list --count origin/main..HEAD` = 16     |
| Working tree clean           | yes      | `git status --short` empty                        |
| No stashes / single worktree | yes      | `git stash list` empty; one worktree              |
| 309 passing tests            | yes      | reproduced after `pnpm install --frozen-lockfile` |
| No `.skip` / `.only`         | yes      | grep over `tests/` returned nothing               |
| Lint / format / build pass   | yes      | re-run at baseline                                |

## Status vocabulary

`VERIFIED_RUNTIME` executed through production code with tests ·
`VERIFIED_FIXTURE` executed end to end against a labelled synthetic fixture ·
`IMPL_EXT_PENDING` implemented, live provider verification pending ·
`MISSING` not implemented · `PARTIAL` incomplete

---

## E. Winner Loop

| ID    | Requirement                                             | Status           | Implementation                                               | Evidence                                                                            |
| ----- | ------------------------------------------------------- | ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| WL-01 | Permanent opaque `creative_id`                          | VERIFIED_RUNTIME | `lib/winner-loop/creative-ledger.ts`, `ids.ts`               | `tests/winner-loop-creative-ledger.test.ts` (17)                                    |
| WL-02 | Versioned `content_fingerprint`, separate from identity | VERIFIED_RUNTIME | `lib/winner-loop/fingerprint.ts`                             | test: algorithm change leaves ids stable                                            |
| WL-03 | `delivery_variant_id` for non-media changes             | VERIFIED_RUNTIME | `creative-ledger.ts`                                         | caption/UTM-only changes keep one creative id                                       |
| WL-04 | Lineage on material adaptation                          | VERIFIED_RUNTIME | `creative-ledger.ts`                                         | `lineageOf` test                                                                    |
| WL-05 | Provider mappings cannot be rebound                     | VERIFIED_RUNTIME | `creative-ledger.ts`                                         | `provider_object_already_mapped`                                                    |
| WL-06 | Organic/paid status separated per network               | VERIFIED_RUNTIME | `creative-ledger.ts`                                         | TikTok win does not imply Meta eligibility                                          |
| WL-07 | Missing metrics are never zero                          | VERIFIED_RUNTIME | `lib/winner-loop/metrics.ts`                                 | `tests/winner-loop-metrics.test.ts` (8)                                             |
| WL-08 | Provider-scoped metric definitions                      | VERIFIED_RUNTIME | `metrics.ts`                                                 | `incomparable_definitions`                                                          |
| WL-09 | Growth Contract as runtime policy                       | VERIFIED_RUNTIME | `lib/config/growth-contract-schema.ts`, `config/growth.yaml` | `tests/winner-loop-evaluator.test.ts`                                               |
| WL-10 | Net contribution, not gross price                       | VERIFIED_RUNTIME | `netContributionPerSubscriberMinor`                          | affordability tests                                                                 |
| WL-11 | Baseline-adjusted evaluator, no views rule              | VERIFIED_RUNTIME | `lib/winner-loop/evaluator.ts`                               | 150k-view creative loses to 30k-view creative                                       |
| WL-12 | Scoring version immutable on history                    | VERIFIED_RUNTIME | `evaluator.ts`                                               | reweighting leaves prior evaluation unchanged                                       |
| WL-13 | Immutable PaidTestProposal                              | VERIFIED_RUNTIME | `lib/winner-loop/paid-test.ts`                               | `tests/winner-loop-paid-gate.test.ts` (21)                                          |
| WL-14 | First paid euro needs human approval                    | VERIFIED_RUNTIME | `paid-test.ts` `assertAuthorized`                            | 14 tests assert adapter never called                                                |
| WL-15 | Transactional spend reservations                        | VERIFIED_RUNTIME | `lib/winner-loop/spend-store.ts`                             | two DB clients cannot overreserve                                                   |
| WL-16 | Idempotency keys                                        | VERIFIED_RUNTIME | `spend-store.ts` unique constraint                           | replay returns original reservation                                                 |
| WL-17 | Cap hierarchy                                           | VERIFIED_RUNTIME | `spend-store.ts`                                             | per-cap tests incl. monthly/campaign                                                |
| WL-18 | Overspend recorded + freezes grant                      | VERIFIED_RUNTIME | `spend.ts` `settle`                                          | `provider_overspend` incident test                                                  |
| WL-19 | Auto-pause                                              | VERIFIED_RUNTIME | `spend.ts` `evaluateAutoPause`                               | 8 trigger test                                                                      |
| WL-20 | No automatic scaling in V1                              | VERIFIED_RUNTIME | `spend.ts` `proposeScale`                                    | absence-of-property test; schema pins `auto_scale_allowed: false`                   |
| WL-21 | Readiness ladder, fails closed                          | VERIFIED_RUNTIME | `lib/winner-loop/readiness.ts`                               | unknown/stale eligibility blocks VBO                                                |
| WL-22 | Attribution classification                              | VERIFIED_RUNTIME | `lib/winner-loop/attribution.ts`                             | 7 classes; only DETERMINISTIC is "exact"                                            |
| WL-23 | RevenueCat is not the attribution engine                | VERIFIED_RUNTIME | `attribution.ts`                                             | subscription event alone → UNKNOWN                                                  |
| WL-24 | Duplicate + out-of-order webhooks                       | VERIFIED_RUNTIME | `lib/winner-loop/subscriptions.ts`                           | occurrence-time ordering; replay determinism                                        |
| WL-25 | Sandbox/production separation                           | VERIFIED_RUNTIME | `subscriptions.ts`                                           | sandbox event rejected                                                              |
| WL-26 | D0/D7/D30 cohorts with limitations                      | VERIFIED_RUNTIME | `subscriptions.ts` `cohort`                                  | creative-level certainty gated on attribution                                       |
| WL-27 | DistributionPR learning contract                        | VERIFIED_RUNTIME | `lib/winner-loop/learnings.ts`                               | confidence capped by attribution quality                                            |
| WL-28 | Fixture D end to end                                    | VERIFIED_FIXTURE | `lib/winner-loop/fixture-d.ts`                               | `tests/winner-loop-fixture-d.test.ts` (14); `pnpm fixture:winner-loop`              |
| WL-29 | Creative trace artifact                                 | VERIFIED_FIXTURE | `buildCreativeTrace`                                         | `reports/audit/winner-loop-creative-trace.json`                                     |
| WL-30 | Cross-venture isolation (creative + spend)              | VERIFIED_RUNTIME | ledger venture scoping                                       | `cross_venture_access_denied`                                                       |
| WL-31 | `winner_loop` analytics event pack                      | MISSING          | —                                                            | not implemented                                                                     |
| WL-32 | Creative manifest + full rights model                   | PARTIAL          | `RightsState`/`DisclosureState` enforced at the gate         | full manifest (licences, consent, expiry, reviewer) not modelled                    |
| WL-33 | Organic publishing modes + caps                         | MISSING          | default recorded in Growth Contract only                     | no publishing service                                                               |
| WL-34 | Dedicated fatigue model                                 | PARTIAL          | evaluator returns `FATIGUE_DETECTED` from velocity decline   | no standalone fatigue evaluator or paid-frequency inputs                            |
| WL-35 | Winner Loop provider adapters                           | MISSING          | —                                                            | no TikTok/HeyGen/RevenueCat/MMP adapters; Fixture D uses inline synthetic functions |

## A–D. Core, materialization, recursion, fleet

Rows below are inherited from the v0.2 baseline (commits `3fe9d08`–`94659d7`) or
were explicitly out of scope for the layout chosen earlier in this branch.

| ID      | Requirement                                  | Status           | Notes                                                         |
| ------- | -------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| CORE-01 | Credential broker                            | VERIFIED_RUNTIME | `lib/credentials/`, 5 test files                              |
| CORE-02 | Authorization envelopes + checkpoint grants  | VERIFIED_RUNTIME | `lib/authorization/`                                          |
| CORE-03 | Provider SDK lifecycle                       | VERIFIED_RUNTIME | `lib/providers/`, contract tests                              |
| CORE-04 | Durable graph runtime                        | VERIFIED_RUNTIME | `lib/workflow/`, resume/idempotency tests                     |
| CORE-05 | JSON-first `vh` CLI                          | VERIFIED_RUNTIME | `lib/cli/`, `scripts/vh.ts`                                   |
| CORE-06 | Migrations + `harness.lock`                  | VERIFIED_RUNTIME | `migrations/`, `lib/upgrade/`                                 |
| CORE-07 | Direct data ingestion                        | VERIFIED_RUNTIME | `lib/data/`                                                   |
| CORE-08 | Quality profiles fast/mvp/release            | VERIFIED_RUNTIME | `scripts/run-quality-profile.ts`                              |
| CORE-09 | pnpm workspace / package boundaries          | MISSING          | single-package layout retained                                |
| CORE-10 | Command bus (one contract → API/CLI/MCP/SDK) | MISSING          | not implemented                                               |
| CORE-11 | Agent Surface generators                     | MISSING          | not implemented                                               |
| CORE-12 | Pack runtime (installable Winner Loop)       | MISSING          | Winner Loop is a library, not an installable pack             |
| CORE-13 | Fleet Controller                             | MISSING          | `vh upgrade` exists; no controller, canary, or rollout        |
| CORE-14 | Recursive Venture Runtime / Connection Hub   | MISSING          | not implemented                                               |
| CORE-15 | Winner Loop database migrations              | MISSING          | spend store creates its own schema; no versioned migration    |
| SEC-01  | Gitleaks / CodeQL / Dependabot               | MISSING          | no scanning tooling configured                                |
| SEC-02  | Adversarial tenant isolation suite           | PARTIAL          | ledger-level scoping tested; no cross-layer adversarial suite |

## Counts

| Status           | Count |
| ---------------- | ----- |
| VERIFIED_RUNTIME | 38    |
| VERIFIED_FIXTURE | 2     |
| PARTIAL          | 3     |
| MISSING          | 12    |

## Honest limits

No provider was contacted during this run. Every TikTok, RevenueCat, HeyGen, and
MMP interaction in this branch is a synthetic function inside Fixture D, labelled
`SYNTHETIC_FIXTURE — no provider was contacted`. Nothing here is evidence about
real provider behaviour, and no advertising spend, organic publication, customer
contact, or charge occurred.

The SQLite spend store is production-capable for a single host. A hosted
Postgres/Neon store implementing the same `SpendStore` interface is required
before multi-region deployment; `BEGIN IMMEDIATE` becomes `SELECT … FOR UPDATE`
or a serializable transaction.
