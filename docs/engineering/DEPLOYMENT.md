# DEPLOYMENT

The template deploys nothing. Every venture deploys itself, independently.
Deploying to production is a human-gated action.

## Per-venture launch checklist

Mirrors `config/venture.yaml` (infrastructure block); flip booleans only
after human verification.

1. **Domain** — registered, DNS at the venture's own registrar/provider.
2. **Vercel** — its own Vercel project linked to the venture repo;
   production domain attached; environment variables set via `vercel env`
   (never copied from another venture).
3. **Neon** — its own Neon project; `DATABASE_URL` in Vercel env; schema
   from [BACKEND.md](BACKEND.md) applied; preview branches optional.
4. **GA4** — its own property + web data stream;
   `NEXT_PUBLIC_GA_MEASUREMENT_ID` set; advertising features off;
   retention 14 months.
5. **Vercel Web Analytics** — enabled on the project if used; consent mode
   per `config/analytics.yaml`.
6. **Google Search Console** — domain property verified; sitemap submitted.
7. **Bing Webmaster Tools** — site verified (GSC import is acceptable);
   sitemap submitted.
8. **Smoke test** — `pnpm verify:raw-html --url https://<domain>` passes
   for all three user agents; consent banner appears; a test submission
   reaches Neon; no GA request observed before opt-in.

## Environments

| Env         | Analytics        | Evidence store         | Robots  |
| ----------- | ---------------- | ---------------------- | ------- |
| development | console log only | JSONL fallback allowed | n/a     |
| preview     | disabled         | Neon branch optional   | noindex |
| production  | per consent      | Neon required          | index   |

## Rollbacks

Vercel instant rollback is acceptable for the validation site. Evidence
tables are append-only; a rollback never deletes evidence.
