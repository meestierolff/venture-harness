/**
 * Eval runner. Every evals/<domain>/*.eval.yaml is either:
 *   kind: deterministic — has a `command`, executed here, pass/fail
 *   kind: rubric        — has `criteria`, applied by an agent/human with
 *                         judgement; this runner validates structure and
 *                         lists the criteria (it cannot judge)
 * Important changes are gated on the deterministic set plus a completed
 * rubric pass where the change touches that domain.
 *
 *   pnpm tsx evals/run-all.ts [--domain offer]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const ROOT = process.cwd();

const evalSchema = z.discriminatedUnion("kind", [
  z.object({
    name: z.string().min(3),
    kind: z.literal("deterministic"),
    description: z.string().min(10),
    command: z.string().min(3),
  }),
  z.object({
    name: z.string().min(3),
    kind: z.literal("rubric"),
    description: z.string().min(10),
    criteria: z.array(z.string().min(5)).min(1),
    applied_by: z.string().min(3),
  }),
]);

const domainFlag = process.argv.indexOf("--domain");
const onlyDomain = domainFlag !== -1 ? process.argv[domainFlag + 1] : null;

const evalsDir = join(ROOT, "evals");
const domains = readdirSync(evalsDir)
  .filter((entry) => statSync(join(evalsDir, entry)).isDirectory())
  .filter((entry) => (onlyDomain ? entry === onlyDomain : true))
  .sort();

let failures = 0;
let deterministicCount = 0;
let rubricCount = 0;

for (const domain of domains) {
  const files = readdirSync(join(evalsDir, domain)).filter((f) => f.endsWith(".eval.yaml"));
  if (files.length === 0) {
    console.log(`FAIL ${domain}: no .eval.yaml files → add at least one eval or remove the domain`);
    failures++;
    continue;
  }
  for (const file of files.sort()) {
    const rel = `evals/${domain}/${file}`;
    const parsed = evalSchema.safeParse(parse(readFileSync(join(ROOT, rel), "utf8")));
    if (!parsed.success) {
      console.log(`FAIL ${rel}: invalid eval spec (${parsed.error.issues[0].message})`);
      failures++;
      continue;
    }
    const spec = parsed.data;
    if (spec.kind === "deterministic") {
      deterministicCount++;
      try {
        const [bin, ...args] = spec.command.split(/\s+/);
        execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        console.log(`PASS ${rel} (${spec.name})`);
      } catch {
        console.log(`FAIL ${rel} (${spec.name}): command failed → ${spec.command}`);
        failures++;
      }
    } else {
      rubricCount++;
      console.log(
        `RUBRIC ${rel} (${spec.name}) — ${spec.criteria.length} criteria, applied by ${spec.applied_by}`,
      );
    }
  }
}

console.log(
  `\nevals: ${deterministicCount} deterministic run, ${rubricCount} rubric(s) listed, ${failures} failure(s)`,
);
if (!existsSync(join(evalsDir, "run-all.ts"))) failures++; // self-check sanity
process.exit(failures > 0 ? 1 : 0);
