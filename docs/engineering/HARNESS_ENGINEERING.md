# HARNESS_ENGINEERING

How this repository stays operable by agents — and how it gets better
instead of merely bigger. Procedure: `skills/harness-engineering/SKILL.md`.

## The core loop

1. An agent run fails, gets corrected, or needs the same explanation twice.
2. The correction is recorded: `pnpm outcome:add` →
   `memory/corrections.jsonl`.
3. `$harness-engineering` (or `$weekly-learning`) reviews recurring
   corrections and promotes them into the cheapest durable form:

   | Failure shape                   | Promote into                     |
   | ------------------------------- | -------------------------------- |
   | Agent misses a fact             | the relevant doc (not AGENTS.md) |
   | Agent misreads a hypothesis     | `config/*.yaml` field + schema   |
   | Agent breaks an invariant       | a test or verify script          |
   | Agent produces off-style output | an eval in `evals/`              |
   | Agent misuses a tool/command    | the skill's SKILL.md             |
   | Everything else, rarely         | AGENTS.md                        |

Do not solve recurring failures by endlessly growing AGENTS.md. The
constitution is a map; growth pressure goes into scripts, tests, and skills.

## Audit checklist

Run through this list during `$harness-engineering`:

- Instruction size: is AGENTS.md still under ~150 lines? Are adapters thin?
- Stale docs: does any doc describe behaviour the code no longer has?
- Missing architecture: any subsystem without an ARCHITECTURE/ADR entry?
- Code/docs drift: `pnpm validate:claims`, `pnpm validate:links` clean?
- Unclear commands: does every documented command exist in package.json?
- Weak errors: do scripts fail with the exact next action to take?
- Missing tests: any invariant only enforced by prose?
- Unclear boundaries: any skill whose "files it may change" is vague?
- Unsupported claims: anything public without a PRODUCT_TRUTH row?
- Active plans without updates: stale files in docs/plans/active/?
- Repeated corrections: same entry shape 3× in corrections.jsonl?
- Unverifiable tasks: any task an agent cannot check with a command?
- Uninspectable analytics: can an agent read every event's contract?
- Consent behaviour without tests: any consent path uncovered?

## Conventions

- Scripts print `OK <check>` / `FAIL <check>: <reason> → <next action>`.
- Every script is idempotent and safe to run twice.
- Generated directories carry a marker and are never hand-edited.
- One active plan at a time under `docs/plans/active/`.

## Related

- [../../skills/harness-engineering/SKILL.md](../../skills/harness-engineering/SKILL.md)
- [../plans/TECH_DEBT.md](../plans/TECH_DEBT.md)
- [../../memory/LEARNINGS.md](../../memory/LEARNINGS.md)
