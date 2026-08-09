# ARCHITECTURE

Venture Harness separates founder authority, deterministic orchestration,
venture-specific product code, and provider effects. The primary v0.2 product
is a local founder-operated launch factory, not a hosted SaaS control plane.
Every materialized venture is an independent repository with its own identity,
policy, provider destinations, migrations, product/design files, and upgrade
lock.

## Evidence status

| Label                     | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| Locally verified          | Executed against repository code, tests, or a packed local consumer.  |
| Fixture verified          | Crossed the production-shaped boundary with synthetic data/providers. |
| Live verification pending | No authorized provider read-back exists in this template.             |

All three labels remain `PROTOTYPE` under
[Product Truth](docs/product/PRODUCT_TRUTH.md). Neither local nor fixture proof
is production proof.

## Primary founder system map

```text
one-time founder-default connection
  GitHub · Vercel · Neon · Stripe/RevenueCat · Brevo · Google/Bing · DNS
                         │ credential references + exact account metadata
                         ▼
idea.md ──> bounded idea compiler ──> typed brief + mode/rail/commerce
                         │
                         ├── read-only Stack doctor
                         ├── complete production dry run
                         └── immutable Launch Grant
                                      │
                                      ▼
                         isolated staging directory
                                      │
                  ordinary web / iOS / hybrid versioned seed
                                      │
                       create + product/design evidence nodes
                                      │ atomic rename
                                      ▼
                         independent child repository
                    manifest · migrations · v2 harness.lock
                                      │
                         child CLI + durable launch graph
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
    local/model work         provider capability           human interrupt
    product + checks       plan/apply/read-back/reconcile   exact evidence
          └───────────────────────────┼───────────────────────────┘
                                      ▼
                 source push · production URL · primary journey
                                      │
                                      ▼
                       sanitized JSON/Markdown launch report
                                      │
                         bounded learning + later vh upgrade
```

The canonical command is:

```bash
vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive
```

The root CLI compiles and issues one Launch Grant, stages the child locally,
then calls the same child launch service used by explicit `vh create`/`vh
launch` flows. Natural-language agents must invoke these semantics; there is no
separate prompt-only implementation.

## Founder Stack and authority

`founder-default` is one credential-free connection record. Each fixed role
contains a `cred://...` reference, exact account/team/organization metadata,
declared scopes/expiry, and launch defaults. Writable Keychain or 1Password
targets are pre-registered before Neon connection strings, Stripe webhook
secrets, or Google measurement IDs can be captured. The profile never contains
a credential value.

`vh stack doctor founder-default` is read-only. It checks local backends,
official CLI/API credential readiness, metadata/scope/expiry alignment,
transport availability, required launch defaults, and writable output targets;
it does not establish that a launch resource exists. Production apply rejects
fixture-only credential storage.

The Launch Grant binds the compiled idea digest, venture/repository identity,
seed, Stack version, exact provider-account destinations, allowed effect
classes, budgets, production/domain/commerce permissions, expiry, founder
actor, and approval reference. The child graph cannot introduce a provider or
effect omitted from the grant. Advertising is never a Launch Grant effect.

## Independent child boundary

Materialization first targets a new sibling staging directory. The founder
brief, compiled-input metadata, Launch Grant, provider targets and exact offer
price are written there before the directory is atomically renamed into its
final child location. If that exact child later has a matching
`.venture/founder-launch.json` transaction journal but no run, repeating the
same one-prompt command resumes child launch without rematerializing. An
unjournaled or mismatched existing child, or an interrupted staging directory,
fails closed for inspection or a new output; no launch provider node starts for
that invocation.

The ordinary `agentic-web-saas` seed is a standalone Next.js application. It
does not import the Venture Harness source repository at runtime. The child owns
its repository, provider config, SQL migrations, product/design/copy files,
deployment, report, and `harness.lock`. Core supplies the versioned seed,
managed bootstrap, contracts, execution rail, and later upgrade rules.

## Workspace and applications

The v0.2 pnpm workspace contains 30 package boundaries under
`packages/` and five application composition boundaries under `apps/`. Package
dependencies use `workspace:*`; the workspace check rejects undeclared internal
imports, package-to-app reverse dependencies, missing ESM/CommonJS/type exports,
cycles, and non-`dist` package allowlists.

