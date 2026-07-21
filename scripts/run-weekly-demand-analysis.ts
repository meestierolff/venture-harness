/**
 * Weekly demand analysis — deterministic aggregation only. Reads whatever
 * evidence exists (SEO inbox CSVs, analytics inbox CSVs, memory JSONL,
 * dev-fallback evidence) and writes the weekly report skeleton with data
 * sections filled and judgement sections left for the $weekly-learning
 * skill. Missing inputs are reported by exact expected filename.
 *
 *   pnpm weekly                       # current ISO week, data/ inboxes
 *   pnpm weekly -- --week 2026-W29 --data data --out reports/weekly
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, parseCsv } from "./lib/util";

function argOf(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function isoWeek(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const week = argOf("week", isoWeek());
const dataDir = argOf("data", "data");
const outDir = argOf("out", "reports/weekly");

interface SectionResult {
  title: string;
  body: string;
}

function noData(expected: string): string {
  return `NO DATA — expected file: \`${expected}\`. Export it and rerun \`pnpm weekly\`.`;
}

function readCsvIfExists(rel: string): Record<string, string>[] | null {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  return parseCsv(readFileSync(abs, "utf8"));
}

const sections: SectionResult[] = [];

// --- SEO: GSC queries -------------------------------------------------------
{
  const rel = `${dataDir}/seo/inbox/gsc-queries.csv`;
  const rows = readCsvIfExists(rel);
  if (!rows) sections.push({ title: "Search queries (GSC)", body: noData(rel) });
  else {
    const parsedRows = rows
      .map((row) => ({
        query: row.query ?? "",
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        position: Number(row.position ?? 0),
      }))
      .filter((q) => q.query !== "");
    const opportunities = parsedRows
      .filter((q) => q.position >= 6 && q.position <= 20 && q.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);
    const lowCtr = parsedRows
      .filter(
        (q) =>
          q.position < 6 && q.impressions >= 20 && q.clicks / Math.max(q.impressions, 1) < 0.02,
      )
      .slice(0, 10);
    const fmt = (q: (typeof parsedRows)[number]) =>
      `| ${q.query} | ${q.impressions} | ${q.clicks} | ${q.position.toFixed(1)} |`;
    sections.push({
      title: "Search queries (GSC)",
      body: [
        `${parsedRows.length} queries in export.`,
        "",
        "**Positions 6–20 with impressions (page or content opportunity):**",
        "",
        "| Query | Impressions | Clicks | Position |",
        "| --- | --- | --- | --- |",
        ...(opportunities.length > 0 ? opportunities.map(fmt) : ["| (none) | | | |"]),
        "",
        "**Low CTR at useful positions (<2% CTR above position 6):**",
        "",
        "| Query | Impressions | Clicks | Position |",
        "| --- | --- | --- | --- |",
        ...(lowCtr.length > 0 ? lowCtr.map(fmt) : ["| (none) | | | |"]),
      ].join("\n"),
    });
  }
}

// --- SEO: pages + Bing + AI referrers --------------------------------------
for (const [title, rel, cols] of [
  [
    "Page performance (GSC)",
    `${dataDir}/seo/inbox/gsc-pages.csv`,
    ["page", "impressions", "clicks"],
  ],
  ["Bing queries", `${dataDir}/seo/inbox/bing-queries.csv`, ["query", "impressions", "clicks"]],
  ["AI referrers", `${dataDir}/analytics/inbox/ai-referrers.csv`, ["referrer", "sessions"]],
] as [string, string, string[]][]) {
  const rows = readCsvIfExists(rel);
  if (!rows) sections.push({ title, body: noData(rel) });
  else {
    const top = rows.slice(0, 15);
    sections.push({
      title,
      body: [
        `${rows.length} rows in export. Top ${top.length}:`,
        "",
        `| ${cols.join(" | ")} |`,
        `| ${cols.map(() => "---").join(" | ")} |`,
        ...top.map((row) => `| ${cols.map((c) => row[c] ?? "").join(" | ")} |`),
      ].join("\n"),
    });
  }
}

// --- Memory: outcomes / experiments / corrections ---------------------------
function jsonlCount(rel: string): { count: number; lastLines: string[] } {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { count: 0, lastLines: [] };
  const lines = readFileSync(abs, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  return { count: lines.length, lastLines: lines.slice(-3) };
}
{
  const parts: string[] = [];
  for (const rel of [
    "memory/outcomes.jsonl",
    "memory/experiments.jsonl",
    "memory/corrections.jsonl",
    "memory/customer-language.jsonl",
  ]) {
    const { count, lastLines } = jsonlCount(rel);
    parts.push(
      `- \`${rel}\`: ${count} entries${count > 0 ? ` (latest: ${lastLines[lastLines.length - 1].slice(0, 120)}…)` : ""}`,
    );
  }
  sections.push({ title: "Versioned memory", body: parts.join("\n") });
}

// --- First-party evidence (dev fallback only; production uses Neon exports) -
{
  const rel = ".data/evidence.jsonl";
  const { count } = jsonlCount(rel);
  sections.push({
    title: "First-party evidence",
    body:
      count > 0
        ? `Local dev fallback holds ${count} events (\`${rel}\`). Production analysis uses Neon exports — place them in \`${dataDir}/analytics/inbox/\`.`
        : `No local fallback events. Production analysis uses Neon exports in \`${dataDir}/analytics/inbox/\`.`,
  });
}

// --- Compose report ---------------------------------------------------------
const report = [
  `# Weekly demand report — ${week}`,
  "",
  `Generated by \`pnpm weekly\` (deterministic aggregation). Judgement`,
  `sections below are completed by the $weekly-learning skill; this script`,
  `never interprets.`,
  "",
  "## Data",
  "",
  ...sections.flatMap((s) => [`### ${s.title}`, "", s.body, ""]),
  "## Judgement (completed by $weekly-learning)",
  "",
  "### What the market did this week",
  "",
  "_pending analysis_",
  "",
  "### Hypothesis and threshold movement",
  "",
  "_pending analysis_",
  "",
  "### Experiment status (per pre-declared rules)",
  "",
  "_pending analysis_",
  "",
  "### The one proposed change (or explicit do-nothing)",
  "",
  "_pending analysis — cite exact evidence, prior score, success criterion_",
  "",
].join("\n");

mkdirSync(join(ROOT, outDir), { recursive: true });
const outPath = join(ROOT, outDir, `${week}.md`);
writeFileSync(outPath, report);
console.log(`weekly report written: ${outDir}/${week}.md`);
const missing = sections.filter((s) => s.body.startsWith("NO DATA"));
if (missing.length > 0) {
  console.log(
    `note: ${missing.length} section(s) had no data — the report lists the expected filenames.`,
  );
}
