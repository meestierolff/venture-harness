#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const testRoot = resolve(root, "tests");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const forbidden = [
  { kind: "focused_or_skipped", pattern: /\b(?:describe|it|test)\.(?:only|skip|todo)\b/g },
  { kind: "disabled_alias", pattern: /\b(?:xdescribe|xit|xtest)\s*\(/g },
  {
    kind: "weak_constant_assertion",
    pattern: /\bexpect\s*\(\s*(?:true|false)\s*\)\s*\.toBe\s*\(/g,
  },
];
const findings = [];
const testFiles = files(testRoot)
  .filter((path) => path.endsWith(".test.ts"))
  .sort();
let assertions = 0;
for (const path of testFiles) {
  const source = readFileSync(path, "utf8");
  assertions += [...source.matchAll(/\bexpect\s*\(/g)].length;
  for (const rule of forbidden) {
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      findings.push({
        kind: rule.kind,
        path: relative(root, path),
        line,
      });
    }
  }
}

const result = {
  status: findings.length === 0 ? "passed" : "failed",
  files: testFiles.length,
  assertions,
  forbiddenFindings: findings,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (findings.length > 0) process.exitCode = 1;
