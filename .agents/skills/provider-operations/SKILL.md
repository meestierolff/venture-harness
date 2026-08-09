---
name: provider-operations
description: Authenticate, inspect, plan, apply, verify, retry, and safely compensate launch-provider operations through official MCP tools, CLIs, APIs, or explicit manual actions. Use for vh auth/doctor and GitHub, Vercel, Neon, Stripe, RevenueCat, Brevo, Google, Bing, DNS, App Store Connect, or EAS work; never expose credentials or claim unverified state.
---

<!-- GENERATED FILE - do not edit. Canonical source: skills/provider-operations/SKILL.md. Regenerate with: pnpm agents:sync -->

# provider-operations

## Purpose

Operate provider capabilities through one typed, redacted lifecycle while
preferring official transports and read-back proof.

## Trigger conditions

- Provider authentication, doctor, provisioning plan/apply/verify, retry,
  degradation, revocation, or manual-action work.

## When not to use

- Product architecture or offer decisions.
- Dashboard browser automation when an official transport or honest manual node exists.

## Required inputs

Provider descriptor, capability, desired/current state, credential reference,
environment, run/idempotency key, and authorization envelope.

## Documents to read

Read the provider contract, relevant official current documentation, active
plan, policies, and credential/authorization ADRs. Read only the selected
provider guide.

## Files this skill may change

Provider configs by reference, migrations, adapter code/tests/fixtures, exact
DNS/manual-action plans, and sanitized evidence reports.

## Files this skill must not change

Secret values, another venture's accounts, unrelated product code, or provider
state that was not read back.

## Execution steps

1. Run doctor: transport installed, auth method, account, scopes, expiry,
   environment, rate limits, and manual-only constraints.
2. Plan desired versus observed state with effects, cost, risk, rollback,
   idempotency, verification, and authorization.
3. Resolve transport in order: appropriate installed MCP, official CLI,
   official API, precise human action.
4. Apply once per idempotency key inside the envelope; never pass secrets in
   interpolated shell strings or reports.
5. Read state back and validate completion. Store identifiers and evidence refs,
   never values.
6. Retry only classified retryable failures within provider/backoff budgets;
   compensate only when declared safe.

## Hard rules

- Credential values never enter Git, config, logs, traces, command args, or reports.
- `configured` is not `verified`; apply output alone is not proof.
- Test/sandbox and live state remain distinct.
- Prices trace to approved offer config and exact displayed-price evidence.
- Protect existing MX/SPF/DKIM/DMARC; never replace nameservers implicitly.
- MijnDomein defaults to one consolidated manual DNS action unless an official
  API is positively verified.
- RevenueCat/App Store dependencies and first Apple record remain honest manual nodes.

## Expected output

A redacted structured plan/result with resource IDs, lifecycle state, evidence,
retryability, and exact next action.

## Validation

Run adapter contract, dry-run, idempotency, redaction, failure, and partial
outage tests. Live verification stays pending without an authorized credential.

## Failure behaviour

Mark `auth_required`, `waiting_manual_action`, `degraded`, or `failed` exactly;
preserve independent work and never silently no-op.

## Human approval boundaries

The envelope must cover the capability/effect/provider/environment. Deletion,
destructive data, real charges, bulk/cold email, nameserver changes, and App
Store publication require distinct authorization.
