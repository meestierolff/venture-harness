import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SpendError,
  ProviderOperationError,
  createMemorySpendStore,
  createSpendLedger,
  createSqliteSpendStore,
  type ReserveInput,
  type SpendGrantInput,
  type SpendLedger,
  type SpendStore,
} from "@/lib/winner-loop";

const APPROVED_AT = new Date("2026-08-08T09:00:00.000Z");
const ORGANIZATION = "org-payout-rank";

const openStores: SpendStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openStores.length) openStores.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function sqliteStore(): SpendStore {
  const dir = mkdtempSync(join(tmpdir(), "vh-spend-"));
  tempDirs.push(dir);
  const store = createSqliteSpendStore(join(dir, "spend.db"));
  openStores.push(store);
  return store;
}

/** A second independent client onto the same database file. */
function sameFileStore(path: string): SpendStore {
  const store = createSqliteSpendStore(path);
  openStores.push(store);
  return store;
}

function clock(start = APPROVED_AT) {
  let current = start;
  return {
    now: () => current,
    advanceHours(hours: number) {
      current = new Date(current.getTime() + hours * 3_600_000);
    },
  };
}

function grantInput(overrides: Partial<SpendGrantInput> = {}): SpendGrantInput {
  return {
    network: "tiktok_paid",
    externalAccountId: "tt-ads-1",
    currency: "EUR",
    totalMinorUnits: 20_000,
    perCreativeMinorUnits: 10_000,
    dailyAccountMinorUnits: 12_000,
    allowedCreativeIds: ["cr_AAAAAAAAAAAAAAAAAAAAAAAAAA", "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB"],
    approvedBy: "founder@example.com",
    approvalRef: "checkpoint:paid-test-001",
    proposalId: "prop-001",
    notBefore: APPROVED_AT.toISOString(),
    expiresAt: new Date("2026-08-15T09:00:00.000Z").toISOString(),
    ...overrides,
    organizationId: overrides.organizationId ?? ORGANIZATION,
    ventureId: overrides.ventureId ?? "payout-rank",
  };
}

let seed = 0;
function ledgerOn(store: SpendStore, now: () => Date = () => APPROVED_AT): SpendLedger {
  seed += 1;
  const local = seed;
  return createSpendLedger({
    store,
    now,
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, i) => (i + local * 13) % 256),
  });
}

function withGrant(overrides: Partial<SpendGrantInput> = {}) {
  const time = clock();
  const store = sqliteStore();
  const ledger = ledgerOn(store, time.now);
  const grant = ledger.registerGrant(grantInput(overrides));
  return { ledger, grant, time, store };
}

let idempotencyCounter = 0;
function reserveInput(overrides: Partial<ReserveInput> & { grantId: string }): ReserveInput {
  idempotencyCounter += 1;
  return {
    creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
    campaignId: "camp-1",
    amountMinorUnits: 1_000,
    idempotencyKey: `key-${idempotencyCounter}`,
    ...overrides,
    organizationId: overrides.organizationId ?? ORGANIZATION,
    ventureId: overrides.ventureId ?? "payout-rank",
  };
}

function reservationRef(
  grant: { organizationId: string; ventureId: string },
  reservationId: string,
) {
  return { ...grant, reservationId };
}

