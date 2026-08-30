# Open-source readiness

Venture Harness v0.2 is a public founder alpha: an open-source, agent-first SaaS
Launch Factory operated from the founder's machine and provider accounts. It is
not a hosted SaaS, a stable public release, or proof of a live founder launch.
PR #9 was squash-merged on 2026-08-25, its required checks passed, and the
protected `main` branch at `770f4bd` passed the hosted quality workflow on
2026-08-26. The post-merge dogfood continuation still requires its own final
local/CI checks and live provider read-back.

## Public product contract

The repository now has one default story:

```text
connect founder-default once
  -> write idea.md
  -> inspect complete production dry run
  -> issue one Launch-Grant-backed command
  -> independent child repository and app
  -> authorized provider work and read-backs
  -> honest report, waiting action, and later Core upgrade
```

Public entry points:

- [README](../../README.md): positioning, quick command, architecture, provider
  and status matrices, ownership, upgrade and troubleshooting;
- [Founder quickstart](FOUNDER_QUICKSTART.md): exact idea, auth, Stack, doctor,
  dry-run, apply and agent-prompt flow;
- [Synthetic Golden Path](SYNTHETIC_GOLDEN_PATH.md): exact root-CLI fixture,
  lifecycle assertions and non-live boundary;
- [Feature Status](../product/FEATURE_STATUS.md): verified, fixture verified,
  experimental, external-verification-required and planned surfaces;
- [Product Truth](../product/PRODUCT_TRUTH.md): evidence-bound public claim
  register;
- [Roadmap](../product/ROADMAP.md): dogfood gate and non-blocking optional work;
- [Ownership/offboarding](../operations/OFFBOARDING.md): founder custody and
  delegated-customer exit boundaries.

## Repository contracts

- `LICENSE`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, and
  `SECURITY.md` define use, participation, decisions, and private reporting.
- Issue and pull-request templates ask for reproducible evidence and unknowns.
- Third-party Actions are pinned to immutable commit SHAs.
- CodeQL, dependency review, Dependabot, Gitleaks, `pnpm audit`, and the local
  public-release checker are configured.
- Credential-shaped fixtures require exact fingerprints; there is no broad test
  or fixture exemption.
- The public Stack example contains references and placeholder metadata only;
  the production CLI rejects the committed in-memory fixture Stack.

These files are configuration intent. They do not prove that GitHub settings,
CI, provider accounts, or a release are live.

## Evidence required for the post-merge founder alpha

- Frozen install, workspace validation/build/package/export checks and packed
  CLI invocation.
- SDK clean install, MCP startup, agent-skill sync/parity, schemas and
  migrations.
- Unit/integration/provider/graph/upgrade/security/privacy/claim checks.
- Rerun the definitive founder Golden Path through the public root CLI and
  child graph after the continuation source settles. Prior local and hosted
  passes remain evidence for their exact SHAs, not for later edits.
- Standalone web production build, raw HTML, desktop/mobile journey,
  accessibility and venture-owned-file upgrade survival.
- `vh doctor`, `vh auth status`, `vh stack doctor founder-default`, and one
  complete real local production dry run as far as available credentials allow.
- `vh verify fast`, `vh verify mvp`, `vh verify release`, compatibility
  `pnpm verify`, secret/dependency scans, and a clean tree.

A skipped live-provider check is incomplete evidence, not a pass. Its record
must name the missing credential/environment, exact command, expected read-back
and limitation.

## Current local prototype evidence

- Launch Contract schema/projection, bounded idea sharpening, compact
  capability-scoped build context and conservative local Launch Receipt have
  focused local tests.
- The focused ordinary web seed completed two separate clean child closures:
  offline frozen install, typecheck, production build, zero-retry Chromium
  journey and child test, with no model or provider call.
- Fixture source publication and read-back install or verify a normal clean
  child Git repository at the exact origin, branch and commit while keeping
  private runtime/report paths untracked.

These are `PROTOTYPE` boundaries. No real dogfood, live provider read-back or
comparable model benchmark has completed, and no token or cost saving is
claimed.

## External settings requiring read-back

Before tagging or publishing a package, confirm through GitHub:

- private vulnerability reporting;
- secret scanning and push protection;
- Dependabot alerts and security updates;
- branch rules requiring quality, security, CodeQL and dependency review;
- least-privilege workflow permissions and protected release environments;
- repository ownership, topics, description, visibility/template status and
  maintainer access.

Record screenshots or API/CLI read-back outside the public repository when they
contain private account data. A YAML workflow is not evidence that a hosted run
succeeded.

This repository previously shipped a source-bound final-evidence workflow that
verified one specific release pull request against a hardcoded repository,
branch, reviewer and pull-request number. It was removed: a fork cannot use a
verifier that asserts facts about somebody else's repository. Record release
evidence for your own fork with the capability-aware quality profiles
(`pnpm verify:mvp && pnpm verify:release`) and your own provider read-back.

## Dogfood before stable

Keep `main` labeled founder alpha and do not tag a public stable release until
one narrow founder-owned web venture has:

- a complete non-fixture Stack doctor;
- an independent GitHub repository and expected source commit;
- a reachable stable Vercel production URL;
- Neon migration/health and Stripe test-resource read-backs;
- the primary journey and final report;
- precise waiting states for any unresolved Brevo/search/domain action;
- a reviewed Core upgrade dry run that preserves venture-owned work.

The first dogfood launch can still reveal a genuine blocker. Do not rewrite
public claims around it; record it, fix the implementation, and rerun.

## Release evidence

Use [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md). The mechanical
check scans the complete local workspace and package contents; CI adds history,
dependency and CodeQL evidence. A maintainer must still review confidentiality,
legal/privacy text, public claims, security gaps, executable behavior, package
contents and the exact tag diff.
