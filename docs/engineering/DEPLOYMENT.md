# DEPLOYMENT

The template deploys nothing. A child launch compiles only the resources its
capabilities need, and an apply runs only inside a reviewed run envelope.

## Launch flow

```bash
vh doctor
vh plan
vh launch --dry-run
vh launch --apply --authorization <profile>
vh status <run-id>
```

Planning lists resource identities, transport, risk, estimated cost,
reversibility, idempotency strategy, read-back and manual work. Provider state
moves through the lifecycle in `config/providers.yaml`; a boolean or successful
request is never launch proof.

## Web rail

Typical dependency order:

1. prepare and verify the child repository;
2. create/link the Vercel project and preview deployment;
3. use a read-back-verified Neon database and run executable migrations when needed;
4. configure test-mode commerce and email resources when active;
5. produce one additive DNS plan, preserving existing mail/security records;
6. attach the domain, deploy under authorization, then read back the exact URL/state;
7. run a separate read-only post-deploy barrier against that URL in desktop and
   mobile Chromium; the launch report remains blocked if HTTPS smoke or the
   critical public-surface journey fails;
8. verify the remaining raw HTML, consent, accessibility, events, webhooks and
   provider state;
9. submit sitemap only after the production URL and verification are real.

## iOS rail

Build and TestFlight are separate effects. The first App Store Connect app record
may pause as a manual node while independent `eas-build` work continues.
`eas-submit` joins the manual Apple identifiers with that same-run EAS build ID;
the following App Store Connect stage must read the exact version/build as
processed and read the exact TestFlight group assignment back. A completed build
does not prove upload, processing or group membership, and TestFlight does not
mean public App Store release. See
[IOS_TESTFLIGHT.md](../operations/IOS_TESTFLIGHT.md).

## Environments

| Environment  | External effects                                  | Evidence rule                                          |
| ------------ | ------------------------------------------------- | ------------------------------------------------------ |
| local        | local files/tests only unless explicitly expanded | fixture/local reports labeled synthetic                |
| test/sandbox | provider test resources                           | retain mode/account/resource ID and read-back          |
| preview      | reversible deploy and preview data branch         | noindex; no production claim                           |
| production   | only effects allowed by the active envelope       | production URL/state and critical journeys read back   |
| TestFlight   | authorized build/upload                           | build and submission IDs/status; not store publication |

## Rollback

The launch handoff must link the applicable provider-specific rollback or
forward-repair option. Never delete evidence to roll back an app. DNS rollback
restores only the changed record after preserving the previous value;
nameserver changes need a separate checkpoint. Full procedure:
[ROLLBACK.md](../operations/ROLLBACK.md).

## Related

- [../operations/FIRST_LAUNCH.md](../operations/FIRST_LAUNCH.md)
- [../operations/VERCEL.md](../operations/VERCEL.md)
- [../operations/MIJNDOMEIN_DNS.md](../operations/MIJNDOMEIN_DNS.md)
- [SECURITY.md](SECURITY.md)
