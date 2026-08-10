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
   `verify:release` (founder-alpha code and fixture gate; must be able to pass
   with no provider connected), `verify:live` (real Stack read-backs; may report
   `INCOMPLETE` with exact gaps), `verify:stable` (release plus required dogfood
   evidence). The final-evidence workflow currently asserts that
   `verify:release` **must** exit 1; that assertion inverts once the semantics
   are honest.
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

It must be built by the real configured Codex CLI build-agent host through the
public `vh launch` path. `FounderGoldenPathBuildAgentFixture` stays a regression
test and must not build this product. The Exception Desk fixture product must
not be reused.

## Verification evidence

Pre-dogfood: frozen install, workspace validation and pack, packed CLI, SDK
clean install, MCP startup, agent parity, schemas, migrations, unit, integration,
tenant, redaction, provider contract, graph crash/resume, idempotency,
current-tree founder Golden Path, Winner Loop Fixture D, Fleet fixture, upgrade
fixture, raw HTML, browser, accessibility, claim checks, release checks, Gitleaks
tree and history, dependency audit, CodeQL-compatible analysis, `verify:fast`,
`verify:mvp`, `verify:release`.

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

## Exact external blockers

Recorded as they are observed. A provider request acceptance is never read-back.

1. **Completion-matrix regeneration.** Adding a proof row for the new `live`
   profile requires an executed `final-verify-live` command with integrity
   metadata, and the matrix renderer only runs inside
   `founder-alpha-final-evidence`. Until that workflow runs on this branch,
   `verify:live` is wired into `quality.yml` only, and no `QUAL-020` proof row
   exists. Exact action: dispatch `founder-alpha-final-evidence` on
   `sol/vh-v0.2-launch-dogfood`, then add the reviewed proof row and commit the
   regenerated matrix. Expected evidence: `reports/audit/commands-run.json`
   containing `final-verify-live` with integrity metadata.

## Remaining work in this plan

Completed in this branch:

| Section                     | Outcome                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| 3.1 pnpm source of truth    | Eleven conflicting pins removed; CI executes checks again                     |
| 3.2 harness.lock            | Accurate and idempotent across repeated refreshes                             |
| 3.3 Gitleaks                | Tree and history clean; three detectors aligned; scanner proven to still bite |
| 3.4 Repository security     | Enabled and read back; dependency-review green                                |
| 3.5 Final-evidence contract | Dead `--name`/`--slug` removed; command verified locally                      |
| 3.6 Verification model      | `release` / `live` / `stable` split, schema-enforced, tested                  |
| 3.7 CLI provenance          | Built from reviewed SHA with byte-for-byte rebuild parity                     |
| 4 Node requirements         | `>=22.5.0` everywhere the runtime actually needs it                           |
| 5.1 Stack connect           | `vh stack connect founder-default` with argv and reference guards             |
| 5.2 Ventures root           | `vh config set ventures-root`; ventures leave the Core checkout               |
| 5.4 Domain fallback         | Provider production URL is a valid first canonical origin                     |
| 5.5 Build host              | Codex CLI stated as the only claimed production build host                    |
| 6 README and NOTICE         | Promise-first opening, four routes, idea-to-app prompt                        |

Additionally repaired, all pre-existing on `0716a1a`: the `String.raw` seed bug
that made every materialized venture fail its own typecheck, the drifted packed
workspace closure, and two tests whose assertions named a guard that had moved.

Not yet started: 5.3 local child Git working repository, 7 focused seed,
8 token usage evidence, 9 dogfood venture, 10 upgrade proof, 11 full regression
suite against a real launch, 12 public dogfood evidence.

## Commit plan

1. `fix(ci): restore reproducible founder-alpha gates`
2. `fix(security): make repository scans and dependency review actionable`
3. `feat(cli): add guided founder stack connection`
4. `fix(launch): materialize ventures outside core with a working git clone`
5. `fix(launch): allow stable provider URL before custom DNS`
6. `docs: align public founder-alpha positioning and example prompt`
7. `test: prove the current-tree founder golden path`
8. `chore(release): build reviewed CLI provenance`
9. `dogfood: record first real founder launch evidence`
10. `test(upgrade): verify dogfood child core evolution`

## Final classification

`FOUNDER ALPHA READY` only with real GitHub, Vercel, Neon and Stripe test-mode
read-back plus a passing primary journey and Core upgrade proof. Otherwise
`FOUNDER ALPHA CODE-READY, DOGFOOD BLOCKED` with the exact blocker and resume
command. No other vocabulary is permitted.
