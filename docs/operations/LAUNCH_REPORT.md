# Launch report contract

The executable `launch.report` binding can render and atomically persist one
concise human-readable report plus its JSON artifact for a run. Its default
paths are `reports/launch/<run-id>/final.md` and
`reports/launch/<run-id>/final.json`. Never fill an unknown field with an
inferred success.

## Current integration boundary

`createLaunchReportWorkflowBinding` is a tested runtime API. The default CLI
reserves and composes it with the active build and provider bindings, then
refreshes the report after waiting, failure, resume, success, or cancellation.
Founder alpha's public build host is unconditionally unavailable before model
invocation because Core has no audited outer read-isolation driver. Valid Launch
Contracts still use the zero-model parse and dry-run path; fixture hosts test
bounded product-task and report behavior without proving a supported operator
injection path. A report records durable state; it never proves a live model or
provider result without read-back evidence.

## Required fields

```markdown
# Launch report: <venture> / <run-id>

- Generated: <timestamp>
- Launch mode / rail: <mode> / <rail>
- Payment / entitlement source: <none|Stripe|RevenueCat> / <authoritative source>
- Event packs / consent: <routed pack IDs> / <strict|basic>
- Authorization: <profile, approval ref, expiry, spend ceiling>
- Overall state: succeeded | waiting | degraded | failed

## What was built

<core journey, public/app surfaces, labeled prototype/concierge limits>

## Repository

<owner/name, branch, commit, URL, visibility>

## Deployments and builds

<environment, URL or build/submission id, read-back state, evidence ref>

## Provider resources

<provider, account/team, resource ids, region, lifecycle state, evidence ref>

## Commerce

<none/Stripe/RevenueCat, test/live mode, entitlement source, products/prices verified>

## Email

<sender/domain/templates/webhooks, test-send status and authorized recipient count>

## Analytics and search

<active event packs, consent mode, GA4/Vercel/Neon, GSC/Bing, sitemap/indexing limits>

## ASO and TestFlight

<metadata artifact, App Store app/team IDs, EAS build, TestFlight submission; never infer publication>

## Checks run

<profile report; PASS/FAIL/SKIP/NOT_APPLICABLE and exact skip prerequisites>

## Active credential references

<cred:// references, account/scopes/expiry/status only; no values>

## Remaining manual actions

<node id, exact action/fields, risk, evidence needed, resume command>

## Known limitations

<unverified provider state, unavailable transport, data lag/sample limits>

## Scheduled loops

<cadence, required sources/freshness, output destination, autonomy>

## Next reviews

<daily/weekly/biweekly/monthly date, active hypotheses/experiments/blockers>
```

## Acceptance

A report may finish as `waiting` or `degraded`; honesty is more important than a
green label. It must not contain secret values, raw provider credential-bearing
responses, personal data, fabricated URLs/resource IDs or a live claim supported
only by a fixture. The renderer keeps only unresolved manual actions and stores
credential references and metadata, never credential values.