| Group                       | Packages                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain and trust primitives | `core`, `config`, `events`, `audit`, `assets`, `credentials`, `policy`, `organizations`, `billing`, `entitlements`, `connections`, `telemetry`, `evaluations`, `loops`, `migrations` |
| Execution and evolution     | `command-bus`, `provider-sdk`, `provider-registry`, `workflow-backend-local`, `orchestrator`, `pack-runtime`, `seed-runtime`, `upgrades`                                             |
| Agent Surfaces              | `agent-runtime`, `agent-gateway`, `api-generator`, `cli-generator`, `mcp-generator`, `sdk-generator`, `ui`                                                                           |

The five consumers are `control-plane`, `api`, `worker`, `docs`, and
`fleet-controller`. They compose packages; packages never depend on apps.
`pnpm workspace:build` builds dependency-first into staged directories and then
atomically replaces `dist/`. `pnpm workspace:pack` builds and packs the root CLI
plus all 30 packages. Status: **locally verified**; publication is not claimed.

## Command bus and Agent Surfaces

A command contract in `@venture-harness/command-bus` is the executable source
for its ID, version, input/output schemas, authorization requirements, meter,
and derived surface names. The same registered handler is reached through the
direct runtime, REST, CLI, MCP, SDK, and UI adapters. Generators do not own a
second authorization or business-logic path.

Before a handler runs, the bus checks identity, organization/venture tenant,
active subscription, entitlements, an unexpired command grant, and actor
scopes. It then parses input, binds the tenant-scoped idempotency key to a
canonical SHA-256 request hash, parses output, and records sanitized audit,
event, and metering evidence. Reusing a key with different input fails as an
idempotency conflict. Status: **locally verified** for the built-in
`campaigns.launch` and `launch.execute` contracts and all six invocation paths.
The same surfaces also expose `stack.doctor`, `stack.plan`, `stack.dry-run`,
`stack.apply`, `stack.read-back`, and `stack.reconcile`; selection carries the
exact profile ID/version, role, provider, capability, and environment.

See [Agent Surfaces](docs/engineering/AGENT_SURFACES.md) for the authoring rule.

## Durable workflow execution

Workflow definitions under `lib/workflow/` are JSON-safe data. Handlers,
validators, conditions, reconcilers, compensators, workspace factories, and
evidence verifiers are injected as bindings, so serialized plans never contain
code or credential values.

`FileWorkflowStore` keeps an atomic state snapshot and an ordered, fsynced JSONL
event stream. A write-ahead pending event recovers a crash between state and
event persistence. The executor supports bounded parallelism, concurrency
groups, retries/backoff, timeouts, per-category budgets, detailed cost records,
bounded node loops, isolated workspaces, queues, cancellation, steering,
superseding runs, and compensation. It persists distinct waits for
authorization, external completion, approval, and manual action.

Effectful attempts are prepared before invocation. A crash or ambiguous result
must reconcile through an injected read-back handler; the runtime never treats
an unknown outcome as permission to repeat the write. Verified effects can be
reused only under the same graph fingerprint and idempotency contract. Manual
or dangerous effects need typed evidence, an explicit approver, and, where
required, a fresh one-shot checkpoint grant. Status: **locally verified**.

The smaller `@venture-harness/workflow-backend-local` package is a tenant-scoped
checkpoint backend for workspace consumers. It is not a replacement for the
full durable executor.

## Venture materialization

A `LaunchGrant` is immutable and content-bound. It names one owner organization,
venture, versioned seed, Stack Profile, repository destination, company-owned
provider accounts, model/resource ceilings, exact allowed launch effects,
expiry, and approval reference. A Launch Grant can authorize repository,
company-stack, deployment, domain, commerce-configuration, and scheduling
effects; it cannot authorize advertising spend. Advertising requires the
separate Winner Loop `SpendGrant`.

Three versioned seeds are present:

- `agentic-web-saas@0.2.0`
- `agentic-ios-subscription@0.2.0`
- `hybrid-agentic-service@0.2.0`

The materializer writes only into an empty, non-symlink workspace with safe
relative paths and exclusive creates. It removes only files created by a failed
materialization. Every result includes `venture.manifest.json`, a v2
`harness.lock`, and no credential value or provider account ID. The ordinary
web seed declares `serviceRuntime: none`; recursive service files and generated
Agent Surfaces belong only to a seed/pack that explicitly selects them.

Before provider apply, the complete plan is deduplicated by canonical request
and checked against aggregate resource, exact-currency provider-cost,
model-token, and model-cost ceilings. Missing cost, currency mismatch, unsafe
minor-unit conversion, or unknown model usage stops before invocation. Provider
effects require fixture or real read-back evidence before they count as
complete. Status: **fixture verified** for synthetic launch effects; **live
verification pending** for every provider effect.

