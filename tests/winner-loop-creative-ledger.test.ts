import { describe, expect, it } from "vitest";
import {
  CreativeLedgerError,
  ULID_PATTERN,
  computeContentFingerprint,
  createCreativeLedger,
  type CreativeDeliveryDimensions,
  type CreativeLedger,
  type CreativeMediaDimensions,
  type CreativeNetwork,
  type CreativeStatus,
} from "@/lib/winner-loop";

const NOW = new Date("2026-08-08T09:00:00.000Z");

const TO_ORGANIC_PUBLISHED: readonly CreativeStatus[] = [
  "READY_FOR_PRODUCTION",
  "RENDERING",
  "ASSET_READY",
  "READY_FOR_ORGANIC_REVIEW",
  "ORGANIC_PUBLISHED",
];
const TO_PAID_RUNNING: readonly CreativeStatus[] = [
  "PAID_TEST_PROPOSED",
  "PAID_TEST_APPROVED",
  "PAID_TEST_RUNNING",
];

function media(overrides: Partial<CreativeMediaDimensions> = {}): CreativeMediaDimensions {
  return {
    hook: "You are losing payouts you already earned",
    openingFrame: "close_up_face",
    format: "talking_head_with_screen_recording",
    speaker: "founder",
    visualSequence: "face_then_dashboard",
    audioTrack: "voice_only",
    onScreenProof: "dashboard_recording",
    embeddedCta: "Check your rank free",
    durationSeconds: 22,
    aspectRatio: "9:16",
    ...overrides,
  };
}

function delivery(overrides: Partial<CreativeDeliveryDimensions> = {}): CreativeDeliveryDimensions {
  return {
    caption: "Most affiliates never check this.",
    adCopy: "",
    destinationUrl: "https://payoutrank.example/scan",
    privacy: "public",
    platformSettings: {},
    ...overrides,
  };
}

let entropy = 0;
function ledger(ventureId = "payout-rank"): CreativeLedger {
  entropy += 1;
  const seed = entropy;
  return createCreativeLedger({
    ventureId,
    now: () => NOW,
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, i) => (i + seed * 7) % 256),
  });
}

function register(book: CreativeLedger, overrides: Partial<CreativeMediaDimensions> = {}) {
  return book.registerVariant({
    ventureId: book.ventureId,
    hypothesisId: "hyp-001",
    creativeFamilyId: "fam-001",
    media: media(overrides),
    assetContentHash: "sha256:abc",
  });
}

function advance(
  book: CreativeLedger,
  creativeId: string,
  network: CreativeNetwork,
  path: readonly CreativeStatus[],
): void {
  for (const status of path) book.recordStatus(creativeId, network, status);
}

