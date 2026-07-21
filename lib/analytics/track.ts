/**
 * The ONLY sanctioned path to analytics. Enforces, at the transport layer:
 *  - taxonomy membership (typed event names)
 *  - allowed-properties filtering (unknown keys are dropped, not sent)
 *  - consent gating for every third-party destination
 *  - first-party evidence delivery that survives page unloads
 *
 * Never throws; a broken analytics pipe must never break the page.
 * Direct gtag calls elsewhere fail lint and pnpm verify:consent.
 */
import { EVENTS, type EventName, type EventProps, type EventSpec } from "./taxonomy";
import { hasAnalyticsConsent } from "../consent";
import { getVisitorId } from "../visitor";

interface TrackOptions {
  /** Set false when the server already persisted the neon leg. */
  neon?: boolean;
}

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    va?: (event: string, properties?: Record<string, unknown>) => void;
  }
}

function filterProps(name: EventName, props: EventProps): EventProps {
  const allowed = new Set<string>(EVENTS[name].props);
  const clean: EventProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (allowed.has(key)) clean[key] = value;
  }
  return clean;
}

export function track(name: EventName, props: EventProps = {}, options: TrackOptions = {}): void {
  try {
    // Widen to EventSpec: the per-event literal tuples otherwise collapse
    // Array.includes' parameter to never across the union.
    const spec: EventSpec = EVENTS[name];
    if (!spec) return;
    const clean = filterProps(name, props);
    const consented = hasAnalyticsConsent();

    // Consent requirement for recording the event at all.
    if (spec.consent === "analytics" && !consented) return;

    if (process.env.NODE_ENV !== "production") {
      console.debug(`[track] ${name}`, clean);
    }

    // Third-party destinations: only ever after consent, regardless of the
    // event's own consent requirement.
    if (
      consented &&
      spec.destinations.includes("ga4") &&
      typeof window !== "undefined" &&
      window.gtag
    ) {
      window.gtag("event", name, clean);
    }
    if (
      consented &&
      spec.destinations.includes("vercel") &&
      typeof window !== "undefined" &&
      window.va
    ) {
      window.va("event", { name, ...clean });
    }

    // First-party evidence (Layer 3): consent-independent, anonymous id.
    if (spec.neon && options.neon !== false && typeof window !== "undefined") {
      const payload = JSON.stringify({
        event: name,
        visitor_id: getVisitorId(),
        props: clean,
      });
      // sendBeacon survives unloads; fetch(keepalive) is the fallback.
      const sent =
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon("/api/evidence", new Blob([payload], { type: "application/json" }));
      if (!sent) {
        void fetch("/api/evidence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => undefined);
      }
    }
  } catch {
    // Analytics must never break the page.
  }
}
