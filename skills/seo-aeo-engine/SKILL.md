---

name: seo-aeo-engine
description: >-
   Discover, build, verify and improve organic search and answer-engine
   visibility. Use for repository-specific topical strategy, query-cluster
   ownership, high-intent content planning, emerging-query discovery, metadata,
   internal linking, structured data, crawlability, indexation, raw-HTML
   verification, weekly Google Search Console and Bing analysis, Bing AI
   Performance, AI-referral tracking, content consolidation and SEO recovery.
   Produces evidenced, human-reviewed, PR-sized improvements. Never publishes
   autonomously or mass-generates low-value pages. Do not use for brand
   identity, paid advertising, social-media automation, offer design or pricing
   decisions.
---

-----------------------------------------------------------------------------

# seo-aeo-engine

## Purpose

Build durable organic discovery for the specific venture in this repository.

The skill must:

1. discover or confirm the venture's most valuable topical wedges;
2. map material query clusters to one intentional canonical owner;
3. deepen the strongest wedges before expanding broadly;
4. make important pages clear, crawlable, indexable and answer-ready;
5. find emerging demand from weekly search and AI-performance data;
6. improve existing pages before creating unnecessary new ones;
7. create concise, original and expert-reviewed content that answers the user
   directly;
8. connect search visibility to qualified visits, conversions and product
   outcomes;
9. turn findings into small, evidenced implementation changes;
10. keep publication and material production changes human-gated.

Do not optimise for page count, keyword count, word count, impressions,
rankings or AI citations in isolation.

Optimise for qualified discovery, topical usefulness, user satisfaction and
commercially meaningful outcomes.

## Core principle

The repository must not publish broadly merely because topics are related to
the market.

It must establish depth around one or two high-value topical wedges, learn from
real performance data, and expand outward only when the existing cluster is
useful, connected and supported by evidence.

Agents provide research, analysis, drafting and implementation capacity.

Human domain knowledge provides direction, product truth, judgement,
experience, differentiation and final approval.

Agents are the excavator, not the surveyor.

## Trigger conditions

Use this skill when:

* a repository needs its initial SEO/AEO strategy;
* a new public route or content page is proposed;
* weekly GSC, Bing, Bing AI Performance or AI-referral files arrive;
* an emerging query or topic appears;
* a high-impression page has weak CTR or low conversion;
* a relevant query ranks in striking distance;
* multiple pages compete for the same intent;
* a page is crawled but not indexed;
* organic traffic, rankings, citations or conversions decline;
* metadata, canonicals, sitemaps, robots rules or structured data change;
* important content is absent from raw HTML;
* AI crawlers or search crawlers appear to be blocked;
* a topical cluster lacks depth or internal connections;
* stale, duplicated or low-value content needs consolidation;
* a new product fact creates a new legitimate search opportunity;
* a local business needs its search entity information reviewed.

## When not to use

Do not use this skill for:

* deciding what the company should sell;
* choosing pricing;
* inventing offer claims;
* general brand voice or visual identity;
* paid-ad acquisition funnels;
* order bumps, upsells or checkout architecture;
* TikTok, Pinterest or slideshow content production;
* automated social-media posting;
* buying links or manipulating third-party mentions;
* creating fabricated ratings, reviews or expertise;
* changing analytics infrastructure under `lib/analytics/**`;
* mass publication.

The skill may identify that a page needs a clearer conversion path, but offer,
pricing and funnel decisions remain owned by the relevant product, offer or
growth skill.

## Required inputs
Use the best available combination of:

- `docs/product/PRODUCT_TRUTH.md` for claim boundaries;
- `docs/growth/SEO.md` for the repository SEO profile and topical map;
- `docs/growth/CONTENT.md`, `config/content.yaml` and `config/offer.yaml`;
- relevant route implementations, metadata and structured data;
- current files under `data/seo/inbox/**` and `data/analytics/inbox/**` when
analysis is in scope;
- recent files under `reports/seo/**`;
- `package.json` and relevant repository verification scripts.

If a normally expected input is missing, report the gap, continue with
unaffected evidence, and do not invent values.

## Success definition

A successful repository has:

* a documented repository SEO profile;
* one or two confirmed or actively tested topical wedges;
* an intentional query-cluster map;
* zero or one canonical owner per material intent;
* useful depth around high-intent subjects;
* clear relationships between informational, decision and product pages;
* important answers in readable textual HTML;
* original evidence or expertise on material pages;
* working internal links, canonicals, sitemaps and structured data;
* weekly search and AI-performance analysis;
* emerging queries converted into deliberate page decisions;
* explicit rejected opportunities;
* no uncontrolled backlog of thin pages;
* measurable qualified traffic and conversion outcomes;
* passing repository checks;
* human approval before publication.

## Source-of-truth order

Resolve conflicts using this order:

1. `docs/product/PRODUCT_TRUTH.md`
2. approved offer and pricing configuration
3. explicit human-approved repository SEO profile
4. `docs/growth/SEO.md`
5. approved content and product documentation
6. current production pages
7. raw HTML and HTTP responses
8. GSC, Bing, Bing AI Performance and analytics data
9. live SERP and competitor research
10. historical SEO reports
11. model assumptions

Never let an SEO hypothesis override approved product truth.

Never modify a product claim merely because a query appears attractive.

If a topic cannot be answered truthfully with the current product, reject or
defer it.

## Documents to read

Read these files when present:

* `AGENTS.md`
* `docs/product/PRODUCT_TRUTH.md`
* `docs/growth/SEO.md`
* `docs/growth/CONTENT.md`
* `CONTENT.md`
* `docs/engineering/FRONTEND.md`
* `config/content.yaml`
* `config/offer.yaml`
* `data/seo/inbox/README.md`
* recent files under `reports/seo/**`
* relevant route implementations
* relevant tests and verification scripts
* `package.json`