function errorFrom(run: () => unknown): SpendError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SpendError);
    return error as SpendError;
  }
  throw new Error("expected the call to throw");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for concurrent spend workers");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("transactional concurrency across independent clients", () => {
  it("isolates identical grant and retry identities across canonical organization scopes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-spend-organizations-"));
    tempDirs.push(dir);
    const path = join(dir, "spend.db");
    const firstStore = sameFileStore(path);
    const secondStore = sameFileStore(path);
    const fixedRandom = (size: number) =>
      Uint8Array.from({ length: size }, (_, index) => (index * 3 + 7) % 256);
    const firstLedger = createSpendLedger({
      store: firstStore,
      now: () => APPROVED_AT,
      randomBytes: fixedRandom,
    });
    const secondLedger = createSpendLedger({
      store: secondStore,
      now: () => APPROVED_AT,
      randomBytes: fixedRandom,
    });
    const firstGrant = firstLedger.registerGrant(
      grantInput({ organizationId: "org-boundary", ventureId: "venture" }),
    );
    const secondGrant = secondLedger.registerGrant(
      grantInput({ organizationId: "org", ventureId: "boundary-venture" }),
    );

    expect(secondGrant.grantId).toBe(firstGrant.grantId);
    const firstReservation = firstLedger.reserve(
      reserveInput({
        organizationId: firstGrant.organizationId,
        ventureId: firstGrant.ventureId,
        grantId: firstGrant.grantId,
        campaignId: "shared-campaign",
        idempotencyKey: "shared\0retry",
        amountMinorUnits: 6_000,
      }),
    );
    const secondReservation = secondLedger.reserve(
      reserveInput({
        organizationId: secondGrant.organizationId,
        ventureId: secondGrant.ventureId,
        grantId: secondGrant.grantId,
        campaignId: "shared-campaign",
        idempotencyKey: "shared\0retry",
        amountMinorUnits: 4_000,
      }),
    );

    expect(firstLedger.reservedMinorUnits(firstGrant)).toBe(6_000);
    expect(secondLedger.reservedMinorUnits(secondGrant)).toBe(4_000);
    expect(firstLedger.getReservation(firstReservation)?.heldMinorUnits).toBe(6_000);
    expect(secondLedger.getReservation(secondReservation)?.heldMinorUnits).toBe(4_000);
    expect(
      firstLedger.getGrant({
        organizationId: "unconfigured-organization",
        ventureId: firstGrant.ventureId,
        grantId: firstGrant.grantId,
      }),
    ).toBeUndefined();
    firstLedger.activateKillSwitch(firstGrant, "organization-local stop");
    expect(firstLedger.isHalted(firstGrant)).toBe(true);
    expect(secondLedger.isHalted(secondGrant)).toBe(false);
  });

  it("serializes truly simultaneous reservations from separate Node processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-spend-process-"));
    tempDirs.push(dir);
    const path = join(dir, "spend.db");
    const parentStore = sameFileStore(path);
    const parentLedger = ledgerOn(parentStore);
    const grant = parentLedger.registerGrant(
      grantInput({
        totalMinorUnits: 10_000,
        perCreativeMinorUnits: 10_000,
        dailyAccountMinorUnits: 10_000,
      }),
    );
    parentStore.close();
    openStores.splice(openStores.indexOf(parentStore), 1);

    const startFile = join(dir, "start");
    const childCode = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createSpendLedger, createSqliteSpendStore } from "./lib/winner-loop/index.ts";
      const worker = process.env.WL_WORKER;
      const store = createSqliteSpendStore(process.env.WL_DB);
      const ledger = createSpendLedger({
        store,
        now: () => new Date("2026-08-08T09:00:00.000Z"),
        randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + Number(worker)),
      });
      writeFileSync(process.env.WL_READY, "ready");
      while (!existsSync(process.env.WL_START)) await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        const reservation = ledger.reserve({
          organizationId: "org-payout-rank",
          ventureId: "payout-rank",
          grantId: process.env.WL_GRANT,
          creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
          campaignId: "camp-concurrent-" + worker,
          amountMinorUnits: 6_000,
          idempotencyKey: "process-" + worker,
        });
        console.log(JSON.stringify({ kind: "created", reservationId: reservation.reservationId }));
      } catch (error) {
        console.log(JSON.stringify({ kind: "error", code: error.code }));
      } finally {
        store.close();
      }
    `;

    const workers = ["1", "2"].map((worker) => {
      const ready = join(dir, `ready-${worker}`);
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childCode],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            WL_WORKER: worker,
            WL_DB: path,
            WL_READY: ready,
            WL_START: startFile,
            WL_GRANT: grant.grantId,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const result = new Promise<{ kind: string; code?: string }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`spend worker exited ${code}: ${stderr}`));
            return;
          }
          resolve(JSON.parse(stdout.trim()) as { kind: string; code?: string });
        });
      });
      return { ready, result };
    });

    await waitUntil(() => workers.every((worker) => existsSync(worker.ready)));
    writeFileSync(startFile, "start");
    const outcomes = await Promise.all(workers.map((worker) => worker.result));
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["created", "error"]);
    expect(outcomes.find((outcome) => outcome.kind === "error")?.code).toBe("cap_exceeded");

    const reopened = ledgerOn(sameFileStore(path));
    expect(reopened.reservedMinorUnits(grant)).toBe(6_000);
  }, 15_000);

  it("prevents two separate database clients from overreserving one cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-spend-"));
    tempDirs.push(dir);
    const path = join(dir, "spend.db");

    const storeA = sameFileStore(path);
    const ledgerA = ledgerOn(storeA);
    const grant = ledgerA.registerGrant(
      grantInput({
        totalMinorUnits: 10_000,
        perCreativeMinorUnits: 10_000,
        dailyAccountMinorUnits: 10_000,
      }),
    );

    // A completely separate connection — the hazard an in-memory ledger cannot see.
    const storeB = sameFileStore(path);
    const ledgerB = ledgerOn(storeB);

    ledgerA.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "a" }),
    );

    const error = errorFrom(() =>
      ledgerB.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "b" }),
      ),
    );

    expect(error.code).toBe("cap_exceeded");
    expect(error.cap).toBe("grantTotal");
    expect(ledgerB.reservedMinorUnits(grant)).toBe(6_000);
  });

  it("shows why the in-memory store is not production safe", () => {
    const storeA = createMemorySpendStore();
    const storeB = createMemorySpendStore();

    expect(storeA.productionSafe).toBe(false);
    expect(sqliteStore().productionSafe).toBe(true);

    // Two memory stores share nothing, so each would grant the same headroom.
    const ledgerA = ledgerOn(storeA);
    const grant = ledgerA.registerGrant(grantInput({ totalMinorUnits: 10_000 }));
    storeB.putGrant(grant);
    const ledgerB = ledgerOn(storeB);

    ledgerA.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "a" }),
    );
    ledgerB.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 6_000, idempotencyKey: "b" }),
    );

    expect(ledgerA.reservedMinorUnits(grant)).toBe(6_000);
    expect(ledgerB.reservedMinorUnits(grant)).toBe(6_000);
  });

  it("returns the original reservation when an idempotency key repeats", () => {
    const { ledger, grant } = withGrant();
    const first = ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "retry-1" }),
    );
    const replay = ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "retry-1" }),
    );

    expect(replay.reservationId).toBe(first.reservationId);
    expect(ledger.reservedMinorUnits(grant)).toBe(5_000);
  });

  it("returns the original reservation when a retry crosses a day boundary", () => {
    const { ledger, grant, time } = withGrant();
    const first = ledger.reserve(
      reserveInput({
        grantId: grant.grantId,
        amountMinorUnits: 5_000,
        idempotencyKey: "retry-day",
      }),
    );
    time.advanceHours(24);
    const replay = ledger.reserve(
      reserveInput({
        grantId: grant.grantId,
        amountMinorUnits: 5_000,
        idempotencyKey: "retry-day",
      }),
    );
    expect(replay.reservationId).toBe(first.reservationId);
    expect(replay.dayKey).toBe(first.dayKey);
  });

  it("binds a retry key to the complete request and fails closed on mismatch", () => {
    const { ledger, grant } = withGrant();
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "bound" }),
    );

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 4_999, idempotencyKey: "bound" }),
      ),
    );

    expect(error.code).toBe("idempotency_conflict");
    expect(error.message).not.toContain(grant.grantId);
    expect(ledger.reservedMinorUnits(grant)).toBe(5_000);
  });

  it("scopes the same opaque retry key independently across venture/customer tenants", () => {
    const store = sqliteStore();
    const ledger = ledgerOn(store);
    const firstGrant = ledger.registerGrant(
      grantInput({ ventureId: "venture-a", customerId: "customer-a" }),
    );
    const secondGrant = ledger.registerGrant(
      grantInput({
        ventureId: "venture-b",
        customerId: "customer-b",
        externalAccountId: "tt-ads-2",
        allowedCreativeIds: ["cr_BBBBBBBBBBBBBBBBBBBBBBBBBB"],
      }),
    );

    const first = ledger.reserve(
      reserveInput({
        organizationId: firstGrant.organizationId,
        ventureId: firstGrant.ventureId,
        grantId: firstGrant.grantId,
        creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
        amountMinorUnits: 100,
        idempotencyKey: "shared-key",
      }),
    );
    const second = ledger.reserve(
      reserveInput({
        organizationId: secondGrant.organizationId,
        ventureId: secondGrant.ventureId,
        grantId: secondGrant.grantId,
        creativeId: "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB",
        amountMinorUnits: 999,
        idempotencyKey: "shared-key",
      }),
    );

    expect(second.reservationId).not.toBe(first.reservationId);
    expect(second.grantId).toBe(secondGrant.grantId);
    expect(second.ventureId).toBe("venture-b");
    expect(second.heldMinorUnits).toBe(999);
  });

  it("survives a client restart without losing committed reservations", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-spend-"));
    tempDirs.push(dir);
    const path = join(dir, "spend.db");

    const first = sameFileStore(path);
    const ledger = ledgerOn(first);
    const grant = ledger.registerGrant(grantInput());
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 7_000, idempotencyKey: "k" }),
    );
    first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const reopened = ledgerOn(sameFileStore(path));
    expect(reopened.reservedMinorUnits(grant)).toBe(7_000);
  });
});

describe("Winner Loop database migrations", () => {
  it("creates durable state and upgrades spend reconciliation/cap columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-winner-migration-"));
    tempDirs.push(dir);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        prepare(sql: string): { all(): Array<{ name: string }> };
        close(): void;
      };
    };
    const db = new DatabaseSync(join(dir, "winner-loop.db"));
    db.exec(readFileSync("migrations/winner-loop/001_winner_loop_state.up.sql", "utf8"));
    db.exec(readFileSync("migrations/winner-loop/002_spend_reconciliation_caps.up.sql", "utf8"));
    const reservationColumns = db
      .prepare("PRAGMA table_info(spend_reservations)")
      .all()
      .map((column) => column.name);
    const grantColumns = db
      .prepare("PRAGMA table_info(spend_grants)")
      .all()
      .map((column) => column.name);
    expect(reservationColumns).toEqual(
      expect.arrayContaining([
        "pending_reason",
        "pending_at",
        "reconciliation_outcome",
        "reconciled_at",
      ]),
    );
    expect(grantColumns).toEqual(
      expect.arrayContaining([
        "daily_customer_minor",
        "monthly_customer_minor",
        "emergency_platform_minor",
      ]),
    );
    for (const table of [
      "creative_manifests",
      "paid_test_proposals",
      "subscription_events",
      "winner_loop_evidence",
    ]) {
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`)
          .all(),
      ).toHaveLength(1);
    }
    db.close();
  });
});

