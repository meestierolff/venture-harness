# Provider authoring

- Status: locally verified contracts and fixture/mock lifecycles
- Live verification: pending for every provider in the template
- Canonical package contracts: `packages/provider-sdk/` and
  `packages/provider-registry/`
- Current CLI integration: `lib/providers/`

## Capability first

Core code requests a capability; a versioned Stack Profile selects an ordered
provider candidate list. Never branch product behavior on a provider name when
the distinction can be represented as a capability contract.

A `CapabilityDescriptor` declares:

- namespaced capability ID and schema version;
- input/output JSON Schemas;
- supported environments and required scopes;
- rate and concurrency classes;
- timeout;
- redaction paths;
- whether an unknown outcome requires read-back-before-retry or manual
  reconciliation.

`ProviderCapabilityRegistry.resolve` returns the first registered candidate in
the Stack Profile that implements the capability. It fails rather than silently
falling back outside the profile.

## Required lifecycle

Every package-level adapter implements the complete lifecycle:

```text
discover → estimate → plan → apply → readBack
                         ↘ reconcile
                         ↘ compensate
```

- `discover` inspects safe, tenant-scoped provider facts.
- `estimate` returns amount, currency, and whether the estimate is known.
- `plan` produces data only; it does not perform an effect.
- `apply` requires explicit runtime authorization.
- `readBack` compares provider state with the plan/result.
- `reconcile` resolves an ambiguous prior attempt without repeating it.
- `compensate` performs only a declared, authorized, reversible response.

Do not return `verified` from the apply response alone.

## Current operational adapter layer

`lib/providers/` is the compatibility integration used by the v0.2 operational
CLI. A provider there has a descriptor, a complete-or-fail plan builder, and the
`doctor → plan → apply → readBack → verify` lifecycle. Preserve it until its
consumers have migrated to the package contract.

Each operation declares provider, capability, action, transport, environment,
risk, effect class, reversibility, credential reference, stable idempotency key,
dependencies, execution spec, read-back assertions, and verification strategy.
An operation contains exactly one of command, HTTP, or manual execution data.

The founder web rail currently composes GitHub, Vercel, Neon, Stripe, Brevo,
Google, Bing, and DNS. RevenueCat is the native-subscription selection. App
Store Connect and EAS remain experimental mobile boundaries. Adding another
provider does not improve v0.2 unless the primary rail has a concrete missing
capability and an end-to-end fixture.

## One-time founder connection

`lib/founder-launch/stack.ts` owns the public `founder-default` connection
record. It is strict credential-free JSON containing:

- one fixed provider-neutral role map;
- an explicit optional-role selection, so RevenueCat appears only for a native
  selection or an already configured native-commerce role;
- bounded GitHub, Vercel and Stripe official-CLI inspection metadata, with
  Stripe accepted only when a test-mode read is proved;
- `cred://...` references and safe account/team/organization metadata;
- requested scopes, expiry, and declared verification metadata;
- launch defaults for Neon, Stripe test mode, Brevo, Google, Bing and DNS;
- Keychain/1Password templates for provider responses that contain a Neon
  connection URI, Stripe webhook signing secret, or Google measurement ID.

`vh stack create founder-default --file <connection.json>` validates and stores
that record atomically in founder-local state. It does not authenticate or
perform a provider effect. `vh stack doctor founder-default` checks every role
without a write. Production rejects the fixture-only in-memory backend.

Built-in Neon, Stripe, RevenueCat, Brevo, Google and Bing credential testers use
bounded read-only official API requests. GitHub and Vercel use their official
CLI session reads; the Stack wizard also uses the official Stripe CLI only for
safe account/test-mode inspection while the REST adapter retains its separate
restricted test-key reference. A passing probe supports
credential/account/scope readiness; it does not prove that a planned repository,
project, database, price, sender, site, deployment, or domain exists. Keep
resource verification in provider `readBack`.

## Canonical Stack Profile commands

The operational bridge exposes `stack.doctor`, `stack.plan`, `stack.dry-run`,
`stack.apply`, `stack.read-back`, and `stack.reconcile` through the command bus.
Every invocation attests the exact Stack Profile ID/version, provider-neutral
role, selected provider, concrete capability, and environment. Operation
commands also bind one operation ID and payload. A mismatch fails before the
adapter is invoked.

