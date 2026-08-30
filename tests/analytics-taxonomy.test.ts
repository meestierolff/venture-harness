/**
 * Taxonomy invariants — the executable form of the analytics contract.
 * Cross-file lockstep with config/analytics.yaml is additionally enforced
 * by scripts/verify-analytics-events.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { EVENTS, type EventSpec } from "@/lib/analytics/taxonomy";
import { filterAnalyticsProps } from "@/lib/analytics/track";
import { safeLandingAttribution } from "@/lib/analytics/attribution";
import { isSafeAnalyticsProperty } from "@/lib/analytics/safe-value";

const config = parse(readFileSync("config/analytics.yaml", "utf8")) as {
  prohibited_properties: string[];
  events: Record<string, { destinations: string[] }>;
};

describe("event taxonomy", () => {
  it("keeps the neon flag consistent with destinations", () => {
    for (const [name, spec] of Object.entries(EVENTS) as [string, EventSpec][]) {
      expect(spec.neon, `${name}: neon flag vs destinations`).toBe(
        spec.destinations.includes("neon"),
      );
    }
  });

  it("routes consent events to first-party storage only", () => {
    for (const [name, spec] of Object.entries(EVENTS) as [string, EventSpec][]) {
      if (name.startsWith("consent_") || name.startsWith("analytics_")) {
        expect(spec.destinations, `${name} must be neon-only`).toEqual(["neon"]);
        expect(spec.consent).toBe("none");
      }
    }
  });

  it("never allows a prohibited property on any event", () => {
    const prohibited = new Set(config.prohibited_properties.map((p) => p.toLowerCase()));
    for (const [name, spec] of Object.entries(EVENTS) as [string, EventSpec][]) {
      for (const prop of spec.props) {
        expect(prohibited.has(prop.toLowerCase()), `${name} allows prohibited "${prop}"`).toBe(
          false,
        );
      }
    }
  });

  it("gives every pre-consent third-party event a first-party leg", () => {
    for (const [name, spec] of Object.entries(EVENTS) as [string, EventSpec][]) {
      if (spec.consent === "none" && spec.destinations.includes("ga4")) {
        expect(spec.destinations.includes("neon"), `${name} needs a neon leg`).toBe(true);
      }
    }
  });

  it("stores displayed_price on every price-bearing evidence event", () => {
    for (const name of [
      "pricing_variant_exposed",
      "plan_selected",
      "monthly_plan_selected",
      "annual_plan_selected",
      "pilot_selected",
      "checkout_intent",
      "reservation_intent",
      "subscription_checkout_started",
      "subscription_started",
      "one_time_checkout_started",
      "one_time_payment_completed",
      "mobile_store_subscription_started",
    ] as const) {
      expect(EVENTS[name].props).toContain("displayed_price");
      expect(EVENTS[name].neon).toBe(true);
    }
  });

  it("matches the event names declared in config/analytics.yaml", () => {
    expect(Object.keys(EVENTS).sort()).toEqual(Object.keys(config.events).sort());
  });

  it("drops URL-derived private, credential-like, oversized, and unknown values", () => {
    expect(
      filterAnalyticsProps("site_visit", {
        landing_route: "/",
        referrer_domain: "person@example.test",
        utm_source: "api_key=private-canary",
        utm_medium: "x".repeat(301),
        utm_campaign: "Jane Founder",
        unregistered: "must-not-leave",
      }),
    ).toEqual({ landing_route: "/" });
    expect(filterAnalyticsProps("site_visit", { utm_source: "+31612345678" })).toEqual({});
    expect(filterAnalyticsProps("site_visit", { utm_source: "31612345678" })).toEqual({});
    expect(filterAnalyticsProps("site_visit", { utm_source: "jane" })).toEqual({});
  });

  it("rejects a malformed route without ambiguous backtracking", () => {
    const started = performance.now();
    expect(isSafeAnalyticsProperty("landing_route", `/${"a".repeat(28)}?`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("does not forward unreviewed URL attribution values", () => {
    expect(
      safeLandingAttribution(
        "?utm_source=Jane+Founder&utm_medium=%2B31612345678&utm_campaign=12+Main+Street",
        "https://person@example.test/private",
      ),
    ).toEqual({});
  });
});
