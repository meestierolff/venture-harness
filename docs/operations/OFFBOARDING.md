# Ownership and offboarding

- Status: founder exit is a manual runbook; recursive customer offboarding is locally verified
- Owner: harness maintainers and the venture operator
- Last updated: 2026-08-09

## Purpose

Let a founder stop using Venture Harness—or let a delegated-service venture
offboard one customer—without deleting assets, leaking credentials, silently
changing ownership, or affecting another tenant.

## Ownership model

| Asset                                       | Default owner                                               | Venture Harness authority                                                        |
| ------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Child Git repository and source             | Founder/company named in the Launch Grant                   | Create/push only within the grant; later upgrades only when invoked              |
| Vercel project/deployment/domain attachment | Founder/company provider account                            | Configure/deploy/read back within the grant                                      |
| Neon project/database/data                  | Founder/company provider account                            | Create, migrate and health-check; no implied deletion                            |
| Stripe/RevenueCat commerce resources        | Founder/company provider account                            | Configure exact authorized resources; no customer charge implied                 |
| Brevo sender/template/webhook               | Founder/company provider account                            | Configure/read back; no bulk or cold sending                                     |
| Google/Bing properties                      | Founder/company provider account                            | Configure/submit/read back; no ownership of search accounts or indexation claim  |
| DNS zone/records                            | Domain owner/registrar account                              | Supported additive adapter or one exact manual action; no nameserver replacement |
| `cred://...` value                          | Founder-selected Keychain/1Password/CI/provider CLI backend | Resolve only for a direct call; never copy into child state or reports           |
| Launch reports and run evidence             | Child venture                                               | Sanitized record of what was and was not verified                                |
| Customer-connected resources                | Customer unless a different ownership class is explicit     | Bounded delegated permission through a connection and grant                      |

The ordinary web child has no runtime dependency on the Venture Harness source
checkout. Its application, migrations, provider config, product/design/copy,
deployment and lock live in its own repository. A child that opts into versioned
Core packages or recursive services must retain access to those reviewed
versions like any other dependency.

## Founder exit from Venture Harness

Stopping Core upgrades is not the same as shutting down the application. The
founder can retain the child and provider resources while ending Harness access.
No single automated `offboard` command exists for this alpha; execute and read
back each decision deliberately.

### 1. Freeze new effects

- Do not start or resume launch, learning, Fleet, distribution or Winner Loop
  runs.
- Inspect `vh status` inside the child and reconcile every prepared/unknown
  provider operation before revoking access.
- Preserve the final launch/upgrade reports and exact external resource IDs.
- Cancel separately scheduled provider jobs through their systems of record;
  local workflow state alone does not cancel them.

### 2. Prove custody

- Confirm founder/admin access to the GitHub repository, Vercel project, Neon
  project, commerce account, Brevo account, analytics/search properties,
  registrar and DNS zone.
- Clone the repository through the founder's normal GitHub access and run its
  documented local verification.
- Export database or provider data only when required by the venture's
  retention/privacy policy; verify the export before any deletion.
- Record ownership/transfers as sanitized evidence. Do not put private account
  exports or credentials in Git.

### 3. Choose resource disposition

| Decision                               | Safe default                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Keep the application live              | Preserve resources, deployment, domain and env configuration; remove only Harness access                                 |
| Move hosting/database/provider account | Create an explicit migration/transfer plan and verify the new destination before detaching the old one                   |
| Stop commerce/email/learning           | Disable new effects at the provider and read the disabled state back; preserve required financial/audit records          |
| Retire the domain                      | Preserve registrar ownership and mail/security records until an authorized cutover; never replace nameservers as cleanup |
| Delete production data/resource        | Separate destructive authorization, backup/retention review and provider read-back are mandatory                         |

### 4. Revoke Harness access

Use the credential lifecycle for each reference:

```bash
vh auth status
vh auth revoke github
vh auth revoke vercel
vh auth revoke neon
vh auth revoke stripe
vh auth revoke revenuecat
vh auth revoke brevo
vh auth revoke google
vh auth revoke bing
```

`vh auth revoke` disables local broker access first. Provider-side token/key
revocation remains a separate settings/API action until read back. For
environment/CI values, remove the secret from the runner. For official CLI
sessions, confirm logout. For Keychain/1Password, confirm the item is absent or
rotated. Do not infer remote revocation from local catalog removal.

