import { describe, expect, it, vi } from "vitest";
import type { CohortSnapshot, WinnerLoopLearning } from "@/lib/winner-loop";
import {
  WINNER_LOOP_EVENT_NAMES,
  WINNER_LOOP_EVENT_PACK,
  WINNER_LOOP_EVENT_SPECS,
  WINNER_PROVIDER_ADAPTER_IDS,
  WINNER_PROVIDER_DESCRIPTORS,
  assertWinnerLoopEventPackParity,
  createFixtureDistributionPrProposal,
  createMemoryWinnerProviderFixtureStore,
  createWinnerLoopEventRuntime,
  createWinnerProviderFixtureAdapters,
  type FixtureJsonObject,
  type WinnerLoopEvent,
  type WinnerLoopEventName,
  type WinnerLoopEventProperties,
  type WinnerProviderAdapterId,
  type WinnerProviderFixtureContext,
  type WinnerProviderFixtureRecord,
  type WinnerProviderFixtureStore,
  type WinnerProviderPlan,
} from "@/lib/winner-integrations";

const NOW = "2026-08-09T08:00:00.000Z";
const now = () => new Date(NOW);

const EVENT_PROPERTIES = {
  creative_hypothesis_created: {
    hypothesis_id: "hyp_fixture_1",
    creative_family_id: "family_fixture_1",
    hypothesis_version: "v1",
  },
  creative_render_requested: {
    creative_id: "creative_fixture_1",
    render_job_id: "render_fixture_1",
    renderer_kind: "local_fixture",
  },
  creative_render_completed: {
    creative_id: "creative_fixture_1",
    render_job_id: "render_fixture_1",
    asset_manifest_id: "manifest_fixture_1",
    render_status: "completed",
  },
  creative_rights_reviewed: {
    creative_id: "creative_fixture_1",
    manifest_id: "manifest_fixture_1",
    rights_status: "approved_paid",
    reviewer_role: "fixture_reviewer",
  },
  creative_approved_for_organic: {
    creative_id: "creative_fixture_1",
    manifest_id: "manifest_fixture_1",
    review_mode: "human",
  },
  organic_post_published: {
    creative_id: "creative_fixture_1",
    publication_id: "publication_fixture_1",
    provider_kind: "content_platform_fixture",
    publication_mode: "direct",
  },
  organic_metric_snapshot: {
    creative_id: "creative_fixture_1",
    snapshot_id: "snapshot_fixture_1",
    offset_minutes: 120,
    metric_count: 8,
    data_quality: "complete",
  },
  winner_evaluation_completed: {
    creative_id: "creative_fixture_1",
    recommendation_id: "recommendation_fixture_1",
    scoring_version: "winner-score-v1",
    recommendation: "PAID_TEST_CANDIDATE",
    confidence: "medium",
  },
  boost_candidate_recommended: {
    creative_id: "creative_fixture_1",
    recommendation_id: "recommendation_fixture_1",
    baseline_definition_id: "baseline_fixture_1",
  },
  paid_test_proposed: {
    creative_id: "creative_fixture_1",
    proposal_id: "paid_proposal_fixture_1",
    network_kind: "short_video_network",
    hard_cap_minor: 5_000,
    currency: "EUR",
  },
  spend_grant_approved: {
    grant_id: "spend_grant_fixture_1",
    proposal_id: "paid_proposal_fixture_1",
    approved_cap_minor: 5_000,
    currency: "EUR",
    approval_mode: "human",
  },
  spend_reserved: {
    grant_id: "spend_grant_fixture_1",
    reservation_id: "reservation_fixture_1",
    reserved_minor: 1_000,
    currency: "EUR",
  },
  paid_test_started: {
    creative_id: "creative_fixture_1",
    paid_test_id: "paid_test_fixture_1",
    grant_id: "spend_grant_fixture_1",
    network_kind: "short_video_network",
  },
  paid_test_paused: {
    creative_id: "creative_fixture_1",
    paid_test_id: "paid_test_fixture_1",
    pause_reason: "tracking_health_failed",
  },
  paid_test_completed: {
    creative_id: "creative_fixture_1",
    paid_test_id: "paid_test_fixture_1",
    outcome: "inconclusive",
  },
  attribution_evidence_recorded: {
    creative_id: "creative_fixture_1",
    attribution_id: "attribution_fixture_1",
    attribution_class: "PRIVACY_AGGREGATED",
    attribution_provider_kind: "aggregate_fixture",
    window_hours: 24,
  },
  subscription_event_ingested: {
    subscription_event_id: "subscription_fixture_1",
    event_type: "INITIAL_PURCHASE",
    environment: "sandbox",
    currency: "EUR",
  },
  cohort_snapshot_calculated: {
    creative_id: "creative_fixture_1",
    cohort_window: "D7",
    attribution_class: "PRIVACY_AGGREGATED",
    subscriber_count: 4,
    data_quality: "partial",
  },
  creative_paid_proof: {
    creative_id: "creative_fixture_1",
    proof_id: "proof_fixture_1",
    attribution_class: "PROVIDER_ATTRIBUTED",
    net_revenue_minor: 8_000,
    currency: "EUR",
  },
  creative_fatigued: {
    creative_id: "creative_fixture_1",
    fatigue_evaluation_id: "fatigue_fixture_1",
    evidence_window: "P7D",
    action: "recommend_pause",
  },
} as const satisfies {
  readonly [Name in WinnerLoopEventName]: WinnerLoopEventProperties[Name];
};

