# First launch

This is the shortest safe path from one brief to an inspectable launch run.
Commands use an installed `vh` bin; from the source checkout, prefix the same
arguments with `pnpm vh --`.

## 1. Prepare

```bash
pnpm install
pnpm verify
```

Founder alpha includes internally owned Codex CLI hosts for bounded rough-prose
sharpening and product work. A valid Launch Contract still parses with zero model
calls. The hosts receive credential-free context through stdin and a small
environment projection; provider credentials, transports and effect authority
stay in the separate provider runtime. This is a practical local prototype, not
perfect or audited OS-level read isolation. Caller injection is not a supported
operator escape hatch.

Complete every uncommented field in `inputs/VENTURE_BRIEF.yaml`. Keep facts in
`known_truths` and uncertain beliefs in `assumptions`. Do not put credentials,
private customer data or marketing proof in the brief.

## 2. Authenticate and diagnose

```bash
codex login status
vh auth login
vh auth status
vh doctor
```

The bare login command lists supported/registered providers and an exact next
action; it does not authenticate every provider. Run `vh auth login <provider>`
for only the accounts the launch can use. `doctor` should name missing CLIs,
scopes, expired references, unavailable transports and manual-only providers.
Fix `auth_required`; accept a manual provider only when the dry run has a precise
manual action. If planning selects another provider, authenticate it and rerun
doctor before apply.

## 3. Create and plan

```bash
vh create --brief inputs/VENTURE_BRIEF.yaml
vh plan
vh launch --dry-run
```

`create` validates the next `config/venture.yaml`, `config/launch.yaml`,
`config/mobile.yaml`, `config/analytics.yaml`, and `config/loops.yaml` values
before replacing each file atomically. It persists the versioned routing
snapshot and materializes routed packs, active journeys, and bounded learning
sources. A validation or write failure restores prior contracts. Selecting a
different venture ID in a working directory that already has `.venture` state
fails closed; use a fresh child directory instead of inheriting stale resources.

Review:

- launch mode, confidence, rationale, assumptions and rejected modes;
- web/mobile/hybrid rail and Stripe/RevenueCat entitlement source;
- capabilities and providers, resource identity, environment and possible cost;
- the minimum active analytics packs for the selected journeys;
- critical path, parallel layers, manual nodes and applicable checks;
- side effects against the intended authorization profile.

A dry run is not evidence that an account, transport or resource exists.

## 4. Apply one envelope

For a conventional web launch whose reviewed profile permits the listed effects:

```bash
vh launch --apply --authorization standard_launch
```

`vh launch` and `vh resume` exit `1` for terminal `failed` or `cancelled` runs.
A durable `waiting` run exits `0` because the authorized execution reached an
expected evidence or manual-action boundary; inspect `vh status <run-id>`, add
the requested typed evidence, and resume the same run. Invalid CLI usage exits
`2`. `vh upgrade` exits `1` when its result is `failed` or `blocked`.

Use `preview_launch`, `mobile_testflight` or another profile when that is the
actual scope. Live prices or charges require `live_commerce_launch` plus an
envelope that explicitly allows them; the profile name alone is insufficient.

## 5. Inspect and continue

```bash
vh status <run-id>
vh explain <run-id> <node-id>
vh resume <run-id> --manual <node-id> --evidence <repo-relative-artifact> [--output <json-file>]
```

When a node waits, follow only the requested manual action, capture its requested
fields in an optional JSON output file and attach the repo-relative evidence
artifact with the command above. Approval nodes use `--approve` instead of
`--manual`. The CLI rejects absolute/traversing evidence paths and
credential-shaped output, resolves the durable node, then resumes the same run.
Do not edit `state.json` by hand. MijnDomein and the first Apple app record are
expected manual cases.

## 6. Accept the launch report

The run is not complete until critical journeys and active providers have
read-back evidence, or the report lists a truthful limitation/manual action.
Use [LAUNCH_REPORT.md](LAUNCH_REPORT.md) as the required handoff shape.

## Exact current sequence

```bash
vh create --brief inputs/VENTURE_BRIEF.yaml && vh launch --dry-run
```

Run authentication and `vh doctor` first. The dry run prints the exact apply
command and any model-host or provider blocker. Invoke apply only under its exact
reviewed authorization. Treat model completion, provider request acceptance and
provider read-back as distinct evidence; no live dogfood success is implied.