describe("cap hierarchy", () => {
  it("enforces the per-creative cap", () => {
    const { ledger, grant } = withGrant();
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 1, idempotencyKey: "2" }),
      ),
    );
    expect(error.cap).toBe("perCreative");
  });

  it("enforces the daily account cap across creatives", () => {
    const { ledger, grant } = withGrant();
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({
          grantId: grant.grantId,
          creativeId: "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB",
          campaignId: "camp-2",
          amountMinorUnits: 2_001,
          idempotencyKey: "2",
        }),
      ),
    );
    expect(error.cap).toBe("dailyAccount");
  });

  it("enforces the per-campaign cap", () => {
    const { ledger, grant } = withGrant({ perCampaignMinorUnits: 3_000 });

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 3_001, idempotencyKey: "1" }),
      ),
    );
    expect(error.cap).toBe("perCampaign");
  });

  it("enforces the monthly venture cap", () => {
    const { ledger, grant } = withGrant({ monthlyVentureMinorUnits: 2_500 });

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 2_501, idempotencyKey: "1" }),
      ),
    );
    expect(error.cap).toBe("monthlyVenture");
  });

  it("enforces a daily customer cap across grants and ventures", () => {
    const { ledger, grant } = withGrant({
      customerId: "customer-shared",
      dailyCustomerMinorUnits: 5_000,
      monthlyCustomerMinorUnits: 20_000,
      emergencyPlatformMinorUnits: 50_000,
    });
    const other = ledger.registerGrant(
      grantInput({
        ventureId: "second-venture",
        customerId: "customer-shared",
        externalAccountId: "tt-ads-2",
        dailyCustomerMinorUnits: 50_000,
        monthlyCustomerMinorUnits: 20_000,
        emergencyPlatformMinorUnits: 50_000,
      }),
    );
    ledger.reserve(
      reserveInput({
        grantId: grant.grantId,
        amountMinorUnits: 3_000,
        idempotencyKey: "customer-a",
      }),
    );
    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({
          organizationId: other.organizationId,
          ventureId: other.ventureId,
          grantId: other.grantId,
          amountMinorUnits: 2_001,
          idempotencyKey: "customer-b",
        }),
      ),
    );
    expect(error.cap).toBe("dailyCustomer");
  });

  it("enforces a monthly customer cap across calendar days", () => {
    const { ledger, grant, time } = withGrant({
      customerId: "customer-monthly",
      dailyCustomerMinorUnits: 5_000,
      monthlyCustomerMinorUnits: 5_000,
      emergencyPlatformMinorUnits: 50_000,
    });
    const other = ledger.registerGrant(
      grantInput({
        ventureId: "second-venture",
        customerId: "customer-monthly",
        externalAccountId: "tt-ads-2",
        dailyCustomerMinorUnits: 5_000,
        monthlyCustomerMinorUnits: 50_000,
        emergencyPlatformMinorUnits: 50_000,
      }),
    );
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 3_000, idempotencyKey: "month-a" }),
    );
    time.advanceHours(24);
    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({
          organizationId: other.organizationId,
          ventureId: other.ventureId,
          grantId: other.grantId,
          amountMinorUnits: 2_001,
          idempotencyKey: "month-b",
        }),
      ),
    );
    expect(error.cap).toBe("monthlyCustomer");
  });

  it("enforces an emergency platform cap across all ventures and customers", () => {
    const { ledger, grant } = withGrant({ emergencyPlatformMinorUnits: 5_000 });
    const other = ledger.registerGrant(
      grantInput({
        ventureId: "second-venture",
        customerId: "other-customer",
        externalAccountId: "tt-ads-2",
        emergencyPlatformMinorUnits: 50_000,
      }),
    );
    ledger.reserve(
      reserveInput({
        grantId: grant.grantId,
        amountMinorUnits: 3_000,
        idempotencyKey: "platform-a",
      }),
    );
    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({
          organizationId: other.organizationId,
          ventureId: other.ventureId,
          grantId: other.grantId,
          amountMinorUnits: 2_001,
          idempotencyKey: "platform-b",
        }),
      ),
    );
    expect(error.cap).toBe("emergencyPlatform");
  });

  it("lets the daily cap recover while the grant total still binds", () => {
    const { ledger, grant, time } = withGrant();
    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );
    time.advanceHours(24);
    ledger.reserve(
      reserveInput({
        grantId: grant.grantId,
        creativeId: "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB",
        amountMinorUnits: 10_000,
        idempotencyKey: "2",
      }),
    );

    const error = errorFrom(() =>
      ledger.reserve(
        reserveInput({
          grantId: grant.grantId,
          creativeId: "cr_BBBBBBBBBBBBBBBBBBBBBBBBBB",
          amountMinorUnits: 1,
          idempotencyKey: "3",
        }),
      ),
    );
    expect(error.cap).toBe("grantTotal");
  });

  it("records spend in integer minor units only", () => {
    const { ledger, grant } = withGrant();
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, amountMinorUnits: 10.5 })),
      ).code,
    ).toBe("non_integer_minor_units");
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, amountMinorUnits: -5 })),
      ).code,
    ).toBe("non_positive_amount");
  });
});

