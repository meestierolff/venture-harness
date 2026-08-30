# Founder quickstart

Venture Harness v0.2 alpha is an open-source, agent-native factory for turning
one app idea into an independent application in accounts you own. A prior
source state completed the founder rail's root-CLI Golden Path fixture. One
isolated current-tree run completed all three slices on 2026-08-12 outside the
loopback-restricted sandbox; repeated final-tree runs and hosted CI evidence
remain pending. Every real provider effect still requires the founder's
credentials, authorization, and read-back evidence.

This is a five-minute conceptual quickstart, not a promise that provider
onboarding, DNS propagation, or a production build finishes in five minutes.

## 1. Run from source

The v0.2 package is not published as a stable release. With Node 22.5 or newer
(the durable runtime uses `node:sqlite`), from a reviewed checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Commands below use an installed `vh` binary. In this checkout, replace `vh`
with `pnpm vh --` and keep the remaining arguments unchanged.

## 2. Choose the ventures root and sharpen or validate one idea

Generated ventures are independent products and may not live inside the Core
checkout. Configure their parent directory once:

```bash
vh config set ventures-root ~/Projects/ventures
```

Copy the complete synthetic contract, replace its decisions with reviewed
founder inputs, then produce the credential-free Product Constitution, final
idea, and sanitized usage summary:

```bash
cp examples/idea-to-launch/launch-contract.yaml ./launch-contract.yaml
vh idea sharpen --input ./launch-contract.yaml --output ./idea.md --json
```

The command performs no provider effect. An existing valid `schemaVersion: 1`
Launch Contract uses the locally tested zero-model-call path. Malformed Launch
Contract-like YAML or front matter fails closed before any model call.
Unambiguously freeform prose uses the internally owned Codex CLI sharpener for
one bounded primary call and at most one schema-repair call. That host runs
read-only from a disposable non-repository directory, receives its prompt only
through stdin, and uses a small environment projection that excludes provider
credentials. It is a practical local prototype, not perfect OS-level read
isolation or a model-quality guarantee. Do not put secrets, private customer
data, testimonials, or unverified results in the input. Before continuing,
confirm the one user, painful job,
outcome, reviewable proposition hypothesis, core feature, primary journey,
commitment event, first channel, success signal, review date, assumptions,
explicit not-building list, and all 15 capability classifications. Every
capability is exactly `REQUIRED`, `DEFERRED`, or `NOT_APPLICABLE`; missing or
invalid classifications make structured input fail closed.

## 3. Connect the founder Stack once

Use the guided connector first:

```bash
vh stack connect founder-default
```

It inspects supported official CLI sessions, saves only credential-free account
metadata and `cred://` references, runs bounded read-only credential tests, then
runs Stack doctor. The connector prepares the fixed founder-default Stack; it
does not read `idea.md`. Launch preparation later filters providers from the
compiled Launch Contract, including Neon only for required persistence, Stripe
only for required supported web commerce, and RevenueCat only for required
supported native digital commerce. Brevo, Google, Bing, and DNS may remain exact
non-blocking actions when the first launch does not require them.

The wizard prints one safe next command for each unresolved role. These
lower-level commands remain available when an account cannot be discovered:

```bash
vh auth login github --ref cred://github/founder-default --scopes repo,workflow
vh auth login vercel --ref cred://vercel/founder-default
vh auth login neon --ref cred://neon/founder-default --backend macos_keychain --kind api_key
vh auth login stripe --ref cred://stripe/founder-default --backend macos_keychain --kind restricted_api_key
vh auth login brevo --ref cred://brevo/founder-default --backend macos_keychain --kind api_key
vh auth login google --ref cred://google/founder-default --backend macos_keychain --kind oauth --scopes https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/siteverification,https://www.googleapis.com/auth/webmasters
vh auth login bing --ref cred://bing/founder-default --backend macos_keychain --kind api_key
```

GitHub and Vercel use their official CLI login sessions by default. The
key-backed commands register metadata only: place each value in the selected
Keychain or 1Password backend using that backend's trusted interface. On a
non-macOS host, use a configured 1Password backend or read-only environment
mapping. Never paste a value into the Stack JSON, argv, Git, a report, or an
agent prompt.