Report missing documents, but continue when enough reliable evidence remains.

## Repository SEO profile

`docs/growth/SEO.md` must contain a repository-specific profile.

Use this structure:

```md
## Repository SEO profile

- Venture:
- Domain:
- Market:
- Primary language:
- Secondary languages:
- Primary audience:
- Primary conversion:
- Secondary conversions:
- Business type:
- Local-search relevance:
- Search maturity:
- Confirmed topical wedges:
- Candidate topical wedges:
- Excluded topics:
- Discovery status:
- Domain experts:
- Evidence sources:
- Last reviewed:
```

Allowed `search maturity` values:

* `pre-launch`
* `new-domain`
* `early-signal`
* `growing`
* `established`
* `recovery`

Allowed `discovery status` values:

* `confirmed`
* `partially-confirmed`
* `required`
* `revalidation-required`

Human-confirmed topical wedges are starting constraints, not permanent
assumptions. Preserve them until enough contrary evidence exists and a human
approves the change.

If no topical wedges are confirmed, discover them before planning a large
content backlog.

## Recognised data inputs

Use current files when available:

* `data/seo/inbox/gsc-queries.csv`
* `data/seo/inbox/gsc-pages.csv`
* `data/seo/inbox/gsc-query-pages.csv`
* `data/seo/inbox/gsc-indexing.csv`
* `data/seo/inbox/bing-queries.csv`
* `data/seo/inbox/bing-pages.csv`
* `data/seo/inbox/bing-ai-performance.csv`
* `data/seo/inbox/bing-ai-pages.csv`
* `data/seo/inbox/bing-ai-grounding-queries.csv`
* `data/analytics/inbox/ai-referrers.csv`
* `data/analytics/inbox/organic-conversions.csv`
* `data/analytics/inbox/landing-page-performance.csv`
* `data/seo/inbox/release-log.csv`
* approved keyword or SERP research exports.

Only require files declared mandatory in
`data/seo/inbox/README.md`.

Do not:

* fabricate absent data;
* interpret a missing row as zero;
* infer conversions from clicks;
* combine incompatible date windows;
* treat sampled AI citation data as a complete activity log;
* claim causation from a before-and-after comparison alone.

## Files this skill may change

Subject to repository conventions, the skill may change:

* `docs/growth/SEO.md`
* `docs/growth/CONTENT.md`
* page metadata under `app/**`
* public crawlable content under `app/**`
* page-level structured data
* internal links
* sitemap implementation
* robots implementation through an approval-gated diff
* content drafts under `templates/content/**`
* SEO validation scripts
* SEO test fixtures
* reports under `reports/seo/**`
* redirect maps through an approval-gated proposal.

Keep every implementation narrowly scoped to an evidenced opportunity.

## Files this skill must not change

Do not change:

* approved pricing values;
* approved offer claims;
* testimonials or review counts;
* product behaviour unrelated to discovery;
* secrets or credentials;
* `lib/analytics/**`;
* unrelated design-system components;
* production-domain configuration without approval;
* `config/*.yaml` unless repository policy explicitly allows the proposed
  addition;
* `skills/**`, including this skill, while executing it.

## Operating modes

Choose one primary mode before starting.

### 1. Repository bootstrap

Use when the repository has no reliable SEO profile, topical map or page
register.

Produce:

* repository SEO profile;
* initial query and intent research;
* candidate topical wedges;
* first cluster recommendation;
* technical baseline;
* measurement setup;
* 30-, 60- and 90-day plan.

### 2. Topical discovery

Use when the venture's strongest organic wedge is unknown or must be
revalidated.

Produce:

* candidate wedge scores;
* supporting query clusters;
* high-intent evidence;
* existing page performance;
* unique-value potential;
* recommended primary and secondary wedge;
* rejected broad topics;
* measurement plan.

### 3. Topical-depth expansion

Use when a wedge is confirmed but incomplete.

Produce:

* current coverage map;
* missing user decisions and sub-intents;
* pages to improve;
* pages to consolidate;
* justified new page briefs;
* internal-link changes;
* depth validation.

### 4. Weekly performance loop

Use when fresh GSC, Bing, AI-performance or analytics data is available.

Produce:

* data-quality report;
* protected winners;
* emerging queries;
* striking-distance opportunities;
* CTR opportunities;
* indexing defects;
* cannibalisation findings;
* AI citation and referral findings;
* maximum three high-confidence actions by default.

### 5. Technical verification

Use for crawlability, rendering, metadata, schema, canonical, indexation,
performance or crawler-access defects.

Produce:

* reproducible findings;
* affected URLs;
* expected versus observed behaviour;
* smallest safe implementation diff;
* executed validation results.

### 6. Traffic or indexation recovery

Use after a material decline.

Produce:

* incident window;
* affected segments;
* release correlation;
* technical hypotheses;
* content and intent hypotheses;
* demand hypotheses;
* evidence for and against each;
* conservative recovery actions;
* monitoring plan.

Do not combine unrelated modes into one oversized change.

## Core objects

### Query cluster

A query cluster groups searches that express substantially the same user task.

It contains:

* cluster ID;
* representative query;
* close variants;
* intent;
* user task;
* funnel stage;
* locale;
* audience;
* canonical owner;
* page type;
* approved evidence;
* conversion goal;
* internal links;
* status.

Do not create separate pages for trivial wording, singular/plural, word-order
or question-format variations.

### Topical wedge

A topical wedge is a commercially relevant subject area in which the venture
can build genuine depth and provide differentiated value.

A wedge must have:

* relevance to the product;
* evidence of user demand;
* one or more meaningful user decisions;
* multiple related but distinct query clusters;
* credible domain knowledge;
* original information or experience;
* a conversion relationship;
* enough durability to justify maintenance.

A topical wedge is not merely a broad market category.

### Canonical owner

