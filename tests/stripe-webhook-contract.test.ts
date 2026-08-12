import { describe, expect, it } from "vitest";
import {
  MemoryStripeWebhookDeliveryStore,
  processStripeWebhookDelivery,
  type StripeWebhookSignatureVerifier,
  type VerifiedStripeWebhookEvent,
} from "@/lib/providers";

const encoder = new TextEncoder();

function event(
  id: string,
  created: number,
  type = "checkout.session.completed",
): VerifiedStripeWebhookEvent {
  return {
    id,
    type,
    created,
    livemode: false,
    data: { object: { id: "cs_fixture_order" } },
  };
}

function verifier(
  value: VerifiedStripeWebhookEvent,
  observed: Uint8Array[],
): StripeWebhookSignatureVerifier {
  return (rawBody, signatureHeader) => {
    observed.push(rawBody);
    expect(signatureHeader).toBe("t=100,v1=fixture-signature");
    return value;
  };
}

describe("Stripe webhook server contract", () => {
  it("verifies the exact raw bytes before resolving current provider state", async () => {
    const rawBody = encoder.encode('{"id":"evt_fixture_one", "spacing":"preserved"}');
    const observed: Uint8Array[] = [];
    const calls: string[] = [];
    const result = await processStripeWebhookDelivery({
      rawBody,
      signatureHeader: "t=100,v1=fixture-signature",
      expectedMode: "test",
      verifySignature: verifier(event("evt_fixture_one", 100), observed),
      resolveCurrentState(verified) {
        calls.push(verified.id);
        return { objectId: verified.data.object.id, sourceVersion: 7, state: { paid: true } };
      },
      store: new MemoryStripeWebhookDeliveryStore(),
    });

    expect(observed).toEqual([rawBody]);
    expect(calls).toEqual(["evt_fixture_one"]);
    expect(result).toMatchObject({
      status: "applied",
      providerStateReconciled: true,
      redirectUsedAsEvidence: false,
    });
  });

  it("rejects missing, failed, oversized, and live-mode deliveries before reconciliation", async () => {
    let reconciled = false;
    const store = new MemoryStripeWebhookDeliveryStore();
    const base = {
      rawBody: encoder.encode("{}"),
      signatureHeader: "t=100,v1=fixture-signature",
      expectedMode: "test" as const,
      resolveCurrentState() {
        reconciled = true;
        return { objectId: "cs_fixture_order", sourceVersion: 1, state: {} };
      },
      store,
    };

    await expect(
      processStripeWebhookDelivery({
        ...base,
        signatureHeader: null,
        verifySignature: () => event("evt_fixture_missing", 1),
      }),
    ).rejects.toThrow(/Stripe-Signature/);
    await expect(
      processStripeWebhookDelivery({
        ...base,
        verifySignature: () => {
          throw new Error("signature mismatch");
        },
      }),
    ).rejects.toThrow(/signature mismatch/);
    await expect(
      processStripeWebhookDelivery({
        ...base,
        verifySignature: () => ({ ...event("evt_fixture_live", 1), livemode: true }),
      }),
    ).rejects.toThrow(/wrong-mode/);
    await expect(
      processStripeWebhookDelivery({
        ...base,
        rawBody: new Uint8Array(1_000_001),
        verifySignature: () => event("evt_fixture_large", 1),
      }),
    ).rejects.toThrow(/exceeds/);
    expect(reconciled).toBe(false);
  });

  it("deduplicates event IDs and cannot regress state when events arrive out of order", async () => {
    const store = new MemoryStripeWebhookDeliveryStore();
    let reconciliations = 0;
    const deliver = (verifiedEvent: VerifiedStripeWebhookEvent, sourceVersion: number) =>
      processStripeWebhookDelivery({
        rawBody: encoder.encode(JSON.stringify({ id: verifiedEvent.id })),
        signatureHeader: "t=100,v1=fixture-signature",
        expectedMode: "test",
        verifySignature: () => verifiedEvent,
        resolveCurrentState(verified) {
          reconciliations += 1;
          return {
            objectId: verified.data.object.id,
            sourceVersion,
            state: { sourceVersion },
          };
        },
        store,
      });

    expect(await deliver(event("evt_fixture_newer", 200), 20)).toMatchObject({ status: "applied" });
    expect(await deliver(event("evt_fixture_older", 100), 10)).toMatchObject({ status: "stale" });
    expect(await deliver(event("evt_fixture_newer", 200), 999)).toMatchObject({
      status: "duplicate",
      sourceVersion: 20,
    });
    expect(reconciliations).toBe(2);
    expect(store.object("cs_fixture_order")).toEqual({
      sourceVersion: 20,
      state: { sourceVersion: 20 },
    });
  });
});
