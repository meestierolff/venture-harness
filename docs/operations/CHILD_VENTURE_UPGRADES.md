# Child-venture upgrades

Corrections reach existing ventures through a versioned release manifest and
`harness.lock`, not by copying the whole template over product code.

## Ownership

- `harness`: centrally maintained contracts/runtime/checks;
- `generated`: reproducible agent adapters or other derived files;
- `project`: venture product code, design, copy and evidence; never overwritten.

The lock records version, source, ownership and trusted hashes. A changed
harness/generated file becomes a conflict instead of being replaced blindly.

## Procedure

```bash
git status --short
vh upgrade --release /path/to/reviewed/venture-harness-v0.3 --dry-run
vh upgrade --release /path/to/reviewed/venture-harness-v0.3
pnpm verify
```

The release argument is a local checkout whose `harness.lock` declares
`source: release`, an exact `v<version>` ref, and a non-empty managed baseline.
The locator rejects URLs, symlinks that escape the checkout, missing files, and
hash mismatches. Selecting that local path is the trust decision: inspect its
commit and release notes before the dry run. A release cannot inject commands.

The dry run shows the migration chain, fixed verification steps, and
create/update/unchanged/preserve/conflict decisions without writing or running a
command. Resolve conflicts by deliberately reconciling the release or changing
ownership—not by discarding child work.

Apply stages deterministic migrations and conflict-free managed writes, then
runs these direct, shell-free commands from the child repository:

```text
pnpm agents:sync
pnpm agents:check
pnpm typecheck
pnpm test:migrations
```

Only after they pass and the staged managed hashes still match the selected
release does the engine write `harness.lock`. `pnpm verify` remains the complete
post-lock repository gate.

If a migration, managed write, sync, check, hash read-back, or lock update fails,
the engine attempts to restore every transaction path and the prior lock. If
rollback is incomplete, restore the paths named in the report from version
control before retrying.

## v0.1 to v0.2

The default registry contains the versioned, idempotent v0.1→v0.2 migration.
Legacy infrastructure booleans map to `configured`, never `verified`, because
v0.1 stored no read-back artifact. A full local-release upgrade resolves one
unambiguous registered chain, plans each migration against the prior staged
result, and commits all migration records in the final lock. Future releases add
code-reviewed registry entries; release data cannot introduce migration code.
The v0.1 migration seeds the canonical harness-owned contract it produces
(`config/framework.yaml`) with its exact staged hash. That lets the selected
release advance the known file without a false no-baseline conflict. An existing
harness path absent from that staged baseline still conflicts; the upgrader does
not guess that an unknown child file is safe to replace.

Bare `vh upgrade` remains a backward-compatible config-only route for an
unlocked v0.1 checkout. Prefer `--release <local-release-root>` when adopting
central managed files so migrations, sync, checks, and the lock share one
rollback boundary.

## Current integration boundary

The CLI intentionally does not fetch releases. An operator supplies a reviewed
local checkout. If a locked venture omits `--release`, the CLI reports that no
target was selected; it does not infer that the venture is current. The fixed
pre-lock suite is upgrade-specific, not the full capability-aware quality gate,
so the operator still runs `pnpm verify` and the applicable staged profile after
apply. No external provider effect is part of a harness upgrade.

## Publishing a central correction

Fix and verify the central harness, add a deterministic registry entry when
contracts change, run `pnpm agents:sync`, and run `pnpm lock:refresh` only after
all managed content passes verification. Tag that hash-complete checkout and
review its release notes. The checkout itself is the local release bundle used
by each child dry run. A child may defer an upgrade; it must not fabricate
compatibility or silently auto-merge.