describe("grant scope and validity", () => {
  it("refuses a creative the grant does not cover", () => {
    const { ledger, grant } = withGrant();
    expect(
      errorFrom(() =>
        ledger.reserve(
          reserveInput({ grantId: grant.grantId, creativeId: "cr_CCCCCCCCCCCCCCCCCCCCCCCCCC" }),
        ),
      ).code,
    ).toBe("creative_not_in_grant");
  });

  it("refuses a different network, account, or currency", () => {
    const { ledger, grant } = withGrant();
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, network: "meta_paid" })),
      ).code,
    ).toBe("network_mismatch");
    expect(
      errorFrom(() =>
        ledger.reserve(reserveInput({ grantId: grant.grantId, externalAccountId: "other" })),
      ).code,
    ).toBe("account_mismatch");
    expect(
      errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId, currency: "USD" })))
        .code,
    ).toBe("currency_mismatch");
  });

  it("refuses an unknown, expired, or revoked grant", () => {
    const { ledger, grant, time } = withGrant();
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: "grant_missing" }))).code).toBe(
      "unknown_grant",
    );

    ledger.revokeGrant(grant, "connection removed");
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );

    const fresh = withGrant();
    fresh.time.advanceHours(24 * 8);
    expect(
      errorFrom(() => fresh.ledger.reserve(reserveInput({ grantId: fresh.grant.grantId }))).code,
    ).toBe("grant_expired");
    void time;
  });
});

