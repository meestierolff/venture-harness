import { appendFile, open, readFile } from "node:fs/promises";
import { Redactor } from "../../../lib/credentials";
import {
  getProviderAdapter,
  type ProviderOperation,
  type ProviderReconciliationResult,
  type ProviderTransport,
  type ProviderTransportContext,
  type ProviderTransportResult,
} from "../../../lib/providers";
import { FileProviderIdempotencyLedger } from "../../../lib/runtime";
import { providerPlanFixtures } from "./requests";

const [ledgerPath, markerPath, callsPath] = process.argv.slice(2);
if (!ledgerPath || !markerPath || !callsPath) throw new Error("worker paths are required");

class ProcessFixtureTransport implements ProviderTransport {
  readonly kind = "http" as const;

  async available(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async execute(
    _operation: ProviderOperation,
    _context: ProviderTransportContext,
  ): Promise<ProviderTransportResult> {
    void _operation;
    void _context;
    await appendFile(callsPath, `${process.pid}\n`, "utf8");
    try {
      const marker = await open(markerPath, "wx", 0o600);
      await marker.writeFile("provider-write\n", "utf8");
      await marker.sync();
      await marker.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Keep the first process between claim and settlement long enough for the
    // other process to observe pending_reconciliation.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      status: "succeeded",
      message: "fixture provider product exists",
      output: { id: "fixture_product" },
      verified: true,
      effectOutcome: "confirmed_write",
    };
  }

  async reconcile(): Promise<ProviderReconciliationResult> {
    try {
      await readFile(markerPath, "utf8");
      return {
        status: "matched",
        message: "fixture provider lookup found the product",
        evidence: { id: "fixture_product" },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { status: "unknown", message: "fixture provider write not visible yet" };
    }
  }
}

async function main(): Promise<void> {
  const adapter = getProviderAdapter("stripe");
  const plan = adapter.plan({
    ...providerPlanFixtures.stripe,
    capabilities: ["product"],
    dryRun: false,
  });
  const report = await adapter.apply(plan, {
    authorization: "approved",
    transports: { http: new ProcessFixtureTransport() },
    redactor: new Redactor(),
    idempotencyLedger: new FileProviderIdempotencyLedger(ledgerPath),
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
