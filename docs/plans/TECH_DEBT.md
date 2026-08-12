# TECH_DEBT

Known debt, honestly stated. Every entry names the risk it carries and the
trigger that would force repayment. Cleared entries move to the bottom with
the date and commit.

## Open

| #   | Debt                                                                                                                       | Risk                                                                                 | Repayment trigger                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1   | `verify:raw-html` needs a running server; it is CI-only and easy to skip locally                                           | crawler regressions land unnoticed until CI                                          | first crawler-related CI failure → add a local pre-push reminder                                             |
| 2   | Static PII checks in `verify-analytics-pii.ts` are pattern-based, not type-based                                           | novel property names could slip past greps                                           | first false negative → move prohibited-prop enforcement into the TrackedEvent types                          |
| 3   | Evidence API idempotency is time-bucket based, not token based                                                             | duplicate events under aggressive retries                                            | first observed duplicate in weekly analysis                                                                  |
| 4   | No automated Lighthouse/axe run in CI (thresholds documented in config/quality.yaml only)                                  | performance/a11y drift                                                               | before first production launch                                                                               |
| 5   | Node exposes no descriptor-relative `openat2`/`renameat` API; local path locks remain cooperative against the same OS user | a malicious same-user process can ignore the lock and race the last pathname syscall | Node adds portable descriptor-relative mutation support, or the CLI moves to a multi-principal local service |

## Cleared

## `framework.public_template` is misnamed (2026-08-10)

The key reads as "this is a GitHub template repository", which is wrong: Core is
never forked or used with GitHub's "Use this template". Ventures are
materialized by the CLI from versioned seeds. The intended meaning is "publicly
distributable open-source repository".

Renaming it touches `frameworkSchema`, every child venture's copy of
`config/framework.yaml`, and therefore needs an idempotent migration plus a
managed-file update. That is more risk than a naming fix warrants during a
release cut, so the meaning is documented at the definition instead.

Recommendation: rename to `public_open_source` in the next migration-bearing
change, with a migration that accepts either key for one Core version.

## Provenance ordering is easy to violate (2026-08-10)

`assertReviewedCoreSourceState` counts README.md, NOTICE.md and
`config/framework.yaml` among the CLI's executable inputs, because they ship in
the npm package. A documentation-only commit therefore invalidates the recorded
provenance, and `pnpm workspace:build` refuses until the CLI is rebuilt. The
refusal is correct, but the failure surfaces far from its cause: without a build
there is no `dist/`, so the MVP profile reports a dozen unrelated
module-not-found, typecheck and production-build failures instead of one
ordering problem.

This happened twice in this release cut.

Recommendation: have `workspace-build.mjs` name the ordering explicitly when the
only stale inputs are packaged documentation, and consider a `verify:fast` check
that fails early with "rebuild provenance from HEAD" rather than letting the MVP
profile fail wide.

## Durable SQLite stores race on journal-mode switching (cleared 2026-08-12)

All direct durable-store constructors now use one bounded WAL initializer. It
reads `PRAGMA journal_mode` back, accepts a concurrent busy transition only when
the observed mode is `wal`, and fails closed on a non-WAL or exhausted result.

`tests/command-bus-idempotency.test.ts` exercises the busy/read-back and
fail-closed branches, starts fresh command, audit, event, and metering databases
across concurrent processes for three rounds, and settles every spawned sibling
before temporary-directory cleanup. Focused stress and affected-store suites
cover the repaired path.
