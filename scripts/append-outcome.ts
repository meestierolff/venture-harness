/**
 * Append a validated entry to versioned memory. Memory files are
 * append-only JSONL; this script is the only sanctioned writer.
 *
 *   pnpm outcome:add -- --type outcome --summary "..." [--detail "..."] [--source "..."]
 *   pnpm outcome:add -- --type correction --summary "..." --detail "what to do instead"
 *   pnpm outcome:add -- --type customer-language --summary "verbatim phrase" --source "call 2026-07-18"
 *
 * Types map to files: outcome→outcomes.jsonl, correction→corrections.jsonl,
 * customer-language→customer-language.jsonl.
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "./lib/util";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(["outcome", "correction", "customer-language"]),
  summary: z.string().min(10, "summary must say something (>=10 chars)"),
  detail: z.string().optional(),
  source: z.string().optional(),
});

const FILE_BY_TYPE: Record<string, string> = {
  outcome: "memory/outcomes.jsonl",
  correction: "memory/corrections.jsonl",
  "customer-language": "memory/customer-language.jsonl",
};

const candidate = {
  date: new Date().toISOString().slice(0, 10),
  type: argOf("type"),
  summary: argOf("summary"),
  detail: argOf("detail"),
  source: argOf("source"),
};

const parsed = entrySchema.safeParse(candidate);
if (!parsed.success) {
  console.error("append-outcome: invalid entry");
  for (const issue of parsed.error.issues)
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  console.error(
    '→ usage: pnpm outcome:add -- --type outcome|correction|customer-language --summary "..." [--detail "..."] [--source "..."]',
  );
  process.exit(1);
}

// Crude PII guard: memory is committed to git.
if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(JSON.stringify(parsed.data))) {
  console.error(
    "append-outcome: entry contains an email address — memory is committed; anonymize first.",
  );
  process.exit(1);
}

const file = FILE_BY_TYPE[parsed.data.type];
if (!existsSync(join(ROOT, file))) {
  console.error(`append-outcome: ${file} missing — restore it from the template.`);
  process.exit(1);
}
appendFileSync(join(ROOT, file), JSON.stringify(parsed.data) + "\n");
console.log(`appended to ${file}: ${parsed.data.summary.slice(0, 80)}`);