The canonical owner is the one page intended to satisfy a query cluster.

Allowed ownership states:

* `owned`
* `candidate`
* `planned`
* `expand-existing`
* `merge`
* `redirect`
* `no-index`
* `rejected`
* `retired`

### Emerging query

An emerging query is a relevant query or cluster showing new or accelerating
visibility, demand, AI grounding activity or conversion evidence.

An emerging query does not automatically deserve a new page.

It may require:

* no action;
* monitoring;
* a paragraph on an existing page;
* a new section;
* a metadata change;
* stronger internal links;
* a comparison;
* a new canonical page;
* product or offer clarification.

## Query-cluster ownership

Every material query cluster must have zero or one intentional canonical owner.

The owner must serve:

* a clear user task;
* one dominant intent;
* an appropriate funnel stage;
* a truthful answer;
* a defined conversion or navigation goal.

A cluster may intentionally have no dedicated page when:

* an existing page already satisfies it;
* demand or relevance is weak;
* the venture lacks credible expertise;
* the product cannot answer it truthfully;
* the page would duplicate another owner;
* the user task is outside the offer;
* the page would primarily exist to capture keywords;
* maintenance cost exceeds likely value.

Preferred action order:

1. protect a successful existing owner;
2. improve the existing owner;
3. add a missing section;
4. strengthen internal links;
5. consolidate overlap;
6. create a new page only for a distinct, valuable intent.

## Topical-wedge discovery

When the wedge is not already confirmed, build candidates from:

* GSC queries and query-page mappings;
* Bing queries;
* landing-page conversions;
* customer questions;
* support emails or calls when available;
* approved sales-call language;
* site search;
* product capabilities;
* competitor and SERP research;
* Bing AI grounding queries;
* AI-referral landing pages;
* recurring domain-expert questions;
* existing pages with unusually strong CTR or engagement.

Do not choose a wedge from search volume alone.

### Wedge scoring

Score each candidate from 0 to 3 on:

* product relevance;
* commercial intent;
* existing search traction;
* CTR quality relative to position and intent;
* conversion evidence;
* density of adjacent sub-intents;
* strength of domain expertise;
* original-value potential;
* defensibility;
* maintenance feasibility.

Subtract for:

* weak product relationship;
* high legal, medical or financial risk without expertise;
* dependence on generic AI summaries;
* duplication with an existing wedge;
* low-value informational traffic;
* inability to create original evidence;
* excessive content or maintenance requirements.

Use:

```text
wedge_score =
  product_relevance
  + commercial_intent
  + traction
  + ctr_quality
  + conversion_evidence
  + adjacent_intent_density
  + expertise
  + original_value
  + defensibility
  + maintainability
  - risk_penalties
```

The score supports judgement. It does not replace it.

Select by default:

* one primary wedge;
* at most one secondary wedge;
* no broad expansion until the primary wedge has sufficient depth.

## Topical depth

Topical depth means satisfying the important decisions and questions inside a
wedge better, not publishing the largest number of articles.

Evaluate depth across:

1. **Intent coverage**
   Does the repository cover the important informational, comparison,
   transactional, problem-aware and decision-stage tasks?

2. **User progression**
   Can a visitor move naturally from question to decision to product action?

3. **Original value**
   Does the content contain experience, data, tools, examples, methodology,
   expert judgement or product insight unavailable from generic summaries?

4. **Internal graph**
   Are hub, child, sibling, comparison and product pages contextually linked?

5. **Canonical clarity**
   Is each cluster owned by one intentional page?

6. **Content quality**
   Are answers direct, accurate, current and independently useful?

7. **Machine readability**
   Are the key facts available in textual HTML and supported by truthful
   metadata and structured data?

8. **Performance evidence**
   Do the pages earn relevant impressions, clicks, citations, engagement or
   conversions?

9. **Maintenance**
   Are dates, prices, product facts and external evidence kept current?

Do not use a fixed article count as the definition of depth.

## Topical map

Maintain a topical map in `docs/growth/SEO.md`.

Each wedge should contain:

```md
### Wedge: <name>

- Status:
- Business relevance:
- Primary audience:
- Primary conversion:
- Domain expert:
- Original evidence available:
- Hub page:
- Product page:
- Comparison pages:
- Decision-stage clusters:
- Informational support clusters:
- Emerging clusters:
- Excluded clusters:
- Last reviewed:
```

Each cluster record must include:

* cluster ID;
* representative query;
* query variants;
* intent;
* user task;
* funnel stage;
* canonical URL;
* current position;
* impressions;
* CTR;
* conversions;
* AI citations when available;
* owner status;
* content status;
* required internal links;
* evidence source;
* last review date.

Use `not available` for missing values.

## New-site mode

Do not assume a universal sandbox duration or guarantee that results will
appear after a fixed period.

For a new site, use patient staged execution.

### Days 0–30: foundation

* verify GSC and Bing Webmaster Tools;
* configure analytics and conversion events;
* establish the repository SEO profile;
* select the first topical wedge;
* create the initial topical map;
* fix crawlability and raw-HTML issues;
* establish canonical, sitemap and robots consistency;
* establish organisation and author transparency;
* claim and complete a Business Profile when local intent is material;
* publish only the essential product, trust and first-cluster pages;
* begin collecting query data before broad expansion.

### Days 31–60: deepen the first wedge

* improve the hub and decision-stage pages;
* answer real customer questions;
* add contextual internal links;
* create original examples, tools, comparisons or evidence;
* review indexation;
* investigate early impressions and grounding queries;
* avoid opening multiple unrelated clusters.

### Days 61–90: learn and expand carefully

* compare equivalent performance windows;
* identify emerging queries;
* improve pages in striking distance;
* consolidate overlap;
* expand only when a new intent is distinct;
* begin a second wedge only when the first is coherent and useful;
* pursue legitimate relevant mentions or citations;
* evaluate qualified traffic and conversions, not traffic alone.

