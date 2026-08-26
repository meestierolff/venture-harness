# Venture Harness

**AI can build your app locally. Venture Harness gets it into the real world.**

A free, open-source, agent-first SaaS Launch Factory. Sharpen the idea, build the
smallest useful product, connect your own stack, and deploy a real application
you own.

> **Founder Alpha.** Every capability in this repository is verified by local
> tests and synthetic fixtures. No live child venture has been launched from it
> yet. Read [What to expect](#what-to-expect) before you rely on anything here.

Boilerplates reuse code. Venture Harness reuses the whole path from idea to a
verified deployment — the contract, the seed, the provider adapters, the
migrations, the quality profiles, and the upgrade logic.

---

## Contents

- [What it does](#what-it-does)
- [What it is not](#what-it-is-not)
- [Requirements](#requirements)
- [Setup](#setup)
- [Your first launch](#your-first-launch)
- [What gets created](#what-gets-created)
- [What to expect](#what-to-expect)
- [Token-efficiency objective](#token-efficiency-objective)
- [Architecture](#architecture)
- [Security and ownership](#security-and-ownership)
- [No hidden telemetry](#no-hidden-telemetry)
- [Core upgrades](#core-upgrades)
- [Verification](#verification)
- [Contributing](#contributing)

---

## What it does

```text
rough idea
  → sharpened Launch Contract
  → smallest useful product
  → independent repository
  → your own infrastructure
  → production deployment
  → provider read-back
  → Launch Receipt
```

Five commands carry that path:

```bash
vh idea sharpen --input ./rough-idea.md --output ./idea.md
vh stack connect founder-default
vh launch --idea ./idea.md --stack founder-default --production --dry-run --non-interactive
vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive
vh upgrade
```

Everything else is implementation detail.

## What it is not

It is not a no-code builder, a hosted platform, a social scheduler, an ad
manager, a startup community, or a thirty-page business-plan generator. It
answers one question:

> What is the smallest useful online business that can be sharpened, built,
> deployed, verified, and measured from this idea?

## Requirements

| Requirement           | Why                                         |
| --------------------- | ------------------------------------------- |
| Node.js `>= 22.5`     | the durable runtime uses `node:sqlite`      |
| `pnpm` via `corepack` | the repository pins its own package manager |
| `git`                 | provenance and venture repositories         |
| A GitHub account      | the venture's repository                    |

Provider CLIs are needed only for the roles you actually use. `vh doctor`
reports which are installed:

| CLI                     | Role                     | Blocks a web launch                     |
| ----------------------- | ------------------------ | --------------------------------------- |
| `gh`                    | GitHub repository        | yes                                     |
| `vercel`                | web hosting              | yes                                     |
| `neonctl`               | Postgres                 | yes, when the product persists data     |
| `stripe`                | commerce                 | only when the contract selects payments |
| `brevo` / Google / Bing | email, analytics, search | no — reported as manual actions         |

## Setup

Takes about five minutes.

**1. Clone and verify.**

```bash
git clone https://github.com/meestierolff/venture-harness.git
cd venture-harness
corepack enable
pnpm install --frozen-lockfile
pnpm verify:fast
```

A clean checkout prepares its own child dependency closure, so those two
commands are all that is needed.

**2. Choose where your ventures live.**

Ventures are independent products and are never written inside this checkout:

```bash
vh config set ventures-root ~/Projects/ventures
```

**3. Connect your stack once.**

```bash
vh stack connect founder-default
```

This inspects official CLI sessions, stores account metadata and `cred://`
references, and runs a no-effect readiness doctor. It prints every unresolved
item, whether it blocks a launch, and the exact next command. Credential values
stay behind your macOS Keychain or 1Password backend and never enter this
repository, argv, logs, or model context.

> Inside this source checkout, replace `vh` with `pnpm vh --` and leave the
> remaining arguments unchanged.

## Your first launch

Write a rough idea in plain language, then sharpen it:

```bash
vh idea sharpen --input ./rough-idea.md --output ./idea.md --json
```

This writes a credential-free `idea.md`, `idea.launch-contract.yaml`,
`idea.product-constitution.md`, and a sanitized `idea.usage.json`. It creates no
repository, deployment, or provider effect. Structured input takes a
deterministic zero-model-call path; rough prose uses one bounded pass on the
authenticated Codex CLI host, plus one repair pass only if the first result
misses the schema.

**Read the Launch Contract before continuing.** It is the scope and decision
surface: one user, one painful job, one useful outcome, one core feature, the
commitment event, the first distribution channel, the primary success signal, a
review date, an explicit not-building list, and `continue` / `change` / `stop`
rules. It is not evidence of demand.

The contract decides what gets built. If it concludes the product needs no
payments or no accounts, no Stripe or auth capability is installed — a capability
is never added just because a generic SaaS might use one.

Then plan, inspect, and apply:

```bash
vh launch --idea ./idea.md --stack founder-default --production --dry-run --non-interactive --json
```

The dry run creates nothing. It reports the selected seed, providers, resources,
migrations, environment variables, blockers, and the exact apply command. Run
that command only after you have read it.

## What gets created

```text
~/Projects/venture-harness      ← this Core monorepo
~/Projects/ventures/your-app    ← an independent product
    ├── its own git history and remote
    ├── its own database and migrations
    ├── its own deployment and analytics
    └── harness.lock
```

A generated venture keeps working when Venture Harness is offline. Its product
and design files are venture-owned and a Core upgrade never overwrites them.

## What to expect

This is the honest status. The claims register in
[docs/product/PRODUCT_TRUTH.md](docs/product/PRODUCT_TRUTH.md) is the ceiling for
every public statement, and
[docs/product/FEATURE_STATUS.md](docs/product/FEATURE_STATUS.md) tracks each
capability.

| Area                                                  | Status                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- |
| Idea sharpening, Launch Contract, fail-closed parsing | prototype, covered by local tests                        |
| Launch graph, resume, idempotency, compensation       | prototype, covered by local tests and synthetic fixtures |
| Provider adapters and read-back contracts             | prototype, exercised against local fixtures              |
| Child materialization, install, build, upgrade        | prototype, tested end to end in a temporary child        |
| A launched live child venture                         | not yet — none has been launched from this repository    |
| A published token benchmark                           | not yet — no controlled measurement has been run         |

What that means in practice: the path is exercised by roughly 1,400 local tests
and synthetic fixtures, and it has not yet been proven against a live production
deployment. Treat it as a working prototype you can drive, not as a product with
a track record.

## Token-efficiency objective

Venture Harness aims to complete the same reviewed scope and acceptance criteria
with fewer model tokens, repeated context reads, agent tasks, tool calls,
retries, and manual provider steps than starting from an empty repository.

**That is an optimization objective, not a promise of savings**, and never a
reason to weaken the product or the quality gate. No controlled comparison has
been published, so this repository states no percentage.

What it does give you is measurement. The sharpener writes sanitized call and
token counts to `idea.usage.json`, and the Launch Receipt records available
build counts and leaves unavailable values unset. Compare like-for-like runs
before drawing conclusions; never infer savings from a smaller scope or from a
fixture.

## Architecture

One public Core monorepo produces independent ventures. The Core holds the CLI,
typed contracts, seeds, provider adapters, credential handling, the graph
runtime, migrations, quality profiles, agent skills, tests, and upgrade logic.

Agents get one root [AGENTS.md](AGENTS.md), one CLI, and one context router —
which is not the same as putting the whole monorepo into every prompt. A standard
web launch loads the Launch Contract, the selected seed, the design skill, the
adapters actually selected, and the relevant verification contracts. It does not
load unrelated modules.

## Security and ownership

- Only `cred://…` references are stored in the repository. Secret values live in
  your Keychain or 1Password and never enter Git, logs, argv, model context, or
  Launch Receipts.
- Every resource is created in accounts you own. There is no hosted control
  plane and no shared tenancy.
- External effects require an explicit run authorization envelope, and deletion,
  destructive data changes, nameserver replacement, bulk sending, charges, and
  irreversible publication each need a distinct checkpoint.
- Provider success requires read-back evidence. A request acceptance is not a
  deployment, an indexation, a delivery, a payment, or a release.
- Private form, search, email, name, and message fields are kept out of
  analytics and normalized learning datasets.

See [SECURITY.md](SECURITY.md) and
[docs/security/THREAT_MODEL.md](docs/security/THREAT_MODEL.md).

## No hidden telemetry

Venture Harness does not phone home. It sends no usage data anywhere, requires no
account, and works fully offline apart from the providers you connect yourself.
There is no required badge in generated products.

## Core upgrades

```bash
vh upgrade --dry-run
vh upgrade
```

The upgrade reports file ownership before it changes anything. Core-owned files
update; venture-owned product and design files do not. `harness.lock` advances
only after a successful, verified upgrade.

## Verification

```bash
pnpm verify:fast      # changed-scope checks
pnpm verify:mvp       # build, typecheck, tests, e2e, accessibility, raw HTML
pnpm verify:release   # packaging and public-surface checks
```

Profiles are capability-aware: a skipped check names the credential, command, and
evidence still required rather than reporting a pass.

Before a release, run the complete local founder-alpha gate:

```bash
pnpm verify:mvp && pnpm verify:release
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Canonical agent skills live in
`skills/<name>/`; the `.claude/` and `.agents/` copies are generated — edit the
canonical source, then run `pnpm agents:sync` and `pnpm agents:check`.

MIT licensed. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
