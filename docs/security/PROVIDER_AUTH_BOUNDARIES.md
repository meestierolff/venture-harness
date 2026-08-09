# Provider authentication boundaries

This document is the minimum security contract for provider authentication and
callbacks. `VERIFIED_LOCAL_CONTRACT` means deterministic local code and negative
tests exercise the boundary. It never means a provider accepted a request or a
deployed callback has been verified.

## Credential broker — `VERIFIED_LOCAL_CONTRACT`

- Repository configuration stores `cred://provider/label`, never values.
- A credential is released only for the bounded provider call and registered
  with the redactor before output or errors are persisted.
- Account, scope, expiry, and remote test metadata may be stored; secret values,
  refresh tokens, private keys, and arbitrary provider responses may not.
- Login/readiness and authorization are independent. A working credential does
  not authorize a write, charge, send, deployment, or publication.

Evidence: `lib/credentials/`, `tests/credentials-broker.test.ts`, and
`tests/runtime-provider-transports.test.ts`.

## OAuth authorization code callback — `VERIFIED_LOCAL_CONTRACT`

`lib/security/oauth.ts` generates 256-bit state and a high-entropy PKCE verifier,
exposes only the S256 challenge, binds the transaction to provider,
organization, venture, actor, browser session, exact HTTPS redirect URI and a
safe application-relative return path, applies a maximum ten-minute lifetime,
and consumes state exactly once before callback validation. It rejects
unsolicited/replayed/expired callbacks, provider errors, missing codes,
cross-tenant or mixed-session callbacks, wildcard/prefix/suffix redirect tricks,
userinfo, fragments and non-HTTPS redirects with a value-free error.

The transaction store is an interface; the in-memory implementation is for
tests and local flows. A deployed adapter must use a shared encrypted store,
exchange the code only through the provider's official endpoint, put returned
values directly into the credential broker, persist only sanitized
account/scope/expiry evidence, and read back revocation. Those provider effects
remain `IMPLEMENTED_LIVE_VERIFICATION_PENDING`.

## RevenueCat webhook library — `VERIFIED_LOCAL_CONTRACT`

`lib/winner-loop/subscriptions.ts` authenticates a route-bound timestamp and the
exact raw bytes with constant-time HMAC comparison before JSON parsing. It
requires JSON MIME, caps body size, enforces past/future freshness, supports a
bounded previous-secret overlap, binds the route to venture, RevenueCat project
and environment, and deduplicates or rejects conflicting provider event IDs in
the scoped SQLite store. An event-ID duplicate remains separate from freshness
and never substitutes for it. Signatures, secrets and raw private bodies are not
logged or persisted.

The signed envelope is the harness ingress contract, not a claim that
RevenueCat itself emits this exact signature format. A deployed endpoint must
preserve raw bytes, establish this envelope at its trusted ingress, configure
the provider's official authorization mechanism, monitor sanitized failure
counts, and verify a real delivery. That is
`IMPLEMENTED_LIVE_VERIFICATION_PENDING`.

## Outbound provider HTTP — `VERIFIED_LOCAL_CONTRACT`

`lib/security/outbound-http.ts` and `lib/runtime/native-http-fetcher.ts` require
HTTPS, reject URL credentials/fragments/alternate ports, use an exact official
host allowlist, validate every DNS answer against public-address rules, and pin
the native HTTPS connection to a validated address while retaining the original
hostname for TLS verification. Redirects are manual and revalidated; writes may
not redirect, and credentials are removed before a cross-host read redirect.
Response bytes, redirects and duration are bounded. The injectable fetch seam is
fixture-only and is not the production transport.

Tests cover metadata/private/mixed DNS, suffix hosts, protocol downgrade,
cross-host authorization stripping and write redirects. Adding an official
provider host requires an explicit code review and a live sanitized doctor/read
back remains `IMPLEMENTED_LIVE_VERIFICATION_PENDING`.

## Required verification evidence

Provider authentication becomes `verified` only after an official remote test
and sanitized account/scope/expiry read-back. Provider resource success needs a
separate resource read-back. A local fixture, configured reference, HTTP 2xx,
accepted request, or generic `doctor` exit is not either kind of proof.

See [provider authentication operations](../operations/PROVIDER_AUTHENTICATION.md),
[credential rotation](../operations/CREDENTIAL_ROTATION.md), and the
[threat model](THREAT_MODEL.md).
