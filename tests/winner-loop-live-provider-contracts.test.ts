import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SqliteWinnerLiveProviderOperationStore,
  WINNER_LIVE_PROVIDER_DESCRIPTORS,
  WINNER_LIVE_PROVIDER_IDS,
  createMemoryWinnerLiveProviderOperationStore,
  createWinnerLiveProviderAdapters,
  WinnerLiveProviderContractError,
  WinnerLiveTransportError,
  type WinnerLiveJsonObject,
  type WinnerLiveProviderAuthorization,
  type WinnerLiveProviderContext,
  type WinnerLiveProviderFeature,
  type WinnerLiveProviderId,
  type WinnerLiveProviderPlan,
  type WinnerLiveProviderPlanRequest,
  type WinnerLivePaidAuthorizationStore,
  type WinnerLiveProviderOperationStore,
  type WinnerLiveProviderTransport,
} from "@/lib/winner-integrations";
import {
  createSpendLedger,
  createSqliteSpendStore,
  createWinnerLivePaidAuthorizationStore,
  type Reservation,
  type SpendGrant,
  type SpendLedger,
} from "@/lib/winner-loop";

const NOW = "2026-08-09T12:00:00.000Z";
const ORGANIZATION_ID = "org-acme";
const now = () => new Date(NOW);
const temporaryDirectories: string[] = [];
const sqliteStores: SqliteWinnerLiveProviderOperationStore[] = [];
const spendStores: { close(): void }[] = [];

