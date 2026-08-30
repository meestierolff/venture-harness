# PROJECT

- Status: FOUNDER ALPHA — local/fixture web rail; first real launch pending
- Owner: harness maintainers
- Last updated: 2026-08-12

## Purpose

Venture Harness is the open-source Core and local execution harness for turning
one founder idea into an independent application in founder-owned provider
accounts. This repository is not a child venture or a hosted SaaS control plane.

## Current state

The primary v0.2 product is one founder-operated web-app launch rail:

```text
one-time founder-default connection
  -> reviewed Launch Contract -> idea.md (zero model calls)
  -> complete production dry run
  -> immutable Launch Grant
  -> independent ordinary Next.js child
  -> bounded product work through the internally owned Codex CLI host
  -> provider graph, source push, production deployment and primary journey
  -> sanitized report, exact waiting action, and later Core upgrade
```

The exact apply command is shown by the dry run:

```bash
vh launch --idea ./idea.md --stack founder-default --production --apply --non-interactive
```

Founder alpha includes practical Codex CLI hosts for rough-prose sharpening and
the two bounded product-build tasks. The production CLI constructs those hosts
internally, sends credential-free context through stdin, projects only a small
CLI environment, and keeps provider credentials and provider capabilities in a
separate runtime. This is a local prototype boundary, not perfect or audited
OS-level read isolation. A valid Launch Contract still uses the locally tested
zero-model parsing path, and no live dogfood or provider result is claimed yet.

One isolated current-tree run of the complete Exception Desk root-CLI Golden
Path passed on 2026-08-12 outside the loopback-restricted sandbox: idea
compilation, Stack persistence/doctor, Launch Grant binding, materialization,
workflow, provider transports, local source push, standalone web journey,
reporting, replay and upgrade preservation all crossed their labeled synthetic
boundaries. Required repetitions, a source-bound final report, and hosted CI
remain pending, so this is not a release pass. No provider has been live
verified from this template. No founder-owned child repository, external
deployment, DNS record, payment resource, email delivery, indexed site,
customer, sale or scheduled external job is recorded as created.

## Start a child venture

Use the [Founder quickstart](docs/public/FOUNDER_QUICKSTART.md). In outline:

1. Register the exact GitHub, Vercel, Neon, Stripe, RevenueCat, Brevo, Google
   and Bing credential references; use a manual DNS role when no supported
   adapter is installed.
2. Copy and edit the credential-free
   [founder-default example](docs/public/founder-default.example.json).
3. Run `vh stack create founder-default --file <connection.json>` and the
   read-only `vh stack doctor founder-default`.
4. Write and review a complete Launch Contract with the initial user, outcome,
   journey, success signal, rail, capabilities, domain and one exact price when
   using Stripe, or sharpen rough prose through the bounded Codex CLI prototype,
   then review the resulting `idea.md` before continuing.
5. Run:

   ```bash
   vh launch --idea ./idea.md --stack founder-default --production --dry-run --non-interactive
   ```

6. Review exact accounts/resources/effects/blockers, then invoke the apply
   command above. A provider/KYC/DNS boundary may produce one precise waiting
   action; resume the same run rather than treating it as success.
7. If unfinished provider work reaches the Grant or envelope expiry, use only
   the exact same-profile authorization renewal command printed by `vh resume`;
   the renewed run envelope remains bounded by the immutable original Grant.

The older `vh create --brief`, `vh plan`, explicit authorized `vh launch`, run
inspection/resume, data/learning and generated Agent Surface commands remain
available as advanced/compatibility paths. They do not replace or complicate
the public founder command.

## Optional work retained

- Expo/SwiftUI, RevenueCat, EAS and App Store Connect are experimental mobile
  boundaries; public App Store approval does not block the founder web alpha.
- Recursive customer organizations, Connection Hub, Service Blueprints,
  Service/Agent Grants and generated API/CLI/MCP/SDK surfaces are for ventures
  that sell delegated orchestrated services, not ordinary apps.
- Validate-first, DistributionPR, Winner Loop, iOS subscription and advanced
  Fleet operations remain optional. Winner Loop never auto-scales; posting and
  spend require distinct human authority.

## Evidence

- Founder compiler and Stack: [lib/founder-launch/](lib/founder-launch/)
- Canonical root CLI: [lib/cli/](lib/cli/), [scripts/vh-bundle.ts](scripts/vh-bundle.ts)
- Launch routing/graph: [lib/launch/](lib/launch/), [lib/workflow/](lib/workflow/)
- Independent seeds: [lib/materialization/](lib/materialization/), [seeds/](seeds/)
- Provider/credential boundaries: [lib/providers/](lib/providers/),
  [lib/credentials/](lib/credentials/)
- Synthetic proofs: [fixtures/](fixtures/), [tests/](tests/)
- Upgrade contract: [harness.lock](harness.lock), [lib/upgrade/](lib/upgrade/)
- Public evidence ceiling: [docs/product/PRODUCT_TRUTH.md](docs/product/PRODUCT_TRUTH.md)

## Assumptions

- The founder owns every external account and reviews exact destinations before
  issuing the production Launch Grant.
- Credential values stay behind Keychain, 1Password, CI/environment or official
  CLI session references and never enter Git, reports or model context.
- The first dogfood venture is a narrow web SaaS using Stripe test mode and
  manual DNS if necessary.

## Unresolved questions

- Which founder-owned account set and domain will provide the first real Stack
  doctor and provider read-backs?
- Which exact external action, if any, will pause the first dogfood launch?
- Which reviewed Core patch will prove the first real child upgrade?

## Related documents

- [README.md](README.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [Feature Status](docs/product/FEATURE_STATUS.md)
- [Roadmap](docs/product/ROADMAP.md)
- [Founder quickstart](docs/public/FOUNDER_QUICKSTART.md)
- [Ownership and offboarding](docs/operations/OFFBOARDING.md)
