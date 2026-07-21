# Codex bootstrap prompt

Paste into OpenAI Codex after creating a repository from the template and
filling in the briefs:

```
Read AGENTS.md, then PROJECT.md, then docs/plans/active/.

Use the venture-bootstrap skill (.agents/skills/venture-bootstrap/SKILL.md).
Inputs are inputs/VENTURE_BRIEF.md, inputs/DESIGN_BRIEF.md, and
inputs/RESEARCH.md.

Follow the skill exactly:
- interrogate the briefs before writing anything; list contradictions,
  missing evidence, and unmeasurable goals in PROJECT.md
- do not write application code — bootstrap produces documents, config,
  and a plan only
- run the thirty-day cash calculator script, never model arithmetic
- finish with pnpm verify and report per the AGENTS.md progress format
  (what changed / what failed or is unknown / what should happen next)
```