Keep the credential-free Stack metadata only if it remains useful as an account
inventory. Remove local run/Stack/catalog state only after required sanitized
evidence has been archived and the operator has explicitly authorized that
deletion. This runbook intentionally provides no recursive delete command.

### 5. Continue without Core or resume later

- To continue independently, keep the child repository/provider configuration,
  remove obsolete Harness workflow credentials, and own future dependency,
  migration, security and operational updates directly.
- To resume Core upgrades later, retain `harness.lock` and the trusted managed
  baselines. Run `vh upgrade --release <reviewed-local-release> --dry-run`
  before applying.
- Removing `harness.lock` abandons the managed upgrade contract; it is not a
  supported offboarding shortcut.

## Delegated-service customer offboarding

This scope exists only for a venture that enabled the recursive customer
runtime. It ends one customer organization's access without affecting another
customer, venture, or the platform company Stack.

### Local sequence

1. Resolve the exact `ventureId` and `customerOrganizationId` through read-only
   lookup.
2. Capture subscription, entitlements, memberships, Service Grants, Agent
   Grants, provider connections, credential references, resources and unresolved
   provider outcomes.
3. Mark the customer organization `offboarded` to block new service execution.
4. Cancel/revoke subscriptions and entitlements in the commercial system of
   record; do not infer provider cancellation from local state.
5. Revoke memberships, Service Grants and Agent Grants.
6. Mark tenant provider connections revoked and revoke their scoped credential
   access.
7. Preserve customer-owned resource records and choose a transfer/preservation
   state; do not delete the underlying resource.
8. Reconcile outstanding effects and usage reservations.
9. Append sanitized audit evidence and verify the tenant audit chain.

The local `service.offboard` boundary marks the organization offboarded,
revokes its connections and scoped credentials, and preserves external-resource
records. Provider-side cancellation, token revocation, account transfer, data
export and deletion are separate operations.

### Customer resource classes

| Resource ownership                     | Default treatment                                                   |
| -------------------------------------- | ------------------------------------------------------------------- |
| `customer_owned`                       | Preserve; leave with the customer and remove venture access         |
| `customer_owned_dedicated_account`     | Preserve; transfer or detach only with explicit evidence            |
| `platform_managed_customer_subaccount` | Freeze effects; export/transfer under provider and contract policy  |
| `venture_owned`                        | Preserve under venture policy; never expose another customer's data |
| `platform_owned_demo`                  | Disposable only when visibly a fixture and deletion is authorized   |
| `transfer_pending`                     | Keep access blocked and track transfer until provider read-back     |

An `unknown` operation may already have written. Keep its usage/spend
reservation and reconcile before releasing it or issuing a replacement.
Offboarding never converts unknown to no-effect.

## Provider verification

For each affected provider, read back as applicable:

- OAuth/key revocation or detached CLI session;
- removed venture webhook without customer-data deletion;
- resource transfer/preservation under the recorded owner;
- disabled schedule/send/publish/spend capability;
- authorized export and retention state;
- domain, DNS and deployment state after any cutover.

Deletion, destructive data change, nameserver replacement, customer charge,
bulk communication and irreversible publication need their own checkpoint.

## Verification

```bash
pnpm vitest run tests/venture-runtime.test.ts tests/recursive-packed-credential.test.ts
```

These local tests prove tenant-scoped service blocking, connection/credential
revocation, customer-owned resource-record survival, isolation and audit-chain
verification. They do not prove a founder exit or provider-side revocation.

## Evidence

- `lib/venture-runtime/`
- `tests/venture-runtime.test.ts`
- `tests/recursive-packed-credential.test.ts`
- `lib/credentials/`
- `lib/upgrade/`

## Assumptions

- The founder/company owns the default Stack and can administer each provider.
- The child repository and sanitized reports remain accessible before local
  Harness state is removed.
- Venture-specific legal, tax, privacy and retention obligations are reviewed
  outside this generic runbook.

## Unresolved questions

- Which provider transfer/export APIs will be exercised in the first real
  founder exit?
- Which child dependencies, if any, need replacement before abandoning Core
  upgrades?
- What retention period applies to the first real venture's reports and data?

## Related documents

- [Founder quickstart](../public/FOUNDER_QUICKSTART.md)
- [Provider authentication](PROVIDER_AUTHENTICATION.md)
- [Credential rotation](CREDENTIAL_ROTATION.md)
- [Child upgrades](CHILD_VENTURE_UPGRADES.md)
- [Rollback](ROLLBACK.md)
- [Security](../engineering/SECURITY.md)