Low early traffic is not by itself evidence that the strategy failed.

## Weekly analysis loop

When weekly data exists:

1. validate files, columns and date coverage;
2. compare the recent period with the preceding equivalent period;
3. compare year over year when history is sufficient;
4. segment brand and non-brand queries;
5. segment device, country, locale and search type when material;
6. map queries to pages;
7. inspect conversions and engagement;
8. inspect Bing AI grounding queries and cited pages;
9. inspect AI referral sources and landing pages;
10. protect existing winners;
11. rank improvements;
12. prepare no more than three high-confidence content actions by default;
13. create PR-sized diffs or human-reviewable drafts;
14. write the dated report.

Run the repository command when available:

```bash
pnpm weekly
```

Do not fail when the command is absent. Report the missing automation and
perform the analysis from available inputs.

## Emerging-query detection

Compare at least:

* recent 28 days versus preceding 28 days;
* recent 7 days versus preceding 7 days for fast-moving topics;
* year over year when available.

Flag candidates showing one or more of:

* new impressions above the repository's minimum evidence threshold;
* sustained impression growth;
* movement into positions 4–20;
* strong CTR relative to position and intent;
* first conversions;
* repeated appearance across related variants;
* increasing Bing AI grounding activity;
* repeated arrival on an unintended page;
* appearance across multiple countries or devices;
* new customer-language patterns;
* new product or market relevance.

For every candidate, determine:

* whether it is truly new;
* whether it is seasonal;
* whether branded demand caused it;
* whether a release or campaign influenced it;
* whether it belongs to an existing cluster;
* whether the current owner already answers it;
* whether the product can answer it truthfully;
* whether it is high intent;
* whether it supports the confirmed wedge.

Classify each candidate as:

* `ignore`
* `monitor`
* `expand-existing`
* `improve-metadata`
* `add-internal-links`
* `create-comparison`
* `create-page`
* `product-truth-review`

Do not create a page simply because a phrase appeared.

## Striking-distance analysis

Investigate relevant queries generally ranking around positions 4–20.

Prioritise when:

* the intent is commercially meaningful;
* the current page is the correct owner;
* impressions are material;
* CTR is promising or improvable;
* the page has conversion value;
* the content gap is identifiable;
* stronger supporting internal links exist or can be added;
* the page can gain original depth.

Possible actions:

* answer the core question more directly;
* strengthen the opening;
* add missing decision criteria;
* improve evidence;
* improve title and description;
* add a comparison;
* update stale facts;
* add relevant internal links;
* consolidate competing pages.

Do not rewrite successful pages extensively without evidence of a specific gap.

## CTR analysis

Never apply one universal CTR benchmark.

Evaluate CTR relative to:

* average position;
* query intent;
* brand versus non-brand;
* device;
* country;
* search appearance;
* page type;
* previous page performance;
* nearby queries at similar positions;
* conversion quality.

A broad query can have lower CTR without being defective.

A high CTR is not valuable when it attracts the wrong user.

Before changing metadata, inspect whether the snippet accurately represents the
page. Never use misleading titles merely to increase clicks.

## Cannibalisation analysis

Flag probable cannibalisation when:

* several URLs receive material impressions for the same user task;
* ownership shifts repeatedly;
* the wrong page outranks the intended owner;
* internal links point inconsistently;
* canonicals and sitemaps disagree;
* near-duplicate pages divide links, clicks or conversions;
* informational pages displace decision-stage owners without helping users.

Do not label multiple-page visibility as cannibalisation when pages serve
genuinely different intents.

Preferred resolution:

1. document the owner;
2. differentiate distinct intents;
3. strengthen internal signals;
4. merge overlap;
5. redirect redundant URLs;
6. use `noindex` only when the page must remain accessible;
7. remove obsolete pages when no replacement is appropriate.

## Indexation analysis

Investigate:

* discovered but not indexed;
* crawled but not indexed;
* duplicate without selected canonical;
* alternate page with canonical;
* blocked by robots;
* blocked by `noindex`;
* soft 404;
* redirect errors;
* server errors;
* orphan pages;
* low-value parameter pages;
* rendered content missing from crawler-visible output.

For a page that is crawled but not indexed, do not immediately request indexing.

First inspect:

* content uniqueness;
* overlap;
* user value;
* internal links;
* canonical signals;
* response status;
* raw HTML;
* rendered HTML;
* sitemap inclusion;
* page quality;
* whether the page should exist at all.

Use Search Console URL Inspection for a small number of important URLs.

Use sitemaps for broad URL discovery.

Use IndexNow only for currently participating engines and only after approved
content changes. A successful submission confirms receipt, not indexing or
ranking.

Never represent IndexNow as a universal search-engine submission mechanism.

## Content decision gate

Do not draft a new indexable page until all are true:

1. the user task is distinct;
2. the query belongs to an approved or candidate wedge;
3. an existing page cannot satisfy it cleanly;
4. the product or domain expert can answer it truthfully;
5. the page will provide original value;
6. the page has a conversion or navigation goal;
7. the page has an internal-link plan;
8. the canonical owner is documented;
9. maintenance is feasible;
10. evidence is strong enough for the repository's maturity.

If one or more conditions fail, improve, consolidate, monitor or reject.

## Content priority

Prefer content in this order:

1. product and conversion pages;
2. high-intent decision pages;
3. comparisons;
4. problem and use-case pages;
5. tools, calculators, diagnostics, quizzes or interactive resources;
6. expert answers to recurring customer questions;
7. supporting informational content;
8. broad awareness content only when it strengthens the wedge.

Decision-stage pages often create more commercial and citation value than
generic long-tail articles, but do not force commercial intent onto a genuinely
informational query.

The informational layer should support real user progression, not exist as
isolated traffic inventory.

## Content brief requirements

