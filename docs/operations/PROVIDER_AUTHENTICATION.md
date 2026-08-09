# Provider authentication

Authenticate once per account profile; keep each child venture's credentials
isolated.

## Commands

```bash
vh auth login [provider]
vh auth status
vh auth test [provider]
vh auth revoke <provider>
vh doctor
```

`vh auth login` without a provider is a discovery call: it returns supported and
registered providers plus the next action. It does not authenticate all
providers. Continue with `vh auth login <provider>` for each provider selected by
the reviewed plan.

`login` should prefer an official provider CLI session when it safely owns token
refresh. API keys, restricted keys, OAuth/service-account material and
JWT/private keys use the credential broker. A test may return reference,
provider, account ID, scopes, expiry and status, but never a value.

The repository's default CLI service can inspect registered broker references;
it does not invent an interactive login or remote scope test. An available
official CLI session is authenticated evidence because doctor repeats the
official session check. A non-CLI reference becomes authenticated evidence only
after an injected official provider tester returns `ok: true`; the safe
`testedAt`/`testStatus` metadata is persisted in the credential catalog. Backend
availability alone, a failed test, or an absent tester never becomes remote
validation. In those cases run `vh auth test <provider>` with the official tester
configured, then rerun `vh doctor`.

## Reference model

Repository config stores only a logical reference such as
`cred://google/primary`. Broker metadata maps it to:

| Backend              | Use                                                       |
| -------------------- | --------------------------------------------------------- |
| system keychain      | writable local default on supported systems               |
| environment mapping  | read-only CI secret supplied by the runner                |
| 1Password CLI        | optional local/team backend when installed and authorized |
| provider CLI session | official session/refresh ownership                        |
| memory               | tests only; never a launch profile                        |

Do not encode a backend or secret value in provider YAML. Do not put account
profiles containing values in the repository.

## Verified lifecycle state

Successful apply plus provider read-back may update
`.venture/provider-lifecycle.json`. This local state contains only the provider,
environment, capability, verified plan/time, and allowlisted typed resource
identifiers needed for a later plan. It never stores credential references or
values, arbitrary request/response bodies, provider messages, or idempotency
keys.

Reuse is limited to the same provider, environment, and proven capability.
Reviewable config remains authoritative, and credentials, account/team scope,
and ambiguous or conflicting identifiers must still be supplied explicitly. A
missing lifecycle file means no prior verified state; malformed, unknown-field,
or secret-bearing state fails closed and must be restored from trusted read-back
evidence before provider planning or apply can continue.

Lifecycle persistence is not a generic resource graph. Within one provider plan,
a later operation may consume only an explicit
`{dependency.<capability>.<path>}` value from a declared dependency. Across
providers, the workflow recompiles a staged plan from strictly allowlisted
public identifiers and DNS records emitted by verified dependencies. Ambiguous,
missing or private-looking values fail before the later transport runs.

The built-in Neon creation path captures only its documented connection URI into
an already registered broker target, and Stripe binds one exact approved test
price to the product created earlier in its plan. The staged Brevo, Google, EAS
and App Store Connect paths consume exact dependency evidence before continuing.
Unresolved RevenueCat/Apple store-product prerequisites remain explicit gaps or
manual actions instead of partial success.

## Provider auth shapes

| Provider            | Preferred supported shape                                                                |
| ------------------- | ---------------------------------------------------------------------------------------- |
| GitHub, Vercel, EAS | official CLI session or scoped token where supported                                     |
| Neon, Brevo         | API key                                                                                  |
| Stripe              | restricted key where possible; test/live separated                                       |
| RevenueCat          | restricted secret key after manual project bootstrap                                     |
| Google              | OAuth or service account with required Analytics/Site Verification/Search Console scopes |
| Bing                | supported OAuth/API key surface, live-doctored before use                                |
| App Store Connect   | issuer/key identifiers plus private key behind a JWT credential reference                |
| MijnDomein/DNS      | manual; no credential value belongs in the harness                                       |

## Doctor outcomes

- `ready`: usable transport and required auth/scopes detected;
- `auth_required`: missing, expired, revoked or insufficient reference;
- `degraded`: some capability/transport cannot run;
- `manual_only`: the provider has a precise human action;
- `unavailable`: no safe executable or manual route for the requested capability.

Provider login does not authorize a write. Apply also needs the active run
envelope.

## Revoke

`vh auth revoke` always disables broker access first and reports local removal
separately from provider-side revocation. If a read-only or failing backend
cannot remove the value, its catalog reference remains present with `revokedAt`
so a new process still fails closed; follow the returned backend-specific removal
action. Provider-side revocation remains `manual_required` until independently
verified, and the result names the exact provider settings action. Local deletion
or CLI logout alone is never reported as remote token revocation.
