import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  FileFixtureAssetVault,
  FileFixtureCommandIdempotencyStore,
  createFileWinnerProviderFixtureStore,
} from "../../../lib/winner-integrations/capability-bridge";
import type { WinnerProviderFixtureRecord } from "../../../lib/winner-integrations/providers";

const [mode, databasePath, startPath, prefix, countText = "1", requestTag = "same"] =
  process.argv.slice(2);
if (!mode || !databasePath || !startPath || !prefix) throw new Error("missing worker arguments");
const count = Number(countText);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid worker count");

while (!existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

const tenant = { organizationId: "fixture-worker-org", ventureId: "fixture-worker-venture" };

function providerRecord(idempotencyKey: string): WinnerProviderFixtureRecord {
  const requestHash = createHash("sha256").update(`${idempotencyKey}:${requestTag}`).digest("hex");
  return {
    adapterId: "fixture_local_renderer",
    tenant,
    operationId: `operation-${idempotencyKey}`,
    idempotencyKey,
    requestHash,
    feature: "creative_render",
    output: {
      fixture_only: true,
      creative_id: `creative-${idempotencyKey}`,
      render_job_id: `render-${requestHash.slice(0, 12)}`,
      renderer_kind: "local_fixture",
      asset_ref: `fixture://creative/${requestHash.slice(0, 16)}`,
      content_hash: requestHash,
    },
    appliedAt: "2026-08-09T12:00:00.000Z",
    fixtureLabel: "SYNTHETIC_FIXTURE — no provider was contacted",
  };
}

function main(): void {
  if (mode === "provider") {
    const store = createFileWinnerProviderFixtureStore(databasePath);
    for (let index = 0; index < count; index += 1) {
      const key = `${prefix}-${index}`;
      store.put(providerRecord(key));
    }
    process.stdout.write(`${JSON.stringify({ status: "success", size: store.size() })}\n`);
    return;
  }
  if (mode === "command") {
    const store = new FileFixtureCommandIdempotencyStore(databasePath);
    try {
      const outcomes: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const key = `${prefix}-${index}`;
        const requestHash = `sha256:${createHash("sha256").update(`${key}:${requestTag}`).digest("hex")}`;
        const ownerToken = `owner-${process.pid}-${index}`;
        const claim = store.claim(key, {
          requestHash,
          ownerToken,
          now: "2026-08-09T12:00:00.000Z",
        });
        outcomes.push(claim.kind);
        if (claim.kind === "owner") {
          store.complete(key, {
            requestHash,
            ownerToken,
            output: { accepted: true, key },
            occurredAt: "2026-08-09T12:00:00.000Z",
            completedAt: "2026-08-09T12:00:01.000Z",
            actorId: "fixture-worker",
            artifactsEmittedAt: null,
          });
        }
      }
      process.stdout.write(`${JSON.stringify({ status: "success", outcomes })}\n`);
    } finally {
      store.close();
    }
    return;
  }
  if (mode === "asset") {
    const vault = new FileFixtureAssetVault(databasePath);
    for (let index = 0; index < count; index += 1) {
      const key = `${prefix}-${index}`;
      vault.put(
        tenant,
        key,
        "text/plain",
        new TextEncoder().encode(`fixture-${key}-${requestTag}`),
      );
    }
    process.stdout.write(`${JSON.stringify({ status: "success" })}\n`);
    return;
  }
  throw new Error("unknown worker mode");
}

try {
  main();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