describe("creative identity is opaque and permanent", () => {
  it("mints a sortable opaque id that is not derived from the fingerprint", () => {
    const book = ledger();
    const variant = register(book);

    expect(variant.creativeId).toMatch(ULID_PATTERN);
    expect(variant.creativeId).not.toContain(variant.contentFingerprint.slice(0, 16));
    expect(variant.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(variant.contentFingerprintVersion).toBe("v2");
  });

  it("keeps existing creative ids stable when the fingerprint algorithm changes", () => {
    const book = ledger();
    const variant = book.registerVariant({
      ventureId: book.ventureId,
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      media: media(),
      assetContentHash: "sha256:abc",
      fingerprintVersion: "v1",
    });
    const originalId = variant.creativeId;
    const originalFingerprint = variant.contentFingerprint;

    // Recomputing under a newer algorithm yields a different fingerprint...
    const recomputed = computeContentFingerprint(
      {
        media: media(),
        delivery: delivery(),
        assetContentHash: "sha256:abc",
        destinationIsTestedHypothesis: false,
      },
      "v2",
    );
    expect(recomputed.fingerprint).not.toBe(originalFingerprint);

    // ...but the stored identity and its recorded version are untouched.
    const stored = book.getVariant(originalId)!;
    expect(stored.creativeId).toBe(originalId);
    expect(stored.contentFingerprint).toBe(originalFingerprint);
    expect(stored.contentFingerprintVersion).toBe("v1");
  });

  it("never mutates historical creative identity", () => {
    const book = ledger();
    const variant = register(book);

    expect(Object.isFrozen(variant)).toBe(true);
    expect(() => {
      (variant as { creativeId: string }).creativeId = "cr_tampered";
    }).toThrow();
    expect(book.getVariant(variant.creativeId)?.creativeId).toBe(variant.creativeId);
  });

  it("returns the same creative when identical media is registered twice", () => {
    const book = ledger();
    expect(register(book).creativeId).toBe(register(book).creativeId);
  });

  it("mints distinct ids for creatives registered in the same millisecond", () => {
    const book = ledger();
    const first = register(book);
    const second = register(book, { hook: "A completely different hook" });

    expect(second.creativeId).not.toBe(first.creativeId);
    expect(second.creativeId).toMatch(ULID_PATTERN);
  });
});

describe("delivery variants versus media identity", () => {
  it("keeps one creative id when only the caption changes", () => {
    const book = ledger();
    const variant = register(book);

    const a = book.registerDeliveryVariant(variant.creativeId, delivery({ caption: "Version A" }));
    const b = book.registerDeliveryVariant(variant.creativeId, delivery({ caption: "Version B" }));

    expect(a.creativeId).toBe(variant.creativeId);
    expect(b.creativeId).toBe(variant.creativeId);
    expect(a.deliveryVariantId).not.toBe(b.deliveryVariantId);
    expect(book.listDeliveryVariants(variant.creativeId)).toHaveLength(2);
  });

  it("keeps one creative id when only UTM parameters change", () => {
    const book = ledger();
    const variant = register(book);

    const plain = book.registerDeliveryVariant(
      variant.creativeId,
      delivery({ destinationUrl: "https://payoutrank.example/scan" }),
    );
    const tagged = book.registerDeliveryVariant(
      variant.creativeId,
      delivery({ destinationUrl: "https://payoutrank.example/scan?utm_source=tiktok" }),
    );

    expect(tagged.creativeId).toBe(plain.creativeId);
    expect(book.getVariant(variant.creativeId)!.creativeId).toBe(variant.creativeId);
  });

  it("treats a destination change as delivery unless the hypothesis tests it", () => {
    const notTested = ledger();
    const a = notTested.registerVariant({
      ventureId: notTested.ventureId,
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      media: media(),
      assetContentHash: "sha256:abc",
      destinationIsTestedHypothesis: false,
      delivery: delivery({ destinationUrl: "https://payoutrank.example/a" }),
    });
    const b = notTested.registerVariant({
      ventureId: notTested.ventureId,
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      media: media(),
      assetContentHash: "sha256:abc",
      destinationIsTestedHypothesis: false,
      delivery: delivery({ destinationUrl: "https://payoutrank.example/b" }),
    });
    expect(b.creativeId).toBe(a.creativeId);

    const tested = ledger();
    const c = tested.registerVariant({
      ventureId: tested.ventureId,
      hypothesisId: "hyp-002",
      creativeFamilyId: "fam-002",
      media: media(),
      assetContentHash: "sha256:abc",
      destinationIsTestedHypothesis: true,
      delivery: delivery({ destinationUrl: "https://payoutrank.example/a" }),
    });
    const d = tested.registerVariant({
      ventureId: tested.ventureId,
      hypothesisId: "hyp-002",
      creativeFamilyId: "fam-002",
      media: media(),
      assetContentHash: "sha256:abc",
      destinationIsTestedHypothesis: true,
      delivery: delivery({ destinationUrl: "https://payoutrank.example/b" }),
    });
    expect(d.creativeId).not.toBe(c.creativeId);
  });

  it("gives a materially edited video a new id that records its parent", () => {
    const book = ledger();
    const parent = register(book);

    const adapted = book.deriveVariant({
      parentCreativeId: parent.creativeId,
      relationship: "platform_variant",
      mediaChanges: { openingFrame: "product_ui", durationSeconds: 15 },
      assetContentHash: "sha256:def",
    });

    expect(adapted.creativeId).not.toBe(parent.creativeId);
    expect(adapted.platformVariantOfCreativeId).toBe(parent.creativeId);
    expect(book.lineageOf(adapted.creativeId)).toEqual([parent.creativeId, adapted.creativeId]);
  });

  it("refuses to mint a new creative when no media dimension changed", () => {
    const book = ledger();
    const parent = register(book);

    expect(() =>
      book.deriveVariant({
        parentCreativeId: parent.creativeId,
        relationship: "platform_variant",
        mediaChanges: {},
        assetContentHash: "sha256:abc",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "not_a_material_adaptation" }) as unknown as Error,
    );
  });
});

describe("provider mappings", () => {
  it("keeps one creative id across networks and resolves each provider object", () => {
    const book = ledger();
    const variant = register(book);
    const shipped = book.registerDeliveryVariant(variant.creativeId, delivery());

    book.mapProviderObject({
      creativeId: variant.creativeId,
      deliveryVariantId: shipped.deliveryVariantId,
      provider: "tiktok_content",
      objectKind: "organic_post",
      externalId: "tt-post-1",
      externalAccountId: "tt-account-1",
      ventureId: book.ventureId,
    });
    book.mapProviderObject({
      creativeId: variant.creativeId,
      deliveryVariantId: shipped.deliveryVariantId,
      provider: "meta_ads",
      objectKind: "ad",
      externalId: "meta-ad-9",
      externalAccountId: "meta-account-1",
      ventureId: book.ventureId,
    });

    expect(book.resolveByProviderObject("tiktok_content", "organic_post", "tt-post-1")).toBe(
      variant.creativeId,
    );
    expect(book.resolveByProviderObject("meta_ads", "ad", "meta-ad-9")).toBe(variant.creativeId);
    expect(book.listProviderObjects(variant.creativeId)).toHaveLength(2);
  });

  it("refuses to rebind an external object to a second creative", () => {
    const book = ledger();
    const one = register(book);
    const two = register(book, { hook: "A different hook entirely" });
    const mapping = {
      provider: "tiktok_content" as const,
      objectKind: "organic_post" as const,
      externalId: "tt-post-1",
      externalAccountId: "tt-account-1",
      ventureId: book.ventureId,
    };

    book.mapProviderObject({ ...mapping, creativeId: one.creativeId });

    expect(() => book.mapProviderObject({ ...mapping, creativeId: two.creativeId })).toThrowError(
      expect.objectContaining({ code: "provider_object_already_mapped" }) as unknown as Error,
    );
  });

  it("is idempotent when the same mapping is recorded twice", () => {
    const book = ledger();
    const variant = register(book);
    const mapping = {
      creativeId: variant.creativeId,
      provider: "tiktok_content" as const,
      objectKind: "organic_post" as const,
      externalId: "tt-post-1",
      externalAccountId: "tt-account-1",
      ventureId: book.ventureId,
    };

    book.mapProviderObject(mapping);
    book.mapProviderObject(mapping);

    expect(book.listProviderObjects(variant.creativeId)).toHaveLength(1);
  });
});

describe("network status and tenant isolation", () => {
  it("tracks organic and paid state per network independently", () => {
    const book = ledger();
    const variant = register(book);

    advance(book, variant.creativeId, "tiktok_organic", TO_ORGANIC_PUBLISHED);
    advance(book, variant.creativeId, "tiktok_paid", TO_PAID_RUNNING);

    const status = book.statusOf(variant.creativeId);
    expect(status.tiktok_organic).toBe("ORGANIC_PUBLISHED");
    expect(status.tiktok_paid).toBe("PAID_TEST_RUNNING");
    expect(status.meta_paid).toBe("DRAFT");
  });

  it("rejects a paid transition that skips the approval gate", () => {
    const book = ledger();
    const variant = register(book);

    expect(() => book.recordStatus(variant.creativeId, "tiktok_paid", "PAID_PROOF")).toThrowError(
      CreativeLedgerError,
    );
  });

  it("does not let a TikTok organic win imply Meta paid eligibility", () => {
    const book = ledger();
    const variant = register(book);

    advance(book, variant.creativeId, "tiktok_organic", [
      ...TO_ORGANIC_PUBLISHED,
      "ORGANIC_SIGNAL",
      "BOOST_CANDIDATE",
    ]);

    expect(book.statusOf(variant.creativeId).meta_paid).toBe("DRAFT");
    expect(book.isPaidEligible(variant.creativeId, "meta_paid")).toBe(false);
  });

  it("denies one venture access to another venture's creative", () => {
    const mine = ledger("payout-rank");
    const variant = register(mine);
    const theirs = createCreativeLedger({ ventureId: "ship-to-users", now: () => NOW });

    expect(theirs.getVariant(variant.creativeId)).toBeUndefined();
    expect(() => theirs.statusOf(variant.creativeId)).toThrowError(CreativeLedgerError);
  });
});
