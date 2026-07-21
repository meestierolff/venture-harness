# data/seo/inbox/

Weekly SEO exports land here for `pnpm weekly` and the $seo-aeo-engine
skill. Expected files and columns (CSV, lowercase headers):

| File               | Columns                              | Source                                               |
| ------------------ | ------------------------------------ | ---------------------------------------------------- |
| `gsc-queries.csv`  | query, impressions, clicks, position | Google Search Console → Performance → Queries export |
| `gsc-pages.csv`    | page, impressions, clicks, position  | GSC → Performance → Pages export                     |
| `bing-queries.csv` | query, impressions, clicks           | Bing Webmaster Tools → Search performance export     |

This is a working inbox: files here are venture-confidential market data.
Do not commit real exports to a public repository —
`pnpm release:check` fails if CSVs are tracked here.
