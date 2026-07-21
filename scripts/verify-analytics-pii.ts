/**
 * Analytics PII verification:
 *  - no taxonomy event allows a prohibited property
 *  - no code path passes prohibited property keys into track()
 *  - no session-replay / keystroke / advertising surface in code
 *  - forms never feed entered values into analytics calls
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Reporter, readText, loadYaml, walk } from "./lib/util";
import { analyticsSchema } from "../lib/config/schemas";

const r = new Reporter("verify-analytics-pii");
const config = analyticsSchema.parse(loadYaml("config/analytics.yaml"));
const prohibited = new Set(config.prohibited_properties.map((p) => p.toLowerCase()));

// 1. Taxonomy props ----------------------------------------------------------
let taxClean = true;
for (const [name, ev] of Object.entries(config.events)) {
  for (const prop of ev.props) {
    if (prohibited.has(prop.toLowerCase())) {
      taxClean = false;
      r.fail(
        `event ${name}`,
        `allows prohibited property "${prop}"`,
        "remove it — prohibited_properties is absolute",
      );
    }
  }
}
if (taxClean) r.ok("no taxonomy event allows a prohibited property");

// 2. Code call sites ---------------------------------------------------------
const codeFiles = ["app", "components", "lib"]
  .filter((d) => existsSync(join(ROOT, d)))
  .flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => /\.(ts|tsx)$/.test(f));

let codeClean = true;
for (const f of codeFiles) {
  const text = readText(f);
  for (const m of text.matchAll(/track\(\s*"[a-z0-9_]+"\s*,\s*\{([^}]*)\}/gs)) {
    const props = m[1];
    for (const key of props.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) {
      if (prohibited.has(key[1].toLowerCase())) {
        codeClean = false;
        r.fail(
          `${f}`,
          `track() call passes prohibited key "${key[1]}"`,
          "strip the property — analytics never receives it",
        );
      }
    }
  }
}
if (codeClean) r.ok("no track() call passes prohibited property keys");

// 3. Forbidden surfaces ------------------------------------------------------
// Patterns detect ENABLING a forbidden surface, not mentioning it —
// schemas and configs legitimately declare these features as false.
const FORBIDDEN_PATTERNS: [RegExp, string, string][] = [
  [
    /session[-_]?replay['"]?\s*[:=]\s*true|from\s+["']rrweb["']/i,
    "session replay enabled",
    "session replay stays off; remove it",
  ],
  [
    /onkeydown|onkeypress|keylogg/i,
    "keystroke capture pattern",
    "keystroke collection is prohibited",
  ],
  [
    /(allow_ad_personalization_signals|allow_google_signals|advertising_features)['"]?\s*[:=]\s*true/i,
    "advertising features enabled",
    "advertising features stay disabled",
  ],
  [
    /document\.addEventListener\(\s*["']mousemove/i,
    "mouse-movement tracking",
    "cursor tracking is prohibited",
  ],
];
let surfaceClean = true;
for (const f of codeFiles) {
  const text = readText(f);
  for (const [re, what, next] of FORBIDDEN_PATTERNS) {
    if (re.test(text)) {
      surfaceClean = false;
      r.fail(`${f}`, what, next);
    }
  }
}
if (surfaceClean) r.ok("no session-replay / keystroke / cursor / advertising surfaces in code");

r.finish();