describe("settlement and reconciliation", () => {
  it("requires typed confirmed-no-write evidence before releasing headroom", () => {
    const { ledger, grant } = withGrant();
    const reservation = ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 4_000 }),
    );

    expect(
      errorFrom(() =>
        ledger.release(
          reservation,
          new ProviderOperationError("ambiguous", "provider outcome is unknown"),
        ),
      ).code,
    ).toBe("release_requires_confirmed_no_write");
    expect(ledger.reservedMinorUnits(grant)).toBe(4_000);

    expect(
      ledger.release(
        reservation,
        new ProviderOperationError("confirmed_no_write", "request was rejected pre-write"),
      ).status,
    ).toBe("released");
  });

  it("returns an existing reservation on retry even after the grant is frozen", async () => {
    const { ledger, grant } = withGrant();
    const input = reserveInput({
      grantId: grant.grantId,
      amountMinorUnits: 4_000,
      idempotencyKey: "settled-before-freeze",
    });
    const settled = await ledger.withReservation(input, async () => 4_000);
    ledger.activateKillSwitch(grant, "manual emergency stop");
    const adapter = vi.fn(async () => 4_000);

    await expect(ledger.withReservation(input, adapter)).resolves.toEqual(settled);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("persists pending reconciliation across a process-style client restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-reconcile-"));
    tempDirs.push(dir);
    const path = join(dir, "spend.db");
    const firstStore = sameFileStore(path);
    const first = ledgerOn(firstStore);
    const grant = first.registerGrant(grantInput());
    let reservationId = "";
    await expect(
      first.withReservation(
        reserveInput({
          grantId: grant.grantId,
          amountMinorUnits: 4_000,
          idempotencyKey: "restart",
        }),
        async (reservation) => {
          reservationId = reservation.reservationId;
          throw new Error("socket closed after request body was sent");
        },
      ),
    ).rejects.toMatchObject({ code: "provider_outcome_unknown" });
    firstStore.close();
    openStores.splice(openStores.indexOf(firstStore), 1);

    const reopened = ledgerOn(sameFileStore(path));
    expect(reopened.getReservation(reservationRef(grant, reservationId))?.status).toBe(
      "pending_reconciliation",
    );
    expect(reopened.reservedMinorUnits(grant)).toBe(4_000);
    const adapter = vi.fn(async () => 4_000);
    await expect(
      reopened.withReservation(
        reserveInput({
          grantId: grant.grantId,
          amountMinorUnits: 4_000,
          idempotencyKey: "restart",
        }),
        adapter,
      ),
    ).rejects.toMatchObject({ code: "provider_replay_blocked" });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("settles to what the provider actually reported", async () => {
    const { ledger, grant } = withGrant();
    await ledger.withReservation(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "1" }),
      async () => 4_237,
    );

    expect(ledger.committedMinorUnits(grant)).toBe(4_237);
    expect(ledger.reservedMinorUnits(grant)).toBe(0);
  });

  it("retains headroom and blocks provider replay when an untyped failure is ambiguous", async () => {
    const { ledger, grant } = withGrant();
    let reservationId = "";
    await expect(
      ledger.withReservation(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "1" }),
        async (reservation) => {
          reservationId = reservation.reservationId;
          throw new Error("provider rejected the campaign");
        },
      ),
    ).rejects.toMatchObject({ code: "provider_outcome_unknown" });

    expect(ledger.committedMinorUnits(grant)).toBe(0);
    expect(ledger.reservedMinorUnits(grant)).toBe(5_000);
    expect(ledger.getReservation(reservationRef(grant, reservationId))).toMatchObject({
      status: "pending_reconciliation",
      reconciliationOutcome: null,
    });

    const replayAdapter = vi.fn(async () => 5_000);
    await expect(
      ledger.withReservation(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "1" }),
        replayAdapter,
      ),
    ).rejects.toMatchObject({ code: "provider_replay_blocked" });
    expect(replayAdapter).not.toHaveBeenCalled();
  });

  it("releases only a typed provider rejection that confirms no write", async () => {
    const { ledger, grant } = withGrant();
    let reservationId = "";
    await expect(
      ledger.withReservation(
        reserveInput({
          grantId: grant.grantId,
          amountMinorUnits: 5_000,
          idempotencyKey: "no-write",
        }),
        async (reservation) => {
          reservationId = reservation.reservationId;
          throw new ProviderOperationError("confirmed_no_write", "provider rejected before write");
        },
      ),
    ).rejects.toMatchObject({ writeDisposition: "confirmed_no_write" });

    expect(ledger.getReservation(reservationRef(grant, reservationId))?.status).toBe("released");
    expect(ledger.reservedMinorUnits(grant)).toBe(0);
  });

  it("marks a post-write response/settlement error pending instead of leaving a replayable hold", async () => {
    const { ledger, grant } = withGrant();
    let reservationId = "";
    await expect(
      ledger.withReservation(
        reserveInput({
          grantId: grant.grantId,
          amountMinorUnits: 5_000,
          idempotencyKey: "invalid-provider-result",
        }),
        async (reservation) => {
          reservationId = reservation.reservationId;
          return Number.NaN;
        },
      ),
    ).rejects.toMatchObject({ code: "provider_outcome_unknown" });
    expect(ledger.getReservation(reservationRef(grant, reservationId))?.status).toBe(
      "pending_reconciliation",
    );
    expect(ledger.reservedMinorUnits(grant)).toBe(5_000);
    expect(
      ledger.reconcileProviderOutcome(reservationRef(grant, reservationId), {
        kind: "present",
        actualSpendMinor: 4_900,
      }),
    ).toMatchObject({ status: "settled", settledMinorUnits: 4_900 });
  });

  it("reconciles an absent ambiguous write exactly once", async () => {
    const { ledger, grant } = withGrant();
    let reservationId = "";
    await expect(
      ledger.withReservation(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "absent" }),
        async (reservation) => {
          reservationId = reservation.reservationId;
          throw new ProviderOperationError("ambiguous", "timeout after request send");
        },
      ),
    ).rejects.toMatchObject({ code: "provider_outcome_unknown" });

    const first = ledger.reconcileProviderOutcome(reservationRef(grant, reservationId), {
      kind: "absent",
    });
    const replay = ledger.reconcileProviderOutcome(reservationRef(grant, reservationId), {
      kind: "absent",
    });
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: "released", reconciliationOutcome: "absent" });
    expect(ledger.reservedMinorUnits(grant)).toBe(0);
    expect(() =>
      ledger.reconcileProviderOutcome(reservationRef(grant, reservationId), {
        kind: "present",
        actualSpendMinor: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "reconciliation_conflict" }) as never);
  });

  it("reconciles a present ambiguous write exactly once", async () => {
    const { ledger, grant } = withGrant();
    let reservationId = "";
    await expect(
      ledger.withReservation(
        reserveInput({
          grantId: grant.grantId,
          amountMinorUnits: 5_000,
          idempotencyKey: "present",
        }),
        async (reservation) => {
          reservationId = reservation.reservationId;
          throw new ProviderOperationError(
            "write_may_have_succeeded",
            "provider timed out after accepting operation",
          );
        },
      ),
    ).rejects.toMatchObject({ code: "provider_outcome_unknown" });

    const first = ledger.reconcileProviderOutcome(reservationRef(grant, reservationId), {
      kind: "present",
      actualSpendMinor: 4_237,
    });
    const replay = ledger.reconcileProviderOutcome(reservationRef(grant, reservationId), {
      kind: "present",
      actualSpendMinor: 4_237,
    });
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: "settled", reconciliationOutcome: "present" });
    expect(ledger.committedMinorUnits(grant)).toBe(4_237);
    expect(() =>
      ledger.reconcileProviderOutcome(reservationRef(grant, reservationId), {
        kind: "present",
        actualSpendMinor: 4_238,
      }),
    ).toThrowError(expect.objectContaining({ code: "reconciliation_conflict" }) as never);
  });

  it("records an overspend at its real value, raises an incident, and freezes the grant", async () => {
    const { ledger, grant } = withGrant();

    await expect(
      ledger.withReservation(
        reserveInput({ grantId: grant.grantId, amountMinorUnits: 5_000, idempotencyKey: "1" }),
        async () => 9_999,
      ),
    ).rejects.toMatchObject({ code: "settlement_exceeds_reservation" });

    expect(ledger.committedMinorUnits(grant)).toBe(9_999);
    expect(ledger.isHalted(grant)).toBe(true);
    expect(ledger.listIncidents(grant)).toHaveLength(1);
    expect(ledger.listIncidents(grant)[0]!.kind).toBe("provider_overspend");
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );
  });
});

