import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { growthContractSchema } from "@/lib/config/growth-contract-schema";
import {
  SqliteWinnerLiveProviderOperationStore,
  WINNER_LIVE_PROVIDER_DESCRIPTORS,
  createWinnerLiveProviderAdapters,
  type WinnerLiveJsonObject,
  type WinnerLiveProviderAuthorization,
  type WinnerLiveProviderContext,
  type WinnerLiveProviderOperationStore,
  type WinnerLiveProviderPlan,
  type WinnerLiveProviderTransport,
} from "@/lib/winner-integrations";
import {
  createOrganicPolicyService,
  createSqliteCreativeLedgerStore,
  createSqliteCreativeManifestStore,
  createSqliteOrganicPolicyStore,
  type CreativeLedgerStore,
  type CreativeManifestInput,
  type CreativeManifestStore,
  type OrganicDuplicatePolicy,
  type OrganicPolicyExecutionAuthority,
  type OrganicPolicyOperation,
  type OrganicPolicyService,
  type OrganicPolicyStore,
  type OrganicReviewMode,
} from "@/lib/winner-loop";

const NOW = "2026-08-09T12:00:00.000Z";
const ORGANIZATION_ID = "org-acme";
const now = () => new Date(NOW);
const tempRoots: string[] = [];
const closeables: Array<{ close(): void }> = [];

afterEach(() => {
  for (const closeable of closeables.splice(0)) {
    try {
      closeable.close();
    } catch {
      // A restart test may already have closed the first connection set.
    }
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "vh-organic-policy-"));
  tempRoots.push(value);
  return value;
}

function contract(
  options: {
    ventureId?: string;
    mode?: OrganicReviewMode;
    omitMode?: boolean;
    allowedProviders?: readonly string[];
    allowedAccounts?: readonly string[];
    maxAccounts?: number;
    maxPosts?: number;
    duplicatePolicy?: OrganicDuplicatePolicy;
    providerPolicyState?: "unknown" | "clear" | "warned" | "restricted";
  } = {},
) {
  const source = parse(readFileSync("config/growth.yaml", "utf8")) as Record<string, unknown>;
  const organic = { ...(source.organic as Record<string, unknown>) };
  organic.allowed_providers = [...(options.allowedProviders ?? ["tiktok_content"])];
  organic.allowed_accounts = [...(options.allowedAccounts ?? ["tiktok-user-1"])];
  organic.max_accounts = options.maxAccounts ?? 1;
  organic.max_posts_per_account_per_day = options.maxPosts ?? 3;
  organic.duplicate_content_policy = options.duplicatePolicy ?? "forbid";
  if (options.omitMode) delete organic.default_review_mode;
  else organic.default_review_mode = options.mode ?? "REVIEW_BEFORE_PUBLISH";
  const compliance = {
    ...(source.compliance as Record<string, unknown>),
    provider_policy_state: options.providerPolicyState ?? "clear",
    allowed_geographies: ["NL", "BE"],
  };
  return growthContractSchema.parse({
    ...source,
    venture_id: options.ventureId ?? "venture-1",
    organic,
    compliance,
  });
}

const PLATFORM_SETTINGS = Object.freeze({
  disable_duet: false,
  disable_stitch: false,
  disable_comment: false,
  brand_content_toggle: false,
  brand_organic_toggle: true,
  is_aigc: true,
});

function manifestInput(
  organizationId: string,
  ventureId: string,
  creativeId: string,
  overrides: Partial<CreativeManifestInput> = {},
): CreativeManifestInput {
  return {
    organizationId,
    ventureId,
    creativeId,
    creativeFamilyId: "family-1",
    hypothesis: "A truthful product walkthrough earns qualified interest",
    scriptVersion: "script-v1",
    promptVersion: "prompt-v1",
    storyboardRef: "artifact://winner/storyboards/creative-1",
    sourceAssetIds: [],
    recordingRefs: [],
    avatarSource: null,
    voiceSource: null,
    mediaLicenses: [],
    testimonialSubjectIds: [],
    testimonialConsents: [],
    creatorIds: [],
    creatorAuthorizations: [],
    aiGenerated: true,
    disclosure: {
      required: true,
      present: true,
      text: "AI-assisted production",
      evidenceRef: "artifact://winner/disclosures/creative-1",
    },
    permittedRegions: ["NL", "BE"],
    permittedChannels: ["tiktok_organic"],
    organicApproved: true,
    paidApproved: false,
    expiresAt: "2026-08-10T12:00:00.000Z",
    claims: [],
    prohibitedClaims: [],
    truthReferences: ["docs/product/PRODUCT_TRUTH.md#fixture"],
    reviewedBy: "reviewer-1",
    reviewEventId: "review-event-1",
    reviewedAt: "2026-08-09T11:30:00.000Z",
    ...overrides,
  };
}

