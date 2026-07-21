# data/analytics/inbox/

Analytics exports for weekly analysis:

| File               | Columns            | Source                                                 |
| ------------------ | ------------------ | ------------------------------------------------------ |
| `ai-referrers.csv` | referrer, sessions | GA4 exploration filtered to AI/answer-engine referrers |
| `neon-*.csv`       | per-export         | SQL exports from the venture's Neon evidence tables    |

Working inbox — venture-confidential. Real exports must not be committed
to a public repository (`pnpm release:check` enforces this).