function eventFor<Name extends WinnerLoopEventName>(name: Name): WinnerLoopEvent {
  return {
    name,
    schemaVersion: 1,
    eventId: `event_${name}`,
    ventureId: "venture_fixture_1",
    occurredAt: NOW,
    providerProvenance: {
      adapterKind: "fixture_adapter",
      evidenceRef: `fixture://${name}`,
      fixture: true,
    },
    properties: EVENT_PROPERTIES[name],
  } as WinnerLoopEvent;
}

describe("installable Winner Loop event pack", () => {
  it("keeps the typed event names, runtime specs, and first-party privacy policy in parity", () => {
    expect(() => assertWinnerLoopEventPackParity()).not.toThrow();
    expect(Object.keys(WINNER_LOOP_EVENT_SPECS).sort()).toEqual(
      [...WINNER_LOOP_EVENT_NAMES].sort(),
    );
    expect(WINNER_LOOP_EVENT_PACK).toMatchObject({
      id: "winner_loop",
      version: 1,
      installable: true,
      enabledByDefault: false,
      activationCapability: "winner_loop",
    });
    for (const spec of Object.values(WINNER_LOOP_EVENT_SPECS)) {
      expect(spec.destinations).toEqual(["first_party_evidence"]);
      expect(spec.piiAllowed).toBe(false);
      expect(spec.rawCreativeContentAllowed).toBe(false);
      expect(spec.providerProvenanceRequired).toBe(true);
      for (const property of spec.allowedProperties) {
        expect(property).not.toMatch(
          /(^|_)(prompt|script|message|credential|private_asset|asset_content|email|phone)(_|$)/i,
        );
      }
    }
  });

  it("requires explicit install and enable before recording anything", () => {
    const sink = vi.fn();
    const runtime = createWinnerLoopEventRuntime({ sink });
    expect(runtime.isInstalled()).toBe(false);
    expect(runtime.isEnabled()).toBe(false);
    expect(() => runtime.enable()).toThrowError(
      expect.objectContaining({ code: "pack_not_installed" }) as never,
    );
    expect(() => runtime.emit(eventFor("creative_hypothesis_created"))).toThrowError(
      expect.objectContaining({ code: "pack_not_enabled" }) as never,
    );
    expect(sink).not.toHaveBeenCalled();
    expect(runtime.recorded()).toEqual([]);
  });

  it("records the complete lifecycle only while the installed pack is enabled", () => {
    const runtime = createWinnerLoopEventRuntime();
    runtime.install();
    runtime.install();
    runtime.enable();
    for (const name of WINNER_LOOP_EVENT_NAMES) runtime.emit(eventFor(name));
    expect(runtime.recorded().map(({ name }) => name)).toEqual(WINNER_LOOP_EVENT_NAMES);
    runtime.disable();
    expect(() => runtime.emit(eventFor("creative_fatigued"))).toThrowError(
      expect.objectContaining({ code: "pack_not_enabled" }) as never,
    );
    expect(runtime.recorded()).toHaveLength(WINNER_LOOP_EVENT_NAMES.length);
  });

  it("rejects unknown, private, personal, and credential-like properties before the sink", () => {
    const sink = vi.fn();
    const runtime = createWinnerLoopEventRuntime({ sink });
    runtime.install();
    runtime.enable();

    const rawScript = {
      ...eventFor("creative_render_requested"),
      properties: {
        ...EVENT_PROPERTIES.creative_render_requested,
        raw_script: "private fixture script",
      },
    } as unknown as WinnerLoopEvent;
    expect(() => runtime.emit(rawScript)).toThrowError(
      expect.objectContaining({ code: "unsafe_event_payload" }) as never,
    );

    const personal = {
      ...eventFor("creative_rights_reviewed"),
      properties: {
        ...EVENT_PROPERTIES.creative_rights_reviewed,
        reviewer_role: "person@example.test",
      },
    } as WinnerLoopEvent;
    expect(() => runtime.emit(personal)).toThrowError(/email-like value/i);

    const fullName = {
      ...eventFor("creative_rights_reviewed"),
      properties: {
        ...EVENT_PROPERTIES.creative_rights_reviewed,
        reviewer_role: "Alice Example",
      },
    } as WinnerLoopEvent;
    expect(() => runtime.emit(fullName)).toThrowError(/accepts tokens only/i);

    const credential = {
      ...eventFor("creative_render_requested"),
      properties: {
        ...EVENT_PROPERTIES.creative_render_requested,
        renderer_kind: "cred://renderer/private",
      },
    } as WinnerLoopEvent;
    expect(() => runtime.emit(credential)).toThrowError(/credential-like value/i);
    expect(sink).not.toHaveBeenCalled();
  });
});