function seedCreative(
  creativeStore: CreativeLedgerStore,
  manifestStore: CreativeManifestStore,
  options: {
    organizationId: string;
    ventureId: string;
    creativeId: string;
    contentFingerprint: string;
    title: string;
    deliveryVariantId: string;
    deliveryFingerprint: string;
  },
): void {
  const scope = { organizationId: options.organizationId, ventureId: options.ventureId };
  if (!creativeStore.getVariant(scope, options.creativeId)) {
    const variant = creativeStore.putVariant({
      organizationId: options.organizationId,
      ventureId: options.ventureId,
      registrationKey: `registration:${options.creativeId}`,
      registrationBinding: `binding:${options.contentFingerprint}`,
      variant: {
        creativeId: options.creativeId,
        hypothesisId: "hypothesis-1",
        creativeFamilyId: "family-1",
        derivedFromCreativeId: null,
        platformVariantOfCreativeId: null,
        contentFingerprint: options.contentFingerprint,
        contentFingerprintVersion: "v1",
        media: {
          hook: "See the ranking",
          openingFrame: "Dashboard",
          format: "walkthrough",
          speaker: "synthetic narrator",
          visualSequence: "rank then detail",
          audioTrack: "narration",
          onScreenProof: "fixture label",
          embeddedCta: "Try the fixture",
          durationSeconds: 18,
          aspectRatio: "9:16",
        },
        assetContentHash: "f".repeat(64),
        destinationIsTestedHypothesis: false,
        createdAt: "2026-08-09T11:00:00.000Z",
      },
    });
    expect(variant.kind).toBe("created");
  }
  if (!creativeStore.getDeliveryVariant(scope, options.deliveryVariantId)) {
    const delivery = creativeStore.putDeliveryVariant(
      scope,
      `delivery-binding:${options.deliveryFingerprint}`,
      {
        deliveryVariantId: options.deliveryVariantId,
        creativeId: options.creativeId,
        deliveryFingerprint: options.deliveryFingerprint,
        delivery: {
          caption: options.title,
          adCopy: "",
          destinationUrl: "https://fixture.example/walkthrough",
          privacy: "PUBLIC_TO_EVERYONE",
          platformSettings: { ...PLATFORM_SETTINGS },
        },
        createdAt: "2026-08-09T11:10:00.000Z",
      },
    );
    expect(delivery.kind).toBe("created");
  }
  if (!manifestStore.getCurrent(scope, options.creativeId)) {
    manifestStore.put(manifestInput(options.organizationId, options.ventureId, options.creativeId));
  }
}

function durableOperationStore(): WinnerLiveProviderOperationStore {
  const store = new SqliteWinnerLiveProviderOperationStore(
    join(root(), "provider-operations.sqlite"),
  );
  closeables.push(store);
  return store;
}

function fixtureTransport(
  options: {
    applyState?: "accepted" | "rejected" | "unknown";
    readBackState?: "matched" | "missing" | "conflict" | "unknown";
    mismatchedEvidence?: boolean;
  } = {},
): WinnerLiveProviderTransport & {
  apply: ReturnType<typeof vi.fn>;
  readBack: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
} {
  return {
    adapterId: "tiktok_content_posting",
    kind: "contract_fixture",
    doctor: vi.fn(async (request) => ({
      state: "ready" as const,
      observedAccountId: request.providerAccountId,
      availableFeatures: request.requestedFeatures,
      grantedScopes: request.requiredScopes,
      providerInvoked: false,
      liveVerified: false,
    })),
    apply: vi.fn(async ({ plan }) => ({
      state: options.applyState ?? ("accepted" as const),
      providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: false,
      externalEffectOccurred: options.applyState === "unknown" ? ("unknown" as const) : false,
      output: { fixture_only: true, external_effect: false },
    })),
    readBack: vi.fn(async ({ plan }) => ({
      state: options.readBackState ?? ("matched" as const),
      providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: false,
      liveVerified: false,
      evidence: options.mismatchedEvidence
        ? { creative_id: "another-creative", status: "PUBLISH_COMPLETE" }
        : evidence(plan),
    })),
    reconcile: vi.fn(async ({ plan }) => ({
      state: options.readBackState ?? ("matched" as const),
      providerOperationId: `fixture-${plan.requestHash.slice(0, 12)}`,
      providerInvoked: false,
      liveVerified: false,
      evidence: evidence(plan),
    })),
  };
}

function evidence(plan: WinnerLiveProviderPlan): WinnerLiveJsonObject {
  return plan.feature === "distribution.content.publish"
    ? {
        creative_id: plan.payload.creative_id,
        publish_id: `publish-${plan.requestHash.slice(0, 8)}`,
        post_id: `post-${plan.requestHash.slice(0, 8)}`,
        status: "PUBLISH_COMPLETE",
      }
    : {
        creative_id: plan.payload.creative_id,
        publish_id: `publish-${plan.requestHash.slice(0, 8)}`,
        status: "SEND_TO_USER_INBOX",
      };
}

function authorization(plan: WinnerLiveProviderPlan): WinnerLiveProviderAuthorization {
  return {
    sourceGrantKind: "customer_service_grant",
    sourceGrantId: "organic-service-grant-1",
    organizationId: plan.organizationId,
    ventureId: plan.ventureId,
    providerId: "tiktok_content_posting",
    externalAccountIds: [plan.providerAccountId],
    allowedFeatures: [plan.feature],
    allowedEffects: [plan.effect],
    maxExternalCostMinor: 0,
    currency: "EUR",
    approvedBy: "founder-1",
    approvalRef: "artifact://approvals/organic-service-1",
    issuedAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-09T13:00:00.000Z",
  };
}

function payload(
  feature: "distribution.content.draft" | "distribution.content.publish",
  title: string,
): WinnerLiveJsonObject {
  const common = {
    creative_id: "creative-1",
    creator_info_ref: "artifact://tiktok/creator-info-current",
    user_consent_ref: "artifact://tiktok/consent-current",
    policy_snapshot_ref: "artifact://tiktok/policy-current",
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
        title,
        privacy_level: "PUBLIC_TO_EVERYONE",
        ...PLATFORM_SETTINGS,
      }
    : { operation: "upload_draft", ...common };
}

