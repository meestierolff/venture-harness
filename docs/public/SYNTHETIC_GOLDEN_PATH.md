# Synthetic founder Golden Path

- Status: FIXTURE VERIFIED on a prior source state; final-tree refresh pending
- Fixture: `synthetic-founder-golden-path`
- Prior full-suite verification: 2026-08-09
- Current final-tree local rerun: product/runtime pass; root blocked at loopback listen
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
It selects:

- `agentic-web-saas@0.2.0` with no recursive service runtime;
- one exact EUR 24.50 monthly Stripe test price;
- GitHub, Vercel, Neon, Stripe, Brevo, Google, Bing and manual DNS;
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

A prior 2026-08-09 source state passed all three tests across the three files.
On the current final tree, the product and runtime slices pass; the root slice
reached the standalone child server check and was blocked when this local
sandbox denied loopback listening with `EPERM`. A full current-tree refresh
remains pending in socket-capable CI; the pending check is not a pass.

The standalone fixture runner is also reproducible with an empty output path:

```bash
node --import tsx scripts/run-synthetic-venture-launch.mts \
  --output /tmp/vh-founder-golden-path \
  --json
```

A prior standalone run returned `status: verified_fixture`, `workflowStatus:
succeeded`, and `launchReport.overallState: succeeded`. It creates an isolated
root and invokes these public root CLI shapes:

```bash
vh stack create founder-default --file founder-default.json --json
vh stack doctor founder-default --json
vh launch --idea ./idea.md --stack founder-default --production --dry-run --non-interactive --output ventures/exception-desk --json
vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive --output ventures/exception-desk --json
```

The first apply must wait at the exact manual DNS node. The fixture writes typed
record evidence, then invokes the public child command:

```bash
vh resume <run-id> --manual dns-records --evidence reports/launch/<run-id>/manual/dns-records.json --json
```

A second resume must be idempotent: it cannot repeat a provider or product
invocation.

## Required proof

| Stage                    | Assertion                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack                    | Create and doctor run through root `vh`; doctor is ready, read-only and reports provider resources as not checked                                                                                    |
| Idea and grant           | Compiler uses the exact fixture source; dry run proposes but does not issue a grant or create the child; apply issues the content-bound grant                                                        |
| Child                    | Local staging becomes `ventures/exception-desk`; ordinary Next.js child contains no recursive runtime or `@venture-harness/*` runtime dependency                                                     |
| Product/design           | Four bounded product tasks produce 14 venture-owned paths: an Exception Desk thesis, venture tokens, responsive mobile composition, visible focus/reduced motion, labeled samples and direct journey |
| Providers                | Registered declarative adapters execute 60 fixture-backed invocations through real `CommandProviderTransport` and `HttpProviderTransport` classes and retain 19 sanitized provider evidence records  |
| Source                   | GitHub command plan creates a local bare remote; child and remote `main` commit/tree are read back and match                                                                                         |
| Database                 | The Neon plan runs `psql` from the child, applies the versioned SQL migration and exercises read-back                                                                                                |
| Commerce/email/discovery | Stripe test resources, Brevo, Google and Bing plans cross fixture transports and emit sanitized evidence                                                                                             |
| Hosting                  | Vercel plan captures five environment-variable bindings and returns a fixture-labeled stable URL                                                                                                     |
| DNS                      | One consolidated manual record set preserves nameservers/mail records and matches two deterministic resolver results                                                                                 |
| Journey/report           | `invoice_draft_confirmed` direct tests pass; final JSON/Markdown report says succeeded, has no manual action, and retains the synthetic limitation                                                   |
| Replay                   | Durable provider idempotency ledger is settled and resume repeats no transport/build invocation                                                                                                      |
| Upgrade                  | Dry run plans Core 0.2.1; apply adds a Core marker, updates the v2 lock and preserves all 14 venture-owned paths byte-for-byte                                                                       |
| Secrets                  | Fixture credential values, connection URI, webhook secret and measurement ID do not appear in durable child text                                                                                     |

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
- `tests/materialization-web-build.test.ts`
- `scripts/run-synthetic-venture-launch.mts`

Fixture verification is the public ceiling for this proof. Do not change any
provider claim to live without a separately authorized, sanitized
account/resource read-back.
