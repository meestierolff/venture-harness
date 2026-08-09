# Contributing to Venture Harness

Thanks for improving the harness. Contributions should strengthen the reusable
framework without adding venture-specific facts, credentials, private evidence,
or unverified public claims.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). The
[governance model](GOVERNANCE.md) explains maintainer and release decisions.
Security reports belong in the private process in [SECURITY.md](SECURITY.md),
not in public issues.

## Ground rules

- Read [AGENTS.md](AGENTS.md) and the active plan before changing behavior.
- Keep one conceptual change per pull request and preserve unrelated work.
- Put deterministic plumbing in code and judgement procedures in canonical
  `skills/` files.
- Never commit secrets, production payloads, customer data, or provider exports.
- Never edit generated agent-skill mirrors directly; edit `skills/`, run
  `pnpm agents:sync`, and review the generated diff.
- Label fixtures, prototypes, samples, mocks, and concierge behavior.
- Do not send, deploy, publish, charge, merge, or mutate a provider unless the
  exact effect has been authorized.

## Local workflow

1. Fork the repository and branch from `main`.
2. Install the exact dependency graph with `pnpm install --frozen-lockfile`.
3. Add or update tests and documentation with the behavior change.
4. Run the compatibility and staged gates:

   ```bash
   pnpm verify
   pnpm verify:mvp
   pnpm release:check
   ```

5. Run `pnpm verify:release` for release-facing changes. A reported `SKIP` is an
   incomplete check, not a pass; include the named missing evidence.
6. Open a pull request using the template and state what changed, what failed or
   remains unknown, and what should happen next.

## Security fixtures

Do not broadly exclude `tests/` from secret scanning. Credential-shaped test
canaries must be assembled dynamically where practical. If the exact literal is
essential, run the scanners, review that it can never authenticate, then add
only its exact path/rule/line/content fingerprint. Any content or line change
must be reviewed again; stale allowlist entries fail the release check.

## Accepted contributions

- bug fixes with focused regression tests;
- stronger safety, privacy, provenance, or release checks;
- clearer errors and documentation that remove recurring ambiguity;
- provider contracts grounded in official behavior and honest read-back gaps;
- accessibility, raw-HTML, consent, and critical-journey improvements.

## Out of scope

- venture-specific brand, pricing, customer, or market claims;
- paid services required merely to run the local test suite;
- broad instruction growth when a focused test or lint rule can enforce it;
- autonomous external effects or bypasses around authorization checkpoints;
- claims that mocks, fixtures, request acceptance, or local tests prove live
  provider state.
