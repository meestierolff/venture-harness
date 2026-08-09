# Open-source readiness

Venture Harness v0.2 is being prepared as a founder alpha: an open-source,
agent-native app launch factory operated from the founder's machine and
provider accounts. It is not a hosted SaaS, a stable public release, or proof of
a live founder launch. A prior source state completed its founder web Golden
Path fixture through the public root CLI; the current final-tree refresh remains
pending in socket-capable CI.

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

## Evidence required before the draft PR is reviewable

- Frozen install, workspace validation/build/package/export checks and packed
  CLI invocation.
- SDK clean install, MCP startup, agent-skill sync/parity, schemas and
  migrations.
- Unit/integration/provider/graph/upgrade/security/privacy/claim checks.
- Rerun the definitive founder Golden Path through the public root CLI and
  child graph. The prior 2026-08-09 source-state fixture passed all three
  slices; on the current final tree, product/runtime pass and the root slice
  reached the standalone child server check before this local sandbox denied
  loopback listening with `EPERM`.
- Standalone web production build, raw HTML, desktop/mobile journey,
  accessibility and venture-owned-file upgrade survival.
- `vh doctor`, `vh auth status`, `vh stack doctor founder-default`, and one
  complete real local production dry run as far as available credentials allow.
- `vh verify fast`, `vh verify mvp`, `vh verify release`, compatibility
  `pnpm verify`, secret/dependency scans, and a clean tree.

A skipped live-provider check is incomplete evidence, not a pass. Its record
must name the missing credential/environment, exact command, expected read-back
and limitation.

## External settings requiring read-back

Before making the repository public, tagging, or publishing a package, confirm
through GitHub:

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

## Dogfood before stable

The branch may become a draft alpha PR after local/CI gates pass. Do not tag a
public stable release until one narrow founder-owned web venture has:

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
