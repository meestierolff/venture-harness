# Venture Harness

**AI can build your app locally. Venture Harness gets it into the real world.**

> From rough idea to the smallest credible live and measurable business in your
> own stack.

Venture Harness is an open-source, founder-operated launch framework for
technical founders and indie hackers. It sharpens a rough idea into a reviewed
contract, builds the smallest useful product in an independent repository, and
coordinates explicitly authorized work in accounts **you** own. It records
provider read-backs and unresolved actions instead of turning a request into a
success claim.

This is a founder alpha, not a stable release. The implementation is locally and
fixture verified; this repository has not yet completed or verified a real
founder launch. See [the current evidence](#evidence-and-release-status).

## What it is

```text
rough idea
→ vh idea sharpen
→ review the Launch Contract
→ vh stack connect founder-default
→ production dry run
→ explicit apply command
→ verified provider state or one exact waiting action
→ local Launch Receipt
```

- **Open source and founder-operated.** You run it on your machine, against your
  own provider accounts.
- **Independent repositories.** Each venture is its own product with its own Git
  history, materialized outside the Venture Harness checkout.
- **One boring default Stack.** GitHub, Vercel, Neon Postgres and Stripe test
  mode are the default web roles. Brevo, Google Analytics/Search Console, Bing
  Webmaster and DNS are supported optional roles. The stable Vercel production
  URL is a valid starting origin when no custom domain is ready.
- **A reviewable founder contract.** `vh idea sharpen` records one user, painful
  job, outcome, core feature, commitment surface, initial channel, success
  signal, review date, stop rules and explicit no-gos in a typed Launch Contract.
- **One-time connection, bounded launch.** `vh stack connect founder-default`
  saves credential-free Stack metadata; a dry run precedes the explicit apply
  command for each venture.
- **A local receipt, not a victory label.** The Launch Receipt records observed
  build usage, verification states, limitations and next actions. A waiting
  provider remains waiting.
- **Honest alpha.** A provider effect is only ever reported as done when the
  provider has been read back. See
  [current verification status](#evidence-and-release-status).
- **Optional packs stay optional.** Delegated services, Agent Surfaces, Winner
  Loop, iOS and Fleet work do not enter the ordinary web rail unless selected.
- **Founder ownership, no phone home.** The child repository and provider
  resources remain yours. The sanitized Launch Receipt stays local; Venture
  Harness does not upload it or phone it home. Authorized launch commands can
  still contact only the reviewed provider destinations.

### Who it is for

- founders and indie hackers who can create software but need a dependable path
  into production;
- builders who want their agent to operate through typed commands and bounded
  authority;
- developers who want each venture in its own repository and provider stack,
  with upgrades that preserve product-owned work.

The founder rail can coordinate repository creation, a focused Next.js app,
database migrations, hosting, selected provider roles, quality checks, a
primary journey, a Launch Receipt, and later Core upgrades. The Launch Contract
keeps capabilities that the venture does not need out of scope.

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

Write the rough idea in plain language, then sharpen it:

```bash
vh idea sharpen --input ./rough-idea.md --output ./idea.md --json
```

The command writes a credential-free `idea.md`,
`idea.launch-contract.yaml`, `idea.product-constitution.md`, and a sanitized
`idea.usage.json`; it does not create a repository, deployment, or launch-provider
effect. Structured input takes a deterministic zero-model-call path. Rough prose
may use the authenticated Codex CLI host for one bounded pass and, only if the
first result misses the schema, one repair pass.

Review the Launch Contract before continuing. It is the scope and decision
surface: one user, painful job, useful outcome, core feature, commitment event,
first distribution channel, primary success signal, review date, explicit
not-building list, and `continue`, `change`, or `stop` rules. It is not evidence
of demand. The [founder principles](docs/product/FOUNDER_PRINCIPLES.md) explain
why those constraints exist.

Then connect the default Stack once. The command inspects supported official CLI
sessions, saves credential-free account metadata and registered `cred://`
references, and runs a no-effect readiness doctor:

```bash
vh stack connect founder-default
```

It prints what is unresolved, whether each item blocks launch, and the next
command for that item. Register non-CLI credential references through the
lower-level `vh auth login` commands below; credential values stay behind the
selected Keychain or 1Password backend. GitHub, Vercel, Neon and Stripe are the
current required web Stack roles. Brevo, Google, Bing and DNS are optional Stack
roles, and a domain is optional for the first Vercel production URL.

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

Every persisted launch run writes a sanitized Launch Receipt inside the child:

```text
reports/launch/<run-id>/receipt.json
reports/launch/<run-id>/receipt.md
```

It records the selected outcome and review date, build agent and observed token
usage, tool calls, retries, files changed, Stack and verification states,
limitations, and exact manual actions. Unknown accounting stays unknown, and a
fixture or waiting state is labeled as such. The receipt is written and read
back locally; Venture Harness has no receipt upload or phone-home step.

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

## Token-efficiency objective

Venture Harness aims to complete the same reviewed scope and acceptance criteria
with fewer model tokens, repeated context reads, agent tasks, tool calls,
retries, and manual provider steps. That is an optimization objective, not a
promise of savings and never a reason to weaken the product or quality gate.

The sharpener writes sanitized call and token counts to `idea.usage.json`. The
Launch Receipt records the available build counts and leaves unavailable values
unset. Compare like-for-like runs before removing work; do not infer savings
from a smaller scope or a fixture.

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

When the Launch Contract selects analytics, automatic preparation reports
`setup.analytics = google_analytics`. Without that capability it reports
`not_requested`. Vercel Web Analytics is an optional, separately
reviewed/manual integration; it is deliberately outside the founder-default
apply-once plan.

## Turn an idea into an app

Paste this into your agent, fill in the idea, and let it run.

```text
/goal

Use Venture Harness to sharpen and launch the following idea as an independent,
production-targeted application. Treat live state as unverified until every
required provider and public journey has been read back.

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
2. review the generated Launch Contract;
3. run the production dry run;
4. inspect blockers and exact provider destinations;
5. invoke the one-prompt apply command;
6. create the independent repository;
7. build a focused, accessible product and design;
8. configure only the provider roles selected by the contract;
9. push the source and request the production deployment;
10. verify the primary journey;
11. read provider state back;
12. generate the final launch report and local Launch Receipt.

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
  -> reviewed Launch Contract + launch mode/rail/commerce selection
  -> founder-default resolution + immutable Launch Grant
  -> staged independent venture from a versioned seed
  -> founder-specific product/design work with direct evidence checks
  -> selected GitHub/Vercel/Neon/commerce/email/search/DNS roles
  -> source push + production deployment + smoke/primary-journey checks
  -> provider read-backs + honest report + local Launch Receipt
  -> bounded learning schedule when requested
```

The default web venture is a standalone Next.js application, not an app nested
inside this Core repository and not a runtime dependency on the Core source
tree. It receives its own package identity, provider config, deployment,
design/product files, `venture.manifest.json`, and `harness.lock`, plus
migrations when the selected product needs persistence.

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

- `pnpm verify:mvp && pnpm verify:release` — the complete local founder-alpha
  code and fixture gate. Both staged profiles must pass; neither command alone
  establishes code readiness. The pair contains no live provider read-back and
  is expected to pass with nothing connected.
- `pnpm verify:live` — real provider read-back only. It honestly reports
  `INCOMPLETE` before a real launch, naming the missing prerequisite, the exact
  command and the expected evidence for each gap.
- `pnpm verify:stable` — both of the above. It stays incomplete until a real
  launch has been read back.

| Surface                                                                   | Status                                            | What remains                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Idea sharpener, Launch Contract, routing and Launch Receipt               | Verified locally                                  | First real founder-reviewed contract and receipt                                    |
| Launch Grant and Stack persistence/doctor                                 | Verified locally                                  | First real founder account set                                                      |
| Independent ordinary web seed, selected migrations, build, HTTP journey   | Fixture verified                                  | First real generated product review and deploy                                      |
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
test-mode price, a private repository destination, a requested custom domain,
optional email/discovery integrations, and one primary journey. It crosses the
real implementation boundaries without using a customer account or causing an
external effect.

```bash
pnpm exec vitest run --no-file-parallelism \
  tests/founder-golden-path-product.test.ts \
  tests/founder-golden-path-runtime.test.ts \
  tests/founder-golden-path.test.ts --reporter=verbose
```

One isolated three-slice run passed on 2026-08-12, and the current provider-URL
root slice passed locally on 2026-08-23. The initial one-prompt graph selects
GitHub, Neon, Stripe and Vercel, succeeds on a fixture-labeled stable Vercel URL,
and leaves custom DNS plus Brevo, Google and Bing as deferred nonblocking work.
Replaying the exact apply command reuses the run and Grant without another
provider or product invocation. A separate Golden Path variant and direct CLI
integration test own the real missing-provider-auth wait/resume boundary.
Final-source repetitions and hosted CI evidence remain pending and are not yet a
release pass. See the
[synthetic proof contract](docs/public/SYNTHETIC_GOLDEN_PATH.md),
[idea](fixtures/ideas/synthetic-founder-web.md), and
[fixture-only Stack](fixtures/founder-stack/founder-default.json).

## Ownership, upgrades, and exit

The founder owns the child repository and connected company accounts. Created
resources stay with the recorded owner; Venture Harness receives bounded
delegated authority for the run. Credential values stay behind local references
and are not copied into the child repository. Venture Harness has no hosted
control plane for the child and does not upload or phone home the sanitized
Launch Receipt. Explicitly authorized provider commands still make the reviewed
external requests needed for the launch.

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
  `reports/launch/<run-id>/{final,receipt}.{json,md}` inside the child. Resume the
  same run; do not edit its state or blindly repeat an ambiguous write.
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
- [Founder principles](docs/product/FOUNDER_PRINCIPLES.md)
- [Roadmap](docs/product/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md) and [threat model](docs/security/THREAT_MODEL.md)
- [Open-source readiness](docs/public/OPEN_SOURCE_READINESS.md)

## License

MIT. See [LICENSE](LICENSE).
