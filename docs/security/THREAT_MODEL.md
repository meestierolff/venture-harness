# Threat model

- Scope: Venture Harness repository and generated child-venture foundation
- Reviewed: 2026-08-09
- Evidence ceiling: local code/tests and repository configuration only

This model records what the repository currently enforces and what remains a
deployment blocker. `VERIFIED_LOCAL_CONTRACT` means a deterministic local test
or scanner exercises the named boundary. It does not mean a production system
has been penetrated, deployed, or certified. `CONFIGURED_UNVERIFIED` means CI or
an external setting is declared but has not been read back here.

## Assets

- credential values behind `cred://...` references;
- private form, customer, subscription, and commercial evidence;
- tenant, venture, account, and provider routing identifiers;
- authorization grants, spend ceilings, idempotency records, and audit events;
- source, dependency graph, CI permissions, packages, and release tags;
- provider resources and any external effect they represent.

## Actors and trust boundaries

Untrusted actors include anonymous web users, malicious contributors,
compromised dependencies or actions, forged webhook senders, hostile provider
responses, and a child venture accidentally reusing another venture's state.
Models and generated code are also untrusted until deterministic checks and
human authorization validate their output.

The principal boundaries are:

1. public HTTP input → application validation and private persistence;
2. model/generated output → repository and command execution;
3. repository source → CI runner → release artifact;
4. credential broker → one provider call;
5. outbound HTTP/CLI request → provider → sanitized read-back;
6. inbound webhook bytes → signature check → venture/project/environment route;
7. browser OAuth initiation → provider callback → credential storage;
8. framework upgrade → child-venture-owned files and state.

## Control and gap register

| Threat                                           | Current status                                                                     | Current evidence/control                                                                                                               | Required before production exposure                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Credential committed in current files            | `VERIFIED_LOCAL_CONTRACT`                                                          | exact fingerprint scanner, `.gitleaks.toml`, `pnpm release:check`                                                                      | keep allowlists exact; rotate any real hit                                                                               |
| Credential retained in history                   | `CONFIGURED_UNVERIFIED`                                                            | full-history Gitleaks workflow                                                                                                         | observe a successful protected-branch run; enable GitHub push protection                                                 |
| Dependency or action compromise                  | `CONFIGURED_UNVERIFIED`                                                            | pinned action SHAs, CodeQL, dependency review, Dependabot, production `pnpm audit`                                                     | review CI findings and protected-branch requirements                                                                     |
| PII copied to analytics or release media         | `VERIFIED_LOCAL_CONTRACT`                                                          | analytics PII verifier plus release scan of `memory/`, `data/`, and `reports/`                                                         | jurisdiction review and deployed-event inspection                                                                        |
| Cross-tenant/customer resource access            | `VERIFIED_LOCAL_CONTRACT`                                                          | scoped runtime-store tests and offboarding tests                                                                                       | authorization review at every deployed HTTP/command boundary                                                             |
| Audit-log tampering                              | `VERIFIED_LOCAL_CONTRACT`                                                          | local hash-chain tamper test in `tests/venture-runtime.test.ts`                                                                        | durable production storage, monitoring, retention, and restore test                                                      |
| Forged RevenueCat ingestion                      | `VERIFIED_LOCAL_CONTRACT`                                                          | exact-body HMAC and constant-time comparison in `lib/winner-loop/subscriptions.ts`; route-isolation tests                              | wire only through a raw-body-preserving HTTP endpoint and provider-specific secret rotation                              |
| Duplicate provider event                         | `VERIFIED_LOCAL_CONTRACT`                                                          | provider-event-ID deduplication and conflicting replay tests                                                                           | durable shared store and retention sized to provider retry policy                                                        |
| Stale but correctly signed webhook replay        | `VERIFIED_LOCAL_CONTRACT`                                                          | route-bound timestamp/raw-body HMAC, freshness/skew limits, size/MIME checks and bounded secret rotation                               | preserve exact bytes and verify a real provider delivery through the deployed ingress                                    |
| OAuth login CSRF/code interception/open redirect | `VERIFIED_LOCAL_CONTRACT`; live exchange pending                                   | 256-bit state, PKCE S256, exact redirect allowlist, tenant/session binding, single-use callback, expiry and negative tests             | shared encrypted transaction store, official token exchange, credential-broker storage and provider revocation read-back |
| Provider HTTP SSRF/DNS rebinding                 | `VERIFIED_LOCAL_CONTRACT`; live egress pending                                     | exact HTTPS host allowlist, all-address validation, DNS-pinned native TLS, manual redirects, cross-host auth stripping and bounded I/O | live provider doctor/read-back and deployment egress policy verification                                                 |
| Raw-HTML audit URL SSRF                          | `VERIFIED_LOCAL_CONTRACT` for literal/resolved-address and redirect rejection only | `scripts/verify-raw-html.ts` rejects credentials, non-public resolution results, and unsafe redirects                                  | native fetch does not pin the validated DNS answer; do not treat this audit script as a rebinding-safe provider runtime  |
| Unauthorized external effect                     | `VERIFIED_LOCAL_CONTRACT`                                                          | scoped authorization/checkpoint/idempotency tests                                                                                      | provider-specific live dry run and sanitized read-back inside an approved run envelope                                   |

## Explicit production blockers

### OAuth callbacks — `IMPLEMENTED_LIVE_VERIFICATION_PENDING`

The local transaction and callback boundary implements state, PKCE, exact
redirects, tenant/session binding, expiry and single use. No provider token was
exchanged in this audit. A deployed adapter still needs a shared encrypted
transaction store, official exchange, credential-broker storage and revocation
read-back before claiming a live connection.

### Webhook freshness — `IMPLEMENTED_LIVE_VERIFICATION_PENDING`

The local ingress contract authenticates exact bytes, timestamp and route,
enforces freshness/MIME/size, supports bounded rotation, and separately handles
duplicate/conflicting events. A deployed endpoint must preserve those bytes,
apply the provider's official authorization contract, monitor sanitized
failures, and verify a real delivery.

### General outbound HTTP SSRF — `IMPLEMENTED_LIVE_VERIFICATION_PENDING`

The native provider transport now validates the exact HTTPS host and every DNS
answer, pins the connection, revalidates redirects, rejects write redirects and
strips credentials on cross-host reads. Deployment egress controls and each
newly allowlisted official host still require a live doctor/read-back.

## Review triggers

Repeat the threat review when adding an OAuth callback, inbound webhook route,
user-controlled URL, file upload, new provider transport, new credential
backend, public package/release, multi-tenant endpoint, or destructive provider
capability. Production exposure requires negative tests, operational monitoring,
rotation/revocation guidance, and read-back evidence—not only this document.

Related: [repository security policy](../../SECURITY.md), [runtime security
design](../engineering/SECURITY.md), and [provider capability matrix](../audits/PROVIDER_CAPABILITY_MATRIX.md).
