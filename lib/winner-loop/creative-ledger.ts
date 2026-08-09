import { createHash } from "node:crypto";
import {
  CURRENT_FINGERPRINT_VERSION,
  computeContentFingerprint,
  computeDeliveryFingerprint,
  normalizeDestination,
  type FingerprintVersion,
} from "./fingerprint";
import {
  assessCreativeCompliance,
  type CreativeCompliancePolicy,
  type CreativeManifestStore,
} from "./creative-manifest";
import { createMemoryCreativeLedgerStore, type CreativeLedgerStore } from "./creative-ledger-store";
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
  | "creative_not_authorized"
  | "immutable_binding_conflict"
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
  organizationId: string;
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
  organizationId: string;
  creativeId: string;
  deliveryVariantId?: string | null;
  provider: CreativeProvider;
  objectKind: CreativeObjectKind;
  externalId: string;
  externalAccountId: string;
  ventureId: string;
}

export interface CreativeLedgerOptions extends IdFactoryOptions {
  /** Scopes every read and write; cross-tenant access throws. */
  organizationId: string;
  ventureId: string;
  store?: CreativeLedgerStore;
  authorization?: {
    manifestStore: CreativeManifestStore;
    regionByNetwork: Readonly<Partial<Record<CreativeNetwork, string>>>;
    policyByNetwork: Readonly<Partial<Record<CreativeNetwork, CreativeCompliancePolicy>>>;
  };
}

const EMPTY_DELIVERY: CreativeDeliveryDimensions = {
  caption: "",
  adCopy: "",
  destinationUrl: "",
  privacy: "public",
  platformSettings: {},
};

