# Synthetic founder Golden Path

- Status: PROTOTYPE — provider-URL root fixture verified; final-source suite pending
- Fixture: `synthetic-founder-golden-path`
- Prior isolated three-slice verification: 2026-08-12
- Current provider-URL root verification: passed locally 2026-08-23
- External effects: none

## Purpose

Prove the founder release through one realistic web SaaS without creating a
customer resource. The test must use the public root CLI and the same child
launch service, graph, provider plans/transports, migrations, seed runtime,
report renderer and upgrade engine as a founder launch.

This is not a second demo implementation. Every external boundary is replaced
below the production adapter/transport interface and remains visibly synthetic.

## Input

[Exception Desk](../../fixtures/ideas/synthetic-founder-web.md) is a private web
SaaS for small service businesses reconciling recurring work and invoice drafts.
It requests:

- `agentic-web-saas@0.2.0` with no recursive service runtime;
- one exact EUR 24.50 monthly Stripe test price;
- GitHub, Vercel, Neon and Stripe for the initial provider-URL graph;
- Brevo, Google, Bing and a custom domain as deferred nonblocking follow-up;
- one journey ending in `invoice_draft_confirmed`;
- labeled sample rows and no customer data;
- the fixture-only [founder-default connection](../../fixtures/founder-stack/founder-default.json).

Production use of that in-memory Stack is rejected. The fixture runner enables
it only through an explicit test-only option.

## Reproduce

```bash
pnpm exec vitest run --no-file-parallelism \
  tests/founder-golden-path-product.test.ts \
  tests/founder-golden-path-runtime.test.ts \
  tests/founder-golden-path.test.ts --reporter=verbose
```

A prior source state passed all three tests across the three files. The current
provider-URL root slice passed locally on 2026-08-23. A full run against the
final committed source and hosted CI remain pending; those pending checks are
not a release pass.

The standalone fixture runner is also reproducible with an empty output path:

```bash
node --import tsx scripts/run-synthetic-venture-launch.mts \
  --output /tmp/vh-founder-golden-path \
  --json
```

The provider-URL root fixture returns `status: verified_fixture`,
`workflowStatus: succeeded`, and `launchReport.overallState: succeeded`. It
creates an isolated root and invokes these public root CLI shapes:

```bash
vh stack create founder-default --file founder-default.json --json
vh stack doctor founder-default --json
vh launch --idea ./idea.md --stack founder-default --production --dry-run --non-interactive --output ventures/exception-desk --json
vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive --output ventures/exception-desk --json
```

The first apply succeeds on the fixture-verified stable Vercel provider URL.
Custom-domain DNS, Brevo, Google and Bing remain deferred and do not block that
initial launch. Replaying the exact apply command must return the same run and
Grant without another provider or product invocation. Missing-provider-auth
waiting and same-run resume remain a separate Golden Path variant rather than an
artificial pause in this happy path.

## Required proof

| Stage                     | Assertion                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack                     | Create and doctor run through root `vh`; doctor is ready, read-only and reports provider resources as not checked                                                                                                                            |
| Idea and grant            | Compiler uses the exact fixture source; dry run proposes but does not issue a grant or create the child; apply issues the content-bound grant                                                                                                |
| Child                     | Local staging becomes `ventures/exception-desk`; ordinary Next.js child contains no recursive runtime or `@venture-harness/*` runtime dependency                                                                                             |
| Product/design            | Bounded product work produces the Exception Desk thesis, venture tokens, responsive composition, visible focus/reduced motion, labeled samples and direct journey                                                                            |
| Initial providers         | Registered GitHub, Neon, Stripe and Vercel declarative adapters cross real `CommandProviderTransport` and `HttpProviderTransport` classes and retain sanitized fixture evidence                                                              |
| Deferred providers/domain | Brevo, Google, Bing and custom-domain DNS are absent from the initial graph and remain visible as nonblocking follow-up; they produce no transport invocation in this run                                                                    |
| Source                    | GitHub command plan creates a local bare remote; child and remote `main` commit/tree are read back and match                                                                                                                                 |
| Database                  | The Neon plan runs `psql` from the child, applies the versioned SQL migration and exercises read-back                                                                                                                                        |
| Commerce                  | Stripe test resources cross the fixture HTTP transport and emit sanitized evidence; no charge occurs                                                                                                                                         |
| Hosting                   | Vercel captures the required environment bindings, returns a fixture-labeled stable provider URL and does not claim a custom domain                                                                                                          |
| Journey/report            | `invoice_draft_confirmed` direct tests pass; final JSON/Markdown report says succeeded, while the local Launch Receipt retains deferred custom-domain work and the synthetic limitation                                                      |
| Replay                    | Repeating the exact apply command returns the same run and Grant; the settled provider ledger and product invocation counts do not change                                                                                                    |
| Blocking resume           | A separate Golden Path variant persists missing GitHub auth as `waiting_for_auth` before that provider effect, preserves independently completed work, and resumes the same child, run and immutable Grant through the exact founder command |
| Upgrade                   | Dry run plans Core 0.2.1; apply adds a Core marker, updates the v2 lock and preserves the asserted venture-owned paths byte-for-byte                                                                                                         |
| Secrets                   | Fixture credential values, connection URI, webhook secret and measurement ID do not appear in durable child text                                                                                                                             |

## Production code and fixture boundary

Used without a parallel fake implementation:

- `scripts/vh-bundle.ts` and `lib/cli/` root/child command flow;
- `lib/founder-launch/` idea, Stack, doctor, dry-run preparation and Launch
  Grant binding;
- `lib/materialization/` seed/materializer and `lib/workflow/` execution/resume;
- built-in provider plan factories, declarative adapters, official command/HTTP
  transport classes, writable credential capture and durable idempotency;
- real local Git/`psql` command shapes and versioned migration paths;
- launch report rendering and the Core upgrade engine.

Synthetic by design:

- all credentials and external provider responses;
- the bare Git remote, Stripe HTTP service, Vercel URL and DNS resolvers;
- product-generation host outputs and deployed-browser command result;
- sample user/data, analytics/search/email results and Core 0.2.1 release.

No network provider, public DNS resolver, email recipient, payment customer,
advertising account or market user is contacted. A green result is
fixture-level evidence only.

## Evidence sources

- `tests/founder-golden-path.test.ts`
- `tests/founder-golden-path-product.test.ts`
- `tests/founder-golden-path-runtime.test.ts`
- `tests/fixtures/synthetic-founder-golden-path.ts`
- `tests/fixtures/founder-golden-path-product.ts`
- `tests/fixtures/founder-golden-path-runtime.ts`
- `tests/cli-launch-integration.test.ts`
- `tests/materialization-web-build.test.ts`
- `scripts/run-synthetic-venture-launch.mts`

Fixture verification is the public ceiling for this proof. Do not change any
provider claim to live without a separately authorized, sanitized
account/resource read-back.
