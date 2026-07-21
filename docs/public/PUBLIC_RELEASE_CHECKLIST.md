# Public release checklist

Run before making any repository (template or venture) public, and before
tagging template releases. `pnpm release:check` automates the mechanical
items; the rest need human eyes.

## Automated (`pnpm release:check`)

- [ ] No secrets or credential-shaped strings in tracked files.
- [ ] `.env*` not tracked (only `.env.example`).
- [ ] LICENSE present; package.json license matches.
- [ ] Generated skill dirs in sync (`pnpm agents:check`).
- [ ] No real personal data in `memory/`, `data/`, or `reports/`.
- [ ] Synthetic/sample material labeled (checks for the SYNTHETIC marker in
      examples and sample data).
- [ ] All verify scripts pass.

## Human review

- [ ] README reads correctly for a first-time visitor (founder, developer,
      Reddit skeptic).
- [ ] No venture-confidential material committed (interview notes,
      unreleased pricing, private channel research).
- [ ] `docs/legal/ANALYTICS_AND_CONSENT.md` reviewed for the launch
      jurisdiction — by a human, ideally counsel.
- [ ] PRODUCT_TRUTH register contains no UNVERIFIED/UNDER REVIEW claims on
      public surfaces.
- [ ] Issue templates and CONTRIBUTING reflect current reality.
- [ ] Screenshots/examples contain no real customer data.

## After going public

- [ ] Enable branch protection on `main` (require PR + checks).
- [ ] Enable secret scanning and Dependabot alerts.
- [ ] Mark the repository as a template (Settings → Template repository)
      if this is the harness itself.
