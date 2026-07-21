/**
 * File a self-improvement proposal as a plan document. Proposals are the
 * ONLY sanctioned self-improvement path: an agent proposes, a human merges.
 *
 *   pnpm improve:propose -- --title "Promote consent copy into COPY.md" \
 *     --evidence "corrections.jsonl 2026-07-14, 2026-07-18" \
 *     --score-before "verify-consent warns weekly" \
 *     --success "no consent-copy correction for 4 weeks"
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/util";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const title = argOf("title");
const evidence = argOf("evidence");
const scoreBefore = argOf("score-before") ?? "not measured — state why";
const success = argOf("success");

if (!title || !evidence || !success) {
  console.error("propose-improvement: --title, --evidence and --success are required.");
  console.error("A proposal without cited evidence and a success criterion is not reviewable.");
  process.exit(1);
}

const dir = join(ROOT, "docs/plans/active");
const existing = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{3}-/.test(f)) : [];
const next = String(
  existing.reduce((max, f) => Math.max(max, Number(f.slice(0, 3))), 0) + 1,
).padStart(3, "0");
const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 50);
const file = `${next}-proposal-${slug}.md`;

const body = `# Proposal ${next}: ${title}

- Status: proposed — awaiting human review
- Owner: (agent-filed; human reviewer required)
- Created: ${new Date().toISOString().slice(0, 10)}

## One conceptual change

${title}

## Evidence

${evidence}

## Score before

${scoreBefore}

## Success criterion (score after must show)

${success}

## Revert rule

If the relevant evaluation does not improve by the next weekly review,
this change is reverted. Negative outcomes are retained in memory.

## Approval

Merging this proposal is a human action. No agent may self-merge,
self-deploy, publish, or send communication on the basis of this file.
`;

writeFileSync(join(dir, file), body);
console.log(`proposal filed: docs/plans/active/${file}`);
console.log("→ next: human review; merge or reject; record the outcome with pnpm outcome:add");
