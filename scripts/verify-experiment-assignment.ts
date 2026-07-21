/**
 * Experiment assignment verification:
 *  - config/experiments.yaml validates against the schema
 *  - variant weights sum to 1 per experiment
 *  - one core concept per experiment (single type)
 *  - assignment is deterministic (same visitor -> same variant, always)
 *  - assignment distribution approximates declared weights
 */
import type { z } from "zod";
import { Reporter, loadYaml } from "./lib/util";
import { experimentsSchema, type experimentSchema } from "../lib/config/schemas";
import { assignVariant } from "../lib/experiments";

const r = new Reporter("verify-experiment-assignment");

const parsed = experimentsSchema.safeParse(loadYaml("config/experiments.yaml"));
if (!parsed.success) {
  const first = parsed.error.issues[0];
  r.fail(
    "experiments.yaml schema",
    `${first.path.join(".")}: ${first.message}`,
    "fix config/experiments.yaml to match lib/config/schemas.ts",
  );
  process.exit(1);
}
const experiments: z.infer<typeof experimentSchema>[] = parsed.data.experiments;
r.ok(`experiments.yaml schema valid (${experiments.length} experiment(s))`);

for (const exp of experiments) {
  const total = exp.variants.reduce((s, v) => s + v.weight, 0);
  if (Math.abs(total - 1) > 0.001)
    r.fail(`${exp.id} weights`, `sum to ${total}`, "allocation weights must sum to 1.0");
  else r.ok(`${exp.id} weights sum to 1`);

  const keys = new Set(exp.variants.map((v) => v.key));
  if (keys.size !== exp.variants.length)
    r.fail(`${exp.id} variant keys`, "duplicate variant keys", "make variant keys unique");
  if (exp.min_duration_days > exp.max_duration_days)
    r.fail(`${exp.id} duration`, "min > max", "fix the duration bounds");

  // Determinism: 500 repeated assignments for the same visitor agree.
  const weights = exp.variants.map((v) => ({ key: v.key, weight: v.weight }));
  const first = assignVariant("visitor-determinism-test", exp.id, weights);
  let deterministic = true;
  for (let i = 0; i < 500; i++) {
    if (assignVariant("visitor-determinism-test", exp.id, weights) !== first) {
      deterministic = false;
      break;
    }
  }
  if (deterministic) r.ok(`${exp.id} assignment deterministic`);
  else
    r.fail(
      `${exp.id} assignment`,
      "non-deterministic result",
      "assignVariant must be a pure hash of (visitorId, experimentId)",
    );

  // Distribution: 20k synthetic visitors approximate weights within 3pp.
  const counts = new Map<string, number>();
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const v = assignVariant(`synthetic-visitor-${i}`, exp.id, weights);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let distOk = true;
  for (const v of exp.variants) {
    const share = (counts.get(v.key) ?? 0) / N;
    if (Math.abs(share - v.weight) > 0.03) {
      distOk = false;
      r.fail(
        `${exp.id} distribution`,
        `variant ${v.key} got ${(share * 100).toFixed(1)}% vs declared ${(v.weight * 100).toFixed(1)}%`,
        "check the hash bucketing in lib/experiments.ts",
      );
    }
  }
  if (distOk) r.ok(`${exp.id} distribution matches weights (±3pp over ${N} visitors)`);
}

r.finish();
