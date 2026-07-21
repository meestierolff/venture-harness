/**
 * Initialize a venture created from the template:
 *  - set the venture name in config/venture.yaml (comments preserved)
 *  - set the package name
 *  - reset PROJECT.md status line and CHANGELOG for the venture
 *
 *   pnpm init:venture -- --name "metermate"
 *
 * Deliberately small: everything substantive happens in $venture-bootstrap
 * after the founder fills in the briefs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { ROOT } from "./lib/util";

const i = process.argv.indexOf("--name");
const name = i !== -1 ? process.argv[i + 1] : undefined;
if (!name || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
  console.error(
    'init-venture: --name required (lowercase, digits, hyphens; e.g. --name "metermate")',
  );
  process.exit(1);
}

// config/venture.yaml — parseDocument preserves comments.
const venturePath = join(ROOT, "config/venture.yaml");
const doc = parseDocument(readFileSync(venturePath, "utf8"));
doc.setIn(["venture", "name"], name);
doc.setIn(["venture", "stage"], "ideation");
writeFileSync(venturePath, doc.toString());
console.log(`config/venture.yaml: name=${name}, stage=ideation`);

// package.json name.
const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
pkg.name = name;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`package.json: name=${name}`);

// PROJECT.md status line.
const projectPath = join(ROOT, "PROJECT.md");
const project = readFileSync(projectPath, "utf8").replace(
  "- Status: TEMPLATE — no venture loaded",
  `- Status: IDEATION — venture "${name}", awaiting $venture-bootstrap`,
);
writeFileSync(projectPath, project);
console.log(`PROJECT.md: status set to ideation for "${name}"`);

// Fresh changelog for the venture.
const changelogPath = join(ROOT, "CHANGELOG.md");
writeFileSync(
  changelogPath,
  `# Changelog — ${name}\n\nStarted from the venture-harness template on ${new Date().toISOString().slice(0, 10)}.\n\n## [Unreleased]\n`,
);
console.log("CHANGELOG.md: reset for the venture");

console.log("\nnext steps:");
console.log("  1. fill in inputs/VENTURE_BRIEF.md and inputs/DESIGN_BRIEF.md");
console.log("  2. open the repo in your coding agent and invoke $venture-bootstrap");
console.log("  3. review the bootstrap output, then pnpm verify");
