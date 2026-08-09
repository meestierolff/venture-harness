# Technical discovery

Use this playbook for web crawlability, indexability, rendering, metadata,
canonicals, sitemaps, redirects, structured data, internal links, performance,
and accessibility signals.

## Required checks

For each intended indexable owner, verify:

- stable HTTPS URL and intentional `200` response;
- no auth, robots, `noindex`, `X-Robots-Tag`, CDN, WAF, geo, or JavaScript
  challenge blocking approved crawlers;
- title, accurate description, language, one visible H1, direct answer/core
  proposition, current product facts, useful links, and alt text in raw HTML;
- one absolute canonical that agrees with redirects, internal links, sitemap,
  hreflang, and structured-data identifiers;
- sitemap contains only preferred, indexable `200` owners and uses `lastmod`
  only for material changes;
- no mixed-case/trailing-slash/parameter/locale duplicates, search-result traps,
  session IDs, orphan routes, redirect chains, soft 404s, or broken links;
- page-appropriate structured data that matches visible names, prices, dates,
  availability, people, reviews, and offers;
- mobile usability, keyboard/focus behavior, contrast, LCP, INP, CLS, TTFB,
  bundle/image cost, and layout stability where tooling is available.

Use `404` or `410` when removal has no relevant replacement. Use permanent
redirects only for permanent replacements. `robots.txt` is not a substitute for
`noindex`.

## Crawler verification

Compare a normal browser, Googlebot-like, bingbot-like, and each explicitly
approved answer crawler. Record URL, user agent, status, relevant headers, and
raw-body differences. Search crawling and model-training access are separate
policy choices. Never call a difference cloaking without evidence.

## Indexation diagnosis

For discovered/crawled-not-indexed, duplicates, blocked routes, soft 404s, or
server failures, inspect uniqueness, owner overlap, user value, links,
canonical, status, raw/rendered content, sitemap, and whether the page should
exist before requesting indexing. Search Console inspection is for a small set
of important URLs; sitemaps handle broad discovery. IndexNow receipt means only
that a participating engine received a submission.

## Output

Record expected versus observed behavior, affected owners, reproducible
commands, the smallest safe diff, source and rendered results, and monitoring.
Crawler-policy, canonical, redirect, and sitemap-rule changes require the
active authorization envelope.