function organicOperation(plan: WinnerLiveProviderPlan): OrganicPolicyOperation {
  return {
    adapterId: "tiktok_content_posting",
    organizationId: plan.organizationId,
    ventureId: plan.ventureId,
    providerAccountId: plan.providerAccountId,
    operationId: plan.operationId,
    idempotencyKey: plan.idempotencyKey,
    requestHash: plan.requestHash,
    feature: plan.feature as "distribution.content.draft" | "distribution.content.publish",
    payload: plan.payload,
  };
}

interface Runtime {
  readonly root: string;
  readonly policyStore: OrganicPolicyStore;
  readonly creativeStore: CreativeLedgerStore;
  readonly manifestStore: CreativeManifestStore;
  readonly service: OrganicPolicyService;
  readonly adapter: ReturnType<typeof createWinnerLiveProviderAdapters>["tiktok_content_posting"];
  readonly plan: WinnerLiveProviderPlan;
  readonly intent: ReturnType<OrganicPolicyService["createIntent"]>;
  readonly authority: OrganicPolicyExecutionAuthority;
  readonly transport: ReturnType<typeof fixtureTransport>;
  readonly operationStore: WinnerLiveProviderOperationStore;
  readonly context: WinnerLiveProviderContext;
}

function runtime(
  options: {
    root?: string;
    organizationId?: string;
    ventureId?: string;
    account?: string;
    allowedProviders?: readonly string[];
    allowedAccounts?: readonly string[];
    mode?: OrganicReviewMode;
    maxAccounts?: number;
    maxPosts?: number;
    duplicatePolicy?: OrganicDuplicatePolicy;
    providerPolicyState?: "unknown" | "clear" | "warned" | "restricted";
    health?: "healthy" | "degraded" | "blocked" | "revoked";
    capabilities?: readonly ("distribution.content.draft" | "distribution.content.publish")[];
    feature?: "distribution.content.draft" | "distribution.content.publish";
    title?: string;
    deliveryVariantId?: string;
    deliveryFingerprint?: string;
    operationId?: string;
    idempotencyKey?: string;
    contentFingerprint?: string;
    transport?: ReturnType<typeof fixtureTransport>;
    operationStore?: WinnerLiveProviderOperationStore;
    approve?: boolean;
    contextNow?: () => Date;
  } = {},
): Runtime {
  const directory = options.root ?? root();
  const organizationId = options.organizationId ?? ORGANIZATION_ID;
  const ventureId = options.ventureId ?? "venture-1";
  const account = options.account ?? "tiktok-user-1";
  const feature = options.feature ?? "distribution.content.publish";
  const title = options.title ?? "A truthful synthetic product walkthrough";
  const deliveryVariantId = options.deliveryVariantId ?? "delivery-1";
  const deliveryFingerprint = options.deliveryFingerprint ?? "b".repeat(64);
  const policyStore = createSqliteOrganicPolicyStore(join(directory, "organic.sqlite"));
  const creativeStore = createSqliteCreativeLedgerStore(join(directory, "creative.sqlite"));
  const manifestStore = createSqliteCreativeManifestStore(join(directory, "manifest.sqlite"));
  closeables.push(policyStore, creativeStore, manifestStore);
  seedCreative(creativeStore, manifestStore, {
    organizationId,
    ventureId,
    creativeId: "creative-1",
    contentFingerprint: options.contentFingerprint ?? "a".repeat(64),
    title,
    deliveryVariantId,
    deliveryFingerprint,
  });
  const service = createOrganicPolicyService({
    store: policyStore,
    creativeStore,
    manifestStore,
    timezone: "Europe/Amsterdam",
  });
  service.recordPolicySnapshot({
    organizationId,
    snapshotId: "policy-current",
    contract: contract({
      ventureId,
      mode: options.mode,
      allowedProviders: options.allowedProviders,
      allowedAccounts: options.allowedAccounts ?? [account],
      maxAccounts: options.maxAccounts ?? options.allowedAccounts?.length ?? 1,
      maxPosts: options.maxPosts,
      duplicatePolicy: options.duplicatePolicy,
      providerPolicyState: options.providerPolicyState,
    }),
    capturedAt: "2026-08-09T11:50:00.000Z",
    expiresAt: "2026-08-09T13:00:00.000Z",
  });
  service.recordProviderSnapshot({
    organizationId,
    snapshotId: `provider-current-${account}`,
    ventureId,
    providerId: "tiktok_content",
    providerAccountId: account,
    health: options.health ?? "healthy",
    providerPolicyState: options.providerPolicyState ?? "clear",
    availableFeatures: options.capabilities ?? [
      "distribution.content.draft",
      "distribution.content.publish",
    ],
    canPost: true,
    observedAt: "2026-08-09T11:58:00.000Z",
    expiresAt: "2026-08-09T12:12:00.000Z",
    evidenceRef: `artifact://tiktok/creator-info/${account}`,
  });
  const transport = options.transport ?? fixtureTransport();
  const operationStore = options.operationStore ?? durableOperationStore();
  const adapter = createWinnerLiveProviderAdapters({
    transports: { tiktok_content_posting: transport },
    store: operationStore,
    organicPolicyService: service,
  }).tiktok_content_posting;
  const plan = adapter.plan({
    organizationId,
    ventureId,
    providerAccountId: account,
    operationId: options.operationId ?? "organic-operation-1",
    idempotencyKey: options.idempotencyKey ?? "organic-idempotency-1",
    feature,
    payload: payload(feature, title),
  });
  const intent = service.createIntent(organicOperation(plan), {
    policySnapshotId: "policy-current",
    providerSnapshotId: `provider-current-${account}`,
    region: "NL",
    deliveryVariantId: feature === "distribution.content.publish" ? deliveryVariantId : null,
    now: now(),
  });
  let reviewApprovalId: string | null = null;
  if (
    (options.approve ?? true) &&
    (options.mode ?? "REVIEW_BEFORE_PUBLISH") === "REVIEW_BEFORE_PUBLISH" &&
    feature === "distribution.content.publish"
  ) {
    reviewApprovalId = service.approveIntent({
      operation: organicOperation(plan),
      intent,
      approvalId: `approval-${plan.operationId}`,
      approvedBy: "reviewer-1",
      approvalRef: `artifact://approvals/${plan.operationId}`,
      approvedAt: "2026-08-09T11:59:00.000Z",
      expiresAt: "2026-08-09T12:30:00.000Z",
    }).approvalId;
  }
  const authority = service.executionAuthority(intent, reviewApprovalId);
  const context: WinnerLiveProviderContext = {
    organizationId,
    credentialRef: "cred://winner-loop/tiktok-content",
    authorization: authorization(plan),
    organicAuthority: authority,
    executionMode: "authorized_transport",
    environment: "test",
    now: options.contextNow ?? now,
  };
  return {
    root: directory,
    policyStore,
    creativeStore,
    manifestStore,
    service,
    adapter,
    plan,
    intent,
    authority,
    transport,
    operationStore,
    context,
  };
}

