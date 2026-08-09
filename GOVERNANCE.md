# Governance

Venture Harness is maintainer-led and evidence-driven. This document governs
the repository and template; each child venture owns its own product and
production decisions.

## Roles

- **Contributors** propose issues and pull requests and follow the contribution
  and conduct policies.
- **Reviewers** provide domain review but cannot merge or release solely by
  virtue of a review.
- **Maintainers** triage work, protect repository access, approve and merge
  changes, cut releases, and handle conduct or security reports.

Current maintainers are the people with repository maintainer access. GitHub's
access controls are authoritative; this document does not grant access.

## Decisions

Routine changes use pull-request review and the applicable automated gates.
Security-sensitive, breaking, provider-effect, migration, or governance changes
need explicit maintainer approval. Significant architecture decisions belong in
an ADR or active plan with rejected alternatives and rollback implications.

When maintainers disagree, they seek the smallest reversible experiment or more
evidence. If a decision cannot be made safely, the change remains unmerged. No
vote or deadline converts missing security or truth evidence into approval.

## Releases

A maintainer selects the version, verifies the public-release checklist,
reviews unresolved skips and advisories, and authorizes the tag. Passing local
checks does not publish a package or release. Release credentials and protected
environment approvals remain outside the repository.

## Security and conduct

Security reports follow [SECURITY.md](SECURITY.md). Conduct reports follow the
[Code of Conduct](CODE_OF_CONDUCT.md). A maintainer who is the subject of a
report recuses when another maintainer can handle it.

## Changes to governance

Governance changes use a dedicated pull request, explain the operational
effect, and require explicit maintainer approval. The repository history is the
record of accepted revisions.
