# MijnDomein DNS

MijnDomein is manual by default because the harness does not assume an
undocumented write API. The launch compiler emits one consolidated `dns-records`
node after the Vercel domain, Google site-verification token and Brevo sending
domain nodes that are active for this run.

## Before changing records

1. Export or capture the current zone and TTLs.
2. Review the one typed, ordered record list assembled only from safe public
   outputs read back from those upstream nodes. Every item names
   `source_provider`, `type`, `name`, `value`, `ttl`, optional `priority`, and
   `reason`.
3. Preserve existing MX, SPF, DKIM, DMARC, verification and unrelated records.
4. Check for a record with the same name/type; update only when the plan says so.
5. Do not replace nameservers. Delegation is a separate, explicitly approved
   strategy with its own rollback plan.

## Apply

Enter the list in its supplied order: Vercel records first, Google records next,
and Brevo records last, with a stable type/name/value order inside each source.
Apply the exact type, host/name, value/target, TTL and priority from each item in
the MijnDomein control panel. Do not add a guessed value, omit an inconvenient
item, or complete a partial list. Never paste a credential or private key.
Record the prior value when updating rather than adding.

## Verify and resume

Use an authoritative DNS lookup—not only a recursive cache. Capture zone, record
type/name/value, TTL, observed authoritative nameserver and timestamp. For
provider verification records, also read the provider's verification state back.

Attach the evidence through the run's manual-action completion surface, then:

```bash
vh resume <run-id> --manual dns-records --evidence reports/launch/<run-id>/manual/dns-records.json
```

The evidence artifact must contain the exact additive record set in the same
order, `preserved_existing_mail_records=true`, `preserved_nameservers=true`, and
at least two timestamped matched propagation checks. The validator compares the
typed list exactly with this run's upstream public outputs and fails closed if
those outputs are absent or ambiguous. Its run, node, approver and output must
match the resumed manual node; a note or arbitrary file path is not proof of DNS
state.

Resuming releases separate downstream read-backs: Vercel domain state, Brevo
domain authentication, and Google site ownership before Search Console and its
sitemap. DNS acceptance does not itself prove any of those states or certificate
issuance.

## Rollback

Restore only the changed record's previous value/TTL and verify authoritative
DNS. Never “fix” an error by deleting unrelated mail or security records.
