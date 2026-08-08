/**
 * Winner Loop domain vocabulary.
 *
 * Identity model (brief section 23, corrected per completion review):
 *
 *   creative_id            opaque, immutable, sortable; minted once; the
 *                          canonical join key through the whole funnel.
 *   content_fingerprint    versioned hash for dedup/equivalence; recomputable;
 *                          never replaces creative_id.
 *   creative_family_id     groups variants from one hypothesis or concept.
 *   derived_from           immutable parent lineage for material adaptations.
 *   delivery_variant_id    non-media delivery differences (caption beside the
 *                          media, destination, UTMs, scheduling, privacy).
 *
 * Provider identifiers (post IDs, ad IDs, render job IDs) are mappings onto
 * identity, never identity itself.
 */

export const CREATIVE_NETWORKS = ["tiktok_organic", "tiktok_paid", "meta_paid"] as const;
export type CreativeNetwork = (typeof CREATIVE_NETWORKS)[number];

export const CREATIVE_STATUSES = [
  "DRAFT",
  "READY_FOR_PRODUCTION",
  "RENDERING",
  "ASSET_READY",
  "RIGHTS_BLOCKED",
  "READY_FOR_ORGANIC_REVIEW",
  "ORGANIC_DRAFT",
  "ORGANIC_PUBLISHED",
  "ORGANIC_SIGNAL",
  "BOOST_CANDIDATE",
  "NEEDS_VARIANTS",
  "PAID_TEST_PROPOSED",
  "PAID_TEST_APPROVED",
  "PAID_TEST_RUNNING",
  "PAID_PROOF",
  "SCALE_ELIGIBLE",
  "SCALE_RECOMMENDED",
  "FATIGUED",
  "REJECTED",
  "ARCHIVED",
] as const;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];

/**
 * What is rendered into the pixels and audio. Changing any of these produces a
 * materially different creative that must carry its own identity and lineage.
 */
export interface CreativeMediaDimensions {
  hook: string;
  openingFrame: string;
  format: string;
  speaker: string;
  visualSequence: string;
  audioTrack: string;
  onScreenProof: string;
  /** A CTA burned into the video or spoken in the audio. */
  embeddedCta: string;
  durationSeconds: number;
  aspectRatio: string;
}

/**
 * How one creative was shipped. Changing these produces a new delivery variant
 * against the same creative_id — the media is unchanged.
 */
export interface CreativeDeliveryDimensions {
  /** Caption text beside the media, not rendered into it. */
  caption: string;
  /** Ad copy supplied to the network, not embedded in the media. */
  adCopy: string;
  destinationUrl: string;
  privacy: string;
  platformSettings: Record<string, string | number | boolean>;
}

export type CreativeRelationship = "iteration" | "platform_variant";

export interface CreativeVariant {
  readonly creativeId: string;
  readonly hypothesisId: string;
  readonly creativeFamilyId: string;
  readonly derivedFromCreativeId: string | null;
  readonly platformVariantOfCreativeId: string | null;
  readonly contentFingerprint: string;
  readonly contentFingerprintVersion: string;
  readonly media: Readonly<CreativeMediaDimensions>;
  readonly assetContentHash: string | null;
  readonly destinationIsTestedHypothesis: boolean;
  readonly createdAt: string;
}

export interface DeliveryVariant {
  readonly deliveryVariantId: string;
  readonly creativeId: string;
  readonly deliveryFingerprint: string;
  readonly delivery: Readonly<CreativeDeliveryDimensions>;
  readonly createdAt: string;
}

export type CreativeProvider =
  | "tiktok_content"
  | "tiktok_ads"
  | "meta_ads"
  | "postiz"
  | "zernio"
  | "heygen"
  | "higgsfield"
  | "local_renderer"
  | "revenuecat"
  | "appsflyer";

export type CreativeObjectKind =
  | "render_job"
  | "asset"
  | "organic_post"
  | "organic_draft"
  | "spark_ad"
  | "campaign"
  | "ad_group"
  | "ad";

export interface CreativeProviderObject {
  readonly creativeId: string;
  readonly deliveryVariantId: string | null;
  readonly provider: CreativeProvider;
  readonly objectKind: CreativeObjectKind;
  readonly externalId: string;
  readonly externalAccountId: string;
  readonly ventureId: string;
  readonly recordedAt: string;
}

export type CreativeNetworkStatus = Readonly<Record<CreativeNetwork, CreativeStatus>>;
