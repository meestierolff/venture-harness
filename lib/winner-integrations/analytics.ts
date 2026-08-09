/**
 * Installable Winner Loop measurement pack.
 *
 * This deliberately lives beside the general analytics taxonomy. A venture must
 * install and enable the capability pack before any Winner Loop event can be
 * recorded. Every event is first-party only: the pack exists to preserve an
 * auditable operational trail, not to leak creative inputs or customer data to
 * a behavioural analytics provider.
 */

export const WINNER_LOOP_EVENT_NAMES = [
  "creative_hypothesis_created",
  "creative_render_requested",
  "creative_render_completed",
  "creative_rights_reviewed",
  "creative_approved_for_organic",
  "organic_post_published",
  "organic_metric_snapshot",
  "winner_evaluation_completed",
  "boost_candidate_recommended",
  "paid_test_proposed",
  "spend_grant_approved",
  "spend_reserved",
  "paid_test_started",
  "paid_test_paused",
  "paid_test_completed",
  "attribution_evidence_recorded",
  "subscription_event_ingested",
  "cohort_snapshot_calculated",
  "creative_paid_proof",
  "creative_fatigued",
] as const;

export type WinnerLoopEventName = (typeof WINNER_LOOP_EVENT_NAMES)[number];
export type WinnerLoopEventDestination = "first_party_evidence";

export interface WinnerLoopEventProperties {
  creative_hypothesis_created: {
    hypothesis_id: string;
    creative_family_id: string;
    hypothesis_version: string;
  };
  creative_render_requested: {
    creative_id: string;
    render_job_id: string;
    renderer_kind: string;
  };
  creative_render_completed: {
    creative_id: string;
    render_job_id: string;
    asset_manifest_id: string;
    render_status: "completed" | "failed";
  };
  creative_rights_reviewed: {
    creative_id: string;
    manifest_id: string;
    rights_status: "approved_organic" | "approved_paid" | "blocked" | "expired";
    reviewer_role: string;
  };
  creative_approved_for_organic: {
    creative_id: string;
    manifest_id: string;
    review_mode: "human";
  };
  organic_post_published: {
    creative_id: string;
    publication_id: string;
    provider_kind: string;
    publication_mode: "direct";
  };
  organic_metric_snapshot: {
    creative_id: string;
    snapshot_id: string;
    offset_minutes: number;
    metric_count: number;
    data_quality: "complete" | "partial" | "thresholded" | "unavailable";
  };
  winner_evaluation_completed: {
    creative_id: string;
    recommendation_id: string;
    scoring_version: string;
    recommendation: string;
    confidence: "none" | "low" | "medium" | "high";
  };
  boost_candidate_recommended: {
    creative_id: string;
    recommendation_id: string;
    baseline_definition_id: string;
  };
  paid_test_proposed: {
    creative_id: string;
    proposal_id: string;
    network_kind: string;
    hard_cap_minor: number;
    currency: string;
  };
  spend_grant_approved: {
    grant_id: string;
    proposal_id: string;
    approved_cap_minor: number;
    currency: string;
    approval_mode: "human";
  };
  spend_reserved: {
    grant_id: string;
    reservation_id: string;
    reserved_minor: number;
    currency: string;
  };
  paid_test_started: {
    creative_id: string;
    paid_test_id: string;
    grant_id: string;
    network_kind: string;
  };
  paid_test_paused: {
    creative_id: string;
    paid_test_id: string;
    pause_reason: string;
  };
  paid_test_completed: {
    creative_id: string;
    paid_test_id: string;
    outcome: "completed" | "stopped" | "inconclusive";
  };
  attribution_evidence_recorded: {
    creative_id: string;
    attribution_id: string;
    attribution_class: string;
    attribution_provider_kind: string;
    window_hours: number;
  };
  subscription_event_ingested: {
    subscription_event_id: string;
    event_type: string;
    environment: "sandbox" | "production";
    currency: string;
  };
  cohort_snapshot_calculated: {
    creative_id: string;
    cohort_window: string;
    attribution_class: string;
    subscriber_count: number;
    data_quality: "complete" | "partial" | "unavailable";
  };
  creative_paid_proof: {
    creative_id: string;
    proof_id: string;
    attribution_class: string;
    net_revenue_minor: number;
    currency: string;
  };
  creative_fatigued: {
    creative_id: string;
    fatigue_evaluation_id: string;
    evidence_window: string;
    action: "recommend_pause" | "paused";
  };
}

