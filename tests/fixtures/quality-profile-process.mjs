import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [profile, reportPath, mode] = process.argv.slice(2);
if (!profile || !reportPath || !mode) process.exit(2);
const status = mode === "pass" ? "PASS" : mode === "skip" ? "INCOMPLETE" : "FAIL";
const summary = {
  PASS: mode === "pass" ? 1 : 0,
  FAIL: mode === "fail" ? 1 : 0,
  SKIP: mode === "skip" ? 1 : 0,
  NOT_APPLICABLE: 0,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  reportPath,
  `${JSON.stringify({ profile, status, passed: status === "PASS", summary })}\n`,
  { mode: 0o600 },
);
process.stdout.write(`profile=${profile} canary=${process.env.VH_QUALITY_TEST_SECRET ?? "none"}\n`);
if (mode === "fail") process.exit(1);
