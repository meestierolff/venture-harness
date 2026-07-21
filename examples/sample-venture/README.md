# Sample venture: MeterMate

> **SYNTHETIC EXAMPLE.** MeterMate is an invented venture used to show how
> the harness works end to end. No real company, customers, interviews,
> prices, or results are described anywhere in this directory. Everything
> is illustrative.

## What this shows

1. **A filled-in venture brief** ([VENTURE_BRIEF.md](VENTURE_BRIEF.md)) —
   note the deliberate honesty markers: labeled beliefs, an admitted lack
   of evidence, and open questions. That is what a good brief looks like.
2. **A filled-in design brief** ([DESIGN_BRIEF.md](DESIGN_BRIEF.md)) —
   principles-not-pixels references and explicit anti-references.
3. **Expected outputs** ([expected/](expected/)) — what the framework's
   deterministic parts produce from these inputs:
   - `thirty-day-cash.txt` — verbatim output of the real calculator run
     against the sample numbers
   - `weekly-report.md` — the real `pnpm weekly` output over synthetic
     inbox CSVs
   - `offer-excerpt.md` — how $offer-architect would structure the offer
     sentence and market-quality table from this brief (illustrative)

## Try it yourself

```bash
# From the repository root:
pnpm tsx skills/offer-architect/scripts/thirty-day-cash.ts \
  --monthly 149 --setup 400 --cac 320 --delivery 25 --onboarding 50

pnpm weekly -- --data examples/sample-venture/data --out /tmp/vh-sample-reports
```

Then compare with [expected/](expected/). The judgement parts (offer
critique, design directions, channel strategy) require running the skills
with a coding agent — see [../prompts/](../prompts/).
