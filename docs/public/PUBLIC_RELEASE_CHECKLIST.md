# Public release checklist

Run this before making the repository public, tagging a template release, or
publishing its package. Mechanical checks, CI checks, external GitHub settings,
and human review are separate evidence classes. None may be silently inferred
from another.

## Local mechanical checks

Run from a clean release candidate:

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm verify
pnpm verify:release
```

`pnpm release:check` verifies:

- [ ] no `.env*` file except `.env.example` exists anywhere in the release
      workspace;
- [ ] no unexpected credential pattern exists; every synthetic canary matches
      an exact path/rule/line/SHA-256 allowlist entry and no entry is stale;
- [ ] license and framework/package versions agree;
- [ ] public community, security, provider, and workflow files exist;
- [ ] all third-party workflow actions use full commit SHAs;
- [ ] sample-venture Markdown is visibly synthetic;
- [ ] `memory/`, `data/`, and `reports/` contain no non-reserved email address,
      and analytics/SEO inbox exports are absent;
- [ ] `npm pack --dry-run --json --ignore-scripts` contains the required CLI
      package files and no sensitive/development paths;
- [ ] generated agent-skill mirrors match their canonical sources.

The command scans the working directory, including ignored files. It does not
scan Git history, query GitHub settings, run CodeQL, resolve dependency
advisories, or prove production security.

## CI evidence

- [ ] Gitleaks full-history workflow passed with the reviewed `.gitleaksignore`.
- [ ] CodeQL analysis passed.
- [ ] dependency-review passed for the pull request.
- [ ] `pnpm audit --prod --audit-level=high` passed or every remaining advisory
      has a time-bounded maintainer decision and mitigation.
- [ ] capability-aware release profile completed. Every `SKIP` is recorded as
      incomplete with its exact command and missing evidence.
- [ ] raw HTML, browser journeys, accessibility, consent, analytics/PII, claims,
      migration/rollback, and relevant provider contracts ran for active
      capabilities.

## Founder rail evidence

- [ ] Installed/packed `vh --help` presents the focused founder workflow and
      routes founder commands to the same canonical CLI implementation.
- [ ] `vh doctor` reports real local prerequisites without mutating a provider.
- [ ] `vh auth status` exposes references/metadata only.
- [ ] `vh stack create founder-default` persists the credential-free connection
      and rejects raw values, unsafe files and fixture storage for production.
- [ ] `vh stack doctor founder-default` runs the applicable read-only official
      CLI/API probes and distinguishes credential readiness from resource
      verification.
- [ ] The full production `--dry-run` reports selected venture/seed/providers,
      exact accounts, repository/resources, env names, migrations, domain,
      analytics/search/email/commerce setup, external effects, blockers and the
      exact apply command.
- [ ] The definitive Golden Path invokes the public root `vh launch --idea ...`
      command and crosses the child CLI, graph, official transport-shaped
      fixtures, migrations, source commit/push, deployment, primary journey,
      report and upgrade.
- [ ] The ordinary web child installs/builds/serves independently and imports no
      runtime code from the Core source checkout.
- [ ] The Golden Path proves that venture-owned product/design files survive a
      Core upgrade and that the lock changes last.
- [ ] Every fixture provider result is labeled and every unavailable live check
      records its missing credential/environment, exact command, expected
      read-back and limitation.

## Human review

- [ ] README, package description, homepage, pricing, metadata, structured data,
      samples, and docs stay within `PRODUCT_TRUTH.md` wording and evidence.
- [ ] README's five-minute language describes conceptual orientation, not a
      guaranteed launch duration.
- [ ] Provider/status matrices use verified, fixture verified, experimental,
      external verification required and planned consistently.
- [ ] Ownership, offboarding and upgrade guidance make the founder/company the
      account/resource owner and never imply automatic deletion or transfer.
- [ ] A fixture, mock, configured reference, request acceptance, or local test
      is never upgraded to provider-backed deployment, customer, sale, delivery,
      submission, indexation, verification, or production-learning evidence.
- [ ] No customer/interview notes, unreleased commercial research, screenshots,
      provider exports, private identifiers, or personal data are present.
- [ ] Prototype, fixture, synthetic, and concierge behavior is visibly labeled.
- [ ] Legal/privacy/consent text was reviewed for the actual launch jurisdiction.
- [ ] Security gaps in `docs/security/THREAT_MODEL.md` were evaluated. OAuth,
      general provider-runtime SSRF, and webhook timestamp freshness remain
      blockers for any production surface that needs them.
- [ ] Package contents, executable behavior, license, version, changelog/release
      notes, and tag diff were reviewed directly.
- [ ] Maintainer access, ownership, issue templates, contribution policy, code of
      conduct, governance, and vulnerability-reporting instructions are current.

## GitHub settings read-back

Repository configuration cannot prove these external settings:

- [ ] private vulnerability reporting enabled;
- [ ] secret scanning and push protection enabled;
- [ ] Dependabot alerts and security updates enabled;
- [ ] branch rules require pull requests and the quality/security/CodeQL/
      dependency-review checks;
- [ ] default workflow token is read-only and release environments protect any
      publication credentials;
- [ ] repository visibility, template status, description, topics, and release
      permissions match the maintainer decision.

## Authorization and release

- [ ] A maintainer explicitly authorizes the exact public repository, version,
      tag, package name, and destination.
- [ ] Publication credentials are supplied only by the protected environment.
- [ ] After publication, read back the immutable tag/release/package metadata and
      record the URL, digest, time, and known limitations.

Passing this checklist does not itself publish anything. See
[OPEN_SOURCE_READINESS.md](OPEN_SOURCE_READINESS.md) and
[TEMPLATE_MAINTENANCE.md](TEMPLATE_MAINTENANCE.md).