Every proposed content change must specify:

* cluster ID;
* representative query;
* user task;
* intent;
* funnel stage;
* current owner;
* proposed owner;
* reason for action;
* evidence period;
* impressions, clicks, CTR and position;
* conversions when available;
* AI citations or grounding activity when available;
* direct answer;
* original contribution;
* domain expert;
* required facts and sources;
* limitations;
* section outline;
* internal links in;
* internal links out;
* conversion goal;
* metadata;
* structured data;
* approval owner;
* validation method;
* monitoring metric.

## Answer-ready content standard

Write for humans first while making each important passage easy to understand
and reuse accurately.

### Direct answer

For a question, comparison or decision page:

* answer the main question in the first one to three sentences;
* usually keep the initial answer concise;
* include the most important condition or limitation;
* avoid a long scene-setting introduction;
* continue with evidence and nuance below.

Do not enforce an exact word count when a shorter or longer answer is clearer.

### Headings

Use headings that describe the question or decision answered by the section.

Question-based headings are useful when users genuinely ask that question.

Do not mechanically turn every heading into a question.

Avoid vague headings such as:

* `Introduction`
* `Overview`
* `Things to know`
* `Final thoughts`

Prefer headings such as:

* `Is Tibet suitable for first-time high-altitude travellers?`
* `How does portfolio overlap increase concentration risk?`
* `What does the price include?`

### Section openings

When a section answers a factual question, begin with a clear declarative
answer before explanation.

Do not bury the conclusion beneath background information.

### Passage clarity

Important passages must:

* name the entity explicitly;
* use consistent terminology;
* include dates, currencies, units and locations when relevant;
* distinguish fact, estimate, opinion and hypothesis;
* explain acronyms;
* avoid unexplained pronouns;
* avoid empty marketing language;
* remain understandable outside the surrounding paragraph.

### Length

No page has a mandatory minimum word count.

Use the shortest length that fully satisfies the user task.

Expand only for:

* evidence;
* examples;
* decisions;
* limitations;
* comparisons;
* methodology;
* original experience;
* useful next steps.

Remove repetition, generic history, padded introductions and conclusions that
add no value.

### Original contribution

Every material indexable page must provide at least one defensible contribution:

* first-hand experience;
* proprietary data;
* original analysis;
* a real worked example;
* a transparent methodology;
* domain-expert judgement;
* an original comparison framework;
* current verified pricing or availability;
* an interactive tool;
* product-specific insight;
* original photography, screenshots or demonstrations;
* a clear position supported by reasoning.

Do not merely paraphrase the current top results.

### Expertise gate

Every page must identify the knowledge needed for reliable review.

For specialist topics, require an appropriate domain expert.

AI-generated drafts cannot replace domain expertise.

The human reviewer must check:

* factual accuracy;
* practical usefulness;
* missing nuance;
* unsupported claims;
* tone and clarity;
* originality;
* product truth;
* legal or safety implications.

### Evidence

Use primary and authoritative sources where practical.

For material claims:

* retain source details;
* record the verification date;
* state important assumptions;
* disclose limitations;
* separate external evidence from internal opinion.

Never fabricate citations, tests, customer experience or expert review.

### Conversion path

Every page must have an appropriate next step.

The next step may be:

* continue to a related answer;
* compare options;
* use a tool;
* view a product;
* request advice;
* start a diagnostic;
* sign up;
* book;
* download an app.

Do not attach a generic sales CTA to every informational page.

## LLM and answer-engine readiness

Treat answer-engine optimisation as an extension of strong SEO, content,
entity and technical practices.

Do not create a hidden or separate “LLM version” of a page.

Material pages should:

* expose important facts in textual HTML;
* answer the primary question early;
* use clear descriptive headings;
* name real entities;
* state current dates, prices and scope;
* support claims with evidence;
* explain comparisons and methodology;
* include author or organisational accountability;
* connect related pages through crawlable links;
* use stable canonical URLs;
* use structured data that matches visible content;
* remain useful when no AI engine cites them.

Do not guarantee AI citation or ranking.

## AI visibility measurement

Use three evidence classes.

### 1. Bing AI Performance

Analyse when available:

* total citations;
* cited pages;
* average cited pages;
* grounding queries;
* grounding-query-to-page mappings;
* topic and intent classifications when available;
* comparison-period changes.

Treat these as sampled visibility indicators.

They do not prove:

* ranking;
* authority;
* exact prompt wording;
* causal impact of one content change;
* conversion value.

Map grounding queries to existing query clusters.

Investigate when:

* an unintended page is cited;
* several pages are cited for the same task;
* a high-value wedge has no citation activity;
* emerging grounding queries appear;
* cited content contains stale facts;
* citation growth produces no qualified traffic.

### 2. AI referrals

Normalise known AI sources and parameters.

Track at least:

* source or referrer;
* campaign parameters;
* landing page;
* sessions;
* engaged sessions;
* conversions;
* assisted conversions;
* revenue or qualified lead outcome when available.

Recognise ChatGPT traffic using both referrer information and recognised
campaign parameters such as `utm_source=chatgpt.com`.

Keep unattributed direct traffic separate.

Do not relabel uncertain direct traffic as AI traffic.

### 3. Controlled prompt observations

A repository may maintain a small, human-approved set of high-value questions
to observe across answer engines.

Record:

* exact question;
* engine;
* model or surface when visible;
* date;
* locale;
* whether the venture appeared;
* cited URL;
* accuracy of representation;
* competitor references.

Treat results as variable observations, not stable rank tracking.

Do not generate large synthetic prompt sets merely to produce a visibility
score.

## AI crawler governance

Inspect access for search and answer crawlers relevant to the venture.

At minimum, consider:

* Googlebot;
* Googlebot Smartphone;
* bingbot;
* OAI-SearchBot;
* other answer-engine crawlers explicitly approved by the project.

