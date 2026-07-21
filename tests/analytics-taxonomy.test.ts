/**
 * Taxonomy invariants — the executable form of the analytics contract.
 * Cross-file lockstep with config/analytics.yaml is additionally enforced
 * by scripts/verify-analytics-events.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { EVENTS, type EventSpec } from "@/lib/analytics/taxonomy";

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
    ] as const) {
      expect(EVENTS[name].props).toContain("displayed_price");
      expect(EVENTS[name].neon).toBe(true);
    }
  });

  it("matches the event names declared in config/analytics.yaml", () => {
    expect(Object.keys(EVENTS).sort()).toEqual(Object.keys(config.events).sort());
  });
});
