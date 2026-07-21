import { describe, expect, it } from "vitest";
import { getConsent, hasAnalyticsConsent, setConsent, type ConsentStorage } from "@/lib/consent";

function memoryStorage(): ConsentStorage {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v) };
}

describe("consent state machine", () => {
  it("defaults to unset — never to accepted", () => {
    expect(getConsent(memoryStorage())).toBe("unset");
    expect(getConsent(null)).toBe("unset"); // storage blocked → unset
    expect(hasAnalyticsConsent(null)).toBe(false);
  });

  it("accept then withdraw is recorded as a withdrawal", () => {
    const storage = memoryStorage();
    const grant = setConsent("accepted", storage);
    expect(grant).toMatchObject({ from: "unset", to: "accepted", withdrawal: false });
    expect(hasAnalyticsConsent(storage)).toBe(true);

    const withdraw = setConsent("declined", storage);
    expect(withdraw).toMatchObject({ from: "accepted", to: "declined", withdrawal: true });
    expect(hasAnalyticsConsent(storage)).toBe(false);
  });

  it("decline without prior grant is not a withdrawal", () => {
    const storage = memoryStorage();
    expect(setConsent("declined", storage).withdrawal).toBe(false);
  });

  it("ignores corrupted stored values", () => {
    const storage = memoryStorage();
    storage.set("vh-consent", "banana");
    expect(getConsent(storage)).toBe("unset");
  });
});
