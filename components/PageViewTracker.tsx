"use client";

/**
 * Manual page_view / route_change tracking for App Router client-side
 * navigation. GA is configured with send_page_view: false, so this is the
 * only pageview source — no duplicates. Referrers are reduced to domain
 * only before leaving the browser.
 */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { track } from "@/lib/analytics/track";

function referrerDomain(): string {
  try {
    return document.referrer ? new URL(document.referrer).hostname : "";
  } catch {
    return "";
  }
}

export function PageViewTracker() {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (previous.current === null) {
      const params = new URLSearchParams(window.location.search);
      track("site_visit", {
        landing_route: pathname,
        referrer_domain: referrerDomain(),
        utm_source: params.get("utm_source") ?? "",
        utm_medium: params.get("utm_medium") ?? "",
        utm_campaign: params.get("utm_campaign") ?? "",
      });
      track("landing_page_view", {
        route: pathname,
        referrer_domain: referrerDomain(),
        utm_source: params.get("utm_source") ?? "",
        utm_medium: params.get("utm_medium") ?? "",
        utm_campaign: params.get("utm_campaign") ?? "",
      });
    } else if (previous.current !== pathname) {
      track("route_change", { from_route: previous.current, to_route: pathname });
    }
    track("page_view", { route: pathname });
    previous.current = pathname;
  }, [pathname]);

  return null;
}
