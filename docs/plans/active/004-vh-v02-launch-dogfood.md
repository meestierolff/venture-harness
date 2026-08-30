# Plan 004: Venture Harness v0.2 founder-alpha launch and first dogfood

- Status: active
- Owner: v0.2 launch and dogfood run
- Created: 2026-08-10
- Authorised by: founder `/goal` received 2026-08-10
- Baseline SHA: `0716a1af5f88b801f61fc4f010cadf4073b1b9ef` (`origin/main`)
- Baseline tree: identical to `f81c47b9254fb6ed229b94740c2774e0340b88dc` (merge of PR #1)
- Branch: `sol/vh-v0.2-launch-dogfood`

## North star

> An open-source, agent-native app launch factory that turns one sharpened
> founder idea into an independent, production-ready application in accounts the
> founder owns.

> AI can build your app locally. Venture Harness gets it into the real world.

This is a release cut, repair, and dogfood run. It adds no speculative
abstraction, no provider breadth, no marketplace, no hosted control plane, and
no new product pack.

## Scope and authorization

Authorized after exact dry-run review: create one private GitHub dogfood
repository, create and configure a Vercel project, create and configure a Neon
project, apply additive migrations, configure Stripe **test-mode** product,
price, webhook and billing portal, configure Brevo/Google/Bing where the
connected accounts permit, attach a custom domain where an adapter exists,
commit and push source, deploy production, run read-only production
verification, and open a draft pull request in Venture Harness.

Not authorized: live Stripe charges, advertising spend, production customer
communication, destructive database changes, nameserver replacement,
irreversible store publication, automatic merge of the Venture Harness PR, and
deletion of external resources this run did not create.

## Baseline evidence recorded before any change

| Item                     | Observed value                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Local HEAD at start      | `f81c47b` on `sol/vh-core-v0.2-winner-loop`                                         |
| Remote `main`            | `0716a1a` (merge of PR #1)                                                          |
| Working tree at start    | clean                                                                               |
| Open PRs                 | #2–#8, all Dependabot                                                               |
| Merged PRs               | #1 only                                                                             |
| `harness.lock`           | already accurate; `pnpm lock:refresh` is a no-op and idempotent (503 managed files) |
| Node in this environment | v26.7.0                                                                             |
| pnpm in this environment | 9.15.9 (matches `packageManager`)                                                   |

### Failing workflow runs on `main`

| Workflow                    | Run                      | Result          | Root cause                           |
| --------------------------- | ------------------------ | --------------- | ------------------------------------ |
| quality                     | 31330684454              | failure in 14s  | `pnpm/action-setup` version conflict |
| security                    | 31330684469              | failure in 20s  | same                                 |
| security (schedule)         | 31356738773              | failure in 11s  | same                                 |
| learning-cadence (schedule) | 31359573005, 31360131868 | failure in ~10s | same                                 |
| weekly-analysis-smoke       | 30792014039, 30244580388 | failure         | same class                           |
| codeql                      | 31330684443              | success         | —                                    |

Exact error, quoted from run 31360131868:

```text
Error: Multiple versions of pnpm specified:
  - version 9 in the GitHub Action config with the key "version"
  - version pnpm@9.15.9 in the package.json with the key "packageManager"
```

Every workflow job that installs pnpm fails before running a single check.
No repository check on `main` other than CodeQL has actually executed since the
workspace split landed. Historical audit reports that claim green gates
therefore describe local runs, not CI.

### Pre-existing local failures on the baseline

Reproduced by stashing all work and running against a clean `0716a1a`. These
are defects on `main`, not regressions introduced by this branch.

| Test                                        | Symptom                                                                                                                      | Status in this branch                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tests/founder-idea.test.ts`                | Expects the credential-labeled-field guard but the classifier now recognises the `xkeysib-` fixture value one branch earlier | Repaired: the fixture value is now genuinely unclassifiable, so it isolates the intended guard |
| `tests/founder-stack.test.ts`               | Expects the document sweep but a `cred://` reference carrying credential material is refused by the reference schema first   | Repaired: the assertion now names the stricter guard that actually fires                       |
| `tests/materialization-web-build.test.ts`   | Generated child `pnpm verify:fast` exits 2 during the offline install/build                                                  | Still failing; unchanged from baseline                                                         |
| `tests/recursive-packed-credential.test.ts` | `ERR_PNPM_NO_OFFLINE_META` resolving workspace packages in the clean offline consumer                                        | Still failing; unchanged from baseline                                                         |

`scripts/render-vh-v02-completion-matrix.ts` also cannot run locally on the
baseline: the committed command ledger holds legacy records without integrity
metadata, so the matrix can only be regenerated by a completed
`founder-alpha-final-evidence` workflow run.

## Release repairs

1. **pnpm source of truth.** `package.json` `packageManager` is canonical.
   Remove the conflicting `with.version` from all eleven `pnpm/action-setup`
   invocations across `security.yml`, `learning-cadence.yml`,
   `weekly-analysis.yml`, `public-release.yml`, `quality.yml` (×4),
   `final-evidence.yml`, `agent-parity.yml`, and `venture-verify.yml`.
2. **Node minimum.** The durable runtime uses `node:sqlite`, which requires
   Node >= 22.5.0. `package.json` `engines.node` currently claims `>=20.9.0`
   and `config/framework.yaml` claims `runtime_min_node: 20.9.0`. Both are
   dishonest. Align package.json, framework config, README, quickstart,
   workflows, and package-consumer tests on `>=22.5.0`.
3. **Final-evidence command contract.** The synthetic launch step passes
   `--name` and `--slug`, which `scripts/run-synthetic-venture-launch.mts`
   rejects with `Unknown option --name`. Remove the dead arguments rather than
   inventing script support for them.
4. **Verification semantics.** Split code readiness from live-provider proof:
   `pnpm verify:mvp && pnpm verify:release` is the complete local founder-alpha
   code and fixture gate (both staged profiles must pass with no provider
   connected), `verify:live` performs real Stack read-backs and may report
   `INCOMPLETE` with exact gaps, and `verify:stable` combines the local gate with
   required dogfood evidence. The final-evidence workflow must treat both local
   profiles as normal passing checks; neither one alone establishes code
   readiness.
5. **Gitleaks.** Keep `.gitleaks.toml` strict. Replace unnecessary
   provider-shaped synthetic strings with a clearly synthetic sentinel format;
   keep only the minimum intentional canaries, each with a recorded fingerprint.
6. **Repository security settings and dependency review.** Enable and read back
   what the current `gh` identity may change; record one exact manual action for
   anything it may not.
7. **`harness.lock`.** Refresh canonically only after source is final; prove a
   repeated refresh is a no-op.
8. **CLI build provenance.** Build `bin/vh.mjs` from an exact committed source
   SHA, emit `bin/vh-build-provenance.json`, prove byte-for-byte rebuild parity,
   and land artifacts in a separate commit.

## Founder-UX repairs

1. `vh stack connect founder-default` — a guided one-time Stack connection that
   never accepts secret values in argv and stores only `cred://` references.
2. `venturesRoot` — a persistent founder setting so ventures materialize outside
   the Core repository, with traversal and symlink escape still blocked.
3. Local child Git working repository after verified GitHub publication.
4. A missing custom domain must not block the first live app; the stable Vercel
   production URL is a valid initial canonical origin.
5. State the Codex CLI build host honestly; claim no other agent host.
6. README rewritten around the founder outcome with a copyable idea-to-app
   prompt; NOTICE, SOURCES, CHANGELOG, feature status, roadmap, quickstart and
   readiness docs corrected.
7. Default web seed reduced to a normal thin-MVP web app; v0.1 validation
   assumptions move to optional packs.
8. Sanitized per-launch model and token usage persisted to the launch report.

## Dogfood lifecycle

New venture **Launch Receipt** — a real small product for indie hackers and
small SaaS founders: email sign-in, create one launch, complete a checklist
persisted in Neon, publish a public read-only launch receipt, and send one
founder-authorized transactional receipt email. Success signal
`launch_receipt_published`. Subscription, EUR 9.00/month, web rail, private
repository, manual DNS.

The intended dogfood still requires a real configured Codex build-agent host
through the public `vh launch` path, never a fixture builder. Founder alpha now
constructs that practical host internally with bounded credential-free stdin
context, a safe environment projection and no provider capability. The boundary
is not perfect OS-level read isolation. The focused repair, protected-main merge,
authenticated host inspection and real public-path product run still require
verification; this is not permission to inject a runner or reuse the Exception
Desk fixture.

## Verification evidence

Pre-dogfood: frozen install, workspace validation and pack, packed CLI, SDK
clean install, MCP startup, agent parity, schemas, migrations, unit, integration,
tenant, redaction, provider contract, graph crash/resume, idempotency,
current-tree founder Golden Path, Winner Loop Fixture D, Fleet fixture, upgrade
fixture, raw HTML, browser, accessibility, claim checks, release checks, Gitleaks
tree and history, dependency audit, CodeQL-compatible analysis, `verify:fast`,
and the complete local founder-alpha gate
`pnpm verify:mvp && pnpm verify:release`.

Post-dogfood: `verify:live`, dogfood application verification, dogfood Core
upgrade proof, and the full release suite again.

A skipped code or fixture test is not a pass. A genuinely unavailable live check
must name provider, missing prerequisite, exact command, expected read-back,
launch impact, and whether the Vercel production URL remains usable.

## Public evidence

- `docs/audits/VH_V02_LAUNCH_READINESS.md`
- `docs/audits/VH_V02_DOGFOOD_REPORT.md`
- `reports/audit/vh-v0.2-launch-readiness.json`
- `reports/audit/vh-v0.2-dogfood.json`
- `reports/audit/vh-v0.2-dogfood-token-usage.json`
- `reports/audit/vh-v0.2-dogfood-upgrade.json`
- `reports/audit/commands-run.json`

No provider secret, private API response, connection string, private user email,
real transactional content, local `.venture` state, or dogfood environment file
may be committed.

## Current founder-alpha assignment evidence

The focused reviewed catalog for assignment sections 5–34 is
`reports/audit/founder-alpha-requirements.json`. The source-bound
`founder-alpha-final-evidence` workflow renders its machine report to
`reports/audit/founder-alpha-evidence.json` only after the audited command
ledger and the legacy v0.2 matrix have been validated. The focused report does
not treat the legacy 175-row matrix as proof that this assignment is complete.

At this source-editing checkpoint, the final workflow report has not run for
the final source SHA. Real dogfood and its dependent upgrade proof require both
the focused Codex-host repair on protected `main` and the unresolved
authenticated founder Stack prerequisites; the controlled blank-repository
benchmark remains validation-only under its separate evidence protocol.
Repository metadata, the main ruleset, and
final PR delivery are external effects whose final read-backs are still
`NOT_RUN`. These states must remain machine-visible as `EXTERNAL_BLOCKER` or
`NOT_RUN`; they may not be converted to `VERIFIED` by prose or by the older
completion matrix.

The focused renderer may emit `FOUNDER ALPHA CODE-READY, DOGFOOD BLOCKED` only
when every implementable P0, P1, and P2 row is `VERIFIED` and every remaining
row is an evidenced external blocker. Any failed or not-run implementable row
forces `INCOMPLETE`. `FOUNDER ALPHA READY` requires every focused row to be
`VERIFIED`.

## Exact remaining prerequisites

Recorded as they are observed. A provider request acceptance is never read-back.

1. **Protected-main Codex host repair.** The founder goal authorizes the bounded
   idea and product calls. A focused branch is restoring the internally owned
   practical Codex CLI hosts after the current protected-main regression. The
   repair must pass its focused and release checks, merge through a focused PR,
   and be re-read from `main` before a real product-build call is represented as
   available. This practical boundary must not be described as perfect OS-level
   read isolation.
2. **Founder Stack.** Real dogfood requires authenticated founder-owned GitHub,
   Vercel, Neon and Stripe test-mode prerequisites plus the exact Stack doctor
   read-back. Exact sequence: run
   `pnpm vh -- stack connect founder-default`, rerun
   `pnpm vh -- stack doctor founder-default`, inspect the production dry run,
   explicitly apply its exact command, then resume the same run through provider
   read-back. Expected evidence: sanitized role readiness, reviewed destinations,
   stable run ID, provider resource identifiers, and verified states.
3. **Final external read-backs.** Repository metadata, the main ruleset, final
   branch checks and PR delivery must be read back after the final source and
   artifact commits are pushed. The source-bound final-evidence workflow has
   not run for that final source SHA. Its GitHub security-settings proof also
   requires an Actions secret named `VH_GITHUB_SECURITY_READ_TOKEN`, scoped only
   to this repository with Metadata read, Administration read, Dependabot alerts
   read, Secret scanning alerts read, and Code scanning alerts read. Missing or
   forbidden read-back remains incomplete; the verifier never stores the token
   or private alert bodies.

## Current implementation status

| Area                                      | Evidence-backed state                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm and Node source of truth             | Implemented locally; final hosted CI still required                                                                                                       |
| Launch Contract and bounded sharpener     | The repaired source path completed one bounded in-worktree sharpener call; the exact external input path and paid-offer result still need focused repairs |
| Build-context manifest and Launch Receipt | Focused local tests pass; no comparative savings or live-launch claim                                                                                     |
| Founder Stack and ventures root           | Credential-free local behavior tested; real founder account doctor pending                                                                                |
| Local child Git working repository        | Fixture publication/read-back and exact clean working-repository handoff tested                                                                           |
| Focused ordinary web seed                 | Two separate clean child closures passed offline install, typecheck, build, journey and child tests                                                       |
| Current-tree founder Golden Path          | One isolated three-slice run passed outside the restricted sandbox; required repetitions remain                                                           |
| Release/live/stable verification split    | Schema and local contracts implemented; final-tree profiles and source-bound workflow still pending                                                       |
| Gitleaks and security checks              | Implementation and regression coverage present; final-tree scans and hosted evidence still pending                                                        |
| `harness.lock` and CLI provenance         | Source-bound refresh/build flow implemented; reviewed-source and artifact-only commits still pending                                                      |
| Repository security settings              | Workflow/config intent exists; GitHub metadata/ruleset and required-check read-backs still pending                                                        |
| Real dogfood and child upgrade            | Incomplete pending protected-main host repair plus founder Stack prerequisites and provider read-back                                                     |
| Blank-repository benchmark/token savings  | Not run; no token, cost, speed or quality saving is claimed                                                                                               |
| Public dogfood evidence                   | Not run; no live provider, customer, demand or market result is claimed                                                                                   |

Additionally repaired, all pre-existing on `0716a1a`: the `String.raw` seed bug
that made every materialized venture fail its own typecheck, the drifted packed
workspace closure, and two tests whose assertions named a guard that had moved.

## Commit plan

1. Commit the reviewed source, tests, workflows and evidence definitions.
2. Review that exact source SHA, then generate and commit only `bin/vh.mjs`,
   `bin/vh-build-provenance.json` and the source-bound `harness.lock` artifacts.
3. Push and read back the draft PR and required checks without merging.
4. Record real dogfood and its child upgrade only after the model and Stack
   blockers are resolved; do not manufacture substitute evidence.

## Final classification

`FOUNDER ALPHA READY` only with real GitHub, Vercel, Neon and Stripe test-mode
read-back plus a passing primary journey and Core upgrade proof.
`FOUNDER ALPHA CODE-READY, DOGFOOD BLOCKED` is permitted only when every
implementable P0, P1 and P2 plus every code, fixture, package, security and CI
check is green, including both halves of the local gate
`pnpm verify:mvp && pnpm verify:release`, and only evidenced external
prerequisites remain. Any other state is `INCOMPLETE`; it is not a release
classification.

## Continuation checkpoint — 2026-08-27

The continuation run inspected local and remote state before trusting the
historical branch name. It started on `main` at
`770f4bd49f8e8fc328b9a83a0c057a807fd3c010`; PR #9 had already been
squash-merged as `c3d8999198fc74f8dfb5bdb3cdaaed6a59c82303` on 2026-08-25.
The protected `main` ruleset is active with pull requests, linear history,
conversation resolution, squash-only merging, zero required approvals, deletion
and force-push protection, and the eight successful required check names from
PR #9. Hosted `quality`, `security`, and `codeql` runs are green for the current
remote `main` SHA.

At that checkpoint, the founder goal authorized bounded model calls, but
authorization did not prove a safe execution boundary. A macOS Seatbelt probe proved repository
allowlisting and private-home denial, yet Codex could not start with only the
single auth-file allowance; broader `.codex` access was rejected because it
would expose private auth/session state. The team therefore treated the
audited-driver prerequisite as the blocker at that checkpoint. GitHub CLI
read-back proves the intended founder
account. Vercel CLI identity, Stripe CLI test-mode availability, and Neon CLI
identity also read back successfully; this does not establish a saved
founder-default Stack, authorize a provider write, or prove any dogfood resource.

Local continuation work is still uncommitted while focused verification runs.
The current tree includes a fail-closed 15-capability Launch Contract with a reviewable
proposition hypothesis, reproducible normal child installation, hardened child
Git publication, schemaVersion 2 Launch Receipts that embed the canonical
contract and explicit model-call count, and a truth-bounded public README/visual
system; the isolated benchmark harness remains in implementation and review. No
dogfood repository, Vercel
deployment, Neon project, Stripe product/price/webhook/portal, comparable token
result, real-child Core upgrade, social-preview upload, prerelease, charge, or
advertising spend is claimed at this checkpoint.

## Continuation checkpoint — 2026-08-30

Remote `main` at `60a11864e7658212239e49805d3eeadbaeabb394` still contains the
unconditional host-disable regression. A focused local repair restores the
production-owned idea and product Codex CLI hosts with credential-free stdin
context, safe environment projection, typed results and a separate provider
runtime. That implementation is a practical founder-alpha boundary, not perfect
OS-level read isolation. It is not authoritative until focused tests, the full
applicable gates, protected-branch checks, merge and `main` read-back complete.

The founder goal already authorizes the bounded idea and product model calls, so
model transmission is no longer the current approval blocker. The saved
founder-default Stack still lacks the required Neon and Stripe credential
references/readiness evidence. No dogfood repository, deployment, provider
resource, primary-journey proof, child upgrade or prerelease is claimed here.

The repaired public source path was exercised with the exact Launch Receipt
rough text from a temporary in-worktree file. It completed one authenticated
`codex_cli` call with 20,120 input, 9,984 cached-input and 1,656 output tokens
(21,776 total) in 41,092 ms; the CLI emitted no model identifier, stored no
transcript and performed no provider effect. The assignment's exact external
`~/Projects/venture-inputs/...` command first failed before model invocation
with `Path escapes the venture root`, and the successful retry classified the
offer as free with payments not applicable. Those are two separate focused
compatibility defects; neither result is an accepted dogfood Launch Contract.
