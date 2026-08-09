# ANALYTICS AND CONSENT

- Status: TEMPLATE — review per venture and jurisdiction
- Owner: founder
- Last updated: 2026-08-04

## Purpose

Engineering inventory for the active product rail, event packs, direct-data
connectors and processors. It is not legal advice or a compliance certification.

## Capability inventory

Add only providers/capabilities the venture activates.

| Provider/store                  | Purpose                                                            | Data categories                                            | Consent/lawful-basis note                      | Region/retention        |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------- | ----------------------- |
| venture-owned first-party store | material product/commercial evidence; private submissions isolated | anonymous event IDs; private payload only in its own table | document lawful basis; not copied to analytics | —                       |
| GA4 (optional)                  | consented behavior/acquisition                                     | allowed event properties only                              | strict opt-in default                          | record property setting |
| Vercel Web Analytics (optional) | aggregate web behavior                                             | route/referrer domain/device class                         | follow configured opt-in mode                  | provider setting        |
| Stripe/RevenueCat (optional)    | commerce/entitlements                                              | provider transaction/customer data                         | contract and product-specific basis            | provider setting        |
| Brevo (optional)                | transactional/lifecycle email                                      | recipient/delivery data stays in email system              | consent/purpose and send authorization         | provider setting        |

## Strict pre-consent behavior

No third-party analytics script or request loads before opt-in. First-party
anonymous consent and material events may be stored only when the venture's
reviewed lawful basis and inventory permit it. The product's core path works when
analytics consent is declined.

## Withdrawal

The settings control must be as reachable as acceptance. Withdrawal stops
third-party analytics immediately for that browser and records the change
first-party without personal form content.

## Direct-data boundary

Normalized learning datasets contain aggregates/classifications and provenance,
not raw provider exports or private text. Do not ingest names, email addresses,
phone numbers, form values, free-form messages, user content, payment details,
auth data or advertising identifiers. De-identification needs human review; a
hash of an email is still personal data.

## Retention and deletion

Record retention per active source, deletion request path, processor agreement
and whether commercial/legal records have a separate required retention. Never
use a deployment rollback to delete evidence.

## Items requiring legal review

- jurisdictional consent/banner/privacy copy;
- lawful basis for first-party evidence and submissions;
- commerce, email and mobile analytics disclosures;
- processor agreements, regions and cross-border transfers;
- data-subject access/deletion and retention schedule;
- App Store privacy labels and nutrition details when mobile is active.

## Evidence

Local consent and PII checks provide engineering evidence only. No jurisdiction
or live provider configuration is verified by the template.

## Assumptions

The child venture will remove inactive processors and add every real one before
launch.

## Unresolved questions

Jurisdiction, active processors, lawful bases, regions and retention are unknown.

## Related documents

- [../engineering/ANALYTICS.md](../engineering/ANALYTICS.md)
- [../../config/analytics.yaml](../../config/analytics.yaml)
- [../../NOTICE.md](../../NOTICE.md)
