import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SqliteWinnerLiveProviderOperationStore,
  createMemoryWinnerLiveProviderOperationStore,
  createWinnerLiveProviderAdapters,
  type WinnerLiveProviderAuthorization,
  type WinnerLiveProviderContext,
  type WinnerLiveProviderPlan,
  type WinnerLiveProviderStoredOperation,
  type WinnerLiveProviderTransport,
} from "@/lib/winner-integrations";

const NOW = "2026-08-09T12:00:00.000Z";
const roots: string[] = [];
const stores: SqliteWinnerLiveProviderOperationStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Restart assertions deliberately close earlier connections.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "vh-provider-operation-store-"));
  roots.push(root);
  return join(root, "operations.sqlite");
}

function openStore(
  path: string,
  options: { readonly pendingTimeoutMs?: number } = {},
): SqliteWinnerLiveProviderOperationStore {
  const store = new SqliteWinnerLiveProviderOperationStore(path, options);
  stores.push(store);
  return store;
}

function storedOperation(
  overrides: Partial<WinnerLiveProviderStoredOperation> = {},
): WinnerLiveProviderStoredOperation & { readonly state: "pending" } {
  return {
    adapterId: "creative_generation",
    organizationId: "org-acme",
    ventureId: "venture-alpha",
    operationId: "operation-1",
    idempotencyKey: "provider-key-1",
    requestHash: "a".repeat(64),
    providerOperationId: null,
    output: null,
    evidence: null,
    updatedAt: NOW,
    ...overrides,
    paidSpendBinding: overrides.paidSpendBinding ?? null,
    state: "pending",
  };
}

function creativePlan(
  store: SqliteWinnerLiveProviderOperationStore,
  transport: WinnerLiveProviderTransport,
  promptRef = "artifact://winner/prompts/creative-1",
): {
  adapter: ReturnType<typeof createWinnerLiveProviderAdapters>["creative_generation"];
  plan: WinnerLiveProviderPlan;
} {
  const adapter = createWinnerLiveProviderAdapters({
    transports: { creative_generation: transport },
    store,
  }).creative_generation;
  const plan = adapter.plan({
    organizationId: "org-acme",
    ventureId: "venture-alpha",
    providerAccountId: "creative-account-1",
    operationId: "creative-operation-1",
    idempotencyKey: "creative-provider-key-1",
    feature: "creative.video.generate",
    payload: {
      operation: "generate_video",
      creative_id: "creative-1",
      provider_model: "official-model-1",
      prompt_ref: promptRef,
      asset_manifest_ref: "artifact://winner/assets/creative-1",
      rights_manifest_ref: "artifact://winner/rights/creative-1",
      output_destination_ref: "asset://venture-alpha/generated/creative-1.mp4",
      aspect_ratio: "9:16",
      max_cost_minor: 100,
      currency: "EUR",
    },
  });
  return { adapter, plan };
}

function authorization(
  plan: WinnerLiveProviderPlan,
  effect = plan.effect,
): WinnerLiveProviderAuthorization {
  return {
    sourceGrantKind: "customer_service_grant",
    sourceGrantId: `service-grant-${effect}`,
    organizationId: plan.organizationId,
    ventureId: plan.ventureId,
    providerId: plan.adapterId,
    externalAccountIds: [plan.providerAccountId],
    allowedFeatures: [plan.feature],
    allowedEffects: [effect],
    maxExternalCostMinor: 100,
    currency: "EUR",
    approvedBy: "founder-1",
    approvalRef: `artifact://approvals/${effect}`,
    issuedAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-09T13:00:00.000Z",
  };
}

function context(plan: WinnerLiveProviderPlan): WinnerLiveProviderContext {
  return {
    organizationId: plan.organizationId,
    credentialRef: "cred://winner/creative-generation",
    authorization: authorization(plan),
    reconciliationAuthorization: authorization(plan, "external_read"),
    executionMode: "authorized_transport",
    environment: "production",
    now: () => new Date(NOW),
  };
}