export function createCreativeLedger(options: CreativeLedgerOptions) {
  const now = options.now ?? (() => new Date());
  const mint = createIdFactory(options);
  const organizationId = options.organizationId;
  const ventureId = options.ventureId;
  if (
    !organizationId.trim() ||
    organizationId !== organizationId.trim() ||
    !ventureId.trim() ||
    ventureId !== ventureId.trim()
  ) {
    throw new Error("creative ledger requires a canonical organization and venture scope");
  }
  const scope = Object.freeze({ organizationId, ventureId });
  const store = options.store ?? createMemoryCreativeLedgerStore();

  function mustGet(creativeId: string): CreativeVariant {
    const variant = store.getVariant(scope, creativeId);
    if (!variant) {
      throw new CreativeLedgerError("unknown_creative", `unknown creative ${creativeId}`);
    }
    return variant;
  }

  function registerVariant(input: RegisterVariantInput): CreativeVariant {
    if (input.organizationId !== organizationId || input.ventureId !== ventureId) {
      throw new CreativeLedgerError(
        "cross_venture_access_denied",
        "cannot register creative state outside the configured organization and venture",
      );
    }
    const derivedFrom = input.derivedFromCreativeId
      ? mustGet(input.derivedFromCreativeId)
      : undefined;
    const platformParent = input.platformVariantOfCreativeId
      ? mustGet(input.platformVariantOfCreativeId)
      : undefined;
    for (const parent of [derivedFrom, platformParent]) {
      if (
        parent &&
        (parent.hypothesisId !== input.hypothesisId ||
          parent.creativeFamilyId !== input.creativeFamilyId)
      ) {
        throw new CreativeLedgerError(
          "immutable_binding_conflict",
          "creative lineage must remain within its original hypothesis and family",
        );
      }
    }
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

    // Only material identity belongs in this binding. Captions, UTMs and other
    // delivery-only changes intentionally replay the existing creative.
    const registrationBinding = JSON.stringify({
      organizationId,
      ventureId,
      hypothesisId: input.hypothesisId,
      creativeFamilyId: input.creativeFamilyId,
      derivedFromCreativeId: input.derivedFromCreativeId ?? null,
      platformVariantOfCreativeId: input.platformVariantOfCreativeId ?? null,
      media: {
        hook: input.media.hook,
        openingFrame: input.media.openingFrame,
        format: input.media.format,
        speaker: input.media.speaker,
        visualSequence: input.media.visualSequence,
        audioTrack: input.media.audioTrack,
        onScreenProof: input.media.onScreenProof,
        embeddedCta: input.media.embeddedCta,
        durationSeconds: input.media.durationSeconds,
        aspectRatio: input.media.aspectRatio,
      },
      assetContentHash: input.assetContentHash ?? "",
      contentFingerprint: fingerprint,
      contentFingerprintVersion: version,
      destinationIsTestedHypothesis,
      testedDestination: destinationIsTestedHypothesis
        ? normalizeDestination(delivery.destinationUrl)
        : null,
      legacyV1Material:
        version === "v1"
          ? {
              caption: delivery.caption,
              destination: normalizeDestination(delivery.destinationUrl),
            }
          : null,
    });
    const registrationKey = createHash("sha256").update(registrationBinding).digest("hex");

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
    const outcome = store.putVariant({
      organizationId,
      ventureId,
      registrationKey,
      registrationBinding,
      variant,
    });
    if (outcome.kind === "conflict") {
      throw new CreativeLedgerError("immutable_binding_conflict", outcome.reason);
    }
    return outcome.value;
  }

  function deriveVariant(input: DeriveVariantInput): CreativeVariant {
    const parent = mustGet(input.parentCreativeId);
    const media = { ...parent.media, ...input.mediaChanges };
    const storedBinding = store.getVariantRegistrationBinding(scope, parent.creativeId);
    if (!storedBinding) {
      throw new CreativeLedgerError(
        "immutable_binding_conflict",
        `creative ${parent.creativeId} has no persisted material replay binding`,
      );
    }
    let material: {
      testedDestination?: string | null;
      legacyV1Material?: { caption: string; destination: string } | null;
    };
    try {
      material = JSON.parse(storedBinding) as typeof material;
    } catch {
      throw new CreativeLedgerError(
        "immutable_binding_conflict",
        `creative ${parent.creativeId} has an invalid material replay binding`,
      );
    }
    if (
      (parent.contentFingerprintVersion === "v1" && !material.legacyV1Material) ||
      (parent.destinationIsTestedHypothesis && typeof material.testedDestination !== "string")
    ) {
      throw new CreativeLedgerError(
        "immutable_binding_conflict",
        `creative ${parent.creativeId} is missing inherited fingerprint material`,
      );
    }
    const inheritedDelivery: CreativeDeliveryDimensions = {
      ...EMPTY_DELIVERY,
      caption: material.legacyV1Material?.caption ?? "",
      destinationUrl: material.legacyV1Material?.destination ?? material.testedDestination ?? "",
    };
    const { fingerprint } = computeContentFingerprint(
      {
        media,
        delivery: inheritedDelivery,
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
      organizationId,
      ventureId,
      hypothesisId: parent.hypothesisId,
      creativeFamilyId: parent.creativeFamilyId,
      media,
      assetContentHash: input.assetContentHash,
      destinationIsTestedHypothesis: parent.destinationIsTestedHypothesis,
      delivery: inheritedDelivery,
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
    const canonicalDelivery: CreativeDeliveryDimensions = {
      caption: delivery.caption,
      adCopy: delivery.adCopy,
      destinationUrl: delivery.destinationUrl,
      privacy: delivery.privacy,
      platformSettings: Object.fromEntries(
        Object.entries(delivery.platformSettings).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    };
    const deliveryFingerprint = computeDeliveryFingerprint(canonicalDelivery);
    const record: DeliveryVariant = Object.freeze({
      deliveryVariantId: mint("dv"),
      creativeId,
      deliveryFingerprint,
      delivery: Object.freeze({
        ...canonicalDelivery,
        platformSettings: Object.freeze({ ...canonicalDelivery.platformSettings }),
      }),
      createdAt: now().toISOString(),
    });
    const binding = JSON.stringify({
      organizationId,
      ventureId,
      creativeId,
      deliveryFingerprint,
      delivery: record.delivery,
    });
    const outcome = store.putDeliveryVariant(scope, binding, record);
    if (outcome.kind === "conflict") {
      throw new CreativeLedgerError("immutable_binding_conflict", outcome.reason);
    }
    return outcome.value;
  }

  function mapProviderObject(input: ProviderObjectInput): CreativeProviderObject {
    mustGet(input.creativeId);
    if (input.organizationId !== organizationId || input.ventureId !== ventureId) {
      throw new CreativeLedgerError(
        "cross_venture_access_denied",
        "cannot map provider state outside the configured organization and venture",
      );
    }
    if (input.deliveryVariantId) {
      const deliveryVariant = store.getDeliveryVariant(scope, input.deliveryVariantId);
      if (!deliveryVariant) {
        throw new CreativeLedgerError(
          "unknown_delivery_variant",
          `unknown delivery variant ${input.deliveryVariantId}`,
        );
      }
      if (deliveryVariant.creativeId !== input.creativeId) {
        throw new CreativeLedgerError(
          "immutable_binding_conflict",
          `${input.deliveryVariantId} belongs to ${deliveryVariant.creativeId}, not ${input.creativeId}`,
        );
      }
    }
    const record: CreativeProviderObject = Object.freeze({
      organizationId,
      creativeId: input.creativeId,
      deliveryVariantId: input.deliveryVariantId ?? null,
      provider: input.provider,
      objectKind: input.objectKind,
      externalId: input.externalId,
      externalAccountId: input.externalAccountId,
      ventureId: input.ventureId,
      recordedAt: now().toISOString(),
    });
    const outcome = store.putProviderObject(record);
    if (outcome.kind === "conflict") {
      throw new CreativeLedgerError(
        "provider_object_already_mapped",
        `${input.provider}::${input.objectKind}::${input.externalId} is already bound and cannot move creatives, accounts, or delivery variants`,
      );
    }
    return outcome.value;
  }

  function recordStatus(
    creativeId: string,
    network: CreativeNetwork,
    next: CreativeStatus,
  ): CreativeStatus {
    mustGet(creativeId);
    const current = store.getStatus(scope, creativeId, network);
    if (!current) {
      throw new CreativeLedgerError(
        "unknown_creative",
        `creative ${creativeId} has no ${network} status record`,
      );
    }
    if (current === next) return current;
    if (!transitionsFor(network)[current].includes(next)) {
      throw new CreativeLedgerError(
        "invalid_status_transition",
        `${network} cannot move from ${current} to ${next}`,
      );
    }
    const transitionAt = now();
    const requiresCurrentAuthorization =
      (network === "tiktok_organic" &&
        (next === "ORGANIC_DRAFT" || next === "ORGANIC_PUBLISHED")) ||
      (network !== "tiktok_organic" &&
        [
          "PAID_TEST_APPROVED",
          "PAID_TEST_RUNNING",
          "PAID_PROOF",
          "SCALE_ELIGIBLE",
          "SCALE_RECOMMENDED",
        ].includes(next));
    if (requiresCurrentAuthorization) {
      const authorization = options.authorization;
      const manifest = authorization?.manifestStore.getCurrent(scope, creativeId);
      const region = authorization?.regionByNetwork[network];
      const policy = authorization?.policyByNetwork[network];
      if (!manifest || !region || !policy) {
        throw new CreativeLedgerError(
          "creative_not_authorized",
          `${network} has no current manifest-backed authorization`,
        );
      }
      const compliance = assessCreativeCompliance(
        manifest,
        {
          mode: network === "tiktok_organic" ? "organic" : "paid",
          channel: network,
          region,
          at: transitionAt,
        },
        policy,
      );
      if (!compliance.allowed) {
        throw new CreativeLedgerError(
          "creative_not_authorized",
          `${network} authorization is blocked: ${compliance.blockers.join(", ")}`,
        );
      }
    }
    const outcome = store.transitionStatus({
      organizationId,
      ventureId,
      creativeId,
      network,
      expected: current,
      next,
      recordedAt: transitionAt.toISOString(),
    });
    if (outcome.kind === "conflict") {
      throw new CreativeLedgerError(
        "invalid_status_transition",
        `${network} changed concurrently from ${current} to ${outcome.current ?? "missing"}`,
      );
    }
    return outcome.status;
  }

  return {
    organizationId,
    ventureId,
    store,
    registerVariant,
    deriveVariant,
    registerDeliveryVariant,
    mapProviderObject,
    recordStatus,
    getVariant: (creativeId: string): CreativeVariant | undefined => {
      return store.getVariant(scope, creativeId);
    },
    getDeliveryVariant: (id: string): DeliveryVariant | undefined =>
      store.getDeliveryVariant(scope, id),
    listDeliveryVariants: (creativeId: string): readonly DeliveryVariant[] =>
      store.listDeliveryVariants(scope, creativeId),
    listVariants: (): readonly CreativeVariant[] => store.listVariants(scope),
    listProviderObjects: (creativeId: string): readonly CreativeProviderObject[] =>
      store.listProviderObjects(scope, creativeId),
    resolveByProviderObject: (
      provider: CreativeProvider,
      objectKind: CreativeObjectKind,
      externalId: string,
    ): string | undefined =>
      store.resolveProviderObject(scope, provider, objectKind, externalId)?.creativeId,
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
      return Object.freeze({
        tiktok_organic: store.getStatus(scope, creativeId, "tiktok_organic")!,
        tiktok_paid: store.getStatus(scope, creativeId, "tiktok_paid")!,
        meta_paid: store.getStatus(scope, creativeId, "meta_paid")!,
      });
    },
    listStatusHistory: (creativeId: string, network?: CreativeNetwork) => {
      mustGet(creativeId);
      return store.listStatusHistory(scope, creativeId, network);
    },
    isPaidEligible: (creativeId: string, network: CreativeNetwork): boolean => {
      mustGet(creativeId);
      return PAID_ELIGIBLE_STATUSES.includes(store.getStatus(scope, creativeId, network)!);
    },
    networks: CREATIVE_NETWORKS,
  };
}

export type CreativeLedger = ReturnType<typeof createCreativeLedger>;
