/**
 * Public-release safety check. Run before making the repository public or
 * tagging a template release. Mechanical checks only — the human half of
 * the checklist lives in docs/public/PUBLIC_RELEASE_CHECKLIST.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Reporter, readText, loadYaml } from "./lib/util";

const r = new Reporter("public-release-check");

// Tracked files come from git so .gitignore is respected.
let tracked: string[] = [];
try {
  tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  r.fail(
    "git",
    "not a git repository or git unavailable",
    "run inside the repo with git installed",
  );
  r.finish();
}

// 1. No env files tracked ----------------------------------------------------
const envTracked = tracked.filter(
  (f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example"),
);
if (envTracked.length === 0) r.ok("no .env files tracked");
else
  for (const f of envTracked)
    r.fail(f, "environment file is tracked", "git rm --cached it; secrets never enter git");

// 2. Secret patterns ---------------------------------------------------------
// Patterns are assembled from parts so this file does not match itself.
const SECRET_PATTERNS: [RegExp, string][] = [
  [new RegExp("AKIA" + "[0-9A-Z]{16}"), "AWS access key"],
  [new RegExp("-----BEGIN " + "(RSA |EC |OPENSSH )?PRIVATE KEY"), "private key"],
  [new RegExp("gh[pousr]_" + "[A-Za-z0-9]{30,}"), "GitHub token"],
  [new RegExp("sk-" + "[A-Za-z0-9]{20,}"), "API secret key"],
  [new RegExp("xox[baprs]-" + "[A-Za-z0-9-]{10,}"), "Slack token"],
  [new RegExp("postgres(ql)?:\\/\\/[^\\s\"']+:[^\\s\"']+@"), "database URL with credentials"],
];
const SELF = "scripts/public-release-check.ts";
let secretsClean = true;
for (const f of tracked) {
  if (f === SELF || f === "pnpm-lock.yaml") continue;
  if (!existsSync(join(ROOT, f))) continue;
  let text: string;
  try {
    text = readText(f);
  } catch {
    continue; // binary
  }
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(text)) {
      secretsClean = false;
      r.fail(
        f,
        `contains a ${what} pattern`,
        "remove the credential and rotate it — history rewrite may be needed",
      );
    }
  }
}
if (secretsClean) r.ok(`no credential patterns across ${tracked.length} tracked files`);

// 3. License and version coherence ------------------------------------------
if (existsSync(join(ROOT, "LICENSE"))) r.ok("LICENSE present");
else r.fail("LICENSE", "missing", "restore the MIT license file");
const pkg = JSON.parse(readText("package.json")) as { license?: string; version?: string };
const framework = loadYaml<{ framework: { license: string; version: string } }>(
  "config/framework.yaml",
);
if (pkg.license === framework.framework.license) r.ok("license fields agree");
else
  r.fail(
    "license fields",
    `package.json "${pkg.license}" != framework.yaml "${framework.framework.license}"`,
    "align them",
  );
if (pkg.version === framework.framework.version) r.ok("version fields agree");
else
  r.fail(
    "version fields",
    `package.json "${pkg.version}" != framework.yaml "${framework.framework.version}"`,
    "bump both together (docs/public/TEMPLATE_MAINTENANCE.md)",
  );

// 4. Synthetic material labeled ---------------------------------------------
const exampleFiles = tracked.filter(
  (f) => f.startsWith("examples/sample-venture/") && f.endsWith(".md"),
);
let labeled = true;
for (const f of exampleFiles) {
  if (!/SYNTHETIC/i.test(readText(f))) {
    labeled = false;
    r.fail(
      f,
      "sample-venture file lacks a SYNTHETIC label",
      "label all example material as synthetic",
    );
  }
}
if (labeled && exampleFiles.length > 0)
  r.ok(`sample venture labeled synthetic (${exampleFiles.length} files)`);

// 5. No personal data in committed memory/data ------------------------------
const memoryFiles = tracked.filter((f) => f.startsWith("memory/") || f.startsWith("data/"));
let memClean = true;
for (const f of memoryFiles) {
  if (!existsSync(join(ROOT, f))) continue;
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(readText(f))) {
    memClean = false;
    r.fail(
      f,
      "contains an email address",
      "anonymize before committing — memory/data are public with the repo",
    );
  }
}
if (memClean) r.ok("no email addresses in committed memory/ or data/");

// 6. Real analytics exports should not ship with the template ----------------
const inboxData = tracked.filter((f) => /^data\/(seo|analytics)\/inbox\/.+\.csv$/.test(f));
if (inboxData.length === 0) r.ok("no analytics/SEO exports committed in inboxes");
else
  for (const f of inboxData)
    r.fail(
      f,
      "export file committed in an inbox",
      "inboxes are working areas; delete before release (real market data is venture-confidential)",
    );

// 7. Generated dirs in sync --------------------------------------------------
try {
  execFileSync("pnpm", ["agents:check"], { stdio: ["ignore", "pipe", "pipe"] });
  r.ok("agent parity (generated dirs in sync)");
} catch {
  r.fail("agent parity", "pnpm agents:check failing", "run pnpm agents:sync and commit");
}

r.finish();