function readyContext(adapterId: WinnerProviderAdapterId): WinnerProviderFixtureContext {
  return {
    fixtureExecution: true,
    credentialRefs:
      adapterId === "fixture_local_renderer"
        ? {}
        : { [adapterId]: `cred://winner-loop/${adapterId}` },
    reviewApprovals: ["organic.direct_publish", "paid.spark_contract"],
    now,
  };
}

function payloadFor(adapterId: WinnerProviderAdapterId): FixtureJsonObject {
  switch (adapterId) {
    case "fixture_local_renderer":
      return { creative_id: "creative_fixture_1", render_profile: "vertical_video_fixture" };
    case "fixture_organic_content":
      return { creative_id: "creative_fixture_1", caption_class: "product_demo" };
    case "fixture_tiktok_spark":
      return { source_post_ref: "fixture-post-1", creative_id: "creative_fixture_1" };
    case "fixture_aggregated_attribution":
      return { aggregate_rows: 3, reporting_window: "P1D" };
    case "fixture_revenuecat":
      return { lifecycle_event_count: 4, environment: "sandbox" };
  }
}

const PROVIDER_TENANT = {
  organizationId: "organization_fixture_1",
  ventureId: "venture_fixture_1",
} as const;

describe("fixture-backed Winner Loop provider contracts", () => {
  it("exposes the complete provider-neutral lifecycle and feature declarations", async () => {
    const adapters = createWinnerProviderFixtureAdapters();
    expect(Object.keys(adapters).sort()).toEqual([...WINNER_PROVIDER_ADAPTER_IDS].sort());
    for (const adapterId of WINNER_PROVIDER_ADAPTER_IDS) {
      const adapter = adapters[adapterId];
      expect(adapter.descriptor).toBe(WINNER_PROVIDER_DESCRIPTORS[adapterId]);
      expect(adapter.descriptor.fixtureOnly).toBe(true);
      expect(adapter.descriptor.features.length).toBeGreaterThan(0);
      expect(adapter.featureAvailability(readyContext(adapterId))).toEqual(
        expect.arrayContaining([expect.objectContaining({ fixtureOnly: true })]),
      );
      for (const method of [
        "doctor",
        "plan",
        "dryRun",
        "apply",
        "readBack",
        "verify",
        "reconcile",
        "redact",
        "featureAvailability",
      ]) {
        expect(typeof adapter[method as keyof typeof adapter]).toBe("function");
      }
      expect((await adapter.doctor(readyContext(adapterId))).fixtureOnly).toBe(true);
    }
  });

  it("runs doctor, plan, dry-run, apply, read-back, verify, and reconcile for all five fixtures", async () => {
    const store = createMemoryWinnerProviderFixtureStore();
    const adapters = createWinnerProviderFixtureAdapters({ store });
    for (const adapterId of WINNER_PROVIDER_ADAPTER_IDS) {
      const adapter = adapters[adapterId];
      const context = readyContext(adapterId);
      const doctor = await adapter.doctor(context, [adapter.descriptor.defaultFeature]);
      expect(doctor.status).toBe("ready");
      const plan = adapter.plan(
        {
          tenant: PROVIDER_TENANT,
          operationId: `operation_${adapterId}`,
          idempotencyKey: `idempotency_${adapterId}`,
          payload: payloadFor(adapterId),
        },
        context,
      );
      expect(plan).toMatchObject({
        state: "ready",
        fixtureOnly: true,
        externalExecutionAllowed: false,
        publicationAllowed: false,
        spendAllowed: false,
        maxSpendMinor: 0,
      });
      expect((await adapter.dryRun(plan)).state).toBe("planned");
      const applied = await adapter.apply(plan, context);
      expect(applied).toMatchObject({
        state: "succeeded",
        reused: false,
        providerInvoked: false,
        externalEffectOccurred: false,
      });
      expect((await adapter.readBack(plan)).state).toBe("matched");
      expect(await adapter.verify(plan)).toMatchObject({
        state: "verified_fixture",
        liveVerified: false,
      });
      expect(await adapter.reconcile(plan)).toMatchObject({
        state: "matched",
        providerInvoked: false,
        reapplied: false,
      });
    }
    expect(store.size()).toBe(WINNER_PROVIDER_ADAPTER_IDS.length);
  });

  it("keeps dry runs and non-fixture execution side-effect free", async () => {
    const store = createMemoryWinnerProviderFixtureStore();
    const adapter = createWinnerProviderFixtureAdapters({ store }).fixture_local_renderer;
    const context = readyContext("fixture_local_renderer");
    const plan = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "render_no_effect",
        idempotencyKey: "render_no_effect",
        payload: payloadFor("fixture_local_renderer"),
      },
      context,
    );
    expect((await adapter.dryRun(plan)).providerInvoked).toBe(false);
    expect(store.size()).toBe(0);
    const denied = await adapter.apply(plan, { ...context, fixtureExecution: false });
    expect(denied).toMatchObject({ state: "failed", externalEffectOccurred: false });
    expect(store.size()).toBe(0);
  });

  it("detects organic draft/direct availability and defaults to review-before-publish", async () => {
    const adapter = createWinnerProviderFixtureAdapters().fixture_organic_content;
    const missing = await adapter.doctor({ fixtureExecution: true, now });
    expect(missing.status).toBe("auth_required");
    expect(missing.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["auth_missing", "review_required"]),
    );

    const authenticated: WinnerProviderFixtureContext = {
      fixtureExecution: true,
      credentialRefs: { fixture_organic_content: "cred://winner-loop/organic" },
      now,
    };
    const availability = adapter.featureAvailability(authenticated);
    expect(availability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "organic_create_draft", state: "available" }),
        expect.objectContaining({ feature: "organic_publish_direct", state: "review_required" }),
      ]),
    );
    const defaultPlan = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "organic_default",
        idempotencyKey: "organic_default",
        payload: payloadFor("fixture_organic_content"),
      },
      authenticated,
    );
    expect(defaultPlan).toMatchObject({
      feature: "organic_create_draft",
      state: "ready",
      publicationPolicy: "review_before_publish",
      publicationAllowed: false,
    });

    const blockedDirect = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "organic_direct_blocked",
        idempotencyKey: "organic_direct_blocked",
        feature: "organic_publish_direct",
        payload: payloadFor("fixture_organic_content"),
      },
      authenticated,
    );
    expect(blockedDirect.state).toBe("blocked");
    expect((await adapter.dryRun(blockedDirect)).state).toBe("blocked");
    expect(
      await adapter.apply(blockedDirect, readyContext("fixture_organic_content")),
    ).toMatchObject({ state: "blocked", providerInvoked: false });
  });

  it("fails closed when account feature availability is unknown", async () => {
    const adapter = createWinnerProviderFixtureAdapters().fixture_organic_content;
    const context: WinnerProviderFixtureContext = {
      ...readyContext("fixture_organic_content"),
      featureOverrides: { organic_publish_direct: "unknown" },
    };
    const plan = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "organic_unknown",
        idempotencyKey: "organic_unknown",
        feature: "organic_publish_direct",
        payload: payloadFor("fixture_organic_content"),
      },
      context,
    );
    expect(plan).toMatchObject({ state: "blocked", publicationAllowed: false });
    expect((await adapter.doctor(context)).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "feature_unknown" })]),
    );
  });

  it("models a reviewed Spark authorization contract while forbidding campaigns and spend", async () => {
    const adapter = createWinnerProviderFixtureAdapters().fixture_tiktok_spark;
    const missing = await adapter.doctor({ fixtureExecution: true, now });
    expect(missing.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["auth_missing", "review_required"]),
    );
    const context = readyContext("fixture_tiktok_spark");
    const plan = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "spark_contract_fixture",
        idempotencyKey: "spark_contract_fixture",
        payload: payloadFor("fixture_tiktok_spark"),
      },
      context,
    );
    expect(plan).toMatchObject({
      potentialExternalEffect: "financial",
      effectClass: "local_fixture_write",
      spendAllowed: false,
      maxSpendMinor: 0,
      publicationAllowed: false,
    });
    const applied = await adapter.apply(plan, context);
    expect(applied.output).toMatchObject({
      fixture_only: true,
      spend_allowed: false,
      external_spend_minor: 0,
      campaign_created: false,
    });
    expect(applied.externalEffectOccurred).toBe(false);
  });

  it("keeps attribution aggregate-only and RevenueCat separate from attribution", async () => {
    const adapters = createWinnerProviderFixtureAdapters();
    const attributionContext = readyContext("fixture_aggregated_attribution");
    const attributionPlan = adapters.fixture_aggregated_attribution.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "attribution_fixture",
        idempotencyKey: "attribution_fixture",
        payload: payloadFor("fixture_aggregated_attribution"),
      },
      attributionContext,
    );
    expect(
      (await adapters.fixture_aggregated_attribution.apply(attributionPlan, attributionContext))
        .output,
    ).toMatchObject({
      attribution_class: "PRIVACY_AGGREGATED",
      person_level_rows: 0,
      deterministic_claim_allowed: false,
    });

    const subscriptionContext = readyContext("fixture_revenuecat");
    const subscriptionPlan = adapters.fixture_revenuecat.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "subscription_fixture",
        idempotencyKey: "subscription_fixture",
        payload: payloadFor("fixture_revenuecat"),
      },
      subscriptionContext,
    );
    expect(
      (await adapters.fixture_revenuecat.apply(subscriptionPlan, subscriptionContext)).output,
    ).toMatchObject({
      environment: "sandbox",
      attribution_engine: false,
      subscriber_payload_persisted: false,
    });
  });

  it("binds idempotency keys to request content and reconciles without replay", async () => {
    const adapter = createWinnerProviderFixtureAdapters().fixture_local_renderer;
    const context = readyContext("fixture_local_renderer");
    const first = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "render_first",
        idempotencyKey: "render_shared_key",
        payload: { creative_id: "creative_fixture_1" },
      },
      context,
    );
    const second = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "render_second",
        idempotencyKey: "render_shared_key",
        payload: { creative_id: "creative_fixture_2" },
      },
      context,
    );
    expect((await adapter.apply(first, context)).reused).toBe(false);
    expect(await adapter.apply(first, context)).toMatchObject({ state: "succeeded", reused: true });
    expect(await adapter.apply(second, context)).toMatchObject({
      state: "conflict",
      externalEffectOccurred: false,
    });
    await expect(
      adapter.apply({ ...first, requestHash: "0".repeat(64) } as WinnerProviderPlan, context),
    ).rejects.toMatchObject({ code: "plan_adapter_mismatch" });
    await expect(
      adapter.apply(
        {
          ...first,
          tenant: { organizationId: "organization_fixture_2", ventureId: first.tenant.ventureId },
        } as WinnerProviderPlan,
        context,
      ),
    ).rejects.toMatchObject({ code: "plan_adapter_mismatch" });
    expect(await adapter.reconcile(first)).toMatchObject({
      state: "matched",
      reapplied: false,
      providerInvoked: false,
    });
  });

  it("isolates the same venture, adapter, and idempotency key across organizations in memory", async () => {
    const store = createMemoryWinnerProviderFixtureStore();
    const adapter = createWinnerProviderFixtureAdapters({ store }).fixture_local_renderer;
    const context = readyContext("fixture_local_renderer");
    const request = {
      ventureId: "shared-venture",
      operationId: "shared-operation",
      idempotencyKey: "shared-key",
      payload: { creative_id: "shared-creative" },
    } as const;
    const alpha = adapter.plan(
      { ...request, tenant: { organizationId: "org-alpha", ventureId: request.ventureId } },
      context,
    );
    const bravo = adapter.plan(
      { ...request, tenant: { organizationId: "org-bravo", ventureId: request.ventureId } },
      context,
    );

    expect(alpha.requestHash).not.toBe(bravo.requestHash);
    expect(await adapter.apply(alpha, context)).toMatchObject({ reused: false });
    expect(await adapter.apply(bravo, context)).toMatchObject({ reused: false });
    expect((await adapter.readBack(alpha)).evidence).not.toEqual(
      (await adapter.readBack(bravo)).evidence,
    );
    expect(await adapter.apply(alpha, context)).toMatchObject({ reused: true });
    expect(await adapter.apply(bravo, context)).toMatchObject({ reused: true });
    expect(store.size()).toBe(2);
  });

  it("rejects sentinel and non-canonical fixture provider tenants", () => {
    const store = createMemoryWinnerProviderFixtureStore();
    const adapter = createWinnerProviderFixtureAdapters({ store }).fixture_local_renderer;
    const context = readyContext("fixture_local_renderer");
    const request = {
      operationId: "scoped-operation",
      idempotencyKey: "scoped-key",
      payload: { creative_id: "scoped-creative" },
    } as const;
    for (const tenant of [
      { organizationId: "__legacy_unscoped__", ventureId: "fixture-venture" },
      { organizationId: "org/alias", ventureId: "fixture-venture" },
      { organizationId: "fixture-org", ventureId: " fixture-venture" },
    ]) {
      expect(() => adapter.plan({ ...request, tenant }, context)).toThrowError(
        expect.objectContaining({ code: "invalid_request" }) as never,
      );
      expect(() =>
        store.get(tenant, "fixture_local_renderer", request.idempotencyKey),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }) as never);
    }
  });

  it("redacts secret values and refuses them in durable fixture payloads", () => {
    const adapter = createWinnerProviderFixtureAdapters().fixture_revenuecat;
    expect(
      adapter.redact({
        credentialRef: "cred://winner-loop/revenuecat",
        apiKey: "do-not-log",
        nested: { authorization: "Bearer abc.def.ghi" },
      }),
    ).toEqual({
      credentialRef: "cred://winner-loop/revenuecat",
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]" },
    });
    expect(() =>
      adapter.plan(
        {
          tenant: PROVIDER_TENANT,
          operationId: "unsafe",
          idempotencyKey: "unsafe",
          payload: { credential_ref: "cred://winner-loop/revenuecat" },
        },
        readyContext("fixture_revenuecat"),
      ),
    ).toThrowError(expect.objectContaining({ code: "unsafe_fixture_payload" }) as never);
  });

  it("uses the shared classifier for nested aliases and common secondary credential formats", () => {
    const adapter = createWinnerProviderFixtureAdapters().fixture_local_renderer;
    const context = readyContext("fixture_local_renderer");
    const credentialShapes = [
      "whsec_secondary_fixture_8Hk2Lm9Q",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abcdefghijkl",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature_fixture",
    ];
    for (const [index, credential] of credentialShapes.entries()) {
      expect(() =>
        adapter.plan(
          {
            tenant: PROVIDER_TENANT,
            operationId: `unsafe-shape-${index}`,
            idempotencyKey: `unsafe-shape-${index}`,
            payload: { creative_id: credential },
          },
          context,
        ),
      ).toThrowError(expect.objectContaining({ code: "unsafe_fixture_payload" }) as never);
    }
    expect(() =>
      adapter.plan(
        {
          tenant: PROVIDER_TENANT,
          operationId: "unsafe-nested-alias",
          idempotencyKey: "unsafe-nested-alias",
          payload: {
            creative_id: "safe-creative",
            metadata: { secondaryProviderSecret: "innocuous-looking-value" },
          } as FixtureJsonObject,
        },
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "unsafe_fixture_payload" }) as never);

    const spark = createWinnerProviderFixtureAdapters().fixture_tiktok_spark;
    expect(() =>
      spark.plan(
        {
          tenant: PROVIDER_TENANT,
          operationId: "unsafe-source-post",
          idempotencyKey: "unsafe-source-post",
          payload: { source_post_ref: "https://example.test/post/fixture" },
        },
        readyContext("fixture_tiktok_spark"),
      ),
    ).toThrowError(expect.objectContaining({ code: "unsafe_fixture_payload" }) as never);
  });

  it("rejects an unsafe custom-store replay before returning provider output or read-back", async () => {
    const holder: { record: WinnerProviderFixtureRecord | undefined } = { record: undefined };
    const store: WinnerProviderFixtureStore = {
      get: () => holder.record,
      put: vi.fn(),
      size: () => (holder.record ? 1 : 0),
    };
    const adapter = createWinnerProviderFixtureAdapters({ store }).fixture_local_renderer;
    const context = readyContext("fixture_local_renderer");
    const plan = adapter.plan(
      {
        tenant: PROVIDER_TENANT,
        operationId: "unsafe-store-replay",
        idempotencyKey: "unsafe-store-replay",
        payload: { creative_id: "safe-creative" },
      },
      context,
    );
    holder.record = {
      adapterId: "fixture_local_renderer",
      tenant: PROVIDER_TENANT,
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      requestHash: plan.requestHash,
      feature: plan.feature,
      output: {
        fixture_only: true,
        creative_id: "safe-creative",
        render_job_id: "fixture-render-safe",
        renderer_kind: "local_fixture",
        asset_ref: "fixture://creative/safe",
        content_hash: plan.requestHash,
        provider_metadata: { secondaryProviderSecret: "whsec_secondary_fixture_8Hk2Lm9Q" },
      },
      appliedAt: NOW,
      fixtureLabel: "SYNTHETIC_FIXTURE — no provider was contacted",
    };
    for (const operation of [adapter.apply(plan, context), adapter.readBack(plan)]) {
      await expect(operation).rejects.toMatchObject({ code: "unsafe_fixture_payload" });
      await operation.catch((error: unknown) => {
        expect(String(error)).not.toContain("whsec_secondary_fixture_8Hk2Lm9Q");
      });
    }
    expect(store.put).not.toHaveBeenCalled();
  });
});

