# Feature status

- Status: FOUNDER ALPHA — local and fixture evidence only
- Owner: harness maintainers
- Last updated: 2026-08-12

## Purpose

Show what a founder can rely on in v0.2, what the synthetic Golden Path proves,
and what still needs a real account or production read-back. Product Truth is
the public claims ceiling.

## Status vocabulary

| Label                              | Meaning                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Verified (local)**               | Repository tests or a packed local consumer exercised the implementation without a provider effect.                     |
| **Fixture verified**               | Labeled synthetic data crossed the production-shaped implementation boundary; no customer or provider account was used. |
| **Experimental**                   | Coherent tested work exists, but it is outside the default founder web rail or lacks release-level proof.               |
| **External verification required** | Code/plan may exist, but the founder must supply an authorized account and matching read-back.                          |
| **Planned**                        | Not part of the available v0.2 alpha behavior.                                                                          |

Verified and fixture-verified rows both map to `PROTOTYPE` in
[Product Truth](PRODUCT_TRUTH.md). This central repository has no `LIVE`
capability row.

One isolated current-tree run completed all three Golden Path slices on
2026-08-12 outside the loopback-restricted sandbox. Repeated final-tree runs and
hosted CI evidence are still pending; one local pass is not a release claim.

## Primary founder web rail

| Surface                                           | Status           | Evidence boundary                                                                                         | Remaining real-world proof                                     |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Root `vh` founder command routing                 | Verified (local) | Public root dispatch tests preserve exact arguments and exit codes                                        | Packed/install invocation in the final release gate            |
| Markdown idea compiler                            | Verified (local) | Typed brief, explicit assumptions, exact price, secret rejection                                          | Founder review of the first real compiled brief                |
| Bounded idea sharpening                           | Verified (local) | Valid contracts use zero model calls; rough prose is limited to one primary and one repair call           | First explicitly approved real founder idea/model run          |
| Typed Launch Contract                             | Verified (local) | Schema, safety boundary, deterministic brief/decision projection, canonical rendering and digest          | Founder review of the first real contract                      |
| Launch mode, web rail, Stripe/no-commerce routing | Verified (local) | Router/compiler tests                                                                                     | Whether the selected route fits the first real idea            |
| `founder-default` persistence                     | Verified (local) | Strict credential-free JSON, atomic local state, fixed nine roles                                         | First real account/team/organization metadata set              |
| `founder-default` doctor                          | Verified (local) | Read-only credential/account probes plus declared-scope, expiry, default and writable-target checks       | First real probe for every required non-CLI account            |
| Production dry run                                | Verified (local) | Repository/resources/env names/migrations/domain/setup/effects/blockers/final command                     | Comparison against the first real accounts and provider limits |
| Immutable Launch Grant                            | Verified (local) | Identity, seed, stack, destinations, effects, budgets, permissions, expiry                                | First grant used against authorized founder accounts           |
| Atomic local child staging                        | Verified (local) | Matching journal/no-run resumes; mismatched child or interrupted staging fails closed                     | Recovery experience in the first interrupted real launch       |
| Frozen independent child install                  | Fixture verified | Two clean local children passed offline frozen install, typecheck, build, zero-retry journey and test     | First clean install from a public package/store                |
| Founder operation/model budget truth              | Verified (local) | Exact provider-action direct estimates and build-task policy; recurring plans/tokens are not claimed      | Comparison with first real provider invoices and model session |
| Capability-scoped build context manifest          | Verified (local) | Canonical contract/product inputs, optional-pack exclusions, symlink guards and estimated 32k cap         | First approved real build-host run; no savings inferred        |
| Definitive root-CLI Golden Path                   | Fixture verified | One isolated current-tree three-slice run passed with no provider effect                                  | Repeated final-tree/CI runs, then live accounts and URL        |
| Standalone focused Next.js seed                   | Fixture verified | Independent package, production build and journey; optional advanced runtime and invented defaults absent | First founder-specific production deployment                   |
| Founder-specific product/design evidence boundary | Fixture verified | Required artifact roles, hashes and direct checks; desktop/mobile fixture review                          | Human design/product acceptance for the first real idea        |
| Child provider configuration                      | Fixture verified | Stack roles render exact account/resource/env references without values                                   | Provider-by-provider live configuration/read-back              |
| Source commit, push and local Git handoff         | Fixture verified | Source publication/read-back against a local bare remote, then exact clean child origin/branch/commit     | New repository and remote commit read-back in GitHub           |
| Production deployment and custom domain           | Fixture verified | Production-shaped Vercel mocks/fixtures, stable URL and domain/manual-DNS branches                        | Reachable Vercel URL plus domain read-back if requested        |
| Primary journey, launch report and Launch Receipt | Fixture verified | Product-specific fixture journey plus sanitized local report/receipt; generic smoke stays unverified      | Live journey against the deployed URL and provider evidence    |
| Core upgrade and unique-file survival             | Fixture verified | v2 ownership, migrations, checks, rollback, lock-last behavior                                            | Upgrade of the first real child repository                     |

## Founder-default providers

