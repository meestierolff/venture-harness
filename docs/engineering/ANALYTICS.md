# ANALYTICS

- Status: FRAMEWORK CONTRACT — no live data
- Owner: harness maintainers
- Last updated: 2026-08-04

## Purpose

Measure each active core journey with the smallest applicable event set while
preserving consent, price integrity, provenance and first-party authority. The
event registry is [../../config/analytics.yaml](../../config/analytics.yaml);
typed code is [../../lib/analytics/](../../lib/analytics/).

## Capability-aware event packs

Packs are selection views over one event registry, not duplicate taxonomies.
`core_product` and `reliability` are always active; other packs resolve from the
venture contract. `vh create` writes that routed set plus the matching active
core journeys to `config/analytics.yaml`; it also writes bounded direct-source
requirements to `config/loops.yaml`. All five one-brief contracts are validated
before any are replaced, and the prior contents are restored if a write fails.

| Pack                           | Activation rule                                               |
| ------------------------------ | ------------------------------------------------------------- |
| `core_product`                 | every venture                                                 |
| `reliability`                  | every venture                                                 |
| `web_acquisition`              | `public_website` capability                                   |
| `content`                      | `web_seo_aeo_geo` capability                                  |
| `onboarding`, `authentication` | `authenticated_product` capability                            |
| `subscription`                 | subscription/hybrid monetization with Stripe or RevenueCat    |
| `one_time_payment`             | one-time/hybrid monetization with Stripe                      |
| `mobile`                       | iOS, cross-platform or hybrid app kind                        |
| `feedback`                     | `feedback_intake` capability                                  |
| `lead_generation`              | lead/services monetization or an explicit public lead journey |
| `experiment`                   | only when a controlled experiment is explicitly running       |

Every active core journey must have an outcome signal and relevant guardrails.
An event that maps to no journey should be removed or justified.

## Evidence layers

| Layer                         | Typical source                        | Scope                                                                                     |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| First-party material evidence | venture-owned Neon                    | assignments, exposures, exact offers/prices, server-confirmed outcomes and consent ledger |
| Consented behavior            | GA4                                   | opted-in acquisition and journey analysis                                                 |
| Aggregate web behavior        | Vercel Web Analytics                  | routes, referrer domains, devices and trends when enabled                                 |
| Commerce/store read-back      | Stripe, RevenueCat, App Store Connect | provider-confirmed product, entitlement, purchase and store metrics                       |

First-party commercial evidence remains authoritative. Provider dashboards are
supporting sources with their own lag, sampling, threshold and mode limits.

## Direct data and freshness

`vh data sync` uses read-only connector contracts for GSC, GA4, Bing Webmaster,
Bing AI Performance where available, Neon evidence, Stripe, RevenueCat, Brevo,
App Store Connect Analytics, release logs, de-identified feedback/interviews and
support classifications. Each normalized dataset retains:

- source and source account;
- fetched time and reporting window;
- timezone and dimensions;
- quality (`complete`, `partial`, `sampled`, `thresholded`, `stale`, or
  `unavailable`);
- limitations and release version.

The default CLI composes a source only when its loop input is declared and its
provider state or lifecycle evidence is verified. It supports aggregate-only
Neon evidence through direct `psql`, a strict categorical release log, and
brokered official HTTP reads for GSC, GA4, Bing rank/traffic aggregates, Stripe
balance transactions, Brevo transactional delivery aggregates, and RevenueCat
overview metrics. Each HTTP connector requests or projects only aggregate,
categorical fields; it discards customer, recipient, message, description,
query, page, and app-user payload fields before normalization. Google/Bing site
or property IDs, Stripe account plus explicit test/live mode, Brevo account ID,
and RevenueCat project ID must be unambiguous. Missing verification,
credential references, modes, or identifiers produce a source-specific
`connector_not_configured` failure and exact next action.

App Store Connect Analytics remains a deliberate boundary: the read path needs
a pre-existing report request, JWT signing, report-instance and segment
discovery, then provider-defined CSV parsing. `vh data sync` will not create
that report request or guess a segment schema. Bing AI Performance likewise
requires an injected account-specific official export adapter until a stable
provider-neutral API contract exists. Predeclared metric definitions and
candidate rules come from the selected loop. These paths are mock-tested, not
live provider proof.

Freshness is reported as `fresh`, `stale`, or `missing` against the loop's
required hours. Missing stays null, never zero. Sources fail independently so a
provider outage cannot silently erase other evidence. Raw provider exports and
private free text are not committed.

## Scheduled learning evidence

`vh learn daily|weekly|biweekly|monthly` persists typed timestamped and latest
JSON/Markdown reports under the destinations in `config/loops.yaml`. Report persistence does
not turn missing evidence into a result: status remains `insufficient_evidence`
with zero actions when required data or metrics are unavailable.

The GitHub cadence workflow honors `enabled`. Disabled loops emit a neutral skip
artifact without syncing. Enabled loops attempt `vh data sync` first, never use a
fixture fallback, upload the resulting report even on failure, and finish red
unless sync status is exactly `complete` and the report is complete. With no
declared, configured connector the CLI reports `not_configured`; partial or stale
evidence reports `incomplete`.

## Consent and prohibited data

Strict mode loads and sends no third-party analytics before opt-in. Withdrawal
stops third-party tracking immediately; first-party consent events remain. Never
send form values, names, email addresses, phone numbers, messages, raw search
text, user content, payment data, auth material, full referrer URLs, keystrokes,
cursor paths, session replay or clipboard data to analytics or normalized
learning datasets.

## Price and experiment integrity

Price-bearing events store the exact displayed string with the server-side
evidence record. Controlled results require exposure counts, stable assignment,
predeclared metrics/stops and limitations. Consent-based and first-party
populations are never mixed without disclosure.

## Quality and reports

Applicable checks are selected through the capability map:

```bash
pnpm verify:fast
pnpm verify:mvp
pnpm verify:release
```

Machine reports go to `.venture/reports/quality/<profile>-latest.json` and mark
checks `PASS`, `FAIL`, `SKIP`, or `NOT_APPLICABLE`. A skipped live check must name
why it skipped, the missing credential/environment, the exact command and the
expected read-back evidence. MVP readiness proves local pack/journey wiring
without treating absent credentials as failure; release readiness separately
requires destination lifecycle and fresh direct-data proof.

## Evidence

Local taxonomy, privacy, exact-price, normalization, freshness and loop tests
plus scheduler-contract fixtures provide prototype evidence. This template
contains no live analytics data or completed scheduled provider run.

## Assumptions

Each child venture reviews jurisdiction, provider retention and event packs
before production.

## Unresolved questions

Live connector availability, sampling and lag must be established per account.

## Related documents

- [../legal/ANALYTICS_AND_CONSENT.md](../legal/ANALYTICS_AND_CONSENT.md)
- [BACKEND.md](BACKEND.md)
- [../operations/OPERATING_CADENCE.md](../operations/OPERATING_CADENCE.md)
