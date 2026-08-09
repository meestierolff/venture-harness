# Provider capability and verification matrix

- Reviewed: 2026-08-09
- Configuration source: `config/providers.yaml`
- Evidence ceiling: local plans, mocks, fixtures, and tests

Every provider credential/account is currently `unconfigured` in the checked-in
config. The table records local contract coverage and the exact remote evidence
still required; it does not claim authenticated connectivity or provisioned
state. A registered implementation is not a configured credential, enabled
provider effect, or live verification.

| Provider          | Supported local shape                                                                                                           | Local evidence                                                                                                                           | Checked-in state       | Live verification still required                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub            | CLI/scoped token; source-repository plan and read-back                                                                          | `tests/providers-contract.test.ts`, `tests/providers-github-source.test.ts`                                                              | `unconfigured`         | authenticated account/repository/branch read-back and authorized source publication                                                      |
| Vercel            | CLI/scoped token; project, env, deploy, domain, analytics plans                                                                 | `tests/providers-contract.test.ts`, `tests/providers-execution.test.ts`                                                                  | `unconfigured`         | project/deployment/domain read-back in the selected team and environment                                                                 |
| Neon              | API/CLI credential plus generated database credential target; migration/read-write plan                                         | `tests/providers-neon.test.ts`                                                                                                           | `unconfigured`         | project/branch/database/role, migration schema, and read-write health read-back                                                          |
| Stripe            | restricted key; product, price, webhook, and portal HTTP plans                                                                  | `tests/providers-contract.test.ts`, `tests/providers-execution.test.ts`                                                                  | `unconfigured`         | test/live mode, product/price/webhook/portal read-back, then separately authorized test checkout                                         |
| RevenueCat        | restricted secret after manual project bootstrap; app, entitlement, offering, webhook plans; signed fixture ingress and cohorts | `tests/providers-contract.test.ts`, `tests/winner-loop-attribution-cohorts.test.ts`, `tests/winner-loop-live-provider-contracts.test.ts` | `unconfigured`         | project/app/entitlement/offering/webhook read-back, deployed route delivery, signature freshness, and exact subscription-state read-back |
| Brevo             | API key; domain, sender, template, webhook plans                                                                                | `tests/providers-contract.test.ts`, `tests/providers-execution.test.ts`                                                                  | `unconfigured`         | authenticated domain/sender/template/webhook read-back and separately authorized test delivery                                           |
| Google            | OAuth/service account; GA4, site verification, Search Console, sitemap plans                                                    | `tests/providers-contract.test.ts`, `tests/launch-fixtures.test.ts`                                                                      | `unconfigured`         | account/property/scopes, verified site, sitemap, and data-freshness read-back; provider exchange remains unwired                         |
| Bing              | OAuth/API key shape; Webmaster site and sitemap plans                                                                           | `tests/providers-contract.test.ts`, `tests/launch-fixtures.test.ts`                                                                      | `unconfigured`         | account/site/sitemap/scopes and data-freshness read-back                                                                                 |
| DNS               | consolidated manual record-set contract                                                                                         | `tests/launch-fixtures.test.ts`, `tests/cli-default-provider-runtime.test.ts`                                                            | `unconfigured`, manual | authoritative DNS resolution for every exact reviewed record                                                                             |
| MijnDomein        | manual DNS/domain attachment plan                                                                                               | `tests/providers-contract.test.ts`, `tests/launch-fixtures.test.ts`                                                                      | `unconfigured`, manual | registrar/domain state and authoritative DNS read-back                                                                                   |
| App Store Connect | JWT credential reference plus manual prerequisites; build/beta plans                                                            | `tests/providers-contract.test.ts`, `tests/mobile-scaffold.test.ts`                                                                      | `unconfigured`         | app/build/TestFlight group/processing state from App Store Connect; no submission implied                                                |
| EAS               | official CLI session; project/build/submit prerequisites                                                                        | `tests/providers-contract.test.ts`, `tests/mobile-scaffold.test.ts`                                                                      | `unconfigured`         | authenticated account/project, signed build artifact, and downstream processing read-back                                                |

## Stack Profile command plane

| Stack Profile                       | DNS binding | Local implementation state                                                                                     | Packaged-default state  | Live verification still required                                              |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `founder-default@0.2.0`             | MijnDomein  | registered and selectable through doctor/plan/dry-run/apply/read-back/reconcile when the root host is injected | unconfigured; no effect | exact account state, trusted manual evidence, and authoritative DNS read-back |
| `founder-default-generic-dns@0.2.0` | generic DNS | registered as a genuinely different adapter and selectable through the same commands                           | unconfigured; no effect | exact account state, trusted manual evidence, and authoritative DNS read-back |

Local evidence: `tests/provider-stack-profiles.test.ts`,
`tests/stack-profile-command-runtime.test.ts`, and
`tests/command-surfaces-parity.test.ts`. Selection binds exact profile ID/version,
role, provider, capability, and environment. Authorized apply requires durable
atomic request and provider-idempotency claims; fixture memory stores are
rejected for production. Missing manual evidence, forged read-back, and an
ambiguous crash outcome never become verified.

## Cross-cutting blockers

- OAuth state, PKCE, exact redirects, single-use callback validation, and tenant
  binding: `VERIFIED_LOCAL_CONTRACT`; official token exchange, shared encrypted
  transaction storage, and live revocation read-back remain pending.
- General provider HTTP SSRF/DNS-rebinding defense:
  `VERIFIED_LOCAL_CONTRACT`; deployment egress policy and live provider
  read-back remain pending.
- RevenueCat signed-ingress freshness, raw-byte/route binding, size/MIME,
  rotation, and deduplication: `VERIFIED_LOCAL_CONTRACT`; the deployed endpoint
  and official provider authorization/delivery remain pending.
- Launch provider budgets: `VERIFIED_LOCAL_CONTRACT` for aggregate operation
  count and exact-currency cost preflight, deduplicated requests, model
  token/cost ceilings, and fail-closed unknown estimates. No exchange conversion,
  provider billing accuracy, or production charge state is claimed.
- Generic `vh doctor` output does not prove resource-specific read-back.
- No external provider operation was run to produce this matrix.

Provider state may move to `verified` only with a sanitized artifact naming the
provider, account/team, environment, capability, exact identifiers, read-back
time, and limitations. See [provider auth boundaries](../security/PROVIDER_AUTH_BOUNDARIES.md)
and [launch report requirements](../operations/LAUNCH_REPORT.md).