`vh auth test <provider>` runs the built-in bounded read-only official API probe
for Neon, Stripe, RevenueCat, Brevo, Google, or Bing; GitHub and Vercel use
official CLI session reads. Stack doctor repeats the applicable probes and
persists safe pass/fail metadata. A pass proves credential/account readiness,
not that a launch resource exists or is correctly configured.

For non-interactive automation, the credential-free Stack example can be copied
into ignored local state and adjusted to the selected roles:

```bash
mkdir -p .venture/input
cp docs/public/founder-default.example.json .venture/input/founder-default.json
vh stack create founder-default --file .venture/input/founder-default.json
vh stack doctor founder-default
```

`stack doctor` is read-only. It checks reference availability, account and
scope metadata, expiry, required launch defaults, transport readiness, and
writable targets for any selected Neon, Stripe, and Google outputs. It does not
verify any live resource. Do not apply while a required role is
`auth_required` or `unconfigured`; follow the exact `nextCommand` and rerun it.

The committed file is an example only. The synthetic fixture under
`fixtures/founder-stack/` uses an in-memory backend and is intentionally blocked
from production launches.

## 4. Review the no-effect dry run

```bash
vh doctor
vh launch --idea ./idea.md --stack founder-default --production --dry-run --non-interactive
```

The result identifies the route and seed, provider accounts, repository and
resources to create, environment-variable names, migrations, domain/DNS plan,
analytics/search/email/commerce setup, estimated external effects, blockers,
and the exact apply command. Credential values are never included. A dry run
can be complete even though no provider has been contacted.

The founder-default preparation reports `setup.analytics = google_analytics`.
Vercel Web Analytics is not enabled by the apply-once plan; add it only as a
separately reviewed/manual option.

## 5. Inspect and authorize the apply boundary

Retain the command below as the exact continuation printed by the dry run. Invoke
it only after reviewing its destinations, effects and immutable Launch Grant and
explicitly authorizing that exact scope:

```bash
vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive
```

The CLI derives graph authorization from an immutable Launch Grant; do not add
`--authorization`. It stages a local child before any venture directory or
provider effect. Its internally owned Codex build host receives only bounded,
credential-free product context; Venture Harness passes it no provider
credential value, provider transport, or external-effect authority. Provider
work runs later through the separately authorized provider runtime. None of
those nodes is live evidence until its required read-back succeeds.

For a web child, the first code-owned node installs the exact child
`pnpm-lock.yaml` with `--frozen-lockfile`, ignores the parent workspace, disables
third-party lifecycle scripts, includes locked development dependencies, and
reads back `node_modules`, TypeScript, and Playwright. No product, provider,
GitHub, or deployment node can start before that check. A confirmed-missing or
interrupted install is retried only through the same bounded durable run.

The Grant's provider budget is an operation count plus direct-charge estimates
for an exact reviewed provider/capability/action allowlist. `0` means no known
direct charge for those operations; it does not include an account's recurring
plan usage. The compiled graph and Launch Grant bound two product-build tasks.
Before either runs, `codex login status` must attest a ChatGPT-subscription
session; API-key or unknown billing blocks before child creation and provider
transport. The host projects only the environment needed for the CLI session and
runs workspace-write inside the staged child. This practical boundary is not an
audited OS-isolation guarantee.

A terminal success points to
`reports/launch/<run-id>/final.{json,md}` inside the child venture. A legitimate
provider, KYC, DNS, or manual-evidence boundary returns a waiting run and an
exact `vh resume <run-id>` action. Waiting is not success, and request
acceptance is not provider verification.

If the original 24-hour Launch Grant or run envelope expires while provider
work is still unfinished, the CLI fails closed and prints an exact
`vh resume <run-id> --authorization <same-profile>` renewal command. That
renewal issues a fresh run envelope only after revalidating the original
repository, provider-account, capability, effect, and zero-unknown-cost Grant
scope; it cannot widen the persisted Grant.

## Agent-prompt equivalent

An agent with access to this checkout should translate the instruction, not
invent a second launch path:

