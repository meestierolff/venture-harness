import {
  CURRENT_FINGERPRINT_VERSION,
  computeContentFingerprint,
  computeDeliveryFingerprint,
  type FingerprintVersion,
} from "./fingerprint";
import { createIdFactory, type IdFactoryOptions } from "./ids";
import {
  CREATIVE_NETWORKS,
  type CreativeDeliveryDimensions,
  type CreativeMediaDimensions,
  type CreativeNetwork,
  type CreativeNetworkStatus,
  type CreativeObjectKind,
  type CreativeProvider,
  type CreativeProviderObject,
  type CreativeRelationship,
  type CreativeStatus,
  type CreativeVariant,
  type DeliveryVariant,
} from "./types";

export type CreativeLedgerErrorCode =
  | "unknown_creative"
  | "unknown_delivery_variant"
  | "not_a_material_adaptation"
  | "provider_object_already_mapped"
  | "invalid_status_transition"
  | "cross_venture_access_denied";

export class CreativeLedgerError extends Error {
  readonly code: CreativeLedgerErrorCode;

  constructor(code: CreativeLedgerErrorCode, message: string) {
    super(message);
    this.name = "CreativeLedgerError";
    this.code = code;
  }
}

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
  ventureId: string;
  hypothesisId: string;
  creativeFamilyId: string;
  media: CreativeMediaDimensions;
  assetContentHash: string | null;
  destinationIsTestedHypothesis?: boolean;
  /** Only used when destinationIsTestedHypothesis is true. */
  delivery?: CreativeDeliveryDimensions;
  derivedFromCreativeId?: string | null;
  platformVariantOfCreativeId?: string | null;
  fingerprintVersion?: FingerprintVersion;
}

export interface DeriveVariantInput {
  parentCreativeId: string;
  relationship: CreativeRelationship;
  mediaChanges: Partial<CreativeMediaDimensions>;
  assetContentHash: string | null;
}

export interface ProviderObjectInput {
  creativeId: string;
  deliveryVariantId?: string | null;
  provider: CreativeProvider;
  objectKind: CreativeObjectKind;
  externalId: string;
  externalAccountId: string;
  ventureId: string;
}

export interface CreativeLedgerOptions extends IdFactoryOptions {
  /** Scopes every read and write; cross-venture access throws. */
  ventureId: string;
}

const EMPTY_DELIVERY: CreativeDeliveryDimensions = {
  caption: "",
  adCopy: "",
  destinationUrl: "",
  privacy: "public",
  platformSettings: {},
};

function providerObjectKey(
  provider: CreativeProvider,
  objectKind: CreativeObjectKind,
  externalId: string,
): string {
  return `${provider}::${objectKind}::${externalId}`;
}

