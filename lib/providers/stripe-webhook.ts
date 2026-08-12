import type { JsonValue } from "./types";

export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1_000_000;

export interface VerifiedStripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly data: {
    readonly object: {
      readonly id: string;
    };
  };
}

export interface StripeWebhookReconciliation {
  readonly objectId: string;
  /** Monotonic version from current provider state, not event arrival order. */
  readonly sourceVersion: number;
  readonly state: JsonValue;
}

export interface StripeWebhookDeliveryResult {
  readonly status: "applied" | "duplicate" | "stale" | "unchanged";
  readonly eventId: string;
  readonly eventType: string;
  readonly objectId: string;
  readonly sourceVersion: number;
  readonly providerStateReconciled: true;
  readonly redirectUsedAsEvidence: false;
}

export type StripeWebhookSignatureVerifier = (
  rawBody: Uint8Array,
  signatureHeader: string,
) => Promise<VerifiedStripeWebhookEvent> | VerifiedStripeWebhookEvent;

export type StripeWebhookCurrentStateResolver = (
  event: VerifiedStripeWebhookEvent,
) => Promise<StripeWebhookReconciliation> | StripeWebhookReconciliation;

export interface StripeWebhookDeliveryStore {
  processVerified(
    event: VerifiedStripeWebhookEvent,
    resolveCurrentState: StripeWebhookCurrentStateResolver,
  ): Promise<StripeWebhookDeliveryResult>;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function assertVerifiedEvent(
  event: VerifiedStripeWebhookEvent,
  expectedMode: "test" | "live",
): void {
  if (
    !/^evt_[A-Za-z0-9_]+$/u.test(event.id) ||
    !/^[a-z0-9_.]+$/u.test(event.type) ||
    !Number.isSafeInteger(event.created) ||
    event.created < 0 ||
    !event.data?.object?.id ||
    event.livemode !== (expectedMode === "live")
  ) {
    throw new Error("Stripe webhook verification returned an invalid or wrong-mode event");
  }
}

/**
 * Accept one server-side delivery. Signature verification receives the exact
 * raw bytes before this module trusts or parses event fields. The verifier owns
 * access to the signing-secret credential; the value never enters this API.
 */
export async function processStripeWebhookDelivery(options: {
  rawBody: Uint8Array;
  signatureHeader: string | null | undefined;
  expectedMode: "test" | "live";
  verifySignature: StripeWebhookSignatureVerifier;
  resolveCurrentState: StripeWebhookCurrentStateResolver;
  store: StripeWebhookDeliveryStore;
}): Promise<StripeWebhookDeliveryResult> {
  if (!(options.rawBody instanceof Uint8Array) || options.rawBody.byteLength === 0) {
    throw new Error("Stripe webhook requires the exact non-empty raw request body");
  }
  if (options.rawBody.byteLength > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    throw new Error(`Stripe webhook body exceeds ${STRIPE_WEBHOOK_MAX_BODY_BYTES} bytes`);
  }
  if (!options.signatureHeader?.trim()) {
    throw new Error("Stripe webhook requires the Stripe-Signature header");
  }
  const event = await options.verifySignature(options.rawBody, options.signatureHeader.trim());
  assertVerifiedEvent(event, options.expectedMode);
  return options.store.processVerified(event, options.resolveCurrentState);
}

interface StoredStripeObject {
  readonly sourceVersion: number;
  readonly state: JsonValue;
}

/** Fixture-only store. Deployments need the same contract in a durable DB transaction. */
export class MemoryStripeWebhookDeliveryStore implements StripeWebhookDeliveryStore {
  readonly #events = new Map<string, StripeWebhookDeliveryResult>();
  readonly #objects = new Map<string, StoredStripeObject>();
  #tail: Promise<void> = Promise.resolve();

  async processVerified(
    event: VerifiedStripeWebhookEvent,
    resolveCurrentState: StripeWebhookCurrentStateResolver,
  ): Promise<StripeWebhookDeliveryResult> {
    let release!: () => void;
    const prior = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const duplicate = this.#events.get(event.id);
      if (duplicate) return { ...duplicate, status: "duplicate" };
      const reconciled = await resolveCurrentState(event);
      if (
        reconciled.objectId !== event.data.object.id ||
        !Number.isSafeInteger(reconciled.sourceVersion) ||
        reconciled.sourceVersion < 0
      ) {
        throw new Error("Stripe webhook reconciliation returned invalid provider state");
      }
      const previous = this.#objects.get(reconciled.objectId);
      let status: StripeWebhookDeliveryResult["status"] = "applied";
      if (previous && reconciled.sourceVersion < previous.sourceVersion) status = "stale";
      else if (previous && reconciled.sourceVersion === previous.sourceVersion) {
        if (canonicalJson(previous.state) !== canonicalJson(reconciled.state)) {
          throw new Error("Stripe webhook reconciliation conflicts at one source version");
        }
        status = "unchanged";
      }
      if (status === "applied") {
        this.#objects.set(reconciled.objectId, {
          sourceVersion: reconciled.sourceVersion,
          state: structuredClone(reconciled.state),
        });
      }
      const result: StripeWebhookDeliveryResult = {
        status,
        eventId: event.id,
        eventType: event.type,
        objectId: reconciled.objectId,
        sourceVersion: reconciled.sourceVersion,
        providerStateReconciled: true,
        redirectUsedAsEvidence: false,
      };
      this.#events.set(event.id, result);
      return result;
    } finally {
      release();
    }
  }

  object(objectId: string): StoredStripeObject | null {
    const value = this.#objects.get(objectId);
    return value
      ? { sourceVersion: value.sourceVersion, state: structuredClone(value.state) }
      : null;
  }
}
