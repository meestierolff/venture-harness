import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { parseGrowthContract } from "../lib/config/growth-contract-schema";
import { buildCreativeTrace, createSqliteSpendStore, runFixtureD } from "../lib/winner-loop";

/**
 * Runs the synthetic Winner Loop fixture end to end and writes the creative
 * trace. No provider is contacted and no money moves; the artifact is labelled
 * so it can never be mistaken for evidence of a live run.
 */
const TRACE_PATH = "reports/audit/winner-loop-creative-trace.json";

async function main(): Promise<void> {
  const contract = parseGrowthContract(parse(readFileSync("config/growth.yaml", "utf8")));
  const workspace = mkdtempSync(join(tmpdir(), "vh-fixture-d-"));
  const store = createSqliteSpendStore(join(workspace, "spend.db"));

  try {
    const result = await runFixtureD({ contract, store });
    const trace = buildCreativeTrace(result);

    mkdirSync(dirname(TRACE_PATH), { recursive: true });
    writeFileSync(TRACE_PATH, `${JSON.stringify(trace, null, 2)}\n`);

    console.log(`${result.label}`);
    console.log(`creative        ${result.creativeId}`);
    console.log(
      `recommendation  ${result.evaluation.recommendation} (${result.evaluation.confidence} confidence)`,
    );
    console.log(
      `readiness       ${result.readiness.stage}, VBO allowed: ${result.readiness.vboAllowed}`,
    );
    console.log(
      `paid gates      unapproved=${result.paidBlockedWithoutApproval}, no-grant=${result.paidBlockedWithoutGrant}`,
    );
    console.log(`settled spend   ${result.settledSpendMinor} minor units`);
    console.log(`cohorts         ${result.cohorts.map((c) => c.window.label).join(", ")}`);
    console.log(
      `learning        ${result.learning.recommendedSurface} (${result.learning.confidence})`,
    );
    console.log(`trace           ${TRACE_PATH}`);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
