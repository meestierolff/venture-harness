# Operating cadence

The cadence starts with direct normalized data, not copied dashboard summaries.
Daily, weekly, biweekly and monthly loop contracts are declared in
`config/loops.yaml`. Every cadence is disabled by default; enabling a schedule
does not make missing provider data valid evidence.

## Sync

```bash
vh data sync
```

Supported connector contracts cover GSC, GA4, Bing Webmaster and AI Performance
where exposed, Neon commercial evidence, Stripe, RevenueCat, Brevo, App Store
Connect Analytics, release logs and de-identified feedback, interview and support
classifications. Each result records provenance, window, timezone, dimensions,
quality, limitations and release version. Sources sync independently.

The source-checkout CLI composes aggregate Neon and strict local release-log
connectors from declared loop inputs. Neon also requires a `verified` lifecycle
entry in `config/providers.yaml` with `project_id`, `database_name`, and a
brokered `database_credential_ref`. With no usable declared connector,
`vh data sync` returns `not_configured`; configured failures or stale required
evidence return `incomplete`. Neither state creates a synthetic or zero-filled
live dataset. Default brokered read-only connectors cover aggregate GSC, GA4,
Bing Webmaster traffic, Stripe balance transactions, RevenueCat overview and
Brevo delivery data after verified provider configuration. App Store Analytics
still needs an account-specific report-request/JWT/segment adapter, and Bing AI
Performance still needs an account-specific official export adapter. Neither
boundary is reported as configured.

## Cadences

| Cadence  | Primary purpose                                        | Maximum conceptual work                          |
| -------- | ------------------------------------------------------ | ------------------------------------------------ |
| daily    | breakage and early-signal visibility                   | one bounded action by default                    |
| weekly   | acquisition, activation, commerce and discovery review | up to configured cap; one hypothesis per journey |
| biweekly | product friction and qualitative synthesis             | up to configured cap; one hypothesis per journey |
| monthly  | strategy, economics, channel and scope decision        | proposals only unless separately authorized      |

Run the current CLI surfaces with:

```bash
vh learn daily
vh learn weekly
vh learn biweekly
vh learn monthly
```

Each `vh learn` call writes a timestamped typed JSON/Markdown pair plus
`latest.json` and `latest.md` under the cadence's declared destination. It still
writes an `insufficient_evidence` report when required data or primary metrics
are unavailable; persistence is not proof that analysis could proceed.

## Decision constraints

- Stop with `insufficient_evidence` if any required source is stale or missing.
- Keep missing values null; do not reinterpret them as zero.
- Cite dataset/provenance references and sample limits for every proposal.
- Protect active measured winners and guardrails.
- Allow at most one active conceptual hypothesis per affected journey.
- Verified bug fixes do not consume the conceptual-action cap, but still need
  reproduced evidence and safe scope.
- `autofix_low_risk` is limited to authorized local/git repairs. It cannot change
  prices, claims, positioning, targeting, spend, send, publish, deploy or delete.

## Scheduled workflow

The GitHub Actions workflow in `.github/workflows/learning-cadence.yml` handles
daily, weekly, biweekly and monthly contracts. It reads `enabled`, cron and
`output_destination` from [config/loops.yaml](../../config/loops.yaml).

- A disabled cadence performs no data sync or analysis. It writes and uploads
  `schedule-skip.json` and `schedule-skip.md`, reports `disabled`, and exits
  neutrally.
- An enabled cadence runs `vh data sync` first. It never falls back to a fixture
  or treats absence as zero.
- It then runs `vh learn <cadence>` so an insufficient-evidence JSON/Markdown
  report still exists, and uploads the declared report directory even when the
  final guard will fail.
- The final guard fails the job if sync is unconfigured/failed, the report
  command failed, `latest.json` is missing, or report status is not `complete`.

Before setting `enabled: true`, declare its read-only inputs and freshness,
configure the corresponding credential references, and add real metric and
candidate mappings. An enabled cadence fails honestly unless its direct sync
status and persisted learning report are both exactly `complete`.

## Outputs

Default destinations are `reports/learning/daily`, `/weekly`, `/biweekly` and
`/monthly`. A successful or insufficient report contains freshness, metrics,
protected winners, accepted/rejected actions, limitations, stop condition and
next run. GitHub uploads these files as a run artifact; it does not commit them.

Every `vh learn` run also refreshes
`reports/learning/operating-cadence.json` and `.md` with the next declared daily,
weekly, biweekly and monthly reviews, missing sources, active hypotheses/experiments
and connector blockers. Enabled daily, weekly, biweekly and monthly contracts
resolve their next UTC occurrence from the reviewed cron expression when `vh create`
materializes a brief. Disabled contracts keep a null date, rendered as
`not scheduled`; the document does not invent a schedule from an incomplete
contract.

The repository includes a scheduled-sync smoke fixture for CI. It must stay
labeled `SYNTHETIC`; the learning-cadence workflow never uses it as a fallback
for missing credentials or provider data.

No scheduled workflow may send, publish, deploy, charge or merge without the
same authorization required for an interactive run.