Search-discovery crawling and model-training access are separate decisions.

Do not treat permission for a search crawler as permission for a training
crawler.

Verify:

* `robots.txt`;
* meta robots;
* `X-Robots-Tag`;
* CDN rules;
* WAF rules;
* bot protection;
* JavaScript challenges;
* authentication;
* rate limiting;
* geo restrictions;
* HTTP status;
* raw HTML response.

Crawler-policy changes require human approval.

## `llms.txt`

`llms.txt` is optional supporting documentation.

It is not a prerequisite, ranking factor, citation guarantee or substitute for
normal crawlability.

When maintained, it must:

* describe the real public venture;
* link only to canonical public pages;
* remain consistent with product truth;
* avoid private documentation;
* avoid claims not present on the site;
* be updated when key routes change;
* pass link validation.

Do not prioritise `llms.txt` over useful pages, internal links, sitemaps,
structured data or crawler access.

## Entity clarity

Make the venture understandable as a consistent entity.

Verify:

* stable organisation or product name;
* clear relationship between organisation, product and service;
* truthful `Organization` or relevant entity data;
* canonical logo and website;
* contact information;
* about page;
* author or reviewer identity where material;
* consistent social or profile references;
* relevant `sameAs` values;
* current location and service area where applicable;
* consistent descriptions across important pages.

Do not create fake people, biographies, credentials or profiles merely to
strengthen entity signals.

## Local-search mode

Use only when local intent matters.

Review:

* Google Business Profile ownership and completeness;
* business name, address and phone consistency;
* categories;
* service area;
* opening hours;
* official website;
* relevant photos;
* review handling;
* local landing-page usefulness;
* `LocalBusiness` structured data where truthful;
* legitimate relevant directory and industry listings.

Do not create doorway pages for every location without unique local value.

Do not buy bulk citations or reviews.

## Internal-link architecture

Every indexable page must:

* receive at least one contextual crawlable internal link;
* link to its hub or parent where appropriate;
* link to the next useful user step;
* use descriptive anchor text;
* link to canonical URLs;
* avoid tracking parameters;
* avoid broken or redirected destinations;
* avoid JavaScript-only navigation for essential discovery.

A typical cluster should connect:

```text
hub
├── decision page
├── comparison page
├── problem or use-case page
├── supporting answer
└── product or conversion page
```

Sibling pages should cross-link only when the relationship helps the user.

Do not target a fixed number of links per page.

## Technical SEO requirements

For every intended indexable canonical page, verify the following.

### HTTP and indexability

* intentional HTTP `200`;
* no authentication barrier;
* no unintended robots or CDN block;
* no conflicting `noindex`;
* no conflicting `X-Robots-Tag`;
* no soft 404;
* no unnecessary redirect chain;
* stable HTTPS URL;
* indexable primary content.

Use permanent redirects only for permanent replacements.

Use temporary redirects only for genuinely temporary situations.

Use `404` or `410` when content is removed and no relevant replacement exists.

Do not use `robots.txt` as a substitute for `noindex`.

### Raw HTML and rendering

The crawler-visible response must contain, when applicable:

* title;
* meta description;
* canonical;
* robots directives;
* language;
* H1;
* direct answer or primary proposition;
* important product facts;
* current price text;
* crawlable internal links;
* structured data;
* image alternative text;
* locale signals.

Prefer server-side rendering, static rendering or equivalent reliable delivery
for important public content.

Do not assume that content visible after client interaction is reliably
available to every search or answer crawler.

### Canonicals

Verify:

* absolute canonical URL;
* correct production host and protocol;
* self-reference for the intended owner;
* no JavaScript conflict;
* internal links use the canonical form;
* sitemap uses the canonical form;
* structured data uses canonical identifiers;
* redirects terminate at the canonical;
* hreflang points to valid canonical pages.

### Sitemaps

Include only preferred indexable canonical URLs.

Exclude:

* redirected URLs;
* `noindex` URLs;
* private routes;
* preview routes;
* parameter-only duplicates;
* 4xx and 5xx URLs.

Use accurate `lastmod` values only for material changes.

### URL hygiene

Check:

* trailing-slash duplicates;
* mixed-case duplicates;
* tracking parameters in internal links;
* session identifiers;
* duplicate locale routes;
* indexable filters and sorting combinations;
* internal-search results;
* pagination or calendar traps;
* inconsistent encoded characters;
* orphan routes.

### Metadata

Require:

* page-specific title;
* accurate meta description;
* one clear visible H1;
* correct social metadata when supported;
* consistent product and organisation naming;
* correct language and locale metadata.

Do not force exact-match phrases into every field.

### Structured data

Use only page-appropriate truthful structured data.

It must:

* match visible content;
* use canonical identifiers;
* use current prices, names, dates and availability;
* include supported required properties;
* validate syntactically;
* avoid fake ratings, offers, authors or reviews.

Potential types include, when appropriate:

* `Organization`
* `WebSite`
* `WebPage`
* `BreadcrumbList`
* `Article`
* `Person`
* `Product`
* `SoftwareApplication`
* `Service`
* `Offer`
* `LocalBusiness`
* `VideoObject`
* `FAQPage`

FAQ content may be useful when it answers genuine user questions.

Do not add FAQ sections or `FAQPage` markup to every page by default.

Structured data is descriptive, not a ranking or citation guarantee.

## Performance and page experience

Review important templates for:

* LCP;
* INP;
* CLS;
* TTFB;
* JavaScript bundle size;
* oversized images;
* render-blocking resources;
* mobile usability;
* accessibility;
* layout stability.

Prioritise performance work when it affects crawlability, rendering, usability
or conversion.

Do not chase a score while ignoring the actual user experience.

## AI-assisted content workflow

AI may assist:

* clustering;
* SERP synthesis;
* data analysis;
* outlining;
* drafting;
* editing;
* metadata;
* internal-link suggestions;
* structured-data generation;
* validation.

