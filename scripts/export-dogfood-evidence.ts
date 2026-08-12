import { resolve } from "node:path";
import { exportDogfoodEvidenceBundle } from "../lib/runtime/dogfood-evidence-bundle";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ventureRoot = option("--venture-root");
const runId = option("--run-id");
const sourceSha = option("--source-sha");
const output = option("--output") ?? "reports/dogfood/launch-receipt/bundle";

if (!ventureRoot || !runId || !sourceSha) {
  throw new Error(
    "Usage: pnpm evidence:dogfood -- --venture-root <independent-child> --run-id <run-id> --source-sha <reviewed-harness-sha> [--output <new-directory>]",
  );
}

const manifest = exportDogfoodEvidenceBundle({
  ventureRoot: resolve(ventureRoot),
  runId,
  harnessSourceSha: sourceSha,
  outputDirectory: resolve(output),
});

console.log(
  `Dogfood evidence bundle ${manifest.runId}: ${manifest.artifacts.length} hash-bound artifacts at ${resolve(output)}/manifest.json`,
);
