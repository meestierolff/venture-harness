import { createHash } from "node:crypto";
import {
  CREATIVE_NETWORKS,
  type CreativeMaterialDimensions,
  type CreativeNetwork,
  type CreativeNetworkStatus,
  type CreativeObjectKind,
  type CreativeProvider,
  type CreativeProviderObject,
  type CreativeRelationship,
  type CreativeStatus,
  type CreativeVariant,
} from "./types";

export type CreativeLedgerErrorCode =
  | "unknown_creative"
  | "not_a_material_adaptation"
  | "provider_object_already_mapped"
  | "invalid_status_transition"
  | "status_not_valid_for_network";

export class CreativeLedgerError extends Error {
  readonly code: CreativeLedgerErrorCode;

  constructor(code: CreativeLedgerErrorCode, message: string) {
    super(message);
    this.name = "CreativeLedgerError";
    this.code = code;
  }
}

/**
 * Query parameters that identify a click, not a creative. Two posts of the same
 * video that differ only by these are the same creative, so they are stripped
 * before fingerprinting. Prefixes cover the per-partner families
 * (utm_*, af_*, adjust_*) that would otherwise fragment one creative's history.
 */
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

/**
 * Reduce a destination to the funnel it points at. Invalid URLs are returned
 * trimmed rather than thrown on: a malformed destination is a content problem
 * for the rights/compliance review to catch, not a reason to lose identity.
 */
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

function canonicalize(dimensions: CreativeMaterialDimensions): string {
  const normalized: Record<string, string | number> = {
    ...dimensions,
    destinationUrl: normalizeDestination(dimensions.destinationUrl),
  };
  return JSON.stringify(
    Object.keys(normalized)
      .sort()
      .map((key) => [key, normalized[key]]),
  );
}

export function fingerprintCreative(input: {
  hypothesisId: string;
  creativeFamilyId: string;
  dimensions: CreativeMaterialDimensions;
  assetContentHash: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.hypothesisId,
        input.creativeFamilyId,
        canonicalize(input.dimensions),
        input.assetContentHash ?? "",
      ]),
    )
    .digest("hex");
}

/**
 * Status machines. Organic and paid tracks are separate because they answer
 * different questions: organic asks "is this worth spending on?", paid asks
 * "did spending work?". Keeping them apart is what stops a TikTok organic win
 * from silently authorising Meta spend.
 */
const ORGANIC_TRANSITIONS: Readonly<Record<CreativeStatus, readonly CreativeStatus[]>> = {
  DRAFT: ["READY_FOR_PRODUCTION", "REJECTED", "ARCHIVED"],
  READY_FOR_PRODUCTION: ["RENDERING", "REJECTED", "ARCHIVED"],
  RENDERING: ["ASSET_READY", "REJECTED", "ARCHIVED"],
  ASSET_READY: ["READY_FOR_ORGANIC_REVIEW", "RIGHTS_BLOCKED", "REJECTED", "ARCHIVED"],
  RIGHTS_BLOCKED: ["READY_FOR_ORGANIC_REVIEW", "REJECTED", "ARCHIVED"],
  READY_FOR_ORGANIC_REVIEW: [
    "ORGANIC_DRAFT",
    "ORGANIC_PUBLISHED",
    "RIGHTS_BLOCKED",
    "REJECTED",
    "ARCHIVED",
  ],
  ORGANIC_DRAFT: ["ORGANIC_PUBLISHED", "REJECTED", "ARCHIVED"],
  ORGANIC_PUBLISHED: ["ORGANIC_SIGNAL", "NEEDS_VARIANTS", "FATIGUED", "REJECTED", "ARCHIVED"],
  ORGANIC_SIGNAL: ["BOOST_CANDIDATE", "NEEDS_VARIANTS", "FATIGUED", "REJECTED", "ARCHIVED"],
  BOOST_CANDIDATE: ["NEEDS_VARIANTS", "FATIGUED", "REJECTED", "ARCHIVED"],
  NEEDS_VARIANTS: ["ORGANIC_DRAFT", "REJECTED", "ARCHIVED"],
  PAID_TEST_PROPOSED: [],
  PAID_TEST_APPROVED: [],
  PAID_TEST_RUNNING: [],
  PAID_PROOF: [],
  SCALE_ELIGIBLE: [],
  SCALE_RECOMMENDED: [],
  FATIGUED: ["ARCHIVED"],
  REJECTED: ["ARCHIVED"],
  ARCHIVED: [],
};

