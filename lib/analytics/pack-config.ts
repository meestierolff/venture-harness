import { CORE_JOURNEYS, EVENT_PACK_IDS, EVENT_PACKS, type EventPackId } from "./packs";
import { EVENTS, type Destination, type EventName } from "./taxonomy";

interface ConfiguredPack {
  stages?: unknown;
  capabilities_any?: unknown;
  required_destinations?: unknown;
  freshness_sources?: unknown;
  events?: unknown;
}

interface AnalyticsPackConfig {
  event_packs?: {
    active?: unknown;
    definitions?: Record<string, ConfiguredPack>;
  };
  core_journeys?: Record<
    string,
    {
      active?: unknown;
      required_packs?: unknown;
      start_events?: unknown;
      outcome_events?: unknown;
      authoritative_destination?: unknown;
    }
  >;
  data_freshness?: Record<string, unknown>;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

/** Return precise contract drift; callers decide whether to print or fail. */
export function validateEventPackConfig(config: unknown): string[] {
  const parsed = config as AnalyticsPackConfig;
  const failures: string[] = [];
  const definitions = parsed.event_packs?.definitions;
  const active = stringArray(parsed.event_packs?.active);
  if (!definitions) return ["event_packs.definitions is required"];
  if (!active) failures.push("event_packs.active must be a string array");

  const configuredIds = Object.keys(definitions);
  if (!sameMembers(configuredIds, EVENT_PACK_IDS)) {
    failures.push(
      `event pack IDs drift: config=[${configuredIds.sort().join(",")}] typed=[${[...EVENT_PACK_IDS].sort().join(",")}].`,
    );
  }
  for (const id of EVENT_PACK_IDS) {
    const configured = definitions[id];
    if (!configured) continue;
    const typed = EVENT_PACKS[id];
    for (const [field, expected] of [
      ["stages", typed.stages],
      ["capabilities_any", typed.capabilitiesAny],
      ["required_destinations", typed.requiredDestinations],
      ["freshness_sources", typed.freshnessSources],
      ["events", typed.events],
    ] as const) {
      const actual = stringArray(configured[field]);
      if (!actual || !sameMembers(actual, expected)) {
        failures.push(`${id}.${field} does not match lib/analytics/packs.ts.`);
      }
    }
  }
  for (const id of active ?? []) {
    if (!EVENT_PACK_IDS.includes(id as EventPackId))
      failures.push(`active event pack ${id} is unknown.`);
  }
  if (active && new Set(active).size !== active.length) {
    failures.push("event_packs.active contains duplicates.");
  }

  const configuredJourneyIds = Object.keys(parsed.core_journeys ?? {});
  const typedJourneyIds = Object.keys(CORE_JOURNEYS);
  if (!sameMembers(configuredJourneyIds, typedJourneyIds)) {
    failures.push(
      `core journey IDs drift: config=[${configuredJourneyIds.sort().join(",")}] typed=[${typedJourneyIds.sort().join(",")}].`,
    );
  }

  const assigned = new Set<EventName>();
  for (const pack of Object.values(EVENT_PACKS))
    pack.events.forEach((event) => assigned.add(event));
  for (const event of Object.keys(EVENTS) as EventName[]) {
    if (!assigned.has(event)) failures.push(`taxonomy event ${event} is not assigned to any pack.`);
  }

  for (const [journeyId, journey] of Object.entries(parsed.core_journeys ?? {})) {
    const typed = CORE_JOURNEYS[journeyId as keyof typeof CORE_JOURNEYS];
    if (!typed) continue;
    const configuredPacks = stringArray(journey.required_packs);
    const configuredStarts = stringArray(journey.start_events);
    const configuredOutcomes = stringArray(journey.outcome_events);
    if (!configuredPacks || !sameMembers(configuredPacks, typed.requiredPacks)) {
      failures.push(`${journeyId}.required_packs does not match lib/analytics/packs.ts.`);
    }
    if (!configuredStarts || !sameMembers(configuredStarts, typed.startEvents)) {
      failures.push(`${journeyId}.start_events does not match lib/analytics/packs.ts.`);
    }
    if (!configuredOutcomes || !sameMembers(configuredOutcomes, typed.outcomeEvents)) {
      failures.push(`${journeyId}.outcome_events does not match lib/analytics/packs.ts.`);
    }
    if (journey.active !== true) continue;
    const packs = stringArray(journey.required_packs);
    const starts = stringArray(journey.start_events);
    const outcomes = stringArray(journey.outcome_events);
    if (!packs || packs.some((pack) => !(active ?? []).includes(pack))) {
      failures.push(`${journeyId} requires an inactive or invalid event pack.`);
    }
    if (!starts || starts.some((event) => !(event in EVENTS))) {
      failures.push(`${journeyId} has an unknown start event.`);
    }
    if (!outcomes || outcomes.some((event) => !(event in EVENTS))) {
      failures.push(`${journeyId} has an unknown outcome event.`);
    }
    for (const outcome of outcomes ?? []) {
      if (outcome in EVENTS && !EVENTS[outcome as EventName].neon) {
        failures.push(`${journeyId} outcome ${outcome} is not first-party authoritative.`);
      }
    }
    if (journey.authoritative_destination !== "neon") {
      failures.push(`${journeyId} authoritative_destination must be neon.`);
    }
  }

  const freshness = parsed.data_freshness;
  if (!freshness || freshness.missing_is_zero !== false) {
    failures.push("data_freshness.missing_is_zero must be false.");
  }
  if (!freshness || freshness.status_required_for_active_sources !== true) {
    failures.push("data freshness status must be required for active sources.");
  }
  return failures;
}

export function analyticsDestinationsFromProviderStates(
  providerStates: Readonly<Record<string, string>>,
): Destination[] {
  const ready = new Set(["configured", "verified", "degraded"]);
  const destinations: Destination[] = [];
  if (ready.has(providerStates.vercel ?? providerStates.vercel_analytics ?? "")) {
    destinations.push("vercel");
  }
  if (ready.has(providerStates.google ?? providerStates.ga4 ?? "")) destinations.push("ga4");
  if (ready.has(providerStates.neon ?? "")) destinations.push("neon");
  return destinations;
}
