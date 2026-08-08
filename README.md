# Venture Harness v0.2

Venture Harness is an agent-neutral launch operating system for a solo founder.
Give it one structured brief; it selects a launch mode and product rail, compiles
a resumable launch graph, and prepares only the providers the venture needs.

> **Implementation status:** v0.2 is verified locally with synthetic web and iOS
> inputs plus desktop/mobile Chromium journeys. No production provider resource,
> DNS change, payment, email, deployment, TestFlight upload, or market result is
> claimed by this template. A provider is `verified` only after an authorized run
> reads it back and stores evidence.

Offline defaults are deliberate: `create`, `plan`, dry-run, run inspection,
synthetic fixtures and local migration/upgrade logic work without an account.
Provider apply uses built-in complete-or-fail plan factories plus official
CLI/API transports, but refuses incomplete resource chains; auth reports
metadata/readiness until a credential backend and remote tester are configured.
Data sync composes verified Neon aggregate evidence and a strict release log
when declared, and reports `not_configured` or `incomplete` otherwise. Those are
honest integration boundaries, not successful no-ops.

## First launch

Install Node 20+ and pnpm, then run the repository gate:

```bash
pnpm install
pnpm verify
```

Fill in [inputs/VENTURE_BRIEF.yaml](inputs/VENTURE_BRIEF.yaml). The first real
launch sequence is:

Examples below use the installed `vh` bin. Inside this source checkout, use
`pnpm vh -- <command-and-options>` instead (for example,
`pnpm vh -- plan`).

```bash
vh auth login
vh doctor
vh create --brief inputs/VENTURE_BRIEF.yaml
vh plan
vh launch --dry-run
vh launch --apply --authorization standard_launch
```

`create`, `plan`, and `--dry-run` do not authorize external writes. Read the dry
run before applying: it lists the launch decision, graph, resources, possible
cost, authorization needs, checks, and consolidated manual actions. See the
[first-launch guide](docs/operations/FIRST_LAUNCH.md).

`create` also synchronizes the selected brief into the canonical venture,
launch, and mobile contracts. Its output and every dry run name the smallest
capability-relevant analytics event-pack set; experiments remain explicit.

The bare `vh auth login` call is discovery: it lists registered/supported
providers and the next command. Run `vh auth login <provider>` for each provider
the reviewed plan needs, then rerun `vh doctor` before apply.

## Four launch modes

The router records a selected mode, confidence, rationale, rejected choices,
assumptions, and evidence that could change the decision.

| Mode              | Use it when                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `validate_first`  | The useful product is costly, risky, slow, or a market must be proven first. Optional 30/60/90-day gates fit here. |
| `thin_mvp`        | A narrow, reversible product journey is cheap enough to expose to real use quickly.                                |
| `product_first`   | Meaningful evidence requires a working product, installed app, or deep workflow.                                   |
| `concierge_first` | A human can honestly deliver the outcome while the repeatable product path is learned.                             |

Progressive commitment replaces universal paperwork. Building can start when
the brief names a user, problem, useful outcome, smallest journey, one success
signal, constraints, known truths, and explicit assumptions. It blocks only for
an unintelligible or deceptive outcome, a material choice that cannot be safely
defaulted, a missing indispensable credential, or an effect outside the active
authorization envelope.

## Product rails

- **Web:** Next.js public site, authenticated product, or both; Vercel is the
  default deployment plan and Neon is available when the capability needs data.
- **iOS:** `expo_react_native`, `swiftui`, or `auto`. Expo is favored for fast,
  cross-platform MVPs; SwiftUI for deep Apple or on-device requirements.
- **Hybrid:** web discovery/support plus a mobile client and shared contracts,
  with one explicit entitlement source.

Native digital purchases route to RevenueCat; ordinary web billing routes to
Stripe. Both are selected together only when a reviewed hybrid entitlement
design requires it. The [iOS/TestFlight guide](docs/operations/IOS_TESTFLIGHT.md)
states the Apple and signing boundaries.

### Launch a web product

Set `app_kind: web` in the founder brief and enable only the web capabilities
the core journey needs. Run the first-launch sequence above, inspect the Vercel,
Neon, discovery, email and commerce nodes selected by the dry run, then apply
through a host that has the required build/provider bindings. The
[deployment guide](docs/engineering/DEPLOYMENT.md) defines the read-back and
critical-journey evidence needed before calling it launched.

### Launch an iOS/TestFlight product

Set `app_kind` to `mobile_ios`, `mobile_cross_platform`, or `hybrid`, and set
`requested_mobile_stack` to `expo_react_native`, `swiftui`, or `auto`. Review the
routed stack and payment source, then apply with `mobile_testflight` authorization
when its envelope permits the build/upload. The first App Store Connect record
may pause for founder input; resume that same run with evidence. Follow the
[iOS/TestFlight guide](docs/operations/IOS_TESTFLIGHT.md); TestFlight never
implies public App Store release.

