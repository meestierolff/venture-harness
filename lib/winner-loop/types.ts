/**
 * Winner Loop domain vocabulary.
 *
 * The invariant this file exists to protect: one creative keeps one permanent
 * internal `creative_id` from hypothesis through render, organic publication,
 * paid test, attribution, and subscription cohort. Provider identifiers
 * (post IDs, ad IDs, render job IDs) are mappings onto that identity — never
 * the identity itself, because provider objects are recreated, deleted, and
 * renumbered outside our control.
 */

/** Networks a creative can occupy. Each track advances independently: a TikTok
 * organic winner is not a Meta winner, so status never propagates sideways. */
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
 * Dimensions that constitute creative identity. A change here produces a
 * different creative; a change outside here does not.
 *
 * Deliberately excluded: the network a creative is posted to, provider object
 * IDs, scheduling, and tracking parameters. Section 23 requires that the same
 * unmodified creative on several destinations keeps one creative ID, so none of
 * those may participate in the fingerprint.
 */
export interface CreativeMaterialDimensions {
  hook: string;
  openingFrame: string;
  format: string;
  speaker: string;
  proofType: string;
  cta: string;
  offer: string;
  durationSeconds: number;
  aspectRatio: string;
  caption: string;
  /** Compared after tracking parameters are stripped — see normalizeDestination. */
  destinationUrl: string;
}

/** How a derived creative relates to its parent. */
export type CreativeRelationship = "iteration" | "platform_variant";

export interface CreativeVariant {
  readonly creativeId: string;
  readonly hypothesisId: string;
  readonly creativeFamilyId: string;
  readonly derivedFromCreativeId: string | null;
  readonly platformVariantOfCreativeId: string | null;
  readonly fingerprint: string;
  readonly dimensions: Readonly<CreativeMaterialDimensions>;
  readonly assetContentHash: string | null;
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
  | "local_renderer";

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
  readonly provider: CreativeProvider;
  readonly objectKind: CreativeObjectKind;
  readonly externalId: string;
  readonly externalAccountId: string;
  readonly recordedAt: string;
}

export type CreativeNetworkStatus = Readonly<Record<CreativeNetwork, CreativeStatus>>;
