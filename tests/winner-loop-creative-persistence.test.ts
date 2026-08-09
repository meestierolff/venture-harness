import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeContentFingerprint,
  assessCreativeCompliance,
  createCreativeLedger,
  createMemoryCreativeLedgerStore,
  createMemoryCreativeManifestStore,
  createSqliteCreativeLedgerStore,
  createSqliteCreativeManifestStore,
  createSqliteWinnerLoopEvidenceStore,
  createTrustedLegacyTenantAdoptionMapping,
  type CreativeDeliveryDimensions,
  type CreativeLedgerStore,
  type CreativeManifestInput,
  type CreativeManifestStore,
  type CreativeMediaDimensions,
} from "@/lib/winner-loop";
import type {
  LegacyAdoptionOptions,
  TrustedLegacyTenantAdoptionMapping,
} from "@/lib/winner-loop/legacy-adoption";

const FIRST_NOW = new Date("2026-08-09T09:00:00.000Z");
const SECOND_NOW = new Date("2026-08-09T10:00:00.000Z");
const THIRD_NOW = new Date("2026-08-09T11:00:00.000Z");
const ORGANIZATION_ID = "org-payout-rank";

const temporaryDirectories = new Set<string>();
const openResources = new Set<{ close(): void }>();

afterEach(() => {
  for (const resource of [...openResources].reverse()) {
    try {
      resource.close();
    } catch {
      // A test may deliberately close and reopen the durable store.
    }
  }
  openResources.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-creative-ledger-"));
  temporaryDirectories.add(directory);
  return join(directory, "winner-loop.sqlite");
}

type CredentialIdentityField = "approvedBy" | "legacyVentureId" | "organizationId" | "ventureId";

const CREDENTIAL_IDENTITY_CASES = [
  ["approver", "approvedBy", "whsec_approver_canary"],
  ["legacy venture id", "legacyVentureId", "whsec_legacy_canary"],
  ["target organization id", "organizationId", "whsec_organization_canary"],
  ["target venture id", "ventureId", "whsec_venture_canary"],
] as const satisfies readonly (readonly [string, CredentialIdentityField, string])[];

function forgedCredentialAdoption(
  field: CredentialIdentityField,
  credential: string,
): LegacyAdoptionOptions {
  const entry = {
    legacyVentureId: "legacy-credential-boundary",
    organizationId: "org-credential-boundary",
    ventureId: "venture-credential-boundary",
  };
  const mapping = {
    contractVersion: 1,
    ownershipVerification: "verified_out_of_band",
    authorizationDisposition: "invalidate_and_require_reapproval",
    approvedBy: "migration-operator",
    approvedAt: FIRST_NOW.toISOString(),
    mappings: [
      field === "approvedBy"
        ? entry
        : {
            ...entry,
            [field]: credential,
          },
    ],
    ...(field === "approvedBy" ? { approvedBy: credential } : {}),
  } as TrustedLegacyTenantAdoptionMapping;
  return { legacyAdoption: mapping };
}

function track<T extends { close(): void }>(resource: T): T {
  openResources.add(resource);
  return resource;
}

function close(resource: { close(): void }): void {
  resource.close();
  openResources.delete(resource);
}

function bytes(seed: number): (size: number) => Uint8Array {
  return (size) => Uint8Array.from({ length: size }, (_, index) => (seed * 31 + index * 17) % 256);
}

function media(overrides: Partial<CreativeMediaDimensions> = {}): CreativeMediaDimensions {
  return {
    hook: "Your affiliate payouts may be leaking",
    openingFrame: "founder_close_up",
    format: "talking_head_with_product",
    speaker: "founder",
    visualSequence: "founder_then_product",
    audioTrack: "founder_voice",
    onScreenProof: "payout_dashboard",
    embeddedCta: "Check your payout rank",
    durationSeconds: 22,
    aspectRatio: "9:16",
    ...overrides,
  };
}

function delivery(overrides: Partial<CreativeDeliveryDimensions> = {}): CreativeDeliveryDimensions {
  return {
    caption: "Check the payout rank before your next campaign.",
    adCopy: "",
    destinationUrl: "https://payoutrank.example/scan?utm_source=tiktok",
    privacy: "public",
    platformSettings: { allowComments: true, placement: "feed" },
    ...overrides,
  };
}

function approvedManifest(
  ventureId: string,
  creativeId: string,
  creativeFamilyId: string,
  organizationId = ORGANIZATION_ID,
): CreativeManifestInput {
  return {
    organizationId,
    ventureId,
    creativeId,
    creativeFamilyId,
    hypothesis: "A concrete payout comparison creates qualified intent.",
    scriptVersion: "script-v1",
    promptVersion: "prompt-v1",
    storyboardRef: "asset://storyboard/1",
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
      text: "AI-assisted creative",
      evidenceRef: "audit://disclosure/1",
    },
    permittedRegions: ["NL"],
    permittedChannels: ["tiktok_organic", "tiktok_paid", "meta_paid"],
    organicApproved: true,
    paidApproved: true,
    expiresAt: "2026-08-20T00:00:00.000Z",
    claims: [],
    prohibitedClaims: [],
    truthReferences: ["truth://creative/1"],
    reviewedBy: "rights-reviewer",
    reviewEventId: `rights-review:${creativeId}`,
    reviewedAt: FIRST_NOW.toISOString(),
  };
}

function ledgerOptions(
  ventureId: string,
  store: CreativeLedgerStore,
  manifestStore: CreativeManifestStore,
  current: Date,
  seed: number,
  organizationId = ORGANIZATION_ID,
) {
  return {
    organizationId,
    ventureId,
    store,
    now: () => current,
    randomBytes: bytes(seed),
    authorization: {
      manifestStore,
      regionByNetwork: {
        tiktok_organic: "NL",
        tiktok_paid: "NL",
        meta_paid: "NL",
      },
      policyByNetwork: {
        tiktok_organic: {
          disclosureRequired: true,
          allowedRegions: ["NL"],
          allowedChannels: ["tiktok_organic"],
          prohibitedClaims: ["guaranteed income"],
        },
        tiktok_paid: {
          disclosureRequired: true,
          allowedRegions: ["NL"],
          allowedChannels: ["tiktok_paid"],
          prohibitedClaims: ["guaranteed income"],
        },
        meta_paid: {
          disclosureRequired: true,
          allowedRegions: ["NL"],
          allowedChannels: ["meta_paid"],
          prohibitedClaims: ["guaranteed income"],
        },
      },
    },
  } as const;
}