const COHORT: CohortSnapshot = {
  organizationId: "organization_fixture_1",
  ventureId: "venture_fixture_1",
  creativeId: "creative_fixture_1",
  creativeFamilyId: "family_fixture_1",
  window: { label: "D7", days: 7 },
  metrics: {
    spendMinor: 5_000,
    impressions: 20_000,
    clicks: 500,
    installs: 80,
    onboardingCompletions: 120,
    paywallViews: 40,
    trials: 20,
    initialSubscribers: 6,
    delayedConversions: 4,
    renewals: 2,
    cancellations: 1,
    refunds: 0,
    grossRevenueMinor: 9_000,
    netRevenueMinor: 9_000,
    activeSubscribers: 5,
    cacMinor: 833,
    trialToPaid: 0.3,
    installToTrial: 0.25,
    onboardingToTrial: 1 / 6,
    paywallViewToPaid: 0.15,
    delayedConversionRate: 0.2,
    retentionRate: 5 / 6,
    refundImpactMinor: 0,
    refundRate: 0,
    roas: 1.8,
    paybackRatio: 1.8,
    paybackAchieved: true,
    paybackDays: 6,
  },
  attributionClass: "PRIVACY_AGGREGATED",
  attributionProvider: "aggregate_fixture",
  attributionConfidence: "medium",
  attributionGranularity: "campaign",
  attributionFreshness: "fresh",
  attributionReportingStatus: "coarse",
  creativeLevelCertainty: false,
  reportingWindowStart: "2026-08-01T00:00:00.000Z",
  reportingWindowEnd: "2026-08-09T00:00:00.000Z",
  windowMature: true,
  revenueCatProject: "fixture_project",
  currency: "EUR",
  revenueDefinition: "net_of_refunds_gross_of_store_fees",
  missingData: [],
  freshnessSeconds: 3_600,
  limitations: ["Privacy-aggregated evidence is not person-level attribution."],
};