describe("kill switch and automatic pause", () => {
  it("halts all further reservations once the kill switch is active", () => {
    const { ledger, grant } = withGrant();
    ledger.activateKillSwitch(grant, "founder stopped all spend");
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );
  });

  it("pauses on tracking, attribution, rights, or revocation failures", () => {
    const { ledger, grant } = withGrant();
    const decision = ledger.evaluateAutoPause(grant, {
      trackingHealthy: false,
      attributionMappingIntact: false,
      providerPolicyWarning: false,
      rightsValid: false,
      disclosureCompliant: true,
      connectionRevoked: true,
      refundRateAnomaly: false,
      stopConditionTriggered: false,
    });

    expect(decision.paused).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "tracking_health_failed",
        "attribution_mapping_broken",
        "rights_invalid",
        "connection_revoked",
      ]),
    );
  });

  it("does not pause when every guardrail is healthy", () => {
    const { ledger, grant } = withGrant();
    const decision = ledger.evaluateAutoPause(grant, {
      trackingHealthy: true,
      attributionMappingIntact: true,
      providerPolicyWarning: false,
      rightsValid: true,
      disclosureCompliant: true,
      connectionRevoked: false,
      refundRateAnomaly: false,
      stopConditionTriggered: false,
    });

    expect(decision.paused).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("auto-pauses immediately when required disclosure is non-compliant", () => {
    const { ledger, grant } = withGrant();
    const decision = ledger.evaluateAutoPause(grant, {
      trackingHealthy: true,
      attributionMappingIntact: true,
      providerPolicyWarning: false,
      rightsValid: true,
      disclosureCompliant: false,
      connectionRevoked: false,
      refundRateAnomaly: false,
      stopConditionTriggered: false,
    });

    expect(decision).toEqual({ paused: true, reasons: ["disclosure_violation"] });
  });

  it("halts spend once an auto-pause is applied", () => {
    const { ledger, grant } = withGrant();
    ledger.applyAutoPause(grant, ["tracking_health_failed"]);
    expect(errorFrom(() => ledger.reserve(reserveInput({ grantId: grant.grantId }))).code).toBe(
      "spend_halted",
    );
  });
});