describe("durable creative identity ledger", () => {
  it("hydrates identity, lineage, delivery, provider mappings, and status history after restart", () => {
    const filename = temporaryDatabase();
    const firstStore = track(createSqliteCreativeLedgerStore(filename));
    const firstManifests = track(createSqliteCreativeManifestStore(filename));
    const first = createCreativeLedger(
      ledgerOptions("payout-rank", firstStore, firstManifests, FIRST_NOW, 1),
    );
    const parentInput = {
      organizationId: first.organizationId,
      ventureId: "payout-rank",
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      media: media(),
      assetContentHash: "sha256:parent",
      destinationIsTestedHypothesis: true,
      delivery: delivery(),
      fingerprintVersion: "v1" as const,
    };
    const parent = first.registerVariant(parentInput);
    firstManifests.put(
      approvedManifest(first.ventureId, parent.creativeId, parent.creativeFamilyId),
    );
    const child = first.deriveVariant({
      parentCreativeId: parent.creativeId,
      relationship: "platform_variant",
      mediaChanges: { openingFrame: "product_first", durationSeconds: 15 },
      assetContentHash: "sha256:child",
    });
    expect(child.contentFingerprint).toBe(
      computeContentFingerprint(
        {
          media: media({ openingFrame: "product_first", durationSeconds: 15 }),
          delivery: delivery(),
          assetContentHash: "sha256:child",
          destinationIsTestedHypothesis: true,
        },
        "v1",
      ).fingerprint,
    );
    const shipped = first.registerDeliveryVariant(parent.creativeId, delivery());
    const provider = first.mapProviderObject({
      organizationId: first.organizationId,
      ventureId: first.ventureId,
      creativeId: parent.creativeId,
      deliveryVariantId: shipped.deliveryVariantId,
      provider: "tiktok_content",
      objectKind: "organic_post",
      externalId: "post-100",
      externalAccountId: "venture-owned-account",
    });
    for (const status of [
      "READY_FOR_PRODUCTION",
      "RENDERING",
      "ASSET_READY",
      "READY_FOR_ORGANIC_REVIEW",
    ] as const) {
      first.recordStatus(parent.creativeId, "tiktok_organic", status);
    }
    expect(first.listStatusHistory(parent.creativeId, "tiktok_organic")).toHaveLength(5);

    close(firstStore);
    close(firstManifests);

    const secondStore = track(createSqliteCreativeLedgerStore(filename));
    const secondManifests = track(createSqliteCreativeManifestStore(filename));
    const second = createCreativeLedger(
      ledgerOptions("payout-rank", secondStore, secondManifests, SECOND_NOW, 2),
    );

    expect(second.registerVariant(parentInput)).toEqual(parent);
    const reorderedMedia = Object.fromEntries(
      Object.entries(parentInput.media).reverse(),
    ) as unknown as CreativeMediaDimensions;
    expect(second.registerVariant({ ...parentInput, media: reorderedMedia })).toEqual(parent);
    expect(
      second.deriveVariant({
        parentCreativeId: parent.creativeId,
        relationship: "platform_variant",
        mediaChanges: { openingFrame: "product_first", durationSeconds: 15 },
        assetContentHash: "sha256:child",
      }),
    ).toEqual(child);
    expect(second.registerDeliveryVariant(parent.creativeId, delivery())).toEqual(shipped);
    expect(
      second.registerDeliveryVariant(
        parent.creativeId,
        delivery({ platformSettings: { placement: "feed", allowComments: true } }),
      ),
    ).toEqual(shipped);
    expect(
      second.mapProviderObject({
        organizationId: second.organizationId,
        ventureId: second.ventureId,
        creativeId: parent.creativeId,
        deliveryVariantId: shipped.deliveryVariantId,
        provider: "tiktok_content",
        objectKind: "organic_post",
        externalId: "post-100",
        externalAccountId: "venture-owned-account",
      }),
    ).toEqual(provider);
    expect(second.listVariants()).toEqual([parent, child]);
    expect(second.lineageOf(child.creativeId)).toEqual([parent.creativeId, child.creativeId]);
    expect(second.getVariant(parent.creativeId)?.contentFingerprintVersion).toBe("v1");
    expect(second.getDeliveryVariant(shipped.deliveryVariantId)).toEqual(shipped);
    expect(second.listProviderObjects(parent.creativeId)).toEqual([provider]);
    expect(second.resolveByProviderObject("tiktok_content", "organic_post", "post-100")).toBe(
      parent.creativeId,
    );
    expect(second.statusOf(parent.creativeId).tiktok_organic).toBe("READY_FOR_ORGANIC_REVIEW");
    expect(second.listStatusHistory(parent.creativeId, "tiktok_organic")).toMatchObject([
      { fromStatus: null, toStatus: "DRAFT" },
      { fromStatus: "DRAFT", toStatus: "READY_FOR_PRODUCTION" },
      { fromStatus: "READY_FOR_PRODUCTION", toStatus: "RENDERING" },
      { fromStatus: "RENDERING", toStatus: "ASSET_READY" },
      { fromStatus: "ASSET_READY", toStatus: "READY_FOR_ORGANIC_REVIEW" },
    ]);

    second.recordStatus(parent.creativeId, "tiktok_organic", "ORGANIC_DRAFT");
    secondManifests.revoke({
      organizationId: second.organizationId,
      ventureId: second.ventureId,
      creativeId: parent.creativeId,
      reason: "creator withdrew authorization",
      reviewedBy: "rights-reviewer",
      reviewEventId: "rights-revocation:parent",
      revokedAt: SECOND_NOW.toISOString(),
    });
    close(secondStore);
    close(secondManifests);

    const thirdStore = track(createSqliteCreativeLedgerStore(filename));
    const thirdManifests = track(createSqliteCreativeManifestStore(filename));
    const third = createCreativeLedger(
      ledgerOptions("payout-rank", thirdStore, thirdManifests, THIRD_NOW, 3),
    );
    const beforeBlockedTransition = third.listStatusHistory(parent.creativeId, "tiktok_organic");

    expect(() =>
      third.recordStatus(parent.creativeId, "tiktok_organic", "ORGANIC_PUBLISHED"),
    ).toThrowError(expect.objectContaining({ code: "creative_not_authorized" }) as never);
    expect(third.statusOf(parent.creativeId).tiktok_organic).toBe("ORGANIC_DRAFT");
    expect(third.listStatusHistory(parent.creativeId, "tiktok_organic")).toEqual(
      beforeBlockedTransition,
    );
  });

  it("isolates identical creative, delivery, manifest, and provider ids by organization", () => {
    const filename = temporaryDatabase();
    const storeA = track(createSqliteCreativeLedgerStore(filename));
    const storeB = track(createSqliteCreativeLedgerStore(filename));
    const manifestsA = track(createSqliteCreativeManifestStore(filename));
    const manifestsB = track(createSqliteCreativeManifestStore(filename));
    const ventureId = "shared-venture";
    const organizationA = "org-alpha";
    const organizationB = "org-bravo";
    const alpha = createCreativeLedger(
      ledgerOptions(ventureId, storeA, manifestsA, FIRST_NOW, 41, organizationA),
    );
    const bravo = createCreativeLedger(
      ledgerOptions(ventureId, storeB, manifestsB, FIRST_NOW, 41, organizationB),
    );

    const alphaCreative = alpha.registerVariant({
      organizationId: organizationA,
      ventureId,
      hypothesisId: "hyp-shared",
      creativeFamilyId: "fam-shared",
      media: media({ hook: "Alpha-owned material" }),
      assetContentHash: "sha256:alpha",
    });
    const bravoCreative = bravo.registerVariant({
      organizationId: organizationB,
      ventureId,
      hypothesisId: "hyp-shared",
      creativeFamilyId: "fam-shared",
      media: media({ hook: "Bravo-owned material" }),
      assetContentHash: "sha256:bravo",
    });
    expect(bravoCreative.creativeId).toBe(alphaCreative.creativeId);

    manifestsA.put(
      approvedManifest(
        ventureId,
        alphaCreative.creativeId,
        alphaCreative.creativeFamilyId,
        organizationA,
      ),
    );
    manifestsB.put(
      approvedManifest(
        ventureId,
        bravoCreative.creativeId,
        bravoCreative.creativeFamilyId,
        organizationB,
      ),
    );
    const alphaDelivery = alpha.registerDeliveryVariant(alphaCreative.creativeId, delivery());
    const bravoDelivery = bravo.registerDeliveryVariant(bravoCreative.creativeId, delivery());
    expect(bravoDelivery.deliveryVariantId).toBe(alphaDelivery.deliveryVariantId);

    const providerInput = {
      creativeId: alphaCreative.creativeId,
      deliveryVariantId: alphaDelivery.deliveryVariantId,
      provider: "tiktok_content" as const,
      objectKind: "organic_post" as const,
      externalId: "shared-provider-object",
      externalAccountId: "shared-account",
      ventureId,
    };
    alpha.mapProviderObject({ ...providerInput, organizationId: organizationA });
    bravo.mapProviderObject({ ...providerInput, organizationId: organizationB });

    expect(alpha.getVariant(alphaCreative.creativeId)?.media.hook).toBe("Alpha-owned material");
    expect(bravo.getVariant(bravoCreative.creativeId)?.media.hook).toBe("Bravo-owned material");
    expect(storeA.listVariants({ organizationId: organizationA, ventureId })).toHaveLength(1);
    expect(storeA.listVariants({ organizationId: organizationB, ventureId })).toHaveLength(1);
    expect(
      manifestsA.getCurrent({ organizationId: organizationA, ventureId }, alphaCreative.creativeId)
        ?.organizationId,
    ).toBe(organizationA);
    expect(
      manifestsA.getCurrent({ organizationId: organizationB, ventureId }, bravoCreative.creativeId)
        ?.organizationId,
    ).toBe(organizationB);
    expect(alpha.listProviderObjects(alphaCreative.creativeId)[0]?.organizationId).toBe(
      organizationA,
    );
    expect(bravo.listProviderObjects(bravoCreative.creativeId)[0]?.organizationId).toBe(
      organizationB,
    );

    expect(() =>
      alpha.registerVariant({
        organizationId: organizationB,
        ventureId,
        hypothesisId: "forged",
        creativeFamilyId: "forged",
        media: media(),
        assetContentHash: "sha256:forged",
      }),
    ).toThrowError(expect.objectContaining({ code: "cross_venture_access_denied" }) as never);
    expect(() =>
      alpha.mapProviderObject({ ...providerInput, organizationId: organizationB }),
    ).toThrowError(expect.objectContaining({ code: "cross_venture_access_denied" }) as never);
  });

  it("keeps same-id organization ledgers isolated in memory", () => {
    const store = track(createMemoryCreativeLedgerStore());
    const manifests = track(createMemoryCreativeManifestStore());
    const alpha = createCreativeLedger(
      ledgerOptions("shared-venture", store, manifests, FIRST_NOW, 51, "org-alpha"),
    );
    const bravo = createCreativeLedger(
      ledgerOptions("shared-venture", store, manifests, FIRST_NOW, 51, "org-bravo"),
    );
    const alphaCreative = alpha.registerVariant({
      organizationId: alpha.organizationId,
      ventureId: alpha.ventureId,
      hypothesisId: "hyp-shared",
      creativeFamilyId: "fam-shared",
      media: media({ hook: "Alpha memory material" }),
      assetContentHash: "sha256:alpha-memory",
    });
    const bravoCreative = bravo.registerVariant({
      organizationId: bravo.organizationId,
      ventureId: bravo.ventureId,
      hypothesisId: "hyp-shared",
      creativeFamilyId: "fam-shared",
      media: media({ hook: "Bravo memory material" }),
      assetContentHash: "sha256:bravo-memory",
    });
    expect(bravoCreative.creativeId).toBe(alphaCreative.creativeId);
    alpha.registerDeliveryVariant(alphaCreative.creativeId, delivery());
    bravo.registerDeliveryVariant(bravoCreative.creativeId, delivery());

    const alphaScope = { organizationId: alpha.organizationId, ventureId: alpha.ventureId };
    const bravoScope = { organizationId: bravo.organizationId, ventureId: bravo.ventureId };
    expect(store.listVariants(alphaScope).map((entry) => entry.media.hook)).toEqual([
      "Alpha memory material",
    ]);
    expect(store.listVariants(bravoScope).map((entry) => entry.media.hook)).toEqual([
      "Bravo memory material",
    ]);
    expect(store.listDeliveryVariants(alphaScope, alphaCreative.creativeId)).toHaveLength(1);
    expect(store.listDeliveryVariants(bravoScope, bravoCreative.creativeId)).toHaveLength(1);
  });

  it("prevents provider objects and delivery variants from moving across creatives or ventures", () => {
    const filename = temporaryDatabase();
    const store = track(createSqliteCreativeLedgerStore(filename));
    const manifests = track(createSqliteCreativeManifestStore(filename));
    const mine = createCreativeLedger(
      ledgerOptions("payout-rank", store, manifests, FIRST_NOW, 11),
    );
    const one = mine.registerVariant({
      organizationId: mine.organizationId,
      ventureId: mine.ventureId,
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      media: media(),
      assetContentHash: "sha256:one",
    });
    const two = mine.registerVariant({
      organizationId: mine.organizationId,
      ventureId: mine.ventureId,
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      media: media({ hook: "A materially different hook" }),
      assetContentHash: "sha256:two",
    });
    const shipped = mine.registerDeliveryVariant(one.creativeId, delivery());
    const mapping = {
      organizationId: mine.organizationId,
      ventureId: mine.ventureId,
      creativeId: one.creativeId,
      deliveryVariantId: shipped.deliveryVariantId,
      provider: "meta_ads" as const,
      objectKind: "ad" as const,
      externalId: "meta-ad-1",
      externalAccountId: "meta-account-1",
    };
    mine.mapProviderObject(mapping);

    expect(() => mine.mapProviderObject({ ...mapping, creativeId: two.creativeId })).toThrowError(
      expect.objectContaining({ code: "immutable_binding_conflict" }) as never,
    );
    expect(() =>
      mine.mapProviderObject({ ...mapping, externalAccountId: "meta-account-2" }),
    ).toThrowError(expect.objectContaining({ code: "provider_object_already_mapped" }) as never);
    expect(() =>
      mine.mapProviderObject({
        ...mapping,
        creativeId: two.creativeId,
        externalId: "meta-ad-2",
      }),
    ).toThrowError(expect.objectContaining({ code: "immutable_binding_conflict" }) as never);

    const theirs = createCreativeLedger(
      ledgerOptions("another-venture", store, manifests, SECOND_NOW, 12),
    );
    expect(theirs.getVariant(one.creativeId)).toBeUndefined();
    expect(() => theirs.statusOf(one.creativeId)).toThrowError(
      expect.objectContaining({ code: "unknown_creative" }) as never,
    );
    const theirCreative = theirs.registerVariant({
      organizationId: theirs.organizationId,
      ventureId: theirs.ventureId,
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      media: media(),
      assetContentHash: "sha256:one",
    });
    expect(theirCreative.creativeId).not.toBe(one.creativeId);
    theirs.mapProviderObject({
      organizationId: theirs.organizationId,
      ventureId: theirs.ventureId,
      creativeId: theirCreative.creativeId,
      provider: "meta_ads",
      objectKind: "ad",
      externalId: "meta-ad-1",
      externalAccountId: "their-meta-account",
    });
    expect(theirs.resolveByProviderObject("meta_ads", "ad", "meta-ad-1")).toBe(
      theirCreative.creativeId,
    );
    expect(mine.resolveByProviderObject("meta_ads", "ad", "meta-ad-1")).toBe(one.creativeId);
  });

  it("supports exact service rehydration through the memory store abstraction", () => {
    const store = track(createMemoryCreativeLedgerStore());
    const manifests = track(createSqliteCreativeManifestStore(temporaryDatabase()));
    const first = createCreativeLedger(
      ledgerOptions("payout-rank", store, manifests, FIRST_NOW, 21),
    );
    const input = {
      organizationId: first.organizationId,
      ventureId: first.ventureId,
      hypothesisId: "hyp-memory",
      creativeFamilyId: "fam-memory",
      media: media(),
      assetContentHash: "sha256:memory",
    };
    const creative = first.registerVariant(input);
    first.recordStatus(creative.creativeId, "tiktok_organic", "READY_FOR_PRODUCTION");

    const rehydrated = createCreativeLedger(
      ledgerOptions("payout-rank", store, manifests, SECOND_NOW, 22),
    );
    expect(rehydrated.registerVariant(input)).toEqual(creative);
    expect(rehydrated.statusOf(creative.creativeId).tiktok_organic).toBe("READY_FOR_PRODUCTION");
    expect(rehydrated.listStatusHistory(creative.creativeId, "tiktok_organic")).toHaveLength(2);
  });

  it("requires trusted adoption for venture-only creative rows and rewrites identity across restart", () => {
    const filename = temporaryDatabase();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          all(...params: unknown[]): unknown[];
          get(...params: unknown[]): unknown;
          run(...params: unknown[]): unknown;
        };
        close(): void;
      };
    };
    const raw = new DatabaseSync(filename);
    const legacyVariant = {
      creativeId: "legacy-creative",
      hypothesisId: "legacy-hypothesis",
      creativeFamilyId: "legacy-family",
      derivedFromCreativeId: null,
      platformVariantOfCreativeId: null,
      contentFingerprint: "a".repeat(64),
      contentFingerprintVersion: "v2",
      media: media({ hook: "Legacy unscoped material" }),
      assetContentHash: "sha256:legacy",
      destinationIsTestedHypothesis: false,
      createdAt: FIRST_NOW.toISOString(),
    };
    const { organizationId: _discardedOrganization, ...legacyManifestInput } = approvedManifest(
      "legacy-venture",
      legacyVariant.creativeId,
      legacyVariant.creativeFamilyId,
    );
    void _discardedOrganization;
    const legacyManifest = {
      ...legacyManifestInput,
      sourceAssetIds: ["legacy-asset"],
      mediaLicenses: [
        {
          assetId: "legacy-asset",
          subjectId: "legacy-asset",
          evidenceRef: "audit://legacy/license",
          licenseType: "paid-social",
          permitsOrganic: true,
          permitsPaid: true,
          permittedRegions: ["NL"],
          permittedChannels: ["tiktok_organic", "tiktok_paid", "meta_paid"],
          expiresAt: "2026-08-20T00:00:00.000Z",
          revokedAt: null,
        },
      ],
      testimonialSubjectIds: ["legacy-subject"],
      testimonialConsents: [
        {
          subjectId: "legacy-subject",
          evidenceRef: "audit://legacy/consent",
          permitsOrganic: true,
          permitsPaid: true,
          permittedRegions: ["NL"],
          permittedChannels: ["tiktok_organic", "tiktok_paid", "meta_paid"],
          expiresAt: "2026-08-20T00:00:00.000Z",
          revokedAt: null,
        },
      ],
      creatorIds: ["legacy-creator"],
      creatorAuthorizations: [
        {
          subjectId: "legacy-creator",
          evidenceRef: "audit://legacy/creator",
          permitsOrganic: true,
          permitsPaid: true,
          permittedRegions: ["NL"],
          permittedChannels: ["tiktok_organic", "tiktok_paid", "meta_paid"],
          expiresAt: "2026-08-20T00:00:00.000Z",
          revokedAt: null,
        },
      ],
      manifestVersion: 1,
      revokedAt: null,
      revocationReason: null,
    };
    const legacyBinding = JSON.stringify({
      ventureId: "legacy-venture",
      hypothesisId: legacyVariant.hypothesisId,
      creativeFamilyId: legacyVariant.creativeFamilyId,
      nestedIdentity: { venture_id: "legacy-venture" },
    });
    raw.exec(`
      CREATE TABLE creative_variants (
        creative_id TEXT NOT NULL PRIMARY KEY, venture_id TEXT NOT NULL,
        registration_key TEXT NOT NULL, registration_binding TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL, content_fingerprint_version TEXT NOT NULL,
        derived_from_creative_id TEXT, platform_variant_of_creative_id TEXT,
        variant_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE creative_delivery_variants (
        delivery_variant_id TEXT NOT NULL PRIMARY KEY, venture_id TEXT NOT NULL,
        creative_id TEXT NOT NULL, delivery_fingerprint TEXT NOT NULL,
        registration_binding TEXT NOT NULL, delivery_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE creative_provider_objects (
        venture_id TEXT NOT NULL, provider TEXT NOT NULL, object_kind TEXT NOT NULL,
        external_id TEXT NOT NULL, creative_id TEXT NOT NULL, delivery_variant_id TEXT,
        external_account_id TEXT NOT NULL, record_json TEXT NOT NULL, recorded_at TEXT NOT NULL
      );
      CREATE TABLE creative_status_current (
        venture_id TEXT NOT NULL, creative_id TEXT NOT NULL, network TEXT NOT NULL,
        status TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE creative_status_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, venture_id TEXT NOT NULL,
        creative_id TEXT NOT NULL, network TEXT NOT NULL, from_status TEXT,
        to_status TEXT NOT NULL, recorded_at TEXT NOT NULL
      );
      CREATE TABLE creative_manifests (
        venture_id TEXT NOT NULL, creative_id TEXT NOT NULL, manifest_version INTEGER NOT NULL,
        review_event_id TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL, PRIMARY KEY (venture_id, creative_id, manifest_version)
      );
    `);
    raw
      .prepare(`INSERT INTO creative_variants VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        legacyVariant.creativeId,
        "legacy-venture",
        "legacy-registration",
        legacyBinding,
        legacyVariant.contentFingerprint,
        legacyVariant.contentFingerprintVersion,
        null,
        null,
        JSON.stringify(legacyVariant),
        legacyVariant.createdAt,
      );
    const legacyStatus = {
      tiktok_organic: "ORGANIC_PUBLISHED",
      tiktok_paid: "PAID_TEST_RUNNING",
      meta_paid: "SCALE_ELIGIBLE",
    } as const;
    for (const network of ["tiktok_organic", "tiktok_paid", "meta_paid"] as const) {
      raw
        .prepare("INSERT INTO creative_status_current VALUES (?,?,?,?,?)")
        .run(
          "legacy-venture",
          legacyVariant.creativeId,
          network,
          legacyStatus[network],
          legacyVariant.createdAt,
        );
      raw
        .prepare(
          `INSERT INTO creative_status_history
           (venture_id, creative_id, network, from_status, to_status, recorded_at)
           VALUES (?,?,?,NULL,?,?)`,
        )
        .run(
          "legacy-venture",
          legacyVariant.creativeId,
          network,
          legacyStatus[network],
          legacyVariant.createdAt,
        );
    }
    raw
      .prepare("INSERT INTO creative_manifests VALUES (?,?,?,?,?,?)")
      .run(
        "legacy-venture",
        legacyVariant.creativeId,
        1,
        legacyManifest.reviewEventId,
        JSON.stringify(legacyManifest),
        legacyManifest.reviewedAt,
      );
    raw.close();

    const sentinelScope = {
      organizationId: "__legacy_unscoped__",
      ventureId: "legacy-venture",
    };
    expect(() => createSqliteCreativeLedgerStore(filename)).toThrowError(
      expect.objectContaining({ code: "legacy_tenant_mapping_required" }) as never,
    );
    expect(() => createSqliteCreativeManifestStore(filename)).toThrowError(
      expect.objectContaining({ code: "legacy_tenant_mapping_required" }) as never,
    );
    const unchanged = new DatabaseSync(filename);
    expect(
      unchanged
        .prepare("PRAGMA table_info(creative_variants)")
        .all()
        .some((column) => (column as { name: string }).name === "organization_id"),
    ).toBe(false);
    expect(
      unchanged
        .prepare("PRAGMA table_info(creative_manifests)")
        .all()
        .some((column) => (column as { name: string }).name === "organization_id"),
    ).toBe(false);
    unchanged.close();

    const adoptedScope = {
      organizationId: "org-adopted",
      ventureId: "adopted-venture",
    };
    const legacyAdoption = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: FIRST_NOW.toISOString(),
      mappings: [
        {
          legacyVentureId: "legacy-venture",
          ...adoptedScope,
        },
      ],
    });
    const ledgerStore = createSqliteCreativeLedgerStore(filename, { legacyAdoption });
    const manifestStore = createSqliteCreativeManifestStore(filename, { legacyAdoption });
    expect(ledgerStore.getVariant(adoptedScope, legacyVariant.creativeId)?.media.hook).toBe(
      "Legacy unscoped material",
    );
    expect(
      ledgerStore.getVariant(
        { organizationId: ORGANIZATION_ID, ventureId: "legacy-venture" },
        legacyVariant.creativeId,
      ),
    ).toBeUndefined();
    expect(ledgerStore.getStatus(adoptedScope, legacyVariant.creativeId, "tiktok_organic")).toBe(
      "READY_FOR_ORGANIC_REVIEW",
    );
    expect(ledgerStore.getStatus(adoptedScope, legacyVariant.creativeId, "tiktok_paid")).toBe(
      "PAID_TEST_PROPOSED",
    );
    expect(ledgerStore.getStatus(adoptedScope, legacyVariant.creativeId, "meta_paid")).toBe(
      "PAID_TEST_PROPOSED",
    );
    expect(
      ledgerStore
        .listStatusHistory(adoptedScope, legacyVariant.creativeId)
        .filter((entry) => entry.reasonCode === "legacy_tenant_adoption_invalidation"),
    ).toHaveLength(3);
    const invalidatedManifest = manifestStore.getCurrent(adoptedScope, legacyVariant.creativeId)!;
    expect(invalidatedManifest).toMatchObject({
      organizationId: adoptedScope.organizationId,
      ventureId: adoptedScope.ventureId,
      manifestVersion: 2,
      organicApproved: false,
      paidApproved: false,
      authorizationInvalidatedAt: FIRST_NOW.toISOString(),
      authorizationInvalidationReason: "legacy_tenant_adoption_invalidation",
    });
    expect(invalidatedManifest.mediaLicenses[0]).toMatchObject({
      permitsOrganic: false,
      permitsPaid: false,
      permittedRegions: [],
      permittedChannels: [],
      revokedAt: FIRST_NOW.toISOString(),
    });
    for (const request of [
      { mode: "organic", channel: "tiktok_organic" },
      { mode: "paid", channel: "tiktok_paid" },
    ] as const) {
      expect(
        assessCreativeCompliance(invalidatedManifest, {
          ...request,
          region: "NL",
          at: SECOND_NOW,
        }),
      ).toMatchObject({
        allowed: false,
        blockers: expect.arrayContaining(["manifest_authorization_invalidated"]),
      });
    }
    expect(manifestStore.listHistory(adoptedScope, legacyVariant.creativeId)).toHaveLength(2);
    expect(() => ledgerStore.getVariant(sentinelScope, legacyVariant.creativeId)).toThrowError(
      expect.objectContaining({ code: "legacy_sentinel_scope_forbidden" }) as never,
    );
    expect(() => manifestStore.getCurrent(sentinelScope, legacyVariant.creativeId)).toThrowError(
      expect.objectContaining({ code: "legacy_sentinel_scope_forbidden" }) as never,
    );
    const reapproved = manifestStore.put({
      ...approvedManifest(
        adoptedScope.ventureId,
        legacyVariant.creativeId,
        legacyVariant.creativeFamilyId,
        adoptedScope.organizationId,
      ),
      reviewEventId: "rights-reapproval:legacy-creative",
      reviewedAt: SECOND_NOW.toISOString(),
    });
    expect(reapproved).toMatchObject({
      manifestVersion: 3,
      organicApproved: true,
      paidApproved: true,
      authorizationInvalidatedAt: null,
    });
    ledgerStore.close();
    manifestStore.close();

    const adoptedRaw = new DatabaseSync(filename);
    const adoptedRegistration = adoptedRaw
      .prepare(
        `SELECT registration_key, registration_binding FROM creative_variants
         WHERE organization_id = ? AND venture_id = ? AND creative_id = ?`,
      )
      .get(adoptedScope.organizationId, adoptedScope.ventureId, legacyVariant.creativeId) as {
      registration_key: string;
      registration_binding: string;
    };
    expect(JSON.parse(adoptedRegistration.registration_binding)).toMatchObject({
      organizationId: adoptedScope.organizationId,
      ventureId: adoptedScope.ventureId,
      nestedIdentity: { venture_id: adoptedScope.ventureId },
    });
    expect(adoptedRegistration.registration_key).toBe(
      createHash("sha256").update(adoptedRegistration.registration_binding).digest("hex"),
    );
    expect(
      adoptedRaw
        .prepare(
          `SELECT COUNT(*) AS count FROM creative_variants
           WHERE organization_id = '__legacy_unscoped__'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    adoptedRaw.close();

    const reopenedLedger = track(createSqliteCreativeLedgerStore(filename));
    const reopenedManifests = track(createSqliteCreativeManifestStore(filename));
    expect(reopenedLedger.getVariant(adoptedScope, legacyVariant.creativeId)).toBeDefined();
    expect(reopenedManifests.getCurrent(adoptedScope, legacyVariant.creativeId)).toBeDefined();
  });

  it("adopts pre-existing sentinel creative rows once and never exposes the sentinel", () => {
    const filename = temporaryDatabase();
    createSqliteCreativeLedgerStore(filename).close();
    createSqliteCreativeManifestStore(filename).close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          get(...params: unknown[]): unknown;
          run(...params: unknown[]): unknown;
        };
        close(): void;
      };
    };
    const raw = new DatabaseSync(filename);
    const legacyVariant = {
      creativeId: "sentinel-creative",
      hypothesisId: "sentinel-hypothesis",
      creativeFamilyId: "sentinel-family",
      derivedFromCreativeId: null,
      platformVariantOfCreativeId: null,
      contentFingerprint: "b".repeat(64),
      contentFingerprintVersion: "v2",
      media: media({ hook: "Sentinel material" }),
      assetContentHash: "sha256:sentinel",
      destinationIsTestedHypothesis: false,
      createdAt: FIRST_NOW.toISOString(),
    };
    const binding = JSON.stringify({
      ventureId: "legacy-sentinel",
      hypothesisId: legacyVariant.hypothesisId,
      creativeFamilyId: legacyVariant.creativeFamilyId,
    });
    raw
      .prepare(
        `INSERT INTO creative_variants (
          organization_id, venture_id, creative_id, registration_key, registration_binding,
          content_fingerprint, content_fingerprint_version, derived_from_creative_id,
          platform_variant_of_creative_id, variant_json, created_at
        ) VALUES ('__legacy_unscoped__',?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "legacy-sentinel",
        legacyVariant.creativeId,
        createHash("sha256").update(binding).digest("hex"),
        binding,
        legacyVariant.contentFingerprint,
        legacyVariant.contentFingerprintVersion,
        null,
        null,
        JSON.stringify(legacyVariant),
        legacyVariant.createdAt,
      );
    raw
      .prepare(
        `INSERT INTO creative_status_current
         VALUES ('__legacy_unscoped__', ?, ?, 'tiktok_organic', 'ORGANIC_PUBLISHED', ?)`,
      )
      .run("legacy-sentinel", legacyVariant.creativeId, legacyVariant.createdAt);
    raw
      .prepare(
        `INSERT INTO creative_status_history
         (organization_id, venture_id, creative_id, network, from_status, to_status, recorded_at)
         VALUES ('__legacy_unscoped__', ?, ?, 'tiktok_organic', NULL, 'ORGANIC_PUBLISHED', ?)`,
      )
      .run("legacy-sentinel", legacyVariant.creativeId, legacyVariant.createdAt);
    const manifest = {
      ...approvedManifest(
        "legacy-sentinel",
        legacyVariant.creativeId,
        legacyVariant.creativeFamilyId,
        "__legacy_unscoped__",
      ),
      manifestVersion: 1,
      revokedAt: null,
      revocationReason: null,
    };
    raw
      .prepare(
        `INSERT INTO creative_manifests
         (organization_id, venture_id, creative_id, manifest_version, review_event_id,
          manifest_json, recorded_at)
         VALUES ('__legacy_unscoped__',?,?,?,?,?,?)`,
      )
      .run(
        "legacy-sentinel",
        legacyVariant.creativeId,
        1,
        manifest.reviewEventId,
        JSON.stringify(manifest),
        manifest.reviewedAt,
      );
    raw.close();

    expect(() => createSqliteCreativeLedgerStore(filename)).toThrowError(
      expect.objectContaining({ code: "legacy_tenant_mapping_required" }) as never,
    );
    expect(() => createSqliteCreativeManifestStore(filename)).toThrowError(
      expect.objectContaining({ code: "legacy_tenant_mapping_required" }) as never,
    );
    const adoptedScope = { organizationId: "org-sentinel", ventureId: "venture-adopted" };
    const legacyAdoption = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: FIRST_NOW.toISOString(),
      mappings: [{ legacyVentureId: "legacy-sentinel", ...adoptedScope }],
    });
    const adoptedLedger = createSqliteCreativeLedgerStore(filename, { legacyAdoption });
    const adoptedManifests = createSqliteCreativeManifestStore(filename, { legacyAdoption });
    expect(adoptedLedger.getVariant(adoptedScope, legacyVariant.creativeId)?.media.hook).toBe(
      "Sentinel material",
    );
    expect(adoptedLedger.getStatus(adoptedScope, legacyVariant.creativeId, "tiktok_organic")).toBe(
      "READY_FOR_ORGANIC_REVIEW",
    );
    expect(adoptedLedger.listStatusHistory(adoptedScope, legacyVariant.creativeId)).toMatchObject([
      { toStatus: "ORGANIC_PUBLISHED", reasonCode: null },
      {
        fromStatus: "ORGANIC_PUBLISHED",
        toStatus: "READY_FOR_ORGANIC_REVIEW",
        reasonCode: "legacy_tenant_adoption_invalidation",
      },
    ]);
    const sentinelManifest = adoptedManifests.getCurrent(adoptedScope, legacyVariant.creativeId)!;
    expect(sentinelManifest).toMatchObject({
      ...adoptedScope,
      organicApproved: false,
      paidApproved: false,
      authorizationInvalidationReason: "legacy_tenant_adoption_invalidation",
    });
    expect(
      assessCreativeCompliance(sentinelManifest, {
        mode: "organic",
        channel: "tiktok_organic",
        region: "NL",
        at: SECOND_NOW,
      }),
    ).toMatchObject({
      allowed: false,
      blockers: expect.arrayContaining(["manifest_authorization_invalidated"]),
    });
    expect(() =>
      adoptedLedger.getVariant(
        { organizationId: "__legacy_unscoped__", ventureId: "legacy-sentinel" },
        legacyVariant.creativeId,
      ),
    ).toThrowError(expect.objectContaining({ code: "legacy_sentinel_scope_forbidden" }) as never);
    adoptedLedger.close();
    adoptedManifests.close();

    const restartedLedger = track(createSqliteCreativeLedgerStore(filename));
    const restartedManifests = track(createSqliteCreativeManifestStore(filename));
    expect(restartedLedger.getVariant(adoptedScope, legacyVariant.creativeId)).toBeDefined();
    expect(restartedManifests.getCurrent(adoptedScope, legacyVariant.creativeId)).toBeDefined();
    const inspected = track(new DatabaseSync(filename));
    expect(
      inspected
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM creative_variants
              WHERE organization_id = '__legacy_unscoped__') +
             (SELECT COUNT(*) FROM creative_manifests
              WHERE organization_id = '__legacy_unscoped__') AS count`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it.each(CREDENTIAL_IDENTITY_CASES)(
    "rejects credential-like %s material without mutating raw creative or evidence rows",
    (_label, field, credential) => {
      const filename = temporaryDatabase();
      createSqliteCreativeLedgerStore(filename).close();
      createSqliteWinnerLoopEvidenceStore(filename).close();
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (path: string) => {
          prepare(sql: string): {
            all(...params: unknown[]): unknown[];
            get(...params: unknown[]): unknown;
            run(...params: unknown[]): unknown;
          };
          close(): void;
        };
      };
      const raw = new DatabaseSync(filename);
      const legacyVentureId = "legacy-credential-boundary";
      const creativeId = "credential-boundary-creative";
      const variant = {
        creativeId,
        hypothesisId: "credential-boundary-hypothesis",
        creativeFamilyId: "credential-boundary-family",
        derivedFromCreativeId: null,
        platformVariantOfCreativeId: null,
        contentFingerprint: "d".repeat(64),
        contentFingerprintVersion: "v2",
        media: media({ hook: "Credential boundary material" }),
        assetContentHash: "sha256:credential-boundary",
        destinationIsTestedHypothesis: false,
        createdAt: FIRST_NOW.toISOString(),
      };
      const registrationBinding = JSON.stringify({
        ventureId: legacyVentureId,
        hypothesisId: variant.hypothesisId,
        creativeFamilyId: variant.creativeFamilyId,
      });
      raw
        .prepare(
          `INSERT INTO creative_variants (
            organization_id, venture_id, creative_id, registration_key, registration_binding,
            content_fingerprint, content_fingerprint_version, derived_from_creative_id,
            platform_variant_of_creative_id, variant_json, created_at
          ) VALUES ('__legacy_unscoped__',?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          legacyVentureId,
          creativeId,
          createHash("sha256").update(registrationBinding).digest("hex"),
          registrationBinding,
          variant.contentFingerprint,
          variant.contentFingerprintVersion,
          null,
          null,
          JSON.stringify(variant),
          variant.createdAt,
        );
      const evidencePayload = JSON.stringify({ ventureId: legacyVentureId, result: "historical" });
      raw
        .prepare(
          `INSERT INTO winner_loop_evidence (
            organization_id, venture_id, kind, record_id, creative_id, occurred_at,
            source_refs_json, payload_json, content_hash
          ) VALUES ('__legacy_unscoped__',?,?,?,?,?,?,?,?)`,
        )
        .run(
          legacyVentureId,
          "winner_evaluation",
          "credential-boundary-evidence",
          creativeId,
          FIRST_NOW.toISOString(),
          JSON.stringify(["legacy://credential-boundary"]),
          evidencePayload,
          createHash("sha256").update(evidencePayload).digest("hex"),
        );
      raw.close();

      const snapshot = () => {
        const database = new DatabaseSync(filename);
        const result = {
          creative: database
            .prepare(
              "SELECT organization_id, venture_id, creative_id, variant_json FROM creative_variants",
            )
            .all(),
          evidence: database
            .prepare(
              "SELECT organization_id, venture_id, kind, record_id, payload_json FROM winner_loop_evidence",
            )
            .all(),
          journal: database
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'legacy_tenant_adoptions'",
            )
            .get(),
        };
        database.close();
        return result;
      };
      const before = snapshot();
      const options = forgedCredentialAdoption(field, credential);
      for (const open of [createSqliteCreativeLedgerStore, createSqliteWinnerLoopEvidenceStore]) {
        let failure: unknown;
        try {
          open(filename, options);
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: "invalid_legacy_tenant_mapping" });
        expect((failure as Error).message).toMatch(/credential-like material/i);
        expect((failure as Error).message).not.toContain(credential);
        expect(snapshot()).toEqual(before);
      }
    },
  );

  it.each(CREDENTIAL_IDENTITY_CASES)(
    "rejects credential-like %s material parsed from the durable adoption journal",
    (_label, field, credential) => {
      const filename = temporaryDatabase();
      createSqliteWinnerLoopEvidenceStore(filename).close();
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (path: string) => {
          exec(sql: string): void;
          prepare(sql: string): {
            all(...params: unknown[]): unknown[];
            get(...params: unknown[]): unknown;
            run(...params: unknown[]): unknown;
          };
          close(): void;
        };
      };
      const legacyVentureId = "legacy-journal-identity";
      const raw = new DatabaseSync(filename);
      const payload = JSON.stringify({ ventureId: legacyVentureId, result: "historical" });
      raw
        .prepare(
          `INSERT INTO winner_loop_evidence (
            organization_id, venture_id, kind, record_id, creative_id, occurred_at,
            source_refs_json, payload_json, content_hash
          ) VALUES ('__legacy_unscoped__',?,?,?,?,?,?,?,?)`,
        )
        .run(
          legacyVentureId,
          "winner_evaluation",
          "journal-identity-evidence",
          null,
          FIRST_NOW.toISOString(),
          JSON.stringify(["legacy://journal-identity"]),
          payload,
          createHash("sha256").update(payload).digest("hex"),
        );
      raw.close();
      const exactAdoption = createTrustedLegacyTenantAdoptionMapping({
        ownershipVerification: "verified_out_of_band",
        authorizationDisposition: "invalidate_and_require_reapproval",
        approvedBy: "migration-operator",
        approvedAt: FIRST_NOW.toISOString(),
        mappings: [
          {
            legacyVentureId,
            organizationId: "org-journal-identity",
            ventureId: "venture-journal-identity",
          },
        ],
      });
      createSqliteWinnerLoopEvidenceStore(filename, { legacyAdoption: exactAdoption }).close();

      const tampered = new DatabaseSync(filename);
      tampered.exec("DROP TRIGGER legacy_tenant_adoptions_immutable");
      const journal = tampered
        .prepare("SELECT approval_json, mapping_json FROM legacy_tenant_adoptions")
        .get() as { approval_json: string; mapping_json: string };
      if (field === "approvedBy") {
        const approval = JSON.parse(journal.approval_json) as Record<string, unknown>;
        tampered
          .prepare("UPDATE legacy_tenant_adoptions SET approval_json = ?")
          .run(JSON.stringify({ ...approval, approvedBy: credential }));
      } else {
        const mapping = JSON.parse(journal.mapping_json) as {
          approvalHash: string;
          mappings: Record<string, unknown>[];
        };
        const journalField = {
          legacyVentureId: "legacyVentureId",
          organizationId: "targetOrganizationId",
          ventureId: "targetVentureId",
        }[field];
        tampered.prepare("UPDATE legacy_tenant_adoptions SET mapping_json = ?").run(
          JSON.stringify({
            ...mapping,
            mappings: [{ ...mapping.mappings[0], [journalField]: credential }],
          }),
        );
      }
      const before = tampered.prepare("SELECT * FROM legacy_tenant_adoptions").get();
      tampered.close();

      let failure: unknown;
      try {
        createSqliteWinnerLoopEvidenceStore(filename, { legacyAdoption: exactAdoption });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "legacy_tenant_adoption_journal_invalid" });
      expect((failure as Error).message).toMatch(/credential-like identity material/i);
      expect((failure as Error).message).not.toContain(credential);
      const readback = new DatabaseSync(filename);
      expect(readback.prepare("SELECT * FROM legacy_tenant_adoptions").get()).toEqual(before);
      expect(readback.prepare("SELECT COUNT(*) AS count FROM winner_loop_evidence").get()).toEqual({
        count: 1,
      });
      readback.close();
    },
  );

  it("binds creative, manifest, and evidence adoption to one durable authority across restarts", () => {
    const filename = temporaryDatabase();
    createSqliteCreativeLedgerStore(filename).close();
    createSqliteCreativeManifestStore(filename).close();
    createSqliteWinnerLoopEvidenceStore(filename).close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          all(...params: unknown[]): unknown[];
          get(...params: unknown[]): unknown;
          run(...params: unknown[]): unknown;
        };
        close(): void;
      };
    };
    const raw = new DatabaseSync(filename);
    const legacyVentureId = "legacy-shared-authority";
    const creativeId = "shared-authority-creative";
    const variant = {
      creativeId,
      hypothesisId: "shared-authority-hypothesis",
      creativeFamilyId: "shared-authority-family",
      derivedFromCreativeId: null,
      platformVariantOfCreativeId: null,
      contentFingerprint: "c".repeat(64),
      contentFingerprintVersion: "v2",
      media: media({ hook: "Shared authority material" }),
      assetContentHash: "sha256:shared-authority",
      destinationIsTestedHypothesis: false,
      createdAt: FIRST_NOW.toISOString(),
    };
    const binding = JSON.stringify({
      ventureId: legacyVentureId,
      hypothesisId: variant.hypothesisId,
      creativeFamilyId: variant.creativeFamilyId,
    });
    raw
      .prepare(
        `INSERT INTO creative_variants (
          organization_id, venture_id, creative_id, registration_key, registration_binding,
          content_fingerprint, content_fingerprint_version, derived_from_creative_id,
          platform_variant_of_creative_id, variant_json, created_at
        ) VALUES ('__legacy_unscoped__',?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        legacyVentureId,
        creativeId,
        createHash("sha256").update(binding).digest("hex"),
        binding,
        variant.contentFingerprint,
        variant.contentFingerprintVersion,
        null,
        null,
        JSON.stringify(variant),
        variant.createdAt,
      );
    raw
      .prepare(
        `INSERT INTO creative_status_current
         VALUES ('__legacy_unscoped__', ?, ?, 'tiktok_paid', 'PAID_TEST_RUNNING', ?)`,
      )
      .run(legacyVentureId, creativeId, variant.createdAt);
    raw
      .prepare(
        `INSERT INTO creative_status_history (
          organization_id, venture_id, creative_id, network, from_status, to_status, recorded_at
        ) VALUES ('__legacy_unscoped__', ?, ?, 'tiktok_paid', NULL, 'PAID_TEST_RUNNING', ?)`,
      )
      .run(legacyVentureId, creativeId, variant.createdAt);
    const manifest = {
      ...approvedManifest(
        legacyVentureId,
        creativeId,
        variant.creativeFamilyId,
        "__legacy_unscoped__",
      ),
      manifestVersion: 1,
      revokedAt: null,
      revocationReason: null,
    };
    raw
      .prepare(
        `INSERT INTO creative_manifests (
          organization_id, venture_id, creative_id, manifest_version, review_event_id,
          manifest_json, recorded_at
        ) VALUES ('__legacy_unscoped__',?,?,?,?,?,?)`,
      )
      .run(
        legacyVentureId,
        creativeId,
        1,
        manifest.reviewEventId,
        JSON.stringify(manifest),
        manifest.reviewedAt,
      );
    const evidencePayload = JSON.stringify({ ventureId: legacyVentureId, result: "historical" });
    raw
      .prepare(
        `INSERT INTO winner_loop_evidence (
          organization_id, venture_id, kind, record_id, creative_id, occurred_at,
          source_refs_json, payload_json, content_hash
        ) VALUES ('__legacy_unscoped__',?,?,?,?,?,?,?,?)`,
      )
      .run(
        legacyVentureId,
        "winner_evaluation",
        "legacy-evaluation",
        creativeId,
        FIRST_NOW.toISOString(),
        JSON.stringify(["legacy://evaluation"]),
        evidencePayload,
        createHash("sha256").update(evidencePayload).digest("hex"),
      );
    raw.close();

    const adoptedScope = { organizationId: "org-shared", ventureId: "venture-shared" };
    const exactAdoption = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: FIRST_NOW.toISOString(),
      mappings: [{ legacyVentureId, ...adoptedScope }],
    });
    const conflictingTarget = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: FIRST_NOW.toISOString(),
      mappings: [
        {
          legacyVentureId,
          organizationId: "org-conflict",
          ventureId: "venture-conflict",
        },
      ],
    });
    const conflictingApproval = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "different-migration-operator",
      approvedAt: SECOND_NOW.toISOString(),
      mappings: [{ legacyVentureId, ...adoptedScope }],
    });
    const conflictingSource = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: FIRST_NOW.toISOString(),
      mappings: [{ legacyVentureId: "different-legacy-source", ...adoptedScope }],
    });

    const adoptedLedger = track(
      createSqliteCreativeLedgerStore(filename, { legacyAdoption: exactAdoption }),
    );
    expect(adoptedLedger.getStatus(adoptedScope, creativeId, "tiktok_paid")).toBe(
      "PAID_TEST_PROPOSED",
    );
    expect(() =>
      createSqliteCreativeManifestStore(filename, { legacyAdoption: conflictingTarget }),
    ).toThrowError(expect.objectContaining({ code: "legacy_tenant_mapping_conflict" }) as never);
    expect(() =>
      createSqliteWinnerLoopEvidenceStore(filename, { legacyAdoption: conflictingApproval }),
    ).toThrowError(expect.objectContaining({ code: "legacy_tenant_mapping_conflict" }) as never);

    const afterConflicts = new DatabaseSync(filename);
    expect(
      afterConflicts
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM creative_manifests
              WHERE organization_id = '__legacy_unscoped__') AS manifests,
             (SELECT COUNT(*) FROM winner_loop_evidence
              WHERE organization_id = '__legacy_unscoped__') AS evidence`,
        )
        .get(),
    ).toEqual({ manifests: 1, evidence: 1 });
    expect(
      afterConflicts
        .prepare(
          `SELECT target_organization_id, target_venture_id
           FROM legacy_tenant_adoptions WHERE legacy_venture_id = ?`,
        )
        .get(legacyVentureId),
    ).toEqual({
      target_organization_id: adoptedScope.organizationId,
      target_venture_id: adoptedScope.ventureId,
    });
    expect(() =>
      afterConflicts
        .prepare(
          `UPDATE legacy_tenant_adoptions SET target_organization_id = 'org-tampered'
           WHERE legacy_venture_id = ?`,
        )
        .run(legacyVentureId),
    ).toThrow(/immutable/);
    expect(() =>
      afterConflicts
        .prepare("DELETE FROM legacy_tenant_adoptions WHERE legacy_venture_id = ?")
        .run(legacyVentureId),
    ).toThrow(/permanent/);
    afterConflicts.close();

    const adoptedManifests = track(
      createSqliteCreativeManifestStore(filename, { legacyAdoption: exactAdoption }),
    );
    const adoptedEvidence = track(
      createSqliteWinnerLoopEvidenceStore(filename, { legacyAdoption: exactAdoption }),
    );
    expect(adoptedManifests.getCurrent(adoptedScope, creativeId)).toMatchObject({
      organicApproved: false,
      paidApproved: false,
      authorizationInvalidationReason: "legacy_tenant_adoption_invalidation",
    });
    expect(
      adoptedEvidence.get(adoptedScope, "winner_evaluation", "legacy-evaluation"),
    ).toMatchObject(adoptedScope);
    close(adoptedLedger);
    close(adoptedManifests);
    close(adoptedEvidence);

    expect(() =>
      createSqliteCreativeLedgerStore(filename, { legacyAdoption: conflictingTarget }),
    ).toThrowError(expect.objectContaining({ code: "legacy_tenant_mapping_conflict" }) as never);
    expect(() =>
      createSqliteCreativeManifestStore(filename, { legacyAdoption: conflictingSource }),
    ).toThrowError(expect.objectContaining({ code: "legacy_tenant_mapping_conflict" }) as never);
    const restartedLedger = track(
      createSqliteCreativeLedgerStore(filename, { legacyAdoption: exactAdoption }),
    );
    const restartedManifests = track(
      createSqliteCreativeManifestStore(filename, { legacyAdoption: exactAdoption }),
    );
    const restartedEvidence = track(
      createSqliteWinnerLoopEvidenceStore(filename, { legacyAdoption: exactAdoption }),
    );
    expect(restartedLedger.getVariant(adoptedScope, creativeId)).toBeDefined();
    expect(restartedManifests.listHistory(adoptedScope, creativeId)).toHaveLength(2);
    expect(
      restartedEvidence.get(adoptedScope, "winner_evaluation", "legacy-evaluation"),
    ).toBeDefined();
  });

  it("rolls back the adoption journal when manifest materialization cannot commit", () => {
    const filename = temporaryDatabase();
    createSqliteCreativeManifestStore(filename).close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): {
          all(...params: unknown[]): unknown[];
          get(...params: unknown[]): unknown;
          run(...params: unknown[]): unknown;
        };
        close(): void;
      };
    };
    const raw = new DatabaseSync(filename);
    const creativeId = "colliding-manifest";
    const targetScope = { organizationId: "org-collision", ventureId: "venture-collision" };
    const targetManifest = {
      ...approvedManifest(
        targetScope.ventureId,
        creativeId,
        "collision-family",
        targetScope.organizationId,
      ),
      manifestVersion: 1,
      revokedAt: null,
      revocationReason: null,
    };
    const sentinelManifest = {
      ...approvedManifest(
        "legacy-collision",
        creativeId,
        "collision-family",
        "__legacy_unscoped__",
      ),
      reviewEventId: "legacy-collision-review",
      manifestVersion: 1,
      revokedAt: null,
      revocationReason: null,
    };
    const insert = raw.prepare(
      `INSERT INTO creative_manifests (
        organization_id, venture_id, creative_id, manifest_version, review_event_id,
        manifest_json, recorded_at
      ) VALUES (?,?,?,?,?,?,?)`,
    );
    insert.run(
      targetScope.organizationId,
      targetScope.ventureId,
      creativeId,
      1,
      targetManifest.reviewEventId,
      JSON.stringify(targetManifest),
      targetManifest.reviewedAt,
    );
    insert.run(
      "__legacy_unscoped__",
      "legacy-collision",
      creativeId,
      1,
      sentinelManifest.reviewEventId,
      JSON.stringify(sentinelManifest),
      sentinelManifest.reviewedAt,
    );
    raw.close();
    const legacyAdoption = createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "migration-operator",
      approvedAt: FIRST_NOW.toISOString(),
      mappings: [{ legacyVentureId: "legacy-collision", ...targetScope }],
    });

    expect(() => createSqliteCreativeManifestStore(filename, { legacyAdoption })).toThrow(
      /unique|constraint/i,
    );

    const inspected = track(new DatabaseSync(filename));
    expect(
      inspected
        .prepare(
          `SELECT COUNT(*) AS count FROM creative_manifests
           WHERE organization_id = '__legacy_unscoped__'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      inspected
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'legacy_tenant_adoptions'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("applies reversible migration constraints that keep identities and history immutable", () => {
    const filename = temporaryDatabase();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          all(...params: unknown[]): unknown[];
          run(...params: unknown[]): unknown;
        };
        close(): void;
      };
    };
    const database = track(new DatabaseSync(filename));
    database.exec(
      readFileSync("migrations/winner-loop/003_creative_identity_ledger.up.sql", "utf8"),
    );
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'creative_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((entry) => entry.name)).toEqual([
      "creative_delivery_variants",
      "creative_provider_objects",
      "creative_status_current",
      "creative_status_history",
      "creative_variants",
    ]);
    for (const table of ["creative_variants", "creative_delivery_variants"] as const) {
      const identityColumn = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .find((column) =>
          table === "creative_variants"
            ? (column as { name: string }).name === "creative_id"
            : (column as { name: string }).name === "delivery_variant_id",
        ) as { notnull: number; pk: number } | undefined;
      expect(identityColumn?.notnull).toBe(1);
      expect(identityColumn?.pk).toBeGreaterThan(0);
    }
    close(database);

    const store = track(createSqliteCreativeLedgerStore(filename));
    const manifests = track(createSqliteCreativeManifestStore(filename));
    const ledger = createCreativeLedger(
      ledgerOptions("payout-rank", store, manifests, FIRST_NOW, 31),
    );
    const creative = ledger.registerVariant({
      organizationId: ledger.organizationId,
      ventureId: ledger.ventureId,
      hypothesisId: "hyp-migration",
      creativeFamilyId: "fam-migration",
      media: media(),
      assetContentHash: "sha256:migration",
      fingerprintVersion: "v1",
    });
    const shipped = ledger.registerDeliveryVariant(creative.creativeId, delivery());
    ledger.mapProviderObject({
      organizationId: ledger.organizationId,
      ventureId: ledger.ventureId,
      creativeId: creative.creativeId,
      deliveryVariantId: shipped.deliveryVariantId,
      provider: "tiktok_content",
      objectKind: "organic_post",
      externalId: "post-migration",
      externalAccountId: "account-migration",
    });
    close(store);
    close(manifests);

    const constrained = track(new DatabaseSync(filename));
    expect(() =>
      constrained
        .prepare(
          "UPDATE creative_variants SET content_fingerprint_version = 'v2' WHERE creative_id = ?",
        )
        .run(creative.creativeId),
    ).toThrow(/immutable/);
    expect(() =>
      constrained
        .prepare("UPDATE creative_provider_objects SET creative_id = 'moved' WHERE external_id = ?")
        .run("post-migration"),
    ).toThrow(/immutable/);
    expect(() =>
      constrained
        .prepare(
          `INSERT OR REPLACE INTO creative_provider_objects
           (organization_id, venture_id, provider, object_kind, external_id, creative_id,
            delivery_variant_id, external_account_id, record_json, recorded_at)
           SELECT organization_id, venture_id, provider, object_kind, external_id, creative_id,
                  delivery_variant_id, 'replacement-account', record_json, recorded_at
           FROM creative_provider_objects WHERE external_id = ?`,
        )
        .run("post-migration"),
    ).toThrow(/immutable|permanent/);
    expect(() =>
      constrained
        .prepare("DELETE FROM creative_status_history WHERE creative_id = ?")
        .run(creative.creativeId),
    ).toThrow(/permanent/);
    expect(() =>
      constrained
        .prepare("DELETE FROM creative_variants WHERE creative_id = ?")
        .run(creative.creativeId),
    ).toThrow(/permanent/);

    constrained.exec(
      readFileSync("migrations/winner-loop/003_creative_identity_ledger.down.sql", "utf8"),
    );
    const remaining = constrained
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'creative_%'`,
      )
      .all();
    // The creative manifest table belongs to migration 001 and must survive a
    // rollback of migration 003; only the five identity-ledger tables go away.
    expect(remaining).toEqual([{ name: "creative_manifests" }]);
  });
});