type EventPropertyName<Name extends WinnerLoopEventName> = Extract<
  keyof WinnerLoopEventProperties[Name],
  string
>;

export interface WinnerLoopEventSpec<Name extends WinnerLoopEventName> {
  readonly name: Name;
  readonly destinations: readonly WinnerLoopEventDestination[];
  readonly allowedProperties: readonly EventPropertyName<Name>[];
  readonly piiAllowed: false;
  readonly rawCreativeContentAllowed: false;
  readonly providerProvenanceRequired: true;
}

function spec<Name extends WinnerLoopEventName>(
  name: Name,
  allowedProperties: readonly EventPropertyName<Name>[],
): WinnerLoopEventSpec<Name> {
  return Object.freeze({
    name,
    destinations: Object.freeze(["first_party_evidence"] as const),
    allowedProperties: Object.freeze([...allowedProperties]),
    piiAllowed: false,
    rawCreativeContentAllowed: false,
    providerProvenanceRequired: true,
  });
}

export const WINNER_LOOP_EVENT_SPECS = Object.freeze({
  creative_hypothesis_created: spec("creative_hypothesis_created", [
    "hypothesis_id",
    "creative_family_id",
    "hypothesis_version",
  ]),
  creative_render_requested: spec("creative_render_requested", [
    "creative_id",
    "render_job_id",
    "renderer_kind",
  ]),
  creative_render_completed: spec("creative_render_completed", [
    "creative_id",
    "render_job_id",
    "asset_manifest_id",
    "render_status",
  ]),
  creative_rights_reviewed: spec("creative_rights_reviewed", [
    "creative_id",
    "manifest_id",
    "rights_status",
    "reviewer_role",
  ]),
  creative_approved_for_organic: spec("creative_approved_for_organic", [
    "creative_id",
    "manifest_id",
    "review_mode",
  ]),
  organic_post_published: spec("organic_post_published", [
    "creative_id",
    "publication_id",
    "provider_kind",
    "publication_mode",
  ]),
  organic_metric_snapshot: spec("organic_metric_snapshot", [
    "creative_id",
    "snapshot_id",
    "offset_minutes",
    "metric_count",
    "data_quality",
  ]),
  winner_evaluation_completed: spec("winner_evaluation_completed", [
    "creative_id",
    "recommendation_id",
    "scoring_version",
    "recommendation",
    "confidence",
  ]),
  boost_candidate_recommended: spec("boost_candidate_recommended", [
    "creative_id",
    "recommendation_id",
    "baseline_definition_id",
  ]),
  paid_test_proposed: spec("paid_test_proposed", [
    "creative_id",
    "proposal_id",
    "network_kind",
    "hard_cap_minor",
    "currency",
  ]),
  spend_grant_approved: spec("spend_grant_approved", [
    "grant_id",
    "proposal_id",
    "approved_cap_minor",
    "currency",
    "approval_mode",
  ]),
  spend_reserved: spec("spend_reserved", [
    "grant_id",
    "reservation_id",
    "reserved_minor",
    "currency",
  ]),
  paid_test_started: spec("paid_test_started", [
    "creative_id",
    "paid_test_id",
    "grant_id",
    "network_kind",
  ]),
  paid_test_paused: spec("paid_test_paused", ["creative_id", "paid_test_id", "pause_reason"]),
  paid_test_completed: spec("paid_test_completed", ["creative_id", "paid_test_id", "outcome"]),
  attribution_evidence_recorded: spec("attribution_evidence_recorded", [
    "creative_id",
    "attribution_id",
    "attribution_class",
    "attribution_provider_kind",
    "window_hours",
  ]),
  subscription_event_ingested: spec("subscription_event_ingested", [
    "subscription_event_id",
    "event_type",
    "environment",
    "currency",
  ]),
  cohort_snapshot_calculated: spec("cohort_snapshot_calculated", [
    "creative_id",
    "cohort_window",
    "attribution_class",
    "subscriber_count",
    "data_quality",
  ]),
  creative_paid_proof: spec("creative_paid_proof", [
    "creative_id",
    "proof_id",
    "attribution_class",
    "net_revenue_minor",
    "currency",
  ]),
  creative_fatigued: spec("creative_fatigued", [
    "creative_id",
    "fatigue_evaluation_id",
    "evidence_window",
    "action",
  ]),
} satisfies {
  [Name in WinnerLoopEventName]: WinnerLoopEventSpec<Name>;
});

