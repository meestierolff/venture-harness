#!/usr/bin/env node

import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  FINAL_EVIDENCE_LEDGER_PATH,
  assertFinalEvidenceSource,
  createFinalEvidenceLedger,
  readFinalEvidenceSource,
} from "./lib/final-evidence-source.mjs";

const root = realpathSync(process.cwd());
const source = readFinalEvidenceSource(root);
assertFinalEvidenceSource({ root, expected: source });
const ledger = createFinalEvidenceLedger(source);
const ledgerPath = resolve(root, FINAL_EVIDENCE_LEDGER_PATH);
mkdirSync(dirname(ledgerPath), { recursive: true });
const temporaryPath = `${ledgerPath}.${process.pid}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
renameSync(temporaryPath, ledgerPath);
console.log(`initialized final evidence for ${source.branch}@${source.sourceSha}`);
