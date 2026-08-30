/**
 * Public-release safety check. This inspects the full working directory (not
 * only Git-tracked paths), exact credential-canary fingerprints, and the npm
 * package manifest. History scanning, dependency analysis, and CodeQL are
 * separate CI checks documented in docs/public/PUBLIC_RELEASE_CHECKLIST.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateCredentialFindings,
  scanCredentialText,
  validateReleaseScanAllowlist,
} from "./lib/release-security";
import { ROOT, Reporter, loadYaml, parseCsv, readText, walk } from "./lib/util";

interface PackedFile {
  path: string;
}

interface PackResult {
  files?: PackedFile[];
}

const REQUIRED_PUBLIC_FILES = [
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/dependabot.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/security.yml",
  "docs/security/THREAT_MODEL.md",
  "docs/security/PROVIDER_AUTH_BOUNDARIES.md",
  "docs/audits/PROVIDER_CAPABILITY_MATRIX.md",
  "docs/public/OPEN_SOURCE_READINESS.md",
  "docs/public/PUBLIC_RELEASE_CHECKLIST.md",
];

function readableText(path: string): string | null {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

export function workflowActionRefs(text: string): string[] {
  return [...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
}

export function isPinnedActionRef(ref: string): boolean {
  return ref.startsWith("./") || /^[^@\s]+@[a-f0-9]{40}$/.test(ref);
}

export function sampleHasSurfaceLocalSyntheticLabel(path: string, text: string): boolean {
  if (path.endsWith(".csv")) {
    const rows = parseCsv(text);
    return (
      rows.length > 0 && rows.every((row) => /^SYNTHETIC(?:_|\b)/iu.test(row.evidence_status ?? ""))
    );
  }
  return /\bSYNTHETIC(?:_|\b)/iu.test(text);
}

function lineForOffset(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function main(): never {
  const r = new Reporter("public-release-check");
  const files = walk(ROOT);

  const envFiles = files.filter((file) => {
    const basename = file.split("/").at(-1) ?? "";
    return /^\.env(?:\..+)?$/.test(basename) && basename !== ".env.example";
  });
  if (envFiles.length === 0) r.ok("no release-blocking .env files anywhere in the workspace");
  else {
    for (const file of envFiles) {
      r.fail(
        file,
        "environment file exists in the release workspace",
        "remove it from release media and rotate exposed values",
      );
    }
  }

  try {
    const allowlist = validateReleaseScanAllowlist(
      JSON.parse(readText(".release-scan-allowlist.json")),
    );
    const findings = files.flatMap((file) => {
      const text = readableText(file);
      return text === null ? [] : scanCredentialText(file, text);
    });
    const result = evaluateCredentialFindings(findings, allowlist);
    for (const finding of result.unexpected) {
      r.fail(
        `${finding.path}:${finding.line}`,
        `unexpected ${finding.rule} fingerprint ${finding.sha256}`,
        "remove and rotate real credentials; only exact synthetic canaries may be reviewed into the allowlist",
      );
    }
    for (const entry of result.stale) {
      r.fail(
        `${entry.path}:${entry.line}`,
        `stale ${entry.rule} allowlist fingerprint ${entry.sha256}`,
        "remove the obsolete entry or review the changed synthetic canary at its exact new fingerprint",
      );
    }
    if (result.unexpected.length === 0 && result.stale.length === 0) {
      r.ok(
        `no unexpected credential patterns across ${files.length} workspace files (${result.allowed.length} exact synthetic canaries)`,
      );
    }
  } catch (error) {
    r.fail(
      "credential scanner configuration",
      String(error),
      "repair .release-scan-allowlist.json; scanner configuration errors fail closed",
    );
  }

  if (existsSync(join(ROOT, "LICENSE"))) r.ok("LICENSE present");
  else r.fail("LICENSE", "missing", "restore the repository license");
  const pkg = JSON.parse(readText("package.json")) as {
    license?: string;
    version?: string;
  };
  const framework = loadYaml<{ framework: { license: string; version: string } }>(
    "config/framework.yaml",
  );
  if (pkg.license === framework.framework.license) r.ok("license fields agree");
  else {
    r.fail(
      "license fields",
      `package.json ${JSON.stringify(pkg.license)} != framework.yaml ${JSON.stringify(framework.framework.license)}`,
      "align the reviewed release metadata",
    );
  }
  if (pkg.version === framework.framework.version) r.ok("version fields agree");
  else {
    r.fail(
      "version fields",
      `package.json ${JSON.stringify(pkg.version)} != framework.yaml ${JSON.stringify(framework.framework.version)}`,
      "bump both together per docs/public/TEMPLATE_MAINTENANCE.md",
    );
  }

  const exampleFiles = files.filter(
    (file) => file.startsWith("examples/sample-venture/") && /\.(?:csv|md|mdx|txt)$/u.test(file),
  );
  let examplesLabeled = true;
  for (const file of exampleFiles) {
    if (!sampleHasSurfaceLocalSyntheticLabel(file, readText(file))) {
      examplesLabeled = false;
      r.fail(
        file,
        "sample lacks a surface-local SYNTHETIC label",
        "label text directly; CSV files need evidence_status=SYNTHETIC on every row",
      );
    }
  }
  if (examplesLabeled && exampleFiles.length > 0) {
    r.ok(`sample venture public artifacts labeled synthetic (${exampleFiles.length} files)`);
  }

  const privateDataFiles = files.filter(
    (file) => file.startsWith("memory/") || file.startsWith("data/") || file.startsWith("reports/"),
  );
  const allowedEmailDomains = new Set([
    "example.com",
    "example.org",
    "example.net",
    "example.invalid",
    "users.noreply.github.com",
  ]);
  let piiClean = true;
  for (const file of privateDataFiles) {
    const text = readableText(file);
    if (text === null) continue;
    for (const match of text.matchAll(/[\w.+-]+@([\w.-]+\.[a-z]{2,})/gi)) {
      if (allowedEmailDomains.has(match[1].toLowerCase())) continue;
      piiClean = false;
      r.fail(
        `${file}:${lineForOffset(text, match.index ?? 0)}`,
        "contains a non-reserved email address",
        "remove or irreversibly anonymize private data before release",
      );
    }
  }
  if (piiClean) r.ok("no non-reserved email addresses in memory/, data/, or reports/");

  const inboxData = files.filter((file) => /^data\/(seo|analytics)\/inbox\/.+\.csv$/.test(file));
  if (inboxData.length === 0) r.ok("no analytics/SEO inbox exports in the workspace");
  else {
    for (const file of inboxData) {
      r.fail(
        file,
        "release workspace contains a provider export",
        "remove confidential exports before release",
      );
    }
  }

  for (const file of REQUIRED_PUBLIC_FILES) {
    if (existsSync(join(ROOT, file))) r.ok(`${file} present`);
    else
      r.fail(
        file,
        "required public-security file is missing",
        "add and review the documented control or community contract",
      );
  }

  for (const file of files.filter(
    (path) => path.startsWith(".github/") || path === "SECURITY.md",
  )) {
    const text = readableText(file);
    if (text?.includes("github.com/OWNER/")) {
      r.fail(
        file,
        "contains an unresolved GitHub OWNER placeholder",
        "replace it with the reviewed repository owner before public release",
      );
    }
  }

  const workflowFiles = files.filter((file) => /^\.github\/workflows\/.+\.ya?ml$/.test(file));
  const unpinned = workflowFiles.flatMap((file) => {
    const text = readText(file);
    return workflowActionRefs(text)
      .filter((ref) => !isPinnedActionRef(ref))
      .map((ref) => `${file}: ${ref}`);
  });
  if (unpinned.length === 0)
    r.ok(`all third-party workflow actions pinned (${workflowFiles.length} workflows)`);
  else {
    for (const value of unpinned) {
      r.fail(
        value,
        "action is not pinned to a full commit SHA",
        "resolve the reviewed action tag and pin its 40-character commit SHA",
      );
    }
  }

  const npmCache = mkdtempSync(join(tmpdir(), "vh-release-npm-cache-"));
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: npmCache },
        maxBuffer: 20 * 1024 * 1024,
      }),
    ) as PackResult[];
    const packedFiles = packed.flatMap((entry) => entry.files ?? []).map((entry) => entry.path);
    const requiredPacked = [
      "package.json",
      "README.md",
      "LICENSE",
      "bin/vh.mjs",
      "bin/vh-build-provenance.json",
    ];
    for (const file of requiredPacked) {
      if (!packedFiles.includes(file)) {
        r.fail(
          `npm package ${file}`,
          "required package file is absent",
          "repair the package files manifest and rerun npm pack --dry-run",
        );
      }
    }
    const sensitivePacked = packedFiles.filter((file) =>
      /(^|\/)(?:\.env(?:\.|$)|memory|data|reports|\.venture|tests?|docs\/plans)(?:\/|$)/.test(file),
    );
    if (sensitivePacked.length === 0)
      r.ok(`npm package contents inspected (${packedFiles.length} files)`);
    else {
      for (const file of sensitivePacked) {
        r.fail(
          `npm package ${file}`,
          "sensitive or development-only path would ship",
          "narrow package.json files before publication",
        );
      }
    }
  } catch (error) {
    r.fail(
      "npm pack --dry-run",
      String(error),
      "repair package metadata and inspect the dry-run JSON before release",
    );
  } finally {
    rmSync(npmCache, { recursive: true, force: true });
  }

  try {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/check-agent-parity.ts"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    r.ok("agent parity (generated directories in sync)");
  } catch {
    r.fail(
      "agent parity",
      "direct agent parity check failed",
      "run pnpm agents:sync, review, and commit the generated parity update",
    );
  }

  return r.finish();
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) main();
