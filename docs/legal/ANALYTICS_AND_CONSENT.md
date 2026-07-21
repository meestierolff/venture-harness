# ANALYTICS_AND_CONSENT

- Status: TEMPLATE
- Owner: unassigned
- Last updated: 2026-07-21

## Purpose

The consent and data-processing inventory for this venture's validation
site. This is an engineering inventory to hand to a qualified professional —
**it is not legal advice and not a compliance certification.**

## Provider inventory

| Provider             | Purpose             | Data received                                                    | Pre-consent              | Post-consent     |
| -------------------- | ------------------- | ---------------------------------------------------------------- | ------------------------ | ---------------- |
| Vercel Web Analytics | aggregate traffic   | pageviews, referrer domain, device class                         | nothing (opt_in default) | aggregate events |
| Google Analytics 4   | consented behaviour | events per config/analytics.yaml, no PII                         | nothing loads            | consented events |
| Neon (first-party)   | commercial evidence | anonymous visitor id events; form payloads in `submissions` only | anonymous events         | unchanged        |

## Pre-consent behaviour (strict mode)

No third-party script loads. No third-party request fires. First-party
anonymous events (consent funnel, experiment exposure with anonymous
visitor id) are recorded in the venture's own database.

## Post-consent behaviour

GA4 and Vercel Web Analytics activate for the consenting visitor. The
consent state change is recorded first-party (`consent_changed`).

## Consent copy

Recorded in [../brand/COPY.md](../brand/COPY.md) (block `consent.banner`).
Requirements: plain language, a real decline option equal in prominence to
accept, and a settings link (`settings_link_required: true`).

## Withdrawal path

The consent settings control (footer link) allows withdrawal at any time.
Withdrawal disables third-party analytics immediately for that browser and
records `consent_withdrawn` first-party.

## Data categories

| Category                       | Where                   | Retention                             |
| ------------------------------ | ----------------------- | ------------------------------------- |
| Anonymous behavioural events   | GA4 / Vercel            | provider-managed (GA4: 14 months)     |
| Anonymous commercial evidence  | Neon                    | life of venture                       |
| Submitted form data (personal) | Neon `submissions` only | until deletion request or venture end |

## Prohibited data

See `prohibited_properties` in [../../config/analytics.yaml](../../config/analytics.yaml):
no email, names, phone, messages, raw search text, form values, passwords,
tokens, keystrokes, session replay, or advertising identifiers — enforced
by `pnpm verify:analytics-pii`.

## Processors

| Processor | Role                          | Region notes                                |
| --------- | ----------------------------- | ------------------------------------------- |
| Vercel    | hosting + aggregate analytics | — (record region at launch)                 |
| Google    | GA4                           | — (record data location settings at launch) |
| Neon      | first-party database          | — (choose region at creation)               |

## Items requiring legal review

- Consent banner copy and its jurisdictional adequacy (GDPR/ePrivacy or
  local equivalent).
- Lawful basis documentation for the `submissions` table.
- Privacy policy and imprint pages before launch.
- Data-processing agreements with Vercel, Google, Neon.
- Retention schedule sign-off.

## Evidence

None — template state.

## Assumptions

None recorded.

## Unresolved questions

None recorded.

## Related documents

- [../engineering/ANALYTICS.md](../engineering/ANALYTICS.md)
- [../../config/analytics.yaml](../../config/analytics.yaml)
- [../../NOTICE.md](../../NOTICE.md)
