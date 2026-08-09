import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SqliteWinnerLiveProviderOperationStore,
  createWinnerLiveProviderAdapters,
  WinnerLiveTransportError,
  type WinnerLiveProviderAuthorization,
  type WinnerLiveProviderContext,
  type WinnerLiveProviderOperationStore,
  type WinnerLiveProviderPlan,
  type WinnerLiveProviderTransport,
  type WinnerLiveTransportDoctorRequest,
  type WinnerLiveTransportOperationRequest,
} from "@/lib/winner-integrations/live-providers";
import {
  SpendError,
  createSpendLedger,
  type AutoPauseReason,
  type SpendGrantInput,
} from "@/lib/winner-loop/spend";
import { createSqliteSpendStore, type SpendStore } from "@/lib/winner-loop/spend-store";

const NOW = "2026-08-09T12:00:00.000Z";
const ORGANIZATION_ID = "org-acme";
const ALL_AUTO_PAUSE_REASONS: readonly AutoPauseReason[] = [
  "tracking_health_failed",
  "attribution_mapping_broken",
  "provider_policy_warning",
  "hard_budget_reached",
  "stop_condition_triggered",
  "refund_rate_anomaly",
  "rights_invalid",
  "disclosure_violation",
  "connection_revoked",
];

const openStores: SpendStore[] = [];
const providerStores: SqliteWinnerLiveProviderOperationStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
  while (providerStores.length > 0) providerStores.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-provider-pause-"));
  tempDirs.push(directory);
  return join(directory, "spend.db");
}

function openStore(path = databasePath()): SpendStore {
  const store = createSqliteSpendStore(path);
  openStores.push(store);
  return store;
}

function closeStore(store: SpendStore): void {
  store.close();
  openStores.splice(openStores.indexOf(store), 1);
}

function grantInput(overrides: Partial<SpendGrantInput> = {}): SpendGrantInput {
  return {
    organizationId: ORGANIZATION_ID,
    ventureId: "venture-pause",
    network: "tiktok_paid",
    externalAccountId: "advertiser-pause-1",
    currency: "EUR",
    totalMinorUnits: 10_000,
    perCreativeMinorUnits: 10_000,
    dailyAccountMinorUnits: 10_000,
    allowedCreativeIds: ["creative-pause-1"],
    approvedBy: "founder-1",
    approvalRef: "approval-pause-1",
    proposalId: "proposal-pause-1",
    notBefore: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  };
}

function durableOperationStore(): WinnerLiveProviderOperationStore {
  const store = new SqliteWinnerLiveProviderOperationStore(databasePath());
  providerStores.push(store);
  return store;
}

type ApplyState = "accepted" | "rejected" | "unknown";
type ReadState = "matched" | "missing" | "conflict" | "unknown";

function fixtureTransport(
  initial: {
    apply?: ApplyState;
    readBack?: ReadState;
    reconcile?: ReadState;
    applyError?: Error;
    reconcileError?: Error;
  } = {},
) {
  const state = {
    apply: initial.apply ?? ("accepted" as ApplyState),
    readBack: initial.readBack ?? ("matched" as ReadState),
    reconcile: initial.reconcile ?? ("matched" as ReadState),
  };
  const evidence = (plan: WinnerLiveProviderPlan) => ({
    campaign_id: plan.payload.campaign_id,
    pause_applied: true,
    status: "PAUSED",
  });
  const transport = {
    adapterId: "tiktok_spark_ads" as const,
    kind: "contract_fixture" as const,
    doctor: vi.fn(async (request: WinnerLiveTransportDoctorRequest) => ({
      state: "ready" as const,
      observedAccountId: request.providerAccountId,
      availableFeatures: request.requestedFeatures,
      grantedScopes: request.requiredScopes,
      providerInvoked: false,
      liveVerified: false,
    })),
    apply: vi.fn(async ({ plan }: WinnerLiveTransportOperationRequest) => {
      if (initial.applyError) throw initial.applyError;
      return {
        state: state.apply,
        providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
        providerInvoked: false,
        externalEffectOccurred: state.apply === "unknown" ? ("unknown" as const) : false,
        output: { fixture_only: true },
      };
    }),
    readBack: vi.fn(async ({ plan }: WinnerLiveTransportOperationRequest) => ({
      state: state.readBack,
      providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: false,
      liveVerified: false,
      evidence: state.readBack === "matched" ? evidence(plan) : null,
    })),
    reconcile: vi.fn(async ({ plan }: WinnerLiveTransportOperationRequest) => {
      if (initial.reconcileError) throw initial.reconcileError;
      return {
        state: state.reconcile,
        providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
        providerInvoked: false,
        liveVerified: false,
        evidence: state.reconcile === "matched" ? evidence(plan) : null,
      };
    }),
  } satisfies WinnerLiveProviderTransport;
  return { state, transport };
}