export interface WinnerLoopProviderProvenance {
  readonly adapterKind: string;
  readonly evidenceRef: string;
  readonly fixture: boolean;
}

type WinnerLoopEventVariant<Name extends WinnerLoopEventName> = Readonly<{
  name: Name;
  schemaVersion: 1;
  eventId: string;
  ventureId: string;
  occurredAt: string;
  providerProvenance: WinnerLoopProviderProvenance;
  properties: Readonly<WinnerLoopEventProperties[Name]>;
}>;

export type WinnerLoopEvent = {
  [Name in WinnerLoopEventName]: WinnerLoopEventVariant<Name>;
}[WinnerLoopEventName];

export interface WinnerLoopEventPack {
  readonly id: "winner_loop";
  readonly version: 1;
  readonly installable: true;
  readonly enabledByDefault: false;
  readonly activationCapability: "winner_loop";
  readonly events: typeof WINNER_LOOP_EVENT_SPECS;
}

export const WINNER_LOOP_EVENT_PACK: WinnerLoopEventPack = Object.freeze({
  id: "winner_loop",
  version: 1,
  installable: true,
  enabledByDefault: false,
  activationCapability: "winner_loop",
  events: WINNER_LOOP_EVENT_SPECS,
});

export class WinnerLoopAnalyticsError extends Error {
  constructor(
    readonly code:
      | "pack_not_installed"
      | "pack_not_enabled"
      | "pack_version_conflict"
      | "event_spec_drift"
      | "unsafe_event_payload",
    message: string,
  ) {
    super(message);
    this.name = "WinnerLoopAnalyticsError";
  }
}

const FORBIDDEN_FIELD =
  /(^|_)(email|phone|full_name|first_name|last_name|customer_name|prompt|script|storyboard|message|credential|secret|token|password|private_asset|asset_content|raw_content|user_content)(_|$)/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:\+|00)[1-9][0-9 ()-]{7,}/u;
const CREDENTIAL_VALUE =
  /(cred:\/\/|bearer\s+[a-z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|pk)_(?:live|test)_[a-z0-9]+)/iu;
const SAFE_EVENT_TOKEN = /^[a-z0-9][a-z0-9_.:/-]*$/iu;

function unsafeValue(value: unknown, path: string): string | null {
  if (FORBIDDEN_FIELD.test(path)) return `forbidden field ${path}`;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : `non-finite number at ${path}`;
  }
  if (typeof value === "string") {
    if (value.length === 0 || value.length > 256) return `unsafe string length at ${path}`;
    if (EMAIL.test(value)) return `email-like value at ${path}`;
    if (PHONE.test(value)) return `phone-like value at ${path}`;
    if (CREDENTIAL_VALUE.test(value)) return `credential-like value at ${path}`;
    if (!SAFE_EVENT_TOKEN.test(value)) {
      return `free-text or personal value at ${path}; Winner Loop analytics accepts tokens only`;
    }
    return null;
  }
  if (typeof value === "boolean" || value === null) return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = unsafeValue(item, `${path}[${index}]`);
      if (issue) return issue;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const issue = unsafeValue(item, path ? `${path}.${key}` : key);
      if (issue) return issue;
    }
    return null;
  }
  return `unsupported value at ${path}`;
}

