# Seed authoring

- Status: locally verified compilation and fixture-verified materialization
- Live verification: repository/provider effects are pending
- Canonical sources: `lib/materialization/seeds.ts` and
  `lib/materialization/materializer.ts`

## Seed contract

A seed selects the smallest independent venture-repository starting point for
one rail. It declares:

- stable ID and semantic version;
- `web`, `ios`, or `hybrid` rail;
- whether the complete recursive service runtime is `none` or `recursive`;
- compatible Core range;
- exact runtime package versions;
- generator versions;
- a deterministic list of safe relative files with ownership and content.

The v0.2 seeds are:

| Seed                             | Rail   | Service runtime | Founder-release status    |
| -------------------------------- | ------ | --------------- | ------------------------- |
| `agentic-web-saas@0.2.0`         | web    | `none`          | default, fixture verified |
| `agentic-ios-subscription@0.2.0` | iOS    | `recursive`     | experimental              |
| `hybrid-agentic-service@0.2.0`   | hybrid | `recursive`     | experimental              |

The ordinary web seed is a standalone Next.js application. It may include
ordinary app auth, database, commerce, email, analytics, search and deployment
contracts without receiving customer organizations, Connection Hub, Service
Blueprints, generated MCP/SDK surfaces, or other recursive-service machinery.
Add that runtime only when the venture actually sells an orchestrated outcome.

## File ownership

Use only v2 ownership labels:

- `core_owned` for invariant runtime/bootstrap files that must conflict on
  unreviewed local edits;
- `merge_managed` for small text files with a trustworthy three-way base;
- `venture_owned` for identity, design, product, copy, policy, and Service
  Blueprints that Core must preserve.

Do not mark venture-specific product work `core_owned` for convenience.

## Templates

The materializer currently supports the declared placeholders used by the
canonical seeds, including venture name/slug, rail, seed ID/version, workflow
SHA, and deterministic accent hue. Unknown placeholders fail. Templates must
not include credential values, provider account IDs, approver identities, or
untrusted absolute paths.

Every seed produces a `venture.manifest.json` and v2 `harness.lock` that bind
Core, seed, packages, provider adapter versions, generator versions, ownership
hashes, update channel, and exact workflow reference.

The one-prompt founder compiler selects the seed from the routed rail and binds
its exact ID/version into the immutable Launch Grant. The child cannot swap a
seed after the grant is issued. Seed compilation remains a no-effect local
operation; repository creation, source push and deployment belong to later
graph nodes.

## Materialization safety

The local filesystem target must be an empty real directory. Seed paths are
repository-relative, cannot contain `..` or backslashes, and are written with
exclusive create. A failed run removes only the files it created. Replays are
bound to the materialization plan digest and do not rewrite the workspace or
repeat provider effects.

A seed is selected through an immutable Launch Grant. The grant must name the
owner, repository, seed version, Stack Profile, company provider destinations,
budgets, exact allowed effects, expiry, and approval. A seed cannot broaden the
grant and a Launch Grant cannot authorize advertising spend.

## Add or revise a seed

1. Prefer revising an existing seed only when the rail's shared minimum really
   changed; otherwise add a pack.
2. Add the ID to the typed `SeedId` and Launch Grant schema.
3. Declare exact package/generator versions and Core compatibility.
4. Keep the shared bootstrap small and venture-neutral.
5. Assign every file one ownership class and add the trusted hash to the v2
   lock through the compiler.
6. Add the seed to fleet release compatibility and packed-consumer fixtures.
7. Test deterministic output, two different venture identities, unsafe paths,
   occupied/symlink targets, rollback, idempotent replay, and absence of account
   IDs/secrets.
8. For an ordinary app seed, prove that recursive files/packages are absent and
   the child has no runtime import from the Core source checkout.
9. Build and serve the child, exercise its public/primary journey, then run a
   Core upgrade and prove that venture-owned product/design files survive.
10. Run the canonical one-prompt Golden Path with fixture read-backs before
    labeling it fixture verified. Do not substitute a seed-only demo script for
    the real root CLI and child graph.

## Verification

```bash
pnpm vitest run tests/materialization.test.ts \
  tests/materialization-web-seed.test.ts \
  tests/materialization-web-build.test.ts \
  tests/founder-launch-orchestrator.test.ts
pnpm vitest run tests/founder-golden-path.test.ts
```

The second command is the definitive founder Golden Path and must traverse the
public root CLI, official transport-shaped fixtures, source commit/push, the
child graph, launch report and upgrade. Do not promote the seed while that
command is failing. Every synthetic provider result remains labeled; it is not
live provider verification.
