/**
 * Validate project documents: required documents exist (config/quality.yaml)
 * and every project document carries the standard contract — Status/Owner/
 * Last updated metadata plus Purpose, Evidence, Assumptions, Unresolved
 * questions, Related documents sections. Also validates all config/ files
 * against their Zod schemas.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Reporter, readText, loadYaml, walk } from "./lib/util";
import { configSchemas } from "../lib/config/schemas";

const r = new Reporter("validate-docs");

// 1. Config contracts --------------------------------------------------------
for (const [file, schema] of Object.entries(configSchemas)) {
  if (!existsSync(join(ROOT, file))) {
    r.fail(file, "config file missing", "restore it from the template");
    continue;
  }
  const parsed = schema.safeParse(loadYaml(file));
  if (parsed.success) r.ok(`${file} schema`);
  else {
    const first = parsed.error.issues[0];
    r.fail(
      `${file} schema`,
      `${first.path.join(".")}: ${first.message}`,
      "fix the config to match lib/config/schemas.ts",
    );
  }
}

// 2. Required documents ------------------------------------------------------
const quality = loadYaml<{ required_documents: string[] }>("config/quality.yaml");
for (const doc of quality.required_documents) {
  if (existsSync(join(ROOT, doc))) r.ok(`required doc ${doc}`);
  else r.fail(`required doc ${doc}`, "missing", "restore it — required by config/quality.yaml");
}

// 3. Project-document contract ----------------------------------------------
const PROJECT_DOC_DIRS = ["docs/business", "docs/product", "docs/brand", "docs/growth"];
const EXTRA_PROJECT_DOCS = [
  "PROJECT.md",
  "docs/engineering/ANALYTICS.md",
  "docs/legal/ANALYTICS_AND_CONSENT.md",
  "inputs/VENTURE_BRIEF.md",
  "inputs/DESIGN_BRIEF.md",
  "inputs/RESEARCH.md",
];
const REQUIRED_META = ["- Status:", "- Owner:", "- Last updated:"];
const REQUIRED_SECTIONS = [
  "## Purpose",
  "## Evidence",
  "## Assumptions",
  "## Unresolved questions",
  "## Related documents",
];
// Input briefs are founder-facing free-form; they need metadata only.
const METADATA_ONLY = new Set([
  "inputs/VENTURE_BRIEF.md",
  "inputs/DESIGN_BRIEF.md",
  "inputs/RESEARCH.md",
]);

const projectDocs: string[] = [...EXTRA_PROJECT_DOCS];
for (const dir of PROJECT_DOC_DIRS) {
  if (existsSync(join(ROOT, dir)))
    projectDocs.push(...walk(join(ROOT, dir)).filter((f) => f.endsWith(".md")));
}

let contractClean = true;
for (const doc of projectDocs) {
  if (!existsSync(join(ROOT, doc))) continue;
  const text = readText(doc);
  const missing: string[] = [];
  for (const meta of REQUIRED_META) if (!text.includes(meta)) missing.push(meta);
  if (!METADATA_ONLY.has(doc))
    for (const s of REQUIRED_SECTIONS) if (!text.includes(s)) missing.push(s);
  if (missing.length > 0) {
    contractClean = false;
    r.fail(
      `${doc} contract`,
      `missing ${missing.join(", ")}`,
      "add the standard project-document metadata/sections",
    );
  }
}
if (contractClean) r.ok(`${projectDocs.length} project documents follow the contract`);

// 4. One active plan discipline ---------------------------------------------
const activePlans = walk(join(ROOT, "docs/plans/active")).filter(
  (file) => file.endsWith(".md") && !file.endsWith("-brief.md") && !file.endsWith("_MATRIX.md"),
);
if (activePlans.length === 0)
  r.fail(
    "active plan",
    "docs/plans/active/ has no plan",
    "create one (see templates/plans/) — agents need an active plan",
  );
else if (activePlans.length > 3)
  r.fail(
    "active plan focus",
    `${activePlans.length} active plans`,
    "complete or archive plans; keep focus (≤3, ideally 1)",
  );
else r.ok(`active plan present (${activePlans.length})`);

r.finish();