const LEARNING: WinnerLoopLearning = {
  learningId: "learning_fixture_1",
  organizationId: "organization_fixture_1",
  ventureId: "venture_fixture_1",
  creativeIds: ["creative_fixture_1"],
  creativeFamilyId: "family_fixture_1",
  hypothesis: "Test whether a promise-matched campaign page improves qualified intent",
  providerContext: {
    provider: "aggregate_fixture",
    externalAccountId: "private-account-id-must-not-propagate",
  },
  organicWindow: {
    start: "2026-07-25T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
  },
  paidWindow: {
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-08-09T00:00:00.000Z",
  },
  attributionClass: "PRIVACY_AGGREGATED",
  creativeLevelCertainty: false,
  acquisitionEconomics: {
    spendMinor: 5_000,
    cacMinor: 833,
    roas: 1.8,
    currency: "EUR",
  },
  cohorts: [COHORT],
  observation:
    "The aggregate fixture shows attention and later subscription activity in the same window.",
  recommendedSurface: "campaign_page",
  proposedChange: "Prepare a message-matched fixture campaign page variant.",
  measurementPlan:
    "Compare the same declared intent and D7 cohort metrics after a reviewed release.",
  rollback: "Revert the fixture change and restore the prior campaign page content.",
  confidence: "suggestive",
  limitations: ["Attribution is aggregated and does not establish creative-level causality."],
  createdAt: NOW,
};

