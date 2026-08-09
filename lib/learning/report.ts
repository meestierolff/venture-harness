import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { LearningLoopDefinition, LearningReport, OperatingCadence } from "./types";

export interface LearningReportArtifacts {
  json: string;
  markdown: string;
  latestJson: string;
  latestMarkdown: string;
}

export interface OperatingCadenceArtifacts {
  json: string;
  markdown: string;
}

function inside(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    return absolute;
  }
  throw new Error(`Learning report destination escapes the venture root: ${candidate}`);
}

function repositoryPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function renderLearningReportMarkdown(report: LearningReport): string {
  const limitations = report.limitations.length
    ? report.limitations.map((item) => `- ${singleLine(item)}`)
    : ["- None recorded."];
  const actions = report.actions.length
    ? report.actions.map(
        (action) =>
          `- **${singleLine(action.title)}** (${action.disposition}; ${action.confidence.toFixed(2)} confidence) — ${singleLine(action.rationale)}`,
      )
    : ["- None. No action is inferred from missing evidence."];
  const freshness = report.freshness.length
    ? report.freshness.map(
        (entry) =>
          `- ${entry.source}: ${entry.status}; fetched ${entry.fetchedAt ?? "never"}; age ${entry.ageHours ?? "unknown"}h`,
      )
    : ["- No normalized data-source evidence was available."];

  return [
    `# ${singleLine(report.cadence)} learning report`,
    "",
    `- Loop: \`${singleLine(report.loopId)}\``,
    `- Generated: ${report.generatedAt}`,
    `- Status: **${report.status}**`,
    `- Next run: ${report.nextRunAt ?? "not scheduled"}`,
    "",
    "## Freshness",
    "",
    ...freshness,
    "",
    "## Actions",
    "",
    ...actions,
    "",
    "## Limitations",
    "",
    ...limitations,
    "",
    "## Stop condition",
    "",
    singleLine(report.stopCondition),
    "",
  ].join("\n");
}

export function persistLearningReport(args: {
  rootDir: string;
  definition: LearningLoopDefinition;
  report: LearningReport;
}): LearningReportArtifacts {
  const root = resolve(args.rootDir);
  const destination = inside(root, args.definition.outputDestination);
  const stamp = args.report.generatedAt.replace(/[:.]/g, "-");
  const base = `${stamp}-${args.report.loopId.replace(/[^a-z0-9_-]+/gi, "-")}`;
  const jsonPath = inside(destination, `${base}.json`);
  const markdownPath = inside(destination, `${base}.md`);
  const latestJsonPath = inside(destination, "latest.json");
  const latestMarkdownPath = inside(destination, "latest.md");
  const json = `${JSON.stringify(args.report, null, 2)}\n`;
  const markdown = renderLearningReportMarkdown(args.report);

  for (const path of [jsonPath, latestJsonPath]) writeAtomic(path, json);
  for (const path of [markdownPath, latestMarkdownPath]) writeAtomic(path, markdown);

  return {
    json: repositoryPath(root, jsonPath),
    markdown: repositoryPath(root, markdownPath),
    latestJson: repositoryPath(root, latestJsonPath),
    latestMarkdown: repositoryPath(root, latestMarkdownPath),
  };
}

export function renderOperatingCadenceMarkdown(cadence: OperatingCadence): string {
  const items = (values: readonly string[], empty: string) =>
    values.length > 0 ? values.map((value) => `- ${singleLine(value)}`) : [`- ${empty}`];
  return [
    "# Operating cadence",
    "",
    `- Generated: ${cadence.generatedAt}`,
    `- Next daily review: ${cadence.nextDailyReview ?? "not scheduled"}`,
    `- Next weekly review: ${cadence.nextWeeklyReview ?? "not scheduled"}`,
    `- Next biweekly review: ${cadence.nextBiweeklyReview ?? "not scheduled"}`,
    `- Next monthly review: ${cadence.nextMonthlyReview ?? "not scheduled"}`,
    "",
    "## Missing data sources",
    "",
    ...items(cadence.missingDataSources, "None in the latest direct-sync artifact."),
    "",
    "## Active hypotheses",
    "",
    ...items(cadence.activeHypotheses, "None recorded."),
    "",
    "## Active experiments",
    "",
    ...items(cadence.activeExperiments, "None recorded."),
    "",
    "## Active blockers",
    "",
    ...items(cadence.activeBlockers, "None recorded."),
    "",
  ].join("\n");
}

export function persistOperatingCadence(args: {
  rootDir: string;
  cadence: OperatingCadence;
}): OperatingCadenceArtifacts {
  const root = resolve(args.rootDir);
  const jsonPath = inside(root, "reports/learning/operating-cadence.json");
  const markdownPath = inside(root, "reports/learning/operating-cadence.md");
  writeAtomic(jsonPath, `${JSON.stringify(args.cadence, null, 2)}\n`);
  writeAtomic(markdownPath, renderOperatingCadenceMarkdown(args.cadence));
  return {
    json: repositoryPath(root, jsonPath),
    markdown: repositoryPath(root, markdownPath),
  };
}