const PAID_TRANSITIONS: Readonly<Record<CreativeStatus, readonly CreativeStatus[]>> = {
  DRAFT: ["PAID_TEST_PROPOSED", "REJECTED", "ARCHIVED"],
  PAID_TEST_PROPOSED: ["PAID_TEST_APPROVED", "REJECTED", "ARCHIVED"],
  PAID_TEST_APPROVED: ["PAID_TEST_RUNNING", "REJECTED", "ARCHIVED"],
  PAID_TEST_RUNNING: ["PAID_PROOF", "NEEDS_VARIANTS", "FATIGUED", "REJECTED", "ARCHIVED"],
  PAID_PROOF: ["SCALE_ELIGIBLE", "FATIGUED", "ARCHIVED"],
  SCALE_ELIGIBLE: ["SCALE_RECOMMENDED", "FATIGUED", "ARCHIVED"],
  SCALE_RECOMMENDED: ["FATIGUED", "ARCHIVED"],
  NEEDS_VARIANTS: ["REJECTED", "ARCHIVED"],
  FATIGUED: ["ARCHIVED"],
  REJECTED: ["ARCHIVED"],
  ARCHIVED: [],
  READY_FOR_PRODUCTION: [],
  RENDERING: [],
  ASSET_READY: [],
  RIGHTS_BLOCKED: [],
  READY_FOR_ORGANIC_REVIEW: [],
  ORGANIC_DRAFT: [],
  ORGANIC_PUBLISHED: [],
  ORGANIC_SIGNAL: [],
  BOOST_CANDIDATE: [],
};

/** A creative is only paid-eligible on a network once that network's own track
 * has passed its approval gate. */
const PAID_ELIGIBLE_STATUSES: readonly CreativeStatus[] = [
  "PAID_TEST_APPROVED",
  "PAID_TEST_RUNNING",
  "PAID_PROOF",
  "SCALE_ELIGIBLE",
  "SCALE_RECOMMENDED",
];

function transitionsFor(network: CreativeNetwork) {
  return network === "tiktok_organic" ? ORGANIC_TRANSITIONS : PAID_TRANSITIONS;
}

export interface RegisterVariantInput {
  hypothesisId: string;
  creativeFamilyId: string;
  dimensions: CreativeMaterialDimensions;
  assetContentHash: string | null;
  derivedFromCreativeId?: string | null;
  platformVariantOfCreativeId?: string | null;
}

export interface DeriveVariantInput {
  parentCreativeId: string;
  relationship: CreativeRelationship;
  changes: Partial<CreativeMaterialDimensions>;
  assetContentHash: string | null;
}

export interface ProviderObjectInput {
  creativeId: string;
  provider: CreativeProvider;
  objectKind: CreativeObjectKind;
  externalId: string;
  externalAccountId: string;
}

export interface CreativeLedgerOptions {
  now?: () => Date;
}

function providerObjectKey(
  provider: CreativeProvider,
  objectKind: CreativeObjectKind,
  externalId: string,
): string {
  return `${provider}::${objectKind}::${externalId}`;
}

