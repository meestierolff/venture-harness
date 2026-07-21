# Template maintenance

For maintainers of the venture-harness template itself (not ventures).

## Versioning

Semantic-ish: MAJOR for breaking structure changes (paths, config schemas),
MINOR for new skills/checks, PATCH for fixes. Version lives in
`package.json` and `config/framework.yaml` — keep them equal
(`pnpm release:check` verifies).

## Release procedure

1. `pnpm agents:sync && pnpm verify` clean.
2. Update CHANGELOG.md.
3. Bump both version fields.
4. `pnpm release:check`.
5. Tag `vX.Y.Z`; GitHub release notes = changelog section.

## How ventures take updates

Ventures are detached copies, not forks tracking upstream. Recommended
flow: read the template changelog, cherry-pick wanted changes, re-run
`pnpm agents:sync && pnpm verify`. Never auto-merge template changes into a
live venture.

## Invariants to protect

- AGENTS.md stays a map (~150 lines).
- Adapters stay thin; no rule exists only in an adapter.
- Every documented command exists; every skill is routed; parity holds.
- New checks must run offline and without paid services.
- Template contains zero venture facts and zero real market data.

## Deprecations

Deprecate skills/scripts by marking them in the skill description and
keeping them one MINOR version before removal, with a migration note in
the changelog.
