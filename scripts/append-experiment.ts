/**
 * Append an experiment result record to memory/experiments.jsonl.
 * Results REQUIRE exposure counts and limitations — a result without
 * exposure data is not reportable in this framework.
 *
 *   pnpm experiment:add -- --id exp-001-... --decision adopt \
 *     --exposures '{"control":412,"variant_b":398}' \
 *     --primary '{"control":0.031,"variant_b":0.052}' \
 *     --limitations "single channel; consented subset only"
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT, loadYaml } from "./lib/util";
import { experimentsSchema } from "../lib/config/schemas";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const recordSchema = z.object({
  date: z.string(),
  id: z.string().regex(/^exp-\d{3}-[a-z0-9-]+$/),
  decision: z.enum(["adopt", "reject", "rerun", "inconclusive"]),
  exposures: z.record(z.number().int().nonnegative()),
  primary: z.record(z.number()),
  limitations: z.string().min(10, "state the sample limitations — always"),
});

const candidate = {
  date: new Date().toISOString().slice(0, 10),
  id: argOf("id"),
  decision: argOf("decision"),
  exposures: argOf("exposures") ? JSON.parse(argOf("exposures")!) : undefined,
  primary: argOf("primary") ? JSON.parse(argOf("primary")!) : undefined,
  limitations: argOf("limitations"),
};

const parsed = recordSchema.safeParse(candidate);
if (!parsed.success) {
  console.error("append-experiment: invalid record — results need exposures AND limitations.");
  for (const issue of parsed.error.issues)
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

// The experiment must exist in the register.
const { experiments } = experimentsSchema.parse(loadYaml("config/experiments.yaml"));
if (!experiments.some((e) => e.id === parsed.data.id)) {
  console.error(
    `append-experiment: "${parsed.data.id}" is not in config/experiments.yaml — record the definition first.`,
  );
  process.exit(1);
}

appendFileSync(join(ROOT, "memory/experiments.jsonl"), JSON.stringify(parsed.data) + "\n");
console.log(`appended experiment result: ${parsed.data.id} → ${parsed.data.decision}`);
