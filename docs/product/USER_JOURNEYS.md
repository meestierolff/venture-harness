# USER_JOURNEYS

- Status: FRAMEWORK TEMPLATE
- Owner: founder
- Last updated: 2026-08-04

## Purpose

Map the founder's launch journey and the child product's measurable core
journeys. Events without a journey are likely noise; journeys without sufficient
measurement cannot support a decision.

## Founder launch journey

| Step         | Command                                                                                                                  | Expected evidence                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Authenticate | `vh auth login`, `vh auth test`, `vh auth status`                                                                        | references, account/scopes/expiry; never values                              |
| Diagnose     | `vh doctor`                                                                                                              | CLI/transport/auth/manual-only readiness and exact remediation               |
| Create       | `vh create --brief <file>`                                                                                               | validated brief and stored launch decision                                   |
| Plan         | `vh plan`                                                                                                                | mode, rail, capabilities, resources, cost/risk and assumptions               |
| Review       | `vh launch --dry-run`                                                                                                    | graph, critical path, parallel work, checks and manual actions               |
| Apply        | `vh launch --apply --authorization <profile>`                                                                            | run id and redacted effect/evidence log                                      |
| Inspect      | `vh status [run-id]`, `vh explain [run-id] <node-id>`                                                                    | node state, dependency, risk, auth and next action                           |
| Continue     | `vh resume <run-id> --manual <node-id> --evidence <artifact> [--output <json-file>]`; use `--approve` for approval nodes | validated resolution, same run fingerprint; verified effects reused          |
| Learn        | `vh data sync`, `vh learn daily\|weekly\|monthly`                                                                        | persisted JSON/Markdown, provenance, freshness, limits and bounded proposals |
| Upgrade      | `vh upgrade --release <local-release-root> --dry-run`, then repeat without `--dry-run`                                   | ownership/conflicts, migration/check report and lock-last result             |
| Revoke       | `vh auth revoke <provider>`                                                                                              | revoked/unavailable reference without value disclosure                       |

## Child product journey template

| Journey        | Steps | Primary event/signal                    | Guardrail                             | Data source                 |
| -------------- | ----- | --------------------------------------- | ------------------------------------- | --------------------------- |
| Core outcome   | —     | —                                       | error/privacy/latency — as applicable | first-party evidence        |
| Evaluate offer | —     | —                                       | claim and price integrity             | typed analytics pack        |
| Pay/subscribe  | —     | server-confirmed conversion/entitlement | refunds, webhook failures             | Stripe or RevenueCat        |
| Retain/return  | —     | repeat useful outcome                   | opt-out/support burden                | first-party + provider data |

## Friction notes

Record observed friction with source, window and sample limits. Do not convert a
missing event into a zero or infer causation from release timing alone.

## Evidence

The founder command surface is represented in `lib/cli/`; synthetic runtime
behavior is covered by CLI, workflow, launch and fixture tests. No child product
journey has live evidence.

## Assumptions

CLI services must be wired to the active provider registry before apply, auth,
data, learning or upgrade commands can perform their intended work.

## Unresolved questions

The first child venture's core journey and event pack.

## Related documents

- [VALIDATION.md](VALIDATION.md)
- [../engineering/ANALYTICS.md](../engineering/ANALYTICS.md)
- [../operations/FIRST_LAUNCH.md](../operations/FIRST_LAUNCH.md)