function adapterFor(
  transport: WinnerLiveProviderTransport,
  operationStore: WinnerLiveProviderOperationStore,
) {
  return createWinnerLiveProviderAdapters({
    transports: { tiktok_spark_ads: transport },
    store: operationStore,
  }).tiktok_spark_ads;
}

function authorization(
  overrides: Partial<WinnerLiveProviderAuthorization> = {},
): WinnerLiveProviderAuthorization {
  return {
    sourceGrantKind: "launch_grant",
    sourceGrantId: "launch-grant-provider-pause-1",
    organizationId: ORGANIZATION_ID,
    ventureId: "venture-pause",
    providerId: "tiktok_spark_ads",
    externalAccountIds: ["advertiser-pause-1"],
    allowedFeatures: ["ads.campaign.pause"],
    allowedEffects: ["reversible_external_write"],
    maxExternalCostMinor: 0,
    currency: "EUR",
    approvedBy: "founder-1",
    approvalRef: "approval-provider-pause-1",
    issuedAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-09T13:00:00.000Z",
    ...overrides,
  };
}

function context(
  now: () => Date = () => new Date(NOW),
  overrides: Partial<WinnerLiveProviderContext> = {},
): WinnerLiveProviderContext {
  return {
    organizationId: ORGANIZATION_ID,
    credentialRef: "cred://winner-loop/tiktok-pause",
    authorization: authorization(),
    executionMode: "authorized_transport",
    environment: "test",
    now,
    ...overrides,
  };
}

function ledgerOn(
  store: SpendStore,
  providerPauseAdapter?: ReturnType<typeof adapterFor>,
  now: () => Date = () => new Date(NOW),
) {
  return createSpendLedger({
    store,
    providerPauseAdapter,
    now,
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1),
  });
}

function registerAndReserve(
  store: SpendStore,
  providerPauseAdapter?: ReturnType<typeof adapterFor>,
) {
  const ledger = ledgerOn(store, providerPauseAdapter);
  const grant = ledger.registerGrant(grantInput());
  const reservation = ledger.reserve({
    organizationId: grant.organizationId,
    ventureId: grant.ventureId,
    grantId: grant.grantId,
    creativeId: "creative-pause-1",
    campaignId: "campaign-pause-1",
    amountMinorUnits: 1_000,
    idempotencyKey: "reserve-pause-1",
  });
  return { ledger, grant, reservation };
}

