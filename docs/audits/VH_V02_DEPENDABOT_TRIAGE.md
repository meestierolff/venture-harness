# Venture Harness v0.2 Dependabot triage

- Read back: 2026-08-27
- Repository: `meestierolff/venture-harness`
- Effect: read-only classification; no dependency PR merged or closed

The public GitHub pull-request API returned seven open Dependabot pull requests.
Founder-alpha completion does not depend on merging any of them.

| PR                                     | Class                        | Release decision                                  |
| -------------------------------------- | ---------------------------- | ------------------------------------------------- |
| #16 — grouped production dependencies  | configured patch/minor group | keep separate from founder-alpha; review normally |
| #17 — grouped development dependencies | configured patch/minor group | keep separate from founder-alpha; review normally |
| #18 — CodeQL autobuild v3→v4           | breaking major               | defer as a separate major                         |
| #19 — CodeQL init v3→v4                | breaking major               | defer as a separate major                         |
| #20 — CodeQL analyze v3→v4             | breaking major               | defer as a separate major                         |
| #8 — dependency-review action v4→v5    | breaking major               | defer as a separate major                         |
| #5 — setup-node v4→v7                  | breaking major               | defer as a separate major                         |

No open PR was identified as superseded by another PR with the same dependency
and target version. `.github/dependabot.yml` groups safe patch/minor production,
development, and GitHub Actions updates; majors remain separate. No automatic
dependency merging is configured.
