import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookSecretVersion {
  secret: string;
  validFrom: string;
  validUntil: string;
}

export interface SignedWebhookPolicy {
  routeId: string;
  secrets: readonly WebhookSecretVersion[];
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
  maxBodyBytes?: number;
  now?: Date;
}

export interface RevenueCatSignedWebhookPolicy {
  secrets: readonly WebhookSecretVersion[];
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
  maxBodyBytes?: number;
  now?: Date;
}

function signatureInput(routeId: string, timestamp: string, rawBody: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(`${routeId}.${timestamp}.`, "utf8"), Buffer.from(rawBody)]);
}

export function signWebhookFixture(
  routeId: string,
  timestamp: string,
  rawBody: Uint8Array,
  secret: string,
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(signatureInput(routeId, timestamp, rawBody))
    .digest("hex")}`;
}

/** Official RevenueCat HMAC fixture format: `t=<unix>,v1=<hex>`. */
export function signRevenueCatWebhookFixture(
  unixTimestamp: number,
  rawBody: Uint8Array,
  secret: string,
): string {
  if (!Number.isSafeInteger(unixTimestamp) || unixTimestamp < 0) {
    throw new Error("RevenueCat webhook timestamp must be Unix seconds");
  }
  const digest = createHmac("sha256", secret)
    .update(Buffer.from(`${unixTimestamp}.`, "utf8"))
    .update(rawBody)
    .digest("hex");
  return `t=${unixTimestamp},v1=${digest}`;
}

/** Verify RevenueCat's exact raw-body HMAC contract before JSON parsing. */
export function verifyRevenueCatSignedWebhook(
  rawBody: Uint8Array,
  signatureHeader: string,
  policy: RevenueCatSignedWebhookPolicy,
): Readonly<{ signedAt: string; receivedAt: string }> {
  const maxBodyBytes = policy.maxBodyBytes ?? 1024 * 1024;
  if (rawBody.byteLength < 1 || rawBody.byteLength > maxBodyBytes) {
    throw new Error("RevenueCat webhook body is outside the allowed limit");
  }
  const components = signatureHeader.split(",").map((part) => part.trim().split("=", 2));
  const timestampValues = components.filter(([key]) => key === "t").map(([, value]) => value);
  const signatures = components.filter(([key]) => key === "v1").map(([, value]) => value);
  if (
    timestampValues.length !== 1 ||
    !/^\d+$/.test(timestampValues[0] ?? "") ||
    signatures.length === 0 ||
    signatures.some((signature) => !/^[a-f0-9]{64}$/i.test(signature ?? ""))
  ) {
    throw new Error("RevenueCat webhook signature header is invalid");
  }
  const unixTimestamp = Number(timestampValues[0]);
  if (!Number.isSafeInteger(unixTimestamp)) {
    throw new Error("RevenueCat webhook signature timestamp is invalid");
  }
  const timestampMs = unixTimestamp * 1_000;
  const now = policy.now ?? new Date();
  const maxAgeMs = (policy.maxAgeSeconds ?? 5 * 60) * 1_000;
  const maxFutureMs = (policy.maxFutureSkewSeconds ?? 30) * 1_000;
  if (now.getTime() - timestampMs > maxAgeMs || timestampMs - now.getTime() > maxFutureMs) {
    throw new Error("RevenueCat webhook timestamp is outside the allowed freshness window");
  }
  const activeSecrets = policy.secrets.filter(
    ({ secret, validFrom, validUntil }) =>
      secret.length >= 16 &&
      timestampMs >= Date.parse(validFrom) &&
      timestampMs < Date.parse(validUntil),
  );
  const signedPayload = Buffer.concat([
    Buffer.from(`${unixTimestamp}.`, "utf8"),
    Buffer.from(rawBody),
  ]);
  const supplied = signatures.map((signature) => Buffer.from(signature!, "hex"));
  const valid = activeSecrets.some(({ secret }) => {
    const expected = createHmac("sha256", secret).update(signedPayload).digest();
    return supplied.some(
      (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );
  });
  if (!valid) throw new Error("RevenueCat webhook signature is invalid");
  return Object.freeze({
    signedAt: new Date(timestampMs).toISOString(),
    receivedAt: now.toISOString(),
  });
}

/**
 * Authenticate exact raw bytes, route identity, and timestamp before parsing.
 * Secret versions provide a bounded overlap for rotation.
 */
export function verifySignedWebhook(
  rawBody: Uint8Array,
  timestamp: string,
  signature: string,
  policy: SignedWebhookPolicy,
): Readonly<{ routeId: string; receivedAt: string }> {
  const maxBodyBytes = policy.maxBodyBytes ?? 1024 * 1024;
  if (rawBody.byteLength < 1 || rawBody.byteLength > maxBodyBytes) {
    throw new Error("Webhook body is outside the allowed limit");
  }
  const timestampMs = Date.parse(timestamp);
  const now = policy.now ?? new Date();
  const maxAgeMs = (policy.maxAgeSeconds ?? 5 * 60) * 1_000;
  const maxFutureMs = (policy.maxFutureSkewSeconds ?? 30) * 1_000;
  if (
    !Number.isFinite(timestampMs) ||
    now.getTime() - timestampMs > maxAgeMs ||
    timestampMs - now.getTime() > maxFutureMs
  ) {
    throw new Error("Webhook timestamp is outside the allowed freshness window");
  }
  const suppliedHex = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) throw new Error("Webhook signature is invalid");
  const supplied = Buffer.from(suppliedHex, "hex");
  const activeSecrets = policy.secrets.filter(
    ({ secret, validFrom, validUntil }) =>
      secret.length >= 16 &&
      timestampMs >= Date.parse(validFrom) &&
      timestampMs < Date.parse(validUntil),
  );
  const message = signatureInput(policy.routeId, timestamp, rawBody);
  const valid = activeSecrets.some(({ secret }) => {
    const expected = createHmac("sha256", secret).update(message).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!valid) throw new Error("Webhook signature is invalid");
  return Object.freeze({ routeId: policy.routeId, receivedAt: now.toISOString() });
}
