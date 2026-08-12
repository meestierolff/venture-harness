# SOURCES

Ideas and prior art that shaped this framework. Listed for transparency;
no document here is reproduced, and no endorsement by these sources is
implied.

## Founder-method influences

The founder principles are Venture Harness's own synthesis. They adapt ideas
from the following public material without reproducing a source's text, code, or
paid/private teaching:

- Basecamp's public [Shape Up: Set Boundaries](https://basecamp.com/shapeup/1.2-chapter-03)
  and [Place Your Bets](https://basecamp.com/shapeup/2.3-chapter-09) informed the
  small-bet, explicit-boundary, and fixed-review framing.
- The Christensen Institute's public
  [Jobs to Be Done overview](https://www.christenseninstitute.org/theory/jobs-to-be-done/)
  informed the focus on one user's concrete progress rather than a feature list.
- The Lean Startup's public
  [Validated Learning principle](https://lean.st/principles/validated-learning/)
  informed the observed-behavior and evidence-led review loop. Venture Harness
  uses its own `continue`, `change`, or `stop` decision vocabulary.
- Paul Graham's public
  [Do Things That Don't Scale](https://www.paulgraham.com/ds.html) informed the
  preference for learning through a narrow launch before building a platform or
  automating a guessed workflow.

The boring default Stack, explicit commitment surface, deterministic-plumbing
boundary, and token-efficiency objective are Venture Harness design choices,
not claims made or endorsed by those sources. Continuous-delivery quality-gate
ideas also inform the separation between a request, an accepted effect, and a
verified read-back.

## Agent-harness influences

- The emerging `AGENTS.md` convention: one canonical instruction file that
  multiple coding agents read, with thin per-agent adapters.
- Anthropic's skills format (`SKILL.md` with name/description frontmatter)
  for reusable procedures separated from project state.
- The general pattern of "map, not encyclopedia" instruction files:
  navigation over duplication.

## Tooling defaults

- Next.js (App Router), Vercel Web Analytics, Google Analytics 4, Neon
  Postgres, Google Search Console, Bing Webmaster Tools, Zod, Vitest.

All product names are trademarks of their owners.