export function createCreativeLedger(options: CreativeLedgerOptions) {
  const now = options.now ?? (() => new Date());
  const mint = createIdFactory(options);
  const ventureId = options.ventureId;
  const variants = new Map<string, CreativeVariant>();
  const deliveryVariants = new Map<string, DeliveryVariant>();
  const deliveryByFingerprint = new Map<string, string>();
  const providerObjects = new Map<string, CreativeProviderObject>();
  const statuses = new Map<string, Record<CreativeNetwork, CreativeStatus>>();
  const variantVenture = new Map<string, string>();

  function mustGet(creativeId: string): CreativeVariant {
    const variant = variants.get(creativeId);
    if (!variant) {
      throw new CreativeLedgerError("unknown_creative", `unknown creative ${creativeId}`);
    }
    if (variantVenture.get(creativeId) !== ventureId) {
      throw new CreativeLedgerError(
        "cross_venture_access_denied",
        `${creativeId} does not belong to venture ${ventureId}`,
      );
    }
    return variant;
  }

  function registerVariant(input: RegisterVariantInput): CreativeVariant {
    const delivery = input.delivery ?? EMPTY_DELIVERY;
    const destinationIsTestedHypothesis = input.destinationIsTestedHypothesis ?? false;
    const { fingerprint, version } = computeContentFingerprint(
      {
        media: input.media,
        delivery,
        assetContentHash: input.assetContentHash,
        destinationIsTestedHypothesis,
      },
      input.fingerprintVersion ?? CURRENT_FINGERPRINT_VERSION,
    );

    // Equivalence is detected by fingerprint, but identity is never derived from
    // it: an identical re-registration returns the creative that already exists.
    for (const existing of variants.values()) {
      if (
        existing.contentFingerprint === fingerprint &&
        existing.contentFingerprintVersion === version &&
        existing.hypothesisId === input.hypothesisId &&
        existing.creativeFamilyId === input.creativeFamilyId
      ) {
        return existing;
      }
    }

    const variant: CreativeVariant = Object.freeze({
      creativeId: mint("cr"),
      hypothesisId: input.hypothesisId,
      creativeFamilyId: input.creativeFamilyId,
      derivedFromCreativeId: input.derivedFromCreativeId ?? null,
      platformVariantOfCreativeId: input.platformVariantOfCreativeId ?? null,
      contentFingerprint: fingerprint,
      contentFingerprintVersion: version,
      media: Object.freeze({ ...input.media }),
      assetContentHash: input.assetContentHash,
      destinationIsTestedHypothesis,
      createdAt: now().toISOString(),
    });
    variants.set(variant.creativeId, variant);
    variantVenture.set(variant.creativeId, input.ventureId);
    statuses.set(variant.creativeId, {
      tiktok_organic: "DRAFT",
      tiktok_paid: "DRAFT",
      meta_paid: "DRAFT",
    });
    return variant;
  }

  function deriveVariant(input: DeriveVariantInput): CreativeVariant {
    const parent = mustGet(input.parentCreativeId);
    const media = { ...parent.media, ...input.mediaChanges };
    const { fingerprint } = computeContentFingerprint(
      {
        media,
        delivery: EMPTY_DELIVERY,
        assetContentHash: input.assetContentHash,
        destinationIsTestedHypothesis: parent.destinationIsTestedHypothesis,
      },
      parent.contentFingerprintVersion as FingerprintVersion,
    );
    if (fingerprint === parent.contentFingerprint) {
      throw new CreativeLedgerError(
        "not_a_material_adaptation",
        `no media dimension changed from ${parent.creativeId}; use a delivery variant instead of minting a new creative`,
      );
    }
    return registerVariant({
      ventureId,
      hypothesisId: parent.hypothesisId,
      creativeFamilyId: parent.creativeFamilyId,
      media,
      assetContentHash: input.assetContentHash,
      destinationIsTestedHypothesis: parent.destinationIsTestedHypothesis,
      derivedFromCreativeId: parent.creativeId,
      platformVariantOfCreativeId:
        input.relationship === "platform_variant" ? parent.creativeId : null,
      fingerprintVersion: parent.contentFingerprintVersion as FingerprintVersion,
    });
  }

  /** Register how a creative was shipped. Same media, different delivery. */
  function registerDeliveryVariant(
    creativeId: string,
    delivery: CreativeDeliveryDimensions,
  ): DeliveryVariant {
    mustGet(creativeId);
    const deliveryFingerprint = computeDeliveryFingerprint(delivery);
    const key = `${creativeId}::${deliveryFingerprint}`;
    const existingId = deliveryByFingerprint.get(key);
    if (existingId) return deliveryVariants.get(existingId)!;

    const record: DeliveryVariant = Object.freeze({
      deliveryVariantId: mint("dv"),
      creativeId,
      deliveryFingerprint,
      delivery: Object.freeze({ ...delivery }),
      createdAt: now().toISOString(),
    });
    deliveryVariants.set(record.deliveryVariantId, record);
    deliveryByFingerprint.set(key, record.deliveryVariantId);
    return record;
  }

  function mapProviderObject(input: ProviderObjectInput): CreativeProviderObject {
    mustGet(input.creativeId);
    if (input.deliveryVariantId && !deliveryVariants.has(input.deliveryVariantId)) {
      throw new CreativeLedgerError(
        "unknown_delivery_variant",
        `unknown delivery variant ${input.deliveryVariantId}`,
      );
    }
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
      creativeId: input.creativeId,
      deliveryVariantId: input.deliveryVariantId ?? null,
      provider: input.provider,
      objectKind: input.objectKind,
      externalId: input.externalId,
      externalAccountId: input.externalAccountId,
      ventureId: input.ventureId,
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
    if (!transitionsFor(network)[current].includes(next)) {
      throw new CreativeLedgerError(
        "invalid_status_transition",
        `${network} cannot move from ${current} to ${next}`,
      );
    }
    track[network] = next;
    return next;
  }

  return {
    ventureId,
    registerVariant,
    deriveVariant,
    registerDeliveryVariant,
    mapProviderObject,
    recordStatus,
    getVariant: (creativeId: string): CreativeVariant | undefined => {
      const variant = variants.get(creativeId);
      if (!variant || variantVenture.get(creativeId) !== ventureId) return undefined;
      return variant;
    },
    getDeliveryVariant: (id: string): DeliveryVariant | undefined => deliveryVariants.get(id),
    listDeliveryVariants: (creativeId: string): readonly DeliveryVariant[] =>
      [...deliveryVariants.values()].filter((entry) => entry.creativeId === creativeId),
    listVariants: (): readonly CreativeVariant[] =>
      [...variants.values()].filter((entry) => variantVenture.get(entry.creativeId) === ventureId),
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