describe("no automatic scaling in V1", () => {
  it("returns a recommendation that was not applied and needs a new grant", () => {
    const { ledger, grant } = withGrant();
    const proposal = ledger.proposeScale(grant, {
      creativeId: "cr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      suggestedTotalMinorUnits: 50_000,
      rationale: "CAC is below target across a full D7 cohort",
    });

    expect(proposal.automaticallyApplied).toBe(false);
    expect(proposal.requiresNewSpendGrant).toBe(true);
    expect(ledger.getGrant(grant)?.totalMinorUnits).toBe(20_000);
  });

  it("exposes no path that raises a cap on an existing grant", () => {
    const { ledger } = withGrant();
    for (const forbidden of ["increaseBudget", "raiseCap", "updateBudget", "setTotal"]) {
      expect(ledger).not.toHaveProperty(forbidden);
    }
  });

  it("cross-venture isolation: a second venture's grant is a separate budget", () => {
    const { ledger, grant } = withGrant();
    const other = ledger.registerGrant(
      grantInput({ ventureId: "ship-to-users", externalAccountId: "tt-ads-2" }),
    );

    ledger.reserve(
      reserveInput({ grantId: grant.grantId, amountMinorUnits: 10_000, idempotencyKey: "1" }),
    );

    expect(ledger.reservedMinorUnits(other)).toBe(0);
    expect(other.grantId).not.toBe(grant.grantId);
  });
});