describe("Winner Loop organic publication policy", () => {
  it("applies and rolls back the organic publication schema migration", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        prepare(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const database = new DatabaseSync(":memory:");
    database.exec(
      readFileSync("migrations/winner-loop/005_organic_publication_policy.up.sql", "utf8"),
    );
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'organic_%' ORDER BY name",
        )
        .all(),
    ).toHaveLength(4);
    for (const table of [
      "organic_policy_snapshots",
      "organic_provider_snapshots",
      "organic_review_approvals",
      "organic_publication_reservations",
    ]) {
      expect(
        database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => (column as { name: string }).name === "organization_id"),
      ).toBe(true);
    }
    database.exec(
      readFileSync("migrations/winner-loop/005_organic_publication_policy.down.sql", "utf8"),
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'organic_%'")
        .all(),
    ).toEqual([]);
    database.close();
  });

  it("fails closed when an existing organic ledger has no organization scope", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const directory = root();
    const filename = join(directory, "legacy-organic.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE organic_policy_snapshots (
        venture_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        PRIMARY KEY (venture_id, snapshot_id)
      )
    `);
    legacy.close();

    expect(() => createSqliteOrganicPolicyStore(filename)).toThrow(/explicit tenant mapping/i);
  });

  it("defaults to REVIEW_BEFORE_PUBLISH and hard-rejects more than three accounts", () => {
    const directory = root();
    const policyStore = createSqliteOrganicPolicyStore(join(directory, "policy.sqlite"));
    const creativeStore = createSqliteCreativeLedgerStore(join(directory, "creative.sqlite"));
    const manifestStore = createSqliteCreativeManifestStore(join(directory, "manifest.sqlite"));
    closeables.push(policyStore, creativeStore, manifestStore);
    const service = createOrganicPolicyService({
      store: policyStore,
      creativeStore,
      manifestStore,
    });
    const snapshot = service.recordPolicySnapshot({
      organizationId: ORGANIZATION_ID,
      snapshotId: "default-review",
      contract: contract({ omitMode: true }),
      capturedAt: "2026-08-09T11:50:00.000Z",
      expiresAt: "2026-08-09T13:00:00.000Z",
    });
    expect(snapshot.terms.defaultReviewMode).toBe("REVIEW_BEFORE_PUBLISH");
    expect(() =>
      service.recordPolicySnapshot({
        organizationId: ORGANIZATION_ID,
        snapshotId: "too-many",
        contract: contract({
          allowedAccounts: ["a", "b", "c", "d"],
          maxAccounts: 4,
        }),
        capturedAt: "2026-08-09T11:51:00.000Z",
        expiresAt: "2026-08-09T13:00:00.000Z",
      }),
    ).toThrow(/hard maximum of three/i);
  });

  it("enforces all three review modes at the adapter apply boundary", async () => {
    const automatic = runtime({ mode: "AUTOMATIC_WITHIN_POLICY", approve: false });
    expect(await automatic.adapter.apply(automatic.plan, automatic.context)).toMatchObject({
      state: "accepted_unverified",
      providerInvoked: false,
      liveVerified: false,
    });
    expect(automatic.transport.apply).toHaveBeenCalledOnce();

    const review = runtime({ mode: "REVIEW_BEFORE_PUBLISH", approve: false });
    const selfAuthoredReview = await review.adapter.apply(review.plan, {
      ...review.context,
      reviewApproval: {
        kind: "organic.direct_publish",
        requestHash: review.plan.requestHash,
        operationId: review.plan.operationId,
        approvedBy: "caller",
        approvalRef: "artifact://caller/self-authored",
        approvedAt: "2026-08-09T11:59:00.000Z",
        expiresAt: "2026-08-09T12:30:00.000Z",
      },
    });
    expect(selfAuthoredReview).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(selfAuthoredReview.diagnostic?.code).toBe("organic_policy_review_invalid");
    expect(review.transport.apply).not.toHaveBeenCalled();

    const approval = review.service.approveIntent({
      operation: organicOperation(review.plan),
      intent: review.intent,
      approvalId: "durable-review",
      approvedBy: "reviewer-1",
      approvalRef: "artifact://approvals/durable-review",
      approvedAt: "2026-08-09T11:59:00.000Z",
      expiresAt: "2026-08-09T12:30:00.000Z",
    });
    const reviewedContext = {
      ...review.context,
      organicAuthority: review.service.executionAuthority(review.intent, approval.approvalId),
    };
    expect(await review.adapter.apply(review.plan, reviewedContext)).toMatchObject({
      state: "accepted_unverified",
    });
    expect(review.transport.apply).toHaveBeenCalledOnce();

    const platformOnly = runtime({ mode: "PLATFORM_DRAFT", approve: false });
    const direct = await platformOnly.adapter.apply(platformOnly.plan, platformOnly.context);
    expect(direct).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(direct.diagnostic?.code).toBe("organic_policy_invalid");
    expect(platformOnly.transport.apply).not.toHaveBeenCalled();
    const draft = runtime({ mode: "PLATFORM_DRAFT", feature: "distribution.content.draft" });
    expect(await draft.adapter.apply(draft.plan, draft.context)).toMatchObject({
      state: "accepted_unverified",
    });
    expect(draft.transport.apply).toHaveBeenCalledOnce();
  });

  it("fails absent, stale, forged, unhealthy, and capability-mismatched inputs before transport", async () => {
    const missing = runtime({ mode: "AUTOMATIC_WITHIN_POLICY" });
    const noAuthority = await missing.adapter.apply(missing.plan, {
      ...missing.context,
      organicAuthority: undefined,
    });
    expect(noAuthority.diagnostic?.code).toBe("organic_policy_missing");
    expect(missing.transport.apply).not.toHaveBeenCalled();

    const forged = runtime({ mode: "AUTOMATIC_WITHIN_POLICY" });
    const forgedResult = await forged.adapter.apply(forged.plan, {
      ...forged.context,
      organicAuthority: { ...forged.authority, intentHash: "f".repeat(64) },
    });
    expect(forgedResult.diagnostic?.code).toBe("organic_policy_invalid");
    expect(forged.transport.apply).not.toHaveBeenCalled();

    const stale = runtime({
      mode: "AUTOMATIC_WITHIN_POLICY",
      contextNow: () => new Date("2026-08-09T12:20:00.000Z"),
    });
    const staleResult = await stale.adapter.apply(stale.plan, stale.context);
    expect(staleResult.diagnostic?.code).toBe("organic_policy_stale");
    expect(stale.transport.apply).not.toHaveBeenCalled();

    const unhealthy = runtime({ mode: "AUTOMATIC_WITHIN_POLICY", health: "degraded" });
    const unhealthyResult = await unhealthy.adapter.apply(unhealthy.plan, unhealthy.context);
    expect(unhealthyResult.diagnostic?.code).toBe("organic_policy_provider_unavailable");
    expect(unhealthy.transport.apply).not.toHaveBeenCalled();

    const unavailable = runtime({
      mode: "AUTOMATIC_WITHIN_POLICY",
      capabilities: ["distribution.content.draft"],
    });
    const unavailableResult = await unavailable.adapter.apply(
      unavailable.plan,
      unavailable.context,
    );
    expect(unavailableResult.diagnostic?.code).toBe("organic_policy_provider_unavailable");
    expect(unavailable.transport.apply).not.toHaveBeenCalled();
  });

  it("rejects providers and accounts outside the exact Growth Contract allowlists", () => {
    const providerTransport = fixtureTransport();
    expect(() =>
      runtime({
        mode: "AUTOMATIC_WITHIN_POLICY",
        allowedProviders: ["postiz"],
        transport: providerTransport,
      }),
    ).toThrow(/does not allow this organic provider/i);
    expect(providerTransport.apply).not.toHaveBeenCalled();

    const accountTransport = fixtureTransport();
    expect(() =>
      runtime({
        mode: "AUTOMATIC_WITHIN_POLICY",
        account: "tiktok-user-1",
        allowedAccounts: ["another-account"],
        transport: accountTransport,
      }),
    ).toThrow(/does not allow this organic account/i);
    expect(accountTransport.apply).not.toHaveBeenCalled();
  });

  it("rechecks current rights, region, channel, and disclosure immediately before apply", async () => {
    const rights = runtime({ mode: "AUTOMATIC_WITHIN_POLICY" });
    rights.manifestStore.revoke({
      organizationId: rights.plan.organizationId,
      ventureId: rights.plan.ventureId,
      creativeId: "creative-1",
      reason: "creator withdrew permission",
      reviewedBy: "reviewer-2",
      reviewEventId: "review-event-revoked",
      revokedAt: "2026-08-09T11:59:30.000Z",
    });
    const blocked = await rights.adapter.apply(rights.plan, rights.context);
    expect(blocked.diagnostic?.code).toBe("organic_policy_rights_invalid");
    expect(rights.transport.apply).not.toHaveBeenCalled();

    const scope = runtime({ mode: "AUTOMATIC_WITHIN_POLICY" });
    scope.manifestStore.put(
      manifestInput(scope.plan.organizationId, scope.plan.ventureId, "creative-1", {
        reviewEventId: "review-event-wrong-scope",
        reviewedAt: "2026-08-09T11:59:30.000Z",
        permittedRegions: ["BE"],
        permittedChannels: ["youtube_organic"],
      }),
    );
    const scopeBlocked = await scope.adapter.apply(scope.plan, scope.context);
    expect(scopeBlocked.diagnostic?.code).toBe("organic_policy_rights_invalid");
    expect(scope.transport.apply).not.toHaveBeenCalled();

    const disclosure = runtime({ mode: "AUTOMATIC_WITHIN_POLICY" });
    disclosure.manifestStore.put(
      manifestInput(disclosure.plan.organizationId, disclosure.plan.ventureId, "creative-1", {
        reviewEventId: "review-event-disclosure-missing",
        reviewedAt: "2026-08-09T11:59:30.000Z",
        disclosure: { required: true, present: false, text: null, evidenceRef: null },
      }),
    );
    const disclosureBlocked = await disclosure.adapter.apply(disclosure.plan, disclosure.context);
    expect(disclosureBlocked.diagnostic?.code).toBe("organic_policy_rights_invalid");
    expect(disclosure.transport.apply).not.toHaveBeenCalled();
  });

  it("serializes concurrent workers at the per-account/day posting cap", async () => {
    const directory = root();
    const transport = fixtureTransport();
    const operationStore = durableOperationStore();
    const first = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      maxPosts: 1,
      duplicatePolicy: "allow_with_variation",
      title: "Variation A",
      deliveryVariantId: "delivery-a",
      deliveryFingerprint: "1".repeat(64),
      operationId: "concurrent-a",
      idempotencyKey: "concurrent-a",
      transport,
      operationStore,
    });
    const second = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      maxPosts: 1,
      duplicatePolicy: "allow_with_variation",
      title: "Variation B",
      deliveryVariantId: "delivery-b",
      deliveryFingerprint: "2".repeat(64),
      operationId: "concurrent-b",
      idempotencyKey: "concurrent-b",
      transport,
      operationStore,
    });
    const results = await Promise.all([
      first.adapter.apply(first.plan, first.context),
      second.adapter.apply(second.plan, second.context),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual([
      "accepted_unverified",
      "blocked",
    ]);
    expect(results.find((result) => result.state === "blocked")?.diagnostic?.code).toBe(
      "organic_policy_limit",
    );
    expect(transport.apply).toHaveBeenCalledOnce();
    expect(
      first.policyStore.listReservations({
        organizationId: first.plan.organizationId,
        ventureId: first.plan.ventureId,
      }),
    ).toHaveLength(1);
  });

  it("releases organic quota when the durable operation claim fails before provider apply", async () => {
    const directory = root();
    const transport = fixtureTransport();
    const backingStore = durableOperationStore();
    const failingStore: WinnerLiveProviderOperationStore = Object.freeze({
      durability: backingStore.durability,
      atomicClaims: true as const,
      get: backingStore.get.bind(backingStore),
      claim: vi.fn(async () => {
        throw new Error("synthetic atomic claim outage");
      }),
      complete: backingStore.complete.bind(backingStore),
      markAmbiguous: backingStore.markAmbiguous.bind(backingStore),
      reconcile: backingStore.reconcile.bind(backingStore),
    });
    const failed = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      approve: false,
      maxPosts: 1,
      duplicatePolicy: "forbid",
      operationId: "claim-failure-a",
      idempotencyKey: "claim-failure-a",
      transport,
      operationStore: failingStore,
    });

    const result = await failed.adapter.apply(failed.plan, failed.context);
    expect(result).toMatchObject({
      state: "blocked",
      providerInvoked: false,
      externalEffectOccurred: false,
    });
    expect(result.diagnostic?.code).toBe("response_invalid");
    expect(transport.apply).not.toHaveBeenCalled();
    expect(
      failed.policyStore.listReservations({
        organizationId: failed.plan.organizationId,
        ventureId: failed.plan.ventureId,
      }),
    ).toMatchObject([{ state: "failed_no_effect" }]);

    const retry = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      approve: false,
      maxPosts: 1,
      duplicatePolicy: "forbid",
      operationId: "claim-failure-b",
      idempotencyKey: "claim-failure-b",
      transport,
      operationStore: durableOperationStore(),
    });
    expect(await retry.adapter.apply(retry.plan, retry.context)).toMatchObject({
      state: "accepted_unverified",
    });
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("enforces forbid, across-account, and variation duplicate policies transactionally", async () => {
    const forbiddenRoot = root();
    const forbiddenTransport = fixtureTransport();
    const forbiddenStore = durableOperationStore();
    const forbiddenA = runtime({
      root: forbiddenRoot,
      account: "account-a",
      allowedAccounts: ["account-a", "account-b"],
      maxAccounts: 2,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "forbid",
      operationId: "forbid-a",
      idempotencyKey: "forbid-a",
      transport: forbiddenTransport,
      operationStore: forbiddenStore,
    });
    const forbiddenB = runtime({
      root: forbiddenRoot,
      account: "account-b",
      allowedAccounts: ["account-a", "account-b"],
      maxAccounts: 2,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "forbid",
      operationId: "forbid-b",
      idempotencyKey: "forbid-b",
      transport: forbiddenTransport,
      operationStore: forbiddenStore,
    });
    expect((await forbiddenA.adapter.apply(forbiddenA.plan, forbiddenA.context)).state).toBe(
      "accepted_unverified",
    );
    const blockedAcross = await forbiddenB.adapter.apply(forbiddenB.plan, forbiddenB.context);
    expect(blockedAcross.diagnostic?.code).toBe("organic_policy_duplicate");

    const acrossRoot = root();
    const acrossTransport = fixtureTransport();
    const acrossStore = durableOperationStore();
    const acrossA = runtime({
      root: acrossRoot,
      account: "account-a",
      allowedAccounts: ["account-a", "account-b"],
      maxAccounts: 2,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_across_accounts",
      operationId: "across-a",
      idempotencyKey: "across-a",
      transport: acrossTransport,
      operationStore: acrossStore,
    });
    const acrossB = runtime({
      root: acrossRoot,
      account: "account-b",
      allowedAccounts: ["account-a", "account-b"],
      maxAccounts: 2,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_across_accounts",
      operationId: "across-b",
      idempotencyKey: "across-b",
      transport: acrossTransport,
      operationStore: acrossStore,
    });
    expect((await acrossA.adapter.apply(acrossA.plan, acrossA.context)).state).toBe(
      "accepted_unverified",
    );
    expect((await acrossB.adapter.apply(acrossB.plan, acrossB.context)).state).toBe(
      "accepted_unverified",
    );
    const sameAccount = runtime({
      root: acrossRoot,
      account: "account-a",
      allowedAccounts: ["account-a", "account-b"],
      maxAccounts: 2,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_across_accounts",
      operationId: "across-a-repeat",
      idempotencyKey: "across-a-repeat",
      transport: acrossTransport,
      operationStore: acrossStore,
    });
    expect(
      (await sameAccount.adapter.apply(sameAccount.plan, sameAccount.context)).diagnostic?.code,
    ).toBe("organic_policy_duplicate");
    expect(acrossTransport.apply).toHaveBeenCalledTimes(2);

    const variationRoot = root();
    const variationTransport = fixtureTransport();
    const variationStore = durableOperationStore();
    const variationA = runtime({
      root: variationRoot,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_with_variation",
      title: "Variation A",
      deliveryVariantId: "variation-a",
      deliveryFingerprint: "3".repeat(64),
      operationId: "variation-a",
      idempotencyKey: "variation-a",
      transport: variationTransport,
      operationStore: variationStore,
    });
    const variationB = runtime({
      root: variationRoot,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_with_variation",
      title: "Variation B",
      deliveryVariantId: "variation-b",
      deliveryFingerprint: "4".repeat(64),
      operationId: "variation-b",
      idempotencyKey: "variation-b",
      transport: variationTransport,
      operationStore: variationStore,
    });
    expect((await variationA.adapter.apply(variationA.plan, variationA.context)).state).toBe(
      "accepted_unverified",
    );
    expect((await variationB.adapter.apply(variationB.plan, variationB.context)).state).toBe(
      "accepted_unverified",
    );
    const repeatedVariation = runtime({
      root: variationRoot,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_with_variation",
      title: "Variation A",
      deliveryVariantId: "variation-a",
      deliveryFingerprint: "3".repeat(64),
      operationId: "variation-a-repeat",
      idempotencyKey: "variation-a-repeat",
      transport: variationTransport,
      operationStore: variationStore,
    });
    expect(
      (await repeatedVariation.adapter.apply(repeatedVariation.plan, repeatedVariation.context))
        .diagnostic?.code,
    ).toBe("organic_policy_duplicate");
    expect(variationTransport.apply).toHaveBeenCalledTimes(2);
  });

  it("binds idempotency to the exact provider request and rejects changed replay input", async () => {
    const directory = root();
    const transport = fixtureTransport();
    const operationStore = durableOperationStore();
    const first = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_with_variation",
      title: "Original title",
      deliveryVariantId: "delivery-original",
      deliveryFingerprint: "5".repeat(64),
      operationId: "same-operation",
      idempotencyKey: "same-key",
      transport,
      operationStore,
    });
    expect((await first.adapter.apply(first.plan, first.context)).state).toBe(
      "accepted_unverified",
    );
    const changed = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      duplicatePolicy: "allow_with_variation",
      title: "Changed title",
      deliveryVariantId: "delivery-changed",
      deliveryFingerprint: "6".repeat(64),
      operationId: "same-operation",
      idempotencyKey: "same-key",
      transport,
      operationStore,
    });
    const conflict = await changed.adapter.apply(changed.plan, changed.context);
    expect(conflict).toMatchObject({ state: "conflict", providerInvoked: false });
    expect(conflict.diagnostic?.code).toBe("idempotency_conflict");
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("survives restart and reconciles an unknown write without a second fixture write", async () => {
    const directory = root();
    const transport = fixtureTransport({ applyState: "unknown" });
    const operationStore = durableOperationStore();
    const first = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      transport,
      operationStore,
    });
    expect(await first.adapter.apply(first.plan, first.context)).toMatchObject({
      state: "unknown",
      externalEffectOccurred: "unknown",
    });
    expect(
      first.policyStore.listReservations({
        organizationId: first.plan.organizationId,
        ventureId: first.plan.ventureId,
      })[0]?.state,
    ).toBe("pending_reconciliation");
    first.policyStore.close();
    first.creativeStore.close();
    first.manifestStore.close();

    const restarted = runtime({
      root: directory,
      mode: "AUTOMATIC_WITHIN_POLICY",
      transport,
      operationStore,
    });
    expect(await restarted.adapter.apply(restarted.plan, restarted.context)).toMatchObject({
      state: "unknown",
      reused: true,
      providerInvoked: false,
    });
    const reconciled = await restarted.adapter.reconcile(restarted.plan, restarted.context);
    expect(reconciled).toMatchObject({ state: "matched", reapplied: false, liveVerified: false });
    expect(
      restarted.policyStore.listReservations({
        organizationId: restarted.plan.organizationId,
        ventureId: restarted.plan.ventureId,
      })[0]?.state,
    ).toBe("published");
    expect(transport.apply).toHaveBeenCalledOnce();
    expect(transport.reconcile).toHaveBeenCalledOnce();
  });

  it("keeps tenant reservations isolated and refuses cross-venture authority", async () => {
    const transport = fixtureTransport();
    const operationStore = durableOperationStore();
    const tenantA = runtime({
      ventureId: "venture-a",
      mode: "AUTOMATIC_WITHIN_POLICY",
      transport,
      operationStore,
    });
    const tenantB = runtime({
      ventureId: "venture-b",
      mode: "AUTOMATIC_WITHIN_POLICY",
      transport,
      operationStore,
    });
    expect((await tenantA.adapter.apply(tenantA.plan, tenantA.context)).state).toBe(
      "accepted_unverified",
    );
    const crossed = await tenantB.adapter.apply(tenantB.plan, {
      ...tenantB.context,
      organicAuthority: tenantA.authority,
    });
    expect(crossed).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(
      tenantA.policyStore.listReservations({
        organizationId: tenantA.plan.organizationId,
        ventureId: tenantB.plan.ventureId,
      }),
    ).toEqual([]);
    expect(transport.apply).toHaveBeenCalledOnce();
  });

  it("isolates same-venture organizations in one SQLite policy ledger and rejects forged authority", async () => {
    const directory = root();
    const transport = fixtureTransport();
    const operationStore = durableOperationStore();
    const tenantA = runtime({
      root: directory,
      organizationId: "organization-a",
      ventureId: "shared-venture",
      mode: "AUTOMATIC_WITHIN_POLICY",
      maxPosts: 1,
      transport,
      operationStore,
    });
    const tenantB = runtime({
      root: directory,
      organizationId: "organization-b",
      ventureId: "shared-venture",
      mode: "AUTOMATIC_WITHIN_POLICY",
      maxPosts: 1,
      transport,
      operationStore,
    });

    expect((await tenantA.adapter.apply(tenantA.plan, tenantA.context)).state).toBe(
      "accepted_unverified",
    );
    const forged = await tenantB.adapter.apply(tenantB.plan, {
      ...tenantB.context,
      organicAuthority: tenantA.authority,
    });
    expect(forged).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(transport.apply).toHaveBeenCalledOnce();

    expect((await tenantB.adapter.apply(tenantB.plan, tenantB.context)).state).toBe(
      "accepted_unverified",
    );
    expect(
      tenantA.policyStore.listReservations({
        organizationId: tenantA.plan.organizationId,
        ventureId: tenantA.plan.ventureId,
      }),
    ).toHaveLength(1);
    expect(
      tenantB.policyStore.listReservations({
        organizationId: tenantB.plan.organizationId,
        ventureId: tenantB.plan.ventureId,
      }),
    ).toHaveLength(1);
    expect(transport.apply).toHaveBeenCalledTimes(2);
  });

  it("does not mark publication verified when provider read-back evidence mismatches", async () => {
    const transport = fixtureTransport({ mismatchedEvidence: true });
    const instance = runtime({
      mode: "AUTOMATIC_WITHIN_POLICY",
      transport,
    });
    expect((await instance.adapter.apply(instance.plan, instance.context)).state).toBe(
      "accepted_unverified",
    );
    const verification = await instance.adapter.verify(instance.plan, instance.context);
    expect(verification).toMatchObject({ state: "failed", liveVerified: false, evidence: null });
    expect(
      instance.policyStore.listReservations({
        organizationId: instance.plan.organizationId,
        ventureId: instance.plan.ventureId,
      })[0]?.state,
    ).toBe("conflict");
  });

  it("requires the organic policy service even when a caller supplies legacy review booleans", async () => {
    const transport = fixtureTransport();
    const adapter = createWinnerLiveProviderAdapters({
      transports: { tiktok_content_posting: transport },
      store: durableOperationStore(),
    }).tiktok_content_posting;
    const plan = adapter.plan({
      organizationId: ORGANIZATION_ID,
      ventureId: "venture-1",
      providerAccountId: "tiktok-user-1",
      operationId: "missing-policy",
      idempotencyKey: "missing-policy",
      feature: "distribution.content.publish",
      payload: payload("distribution.content.publish", "Legacy self-authored review"),
    });
    const result = await adapter.apply(plan, {
      organizationId: ORGANIZATION_ID,
      credentialRef: "cred://winner-loop/tiktok-content",
      authorization: authorization(plan),
      reviewApproval: {
        kind: "organic.direct_publish",
        requestHash: plan.requestHash,
        operationId: plan.operationId,
        approvedBy: "caller",
        approvalRef: "artifact://caller/legacy-review",
        approvedAt: "2026-08-09T11:59:00.000Z",
        expiresAt: "2026-08-09T12:30:00.000Z",
      },
      executionMode: "authorized_transport",
      environment: "test",
      now,
    });
    expect(result).toMatchObject({ state: "blocked", providerInvoked: false });
    expect(result.diagnostic?.code).toBe("organic_policy_missing");
    expect(transport.apply).not.toHaveBeenCalled();
    expect(WINNER_LIVE_PROVIDER_DESCRIPTORS.tiktok_content_posting.liveVerification).toBe(
      "pending",
    );
  });
});
