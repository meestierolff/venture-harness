import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CORE_JOURNEYS,
  EVENT_PACK_IDS,
  EVENT_PACKS,
  analyticsDestinationsFromProviderStates,
  eventNamesForPacks,
  resolveActiveEventPacks,
  resolveActiveCoreJourneys,
  validateEventPackConfig,
  validateMeasurementPlan,
} from "@/lib/analytics";
import { EVENTS } from "@/lib/analytics/taxonomy";

const analyticsConfig = parse(readFileSync("config/analytics.yaml", "utf8")) as unknown;

describe("analytics event packs", () => {
  it("keeps YAML pack metadata and the typed registry in lockstep", () => {
    expect(validateEventPackConfig(analyticsConfig)).toEqual([]);
    expect(EVENT_PACK_IDS).toEqual([
      "core_product",
      "web_acquisition",
      "lead_generation",
      "onboarding",
      "authentication",
      "subscription",
      "one_time_payment",
      "content",
      "experiment",
      "mobile",
      "feedback",
      "reliability",
    ]);
  });

  it("assigns every typed event to at least one reusable pack", () => {
    const packed = new Set(Object.values(EVENT_PACKS).flatMap((pack) => [...pack.events]));
    expect([...Object.keys(EVENTS)].filter((event) => !packed.has(event as never))).toEqual([]);
  });

  it("does not require an inactive pack at any current tracking call site", () => {
    const config = analyticsConfig as { event_packs: { active: (keyof typeof EVENT_PACKS)[] } };
    const activeEvents = new Set(eventNamesForPacks(config.event_packs.active));
    const sources = readdirSync("components")
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => readFileSync(`components/${file}`, "utf8"));
    const calls = sources.flatMap((source) =>
      [...source.matchAll(/track\(\s*["']([a-z0-9_]+)["']/g)].map((match) => match[1]),
    );
    expect(calls.filter((event) => !activeEvents.has(event as never))).toEqual([]);
  });

  it("selects the smallest capability-relevant set and leaves experiments explicit", () => {
    expect(
      resolveActiveEventPacks({
        capabilities: ["public_website", "web_seo_aeo_geo", "feedback_intake"],
        appKind: "web",
        monetizationModel: "services",
      }),
    ).toEqual([
      "core_product",
      "web_acquisition",
      "lead_generation",
      "content",
      "feedback",
      "reliability",
    ]);

    const ios = resolveActiveEventPacks({
      capabilities: ["revenuecat", "app_store_connect", "eas", "feedback_intake"],
      appKind: "hybrid",
      monetizationModel: "subscription",
    });
    expect(ios).toEqual(["core_product", "subscription", "mobile", "feedback", "reliability"]);
    expect(ios).not.toContain("experiment");
    expect(eventNamesForPacks(ios)).not.toContain("authentication_succeeded");
  });

  it("proves active core journeys have starts and first-party outcomes", () => {
    const activePacks = ["core_product", "lead_generation", "reliability"] as const;
    expect(
      validateMeasurementPlan({
        activePacks,
        activeJourneys: ["core_product", "lead_generation"],
        configuredDestinations: ["ga4", "neon"],
        freshness: {
          ga4: "fresh",
          neon_commercial_evidence: "fresh",
          release_log: "fresh",
        },
      }),
    ).toEqual([]);
    for (const journey of Object.values(CORE_JOURNEYS)) {
      for (const event of journey.outcomeEvents) expect(EVENTS[event].neon).toBe(true);
    }
  });

  it("derives active journeys from the routed packs", () => {
    expect(
      resolveActiveCoreJourneys([
        "core_product",
        "authentication",
        "onboarding",
        "subscription",
        "reliability",
      ]),
    ).toEqual(["core_product", "authenticated_product", "subscription"]);
  });

  it("returns exact destination and freshness gaps instead of silently skipping", () => {
    const issues = validateMeasurementPlan({
      activePacks: ["core_product", "web_acquisition"],
      activeJourneys: ["core_product"],
      configuredDestinations: ["neon"],
      freshness: { neon_commercial_evidence: "fresh" },
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      "destination_unconfigured",
      "destination_unconfigured",
      "freshness_unknown",
    ]);
    expect(issues.every((issue) => issue.nextAction.length > 20)).toBe(true);
  });

  it("derives analytics destinations only from usable provider lifecycle states", () => {
    expect(
      analyticsDestinationsFromProviderStates({
        vercel: "configured",
        google: "auth_required",
        neon: "verified",
      }),
    ).toEqual(["vercel", "neon"]);
  });

  it("keeps every pack free of PII and raw form values", () => {
    for (const pack of Object.values(EVENT_PACKS)) {
      expect(pack.privacy.piiAllowed).toBe(false);
      expect(pack.privacy.rawFormValuesAllowed).toBe(false);
    }
  });
});