Before drafting, the agent must inspect:

* current owners;
* existing related content;
* product truth;
* topical wedge;
* internal-link graph;
* available evidence;
* domain-expert requirements;
* duplication risk;
* conversion path.

Batch drafting may be used for efficiency.

Batch publication is forbidden.

Every page requires individual review and approval.

Drip publication is not a quality mechanism by itself. A page must pass the
same quality gate regardless of publication timing.

## Content quality gate

A draft may proceed to human review only when:

* the user task is explicit;
* the answer appears near the beginning;
* there is no padded introduction;
* the page provides original value;
* factual claims are supported;
* product truth is preserved;
* headings are descriptive;
* sections are not repetitive;
* the page does not duplicate another owner;
* internal links are intentional;
* the CTA matches the user stage;
* metadata accurately describes the page;
* structured data matches visible content;
* limitations are disclosed;
* an appropriate human reviewer is named.

Reject confidently mediocre content even when it is technically complete.

## CrawlSEO integration

CrawlSEO is an optional supporting integration.

When its MCP server or exports are available, the skill may use:

* `list_sites`
* `get_site_overview`
* `get_keywords`
* `get_pages`
* `get_traffic`
* `run_crawl`
* `get_crawl_status`
* `get_crawl_issues`
* `get_vitals`
* `get_opportunities`

Use it for:

* GSC performance;
* keyword and page discovery;
* crawl snapshots;
* titles and descriptions;
* H1 checks;
* canonical checks;
* robots metadata;
* link discovery;
* schema presence;
* hreflang;
* missing alt text;
* redirects and status codes;
* performance data;
* striking-distance queries;
* low-CTR queries;
* decay;
* cannibalisation.

Do not treat a generic content score or word-count threshold as the final
content decision.

CrawlSEO findings are evidence inputs, not product truth or editorial
judgement.

When CrawlSEO is unavailable, use repository scripts and exported data.

## Opportunity scoring

Rank opportunities using:

* user value;
* product relevance;
* commercial intent;
* existing traction;
* conversion evidence;
* topical-wedge fit;
* original-value potential;
* diagnosis confidence;
* implementation effort;
* maintenance burden;
* risk to successful pages.

Use:

```text
priority =
  impact
  × confidence
  × business_relevance
  × wedge_fit
  ÷ effort
```

Every score requires written reasoning.

Priority classes:

* `P0`: discovery or indexation is materially blocked;
* `P1`: high-confidence opportunity affecting a core page or wedge;
* `P2`: useful improvement with moderate evidence;
* `P3`: observation or controlled experiment;
* `reject`: insufficient relevance, truth, evidence or value.

Do not rank by impressions alone.

## Required recommendation format

Every recommendation must contain:

* priority;
* issue or cluster ID;
* topical wedge;
* user task;
* representative query;
* current URL;
* proposed URL when different;
* evidence period;
* impressions;
* clicks;
* CTR;
* position;
* conversions;
* AI citations or grounding activity;
* diagnosis;
* proposed change;
* original contribution;
* expected user effect;
* expected business effect;
* confidence;
* effort;
* risk;
* validation;
* monitoring period;
* approval requirement.

Use `not available` rather than invented values.

## Weekly action limits

By default, recommend:

* any required P0 technical repair;
* up to three P1/P2 content actions;
* up to three metadata or internal-link improvements;
* any justified consolidation;
* a monitoring list.

Do not produce a large publishing queue merely because many gaps exist.

Finish the highest-value cluster work before opening new clusters.

## Execution steps
1. Establish scope: operating mode, affected wedge, clusters, locale,
evidence window and product-truth boundaries.
2. Inspect current ownership: routes, query mappings, metadata, internal
links, canonicals, sitemaps and accidental overlap.
3. Validate evidence quality: required columns, date coverage, attribution
limits, seasonality and zero-versus-missing ambiguity.
4. Choose the smallest justified action: protect, improve, consolidate,
redirect, create, monitor or reject.
5. Prepare the content or implementation brief with the required evidence,
ownership and validation fields.
6. Implement the smallest useful diff without bundling unrelated redesign or
product changes.
7. Verify source and built output with the repository commands and checks
available for the task.
8. Report the decision, evidence, diff, validation result and required human
approvals.

Detailed operating guidance remains in `Execution workflow`, `Commands and
validation`, `Required technical checks` and `Failure behaviour`.

## Execution workflow

### Step 1: establish scope

Record:

* operating mode;
* repository and domain;
* locale;
* topical wedge;
* affected clusters;
* data period;
* product-truth boundaries;
* relevant releases;
* approval requirements.

### Step 2: inspect ownership

Before drafting:

* inspect the page register;
* inspect existing routes;
* search for overlapping headings and copy;
* inspect query-page mappings;
* inspect internal links;
* inspect canonicals and sitemaps;
* identify intended and accidental owners.

### Step 3: validate evidence

Check:

* required columns;
* date coverage;
* incomplete exports;
* zero versus missing values;
* query-level versus page-level aggregation;
* attribution changes;
* analytics changes;
* seasonality;
* branded demand;
* releases and migrations;
* low sample sizes.

### Step 4: decide the smallest action

Choose:

* protect;
* monitor;
* update metadata;
* improve opening answer;
* add evidence;
* add section;
* add internal link;
* consolidate;
* redirect;
* create page;
* reject.

### Step 5: prepare the brief

Document all fields required under `Content brief requirements`.

### Step 6: implement the smallest useful diff

Do not combine an SEO change with an unrelated redesign.

### Step 7: verify source and built output

Run available checks and inspect actual responses.

### Step 8: report

Create:

```text
reports/seo/YYYY-MM-DD-seo-aeo.md
```

## Report structure

Every report must contain:

