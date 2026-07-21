"use client";

/**
 * The single, consent-gated loader for third-party analytics.
 * Strict mode: NOTHING third-party loads before consent === "accepted".
 * Withdrawal removes GA cookies' future use by disabling on next state
 * change (gtag consent update) — and no further events are sent because
 * lib/analytics/track.ts checks consent per call.
 *
 * verify-consent.ts asserts GA appears only in this file, behind the gate.
 */
import { useEffect, useState } from "react";
import Script from "next/script";
import { CONSENT_CHANGE_EVENT, getConsent } from "@/lib/consent";

const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
const VERCEL_ENABLED = process.env.NEXT_PUBLIC_VERCEL_ANALYTICS_ENABLED === "true";

export function AnalyticsScripts() {
  const [consent, setConsentState] = useState<"unset" | "accepted" | "declined">("unset");

  useEffect(() => {
    setConsentState(getConsent());
    const onChange = () => setConsentState(getConsent());
    window.addEventListener(CONSENT_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_CHANGE_EVENT, onChange);
  }, []);

  if (consent !== "accepted") return null; // strict mode: the gate

  return (
    <>
      {GA_ID ? (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
            strategy="afterInteractive"
          />
          <Script id="ga-init" strategy="afterInteractive">
            {`window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              window.gtag = gtag;
              gtag('js', new Date());
              gtag('config', '${GA_ID}', {
                send_page_view: false,           /* manual page_view prevents duplicates */
                allow_google_signals: false,     /* advertising features off */
                allow_ad_personalization_signals: false
              });`}
          </Script>
        </>
      ) : null}
      {VERCEL_ENABLED ? (
        <Script src="/_vercel/insights/script.js" strategy="afterInteractive" data-mode="auto" />
      ) : null}
    </>
  );
}
