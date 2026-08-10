# Venture Harness

**AI can build your app locally. Venture Harness gets it into the real world.**

Venture Harness is an open-source, agent-native app launch factory. It turns one
sharpened founder idea into an independent, production-ready application in
accounts **you** own — repository, hosting, database, commerce, email, analytics
and search — and it verifies each of those against the provider rather than
assuming them.

You stay the owner. Venture Harness never holds your accounts, never guarantees
demand, and never spends money on advertising.

Four routes into this document:

1. [What it is](#what-it-is)
2. [Five-minute local setup](#five-minute-conceptual-quickstart)
3. [Turn an idea into an app](#turn-an-idea-into-an-app)
4. [Current verification status](#evidence-and-release-status)

## What it is

```text
connect stack once
→ write or generate idea.md
→ dry run
→ one apply command
→ independent live app
```

- **Open source and founder-operated.** You run it on your machine, against your
  own provider accounts.
- **Independent repositories.** Each venture is its own product with its own Git
  history, materialized outside the Venture Harness checkout.
- **One opinionated stack.** GitHub, Vercel, Neon Postgres, Stripe for web
  commerce, Brevo, Google Analytics, Google Search Console, Bing Webmaster, and
  a custom domain when you have one. The stable Vercel production URL is a valid
  starting origin, so missing DNS never stops a first launch.
- **One-time connection, one-prompt launch.** `vh stack connect founder-default`
  once; `vh launch --idea idea.md …` per venture.
- **Honest alpha.** A provider effect is only ever reported as done when the
  provider has been read back. See
  [current verification status](#evidence-and-release-status).

### Who it is for

- founders and indie hackers who can create software but need a dependable path
  into production;
- builders who want their agent to operate through typed commands and bounded
  authority;
- developers who want each venture in its own repository and provider stack,
  with upgrades that preserve product-owned work.

The founder rail coordinates repository creation, a focused Next.js app,
database migrations, hosting, test-mode web commerce, transactional email,
analytics, search, a domain plan, quality checks, a primary journey, a launch
report, and later Core upgrades.

Venture Harness is not a guarantee of demand, a no-code page generator, a
hosted owner of your cloud accounts, an automatic ad-spend system, or a
replacement for provider accounts and their legal/KYC requirements.

### The build host

The v0.2 alpha ships an authenticated Codex CLI build host. The build-host
interface is extensible, but other agent hosts are not yet claimed as production
launch implementations.

## Five-minute conceptual quickstart

Five minutes is enough to understand and inspect the flow. Provider onboarding,
DNS propagation, product generation, and a real production build can take
longer.

The v0.2 package is not published as a stable release. With Node 22.5 or newer
(the durable runtime uses `node:sqlite`), from a reviewed source checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Choose where your ventures live. They are independent products, so they are
never materialized inside the Venture Harness checkout:

```bash
vh config set ventures-root ~/Projects/ventures
```

Then connect the default Stack once. The wizard reads back the GitHub and Vercel
CLI sessions you already have, collects the remaining provider credentials at a
hidden prompt, stores them in your Keychain or 1Password, and keeps only
`cred://` references in Venture Harness:

```bash
vh stack connect founder-default
```

It prints exactly what is still unresolved and the one command that fixes each
item. Only GitHub, Vercel, Neon and Stripe block a launch; Brevo, Google, Bing
and DNS can follow later without holding up your first live app.

Write `idea.md` with the initial user, problem, outcome, primary journey,
success signal, rail, required capabilities, and—when using Stripe—one exact
monthly or annual displayed price. A domain is optional.

<details>
<summary>Explicit commands for automation and advanced users</summary>

The wizard is the recommended path. These lower-level commands remain available
and are what the wizard orchestrates:

```bash
vh auth login github --ref cred://github/founder-default --scopes repo,workflow
vh auth login vercel --ref cred://vercel/founder-default
vh auth login neon --ref cred://neon/founder-default --backend macos_keychain --kind api_key
vh auth login stripe --ref cred://stripe/founder-default --backend macos_keychain --kind restricted_api_key
vh auth login revenuecat --ref cred://revenuecat/founder-default --backend macos_keychain --kind restricted_api_key --scopes project_configuration:apps:read_write,project_configuration:entitlements:read_write,project_configuration:offerings:read_write,project_configuration:integrations:read_write
vh auth login brevo --ref cred://brevo/founder-default --backend macos_keychain --kind api_key
vh auth login google --ref cred://google/founder-default --backend macos_keychain --kind oauth --scopes https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/siteverification,https://www.googleapis.com/auth/webmasters
vh auth login bing --ref cred://bing/founder-default --backend macos_keychain --kind api_key
vh stack create founder-default --file .venture/input/founder-default.json
vh stack doctor founder-default
```

</details>

GitHub and Vercel prefer official CLI sessions. Key-backed commands register
credential references; store values through the selected Keychain or 1Password
interface, never in Git, argv, the Stack file, a report, or model context.
`vh auth test <provider>` and Stack doctor use bounded read-only official
CLI/API probes; that establishes credential/account readiness, not the existence
of a planned launch resource. The
[complete quickstart](docs/public/FOUNDER_QUICKSTART.md) has exact scopes, a
credential-free [Stack example](docs/public/founder-default.example.json),
non-macOS guidance, and doctor interpretation.

Run the no-effect production dry run:

```bash
vh doctor
vh auth status
vh stack doctor founder-default
vh launch --idea ./idea.md --stack founder-default --production --dry-run --non-interactive
```

It reports the selected mode/rail/seed, exact provider accounts, proposed
repository and resources, environment-variable names, migrations, domain
records, analytics/search/email/commerce setup, estimated effects, genuine
blockers, and the exact apply command. A complete dry run is not evidence that
a provider was contacted.

After reviewing those destinations and effects, issue one explicit launch:

```bash
vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive
```

The command creates an immutable Launch Grant and uses the same child CLI,
durable graph, provider adapters, migrations, seed runtime, and upgrade model as
the synthetic proof. Do not add `--authorization`; the one-prompt path derives
its exact authorization from the Launch Grant. A provider or domain boundary
can return a waiting run with one exact `vh resume <run-id>` action. Waiting and
provider request acceptance are not launch success.

Before product work, provider changes, source push, or deployment, Core installs
the independent child's exact `pnpm-lock.yaml` with a frozen, parent-workspace-
isolated command, lifecycle scripts disabled, and development tooling included.
It reads back `node_modules`, TypeScript, and Playwright and can safely retry a
confirmed-missing install on the same durable run.

The founder Grant bounds an exact number of reviewed provider operations and
their direct operation estimates. A zero estimate applies only to the named
actions; it excludes recurring provider account-plan usage. Production build
work also requires `codex login status` to attest ChatGPT-subscription use and
is bounded by build-agent task count. It does not claim a token or total-money
hard cap, and API-key or unknown model billing fails before child creation or a
provider call.

If unfinished provider work outlives the original 24-hour Grant or run
envelope, `vh resume` fails closed and prints the exact
`--authorization <same-profile>` renewal command. Renewal revalidates and
retains the original repository, provider-account, capability, effect, and
budget scope; it does not expand the Launch Grant.

Inside this source checkout, replace `vh` with `pnpm vh --` and leave the
remaining arguments unchanged.

## Founder-default Stack

The founder selects account/team/organization IDs once. The saved connection is
credential-free metadata plus `cred://...` references.

| Role                 | v0.2 default                                                          | Apply boundary                                                                             |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Source control       | GitHub                                                                | Repository create, local commit/push, and remote read-back                                 |
| Hosting              | Vercel                                                                | Project, encrypted env metadata, production deployment, domain, `READY` read-back          |
| Database             | Neon Postgres                                                         | Project, captured connection reference, versioned migrations, health read-back             |
| Web commerce         | Stripe test mode                                                      | One exact price, webhook, portal, and resource read-back; no customer charge implied       |
| Native subscriptions | RevenueCat                                                            | Selected only for native digital goods; project/key bootstrap can be manual                |
| Email                | Brevo                                                                 | Sender/template/webhook configuration; delivery and DNS authentication verified separately |
| Analytics            | Google Analytics                                                      | Property/stream configuration and measurement ID capture; traffic is not inferred          |
| Search               | Google Search Console and Bing Webmaster                              | Site/sitemap submission; acceptance is not indexation                                      |
| DNS                  | Installed supported adapter, otherwise one consolidated manual action | Preserve existing mail/security records and read authoritative DNS back                    |

Capability interfaces remain provider-neutral, but v0.2 does not pretend that
multiple production alternatives are complete.

The automatic preparation reports `setup.analytics = google_analytics`.
Vercel Web Analytics is an optional, separately reviewed/manual integration;
it is deliberately outside the founder-default apply-once plan.

## Turn an idea into an app

Paste this into your agent, fill in the idea, and let it run.

```text
/goal

Use Venture Harness to sharpen and launch the following idea as an independent,
production-ready application.

IDEA

[Describe the rough idea in plain language.]

OPTIONAL CONTEXT

- Initial user:
- Problem:
- Desired outcome:
- Market/language:
- Web, iOS, hybrid or let Venture Harness decide:
- Preferred domain:
- Business-model thoughts:
- Constraints:
- Things the product must not become:

Use my authenticated `founder-default` Stack.

First sharpen the idea:

1. identify the narrowest credible initial user;
2. define the urgent problem and useful outcome;
3. challenge weak assumptions;
4. choose the smallest useful product scope;
5. choose the launch mode;
6. choose the business and payment model;
7. choose Stripe, RevenueCat or no payments;
8. define the primary user journey and success signal;
9. record non-critical uncertainty as assumptions.

Then execute the real Venture Harness path:

1. produce the final credential-free `idea.md`;
2. run the production dry run;
3. inspect blockers and exact provider destinations;
4. invoke the one-prompt apply command;
5. create the independent repository;
6. build a unique, accessible product and design;
7. configure the database, commerce, email, analytics and search;
8. push the source;
9. deploy production;
10. verify the primary journey;
11. read provider state back;
12. generate the final launch report.

Only add a ServiceBlueprint, customer Connection Hub and venture-specific
API/CLI/MCP/SDK when this business sells an orchestrated customer service.

Do not create advertising spend.

Do not stop at a plan, local build or preview.

Use sensible reversible defaults, complete every independent step and report
only genuine external actions.
```

### Shorter daily prompt

```text
/goal

Launch this idea with Venture Harness on my `founder-default` Stack:

[one or two sentences]

Sharpen it into the narrowest credible initial user, one urgent problem, one
success signal and the smallest useful scope. Record open questions as
assumptions rather than blocking on them. Then run the production dry run, show
me the blockers and provider destinations, and run the exact apply command.
Verify the primary journey and read every provider back before reporting
anything as done. No advertising spend.
```

## What the one-prompt rail does

```text
idea.md
  -> typed brief + launch mode/rail/commerce selection
  -> founder-default resolution + immutable Launch Grant
  -> staged independent venture from a versioned seed
  -> founder-specific product/design work with direct evidence checks
  -> GitHub + Vercel + Neon + Stripe/RevenueCat + Brevo + Google/Bing + DNS
  -> source push + production deployment + smoke/primary-journey checks
  -> provider read-backs + honest final report
  -> bounded learning schedule when requested
```

The default web venture is a standalone Next.js application, not an app nested
inside this Core repository and not a runtime dependency on the Core source
tree. It receives its own package identity, migrations, provider config,
deployment, design/product files, `venture.manifest.json`, and `harness.lock`.

The generated product is not accepted merely because files exist. Product
nodes require hash-verified changes, required artifact roles, and a relevant
direct check. The fixture proof exercises desktop/mobile composition, raw HTML,
accessibility, consent/PII boundaries, the primary journey, production build,
and upgrade preservation; it is not proof that every idea will need no founder
review.

See [Architecture](ARCHITECTURE.md) for the full trust and execution map.

## Evidence and release status

**Venture Harness has not yet completed a real founder launch from this
repository.** No founder-launch GitHub repository, Vercel deployment, Neon
database, Stripe resource, Brevo message, search property, DNS change, customer,
sale or market result is claimed. Every real provider effect stays
**external verification required** until an authorized read-back exists.

What is verified today, and how:

- `pnpm verify:release` — the founder-alpha code and fixture gate. It contains
  no live provider read-back and is expected to pass with nothing connected.
- `pnpm verify:live` — real provider read-back only. It honestly reports
  `INCOMPLETE` before a real launch, naming the missing prerequisite, the exact
  command and the expected evidence for each gap.
- `pnpm verify:stable` — both of the above. It stays incomplete until a real
  launch has been read back.

| Surface                                                                   | Status                                            | What remains                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Idea compiler, launch routing, Launch Grant, Stack persistence/doctor     | Verified locally                                  | First real founder account set                                                      |
| Independent ordinary web seed, migrations, production build, HTTP journey | Fixture verified                                  | First real generated product review and deploy                                      |
| Definitive founder Golden Path                                            | Fixture verified through the public root CLI      | Live provider accounts and a public production URL                                  |
| GitHub/Vercel/Neon/Stripe/Brevo/Google/Bing provider plans and read-backs | Fixture verified through labeled transports/mocks | Authorized provider-by-provider read-back                                           |
| DNS                                                                       | Fixture/manual-plan verified                      | Registrar action and authoritative propagation evidence                             |
| Core upgrade and venture-owned-file survival                              | Fixture verified                                  | Upgrade of the first real child repository                                          |
| iOS/TestFlight rail                                                       | Experimental                                      | Signed build/upload/account evidence; public App Store approval is out of scope     |
| Delegated-service runtime                                                 | Optional, locally verified                        | Real customer/connection/offboarding evidence                                       |
| Winner Loop and DistributionPR                                            | Optional, fixture verified                        | External posting, attribution, and any separately approved spend                    |
| Fleet controller                                                          | Experimental, fixture verified                    | Real branch/PR/preview/merge/deploy canary                                          |
| Public stable release                                                     | Planned                                           | Real dogfood launch, release gates, GitHub settings read-back, explicit publication |

“Verified locally” and “fixture verified” map to `PROTOTYPE` in
[Product Truth](docs/product/PRODUCT_TRUTH.md). Only sanitized production
read-back can establish a `LIVE` claim. See [Feature Status](docs/product/FEATURE_STATUS.md)
for the detailed matrix.

## Synthetic Golden Path

The labeled Exception Desk fixture supplies a realistic web SaaS idea, one
test-mode price, a private repository destination, a manual DNS plan, and one
primary journey. It crosses the real implementation boundaries without using a
customer account or causing an external effect.

```bash
pnpm exec vitest run --no-file-parallelism \
  tests/founder-golden-path-product.test.ts \
  tests/founder-golden-path-runtime.test.ts \
  tests/founder-golden-path.test.ts --reporter=verbose
```

A prior 2026-08-09 source state passed all three tests. On the current final
tree, the product and runtime slices pass; the root slice reached the
standalone child server check and was blocked when this local sandbox denied
loopback listening with `EPERM`. A full current-tree refresh remains pending in
socket-capable CI; that pending check is not a pass. The prior run exercised the
public root dispatcher and exact founder command semantics, then kept every
provider below the real transport boundary on labeled fixtures. See the
[synthetic proof contract](docs/public/SYNTHETIC_GOLDEN_PATH.md),
[idea](fixtures/ideas/synthetic-founder-web.md), and
[fixture-only Stack](fixtures/founder-stack/founder-default.json).

## Ownership, upgrades, and exit

The founder owns the child repository and connected company accounts. Created
resources stay with the recorded owner; Venture Harness receives bounded
delegated authority for the run. Credential values stay behind local references
and are not copied into the child repository.

Every managed file has one upgrade class:

| Class           | Upgrade behavior                                                      |
| --------------- | --------------------------------------------------------------------- |
| `core_owned`    | Update only from the trusted unchanged baseline; local edits conflict |
| `merge_managed` | Three-way merge against the trusted prior version; overlaps conflict  |
| `venture_owned` | Preserve product, design, copy, policy, and other venture-owned work  |

```bash
vh upgrade --release /path/to/reviewed-venture-harness-release --dry-run
vh upgrade --release /path/to/reviewed-venture-harness-release
pnpm verify
```

The release checkout and hashes are verified, migrations and fixed checks run,
and the lock changes last. A failed check restores staged files. No command
fetches and executes an unreviewed remote manifest. See
[child upgrades](docs/operations/CHILD_VENTURE_UPGRADES.md) and
[offboarding](docs/operations/OFFBOARDING.md).

## Troubleshooting

- Run `vh stack doctor founder-default` for missing auth, scopes, account IDs,
  launch defaults, transport readiness, and writable capture targets.
- Run the production dry run before apply; it is the authoritative account,
  resource, migration, domain, setup, and blocker preview.
- Inspect `vh status <run-id>` and
  `reports/launch/<run-id>/final.{json,md}` inside the child. Resume the same run;
  do not edit its state or blindly repeat an ambiguous write.
- If the exact intended child exists with a matching
  `.venture/founder-launch.json` transaction journal but no run, rerun the same
  one-prompt command; it resumes child launch instead of rematerializing.
- An existing child without a matching journal, or an interrupted staging
  directory, fails closed. Inspect it and choose a new `--output`; do not
  overwrite or guess that provider work began.
- A custom-domain blocker may coexist with a working stable Vercel production
  URL. The report must distinguish them.
- A fixture Stack is intentionally rejected for production.

See the [quickstart troubleshooting table](docs/public/FOUNDER_QUICKSTART.md#troubleshooting)
and [operator guide](docs/operations/TROUBLESHOOTING.md).

## Optional advanced work

Core retains tested capabilities without putting them on the ordinary web path:

- Service Blueprints, recursive customer organizations, Connection Hub,
  provider connections, Service/Agent Grants, API/CLI/MCP/SDK Agent Surfaces,
  metering, audit, revocation, and offboarding for delegated-service ventures;
- `validate-first`, DistributionPR, Winner Loop, iOS subscription, and advanced
  Fleet packs/operations;
- bounded daily, weekly, biweekly, and monthly evidence loops.

Winner Loop never auto-scales or raises a cap. Advertising needs a separate
human-approved Spend Grant and is never authorized by a founder Launch Grant.

## Project navigation

- [Founder quickstart](docs/public/FOUNDER_QUICKSTART.md)
- [Synthetic Golden Path](docs/public/SYNTHETIC_GOLDEN_PATH.md)
- [Architecture](ARCHITECTURE.md)
- [Provider operations](docs/operations/README.md)
- [Feature status](docs/product/FEATURE_STATUS.md)
- [Product Truth](docs/product/PRODUCT_TRUTH.md)
- [Roadmap](docs/product/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md) and [threat model](docs/security/THREAT_MODEL.md)
- [Open-source readiness](docs/public/OPEN_SOURCE_READINESS.md)

## License

MIT. See [LICENSE](LICENSE).
