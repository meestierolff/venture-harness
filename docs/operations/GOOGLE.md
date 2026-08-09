# Google Analytics and Search Console

The Google API plan can cover a GA4 property/web stream, site-verification token,
Search Console property and sitemap submission when account permissions allow.

## Authentication

Use OAuth or a service account with only the required Analytics edit, Site
Verification and Search Console scopes. `vh auth test google` must confirm the
usable account/scopes without revealing a token.

## Order

1. `google-analytics-property` creates or locates the GA4 property and reads its
   public property ID back.
2. `google-analytics-stream` consumes that same-run property ID, creates or
   locates the web stream, and reads its stream and measurement IDs back. Both
   analytics stages occur before DNS work.
3. Keep strict consent: no GA request before opt-in.
4. `google-site-dns-record` requests a `DNS_TXT` token and repeats the token
   read-back before exposing one typed public DNS record to `dns-records`.
5. Apply and verify the consolidated DNS plan. `google-site-verification` then
   verifies exact site ownership and reads it back.
6. Only after ownership is verified does `google-search-console` create/read the
   Search Console site and submit/read the sitemap for the canonical production
   URL.

## Verify and ingest

Only a unique same-run ID may cross between stages; a missing or ambiguous ID
stops the dependent node. Read back property/stream identity, site ownership and
sitemap status. Search Console acceptance does not prove indexing or ranking.
`vh data sync` later
records reporting window, account/property, lag, row/aggregation limits,
sampling/thresholding and the consented GA4 population.

Do not combine GA4 consented denominators with first-party populations without a
clear limitation.