## File ownership

Every v2 managed-file entry has exactly one ownership class:

| Class           | Upgrade behavior                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `core_owned`    | Replace only when the file still matches its trusted prior hash; otherwise stop with a conflict.                           |
| `merge_managed` | Three-way merge non-overlapping Core and venture changes against the trusted base; overlapping edits stop with a conflict. |
| `venture_owned` | Create at initial materialization when declared, then preserve on every Core upgrade.                                      |

The legacy v1 `harness` / `generated` / `project` labels remain readable only
for migration compatibility. A v2 lock rejects them. Product identity, design,
copy, service blueprints, and other venture-owned files are never silently
replaced by a Core release.

## Provider portability

Core routes capabilities, not vendor names. `@venture-harness/provider-sdk`
defines `discover → estimate → plan → apply → readBack`, plus reconcile and
compensate. A capability descriptor declares schema version, environments,
required scopes, timeout, rate/concurrency class, redaction paths, and its
unknown-outcome policy. `@venture-harness/provider-registry` resolves a
capability through ordered candidates in a versioned Stack Profile and fails if
none implements it.

The compatibility integration under `lib/providers/` supplies the concrete v0.2
GitHub, Vercel, Neon, Stripe, RevenueCat, Brevo, Google, Bing, DNS/MijnDomein,
App Store Connect, and EAS plans used by the current CLI. Those adapters expose
doctor, plan, apply, read-back, and verification; they bind client-ledger keys
to the full canonical operation, reconcile ambiguous attempts without blindly
repeating writes, and require read-back before `verified`. Manual-only provider
steps stay explicit. Status: **locally verified with mocks/fixtures**; **live
verification pending** for every registered provider in this template.

The package capability catalog also contains two locally tested DNS-selection
profiles: `founder-default@0.2.0` selects MijnDomein and
`founder-default-generic-dns@0.2.0` selects the generic DNS adapter. That catalog
contract is distinct from the founder's persisted one-time connection record;
the one-prompt record renders its explicit `manual_generic` or
`mijndomein_manual` choice into the child provider config. Neither name proves a
registrar credential or live DNS write.

A host-injected runtime exercises package profiles through the six canonical
Stack commands with exact attestation. Authorized apply requires durable atomic
operation and provider-idempotency stores. SQLite prepares a request-bound claim
before adapter invocation; restart releases only durable confirmed-no-write,
completes confirmed writes only after matched read-back, and leaves unknown
state ambiguous. Manual actions require trusted declared evidence. The packaged
default remains unconfigured and performs no provider effect.

See [Provider authoring](docs/engineering/PROVIDER_AUTHORING.md).

## Recursive tenancy and service execution

The recursive runtime under `lib/venture-runtime/` models this ownership chain:

```text
platform operator
└── independent venture
    └── customer organization
        ├── user membership
        └── explicitly granted agent
```

Every service execution carries operator, venture, customer organization,
subscription, entitlement, Service Grant, provider connection, authorization
envelope, run/node, correlation, and causation identities. SQLite queries key
customer data by both venture and customer organization. Credentials are held
behind tenant-scoped `cred://` references, passed only during the provider call,
and revoked with the connection or customer. Cross-tenant connection, resource,
webhook, agent-token, and credential access fails closed.

Provider connections have three stack classes: `company`, `customer`, and
`agent_access`. Resource ownership is recorded separately, including
customer-owned, dedicated-account, managed-subaccount, demo, and transfer
states. Usage is reserved atomically before an effect. A definitive no-effect
failure releases it; an unknown outcome retains the reservation for
reconciliation. Audit records form a per-tenant hash chain. Offboarding revokes
access while preserving customer-owned resource records. Status: **locally
verified** with SQLite fixtures; **live verification pending**.

## Service Blueprints and packs

A versioned Service Blueprint defines one outcome, canonical command, required
capabilities, usage/billing units, completion criteria, workflow graph, and
policy. A customer receives an expiring Service Grant bound to an exact
blueprint version and an allowlist of provider connections. The runtime refuses
commands or capabilities outside that grant.

Packs install coherent capability sets: commands, events, migrations, provider
requirements, evaluations, loops, UI contributions, and Service Blueprint IDs.
Installation is idempotent at an exact version. Version changes require an
explicit pack upgrade, and uninstall requires a dependency-aware migration;
Winner Loop evidence must be preserved. Status: **locally verified**.

