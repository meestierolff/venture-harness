import { describe, expect, it } from "vitest";
import {
  CreativeLedgerError,
  createCreativeLedger,
  type CreativeLedger,
  type CreativeMaterialDimensions,
  type CreativeNetwork,
  type CreativeStatus,
} from "@/lib/winner-loop";

/** The organic track from DRAFT to a live post, and the paid track from DRAFT
 * to a running test. Spelled out so a gate added later breaks these tests. */
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

function advance(
  book: CreativeLedger,
  creativeId: string,
  network: CreativeNetwork,
  path: readonly CreativeStatus[],
): void {
  for (const status of path) book.recordStatus(creativeId, network, status);
}

const now = new Date("2026-08-08T09:00:00.000Z");

function dimensions(
  overrides: Partial<CreativeMaterialDimensions> = {},
): CreativeMaterialDimensions {
  return {
    hook: "You are losing payouts you already earned",
    openingFrame: "close_up_face",
    format: "talking_head_with_screen_recording",
    speaker: "founder",
    proofType: "product_demo",
    cta: "Check your rank free",
    offer: "free_scan",
    durationSeconds: 22,
    aspectRatio: "9:16",
    caption: "Most affiliates never check this.",
    destinationUrl: "https://payoutrank.example/scan",
    ...overrides,
  };
}

function ledger() {
  return createCreativeLedger({ now: () => now });
}

describe("creative identity", () => {
  it("derives a deterministic permanent creative id from material content", () => {
    const first = ledger().registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });
    const second = ledger().registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    expect(first.creativeId).toMatch(/^cr_[0-9a-f]{16}$/);
    expect(second.creativeId).toBe(first.creativeId);
  });

  it("keeps one creative id when the same unmodified creative reaches several destinations", () => {
    const book = ledger();
    const variant = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    book.mapProviderObject({
      creativeId: variant.creativeId,
      provider: "tiktok_content",
      objectKind: "organic_post",
      externalId: "tt-post-1",
      externalAccountId: "tt-account-1",
    });
    book.mapProviderObject({
      creativeId: variant.creativeId,
      provider: "meta_ads",
      objectKind: "ad",
      externalId: "meta-ad-9",
      externalAccountId: "meta-account-1",
    });

    expect(book.resolveByProviderObject("tiktok_content", "organic_post", "tt-post-1")).toBe(
      variant.creativeId,
    );
    expect(book.resolveByProviderObject("meta_ads", "ad", "meta-ad-9")).toBe(variant.creativeId);
    expect(book.listProviderObjects(variant.creativeId)).toHaveLength(2);
  });

  it("treats tracking parameters on the destination as non-material", () => {
    const plain = ledger().registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions({ destinationUrl: "https://payoutrank.example/scan" }),
      assetContentHash: "sha256:abc",
    });
    const tagged = ledger().registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions({
        destinationUrl: "https://payoutrank.example/scan?utm_source=tiktok&ttclid=xyz",
      }),
      assetContentHash: "sha256:abc",
    });

    expect(tagged.creativeId).toBe(plain.creativeId);
  });

  it("gives a materially adapted creative a new id that records its parent", () => {
    const book = ledger();
    const parent = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    const adapted = book.deriveVariant({
      parentCreativeId: parent.creativeId,
      relationship: "platform_variant",
      changes: { openingFrame: "product_ui", durationSeconds: 15 },
      assetContentHash: "sha256:def",
    });

    expect(adapted.creativeId).not.toBe(parent.creativeId);
    expect(adapted.platformVariantOfCreativeId).toBe(parent.creativeId);
    expect(adapted.derivedFromCreativeId).toBe(parent.creativeId);
    expect(book.lineageOf(adapted.creativeId)).toEqual([parent.creativeId, adapted.creativeId]);
  });

  it("refuses to mint a new id when nothing material changed", () => {
    const book = ledger();
    const parent = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    expect(() =>
      book.deriveVariant({
        parentCreativeId: parent.creativeId,
        relationship: "platform_variant",
        changes: {},
        assetContentHash: "sha256:abc",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "not_a_material_adaptation" }) as unknown as Error,
    );
  });

  it("never mutates historical creative identity", () => {
    const book = ledger();
    const variant = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    expect(Object.isFrozen(variant)).toBe(true);
    expect(() => {
      (variant as { creativeId: string }).creativeId = "cr_tampered";
    }).toThrow();
    expect(book.getVariant(variant.creativeId)?.creativeId).toBe(variant.creativeId);
  });

  it("rejects a provider mapping that would rebind an external object", () => {
    const book = ledger();
    const one = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });
    const two = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions({ hook: "A different hook entirely" }),
      assetContentHash: "sha256:zzz",
    });

    book.mapProviderObject({
      creativeId: one.creativeId,
      provider: "tiktok_content",
      objectKind: "organic_post",
      externalId: "tt-post-1",
      externalAccountId: "tt-account-1",
    });

    expect(() =>
      book.mapProviderObject({
        creativeId: two.creativeId,
        provider: "tiktok_content",
        objectKind: "organic_post",
        externalId: "tt-post-1",
        externalAccountId: "tt-account-1",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "provider_object_already_mapped" }) as unknown as Error,
    );
  });

  it("is idempotent when the same mapping is recorded twice", () => {
    const book = ledger();
    const variant = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });
    const mapping = {
      creativeId: variant.creativeId,
      provider: "tiktok_content" as const,
      objectKind: "organic_post" as const,
      externalId: "tt-post-1",
      externalAccountId: "tt-account-1",
    };

    book.mapProviderObject(mapping);
    book.mapProviderObject(mapping);

    expect(book.listProviderObjects(variant.creativeId)).toHaveLength(1);
  });
});

describe("network status", () => {
  it("tracks organic and paid state per network independently", () => {
    const book = ledger();
    const variant = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    advance(book, variant.creativeId, "tiktok_organic", TO_ORGANIC_PUBLISHED);
    advance(book, variant.creativeId, "tiktok_paid", TO_PAID_RUNNING);

    const status = book.statusOf(variant.creativeId);
    expect(status.tiktok_organic).toBe("ORGANIC_PUBLISHED");
    expect(status.tiktok_paid).toBe("PAID_TEST_RUNNING");
    expect(status.meta_paid).toBe("DRAFT");
  });

  it("rejects a transition that the status model does not allow", () => {
    const book = ledger();
    const variant = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    expect(() => book.recordStatus(variant.creativeId, "tiktok_paid", "PAID_PROOF")).toThrowError(
      CreativeLedgerError,
    );
  });

  it("does not let a TikTok win imply a Meta win", () => {
    const book = ledger();
    const variant = book.registerVariant({
      hypothesisId: "hyp-001",
      creativeFamilyId: "fam-001",
      dimensions: dimensions(),
      assetContentHash: "sha256:abc",
    });

    advance(book, variant.creativeId, "tiktok_organic", [
      ...TO_ORGANIC_PUBLISHED,
      "ORGANIC_SIGNAL",
      "BOOST_CANDIDATE",
    ]);

    expect(book.statusOf(variant.creativeId).meta_paid).toBe("DRAFT");
    expect(book.isPaidEligible(variant.creativeId, "meta_paid")).toBe(false);
  });
});
