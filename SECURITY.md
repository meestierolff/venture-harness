# Security policy

## Report a vulnerability privately

Use GitHub's **Security → Advisories → Report a vulnerability** flow for this
repository. Do not open a public issue for an exploitable problem and do not
include credentials, personal data, or production payloads in an issue or pull
request.

Include the affected version or commit, impact, prerequisites, minimal
reproduction, and any known mitigation. Maintainers aim to acknowledge a report
within three business days, then coordinate validation, remediation, and a
disclosure date with the reporter. Response times are targets, not a warranty.

If private vulnerability reporting is unavailable, open a public issue that
contains no exploit details or sensitive material and asks a maintainer to
enable a private channel.

## Supported versions

Only the latest `main` revision is currently supported. A tagged release is
supported only when its release notes say so. Child ventures own their deployed
dependency versions, credentials, provider configuration, and incident response;
template updates are deliberate rather than automatic.

## Security surfaces

- public routes and private evidence persistence under `app/`;
- workflow, provider, credential, data, and learning code under `lib/`;
- packaged command entry points and local scripts;
- generated child-venture code and provider plans;
- CI workflows and release/package contents;
- inbound subscription events and outbound provider HTTP/CLI calls.

## Repository controls

- `.env*` is excluded except `.env.example`; repository config accepts only
  `cred://...` references.
- `pnpm release:check` scans the full workspace and npm pack manifest. Synthetic
  credential canaries require an exact path, rule, line, and SHA-256 fingerprint
  in `.release-scan-allowlist.json`.
- Gitleaks scans full history in CI. CodeQL, dependency review, `pnpm audit`, and
  Dependabot cover source and dependency changes.
- Every third-party GitHub Action is pinned to a full commit SHA.
- GitHub-hosted secret scanning and push protection must also be enabled in the
  repository settings; configuration files cannot prove that external setting.

## Known limits

Local tests and scanners are not a production security certification. OAuth
callback state/PKCE/redirect validation and general provider-runtime SSRF/DNS
rebinding protection are currently `MISSING_RUNTIME`. The RevenueCat ingestion
library verifies an exact-body HMAC and deduplicates provider event IDs, but a
signed timestamp freshness window is also `MISSING_RUNTIME`. Do not expose those
surfaces as production endpoints until the missing contracts are implemented
and reviewed.

See [the threat model](docs/security/THREAT_MODEL.md), [provider auth
boundaries](docs/security/PROVIDER_AUTH_BOUNDARIES.md), and [public release
checklist](docs/public/PUBLIC_RELEASE_CHECKLIST.md).
