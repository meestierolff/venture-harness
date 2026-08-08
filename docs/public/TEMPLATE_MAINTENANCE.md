# Template maintenance

For central Venture Harness maintainers, not child-venture product work.

## Version and release

Use semantic versions: major for breaking contracts, minor for capability/rail
additions, patch for compatible fixes. Keep package/framework/lock versions and
release notes aligned.

Before release:

1. assign each release-manifest file `harness`, `generated` or `project`
   ownership and a trusted hash where applicable;
2. add a versioned deterministic migration for contract changes;
3. run `pnpm agents:sync`, `pnpm verify` and `pnpm verify:release`;
4. audit PRODUCT_TRUTH and ensure live checks are evidence-backed or honest
   skips;
5. update changelog, versions and release manifest;
6. run the public-release check, tag and publish notes after human approval.

## How child ventures update

Child ventures run `vh upgrade --release <local-release-root> --dry-run`, resolve
managed-file conflicts, then repeat without `--dry-run`. Project-owned
product/design/evidence is preserved. Managed changes apply only from a trusted
hash-verified local baseline; adapters regenerate deterministically; fixed checks
run; the lock updates last. See
[CHILD_VENTURE_UPGRADES.md](../operations/CHILD_VENTURE_UPGRADES.md).

## Invariants

- AGENTS.md remains a short map; adapters hold no unique rules.
- Every documented command and skill route exists and is checked.
- Offline fixture verification never claims a live provider/resource.
- Release artifacts contain no secrets, personal data or real venture evidence.
- A correction changes existing ventures through a release/migration, not a
  whole-repository overwrite.