afterEach(() => {
  for (const store of sqliteStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A restart assertion may have closed the store deliberately.
    }
  }
  for (const store of spendStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A restart assertion may have closed an earlier connection deliberately.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-provider-contracts-"));
  temporaryDirectories.push(directory);
  return directory;
}

const ACCOUNT_BY_PROVIDER: Record<WinnerLiveProviderId, string> = {
  creative_generation: "creative-account-1",
  tiktok_content_posting: "tiktok-user-1",
  tiktok_spark_ads: "advertiser-1",
  aggregated_attribution: "attribution-account-1",
  revenuecat: "revenuecat-project-1",
};

const FEATURE_BY_PROVIDER: Record<WinnerLiveProviderId, WinnerLiveProviderFeature> = {
  creative_generation: "creative.video.generate",
  tiktok_content_posting: "distribution.content.draft",
  tiktok_spark_ads: "ads.organic_post.boost",
  aggregated_attribution: "attribution.campaign.read",
  revenuecat: "subscription.lifecycle.read",
};

function payloadFor(
  adapterId: WinnerLiveProviderId,
  feature: WinnerLiveProviderFeature = FEATURE_BY_PROVIDER[adapterId],
): WinnerLiveJsonObject {
  switch (adapterId) {
    case "creative_generation":
      return {
        operation: "generate_video",
        creative_id: "creative-1",
        provider_model: "video-model-1",
        prompt_ref: "artifact://winner/prompts/creative-1",
        asset_manifest_ref: "artifact://winner/assets/creative-1",
        rights_manifest_ref: "artifact://winner/rights/creative-1",
        output_destination_ref: "asset://venture/creative-1",
        aspect_ratio: "9:16",
        max_cost_minor: 300,
        currency: "EUR",
      };
    case "tiktok_content_posting": {
      const common = {
        creative_id: "creative-1",
        creator_info_ref: "artifact://tiktok/creator-info-1",
        user_consent_ref: "artifact://tiktok/consent-1",
        policy_snapshot_ref: "artifact://tiktok/policy-1",
        media: {
          method: "brokered_file_upload",
          media_ref: "asset://venture/creative-1.mp4",
          size_bytes: 2_000_000,
          mime_type: "video/mp4",
        },
      };
      return feature === "distribution.content.publish"
        ? {
            operation: "publish_direct",
            ...common,
            title: "A truthful synthetic product walkthrough",
            privacy_level: "PUBLIC_TO_EVERYONE",
            disable_duet: false,
            disable_stitch: false,
            disable_comment: false,
            brand_content_toggle: false,
            brand_organic_toggle: true,
            is_aigc: true,
          }
        : { operation: "upload_draft", ...common };
    }
    case "tiktok_spark_ads":
      if (feature === "ads.campaign.pause") {
        return {
          operation: "pause_campaign",
          campaign_id: "provider-campaign-1",
          advertiser_id: "advertiser-1",
          pause_reason: "hard_budget_reached",
          incident_ref: "artifact://winner/incidents/hard-budget-1",
          observed_spend_minor: 5_000,
          currency: "EUR",
          requested_at: NOW,
        };
      }
      return {
        operation: "create_spark_paid_test",
        proposal_id: "proposal-1",
        creative_id: "creative-1",
        source_post_id: "post-1",
        spark_authorization_ref: "resource://tiktok/spark-authorization-1",
        advertiser_id: "advertiser-1",
        campaign_key: "campaign-1",
        objective: "APP_PROMOTION",
        optimization_event: "TRIAL_STARTED",
        geographies: ["NL"],
        total_budget_minor: 5_000,
        daily_cap_minor: 1_000,
        reserved_minor: 5_000,
        currency: "EUR",
        start_at: "2026-08-09T11:30:00.000Z",
        end_at: "2026-08-10T12:00:00.000Z",
        auto_scale: false,
        scale_mode: "manual_recommendation_only",
      };
    case "aggregated_attribution":
      return {
        operation: "read_aggregates",
        provider_kind: "mobile_measurement_partner",
        dataset_ref: "artifact://attribution/report-1",
        creative_ids: ["creative-1"],
        window_start: "2026-08-01T00:00:00.000Z",
        window_end: "2026-08-08T00:00:00.000Z",
        allowed_attribution_classes: ["PRIVACY_AGGREGATED", "MODELED", "UNKNOWN"],
        aggregate_only: true,
        include_person_level_rows: false,
      };
    case "revenuecat":
      return {
        operation: "read_lifecycle_aggregates",
        project_id: "revenuecat-project-1",
        environment: "sandbox",
        window_start: "2026-08-01T00:00:00.000Z",
        window_end: "2026-08-08T00:00:00.000Z",
        currency: "EUR",
        cohort_periods: ["D0", "D7", "D30"],
        lifecycle_event_types: ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION"],
        aggregate_only: true,
        include_subscriber_payload: false,
      };
  }
}

function requestFor(
  adapterId: WinnerLiveProviderId,
  feature: WinnerLiveProviderFeature = FEATURE_BY_PROVIDER[adapterId],
  overrides: Partial<WinnerLiveProviderPlanRequest> = {},
): WinnerLiveProviderPlanRequest {
  return {
    organizationId: ORGANIZATION_ID,
    ventureId: "venture-1",
    providerAccountId: ACCOUNT_BY_PROVIDER[adapterId],
    operationId: `${adapterId}-operation-1`,
    idempotencyKey: `${adapterId}-idempotency-1`,
    feature,
    payload: payloadFor(adapterId, feature),
    ...overrides,
  };
}

function authorizationFor(
  plan: WinnerLiveProviderPlan,
  overrides: Partial<WinnerLiveProviderAuthorization> = {},
): WinnerLiveProviderAuthorization {
  return {
    sourceGrantKind: "customer_service_grant",
    sourceGrantId: "service-grant-1",
    organizationId: plan.organizationId,
    ventureId: plan.ventureId,
    providerId: plan.adapterId,
    externalAccountIds: [plan.providerAccountId],
    allowedFeatures: [plan.feature],
    allowedEffects: [plan.effect],
    maxExternalCostMinor: 10_000,
    currency: "EUR",
    approvedBy: "founder-1",
    approvalRef: "artifact://approvals/provider-1",
    issuedAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-09T13:00:00.000Z",
    ...overrides,
  };
}

function spendGrant(): SpendGrant {
  return {
    grantId: "grant-1",
    organizationId: ORGANIZATION_ID,
    ventureId: "venture-1",
    customerId: "customer-1",
    network: "tiktok_paid",
    externalAccountId: "advertiser-1",
    currency: "EUR",
    totalMinorUnits: 5_000,
    perCreativeMinorUnits: 5_000,
    perPaidTestMinorUnits: 5_000,
    perCampaignMinorUnits: 5_000,
    dailyAccountMinorUnits: 1_000,
    dailyVentureMinorUnits: 5_000,
    monthlyVentureMinorUnits: 5_000,
    dailyCustomerMinorUnits: 5_000,
    monthlyCustomerMinorUnits: 5_000,
    emergencyPlatformMinorUnits: 5_000,
    allowedCreativeIds: ["creative-1"],
    approvedBy: "founder-1",
    approvalRef: "artifact://approvals/spend-1",
    proposalId: "proposal-1",
    notBefore: "2026-08-09T11:30:00.000Z",
    expiresAt: "2026-08-10T12:00:00.000Z",
    grantHash: "a".repeat(64),
    issuedAt: "2026-08-09T11:20:00.000Z",
  };
}

function reservation(): Reservation {
  return {
    reservationId: "reservation-1",
    organizationId: ORGANIZATION_ID,
    idempotencyKey: "reservation-key-1",
    grantId: "grant-1",
    ventureId: "venture-1",
    creativeId: "creative-1",
    paidTestId: "proposal-1",
    campaignId: "campaign-1",
    externalAccountId: "advertiser-1",
    heldMinorUnits: 5_000,
    settledMinorUnits: null,
    status: "held",
    pendingReason: null,
    pendingAt: null,
    reconciliationOutcome: null,
    reconciledAt: null,
    dayKey: "2026-08-09",
    monthKey: "2026-08",
    createdAt: "2026-08-09T11:31:00.000Z",
  };
}

function paidAuthorityStore(
  options: {
    grant?: SpendGrant | undefined;
    reservation?: Reservation | undefined;
    hashValid?: boolean;
    halted?: boolean;
  } = {},
): WinnerLivePaidAuthorizationStore {
  const storedGrant = Object.prototype.hasOwnProperty.call(options, "grant")
    ? options.grant
    : spendGrant();
  let storedReservation = Object.prototype.hasOwnProperty.call(options, "reservation")
    ? options.reservation
    : reservation();
  return {
    authoritative: true,
    getGrant: async (scope, grantId) =>
      storedGrant?.grantId === grantId &&
      storedGrant.organizationId === scope.organizationId &&
      storedGrant.ventureId === scope.ventureId
        ? storedGrant
        : undefined,
    getReservation: async (scope, reservationId) =>
      storedReservation?.reservationId === reservationId &&
      storedReservation.organizationId === scope.organizationId &&
      storedReservation.ventureId === scope.ventureId
        ? storedReservation
        : undefined,
    verifyGrantHash: async () => options.hashValid ?? true,
    isGrantHalted: async () => options.halted ?? false,
    recordProviderSpend: async (scope, reservationId, actualSpendMinor) => {
      if (
        !storedReservation ||
        storedReservation.organizationId !== scope.organizationId ||
        storedReservation.ventureId !== scope.ventureId ||
        storedReservation.reservationId !== reservationId
      ) {
        throw new Error("reservation unavailable");
      }
      const overspendRecorded = actualSpendMinor > storedReservation.heldMinorUnits;
      storedReservation = Object.freeze({
        ...storedReservation,
        status: "settled" as const,
        settledMinorUnits: actualSpendMinor,
        reconciliationOutcome: "present" as const,
        reconciledAt: NOW,
      });
      return Object.freeze({
        reservation: storedReservation,
        overspendRecorded,
        grantHalted: overspendRecorded,
        providerPauseQueued: overspendRecorded,
      });
    },
  };
}

function fixtureOperationStore(): WinnerLiveProviderOperationStore {
  return createMemoryWinnerLiveProviderOperationStore();
}

function durableTestOperationStore(): WinnerLiveProviderOperationStore {
  const store = new SqliteWinnerLiveProviderOperationStore(
    join(temporaryRoot(), "provider-operations.sqlite"),
  );
  sqliteStores.push(store);
  return store;
}

function evidenceFor(plan: WinnerLiveProviderPlan): WinnerLiveJsonObject {
  switch (plan.adapterId) {
    case "creative_generation":
      return {
        creative_id: plan.payload.creative_id,
        asset_ref: "asset://venture/rendered-creative-1",
        status: "COMPLETED",
      };
    case "tiktok_content_posting":
      return plan.feature === "distribution.content.publish"
        ? {
            creative_id: plan.payload.creative_id,
            publish_id: "publish-1",
            post_id: "post-1",
            status: "PUBLISH_COMPLETE",
          }
        : {
            creative_id: plan.payload.creative_id,
            publish_id: "publish-1",
            status: "SEND_TO_USER_INBOX",
          };
    case "tiktok_spark_ads":
      if (plan.feature === "ads.campaign.pause") {
        return {
          campaign_id: plan.payload.campaign_id,
          pause_applied: true,
          status: "PAUSED",
        };
      }
      return {
        creative_id: plan.payload.creative_id,
        source_post_id: plan.payload.source_post_id,
        campaign_id: "provider-campaign-1",
        configured_budget_minor: plan.payload.total_budget_minor,
        spend_minor: 0,
        auto_scale: false,
        status: "DISABLED_PENDING_START",
      };
    case "aggregated_attribution":
      return {
        attribution_class: "PRIVACY_AGGREGATED",
        aggregate_only: true,
        person_level_rows: 0,
        row_count: 3,
      };
    case "revenuecat":
      return {
        project_id: plan.payload.project_id,
        environment: plan.payload.environment,
        lifecycle_event_count: 4,
        attribution_engine: false,
        subscriber_payload_persisted: false,
      };
  }
}

function fixtureTransport(
  adapterId: WinnerLiveProviderId,
  options: {
    applyState?: "accepted" | "rejected" | "unknown";
    evidence?: (plan: WinnerLiveProviderPlan) => WinnerLiveJsonObject;
    throwApply?: Error;
  } = {},
): WinnerLiveProviderTransport & {
  doctor: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  readBack: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
} {
  const descriptor = WINNER_LIVE_PROVIDER_DESCRIPTORS[adapterId];
  return {
    adapterId,
    kind: "contract_fixture",
    doctor: vi.fn(async (request) => ({
      state: "ready" as const,
      observedAccountId: request.providerAccountId,
      availableFeatures: request.requestedFeatures,
      grantedScopes: request.requiredScopes,
      providerInvoked: false,
      liveVerified: false,
    })),
    apply: vi.fn(async ({ plan }) => {
      if (options.throwApply) throw options.throwApply;
      return {
        state: options.applyState ?? ("accepted" as const),
        providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
        providerInvoked: false,
        externalEffectOccurred: options.applyState === "unknown" ? ("unknown" as const) : false,
        output: { accepted_by_contract_fixture: true },
      };
    }),
    readBack: vi.fn(async ({ plan }) => ({
      state: "matched" as const,
      providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: false,
      liveVerified: false,
      evidence: (options.evidence ?? evidenceFor)(plan),
    })),
    reconcile: vi.fn(async ({ plan }) => ({
      state: "matched" as const,
      providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: false,
      liveVerified: false,
      evidence: (options.evidence ?? evidenceFor)(plan),
    })),
    // Ensure the descriptor is used so every fixture includes the declared contract at compile time.
    ...(descriptor.id === adapterId ? {} : { adapterId: descriptor.id }),
  };
}

function readyContext(plan: WinnerLiveProviderPlan): WinnerLiveProviderContext {
  const context: WinnerLiveProviderContext = {
    organizationId: plan.organizationId,
    credentialRef: `cred://winner-loop/${plan.adapterId}`,
    authorization: authorizationFor(plan),
    executionMode: "authorized_transport",
    environment: "test",
    now,
  };
  if (plan.feature === "distribution.content.publish") {
    return {
      ...context,
      reviewApproval: {
        kind: "organic.direct_publish",
        requestHash: plan.requestHash,
        operationId: plan.operationId,
        approvedBy: "reviewer-1",
        approvalRef: "artifact://approvals/organic-1",
        approvedAt: "2026-08-09T11:45:00.000Z",
        expiresAt: "2026-08-09T13:00:00.000Z",
      },
    };
  }
  if (plan.feature === "ads.organic_post.boost") {
    return {
      ...context,
      reviewApproval: {
        kind: "paid.spark_contract",
        requestHash: plan.requestHash,
        operationId: plan.operationId,
        approvedBy: "founder-1",
        approvalRef: "artifact://approvals/paid-1",
        approvedAt: "2026-08-09T11:45:00.000Z",
        expiresAt: "2026-08-09T13:00:00.000Z",
      },
      spendAuthorityRefs: {
        grantId: "grant-1",
        reservationId: "reservation-1",
      },
    };
  }
  return context;
}

describe("Winner Loop live provider contracts", () => {
  it("declares five production-capable, read-back-gated provider classes", () => {
    expect(WINNER_LIVE_PROVIDER_IDS).toEqual([
      "creative_generation",
      "tiktok_content_posting",
      "tiktok_spark_ads",
      "aggregated_attribution",
      "revenuecat",
    ]);
    for (const id of WINNER_LIVE_PROVIDER_IDS) {
      const descriptor = WINNER_LIVE_PROVIDER_DESCRIPTORS[id];
      expect(descriptor.implementation).toBe("injected_official_transport");
      expect(descriptor.liveVerification).toBe("pending");
      expect(descriptor.features.every((feature) => feature.readBackRequired)).toBe(true);
      expect(descriptor.features.every((feature) => feature.credentialKind.length > 0)).toBe(true);
      expect(descriptor.features.every((feature) => feature.requiredAccountChecks.length > 0)).toBe(
        true,
      );
    }
    expect(WINNER_LIVE_PROVIDER_DESCRIPTORS.tiktok_content_posting.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requiredScopes: ["video.upload"] }),
        expect.objectContaining({ requiredScopes: ["video.publish"] }),
      ]),
    );
    expect(WINNER_LIVE_PROVIDER_DESCRIPTORS.revenuecat.features[0]?.requiredScopes).toEqual([
      "charts_metrics:overview:read",
    ]);
  });

  it.each(WINNER_LIVE_PROVIDER_IDS)(
    "validates and deterministically hashes %s operations",
    (id) => {
      const adapter = createWinnerLiveProviderAdapters()[id];
      const first = adapter.plan(requestFor(id));
      const second = adapter.plan(requestFor(id));
      expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.requestHash).toBe(first.requestHash);
      expect(first.externalExecutionAllowedByPlan).toBe(false);
      expect(first.liveVerification).toBe("pending");
    },
  );

  it("rejects operation/schema mismatches and credential material in payloads", () => {
    const adapter = createWinnerLiveProviderAdapters().creative_generation;
    expect(() =>
      adapter.plan(
        requestFor("creative_generation", "creative.video.generate", {
          payload: { ...payloadFor("creative_generation"), operation: "publish_direct" },
        }),
      ),
    ).toThrow(WinnerLiveProviderContractError);
    expect(() =>
      adapter.plan(
        requestFor("creative_generation", "creative.video.generate", {
          payload: {
            ...payloadFor("creative_generation"),
            access_token: "secret-provider-value",
          },
        }),
      ),
    ).toThrow(/Secret-bearing field/u);
  });

  it.each(WINNER_LIVE_PROVIDER_IDS)(
    "produces a side-effect-free deterministic %s dry run",
    async (id) => {
      const transport = fixtureTransport(id);
      const adapter = createWinnerLiveProviderAdapters({ transports: { [id]: transport } })[id];
      const plan = adapter.plan(requestFor(id));
      const first = await adapter.dryRun(plan);
      const second = await adapter.dryRun(plan);
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        state: "planned",
        providerInvoked: false,
        externalEffectOccurred: false,
        liveVerified: false,
      });
      expect(transport.apply).not.toHaveBeenCalled();
    },
  );

  it("fails closed when transport, credential, or authorization is unavailable", async () => {
    const withoutTransport = createWinnerLiveProviderAdapters().creative_generation;
    const plan = withoutTransport.plan(requestFor("creative_generation"));
    const doctor = await withoutTransport.doctor(
      {
        organizationId: plan.organizationId,
        ventureId: plan.ventureId,
        providerAccountId: plan.providerAccountId,
        features: [plan.feature],
      },
      readyContext(plan),
    );
    expect(doctor.status).toBe("transport_missing");
    expect(doctor.liveVerified).toBe(false);
    const apply = await withoutTransport.apply(plan, readyContext(plan));
    expect(apply).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(apply.diagnostic?.code).toBe("transport_missing");

    const transport = fixtureTransport("creative_generation");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: fixtureOperationStore(),
    }).creative_generation;
    const noCredential = await adapter.apply(plan, {
      organizationId: plan.organizationId,
      authorization: authorizationFor(plan),
      executionMode: "authorized_transport",
      environment: "test",
      now,
    });
    expect(noCredential.diagnostic?.code).toBe("credential_missing");
    const rawCredential = await adapter.apply(plan, {
      organizationId: plan.organizationId,
      credentialRef: "sk_live_not-a-reference",
      authorization: authorizationFor(plan),
      executionMode: "authorized_transport",
      environment: "test",
      now,
    });
    expect(rawCredential.diagnostic?.code).toBe("credential_invalid");
    const noAuthorization = await adapter.apply(plan, {
      organizationId: plan.organizationId,
      credentialRef: "cred://winner-loop/creative",
      executionMode: "authorized_transport",
      environment: "test",
      now,
    });
    expect(noAuthorization.diagnostic?.code).toBe("authorization_missing");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("rejects a provider context and grant attested to a different organization", async () => {
    const transport = fixtureTransport("creative_generation");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: fixtureOperationStore(),
    }).creative_generation;
    const plan = adapter.plan(requestFor("creative_generation"));
    const result = await adapter.apply(plan, {
      ...readyContext(plan),
      organizationId: "org-forged",
      authorization: authorizationFor(plan, { organizationId: "org-forged" }),
    });
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe("authorization_invalid");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("never defaults an authorized effect to an in-memory idempotency ledger", async () => {
    const transport = fixtureTransport("creative_generation");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
    }).creative_generation;
    const plan = adapter.plan(requestFor("creative_generation"));
    const result = await adapter.apply(plan, readyContext(plan));
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe("operation_store_missing");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("refuses to label an in-memory spend ledger as authoritative provider state", () => {
    expect(() => createWinnerLivePaidAuthorizationStore(createSpendLedger({ now }))).toThrow(
      /production-safe spend store/i,
    );
  });

  it("allows the in-memory ledger only for an explicit test fixture transport", async () => {
    const fixture = fixtureTransport("creative_generation");
    const officialTransport: WinnerLiveProviderTransport = {
      ...fixture,
      kind: "official_api",
    };
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: officialTransport },
      store: fixtureOperationStore(),
    }).creative_generation;
    const plan = adapter.plan(requestFor("creative_generation"));
    const result = await adapter.apply(plan, readyContext(plan));
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe("operation_store_unsafe");
    expect(fixture.apply).not.toHaveBeenCalled();
  });

  it("runs doctor through an injected transport but never upgrades fixture evidence to live", async () => {
    for (const id of WINNER_LIVE_PROVIDER_IDS) {
      const transport = fixtureTransport(id);
      const adapter = createWinnerLiveProviderAdapters({ transports: { [id]: transport } })[id];
      const plan = adapter.plan(requestFor(id));
      const result = await adapter.doctor(
        {
          organizationId: plan.organizationId,
          ventureId: plan.ventureId,
          providerAccountId: plan.providerAccountId,
          features: [plan.feature],
        },
        readyContext(plan),
      );
      expect(result).toMatchObject({ status: "ready", liveVerified: false });
      expect(result.availableFeatures).toContain(plan.feature);
      expect(transport.doctor).toHaveBeenCalledOnce();
    }
  });

  it("refuses to substitute a contract fixture for a production transport", async () => {
    const transport = fixtureTransport("creative_generation");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: fixtureOperationStore(),
    }).creative_generation;
    const plan = adapter.plan(requestFor("creative_generation"));
    const context = { ...readyContext(plan), environment: "production" as const };
    const doctor = await adapter.doctor(
      {
        organizationId: plan.organizationId,
        ventureId: plan.ventureId,
        providerAccountId: plan.providerAccountId,
        features: [plan.feature],
      },
      context,
    );
    expect(doctor.diagnostics[0]?.code).toBe("transport_mismatch");
    const result = await adapter.apply(plan, context);
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe("transport_mismatch");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it.each(WINNER_LIVE_PROVIDER_IDS.filter((id) => id !== "tiktok_content_posting"))(
    "runs the complete %s apply/read-back lifecycle without claiming fixture state is live",
    async (id) => {
      const transport = fixtureTransport(id);
      const adapter = createWinnerLiveProviderAdapters({
        transports: { [id]: transport },
        store: fixtureOperationStore(),
        paidAuthorizationStore: id === "tiktok_spark_ads" ? paidAuthorityStore() : undefined,
      })[id];
      const plan = adapter.plan(requestFor(id));
      const context = readyContext(plan);
      const applied = await adapter.apply(plan, context);
      expect(applied).toMatchObject({
        state: "accepted_unverified",
        liveVerified: false,
      });
      const verified = await adapter.verify(plan, context);
      expect(verified).toMatchObject({ state: "verified", liveVerified: false });
      expect(verified.evidence).toEqual(evidenceFor(plan));
      expect(transport.apply).toHaveBeenCalledOnce();
      expect(transport.readBack).toHaveBeenCalledOnce();
    },
  );

  it("reuses an identical idempotency binding and conflicts on changed input", async () => {
    const transport = fixtureTransport("creative_generation");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: fixtureOperationStore(),
    }).creative_generation;
    const original = adapter.plan(requestFor("creative_generation"));
    const first = await adapter.apply(original, readyContext(original));
    const replay = await adapter.apply(original, readyContext(original));
    expect(first.state).toBe("accepted_unverified");
    expect(replay).toMatchObject({ state: "accepted_unverified", reused: true });
    expect(transport.apply).toHaveBeenCalledOnce();

    const changed = adapter.plan(
      requestFor("creative_generation", "creative.video.generate", {
        payload: { ...payloadFor("creative_generation"), provider_model: "video-model-2" },
      }),
    );
    const conflict = await adapter.apply(changed, readyContext(changed));
    expect(conflict).toMatchObject({ state: "conflict", providerInvoked: false });
    expect(conflict.diagnostic?.code).toBe("idempotency_conflict");
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("uses one durable atomic claim across concurrent workers and adapter restart", async () => {
    const transport = fixtureTransport("creative_generation");
    const store = durableTestOperationStore();
    const firstWorker = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store,
    }).creative_generation;
    const secondWorker = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store,
    }).creative_generation;
    const plan = firstWorker.plan(requestFor("creative_generation"));
    const [left, right] = await Promise.all([
      firstWorker.apply(plan, readyContext(plan)),
      secondWorker.apply(plan, readyContext(plan)),
    ]);
    expect([left.state, right.state]).toContain("accepted_unverified");
    expect([left.reused, right.reused]).toContain(true);
    expect(transport.apply).toHaveBeenCalledOnce();

    const restartedWorker = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store,
    }).creative_generation;
    const afterRestart = await restartedWorker.apply(plan, readyContext(plan));
    expect(afterRestart).toMatchObject({ state: "accepted_unverified", reused: true });
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous outcome without replaying the provider mutation", async () => {
    const transport = fixtureTransport("creative_generation", { applyState: "unknown" });
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: fixtureOperationStore(),
    }).creative_generation;
    const plan = adapter.plan(requestFor("creative_generation"));
    const context = readyContext(plan);
    const unknown = await adapter.apply(plan, context);
    expect(unknown).toMatchObject({ state: "unknown", externalEffectOccurred: "unknown" });
    const replay = await adapter.apply(plan, context);
    expect(replay).toMatchObject({ state: "unknown", reused: true, providerInvoked: false });
    expect(transport.apply).toHaveBeenCalledOnce();
    const reconciled = await adapter.reconcile(plan, context);
    expect(reconciled).toMatchObject({ state: "matched", reapplied: false, liveVerified: false });
    expect(transport.reconcile).toHaveBeenCalledOnce();
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("persists a late provider match after confirmed absence and never regresses verified state", async () => {
    const directory = temporaryRoot();
    const operationPath = join(directory, "late-provider-match.sqlite");
    const transport = fixtureTransport("creative_generation");
    transport.reconcile.mockResolvedValueOnce({
      state: "missing" as const,
      providerOperationId: null,
      providerInvoked: false,
      liveVerified: false,
      evidence: null,
    });
    const firstStore = new SqliteWinnerLiveProviderOperationStore(operationPath);
    sqliteStores.push(firstStore);
    const firstAdapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: firstStore,
    }).creative_generation;
    const plan = firstAdapter.plan(requestFor("creative_generation"));
    const context = readyContext(plan);
    expect(await firstAdapter.apply(plan, context)).toMatchObject({
      state: "accepted_unverified",
    });
    expect(await firstAdapter.reconcile(plan, context)).toMatchObject({ state: "missing" });
    expect(
      await firstStore.get(
        plan.organizationId,
        plan.ventureId,
        plan.adapterId,
        plan.idempotencyKey,
      ),
    ).toMatchObject({ state: "confirmed_absent" });

    firstStore.close();
    const restartedStore = new SqliteWinnerLiveProviderOperationStore(operationPath);
    sqliteStores.push(restartedStore);
    const restartedAdapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: restartedStore,
    }).creative_generation;
    expect(await restartedAdapter.reconcile(plan, context)).toMatchObject({
      state: "matched",
      reapplied: false,
      evidence: { creative_id: "creative-1", status: "COMPLETED" },
    });
    expect(
      await restartedStore.get(
        plan.organizationId,
        plan.ventureId,
        plan.adapterId,
        plan.idempotencyKey,
      ),
    ).toMatchObject({ state: "verified", evidence: { creative_id: "creative-1" } });

    transport.reconcile.mockResolvedValueOnce({
      state: "missing" as const,
      providerOperationId: null,
      providerInvoked: false,
      liveVerified: false,
      evidence: null,
    });
    expect(await restartedAdapter.reconcile(plan, context)).toMatchObject({
      state: "conflict",
      reapplied: false,
      evidence: { creative_id: "creative-1", status: "COMPLETED" },
      diagnostic: { code: "verification_mismatch" },
    });
    expect(
      await restartedStore.get(
        plan.organizationId,
        plan.ventureId,
        plan.adapterId,
        plan.idempotencyKey,
      ),
    ).toMatchObject({ state: "verified" });
    expect(await restartedAdapter.apply(plan, context)).toMatchObject({
      state: "accepted_unverified",
      reused: true,
      providerInvoked: false,
    });
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("reconciles an unknown paid write after write review and Spend Grant expiry", async () => {
    const transport = fixtureTransport("tiktok_spark_ads", { applyState: "unknown" });
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: durableTestOperationStore(),
      paidAuthorizationStore: paidAuthorityStore(),
    }).tiktok_spark_ads;
    const plan = adapter.plan(requestFor("tiktok_spark_ads"));
    const applied = await adapter.apply(plan, readyContext(plan));
    expect(applied.state).toBe("unknown");

    const expiredWriteContext: WinnerLiveProviderContext = {
      ...readyContext(plan),
      authorization: authorizationFor(plan, {
        issuedAt: "2026-08-09T09:00:00.000Z",
        expiresAt: "2026-08-09T11:59:00.000Z",
      }),
      reviewApproval: {
        ...readyContext(plan).reviewApproval!,
        approvedAt: "2026-08-09T10:00:00.000Z",
        expiresAt: "2026-08-09T11:59:00.000Z",
      },
      spendAuthorityRefs: undefined,
      reconciliationAuthorization: authorizationFor(plan, {
        sourceGrantId: "reconciliation-read-grant-1",
        allowedEffects: ["external_read"],
      }),
    };
    const reconciled = await adapter.reconcile(plan, expiredWriteContext);
    expect(reconciled).toMatchObject({ state: "matched", reapplied: false });
    expect(transport.reconcile).toHaveBeenCalledOnce();
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("records provider overspend before rejecting read-back and preserves it across restart", async () => {
    const directory = temporaryRoot();
    const operationPath = join(directory, "paid-provider-operations.sqlite");
    const spendPath = join(directory, "paid-spend.sqlite");
    const openSpend = (): SpendLedger => {
      const store = createSqliteSpendStore(spendPath);
      spendStores.push(store);
      return createSpendLedger({
        store,
        now,
        randomBytes: (size) => new Uint8Array(size).fill(7),
      });
    };
    const firstLedger = openSpend();
    const grant = firstLedger.registerGrant({
      organizationId: ORGANIZATION_ID,
      ventureId: "venture-1",
      customerId: "customer-1",
      network: "tiktok_paid",
      externalAccountId: "advertiser-1",
      currency: "EUR",
      totalMinorUnits: 5_000,
      perCreativeMinorUnits: 5_000,
      dailyAccountMinorUnits: 5_000,
      perPaidTestMinorUnits: 5_000,
      perCampaignMinorUnits: 5_000,
      dailyVentureMinorUnits: 5_000,
      monthlyVentureMinorUnits: 5_000,
      dailyCustomerMinorUnits: 5_000,
      monthlyCustomerMinorUnits: 5_000,
      emergencyPlatformMinorUnits: 5_000,
      allowedCreativeIds: ["creative-1"],
      approvedBy: "founder-1",
      approvalRef: "artifact://approvals/spend-overspend",
      proposalId: "proposal-1",
      notBefore: "2026-08-09T11:30:00.000Z",
      expiresAt: "2026-08-10T12:00:00.000Z",
    });
    const held = firstLedger.reserve({
      organizationId: ORGANIZATION_ID,
      ventureId: "venture-1",
      grantId: grant.grantId,
      creativeId: "creative-1",
      campaignId: "campaign-1",
      amountMinorUnits: 5_000,
      idempotencyKey: "paid-reservation-overspend",
      paidTestId: "proposal-1",
      network: "tiktok_paid",
      externalAccountId: "advertiser-1",
      currency: "EUR",
    });
    const firstAuthority = createWinnerLivePaidAuthorizationStore(firstLedger);
    expect(
      await firstAuthority.verifyGrantHash(
        { organizationId: ORGANIZATION_ID, ventureId: "venture-1" },
        { ...grant, totalMinorUnits: grant.totalMinorUnits + 1 },
      ),
    ).toBe(false);
    const transport = fixtureTransport("tiktok_spark_ads", {
      applyState: "unknown",
      evidence: (plan) => ({
        ...evidenceFor(plan),
        spend_minor: 5_001,
      }),
    });
    const firstOperationStore = new SqliteWinnerLiveProviderOperationStore(operationPath);
    sqliteStores.push(firstOperationStore);
    const firstAdapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: firstOperationStore,
      paidAuthorizationStore: firstAuthority,
    }).tiktok_spark_ads;
    const plan = firstAdapter.plan(requestFor("tiktok_spark_ads"));
    const writeContext: WinnerLiveProviderContext = {
      ...readyContext(plan),
      spendAuthorityRefs: {
        grantId: grant.grantId,
        reservationId: held.reservationId,
      },
    };
    expect(await firstAdapter.apply(plan, writeContext)).toMatchObject({ state: "unknown" });
    expect(transport.apply).toHaveBeenCalledOnce();

    firstOperationStore.close();
    firstLedger.store.close();
    const restartedLedger = openSpend();
    const restartedOperationStore = new SqliteWinnerLiveProviderOperationStore(operationPath);
    sqliteStores.push(restartedOperationStore);
    const restartedAdapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: restartedOperationStore,
      paidAuthorizationStore: createWinnerLivePaidAuthorizationStore(restartedLedger),
    }).tiktok_spark_ads;
    const readContext: WinnerLiveProviderContext = {
      ...readyContext(plan),
      spendAuthorityRefs: undefined,
      reconciliationAuthorization: authorizationFor(plan, {
        sourceGrantId: "paid-overspend-read-grant",
        allowedEffects: ["external_read"],
      }),
    };
    const reconciled = await restartedAdapter.reconcile(plan, readContext);
    expect(reconciled).toMatchObject({
      state: "conflict",
      reapplied: false,
      liveVerified: false,
      diagnostic: { code: "provider_overspend" },
      evidence: { spend_minor: 5_001 },
    });
    const scope = { organizationId: ORGANIZATION_ID, ventureId: "venture-1" };
    expect(
      restartedLedger.getReservation({ ...scope, reservationId: held.reservationId }),
    ).toMatchObject({ status: "settled", settledMinorUnits: 5_001 });
    expect(restartedLedger.isHalted({ ...scope, grantId: grant.grantId })).toBe(true);
    expect(restartedLedger.listIncidents({ ...scope, grantId: grant.grantId })).toHaveLength(1);
    expect(
      restartedLedger.listProviderPauseObligations({ ...scope, grantId: grant.grantId }),
    ).toHaveLength(1);
    expect(transport.apply).toHaveBeenCalledOnce();

    restartedOperationStore.close();
    restartedLedger.store.close();
    const secondRestartLedger = openSpend();
    const secondRestartOperationStore = new SqliteWinnerLiveProviderOperationStore(operationPath);
    sqliteStores.push(secondRestartOperationStore);
    const secondRestartAdapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: secondRestartOperationStore,
      paidAuthorizationStore: createWinnerLivePaidAuthorizationStore(secondRestartLedger),
    }).tiktok_spark_ads;
    expect(await secondRestartAdapter.reconcile(plan, readContext)).toMatchObject({
      state: "conflict",
      diagnostic: { code: "provider_overspend" },
    });
    expect(secondRestartLedger.listIncidents({ ...scope, grantId: grant.grantId })).toHaveLength(1);
    expect(
      secondRestartLedger.listProviderPauseObligations({ ...scope, grantId: grant.grantId }),
    ).toHaveLength(1);
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("normalizes ambiguous transport errors and redacts their credential material", async () => {
    const transport = fixtureTransport("creative_generation", {
      throwApply: new WinnerLiveTransportError(
        "upstream_timeout",
        "effect_may_have_occurred",
        true,
        "timeout after Authorization: Bearer super-secret-token",
      ),
    });
    const adapter = createWinnerLiveProviderAdapters({
      transports: { creative_generation: transport },
      store: fixtureOperationStore(),
    }).creative_generation;
    const plan = adapter.plan(requestFor("creative_generation"));
    const result = await adapter.apply(plan, readyContext(plan));
    expect(result).toMatchObject({ state: "unknown", externalEffectOccurred: "unknown" });
    expect(result.diagnostic).toMatchObject({
      code: "outcome_ambiguous",
      providerCode: "upstream_timeout",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  it("fails verification when provider read-back violates category invariants", async () => {
    const transport = fixtureTransport("aggregated_attribution", {
      evidence: () => ({
        attribution_class: "DETERMINISTIC",
        aggregate_only: false,
        person_level_rows: 12,
      }),
    });
    const adapter = createWinnerLiveProviderAdapters({
      transports: { aggregated_attribution: transport },
      store: fixtureOperationStore(),
    }).aggregated_attribution;
    const plan = adapter.plan(requestFor("aggregated_attribution"));
    const context = readyContext(plan);
    await adapter.apply(plan, context);
    const verified = await adapter.verify(plan, context);
    expect(verified).toMatchObject({ state: "failed", liveVerified: false, evidence: null });
    expect(verified.diagnostic?.code).toBe("verification_mismatch");
  });

  it("requires request-bound human review before direct publication", async () => {
    const transport = fixtureTransport("tiktok_content_posting");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_content_posting: transport },
      store: fixtureOperationStore(),
    }).tiktok_content_posting;
    const plan = adapter.plan(requestFor("tiktok_content_posting", "distribution.content.publish"));
    const ordinaryLaunchContext: WinnerLiveProviderContext = {
      organizationId: plan.organizationId,
      credentialRef: "cred://winner-loop/tiktok",
      authorization: authorizationFor(plan, {
        sourceGrantKind: "launch_grant",
        allowedFeatures: ["distribution.content.draft"],
        allowedEffects: ["reversible_external_write"],
      }),
      executionMode: "authorized_transport",
      environment: "test",
      now,
    };
    const ordinaryLaunch = await adapter.apply(plan, ordinaryLaunchContext);
    expect(ordinaryLaunch).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(ordinaryLaunch.diagnostic?.code).toBe("authorization_invalid");

    const noReview = await adapter.apply(plan, {
      ...readyContext(plan),
      reviewApproval: undefined,
    });
    expect(noReview.diagnostic?.code).toBe("review_missing");
    const mismatchedReview = await adapter.apply(plan, {
      ...readyContext(plan),
      reviewApproval: {
        ...readyContext(plan).reviewApproval!,
        requestHash: "f".repeat(64),
      },
    });
    expect(mismatchedReview.diagnostic?.code).toBe("review_invalid");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("requires a separate exact Spend Grant and held reservation despite a Launch Grant", async () => {
    const transport = fixtureTransport("tiktok_spark_ads");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: fixtureOperationStore(),
      paidAuthorizationStore: paidAuthorityStore(),
    }).tiktok_spark_ads;
    const plan = adapter.plan(requestFor("tiktok_spark_ads"));
    const complete = readyContext(plan);
    const launchOnly = await adapter.apply(plan, {
      ...complete,
      authorization: authorizationFor(plan, { sourceGrantKind: "launch_grant" }),
      spendAuthorityRefs: undefined,
    });
    expect(launchOnly).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(launchOnly.diagnostic?.code).toBe("spend_grant_missing");

    const noReservation = await adapter.apply(plan, {
      ...complete,
      spendAuthorityRefs: { grantId: "grant-1", reservationId: "" },
    });
    expect(noReservation.diagnostic?.code).toBe("reservation_missing");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("rejects forged paid authority IDs that resolve to another organization", async () => {
    const transport = fixtureTransport("tiktok_spark_ads");
    const crossOrganizationGrant: SpendGrant = {
      ...spendGrant(),
      organizationId: "org-forged",
    };
    const crossOrganizationReservation: Reservation = {
      ...reservation(),
      organizationId: "org-forged",
    };
    const maliciousLookup: WinnerLivePaidAuthorizationStore = {
      authoritative: true,
      getGrant: async () => crossOrganizationGrant,
      getReservation: async () => crossOrganizationReservation,
      verifyGrantHash: async () => true,
      isGrantHalted: async () => false,
      recordProviderSpend: async () => {
        throw new Error("must not settle a forged cross-organization reservation");
      },
    };
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: fixtureOperationStore(),
      paidAuthorizationStore: maliciousLookup,
    }).tiktok_spark_ads;
    const plan = adapter.plan(requestFor("tiktok_spark_ads"));
    const result = await adapter.apply(plan, readyContext(plan));
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe("spend_grant_invalid");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("does not trust paid authority identities without an authoritative spend store", async () => {
    const transport = fixtureTransport("tiktok_spark_ads");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: fixtureOperationStore(),
    }).tiktok_spark_ads;
    const plan = adapter.plan(requestFor("tiktok_spark_ads"));
    const result = await adapter.apply(plan, readyContext(plan));
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe("spend_authority_store_missing");
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "forged grant hash",
      authority: paidAuthorityStore({ hashValid: false }),
      code: "grant_hash_invalid",
    },
    {
      name: "halted grant",
      authority: paidAuthorityStore({ halted: true }),
      code: "spend_halted",
    },
    {
      name: "released reservation",
      authority: paidAuthorityStore({ reservation: { ...reservation(), status: "released" } }),
      code: "reservation_invalid",
    },
    {
      name: "cross-tenant grant hidden by scoped lookup",
      authority: paidAuthorityStore({ grant: { ...spendGrant(), ventureId: "venture-other" } }),
      code: "spend_grant_missing",
    },
    {
      name: "cross-account reservation",
      authority: paidAuthorityStore({
        reservation: { ...reservation(), externalAccountId: "advertiser-other" },
      }),
      code: "reservation_invalid",
    },
  ])("rejects $name resolved from the authoritative spend store", async ({ authority, code }) => {
    const transport = fixtureTransport("tiktok_spark_ads");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: fixtureOperationStore(),
      paidAuthorizationStore: authority,
    }).tiktok_spark_ads;
    const plan = adapter.plan(requestFor("tiktok_spark_ads"));
    const result = await adapter.apply(plan, readyContext(plan));
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe(code);
    expect(transport.apply).not.toHaveBeenCalled();
  });

  it("treats provider-side campaign pause as an idempotent read-back-verified operation", async () => {
    const transport = fixtureTransport("tiktok_spark_ads");
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: durableTestOperationStore(),
    }).tiktok_spark_ads;
    const plan = adapter.plan(requestFor("tiktok_spark_ads", "ads.campaign.pause"));
    const context = readyContext(plan);
    const accepted = await adapter.apply(plan, context);
    expect(accepted).toMatchObject({
      state: "accepted_unverified",
      liveVerified: false,
    });
    expect(accepted.diagnostic?.code).toBe("verification_pending");
    const replay = await adapter.apply(plan, context);
    expect(replay).toMatchObject({ state: "accepted_unverified", reused: true });
    const verified = await adapter.verify(plan, context);
    expect(verified).toMatchObject({ state: "verified", liveVerified: false });
    expect(verified.evidence).toEqual({
      campaign_id: "provider-campaign-1",
      pause_applied: true,
      status: "PAUSED",
    });
    expect(transport.apply).toHaveBeenCalledOnce();
    expect(transport.readBack).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous campaign pause without issuing a second pause", async () => {
    const transport = fixtureTransport("tiktok_spark_ads", { applyState: "unknown" });
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_spark_ads: transport },
      store: durableTestOperationStore(),
    }).tiktok_spark_ads;
    const plan = adapter.plan(requestFor("tiktok_spark_ads", "ads.campaign.pause"));
    const context = readyContext(plan);
    expect((await adapter.apply(plan, context)).state).toBe("unknown");
    const reconciled = await adapter.reconcile(plan, context);
    expect(reconciled).toMatchObject({ state: "matched", reapplied: false });
    expect(transport.apply).toHaveBeenCalledOnce();
    expect(transport.reconcile).toHaveBeenCalledOnce();
  });

  it("redacts secrets, sensitive upload URLs, and diagnostic values while preserving refs", () => {
    const adapter = createWinnerLiveProviderAdapters().tiktok_content_posting;
    const redacted = adapter.redact({
      credentialRef: "cred://winner-loop/tiktok",
      authorization: "Bearer abcdefghijklmnop",
      nested: {
        api_key: "plain-secret",
        upload_url: "https://upload.example/video?upload_token=opaque-value&id=1",
      },
    });
    expect(redacted).toEqual({
      credentialRef: "cred://winner-loop/tiktok",
      authorization: "[REDACTED]",
      nested: { api_key: "[REDACTED]", upload_url: "[REDACTED]" },
    });
    expect(JSON.stringify(redacted)).not.toContain("opaque-value");
  });
});
