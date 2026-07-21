# Bootstrap blockers

Application code may not be written while any item below is incoherent or
missing. "Coherent" means: stated, consistent with the other items, and
either evidenced or explicitly labeled an assumption.

| #   | Item                                           | Where it must live                                         |
| --- | ---------------------------------------------- | ---------------------------------------------------------- |
| 1   | ICP (specific, narrowed)                       | docs/business/ICP.md, config/offer.yaml                    |
| 2   | Pain (urgent, evidenced or labeled)            | docs/business/OFFER.md                                     |
| 3   | Measurable customer outcome                    | docs/business/OFFER.md                                     |
| 4   | Offer sentence (required structure)            | docs/business/OFFER.md, config/offer.yaml                  |
| 5   | First useful result + time to it               | docs/business/OFFER.md (day-one win)                       |
| 6   | Pricing hypothesis                             | docs/business/PRICING.md, config/offer.yaml                |
| 7   | Thirty-day cash hypothesis (calculator output) | docs/business/ECONOMICS.md                                 |
| 8   | Validation event taxonomy coverage             | docs/product/USER_JOURNEYS.md ↔ config/analytics.yaml      |
| 9   | Analytics architecture confirmed (3 layers)    | docs/engineering/ANALYTICS.md                              |
| 10  | Consent mode chosen                            | config/analytics.yaml, docs/legal/ANALYTICS_AND_CONSENT.md |
| 11  | ≥1 pricing experiment hypothesis (draft)       | config/experiments.yaml                                    |
| 12  | Product-truth boundaries (what may be claimed) | docs/product/PRODUCT_TRUTH.md                              |
| 13  | Active plan                                    | docs/plans/active/                                         |

Common failures to check for explicitly: contradictions between brief and
economics; unpriced concierge labour; "everyone" ICPs; outcomes that
cannot be measured; missing qualification criteria; launch infrastructure
assumed but not planned (domain, Vercel, Neon, GA4, GSC, Bing).