## Provider support

“Planned” below means the adapter produces typed, redacted, idempotent
operations and read-back requirements. It does not mean this template has
created a live resource.

| Provider          | Current v0.2 surface                                            | Honest boundary                                                                                                                                            |
| ----------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub            | CLI plan for repo, Actions secret metadata, settings, draft PR  | Secret values are write-only; verify metadata.                                                                                                             |
| Vercel            | CLI plan for create/link, env metadata, JSON deploy, domain     | Creation needs an explicit slug/scope/intent; deployment identity and `READY` state are read back.                                                         |
| Vercel Analytics  | Event destination, consent contract and capability checks       | Enablement and behavior require linked-project read-back; no separate live adapter is claimed.                                                             |
| Neon              | CLI/psql plan for verified resources or new-project composition | New-project output is captured only into a pre-registered writable broker reference; migrations and read/write health must still pass before verification. |
| Stripe            | API plan for product, price, webhook, portal                    | Test/live modes stay separate; no charge is implied by configuration.                                                                                      |
| RevenueCat        | API plan for app, entitlement, offering, webhook                | Project and secret-key bootstrap remain manual; store products are separate.                                                                               |
| Brevo             | API plan for domain, sender, template, webhook                  | DNS authentication is asynchronous; sending remains separately authorized.                                                                                 |
| Google            | API plan for GA4, site verification, Search Console, sitemap    | DNS/site verification must complete before Search Console is called verified.                                                                              |
| Bing              | API plan for site, sitemap, URL submission                      | Availability is checked by doctor; indexing is never inferred from acceptance.                                                                             |
| DNS / MijnDomein  | One ordered manual record plan and authoritative read-back      | No undocumented MijnDomein write API; preserve MX/SPF/DKIM/DMARC and nameservers.                                                                          |
| App Store Connect | API/manual plan for prerequisites, groups, beta metadata        | The first app record is manual; TestFlight is not App Store publication.                                                                                   |
| EAS               | CLI plan for iOS build and submit                               | Build completion and Apple acceptance are verified separately.                                                                                             |

Provider state is typed: `unconfigured`, `auth_required`, `planned`,
`applying`, `waiting_manual_action`, `configured`, `verified`, `degraded`,
`failed`, or `disabled`. Only `verified` requires a timestamp and evidence
artifact. Full guides are indexed in [docs/operations/](docs/operations/README.md).

### Automation boundary

- **Works fully offline:** brief validation, mode/rail/payment routing, graph and
  dry-run compilation, durable local execution/resume, synthetic fixtures,
  redaction, config migration, managed-file upgrade planning, data normalization
  and bounded learning decisions.
- **Automatable after configuration:** complete built-in provider plans execute
  through official CLI/API transports and the default agent host, inside an
  envelope, then read state back. Account-specific credentials and identifiers
  remain unconfigured, and incomplete multi-resource chains fail before a call.
- **Genuinely manual by default:** MijnDomein record entry, first App Store
  Connect app record, RevenueCat project/key bootstrap, jurisdictional/legal
  review, and any effect for which doctor finds no supported official transport.

## Authenticate once, expose no secrets

```bash
vh auth login [provider]
vh auth status
vh auth test [provider]
vh auth revoke <provider>
```

Repository config stores only logical references such as
`cred://stripe/primary`. The broker maps each reference to a system keychain,
read-only CI environment, optional 1Password backend, provider CLI session, or
in-memory test backend. Values never belong in Git, logs, reports, workflow
state, or another venture. Status and tests may reveal account IDs, scopes,
expiry, and availability—never the value. See
[provider authentication](docs/operations/PROVIDER_AUTHENTICATION.md) and
[credential rotation](docs/operations/CREDENTIAL_ROTATION.md).

## Authorization profiles

An authorization profile is a ceiling, not proof that an operation succeeded.
Every run envelope also limits providers, capabilities, environments, expiry,
spend, recipient count, and forbidden actions.

Launch envelopes replace a profile's wildcard with the exact provider
capabilities declared by the scoped graph. Known provider estimates are reserved
durably before transport and accumulated across the run. An external write with
no estimate is rejected unless the chosen profile explicitly sets
`unknown_external_costs_allowed`; that exception should be removed as adapters
gain complete estimates.