describe("SQLite Winner live-provider operation store", () => {
  it("uses two SQLite connections as one atomic owner barrier and replays after restart", async () => {
    const path = databasePath();
    const firstStore = openStore(path);
    const secondStore = openStore(path);
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const transport: WinnerLiveProviderTransport & { apply: ReturnType<typeof vi.fn> } = {
      adapterId: "creative_generation",
      kind: "official_api",
      doctor: vi.fn(),
      apply: vi.fn(async ({ plan }) => {
        await providerGate;
        return {
          state: "accepted" as const,
          providerOperationId: `job-${plan.requestHash.slice(0, 12)}`,
          providerInvoked: true,
          externalEffectOccurred: true,
          output: { creative_id: plan.payload.creative_id, status: "PROCESSING" },
        };
      }),
      readBack: vi.fn(async ({ plan }) => ({
        state: "matched" as const,
        providerOperationId: `job-${plan.requestHash.slice(0, 12)}`,
        providerInvoked: true,
        liveVerified: true,
        evidence: {
          creative_id: plan.payload.creative_id,
          asset_ref: "asset://venture-alpha/generated/creative-1.mp4",
          status: "COMPLETED",
        },
      })),
      reconcile: vi.fn(async ({ plan }) => ({
        state: "matched" as const,
        providerOperationId: `job-${plan.requestHash.slice(0, 12)}`,
        providerInvoked: true,
        liveVerified: true,
        evidence: {
          creative_id: plan.payload.creative_id,
          asset_ref: "asset://venture-alpha/generated/creative-1.mp4",
          status: "COMPLETED",
        },
      })),
    };
    const first = creativePlan(firstStore, transport);
    const second = creativePlan(secondStore, transport);
    const conflicting = creativePlan(
      secondStore,
      transport,
      "artifact://winner/prompts/creative-conflict",
    );

    const ownerResult = first.adapter.apply(first.plan, context(first.plan));
    await vi.waitFor(() => expect(transport.apply).toHaveBeenCalledOnce());
    const pending = await second.adapter.apply(second.plan, context(second.plan));
    const conflict = await conflicting.adapter.apply(conflicting.plan, context(conflicting.plan));
    expect(pending).toMatchObject({ state: "unknown", reused: true, providerInvoked: false });
    expect(pending.diagnostic?.code).toBe("outcome_ambiguous");
    expect(conflict).toMatchObject({ state: "conflict", providerInvoked: false });
    expect(transport.apply).toHaveBeenCalledOnce();

    releaseProvider();
    expect(await ownerResult).toMatchObject({
      state: "accepted_unverified",
      providerInvoked: true,
    });
    firstStore.close();
    secondStore.close();

    const restartedStore = openStore(path);
    const restarted = creativePlan(restartedStore, transport);
    expect(await restarted.adapter.apply(restarted.plan, context(restarted.plan))).toMatchObject({
      state: "accepted_unverified",
      reused: true,
      providerInvoked: false,
    });
    expect(transport.apply).toHaveBeenCalledOnce();
    expect(
      await restarted.adapter.reconcile(restarted.plan, context(restarted.plan)),
    ).toMatchObject({ state: "matched", reapplied: false, liveVerified: true });
    expect(
      await restartedStore.get(
        restarted.plan.organizationId,
        restarted.plan.ventureId,
        restarted.plan.adapterId,
        restarted.plan.idempotencyKey,
      ),
    ).toMatchObject({ state: "verified", organizationId: "org-acme" });
  });

  it("turns a crashed owner into ambiguity and permits only hash-bound reconciliation", async () => {
    const path = databasePath();
    const first = openStore(path, { pendingTimeoutMs: 100 });
    const record = storedOperation();
    expect(await first.claim(record, { ownerToken: "owner-a", now: NOW })).toMatchObject({
      kind: "owner",
    });
    first.close();

    const restarted = openStore(path, { pendingTimeoutMs: 100 });
    expect(
      await restarted.claim(record, {
        ownerToken: "owner-b",
        now: "2026-08-09T12:00:00.050Z",
      }),
    ).toMatchObject({ kind: "pending" });
    expect(
      await restarted.claim(record, {
        ownerToken: "owner-c",
        now: "2026-08-09T12:00:00.100Z",
      }),
    ).toMatchObject({ kind: "ambiguous" });
    await expect(
      restarted.reconcile({
        ...record,
        requestHash: "b".repeat(64),
        state: "verified",
        evidence: { status: "COMPLETED" },
        updatedAt: "2026-08-09T12:00:01.000Z",
      }),
    ).rejects.toThrow(/different input/u);
    await restarted.reconcile({
      ...record,
      state: "verified",
      providerOperationId: "job-reconciled",
      evidence: { status: "COMPLETED" },
      updatedAt: "2026-08-09T12:00:01.000Z",
    });
    expect(
      await restarted.claim(record, {
        ownerToken: "owner-d",
        now: "2026-08-09T12:00:02.000Z",
      }),
    ).toMatchObject({ kind: "replay", record: { state: "verified" } });
  });

  it("isolates equal venture/key tuples by organization and resists delimiter collisions", async () => {
    const path = databasePath();
    const first = openStore(path);
    const second = openStore(path);
    const orgA = storedOperation({ organizationId: "org-a", requestHash: "a".repeat(64) });
    const orgB = storedOperation({ organizationId: "org-b", requestHash: "b".repeat(64) });
    expect(await first.claim(orgA, { ownerToken: "owner-a", now: NOW })).toMatchObject({
      kind: "owner",
    });
    expect(await second.claim(orgB, { ownerToken: "owner-b", now: NOW })).toMatchObject({
      kind: "owner",
    });

    const memory = createMemoryWinnerLiveProviderOperationStore();
    const delimiterA = storedOperation({
      organizationId: "org\u0000venture",
      ventureId: "shared",
      idempotencyKey: "key",
      requestHash: "c".repeat(64),
    });
    const delimiterB = storedOperation({
      organizationId: "org",
      ventureId: "venture\u0000shared",
      idempotencyKey: "key",
      requestHash: "d".repeat(64),
    });
    expect(await memory.claim(delimiterA, { ownerToken: "delimiter-a", now: NOW })).toMatchObject({
      kind: "owner",
    });
    expect(await memory.claim(delimiterB, { ownerToken: "delimiter-b", now: NOW })).toMatchObject({
      kind: "owner",
    });
  });
});