> Sharpen and review `./idea.md`, run `vh doctor`, and run the complete production
> dry run using my `founder-default` Stack. Show every blocker and the exact apply
> command. Invoke it only after I explicitly authorize that exact Launch Grant.
> Do not expose credentials, widen authority, or claim a live result without
> provider and primary-journey read-back.

The apply path is an alpha prototype. An authenticated model host, authorized
Founder Stack and matching provider read-backs are prerequisites, not evidence
that the path has already succeeded.

## What you own

The new application is a separate repository with its own package name,
migrations, provider configuration, deployment, design, venture manifest, and
`harness.lock`. Provider accounts and created company resources remain in the
founder's Stack. Venture Harness stores references and sanitized evidence, not
credential values or ownership of the accounts.

Core upgrades classify files as `core_owned`, `merge_managed`, or
`venture_owned`. Preservation of product, design, copy, and other
venture-owned work is fixture-tested for the registered upgrade path; an
unrecognized or overlapping conflict stops for review. See
[child upgrades](../operations/CHILD_VENTURE_UPGRADES.md) and
[offboarding](../operations/OFFBOARDING.md).

## Troubleshooting

| Symptom                                         | Meaning                                                                             | Next action                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Stack profile missing                           | No durable local Stack metadata exists                                              | Create it from the credential-free JSON, then rerun doctor                    |
| `auth_required`                                 | Reference is missing, expired, revoked, untested, or lacks scope                    | Run the returned `vh auth login`/`vh auth test` command                       |
| `unconfigured`                                  | Account metadata, launch defaults, writable capture backend, or transport is absent | Correct the Stack file, recreate it, and rerun doctor                         |
| Fixture backend rejected                        | In-memory credentials cannot authorize production                                   | Use Keychain or 1Password and recreate the Stack                              |
| Matching journaled child, no run                | The prior transaction reached atomic rename before child launch began               | Rerun the exact same one-prompt command; it resumes the child                 |
| Child missing/mismatching transaction journal   | The CLI cannot prove that the existing destination belongs to this launch           | Inspect it and choose a new `--output`; it fails closed                       |
| Interrupted staging directory                   | Atomic materialization did not finish                                               | Inspect it and choose a new `--output`; do not overwrite it                   |
| Run is waiting                                  | An exact external action or evidence boundary was reached                           | Read the launch report and resume the same run ID                             |
| Frozen child install is missing or interrupted  | The lockfile/tooling read-back did not establish a complete independent install     | Repair local package access and resume the same run; descendants stay blocked |
| Package execution policy mismatch               | Scripts, dependencies, lifecycle allowlist, or lockfile differ from the Core review | Restore the generated contract or begin a deliberate Core upgrade             |
| Provider says accepted but report is unverified | Read-back has not matched the intended state                                        | Do not retry blindly; inspect or reconcile the prepared operation             |
| Custom domain is blocked                        | DNS cannot be automated or has not propagated                                       | Complete the consolidated record action; keep the stable Vercel URL           |

More detail lives in [provider authentication](../operations/PROVIDER_AUTHENTICATION.md),
[troubleshooting](../operations/TROUBLESHOOTING.md), and the
[launch-report contract](../operations/LAUNCH_REPORT.md).

## Current evidence ceiling

- Founder Stack persistence/doctor and idea-to-Launch-Grant preparation are
  locally verified.
- One isolated current-tree fixture run covers the complete public-root-CLI
  Golden Path—including the independent web seed, production-shaped providers,
  local source push, launch report, primary journey, idempotent replay, and Core
  upgrade. Required repeated final-tree runs and hosted CI remain pending.
- The focused ordinary web seed separately passed two clean local closures with
  offline frozen installs, production builds, zero-retry Chromium journeys and
  child tests; no model or provider call occurred.
- No provider resource in this central template is live verified.
- No completed comparable benchmark supports a token, cost, speed or quality
  saving claim.
- iOS/TestFlight, delegated-service runtime, Fleet, DistributionPR, and Winner
  Loop remain optional or experimental and do not belong on the default web
  path.

See [Feature Status](../product/FEATURE_STATUS.md) for the complete matrix and
[Product Truth](../product/PRODUCT_TRUTH.md) for the public claims ceiling.