export function createCreativeLedger(options: CreativeLedgerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const variants = new Map<string, CreativeVariant>();
  const providerObjects = new Map<string, CreativeProviderObject>();
  const statuses = new Map<string, Record<CreativeNetwork, CreativeStatus>>();

  function mustGet(creativeId: string): CreativeVariant {
    const variant = variants.get(creativeId);
    if (!variant) {
      throw new CreativeLedgerError("unknown_creative", `unknown creative ${creativeId}`);
    }
    return variant;
  }

  function registerVariant(input: RegisterVariantInput): CreativeVariant {
    const fingerprint = fingerprintCreative(input);
    const creativeId = `cr_${fingerprint.slice(0, 16)}`;
    const existing = variants.get(creativeId);
    if (existing) return existing;

    const variant: CreativeVariant = Object.freeze({
      creativeId,
      hypothesisId: input.hypothesisId,
      creativeFamilyId: input.creativeFamilyId,
      derivedFromCreativeId: input.derivedFromCreativeId ?? null,
      platformVariantOfCreativeId: input.platformVariantOfCreativeId ?? null,
      fingerprint,
      dimensions: Object.freeze({ ...input.dimensions }),
      assetContentHash: input.assetContentHash,
      createdAt: now().toISOString(),
    });
    variants.set(creativeId, variant);
    statuses.set(creativeId, {
      tiktok_organic: "DRAFT",
      tiktok_paid: "DRAFT",
      meta_paid: "DRAFT",
    });
    return variant;
  }

  function deriveVariant(input: DeriveVariantInput): CreativeVariant {
    const parent = mustGet(input.parentCreativeId);
    const dimensions = { ...parent.dimensions, ...input.changes };
    const fingerprint = fingerprintCreative({
      hypothesisId: parent.hypothesisId,
      creativeFamilyId: parent.creativeFamilyId,
      dimensions,
      assetContentHash: input.assetContentHash,
    });
    if (fingerprint === parent.fingerprint) {
      throw new CreativeLedgerError(
        "not_a_material_adaptation",
        `no material dimension changed from ${parent.creativeId}; reuse the same creative id rather than minting a new one`,
      );
    }
    return registerVariant({
      hypothesisId: parent.hypothesisId,
      creativeFamilyId: parent.creativeFamilyId,
      dimensions,
      assetContentHash: input.assetContentHash,
      derivedFromCreativeId: parent.creativeId,
      platformVariantOfCreativeId:
        input.relationship === "platform_variant" ? parent.creativeId : null,
    });
  }

  function mapProviderObject(input: ProviderObjectInput): CreativeProviderObject {
    mustGet(input.creativeId);
    const key = providerObjectKey(input.provider, input.objectKind, input.externalId);
    const existing = providerObjects.get(key);
    if (existing) {
      if (existing.creativeId !== input.creativeId) {
        throw new CreativeLedgerError(
          "provider_object_already_mapped",
          `${key} is already mapped to ${existing.creativeId}; provider objects never move between creatives`,
        );
      }
      return existing;
    }
    const record: CreativeProviderObject = Object.freeze({
      ...input,
      recordedAt: now().toISOString(),
    });
    providerObjects.set(key, record);
    return record;
  }

  function recordStatus(
    creativeId: string,
    network: CreativeNetwork,
    next: CreativeStatus,
  ): CreativeStatus {
    mustGet(creativeId);
    const track = statuses.get(creativeId)!;
    const current = track[network];
    if (current === next) return current;
    const allowed = transitionsFor(network)[current];
    if (!allowed.includes(next)) {
      throw new CreativeLedgerError(
        "invalid_status_transition",
        `${network} cannot move from ${current} to ${next}`,
      );
    }
    track[network] = next;
    return next;
  }

  return {
    registerVariant,
    deriveVariant,
    mapProviderObject,
    recordStatus,
    getVariant: (creativeId: string): CreativeVariant | undefined => variants.get(creativeId),
    listVariants: (): readonly CreativeVariant[] => [...variants.values()],
    listProviderObjects: (creativeId: string): readonly CreativeProviderObject[] =>
      [...providerObjects.values()].filter((entry) => entry.creativeId === creativeId),
    resolveByProviderObject: (
      provider: CreativeProvider,
      objectKind: CreativeObjectKind,
      externalId: string,
    ): string | undefined =>
      providerObjects.get(providerObjectKey(provider, objectKind, externalId))?.creativeId,
    lineageOf: (creativeId: string): readonly string[] => {
      const chain: string[] = [];
      let cursor: string | null = creativeId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        chain.unshift(cursor);
        cursor = mustGet(cursor).derivedFromCreativeId;
      }
      return chain;
    },
    statusOf: (creativeId: string): CreativeNetworkStatus => {
      mustGet(creativeId);
      return Object.freeze({ ...statuses.get(creativeId)! });
    },
    isPaidEligible: (creativeId: string, network: CreativeNetwork): boolean => {
      mustGet(creativeId);
      return PAID_ELIGIBLE_STATUSES.includes(statuses.get(creativeId)![network]);
    },
    networks: CREATIVE_NETWORKS,
  };
}

export type CreativeLedger = ReturnType<typeof createCreativeLedger>;