| Profile                | Intended scope                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `read_only`            | Inspect local and external state.                                                                              |
| `build_local`          | Local files, tests, and repository work.                                                                       |
| `preview_launch`       | Reversible preview resources and preview deploys.                                                              |
| `standard_launch`      | Named production deploy, additive DNS, and at most one authorized test email when the envelope permits them.   |
| `live_commerce_launch` | Explicit live commerce configuration or charge authority within a cap.                                         |
| `mobile_testflight`    | iOS build and TestFlight upload, not public App Store release.                                                 |
| `autofix_low_risk`     | Narrow, proven local repairs; never pricing, claims, targeting, send, publish, deploy, or destructive changes. |

Deletion, destructive production data changes, nameserver replacement, bulk or
cold communication, cap overruns, unapproved customer charges, and irreversible
App Store publication always need a distinct checkpoint.

## Runs: inspect, pause, and resume

```bash
vh status [run-id]
vh explain [run-id] <node-id>
vh resume <run-id>
vh resume <run-id> --authorization <same-profile>
vh resume <run-id> --manual <node-id> --evidence <artifact> [--output <json-file>]
vh resume <run-id> --grant <node-id> --effect <effect> --operation <operation-id> --evidence <artifact>
vh cancel <run-id> --reason "why"
```

Use `--approve` instead of `--manual` to resolve an approval node. Run state and a
redacted event log are written atomically under
`.venture/runs/<run-id>/`. Manual and approval nodes pause honestly while
independent nodes continue. Resume uses the same graph fingerprint and reuses
verified idempotent effects; it does not silently start a second launch.
An expired envelope is never renewed silently while provider effects remain. A
named `--authorization` renewal preserves the run ID, graph fingerprint,
providers, environments, exact capabilities, and original profile while
persisting a new issue/expiry window and approval reference.

Dangerous provider effects pause before transport and persist the exact effect
and operation ID. `--grant` accepts only typed JSON under
`reports/launch/<run-id>/checkpoints/` whose run, node, effect, operation,
approver, and approval time match. The resulting grant is consumed once before
the provider call; a retry needs a later approval and a new evidence artifact.

## Direct data and bounded learning

```bash
vh data sync
vh learn daily
vh learn weekly
vh learn biweekly
vh learn monthly
```

Direct connectors normalize provenance, reporting windows, timezone, quality,
limitations, and release version. Missing data remains missing—not zero. A
learning loop refuses to act on stale required evidence, protects measured
winners, permits one conceptual hypothesis per journey, and limits low-risk
autofix. `vh learn` persists timestamped and `latest` JSON/Markdown reports under
`reports/learning/<cadence>/`, including an honest `insufficient_evidence`
report when data is absent.

The daily/weekly/biweekly/monthly GitHub workflow is disabled by default. Disabled
cadences upload a neutral skip marker without syncing; once enabled, the
workflow syncs direct data first, never substitutes a fixture, uploads the typed
report, and fails unless evidence is complete. The template declares no live
source account or credential. The operating contract is in
[OPERATING_CADENCE.md](docs/operations/OPERATING_CADENCE.md).

## Upgrade a child venture

```bash
vh upgrade --release /path/to/venture-harness-v0.3 --dry-run
vh upgrade --release /path/to/venture-harness-v0.3
pnpm verify
```

`harness.lock` records the release, managed-file ownership and trusted hashes.
`--release` accepts an explicitly reviewed local release checkout, never a URL.
Its release lock and every managed hash must verify before planning. The
registered migration chain and conflict-free managed writes are staged together;
the fixed upgrade runner then runs adapter sync, parity, typecheck, and migration
tests before writing the child lock last. A failed check restores the staged
files and leaves the prior lock in place. Project-owned product, design, copy,
and evidence are preserved. The release cannot provide executable commands, and
the CLI does not fetch or execute a remote manifest.

For backward compatibility, bare `vh upgrade` can still migrate an unlocked
v0.1 config to v0.2. Use the explicit local release path for a full central
managed-file upgrade, and run `pnpm verify` after the new lock is committed for
the complete repository gate. See
[CHILD_VENTURE_UPGRADES.md](docs/operations/CHILD_VENTURE_UPGRADES.md).

## Safety and evidence

- No fabricated capabilities, users, testimonials, provider state, results, or
  analytics.
- No credential values in Git; no private form/search/message content in
  analytics.
- Exact displayed prices are recorded for price-bearing evidence events.
- External effects require a run-scoped envelope and provider read-back.
- Public claims follow [PRODUCT_TRUTH.md](docs/product/PRODUCT_TRUTH.md).
- Quality checks are capability-aware; skipped live checks name the credential,
  command, and evidence needed.

Start with [PROJECT.md](PROJECT.md), [ARCHITECTURE.md](ARCHITECTURE.md), and the
[documentation index](docs/README.md). The repository remains a template: both
fixtures are synthetic, and no venture or live market evidence is loaded.

## License

MIT. See [LICENSE](LICENSE).