describe("fixture-only DistributionPR bridge", () => {
  it("turns WinnerLoopLearning into a complete evidence-linked proposal without mutating anything", () => {
    const proposal = createFixtureDistributionPrProposal(
      {
        organizationId: LEARNING.organizationId,
        ventureId: LEARNING.ventureId,
      },
      {
        proposalId: "distribution_pr_fixture_1",
        learning: LEARNING,
        implementation: "Prepare a reviewed fixture variant of the campaign-page headline and CTA.",
        diffSummary: "Fixture proposal changes the campaign-page message and CTA treatment.",
        files: [
          {
            path: "fixtures/distribution-pr/campaign-page.json",
            operation: "modify",
            before: "Generic fixture campaign promise",
            after: "Promise-matched fixture campaign message",
          },
        ],
        previewDescription: "Static fixture description of the proposed campaign-page treatment.",
        createdAt: NOW,
      },
    );

    expect(proposal).toMatchObject({
      source: "winner_loop",
      state: "fixture_proposal_only",
      fixtureOnly: true,
      repositoryMutated: false,
      pullRequestOpened: false,
      publicationAllowed: false,
      organizationId: "organization_fixture_1",
      ventureId: "venture_fixture_1",
      targetSurface: "campaign_page",
      hypothesis: {
        confidence: "suggestive",
        causalStatus: "not_established",
      },
      preview: { kind: "fixture_description", url: null },
      measurement: { causalInterpretationAllowed: false },
    });
    expect(proposal.evidence).toMatchObject({
      learningId: "learning_fixture_1",
      creativeIds: ["creative_fixture_1"],
      attributionClass: "PRIVACY_AGGREGATED",
      creativeLevelCertainty: false,
      cohortWindows: [expect.objectContaining({ label: "D7" })],
    });
    expect(proposal.limitations.join(" ")).toMatch(/do not establish.*caused/i);
    expect(proposal.limitations.join(" ")).toMatch(/no repository was changed/i);
    expect(JSON.stringify(proposal)).not.toContain("private-account-id-must-not-propagate");
  });

  it("rejects causal overclaims, unsafe paths, personal values, and credentials", () => {
    const base = {
      proposalId: "distribution_pr_fixture_2",
      learning: LEARNING,
      implementation: "Prepare a fixture-only landing-page variant.",
      diffSummary: "Fixture-only summary.",
      files: [
        {
          path: "fixtures/distribution-pr/landing.json",
          operation: "modify" as const,
          before: "Fixture before",
          after: "Fixture after",
        },
      ],
      previewDescription: "Fixture preview description.",
      createdAt: NOW,
    };
    const scope = {
      organizationId: LEARNING.organizationId,
      ventureId: LEARNING.ventureId,
    };
    expect(() =>
      createFixtureDistributionPrProposal(scope, {
        ...base,
        hypothesis: "This creative caused the subscription increase",
      }),
    ).toThrowError(expect.objectContaining({ code: "causal_overclaim" }) as never);
    expect(() =>
      createFixtureDistributionPrProposal(scope, {
        ...base,
        files: [{ ...base.files[0], path: "../.env.production" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_path" }) as never);
    expect(() =>
      createFixtureDistributionPrProposal(scope, {
        ...base,
        previewDescription: "Send the preview to person@example.test",
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_content" }) as never);
    expect(() =>
      createFixtureDistributionPrProposal(scope, {
        ...base,
        implementation: "Use cred://provider/private while preparing this fixture",
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe_content" }) as never);
  });

  it("refuses a same-venture caller from a different organization", () => {
    expect(() =>
      createFixtureDistributionPrProposal(
        { organizationId: "organization_fixture_2", ventureId: LEARNING.ventureId },
        {
          proposalId: "distribution_pr_cross_org",
          learning: LEARNING,
          implementation: "Prepare a fixture-only campaign-page variant.",
          diffSummary: "Fixture-only campaign-page summary.",
          files: [
            {
              path: "fixtures/distribution-pr/campaign-page.json",
              operation: "modify",
              before: "Fixture before",
              after: "Fixture after",
            },
          ],
          previewDescription: "Fixture preview description.",
          createdAt: NOW,
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "tenant_scope_mismatch",
        message: "caller scope does not own this Winner Loop learning",
      }) as never,
    );
  });

  it("rejects a forged learning scope before producing a proposal", () => {
    const forgedLearning = {
      ...LEARNING,
      organizationId: "organization_fixture_2",
    } satisfies WinnerLoopLearning;
    expect(() =>
      createFixtureDistributionPrProposal(
        { organizationId: LEARNING.organizationId, ventureId: LEARNING.ventureId },
        {
          proposalId: "distribution_pr_forged_scope",
          learning: forgedLearning,
          implementation: "Prepare a fixture-only campaign-page variant.",
          diffSummary: "Fixture-only campaign-page summary.",
          files: [
            {
              path: "fixtures/distribution-pr/campaign-page.json",
              operation: "modify",
              before: "Fixture before",
              after: "Fixture after",
            },
          ],
          previewDescription: "Fixture preview description.",
          createdAt: NOW,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "tenant_scope_mismatch" }) as never);
  });

  it("rejects a foreign nested cohort even when the learning scope matches", () => {
    const forgedLearning = {
      ...LEARNING,
      cohorts: [{ ...LEARNING.cohorts[0]!, organizationId: "organization_fixture_2" }],
    } satisfies WinnerLoopLearning;
    expect(() =>
      createFixtureDistributionPrProposal(
        { organizationId: LEARNING.organizationId, ventureId: LEARNING.ventureId },
        {
          proposalId: "distribution_pr_foreign_cohort",
          learning: forgedLearning,
          implementation: "Prepare a fixture-only campaign-page variant.",
          diffSummary: "Fixture-only campaign-page summary.",
          files: [
            {
              path: "fixtures/distribution-pr/campaign-page.json",
              operation: "modify",
              before: "Fixture before",
              after: "Fixture after",
            },
          ],
          previewDescription: "Fixture preview description.",
          createdAt: NOW,
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "tenant_scope_mismatch",
        message: expect.stringMatching(/cohort.*does not belong/i),
      }) as never,
    );
  });
});