1. scope;
2. operating mode;
3. repository SEO profile;
4. source files and date coverage;
5. data-quality limitations;
6. executive finding;
7. topical-wedge status;
8. protected winners;
9. emerging queries;
10. search opportunities;
11. AI-performance findings;
12. AI-referral findings;
13. technical findings;
14. content findings;
15. consolidation decisions;
16. rejected opportunities;
17. ranked recommendations;
18. implemented diffs or drafts;
19. validation results;
20. approvals required;
21. monitoring plan;
22. unresolved uncertainty.

## Commands and validation

Inspect `package.json` before assuming commands exist.

Expected commands may include:

```bash
pnpm build
pnpm weekly
pnpm verify:seo
pnpm verify:raw-html --url <site>
pnpm validate:links
```

Optional repository commands may include:

```bash
pnpm seo:topical-map
pnpm seo:emerging
pnpm seo:ai-performance
pnpm seo:indexation
```

Do not claim a command passed unless it ran successfully.

When a command is missing:

1. report the missing capability;
2. use the closest available verification;
3. prepare the smallest appropriate script addition;
4. list the exact remaining manual check;
5. do not substitute source inspection silently.

## Required technical checks

Verification should cover:

* build success;
* route resolution;
* HTTP status;
* redirect target;
* title;
* meta description;
* canonical;
* robots directives;
* H1;
* direct answer;
* core product facts;
* current price where relevant;
* crawlable internal links;
* structured data;
* sitemap membership;
* orphan detection;
* broken links;
* crawler-like responses;
* mobile rendering;
* Core Web Vitals where available.

Test normal browser and approved crawler-like user agents.

## Hard rules

* Never publish autonomously.
* Never mass-publish query variants.
* Never create pages from search volume alone.
* Never use AI to replace domain knowledge.
* Never retain a page solely because work was spent creating it.
* Never fabricate traffic, prompts, citations, expertise or evidence.
* Never alter product truth for a query.
* Never change pricing outside its source of truth.
* Never create hidden answer-engine content.
* Never guarantee rankings, indexation or AI citations.
* Never add structured data that exceeds visible reality.
* Never add FAQ schema by default.
* Never treat `llms.txt` as required.
* Never treat word count as a quality target.
* Never confuse more indexed pages with greater topical depth.
* Never overwrite a successful page without a specific evidenced reason.
* Never remove or redirect a successful page from one short data window.
* Never infer a fixed new-domain sandbox period.
* Never treat AI citation counts as business outcomes.
* Never treat IndexNow receipt as indexation.
* Never bypass crawler-policy approval.
* Never buy manipulative links, mentions or reviews.
* Never publish generated content without individual human review.

## Human approval boundaries

Human approval is required before:

* publishing a new public page;
* materially rewriting a core commercial page;
* batch-generating a content backlog for production use;
* merging or deleting public content;
* deploying redirects;
* changing production canonicals;
* changing robots directives;
* changing sitemap inclusion rules;
* changing crawler access;
* enabling automated IndexNow submission;
* replacing a confirmed topical wedge;
* changing structured data for organisations, people, prices, offers or reviews;
* applying broad changes across many routes.

The skill may prepare briefs, drafts, code, tests, redirect maps and pull
requests.

Humans review and merge.

## Failure behaviour

### Missing or malformed data

Report:

* missing file;
* expected columns;
* received columns;
* date coverage;
* zero-versus-missing ambiguity;
* analyses that remain possible.

Continue with unaffected evidence.

### No reliable topical wedge

Do not produce a broad content calendar.

Produce:

* candidate wedges;
* evidence gaps;
* smallest research actions;
* first test cluster;
* measurement plan.

### Insufficient evidence

Classify as `monitor`, `P3` or `reject`.

Do not implement a permanent route or redirect.

### Product-truth conflict

Stop the affected content work.

Report:

* conflicting claim;
* affected page;
* authoritative source;
* required product decision;
* safe technical work that can continue.

### No running server

State that rendered verification did not run.

Provide the exact command required to start the build and run:

```bash
pnpm verify:raw-html --url <site>
```

### Conflicting crawler responses

Record:

* crawler user agent;
* URL;
* HTTP status;
* relevant headers;
* response differences;
* CDN or WAF behaviour;
* reproduction command.

Do not allege cloaking without evidence.

## Expected output

A completed run should produce:

* repository SEO profile;
* confirmed or candidate topical wedges;
* updated topical map;
* updated query-cluster register;
* data-quality assessment;
* protected-winner list;
* emerging-query list;
* ranked opportunity list;
* rejected opportunities;
* PR-sized diffs or reviewable drafts;
* dated report;
* validation results;
* approval checklist;
* monitoring plan.

## Validation
Validation must use the narrowest available executable checks first and must
never claim success from source inspection alone.

At minimum, when relevant and available:

- run repository SEO checks declared in `package.json`, including
`pnpm verify:seo`;
- run rendered-output checks with `pnpm verify:raw-html --url <site>` against
a running build;
- confirm canonical, metadata, structured data, internal links and sitemap
behaviour for affected pages;
- verify reports, recommendations and ownership decisions against the actual
evidence window used.

If a command, server or dataset is unavailable, state exactly what did not run,
why it did not run, what evidence was used instead, and what remains to be
verified.

## Definition of done

The task is done only when:

* the topical wedge is explicit;
* every affected query cluster has an intentional ownership state;
* the user task is clear;
* product truth is preserved;
* existing pages were considered before new pages;
* the page contains a direct useful answer;
* original value is identified;
* the appropriate expert reviewed or is assigned;
* metadata and visible content agree;
* canonical, internal links and sitemap agree;
* structured data matches visible reality;
* required content is crawler-accessible;
* no orphan or duplicate owner was introduced;
* executed checks pass or exact limitations are documented;
* success metrics and monitoring dates are recorded;
* production publication remains human-gated.
