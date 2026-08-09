# Pack authoring

- Status: locally verified install and replay behavior
- Live verification: pack contributions may still depend on live providers
- Canonical materialization catalog: `lib/materialization/packs.ts`
- Package primitive: `packages/pack-runtime/`

## What a pack is

A pack is a versioned capability contribution set. It can contribute:

- capabilities;
- Service Blueprint IDs;
- command IDs;
- event names;
- migrations;
- provider requirements;
- evaluations;
- bounded loops;
- UI contribution IDs.

A pack is not a bag of files and does not bypass command, policy, tenant,
workflow, provider, or evidence boundaries.

The v0.2 catalog includes `validate-first`, `ship-to-users`,
`distribution-pr`, `winner-loop`, `web-saas`, and `ios-subscription`.

| Pack               | Founder-release position                                                                |
| ------------------ | --------------------------------------------------------------------------------------- |
| `web-saas`         | Add only when the routed web product needs subscription/email contributions             |
| `validate-first`   | Optional validation mode; never a universal pre-build gate                              |
| `ship-to-users`    | Optional orchestrated launch Service Blueprint, not required by an ordinary app feature |
| `ios-subscription` | Experimental native-subscription contribution                                           |
| `distribution-pr`  | Optional, fixture verified; sending/posting stays human-gated                           |
| `winner-loop`      | Optional, fixture verified; spend needs a separate human-approved Spend Grant           |

The ordinary web seed starts with `serviceRuntime: none`. Installing a manifest
does not silently add the complete recursive customer runtime. A pack that needs
Service Grants, customer provider connections, generated Agent Surfaces, usage
metering, or recursive tenancy must declare that product requirement and select
an appropriate seed/runtime deliberately.

## Manifest invariants

- Use a lowercase hyphenated ID, semantic version, and Core compatibility.
- Every contribution ID must be stable and unique in the composed state.
- A command must exist in the command catalog and declare its authorization
  requirements.
- A provider entry names a requirement, not proof that it is configured.
- A migration is ordered and idempotent.
- A loop is bounded and has explicit evidence/stop behavior.
- UI contributions call command contracts; they do not implement effects.
- The uninstall policy must say whether evidence must be preserved.
- Optional provider requirements remain unconfigured until the venture selects
  and doctors them; their presence in a manifest is not a provider claim.
- A pack cannot broaden a Launch Grant or turn a proposed post, send, charge,
  deployment, or spend into an authorized effect.

## Install and upgrade semantics

`installPack` unions contributions deterministically and returns
`already_installed` for the same version without duplicating anything. Installing
a different version over an existing one fails and requires an explicit pack
upgrade/migration.

The package-level `InMemoryPackRegistry` is a lightweight workspace primitive
for executable command manifests. The materialization catalog has the richer
venture manifest used for seeds and fleet evolution. Keep the two schemas
aligned when a package command becomes a venture contribution.

Uninstall is intentionally not a simple delete. It requires a
dependency-aware migration that proves no active command, blueprint, provider,
event, evaluation, loop, UI surface, or evidence record would be orphaned.
Winner Loop uses `preserve_evidence`; archive its history before removal.

## Add a pack

1. Define the exact user capability and why it is not part of Core.
2. Author and test its commands, Service Blueprints, events, migrations,
   evaluations, loops, provider requirements, and UI actions independently.
3. Add the manifest to `PackManifest["id"]` and `PACKS`.
4. Declare Core compatibility and an evidence-preserving uninstall policy.
5. Install it twice in a test and assert identical state on replay.
6. Test incompatibility, version conflict, duplicate contribution protection,
   migration failure, and dependency-aware uninstall refusal.
7. Add it only to seeds whose smallest useful journey needs it.
8. Prove the ordinary founder web Golden Path stays green without the pack.
9. Label fixture, experimental, external-verification and planned provider
   surfaces separately in Product Truth and Feature Status.

## Verification

```bash
pnpm test -- tests/materialization.test.ts tests/workspace-boundaries.test.ts
pnpm workspace:check
```

An installed manifest is **locally verified**. Provider configuration or a
market outcome contributed by that pack remains **live verification pending**.
