# Generic frontier-agent guide

For any agent that can read and edit the repository:

1. Read [AGENTS.md](../../AGENTS.md), [PROJECT.md](../../PROJECT.md),
   [PRODUCT_TRUTH.md](../product/PRODUCT_TRUTH.md) and the active plan.
2. Load the relevant canonical `skills/<name>/SKILL.md` procedure.
3. Read typed config before inferring venture, provider or authorization state.
4. Plan external effects through the provider/runtime contracts; never serialize
   credentials or call a successful request “verified” without read-back.
5. Keep local reversible work moving under progressive commitment; stop for
   deception, unsafe defaults, indispensable missing auth or effects outside the
   envelope.
6. Run `pnpm verify` and the applicable staged quality profile before completion.

Cursor, Windsurf and other agents should point to AGENTS.md rather than duplicate
it. Publication, deploy, send, charge, merge and production mutation remain
bounded by explicit user authorization and the active run envelope.