See [Service Blueprints](docs/engineering/SERVICE_BLUEPRINTS.md),
[pack authoring](docs/engineering/PACK_AUTHORING.md), and
[seed authoring](docs/engineering/SEED_AUTHORING.md).

## Fleet evolution

A Core release manifest binds its version tag, exact workflow SHA, changed
packages, affected capabilities, migrations, compatible seeds, required checks,
risk, rollback mode, and managed files to one digest. Fleet selection filters
unaffected ventures, upgrades a canary first, then bounded batches. Each venture
runs a branch, managed-file upgrade, migrations, venture checks, preview,
policy-gated merge, optional production deploy, and smoke read-back. The lock is
marked verified only after those checks.

Any non-verified canary or batch result pauses every later batch. Pre-production
failure restores the snapshot; a production failure uses the declared rollback
or records that a forward fix is required. Fleet run state has memory and SQLite
stores and binds a run ID to one release digest and venture selection. The
SQLite store creates runs atomically and uses expiring owner leases. Each
external phase persists a request-bound `prepared` checkpoint before its hook;
restart retries only confirmed `not_applied`, leaves unknown outcomes paused,
and does not repeat completed effects. Prior verified ventures survive a later
batch crash, and high-risk releases always stop for human merge approval.
Status: **fixture verified**; opening branches, merging, and deploying real
ventures remain **live verification pending**.

See [Fleet upgrades](docs/operations/FLEET_UPGRADES.md).

## Winner Loop

Winner Loop is an optional, evidence-preserving pack. It tracks immutable
creative identity and lineage separately from delivery variants and provider
object IDs; versions content fingerprints for deduplication; stores rights,
licenses, consent, disclosures, claims, and revocation history; ingests scheduled
organic metrics without converting missing data to zero; evaluates performance
against account/format baselines; and emits bounded recommendations.

Paid promotion is two-stage. A material-terms proposal receives a human
decision, then an immutable `SpendGrant` authorizes only its named customer,
venture, account, campaign, creative, currency, window, and caps. SQLite
reservation transactions enforce creative, paid-test, campaign, account,
venture, customer-day/month, and emergency platform ceilings. Unknown outcomes
hold reservations; reconciliation can release only confirmed no-write. Runtime
can auto-pause at declared stop conditions but never auto-scale or raise a cap.

Attribution carries an explicit evidence class and confidence. RevenueCat
fixture ingestion verifies raw webhook bytes before parsing, including signature
freshness, JSON content type/body size, secret-rotation windows, optional route
authorization, and venture/project/environment/app binding. It durably
deduplicates events, rejects conflicting replays, serializes alias and currency
invariants across SQLite clients, preserves transaction/expiration/grace
metadata, links only HMAC-pseudonymized subscriber aliases, and calculates
cohorts including transaction-linked refunds and retention windows.
Cancellation and billing issues do not revoke entitlement before expiration.
The event pack is disabled by default, first-party-only, and rejects PII,
credential material, and raw creative content.

The integration layer separates provider-incapable fixture adapters from
transport-injected live-mode contracts for creative rendering, TikTok organic,
TikTok paid/Spark, attribution, and RevenueCat. The live-mode contracts are
production-targeting boundaries, not configured integrations: local contract
tests do not prove an account, network call, publication, spend, or provider
read-back. Their contract behavior is **locally verified**; every actual
provider effect remains **live verification pending**.

Fixture D crosses the command bus, grant checks, durable workflow, real isolated
venture materialization, pack installation, tenant asset vault, SQLite creative
and evidence stores, audit chain, event pack, and six package-SDK/registry
fixture-provider lifecycles. Provider identifiers and reported fixture values
used by the domain run come from verified SDK read-back. It emits only a
fixture DistributionPR proposal and cannot publish, spend, or mutate the source
repository. Status: **fixture verified**; organic publication, advertising,
live attribution, and live subscription read-back remain **live verification
pending**.

See [Winner Loop](docs/engineering/WINNER_LOOP.md).

## Decisions and operations

Architecture decisions live in [docs/decisions/](docs/decisions/index.md).
Authoring guides live in [docs/engineering/](docs/README.md#engineering-and-authoring).
Operator guides live in [docs/operations/](docs/operations/README.md). The active
completion plan is [Plan 003](docs/plans/active/003-vh-v02-codex-completion.md).
