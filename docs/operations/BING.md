# Bing Webmaster Tools

The Bing adapter plans site, sitemap and URL-submission operations through the
supported API surface. Because parts of the surface are legacy, `vh doctor` must
confirm live availability before apply.

## Prepare

Authenticate through the supported OAuth/API-key path, confirm the exact site
URL/domain and verify ownership. Import from Google may be used when the account
and current official surface support it, but the harness still reads Bing state
back.

## Apply and verify

Add or locate the site, submit the canonical sitemap, and submit individual URLs
only when the active plan needs it. Read back site/feed lists and submission
responses. Acceptance is not indexation, rank or AI citation evidence.

## Data

`vh data sync` treats Bing Webmaster and Bing AI Performance (where exposed) as
separate provenance-aware sources. Report API availability, reporting window,
sampling or incomplete coverage and lag. Missing API access remains missing—not
zero impressions or citations.