export function assertWinnerLoopEventPackParity(): void {
  const declared = Object.keys(WINNER_LOOP_EVENT_SPECS).sort();
  const canonical = [...WINNER_LOOP_EVENT_NAMES].sort();
  if (JSON.stringify(declared) !== JSON.stringify(canonical)) {
    throw new WinnerLoopAnalyticsError(
      "event_spec_drift",
      "Winner Loop event names and runtime specifications differ",
    );
  }
  for (const name of WINNER_LOOP_EVENT_NAMES) {
    const eventSpec = WINNER_LOOP_EVENT_SPECS[name];
    if (
      eventSpec.name !== name ||
      new Set(eventSpec.allowedProperties).size !== eventSpec.allowedProperties.length ||
      eventSpec.destinations.length !== 1 ||
      eventSpec.destinations[0] !== "first_party_evidence" ||
      eventSpec.piiAllowed !== false ||
      eventSpec.rawCreativeContentAllowed !== false
    ) {
      throw new WinnerLoopAnalyticsError(
        "event_spec_drift",
        `Winner Loop event specification ${name} violates pack invariants`,
      );
    }
  }
}

export function assertWinnerLoopEventSafe(event: WinnerLoopEvent): void {
  const candidate = event as WinnerLoopEventVariant<WinnerLoopEventName>;
  const eventSpec = WINNER_LOOP_EVENT_SPECS[candidate.name];
  if (!eventSpec) {
    throw new WinnerLoopAnalyticsError(
      "unsafe_event_payload",
      `Unknown Winner Loop event ${(candidate as { name?: unknown }).name ?? "<missing>"}`,
    );
  }
  if (
    candidate.schemaVersion !== 1 ||
    !candidate.eventId ||
    !candidate.ventureId ||
    !Number.isFinite(Date.parse(candidate.occurredAt))
  ) {
    throw new WinnerLoopAnalyticsError(
      "unsafe_event_payload",
      `Winner Loop event ${candidate.name} has an invalid envelope`,
    );
  }
  const actual = Object.keys(candidate.properties).sort();
  const allowed = [...eventSpec.allowedProperties].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    throw new WinnerLoopAnalyticsError(
      "unsafe_event_payload",
      `Winner Loop event ${candidate.name} properties do not match its typed allowlist`,
    );
  }
  const issue = unsafeValue(
    {
      eventId: candidate.eventId,
      ventureId: candidate.ventureId,
      providerProvenance: candidate.providerProvenance,
      properties: candidate.properties,
    },
    "event",
  );
  if (issue) {
    throw new WinnerLoopAnalyticsError(
      "unsafe_event_payload",
      `Winner Loop event ${candidate.name} rejected: ${issue}`,
    );
  }
}

export interface WinnerLoopEventRuntime {
  install(pack?: WinnerLoopEventPack): void;
  enable(): void;
  disable(): void;
  isInstalled(): boolean;
  isEnabled(): boolean;
  emit(event: WinnerLoopEvent): WinnerLoopEvent;
  recorded(): readonly WinnerLoopEvent[];
}

export function createWinnerLoopEventRuntime(
  options: {
    sink?: (event: WinnerLoopEvent) => void;
  } = {},
): WinnerLoopEventRuntime {
  let installedVersion: number | null = null;
  let enabled = false;
  const events: WinnerLoopEvent[] = [];

  return Object.freeze({
    install(pack: WinnerLoopEventPack = WINNER_LOOP_EVENT_PACK): void {
      assertWinnerLoopEventPackParity();
      if (installedVersion !== null && installedVersion !== pack.version) {
        throw new WinnerLoopAnalyticsError(
          "pack_version_conflict",
          `winner_loop v${installedVersion} is already installed; refusing v${pack.version}`,
        );
      }
      installedVersion = pack.version;
    },
    enable(): void {
      if (installedVersion === null) {
        throw new WinnerLoopAnalyticsError(
          "pack_not_installed",
          "Install the winner_loop event pack before enabling it",
        );
      }
      enabled = true;
    },
    disable(): void {
      enabled = false;
    },
    isInstalled: () => installedVersion !== null,
    isEnabled: () => enabled,
    emit(event: WinnerLoopEvent): WinnerLoopEvent {
      if (!enabled) {
        throw new WinnerLoopAnalyticsError(
          "pack_not_enabled",
          "winner_loop is not enabled; no event was recorded",
        );
      }
      assertWinnerLoopEventSafe(event);
      const stored = Object.freeze({
        ...event,
        providerProvenance: Object.freeze({ ...event.providerProvenance }),
        properties: Object.freeze({ ...event.properties }),
      }) as WinnerLoopEvent;
      events.push(stored);
      options.sink?.(stored);
      return stored;
    },
    recorded: () => Object.freeze([...events]),
  });
}
