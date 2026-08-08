# ARCHITECTURE

Venture Harness separates founder judgement, deterministic orchestration, and
external effects. The small TypeScript runtime is the control plane; provider
CLIs and APIs remain replaceable transports.

## System map

```text
founder brief / build prompt
          │
          ▼
progressive-commitment validation ──► launch-mode + rail router
          │                                    │
          └────────────────────────────────────▼
                              launch graph compiler
                                         │
                     ┌───────────────────┼────────────────────┐
                     ▼                   ▼                    ▼
               local/model work   provider adapters   manual/approval nodes
                     │                   │                    │
                     └───────────────────▼────────────────────┘
                          durable workflow executor
                     state + events + evidence + budgets
                                         │
                     ┌───────────────────┼────────────────────┐
                     ▼                   ▼                    ▼
                 launch report      direct data sync    learning loops
                                         │
                                         ▼
                            versioned child-venture upgrade
```

`vh create` persists the router version, complete decision, and active event
packs with the selected brief in `.venture/project.json`. Each authorized run
copies that snapshot into `.venture/launches/<run-id>.json`; reports and resumes
use the persisted decision. Legacy schema-v1 state is read and deterministically
backfilled, while mismatched v0.2 snapshots and cross-venture reuse fail closed.

## Layers

| Layer             | Source                                               | Responsibility                                                                                                                                                |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator surface  | `bin/`, `lib/cli/`                                   | One `vh` entry point, exact errors, status and explain output.                                                                                                |
| Venture contracts | `config/`, `lib/config/`                             | Capabilities, launch decision, providers, policies, mobile, loops and lock schemas.                                                                           |
| Planning          | `lib/launch/`                                        | Validate the brief; choose mode, rail and payment source; compile the graph and dry run.                                                                      |
| Execution         | `lib/workflow/`                                      | DAG validation, bounded parallelism, retries, interrupts, resume, idempotency, budgets, cancellation and compensation.                                        |
| Product host      | `lib/mobile/`, `lib/runtime/build-agent-host.ts`     | Create-only deterministic mobile preparation plus agent-neutral bounded product work; the default Codex CLI adapter uses stdin and structured JSONL evidence. |
| Trust boundary    | `lib/credentials/`, `lib/providers/`, `lib/runtime/` | Keep values outside state; plan effects; compose official transports; read state back.                                                                        |
| Evidence          | `lib/analytics/`, `lib/data/`, `lib/learning/`       | Typed events, normalized provenance/freshness and bounded decisions.                                                                                          |
| Evolution         | `lib/migrations/`, `lib/upgrade/`, `harness.lock`    | Deterministic config migration and managed-file upgrades without replacing project-owned work.                                                                |
| Agent canon       | `AGENTS.md`, `skills/`, `docs/`                      | Rules, procedures and venture knowledge; generated adapters contain no unique policy.                                                                         |

## Planning and execution are separate

`vh plan` and `vh launch --dry-run` are pure planning surfaces. A provider plan
declares capability, transport, auth, risk, side effect, reversibility,
idempotency, read-back and manual fallback. An external write runs only through
an executable transport and a valid authorization envelope. A successful API
response is not verification; provider state becomes `verified` only after
read-back plus an evidence artifact.

Workflow definitions are JSON-safe. Handler functions and credentials are
injected separately, so durable state can be inspected without serializing code
or secrets. Runs live under `.venture/runs/`, use atomic state replacement and
append-only redacted events, and retain the graph fingerprint used for resume.
The default product host invokes `codex exec` directly with an argv array,
workspace-write sandboxing, an ephemeral session and ignored user config. It
sends the brief through stdin, keeps provider credentials out of the host
environment, and stores sanitized structured evidence rather than prompts or raw
JSONL. Fast and MVP quality profiles remain deterministic `pnpm` commands.
Repository, design, core-journey, and event-pack model nodes snapshot the
repository before and after the host runs. They complete only when declared
files have different hashes, handler-specific artifact roles exist, and a
relevant direct check passed with evidence, or when a typed
`already_compliant` result proves the required artifacts existed unchanged.
For a concrete mobile rail, `launch.prepareRepository` first uses the repo-native
mobile generator: exact generated files are idempotent, while unowned or changed
paths fail closed without overwrite. Subsequent design and core-journey work
continues through the bounded product host.

## Trust boundaries

- Config stores logical `cred://...` references only. Broker metadata selects
  keychain, environment, 1Password, CLI-session, or test backend.
- Provider operations receive a secret only for the duration of one direct CLI
  or HTTP call. Shell interpolation is not the credential transport.
- Run state, reports and errors pass through redaction. A provider response that
  may contain generated credentials is never persisted. The Neon new-project path
  may capture only `connection_uris[0].connection_uri` directly into an
  already-registered writable Neon credential reference; the broker adds it to
  redaction before command output leaves the transport. Other generated values
  require an explicit provider-specific capture path or separate broker registration.
- Authorization profiles define ceilings. Run envelopes narrow profiles by
  capability, provider, environment, expiry, spend, recipients and forbidden
  actions.
- Manual actions are typed nodes with requested fields and completion evidence;
  they are not untracked prose.
- Cross-provider dependencies persist only provider-specific allowlisted public
  DNS records and resource identifiers. DNS evidence must exactly equal the
  current run's ordered Vercel, Google and Brevo records; mobile submit and
  TestFlight stages similarly reject absent or ambiguous Apple/EAS identifiers.

## Product rails

The web rail keeps Next.js and raw server-rendered HTML. Mobile routing chooses
Expo React Native, SwiftUI, or records why `auto` chose one. Hybrid products
share backend/event contracts but keep web discovery and App Store discovery
as separate loops. Stripe and RevenueCat are alternative entitlement sources
unless an ADR defines a hybrid source of truth.
Expo scaffolds live under `mobile/expo`; native SwiftUI projects live under
`mobile/ios`. Missing bundle identifiers receive an explicitly local
`com.example.*` placeholder, never a claimed Apple or provider identifier.

## Evidence and learning

First-party commercial evidence remains authoritative. Direct connectors
normalize source account, fetched time, reporting window, timezone, dimensions,
quality, limitations and release version; raw provider exports are not committed.
Freshness is `fresh`, `stale`, or `missing`, and missing never becomes zero.
Learning functions stop on stale required evidence and cap conceptual actions.
Default official HTTP reads are source-isolated and credential-brokered. GSC,
GA4, Bing rank/traffic aggregates, Stripe balance transactions, Brevo delivery
aggregates, and RevenueCat overview metrics are projected into allowlisted
aggregate rows before the shared PII/credential normalizer runs. App Store
Analytics and Bing AI Performance fail with explicit connector prerequisites
instead of guessed endpoints or hidden fixture fallbacks.

## Upgrade ownership

`harness.lock` distinguishes `harness`, `generated`, and `project` files and
stores trusted hashes. Managed-release planning preserves project files, blocks
on diverged managed files and updates the lock last. A hash-verified local
release checkout supplies content but no commands. The registry resolves one
code-defined migration chain; staged writes then pass fixed adapter sync, parity,
typecheck, migration tests, and release-hash read-back before the lock is
replaced. Failures restore transaction paths. Central fetching remains
intentionally outside `vh upgrade`, and the operator runs the complete `pnpm
verify` gate after the lock commit. See
[ADR-004](docs/decisions/ADR-004-versioned-upgrades.md).

## Decisions and operations

Architecture decisions live in [docs/decisions/](docs/decisions/index.md).
Operator guides live in [docs/operations/](docs/operations/README.md). The
active executable decomposition is under [docs/plans/active/](docs/plans/active/).
