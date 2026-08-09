# Service Blueprints

- Status: locally verified with recursive-tenant SQLite fixtures
- Live verification: customer provider execution remains pending
- Canonical sources: `lib/venture-runtime/types.ts`,
  `lib/venture-runtime/store.ts`, and `lib/venture-runtime/service.ts`

## Purpose

A Service Blueprint is the versioned contract for one outcome a venture can
deliver to a customer organization. It connects a public capability to its
canonical command, workflow, provider capabilities, completion evidence, usage,
billing unit, and policy without embedding one customer's credentials or
provider resources.

## Required fields

| Field                                 | Meaning                                                |
| ------------------------------------- | ------------------------------------------------------ |
| `blueprintId`, `ventureId`, `version` | Immutable identity and owning venture.                 |
| `outcome`                             | Truthful result the service intends to deliver.        |
| `commandId`                           | One canonical command contract.                        |
| `requiredCapabilities`                | Provider-neutral capability allowlist.                 |
| `usageUnit`                           | Atomic metering quantity.                              |
| `billingUnit`                         | Commercial unit; may equal usage but remains explicit. |
| `completionCriteria`                  | Evidence conditions, not optimistic status text.       |
| `workflowGraph`                       | JSON-safe workflow definition/reference.               |
| `policy`                              | Additional venture constraints.                        |

Never mutate a published blueprint version in place. Add a later version and
migrate or issue grants explicitly.

## Customer Service Grant

A Service Grant binds one customer organization to:

- an exact blueprint ID and version;
- a finite allowlist of that customer's provider connection IDs;
- the user who granted access;
- activation and expiry timestamps;
- optional revocation.

The grant does not replace subscription, entitlement, command grant, agent
grant, or run authorization. Each is independently checked.

## Execution chain

Before calling a provider, the recursive runtime verifies:

1. user membership or a valid hashed agent token;
2. active customer organization;
3. explicit active subscription;
4. explicit entitlement attached to that subscription;
5. active Service Grant and exact blueprint version;
6. command and capability membership in that blueprint;
7. provider connection membership in the Service Grant;
8. verified, non-revoked connection with the capability;
9. a run/node-scoped authorization envelope;
10. an atomic usage reservation bound to the full request.

Only then does the tenant credential broker expose the secret for one provider
call. Completion settles usage. A proven no-effect failure releases usage. An
ambiguous outcome keeps it reserved and requires reconciliation.

## Authoring example

```json
{
  "blueprintId": "payout-rank.primary",
  "ventureId": "payout-rank",
  "version": 1,
  "outcome": "Produce one verified comparison report",
  "commandId": "reports.generate",
  "requiredCapabilities": ["source.read", "report.render"],
  "usageUnit": "verified_report",
  "billingUnit": "verified_report",
  "completionCriteria": ["artifact hash stored", "provider read-back matched"],
  "workflowGraph": { "id": "report-v1" },
  "policy": { "customerDataExport": false }
}
```

Keep outcome and completion wording inside Product Truth. A fixture artifact is
not a customer outcome.

## Authoring checklist

1. Define the outcome and the evidence that proves it.
2. Reuse or add one canonical command contract.
3. Name only provider-neutral capabilities.
4. Define one countable usage unit and explicit billing unit.
5. Use a bounded, resumable graph with reconciliation for effects.
6. Add negative tests for cross-venture/customer grant and connection reuse,
   expiry, revocation, entitlement exhaustion, agent-token forgery, idempotency
   conflict, unknown outcomes, and offboarding.
7. Put the blueprint ID in the owning pack and seed only where needed.

## Offboarding

Offboarding revokes organization access, memberships, Service/Agent Grants,
connections, and credential access. It preserves customer-owned resource
records for transfer or retrieval. See [Offboarding](../operations/OFFBOARDING.md).
