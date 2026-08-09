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

For v2 founder children, author new entries as `core_owned`, `merge_managed` or
`venture_owned`; the legacy labels above exist only for v1 compatibility. Before
an alpha tag, also run the definitive one-prompt Golden Path, standalone web
build/HTTP journey, provider fixture read-backs, and upgrade preservation proof.
No stable tag precedes the first real founder dogfood launch.

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
- The README, quickstart and packed help expose one canonical founder command;
  agents do not receive a second prompt-only launch implementation.
- The ordinary web seed remains standalone and does not acquire recursive
  service runtime or optional packs without an explicit product need.
- Offline fixture verification never claims a live provider/resource.
- Release artifacts contain no secrets, personal data or real venture evidence.
- A correction changes existing ventures through a release/migration, not a
  whole-repository overwrite.
