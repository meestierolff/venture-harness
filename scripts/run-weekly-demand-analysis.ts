/**
 * Deterministic weekly aggregation. Direct normalized datasets are primary;
 * legacy CSV inboxes remain a labeled compatibility fallback. Missing values
 * remain missing and this script applies no business or SEO thresholds.
 *
 *   pnpm weekly
 *   pnpm weekly -- --datasets .venture/data/latest.json
 *   pnpm weekly -- --fixture --week 2026-W32
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DataSyncResult, NormalizedDataset, NormalizedScalar } from "../lib/data/types";
import { syncScheduledAnalyticsFixture } from "../lib/analytics/scheduled-fixture";
import { ROOT, parseCsv } from "./lib/util";

function argOf(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${flag}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function isoWeek(date = new Date()): string {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface SectionResult {
  title: string;
  body: string;
}

export interface ReportInput {
  week: string;
  datasets: NormalizedDataset[];
  freshness: DataSyncResult["freshness"];
  failures: DataSyncResult["failures"];
  fixture: boolean;
  dataDir: string;
  includeLegacyFallback: boolean;
}

function markdown(value: NormalizedScalar | undefined): string {
  if (value === null || value === undefined || value === "") return "missing";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function noData(expected: string, command = "pnpm vh data sync"): string {
  return [
    `MISSING — no dataset was available at \`${expected}\`; missing is not zero.`,
    `Run \`${command}\` and rerun this report.`,
  ].join(" ");
}

function parseSyncFile(path: string): DataSyncResult {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as DataSyncResult | NormalizedDataset[];
  if (Array.isArray(parsed)) return { datasets: parsed, failures: [], freshness: [] };
  if (
    !Array.isArray(parsed.datasets) ||
    !Array.isArray(parsed.failures) ||
    !Array.isArray(parsed.freshness)
  ) {
    throw new Error(`${path} is not a normalized data-sync artifact`);
  }
  return parsed;
}

function renderDataset(dataset: NormalizedDataset): SectionResult {
  const provenance = dataset.provenance;
  const columns = [...new Set(dataset.rows.flatMap((row) => Object.keys(row)))].sort();
  const rows = dataset.rows.slice(0, 15);
  const metadata = [
    `- Source: \`${provenance.source}\``,
    `- Account/property: \`${provenance.sourceAccount}\``,
    `- Fetched: \`${provenance.fetchedAt}\``,
    `- Window: \`${provenance.reportingWindow.start}\` to \`${provenance.reportingWindow.end}\``,
    `- Timezone: \`${provenance.timezone}\``,
    `- Quality: \`${provenance.quality}\``,
    `- Release: ${provenance.releaseVersion ? `\`${provenance.releaseVersion}\`` : "not supplied"}`,
    `- Limitations: ${provenance.limitations.length > 0 ? provenance.limitations.join("; ") : "none reported"}`,
  ];
  if (columns.length === 0 || rows.length === 0) {
    return {
      title: `${provenance.source} — ${dataset.id}`,
      body: [...metadata, "", "No rows returned; this is not interpreted as zero activity."].join(
        "\n",
      ),
    };
  }
  return {
    title: `${provenance.source} — ${dataset.id}`,
    body: [
      ...metadata,
      "",
      `Showing ${rows.length} of ${dataset.rows.length} row(s) without interpretation:`,
      "",
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${columns.map((column) => markdown(row[column])).join(" | ")} |`),
    ].join("\n"),
  };
}

function readCsvIfExists(root: string, relativePath: string): Record<string, string>[] | null {
  const path = join(root, relativePath);
  if (!existsSync(path)) return null;
  return parseCsv(readFileSync(path, "utf8"));
}

function renderLegacyCsv(
  root: string,
  title: string,
  relativePath: string,
  columns: string[],
): SectionResult {
  const rows = readCsvIfExists(root, relativePath);
  if (!rows) return { title, body: noData(relativePath) };
  const shown = rows.slice(0, 15);
  return {
    title,
    body: [
      "LEGACY CSV FALLBACK — provenance, freshness, sampling, and threshold metadata may be incomplete.",
      `${rows.length} row(s); showing ${shown.length} without thresholding or opportunity scoring.`,
      "",
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
      ...shown.map(
        (row) =>
          `| ${columns.map((column) => markdown(row[column] === "" ? null : row[column])).join(" | ")} |`,
      ),
    ].join("\n"),
  };
}

function versionedMemorySection(root: string): SectionResult {
  const lines: string[] = [];
  for (const relativePath of [
    "memory/outcomes.jsonl",
    "memory/experiments.jsonl",
    "memory/corrections.jsonl",
    "memory/customer-language.jsonl",
  ]) {
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      lines.push(`- \`${relativePath}\`: MISSING (not zero entries)`);
      continue;
    }
    const entries = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    lines.push(
      `- \`${relativePath}\`: ${entries.length} recorded entr${entries.length === 1 ? "y" : "ies"}`,
    );
  }
  return { title: "Versioned memory", body: lines.join("\n") };
}

export function buildWeeklyReport(root: string, input: ReportInput): string {
  const sections: SectionResult[] = input.datasets.map(renderDataset);
  if (input.datasets.length === 0 && input.includeLegacyFallback) {
    sections.push(
      renderLegacyCsv(root, "Search queries (GSC)", `${input.dataDir}/seo/inbox/gsc-queries.csv`, [
        "query",
        "impressions",
        "clicks",
        "position",
      ]),
      renderLegacyCsv(root, "Page performance (GSC)", `${input.dataDir}/seo/inbox/gsc-pages.csv`, [
        "page",
        "impressions",
        "clicks",
      ]),
      renderLegacyCsv(root, "Bing queries", `${input.dataDir}/seo/inbox/bing-queries.csv`, [
        "query",
        "impressions",
        "clicks",
      ]),
      renderLegacyCsv(root, "AI referrers", `${input.dataDir}/analytics/inbox/ai-referrers.csv`, [
        "referrer",
        "sessions",
      ]),
    );
  }
  sections.push(versionedMemorySection(root));

  const freshness =
    input.freshness.length === 0
      ? ["MISSING — no freshness ledger was supplied; no source is treated as fresh or zero."]
      : input.freshness.map(
          (entry) =>
            `- \`${entry.source}\`: ${entry.status}; fetched=${entry.fetchedAt ?? "missing"}; age_hours=${entry.ageHours ?? "missing"}; limit_hours=${entry.freshnessHours}; ${entry.limitation ?? "no limitation reported"}`,
        );
  const failures =
    input.failures.length === 0
      ? ["No connector failures were reported by the supplied sync artifact."]
      : input.failures.map(
          (failure) =>
            `- \`${failure.source}\` ${failure.code}: ${failure.message} Next: ${failure.nextAction}`,
        );

  return [
    `# Weekly demand report — ${input.week}`,
    "",
    input.fixture
      ? "> SYNTHETIC FIXTURE — pipeline verification only. Nothing below is market evidence."
      : "Generated from normalized direct datasets when available; legacy CSV is fallback only.",
    "",
    "This deterministic report applies no opportunity, CTR, traffic, or commercial thresholds.",
    "Judgement remains with the bounded learning loop and its pre-declared rules.",
    "",
    "## Data freshness and connector status",
    "",
    ...freshness,
    "",
    ...failures,
    "",
    "## Data",
    "",
    ...sections.flatMap((section) => [`### ${section.title}`, "", section.body, ""]),
    "## Judgement (completed by the learning-loop engine)",
    "",
    "### What the market did this week",
    "",
    "_pending analysis; cite normalized source, account, window, freshness, and limitations_",
    "",
    "### Hypothesis and decision-rule movement",
    "",
    "_pending analysis against pre-declared venture rules_",
    "",
    "### Experiment status (only when an experiment pack is active)",
    "",
    "_pending analysis; exposures and limitations are required_",
    "",
    "### Bounded proposed actions",
    "",
    "_pending analysis; at most three non-bug actions and one conceptual change per journey_",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const week = argOf("week", isoWeek())!;
  const dataDir = argOf("data", "data")!;
  const outDir = argOf("out", "reports/weekly")!;
  const explicitPath = argOf("datasets");
  const syncOut = argOf("sync-out");
  const defaultPath = join(ROOT, ".venture/data/latest.json");
  const fixture = process.argv.includes("--fixture");
  let sync: DataSyncResult;
  if (fixture) sync = syncScheduledAnalyticsFixture(new Date());
  else if (explicitPath) sync = parseSyncFile(resolve(ROOT, explicitPath));
  else if (existsSync(defaultPath)) sync = parseSyncFile(defaultPath);
  else sync = { datasets: [], failures: [], freshness: [] };

  if (syncOut) {
    const syncPath = resolve(ROOT, syncOut);
    mkdirSync(dirname(syncPath), { recursive: true });
    writeFileSync(syncPath, `${JSON.stringify(sync, null, 2)}\n`, { mode: 0o600 });
    console.log(`data sync artifact written: ${relativePath(ROOT, syncPath)}`);
  }
  if (process.argv.includes("--sync-only")) {
    if (!syncOut) throw new Error("--sync-only requires --sync-out <path>");
    return;
  }

  const synthetic =
    fixture ||
    (sync.datasets.length > 0 &&
      sync.datasets.every((dataset) =>
        dataset.provenance.limitations.some((limitation) => limitation.includes("SYNTHETIC")),
      ));

  const report = buildWeeklyReport(ROOT, {
    week,
    datasets: sync.datasets,
    freshness: sync.freshness,
    failures: sync.failures,
    fixture: synthetic,
    dataDir,
    includeLegacyFallback: true,
  });
  const outPath = resolve(ROOT, outDir, `${week}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report);
  console.log(`weekly report written: ${relativePath(ROOT, outPath)}`);
  if (synthetic) console.log("data mode: SYNTHETIC scheduled-sync fixture (not market evidence)");
  else if (sync.datasets.length === 0) {
    console.log("data gap: no normalized direct dataset; legacy inboxes are labeled fallback");
    if (process.argv.includes("--require-data")) process.exit(2);
  }
}

function relativePath(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) void main();
