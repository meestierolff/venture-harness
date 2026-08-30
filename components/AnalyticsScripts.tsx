"use client";

/**
 * The single consent boundary for third-party analytics. A valid GA4
 * measurement id gets an inline, first-party default-denied command before
 * any external loader. Grant and withdrawal are then applied synchronously on
 * the consent event; all normal events remain gated again in track.ts.
 */
import { useEffect, useState } from "react";
import Script from "next/script";
import {
  CONSENT_CHANGE_EVENT,
  CONSENT_STORAGE_KEY,
  consentStateFromStoredValue,
  getConsent,
  type ConsentState,
} from "@/lib/consent";

type GoogleAnalyticsTarget = {
  gtag?: (...args: unknown[]) => void;
  [key: string]: unknown;
};

const DENIED_CONSENT = {
  ad_personalization: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  analytics_storage: "denied",
};

const GRANTED_ANALYTICS_CONSENT = {
  ...DENIED_CONSENT,
  analytics_storage: "granted",
};

export function validGaMeasurementId(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && /^G-[A-Z0-9]{10}$/u.test(candidate) ? candidate : null;
}

export function googleAnalyticsDefaultDeniedScript(measurementId: string): string {
  const validId = validGaMeasurementId(measurementId);
  if (!validId) return "";
  const serializedId = JSON.stringify(validId);
  const serializedConsent = JSON.stringify({ ...DENIED_CONSENT, wait_for_update: 500 });
  return `(function(){var id=${serializedId};window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};window["ga-disable-"+id]=true;window.gtag("consent","default",${serializedConsent});})();`;
}

export function googleAnalyticsInitScript(measurementId: string): string {
  const validId = validGaMeasurementId(measurementId);
  if (!validId) return "";
  const serializedId = JSON.stringify(validId);
  const serializedConfig = JSON.stringify({
    allow_ad_personalization_signals: false,
    allow_google_signals: false,
    send_page_view: false,
  });
  return `(function(){var id=${serializedId};window.gtag("js",new Date());window.gtag("config",id,${serializedConfig});})();`;
}

export function applyGoogleAnalyticsConsent(
  measurementId: string,
  consent: ConsentState,
  target: GoogleAnalyticsTarget = window as unknown as GoogleAnalyticsTarget,
): boolean {
  const validId = validGaMeasurementId(measurementId);
  if (!validId) return false;
  const accepted = consent === "accepted";
  target[`ga-disable-${validId}`] = !accepted;
  target.gtag?.("consent", "update", accepted ? GRANTED_ANALYTICS_CONSENT : DENIED_CONSENT);
  return true;
}

export function consentStateFromStorageEvent(
  event: Pick<StorageEvent, "key" | "newValue">,
): ConsentState | null {
  if (event.key === null) return "unset";
  return event.key === CONSENT_STORAGE_KEY ? consentStateFromStoredValue(event.newValue) : null;
}

export function consentStateFromChangeEvent(event: Event): ConsentState | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as { to?: unknown } | null;
  return detail?.to === "accepted" || detail?.to === "declined" ? detail.to : null;
}

const GA_ID = validGaMeasurementId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);

export function AnalyticsScripts() {
  const [consent, setConsentState] = useState<ConsentState>("unset");

  useEffect(() => {
    const applyConsent = (next: ConsentState) => {
      if (GA_ID) applyGoogleAnalyticsConsent(GA_ID, next);
      setConsentState(next);
    };
    const syncConsent = (event: Event) => {
      applyConsent(consentStateFromChangeEvent(event) ?? getConsent());
    };
    const syncConsentFromStorage = (event: StorageEvent) => {
      const next = consentStateFromStorageEvent(event);
      if (next !== null) applyConsent(next);
    };
    applyConsent(getConsent());
    window.addEventListener(CONSENT_CHANGE_EVENT, syncConsent);
    window.addEventListener("storage", syncConsentFromStorage);
    return () => {
      window.removeEventListener(CONSENT_CHANGE_EVENT, syncConsent);
      window.removeEventListener("storage", syncConsentFromStorage);
    };
  }, []);

  if (!GA_ID) return null;

  return (
    <>
      <script
        id="ga-consent-default"
        dangerouslySetInnerHTML={{ __html: googleAnalyticsDefaultDeniedScript(GA_ID) }}
      />
      {consent === "accepted" ? (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`}
            strategy="afterInteractive"
          />
          <Script id="ga-init" strategy="afterInteractive">
            {googleAnalyticsInitScript(GA_ID)}
          </Script>
        </>
      ) : null}
    </>
  );
}
