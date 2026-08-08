# Brevo

The Brevo API plan covers sending domain, sender, versioned transactional
template and webhook configuration.

## Configure

Authenticate with a brokered API key. `brevo-sending-domain` first creates or
locates the exact domain and reads its typed public DNS authentication records
back. Those records join the one consolidated MijnDomein DNS plan; apply that
plan without changing nameservers or unrelated MX, SPF, DKIM or DMARC records.

## Verify

After the manual DNS node is verified, `brevo-domain-verification` requests
authentication and reads back both `verified=true` and `authenticated=true` for
the same domain. Only then may `brevo-email` configure and read back the inactive
sender, versioned transactional template and configured webhook/events. DNS
authentication is asynchronous; API acceptance alone leaves the provider
`configured` or `waiting_manual_action`, not `verified`.

## Sending boundary

A test send is allowed only to the explicitly authorized founder/test address
and recipient cap in the run envelope. Bulk, cold or lifecycle sending needs
separate consent, limits and authorization. Template creation is not email
delivery; record delivery/bounce evidence separately and never ingest recipient
addresses or message bodies into analytics.

## Rollback

Disable or restore the prior sender/template/webhook version and verify state.
Do not send an unapproved message to test recovery.
