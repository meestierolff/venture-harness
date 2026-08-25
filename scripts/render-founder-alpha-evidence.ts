import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type FounderAlphaCatalog,
  type FounderAlphaLedger,
  renderFounderAlphaEvidence,
} from "./lib/founder-alpha-evidence";
import {
  FINAL_EVIDENCE_LEDGER_PATH,
  assertFinalEvidenceSource,
  finalEvidenceOutputPaths,
  validateFinalEvidenceLedger,
} from "./lib/final-evidence-source.mjs";

const catalogPath = "reports/audit/founder-alpha-requirements.json";
const outputPath = "reports/audit/founder-alpha-evidence.json";
const legacyOutputPaths = [
  "reports/audit/quality-release.json",
  "reports/audit/quality-live.json",
  "reports/audit/seed-closure.json",
  "reports/audit/winner-loop-creative-trace.json",
  "reports/audit/vh-v0.2-codex-requirement-matrix.json",
  "docs/plans/active/VH_V02_CODEX_COMPLETION_MATRIX.md",
  "docs/plans/active/VH_V02_WINNER_LOOP_COMPLETION_MATRIX.md",
];

const root = realpathSync(process.cwd());
const ledger = JSON.parse(
  readFileSync(resolve(root, FINAL_EVIDENCE_LEDGER_PATH), "utf8"),
) as FounderAlphaLedger;
validateFinalEvidenceLedger(ledger);
const allowedPaths = finalEvidenceOutputPaths(ledger, [...legacyOutputPaths, outputPath]);
assertFinalEvidenceSource({ root, expected: ledger, allowedPaths });

const catalog = JSON.parse(readFileSync(resolve(root, catalogPath), "utf8")) as FounderAlphaCatalog;
const report = renderFounderAlphaEvidence({ root, catalog, ledger, catalogPath });
const absoluteOutput = resolve(root, outputPath);
mkdirSync(dirname(absoluteOutput), { recursive: true });
const temporaryOutput = `${absoluteOutput}.${process.pid}.tmp`;
writeFileSync(temporaryOutput, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryOutput, absoluteOutput);

assertFinalEvidenceSource({ root, expected: ledger, allowedPaths });
console.log(
  `founder-alpha evidence ${report.classification ?? report.reportStatus}: ${JSON.stringify(report.counts)} (${report.sourceSha})`,
);