The package capability catalog also has `founder-default@0.2.0` and
`founder-default-generic-dns@0.2.0`; the latter selects the generic DNS adapter
instead of MijnDomein for `dns.record`. This is a real adapter substitution, not
an alias. Do not confuse these package selection contracts with the founder's
persisted one-time connection record. The one-prompt connection renders its
explicit `manual_generic` or `mijndomein_manual` choice into child config.

The root host bridge imports package public exports, while the packaged runtime
stays unconfigured unless a host supplies implementation and execution context.
Catalog fields distinguish implementation availability, credential state,
disabled provider effects, and pending live verification.

## Idempotency and ambiguous writes

The client ledger atomically binds its key to a SHA-256 hash of the complete
canonical operation. The same key plus a different operation is a conflict. A
write attempt is settled as only:

- succeeded;
- definitive no-write; or
- pending reconciliation.

Timeouts, disconnects, and malformed post-write responses are unknown, not
definitive failures. Reconcile through provider state before retrying. Retry an
effect only when provider evidence proves the prior attempt did not write.

Use native provider idempotency in addition to the client ledger when supported.

The Stack command runtime also requires a durable atomic operation store and
durable provider idempotency ledger before authorized apply. Its SQLite store
writes the complete prepared request and canonical request hash under
`BEGIN IMMEDIATE` before adapter invocation. Independent processes therefore see
one owner, an exact replay, a conflict, a pending attempt, or an ambiguous
attempt before any second mutation. After restart, reconcile may release only
confirmed no-write and may complete a confirmed write only after matched
read-back; unknown remains ambiguous. In-memory stores are fixture-only.

## Budget estimates

Every operation in a materialized launch plan declares an exact known
`estimatedCost` with a non-negative amount in the Launch Grant's ISO currency.
Do not infer a missing estimate as zero or convert currencies. Before apply,
deduplicate identical canonical provider requests and aggregate operation count
and exactly representable minor-unit cost. Check those totals against the
external-resource ceiling, and check independently metered model tokens/cost
against the model ceiling. Unknown, invalid, currency-mismatched,
non-convertible, or excessive values stop the whole plan before invocation.

## Credentials and output

- Persist only `cred://...` references.
- Resolve a value only for one direct transport call.
- Never put a value in argv, a URL, a report, durable state, or an exception.
- Pass command payload secrets through stdin or a narrowly scoped environment
  binding, never shell interpolation.
- Declare response fields that may contain credentials and capture only through
  an already-registered writable credential reference.
- Register captured values with the redactor before output can leave the
  transport.
- Keep account IDs and resource IDs tenant-scoped and allowlisted.
- Keep auth-readiness probes read-only and bounded; do not reuse their success
  as resource read-back evidence.
- Register every writable capture target before planning or transport. A
  provider response containing an unregistered credential field fails rather
  than leaking into output.

## Manual providers

When no supported official write transport exists, author a manual operation
with the system, instructions, required fields, and exact completion evidence.
Never simulate success. DNS/MijnDomein changes, the first App Store Connect app
record, and RevenueCat project/key bootstrap are current examples. A Stack
operation remains `waiting_manual_evidence` until a trusted host verifier accepts
the declared evidence; transport acceptance or self-authored booleans are not
enough.

## Add or change a provider

1. Add or revise the capability descriptor and typed request/result contract.
2. Add the provider implementation with every lifecycle method.
3. Register it in the capability registry and relevant Stack Profiles.
4. If the operational CLI needs it, add its `ProviderId`, descriptor, plan
   builder, registry entry, transport, and fixture request under `lib/providers/`.
5. Add doctor cases for missing auth, missing scope, unavailable transport,
   provider limitation, and manual-only state.
6. Test dry-run non-invocation, authorization denial, redaction, dependency
   materialization, native/client idempotency, read-back mismatch, ambiguous
   outcome reconciliation, rate limiting, and compensation boundaries.
7. If the provider joins `founder-default`, add its exact account/default/auth
   metadata, official read-only credential tester, writable capture needs,
   no-effect doctor result, one-prompt graph node, fixture and external-action
   wording. Do not add it to the fixed Stack only to advertise breadth.
8. Update the provider capability matrix and Product Truth. Keep the public
   status **live verification pending** until an authorized read-back artifact
   exists.

## Verification

```bash
pnpm test:providers
pnpm typecheck
pnpm lint
```

Mock or fixture verification proves the contract and control flow only. A live
provider is `verified` only after the exact account/resource state is read back
and stored as sanitized evidence.
