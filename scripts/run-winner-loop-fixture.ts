import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { parseGrowthContract } from "../lib/config/growth-contract-schema";
import { runFixtureDThroughProductionBoundaries } from "../lib/winner-loop";

/**
 * Runs the synthetic Winner Loop fixture end to end and writes the creative
 * trace. No provider is contacted and no money moves; the artifact is labelled
 * so it can never be mistaken for evidence of a live run.
 */
const TRACE_PATH = "reports/audit/winner-loop-creative-trace.json";

async function main(): Promise<void> {
  const contract = parseGrowthContract(parse(readFileSync("config/growth.yaml", "utf8")));
  const workspace = mkdtempSync(join(tmpdir(), "vh-fixture-d-"));

  try {
    const result = await runFixtureDThroughProductionBoundaries({
      contract,
      workspaceDirectory: workspace,
      tracePath: TRACE_PATH,
      runId: "winner-loop-fixture-d",
    });
    console.log("SYNTHETIC_FIXTURE — no provider was contacted");
    console.log(`workflow        ${result.runId} (${result.state})`);
    console.log(`command audit   ${result.commandAuditRecords} records`);
    console.log(`provider SDK    ${result.providerOperations.length} fixture lifecycles`);
    console.log(`event pack      ${result.eventPackEvents} first-party events`);
    console.log(`DistributionPR  ${result.distributionProposalId} (fixture proposal only)`);
    console.log(`trace           ${TRACE_PATH}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