| Provider/capability                      | Implementation status          | Current evidence                                                                | Live boundary                                                                  |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| GitHub repository and source push        | Fixture verified               | Official command-shaped transport, local bare Git remote, commit/push/read-back | GitHub account, repository and remote SHA read-back                            |
| Vercel project/env/deploy/domain         | Fixture verified               | Complete-or-fail CLI plan plus mock/fixture read-back assertions                | Team/project/deployment `READY`/domain read-back                               |
| Neon project/database/migrations         | Fixture verified               | Mock/fixture output capture to pre-registered ref, migration and health plan    | Organization/project/database and read/write health read-back                  |
| Stripe test product/price/webhook/portal | Fixture verified               | Official HTTP boundary, exact-price and webhook-secret capture/read-back        | Stripe test account resource read-back; no charge implied                      |
| RevenueCat native entitlement stack      | Experimental                   | Local plan/contract tests                                                       | Manual project/key bootstrap, app/store product and read-back                  |
| Brevo sender/template/webhook            | Fixture verified               | Staged mock/fixture plan and DNS/manual boundary                                | Account, domain auth, sender/template and optional delivery read-back          |
| Google Analytics/Search Console          | Fixture verified               | Mock/fixture property/stream/site/sitemap plan and captured measurement ref     | OAuth scope plus property/site read-back                                       |
| Vercel Web Analytics                     | Optional, manual               | Local manual-plan contract                                                      | Deliberately absent from founder-default apply-once; separate review/read-back |
| Bing Webmaster                           | Fixture verified               | Mock/fixture site/sitemap/URL plan and acceptance assertions                    | Account/site read-back; indexation is never inferred                           |
| DNS/MijnDomein or generic manual DNS     | Fixture/manual-plan verified   | Consolidated records and authoritative read-back contract                       | Registrar action, preservation of existing records, propagation evidence       |
| Live status for all providers            | External verification required | No authorized provider account was contacted by this template                   | First sanitized production or sandbox read-back artifact                       |

## Quality and public release

| Surface                                              | Status           | Boundary                                                                             |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| Secret/PII/claim/migration/graph invariants          | Verified (local) | Final branch still needs the complete frozen release gate and CI evidence            |
| Desktop/mobile product composition and accessibility | Fixture verified | Not a production accessibility certification or guarantee for arbitrary generated UI |
| Raw HTML, metadata, sitemap, robots and consent      | Fixture verified | Must rerun against each child and its deployed production URL                        |
| Public repository/community/security files           | Verified (local) | GitHub security/ruleset settings require external read-back                          |
| Public stable tag/package                            | Planned          | This remains alpha until the first real founder launch is dogfooded                  |

## Optional and experimental work

| Surface                                     | Status                         | Default-path rule                                                            |
| ------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| Expo/SwiftUI and TestFlight                 | Experimental                   | Never blocks the founder web rail; public App Store approval is out of scope |
| Recursive delegated-service runtime         | Optional, verified (local)     | Generate only for a venture selling an orchestrated service                  |
| Agent REST/CLI/MCP/TypeScript SDK/UI parity | Optional, verified (local)     | Generate from command contracts when the Agent Surface is enabled            |
| Service Blueprints                          | Optional, verified (local)     | Use only for resumable multi-step outcomes, not ordinary features            |
| Winner Loop                                 | Optional, fixture verified     | No automatic scaling; publication and spend remain separately human-gated    |
| DistributionPR                              | Optional, fixture verified     | Proposal only in the fixture; no automatic posting                           |
| Fleet controller                            | Experimental, fixture verified | No blocker for single-child `vh upgrade`                                     |
| Knowledge graph                             | Optional, locally available    | Use only for a demonstrated relational product need                          |

## Automation boundary

- **Local/no-effect:** idea compile, routing, Stack metadata, doctor, dry run,
  Launch Grant compilation, seed planning, report rendering, upgrade planning.
- **Automatable when authorized and authenticated:** repository/resource
  creation, additive migrations, env configuration, test commerce, analytics,
  search, email configuration, source push, deployment, and read-back.
- **Can require one exact external action:** provider KYC, unsupported registrar
  DNS, asynchronous verification/propagation, RevenueCat bootstrap, or a
  provider limitation exposed by doctor.
- **Never implied:** destructive production changes, nameserver replacement,
  customer charge, bulk/cold send, ad spend, App Store publication, package
  publication, PR merge, or proof of demand.

## Evidence

The implementation and test paths for every public claim are registered in
[PRODUCT_TRUTH.md](PRODUCT_TRUTH.md). Fixture results cannot upgrade a provider
row to live. Usage accounting is locally tested, but no completed comparable
benchmark supports a token-, cost-, speed- or quality-savings claim.

## Assumptions

- The first dogfood venture is a narrow web SaaS using Stripe test mode and
  manual DNS if no supported adapter is installed.
- The founder supplies and owns every external account and reviews the dry run.
- Optional advanced work stays outside the default seed unless the idea selects
  it.

## Unresolved questions

- Which real founder account set will provide the first complete Stack doctor?
- Which narrow web venture will supply the first reachable production URL and
  provider read-backs?
- Which remaining external action will be the first observed manual boundary?

## Related documents

- [PRODUCT_TRUTH.md](PRODUCT_TRUTH.md)
- [ROADMAP.md](ROADMAP.md)
- [Founder quickstart](../public/FOUNDER_QUICKSTART.md)
- [Synthetic Golden Path](../public/SYNTHETIC_GOLDEN_PATH.md)
- [Architecture](../../ARCHITECTURE.md)
- [Provider authoring](../engineering/PROVIDER_AUTHORING.md)
