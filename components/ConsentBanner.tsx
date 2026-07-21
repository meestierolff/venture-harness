"use client";

/**
 * Strict-mode consent banner: equal-prominence accept/decline, reopenable
 * settings (footer link dispatches the open event), immediate withdrawal.
 * Consent events go first-party only (taxonomy destinations: neon).
 * Copy is governed by docs/brand/COPY.md (block consent.banner).
 */
import { useEffect, useState } from "react";
import { getConsent, setConsent, type ConsentState } from "@/lib/consent";
import { track } from "@/lib/analytics/track";

export const OPEN_CONSENT_SETTINGS_EVENT = "vh-open-consent-settings";

export function ConsentBanner() {
  const [state, setState] = useState<ConsentState>("unset");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const current = getConsent();
    setState(current);
    if (current === "unset") {
      setOpen(true);
      track("consent_banner_view");
    }
    const onOpenSettings = () => {
      setOpen(true);
      track("consent_settings_opened");
    };
    window.addEventListener(OPEN_CONSENT_SETTINGS_EVENT, onOpenSettings);
    return () => window.removeEventListener(OPEN_CONSENT_SETTINGS_EVENT, onOpenSettings);
  }, []);

  if (!open) return null;

  const decide = (to: "accepted" | "declined") => {
    const change = setConsent(to);
    setState(to);
    setOpen(false);
    track("consent_changed", { from_state: change.from, to_state: to });
    if (to === "accepted") track("analytics_accepted", { consent_scope: "analytics" });
    else if (change.withdrawal) track("consent_withdrawn");
    else track("analytics_declined");
  };

  return (
    <div role="dialog" aria-label="Analytics consent" className="consent-banner">
      <p>
        This site can use analytics (Google Analytics, Vercel Web Analytics) to understand which
        pages and offers matter. Nothing loads before you decide, declining changes nothing about
        how the site works, and you can change your choice anytime via &ldquo;Analytics
        settings&rdquo; in the footer.
      </p>
      <div className="consent-actions">
        <button type="button" onClick={() => decide("accepted")}>
          Allow analytics
        </button>
        <button type="button" onClick={() => decide("declined")}>
          {state === "accepted" ? "Withdraw consent" : "Decline"}
        </button>
      </div>
    </div>
  );
}

export function ConsentSettingsLink() {
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CONSENT_SETTINGS_EVENT))}
    >
      Analytics settings
    </button>
  );
}
