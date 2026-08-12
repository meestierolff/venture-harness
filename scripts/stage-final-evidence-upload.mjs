#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  FINAL_EVIDENCE_LEDGER_PATH,
  assertFinalEvidenceSource,
  finalEvidenceLogDirectory,
  finalEvidenceOutputPaths,
  validateFinalEvidenceLedger,
} from "./lib/final-evidence-source.mjs";

export const FINAL_EVIDENCE_PORTABLE_PATHS = Object.freeze([
  "reports/audit/founder-alpha-evidence.json",
  "reports/audit/founder-alpha-requirements.json",
  "reports/audit/github-readback.json",
  "reports/audit/quality-release.json",
  "reports/audit/quality-live.json",
  "reports/audit/seed-closure.json",
  "reports/audit/winner-loop-creative-trace.json",
  "reports/audit/vh-v0.2-codex-requirement-matrix.json",
  "docs/plans/active/VH_V02_CODEX_COMPLETION_MATRIX.md",
  "docs/plans/active/VH_V02_WINNER_LOOP_COMPLETION_MATRIX.md",
]);

function repositoryFile(root, path) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`portable evidence path must be repository-relative: ${path}`);
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new Error(`portable evidence path must stay inside the repository: ${path}`);
  }
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`portable evidence is absent or not a regular file: ${path}`);
  }
  return absolute;
}

export function stageFinalEvidenceUpload({ rootDirectory, outputDirectory }) {
  const root = realpathSync(rootDirectory);
  const output = resolve(outputDirectory);
  const fromRoot = relative(root, output);
  if (!fromRoot || (!fromRoot.startsWith("../") && !isAbsolute(fromRoot))) {
    throw new Error("portable evidence staging directory must be outside the repository");
  }
  if (existsSync(output)) {
    throw new Error(`portable evidence staging directory already exists: ${output}`);
  }
  const ledger = JSON.parse(readFileSync(resolve(root, FINAL_EVIDENCE_LEDGER_PATH), "utf8"));
  validateFinalEvidenceLedger(ledger);
  const logDirectory = finalEvidenceLogDirectory(ledger.sourceSha);
  const recordPaths = ledger.records.flatMap((record) => [
    record.evidencePath,
    ...(Array.isArray(record.artifacts) ? record.artifacts.map(({ path }) => path) : []),
  ]);
  for (const record of ledger.records) {
    if (!record.evidencePath.startsWith(logDirectory)) {
      throw new Error(
        `command ${record.id ?? "<unknown>"} log is outside source-scoped evidence: ${record.evidencePath}`,
      );
    }
  }
  const paths = [FINAL_EVIDENCE_LEDGER_PATH, ...recordPaths, ...FINAL_EVIDENCE_PORTABLE_PATHS];
  const uniquePaths = [...new Set(paths)].sort();
  assertFinalEvidenceSource({
    root,
    expected: ledger,
    allowedPaths: finalEvidenceOutputPaths(ledger, FINAL_EVIDENCE_PORTABLE_PATHS),
  });
  for (const path of uniquePaths) {
    const source = repositoryFile(root, path);
    const destination = resolve(output, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return Object.freeze({ sourceSha: ledger.sourceSha, paths: Object.freeze(uniquePaths) });
}

const outputIndex = process.argv.indexOf("--output");
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (!output || outputIndex !== process.argv.length - 2) {
    console.error(
      "usage: node scripts/stage-final-evidence-upload.mjs --output <outside-repository-directory>",
    );
    process.exit(1);
  }
  try {
    const staged = stageFinalEvidenceUpload({
      rootDirectory: process.cwd(),
      outputDirectory: output,
    });
    console.log(`staged ${staged.paths.length} portable evidence files for ${staged.sourceSha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
