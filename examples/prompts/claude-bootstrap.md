# Claude Code bootstrap prompt

After creating a repository from the template and filling in the briefs,
open it in Claude Code and run:

```
/venture-bootstrap
```

Or, as a full prompt:

```
Run the venture-bootstrap skill on inputs/VENTURE_BRIEF.md and
inputs/DESIGN_BRIEF.md.

Use plan mode first. Dispatch the offer-critic subagent against the offer
before finalizing docs/business/OFFER.md, and the evidence-verifier
against any number you are about to record as fact.

Bootstrap writes documents and config only — no application code. Finish
with pnpm verify and report in the three-sentence format from AGENTS.md.
```

After bootstrap, typical next steps: `/design-director` for the identity,
then the active plan for building the validation site, with
`/quality-gate` before every completion claim.