describe("Winner provider-pause safety outbox", () => {
  it("atomically preserves a local halt, one request-bound obligation, and every auto-pause reason", () => {
    const store = openStore();
    const { ledger, grant } = registerAndReserve(store);

    const obligations = ledger.applyAutoPause(grant, ALL_AUTO_PAUSE_REASONS);

    expect(ledger.isHalted(grant)).toBe(true);
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      providerAdapterId: "tiktok_spark_ads",
      campaignId: "campaign-pause-1",
      state: "pending",
      attemptCount: 0,
      reasons: ALL_AUTO_PAUSE_REASONS,
    });
    expect(obligations[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(obligations[0]?.incidentIds).toHaveLength(ALL_AUTO_PAUSE_REASONS.length);
    expect(ledger.listIncidents(grant).filter(({ kind }) => kind === "auto_pause")).toHaveLength(
      ALL_AUTO_PAUSE_REASONS.length,
    );
  });

  it("settles real overspend, freezes locally, and commits its pause obligation across restart", () => {
    const path = databasePath();
    const firstStore = openStore(path);
    const { ledger, grant, reservation } = registerAndReserve(firstStore);

    expect(() => ledger.settle(reservation, 1_250)).toThrowError(
      expect.objectContaining<Partial<SpendError>>({ code: "settlement_exceeds_reservation" }),
    );
    expect(ledger.isHalted(grant)).toBe(true);
    expect(ledger.getReservation(reservation)).toMatchObject({
      status: "settled",
      settledMinorUnits: 1_250,
    });
    closeStore(firstStore);

    const restarted = ledgerOn(openStore(path));
    const [obligation] = restarted.listProviderPauseObligations(grant);
    expect(obligation).toMatchObject({
      campaignId: "campaign-pause-1",
      reasons: ["provider_overspend"],
      state: "pending",
      attemptCount: 0,
    });
    expect(JSON.parse(obligation!.payloadJson!)).toMatchObject({
      operation: "pause_campaign",
      pause_reason: "provider_overspend",
      observed_spend_minor: 1_250,
    });
    expect(restarted.listIncidents(grant)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "provider_overspend" })]),
    );
  });

  it("claims concurrent processing once and completes only after matching read-back", async () => {
    const store = openStore();
    const operationStore = durableOperationStore();
    const fixture = fixtureTransport();
    const adapter = adapterFor(fixture.transport, operationStore);
    const { ledger, grant } = registerAndReserve(store, adapter);
    const [obligation] = ledger.applyAutoPause(grant, ["hard_budget_reached"]);

    const results = await Promise.all([
      ledger.processProviderPause(obligation!, context()),
      ledger.processProviderPause(obligation!, context()),
    ]);

    expect(fixture.transport.apply).toHaveBeenCalledTimes(1);
    expect(results.some(({ complete }) => complete)).toBe(true);
    expect(ledger.getProviderPauseObligation(obligation!)).toMatchObject({
      state: "verified",
      attemptCount: 1,
      verifiedAt: NOW,
    });
    const replay = await ledger.processProviderPause(obligation!, context());
    expect(replay).toMatchObject({ complete: true, applyAttempted: false });
    expect(fixture.transport.apply).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous outcome after restart and expired apply approval without replaying mutation", async () => {
    const path = databasePath();
    const operationStore = durableOperationStore();
    const fixture = fixtureTransport({ apply: "unknown", reconcile: "unknown" });
    const firstAdapter = adapterFor(fixture.transport, operationStore);
    const firstStore = openStore(path);
    const { ledger, grant } = registerAndReserve(firstStore, firstAdapter);
    const [obligation] = ledger.applyAutoPause(grant, ["tracking_health_failed"]);

    const unresolved = await ledger.processProviderPause(obligation!, context());
    expect(unresolved).toMatchObject({
      complete: false,
      state: "unknown",
      applyAttempted: true,
      reconciled: true,
    });
    expect(unresolved.obligation).toMatchObject({
      attemptCount: 1,
      lastApplyState: "unknown",
      lastReadBackState: "unknown",
      lastReconciledAt: NOW,
    });
    expect(fixture.transport.apply).toHaveBeenCalledTimes(1);
    closeStore(firstStore);

    fixture.state.reconcile = "matched";
    const later = () => new Date("2026-08-09T14:00:00.000Z");
    const reconciliationAuthorization = authorization({
      sourceGrantId: "reconciliation-grant-1",
      allowedEffects: ["external_read"],
      issuedAt: "2026-08-09T13:30:00.000Z",
      expiresAt: "2026-08-09T15:00:00.000Z",
    });
    const restarted = ledgerOn(
      openStore(path),
      adapterFor(fixture.transport, operationStore),
      later,
    );
    const reconciled = await restarted.processProviderPause(
      obligation!,
      context(later, {
        authorization: authorization(),
        reconciliationAuthorization,
      }),
    );

    expect(reconciled).toMatchObject({
      complete: true,
      state: "verified",
      applyAttempted: false,
      reconciled: true,
    });
    expect(reconciled.obligation).toMatchObject({
      lastReadBackState: "matched",
      lastReconciledAt: "2026-08-09T14:00:00.000Z",
    });
    expect(fixture.transport.apply).toHaveBeenCalledTimes(1);
    expect(fixture.transport.reconcile).toHaveBeenCalledTimes(2);
  });

  it("never reports rejected or missing provider pause evidence complete", async () => {
    const store = openStore();
    const operationStore = durableOperationStore();
    const fixture = fixtureTransport({ apply: "rejected", reconcile: "missing" });
    const adapter = adapterFor(fixture.transport, operationStore);
    const { ledger, grant } = registerAndReserve(store, adapter);
    const [obligation] = ledger.applyAutoPause(grant, ["provider_policy_warning"]);

    const first = await ledger.processProviderPause(obligation!, context());
    const retry = await ledger.processProviderPause(obligation!, context());

    expect(first.complete).toBe(false);
    expect(retry.complete).toBe(false);
    expect(retry.state).toBe("failed");
    expect(fixture.transport.apply).toHaveBeenCalledTimes(1);
    expect(ledger.listIncidents(grant)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "provider_pause_failed" })]),
    );
  });

  it("redacts ambiguous provider diagnostics before durable incident storage", async () => {
    const store = openStore();
    const leakedValue = ["Bearer", "synthetic-provider-token"].join(" ");
    const ambiguous = new WinnerLiveTransportError(
      "fixture_timeout",
      "ambiguous",
      false,
      `timeout after ${leakedValue}`,
    );
    const fixture = fixtureTransport({
      reconcile: "unknown",
      applyError: ambiguous,
      reconcileError: ambiguous,
    });
    const adapter = adapterFor(fixture.transport, durableOperationStore());
    const { ledger, grant } = registerAndReserve(store, adapter);
    const [obligation] = ledger.applyAutoPause(grant, ["stop_condition_triggered"]);

    const result = await ledger.processProviderPause(obligation!, context());

    expect(result).toMatchObject({ complete: false, state: "unknown" });
    expect(JSON.stringify(result.obligation)).not.toContain(leakedValue);
    expect(JSON.stringify(ledger.listIncidents(grant))).not.toContain(leakedValue);
    expect(result.obligation.lastDiagnosticMessage).toContain("[REDACTED]");
  });

  it("fails closed before the mutation claim when auth or the injected adapter is missing", async () => {
    const store = openStore();
    const operationStore = durableOperationStore();
    const fixture = fixtureTransport();
    const adapter = adapterFor(fixture.transport, operationStore);
    const { ledger, grant } = registerAndReserve(store, adapter);
    const [obligation] = ledger.applyAutoPause(grant, ["connection_revoked"]);

    const blocked = await ledger.processProviderPause(
      obligation!,
      context(() => new Date(NOW), { credentialRef: undefined, authorization: undefined }),
    );
    expect(blocked).toMatchObject({ complete: false, applyAttempted: false, state: "pending" });
    expect(fixture.transport.apply).not.toHaveBeenCalled();
    expect(ledger.getProviderPauseObligation(obligation!)?.attemptCount).toBe(0);

    const recovered = await ledger.processProviderPause(obligation!, context());
    expect(recovered.complete).toBe(true);
    expect(fixture.transport.apply).toHaveBeenCalledTimes(1);

    const noAdapterStore = openStore();
    const withoutAdapter = registerAndReserve(noAdapterStore);
    const [noAdapterObligation] = withoutAdapter.ledger.applyAutoPause(withoutAdapter.grant, [
      "connection_revoked",
    ]);
    const noAdapterResult = await withoutAdapter.ledger.processProviderPause(
      noAdapterObligation!,
      context(),
    );
    expect(noAdapterResult).toMatchObject({
      complete: false,
      applyAttempted: false,
      state: "pending",
      diagnosticCode: "transport_missing",
    });
    expect(noAdapterObligation!.attemptCount).toBe(0);
  });

  it("records an unexecutable missing-target obligation without any provider call", async () => {
    const store = openStore();
    const operationStore = durableOperationStore();
    const fixture = fixtureTransport();
    const adapter = adapterFor(fixture.transport, operationStore);
    const ledger = ledgerOn(store, adapter);
    const grant = ledger.registerGrant(grantInput());
    const [obligation] = ledger.applyAutoPause(grant, ["rights_invalid"]);

    expect(obligation).toMatchObject({
      campaignId: null,
      state: "blocked",
      requestHash: null,
      lastDiagnosticCode: "invalid_request",
    });
    const result = await ledger.processProviderPause(obligation!, context());
    expect(result.complete).toBe(false);
    expect(fixture.transport.doctor).not.toHaveBeenCalled();
    expect(fixture.transport.apply).not.toHaveBeenCalled();
    expect(fixture.transport.readBack).not.toHaveBeenCalled();
    expect(fixture.transport.reconcile).not.toHaveBeenCalled();
  });

  it("applies and rolls back the provider-pause migration", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const database = new DatabaseSync(":memory:");
    try {
      for (const migration of [
        "001_winner_loop_state.up.sql",
        "002_spend_reconciliation_caps.up.sql",
        "004_provider_pause_obligations.up.sql",
      ]) {
        database.exec(readFileSync(join("migrations/winner-loop", migration), "utf8"));
      }
      const columns = database
        .prepare("PRAGMA table_info(provider_pause_obligations)")
        .all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "request_hash",
          "attempt_count",
          "last_attempted_at",
          "last_apply_state",
          "last_read_back_state",
          "last_reconciled_at",
          "verified_at",
        ]),
      );

      database.exec(
        readFileSync(
          join("migrations/winner-loop", "004_provider_pause_obligations.down.sql"),
          "utf8",
        ),
      );
      expect(database.prepare("PRAGMA table_info(provider_pause_obligations)").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
