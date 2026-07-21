/**
 * Event-taxonomy lockstep verification:
 *  - config/analytics.yaml events == lib/analytics/taxonomy.ts events
 *    (names, destinations, consent, props, neon, experiment flags)
 *  - every track() call site uses a taxonomy event name
 *  - every experiment's activation/exposure/primary metric event exists
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Reporter, readText, loadYaml, walk } from "./lib/util";
import { analyticsSchema, experimentsSchema } from "../lib/config/schemas";
import { EVENTS } from "../lib/analytics/taxonomy";

const r = new Reporter("verify-analytics-events");
const config = analyticsSchema.parse(loadYaml("config/analytics.yaml"));

const yamlNames = new Set(Object.keys(config.events));
const tsNames = new Set(Object.keys(EVENTS));

let lockstep = true;
for (const name of yamlNames) {
  if (!tsNames.has(name)) {
    lockstep = false;
    r.fail(
      `event ${name}`,
      "in config/analytics.yaml but not lib/analytics/taxonomy.ts",
      "add it to the typed taxonomy",
    );
  }
}
for (const name of tsNames) {
  if (!yamlNames.has(name)) {
    lockstep = false;
    r.fail(
      `event ${name}`,
      "in taxonomy.ts but not config/analytics.yaml",
      "declare it in the config contract",
    );
  }
}
for (const name of yamlNames) {
  if (!tsNames.has(name)) continue;
  const y = config.events[name];
  const t = EVENTS[name as keyof typeof EVENTS];
  const yd = [...y.destinations].sort().join(",");
  const td = [...t.destinations].sort().join(",");
  if (yd !== td) {
    lockstep = false;
    r.fail(`event ${name} destinations`, `yaml [${yd}] != ts [${td}]`, "align the two definitions");
  }
  if (y.consent !== t.consent) {
    lockstep = false;
    r.fail(
      `event ${name} consent`,
      `yaml "${y.consent}" != ts "${t.consent}"`,
      "align the two definitions",
    );
  }
  if (y.neon !== t.neon) {
    lockstep = false;
    r.fail(`event ${name} neon`, `yaml ${y.neon} != ts ${t.neon}`, "align the two definitions");
  }
  const yp = [...y.props].sort().join(",");
  const tp = [...t.props].sort().join(",");
  if (yp !== tp) {
    lockstep = false;
    r.fail(`event ${name} props`, `yaml [${yp}] != ts [${tp}]`, "align allowed properties");
  }
}
if (lockstep) r.ok(`taxonomy in lockstep (${yamlNames.size} events)`);

// track() call sites use known event names ----------------------------------
const codeFiles = ["app", "components", "lib"]
  .filter((d) => existsSync(join(ROOT, d)))
  .flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith("lib/analytics/"));
let callsClean = true;
let calls = 0;
for (const f of codeFiles) {
  for (const m of readText(f).matchAll(/track\(\s*"([a-z0-9_]+)"/g)) {
    calls++;
    if (!tsNames.has(m[1])) {
      callsClean = false;
      r.fail(
        `${f}`,
        `track("${m[1]}") is not a taxonomy event`,
        "add the event to the taxonomy or fix the name",
      );
    }
  }
}
if (callsClean) r.ok(`${calls} track() call site(s) use taxonomy events`);

// experiments reference real events -----------------------------------------
const experiments = experimentsSchema.parse(loadYaml("config/experiments.yaml"));
let expClean = true;
for (const exp of experiments.experiments) {
  for (const [field, ev] of [
    ["activation_event", exp.activation_event],
    ["exposure_event", exp.exposure_event],
    ["primary_metric", exp.primary_metric],
    ...exp.secondary_metrics.map((s: string) => ["secondary_metric", s] as [string, string]),
  ] as [string, string][]) {
    if (!yamlNames.has(ev)) {
      expClean = false;
      r.fail(
        `${exp.id} ${field}`,
        `"${ev}" is not a taxonomy event`,
        "use an event from config/analytics.yaml",
      );
    }
  }
}
if (expClean) r.ok("experiment definitions reference taxonomy events only");

r.finish();
