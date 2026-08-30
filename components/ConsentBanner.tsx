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
import { TruthClaim } from "@/components/TruthClaim";

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
        <TruthClaim id="truth-041">
          In this locally tested prototype, optional Google Analytics stays off until you allow it;
          declining leaves the core site available, and Analytics settings lets this browser change
          or withdraw its choice. The prototype may record that consent choice first-party without
          form content.
        </TruthClaim>
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
