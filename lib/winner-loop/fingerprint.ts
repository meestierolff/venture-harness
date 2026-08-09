import { createHash } from "node:crypto";
import type { CreativeDeliveryDimensions, CreativeMediaDimensions } from "./types";

/**
 * Content fingerprints answer "is this the same content?" — deduplication and
 * equivalence detection. They never answer "which creative is this?", which is
 * what the opaque creative_id is for.
 *
 * Algorithms are versioned and additive. An existing record keeps the version
 * it was fingerprinted under, so introducing v2 cannot retroactively change what
 * v1 concluded, and a stored creative_id never moves.
 */

export const FINGERPRINT_VERSIONS = ["v1", "v2"] as const;
export type FingerprintVersion = (typeof FINGERPRINT_VERSIONS)[number];
export const CURRENT_FINGERPRINT_VERSION: FingerprintVersion = "v2";

/** Query parameters that identify a click, not content. */
const TRACKING_PARAM_PREFIXES = ["utm_", "af_", "adjust_", "pk_", "mc_"];
const TRACKING_PARAM_NAMES = new Set([
  "ttclid",
  "fbclid",
  "gclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "igshid",
  "clickid",
  "click_id",
  "ref",
  "ref_src",
  "_branch_match_id",
  "gbraid",
  "wbraid",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_NAMES.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function normalizeDestination(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim();
  }
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  url.hash = "";
  const search = url.searchParams.toString();
  const path = url.pathname.replace(/\/$/, "");
  return `${url.protocol}//${url.host}${path}${search ? `?${search}` : ""}`;
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

export interface FingerprintInput {
  media: CreativeMediaDimensions;
  delivery: CreativeDeliveryDimensions;
  assetContentHash: string | null;
  /**
   * True only when the creative hypothesis is explicitly testing the landing
   * destination. Then, and only then, the destination is material to identity;
   * otherwise a destination change is a delivery variant.
   */
  destinationIsTestedHypothesis: boolean;
}

/** v1: the original algorithm. Retained so historical records stay verifiable. */
function fingerprintV1(input: FingerprintInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        ...input.media,
        caption: input.delivery.caption,
        destinationUrl: normalizeDestination(input.delivery.destinationUrl),
        assetContentHash: input.assetContentHash ?? "",
      }),
    )
    .digest("hex");
}

/**
 * v2: only what is rendered into the pixels and audio, plus the destination
 * when the destination is itself the hypothesis under test. A caption or ad copy
 * that sits beside the media is delivery, not content.
 */
function fingerprintV2(input: FingerprintInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        ...input.media,
        assetContentHash: input.assetContentHash ?? "",
        testedDestination: input.destinationIsTestedHypothesis
          ? normalizeDestination(input.delivery.destinationUrl)
          : null,
      }),
    )
    .digest("hex");
}

const ALGORITHMS: Record<FingerprintVersion, (input: FingerprintInput) => string> = {
  v1: fingerprintV1,
  v2: fingerprintV2,
};

export interface ContentFingerprint {
  readonly fingerprint: string;
  readonly version: FingerprintVersion;
}

export function computeContentFingerprint(
  input: FingerprintInput,
  version: FingerprintVersion = CURRENT_FINGERPRINT_VERSION,
): ContentFingerprint {
  return Object.freeze({ fingerprint: ALGORITHMS[version](input), version });
}

/** Delivery variants distinguish how one creative was shipped, never what it is. */
export function computeDeliveryFingerprint(delivery: CreativeDeliveryDimensions): string {
  return createHash("sha256")
    .update(
      stableJson({
        caption: delivery.caption,
        adCopy: delivery.adCopy,
        destinationUrl: delivery.destinationUrl,
        privacy: delivery.privacy,
        platformSettings: JSON.stringify(delivery.platformSettings ?? {}),
      }),
    )
    .digest("hex");
}
