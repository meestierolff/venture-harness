import { appendFileSync, existsSync } from "node:fs";
import { SqliteAuditChain } from "../../packages/audit/src/index";
import {
  CommandBus,
  SqliteIdempotencyStore,
  defineCommandContract,
} from "../../packages/command-bus/src/index";
import type { JsonObject } from "../../packages/core/src/index";
import { SqliteEventLog } from "../../packages/events/src/index";
import { SqliteMeteringSink } from "../../packages/telemetry/src/index";

const [databasePath, effectPath, startPath, value = "same"] = process.argv.slice(2);
if (!databasePath || !effectPath || !startPath) throw new Error("missing worker arguments");

while (!existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

const objectSchema = {
  name: "AtomicCommandObject",
  jsonSchema: { type: "object" } as const,
  parse(candidate: unknown): JsonObject {
    if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") {
      throw new Error("input must be an object");
    }
    return JSON.parse(JSON.stringify(candidate)) as JsonObject;
  },
};
const contract = defineCommandContract({
  id: "atomic.execute",
  version: 1,
  title: "Execute Atomic Effect",
  description: "Concurrency proof command.",
  input: objectSchema,
  output: objectSchema,
  requirements: { activeSubscription: false, entitlements: [], grant: true, scopes: [] },
  meter: "atomic_effects",
});
const idempotency = new SqliteIdempotencyStore(databasePath, { pendingTimeoutMs: 5_000 });
const audit = new SqliteAuditChain(`${databasePath}.audit.sqlite`);
const events = new SqliteEventLog(`${databasePath}.events.sqlite`);
const metering = new SqliteMeteringSink(`${databasePath}.metering.sqlite`);
const bus = new CommandBus(
  {
    identity() {},
    tenant() {},
    subscription() {},
    entitlement() {},
    grant() {},
    scope() {},
    idempotency,
    audit,
    events,
    metering,
  },
  { executionMode: "production" },
);
bus.register(contract, async (input) => {
  appendFileSync(effectPath, `${process.pid}:${String(input.value)}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { accepted: true, value: input.value };
});

async function main(): Promise<void> {
  try {
    const output = await bus.execute(
      contract,
      { value },
      {
        context: {
          identity: { actorId: "process-worker", kind: "service" },
          tenant: { organizationId: "atomic-org", ventureId: "atomic-venture" },
          subscription: { subscriptionId: "sub", status: "active", plan: "test" },
          entitlements: [],
          grants: [],
          scopes: [],
        },
        idempotencyKey: "shared-process-key",
      },
    );
    process.stdout.write(`${JSON.stringify({ status: "success", output })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "error",
        code: error && typeof error === "object" && "code" in error ? error.code : "unknown",
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  } finally {
    idempotency.close();
    audit.close();
    events.close();
    metering.close();
  }
}

void main();
