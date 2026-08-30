import { describe, expect, it, vi } from "vitest";
import {
  applyGoogleAnalyticsConsent,
  consentStateFromChangeEvent,
  consentStateFromStorageEvent,
  googleAnalyticsDefaultDeniedScript,
  googleAnalyticsInitScript,
  validGaMeasurementId,
} from "@/components/AnalyticsScripts";

const MEASUREMENT_ID = "G-ABC123DEF4";

describe("Google Analytics consent boundary", () => {
  it("accepts only an exact GA4 measurement id", () => {
    expect(validGaMeasurementId(MEASUREMENT_ID)).toBe(MEASUREMENT_ID);
    expect(validGaMeasurementId(` ${MEASUREMENT_ID} `)).toBe(MEASUREMENT_ID);
    for (const invalid of [
      undefined,
      "",
      "UA-123456-1",
      "G-short",
      "G-ABC123DEF45",
      "G-ABC123def4",
      'G-ABC123D"<F',
    ]) {
      expect(validGaMeasurementId(invalid)).toBeNull();
    }
  });

  it("serializes a valid id into a default-denied script and refuses invalid input", () => {
    expect(googleAnalyticsDefaultDeniedScript('G-BAD"</script>')).toBe("");
    expect(googleAnalyticsInitScript('G-BAD"</script>')).toBe("");

    const target: Record<string, unknown> = {};
    new Function("window", googleAnalyticsDefaultDeniedScript(MEASUREMENT_ID))(target);
    const dataLayer = target.dataLayer as IArguments[];
    expect(target[`ga-disable-${MEASUREMENT_ID}`]).toBe(true);
    expect(Array.from(dataLayer[0] ?? [])).toEqual([
      "consent",
      "default",
      expect.objectContaining({
        analytics_storage: "denied",
        ad_storage: "denied",
      }),
    ]);
    expect(googleAnalyticsDefaultDeniedScript(MEASUREMENT_ID)).toContain(
      JSON.stringify(MEASUREMENT_ID),
    );
  });

  it("grants and then immediately denies and disables on withdrawal", () => {
    const gtag = vi.fn();
    const target: { gtag: typeof gtag; [key: string]: unknown } = { gtag };

    expect(applyGoogleAnalyticsConsent(MEASUREMENT_ID, "accepted", target)).toBe(true);
    expect(target[`ga-disable-${MEASUREMENT_ID}`]).toBe(false);
    expect(gtag).toHaveBeenLastCalledWith(
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "granted", ad_storage: "denied" }),
    );

    expect(applyGoogleAnalyticsConsent(MEASUREMENT_ID, "declined", target)).toBe(true);
    expect(target[`ga-disable-${MEASUREMENT_ID}`]).toBe(true);
    expect(gtag).toHaveBeenLastCalledWith(
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "denied", ad_storage: "denied" }),
    );
  });

  it("maps cross-tab withdrawal and storage clearing to immediate denial", () => {
    expect(consentStateFromStorageEvent({ key: "vh-consent", newValue: "accepted" })).toBe(
      "accepted",
    );
    expect(consentStateFromStorageEvent({ key: "vh-consent", newValue: "declined" })).toBe(
      "declined",
    );
    expect(consentStateFromStorageEvent({ key: "vh-consent", newValue: null })).toBe("unset");
    expect(consentStateFromStorageEvent({ key: null, newValue: null })).toBe("unset");
    expect(consentStateFromStorageEvent({ key: "unrelated", newValue: "accepted" })).toBeNull();
  });

  it("takes same-tab withdrawal from the event even if persistence could not change", () => {
    expect(
      consentStateFromChangeEvent(
        new CustomEvent("vh-consent-change", { detail: { from: "accepted", to: "declined" } }),
      ),
    ).toBe("declined");
    expect(consentStateFromChangeEvent(new Event("vh-consent-change"))).toBeNull();
  });
});
