/**
 * Layer 3 evidence intake: experiment lifecycle, commercial intent,
 * consent ledger. Anonymous visitor id only — personal data is rejected by
 * schema (unknown keys refused, prohibited keys refused). Pricing events
 * must carry the exact displayed_price string.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { EVENTS, type EventName } from "@/lib/analytics/taxonomy";
import { readBoundedJson, validatePublicJsonRequest } from "@/lib/bounded-json";
import { persistEvidence } from "@/lib/evidence-store";
import { allowRequest, clientRateLimitKey } from "@/lib/rate-limit";
import { isSafeAnalyticsProperty } from "@/lib/analytics/safe-value";
import { VISITOR_ID_PATTERN } from "@/lib/visitor-id";

const EVIDENCE_BODY_MAX_BYTES = 16_384;
const MAX_PROP_KEYS = 32;

const PRICE_REQUIRED = new Set<EventName>([
  "pricing_variant_exposed",
  "plan_selected",
  "monthly_plan_selected",
  "annual_plan_selected",
  "pilot_selected",
  "checkout_intent",
  "reservation_intent",
]);

const PUBLIC_EVIDENCE_PROPS = {
  consent_banner_view: [],
  analytics_accepted: ["consent_scope"],
  analytics_declined: [],
  consent_settings_opened: [],
  consent_changed: ["from_state", "to_state"],
  consent_withdrawn: [],
} as const satisfies Partial<Record<EventName, readonly string[]>>;

const propKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);
const propsSchema = z
  .record(propKeySchema, z.union([z.string().max(300), z.number().finite(), z.boolean()]))
  .superRefine((props, context) => {
    if (Object.keys(props).length > MAX_PROP_KEYS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "too many properties" });
    }
    for (const [key, value] of Object.entries(props)) {
      if (!isSafeAnalyticsProperty(key, value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "evidence property does not match its reviewed non-private shape",
        });
      }
    }
  });

const bodySchema = z
  .object({
    event: z.string().min(1).max(100),
    visitor_id: z.string().regex(VISITOR_ID_PATTERN),
    props: propsSchema.default({}),
  })
  .strict();

export async function POST(request: NextRequest) {
  const requestBoundary = validatePublicJsonRequest(request);
  if (!requestBoundary.ok) {
    if (requestBoundary.error === "unsupported_media_type") {
      return NextResponse.json({ error: "application/json required" }, { status: 415 });
    }
    return NextResponse.json({ error: "cross-origin request refused" }, { status: 403 });
  }

  const clientKey = clientRateLimitKey(request.headers);
  if (!allowRequest(`evidence:${clientKey}`, 60, 20)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const body = await readBoundedJson(request, EVIDENCE_BODY_MAX_BYTES);
  if (!body.ok) {
    if (body.error === "payload_too_large") {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
    if (body.error === "invalid_content_length") {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const { event, visitor_id, props } = parsed.data;
  const spec = EVENTS[event as EventName];
  if (!spec || !spec.neon) {
    return NextResponse.json({ error: "unknown or non-persistable event" }, { status: 400 });
  }

  const publicProps = PUBLIC_EVIDENCE_PROPS[event as keyof typeof PUBLIC_EVIDENCE_PROPS];
  if (!publicProps) {
    return NextResponse.json(
      { error: "event is not accepted from public clients" },
      { status: 400 },
    );
  }

  // The public route accepts only finite repo-authored consent values. Product,
  // experiment and commercial evidence is minted by reviewed server code.
  const allowed = new Set<string>(publicProps);
  const unknownProperties = Object.keys(props).filter((key) => !allowed.has(key));
  if (unknownProperties.length > 0 || Object.keys(props).length !== publicProps.length) {
    return NextResponse.json({ error: "unknown evidence property" }, { status: 400 });
  }
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (allowed.has(key)) clean[key] = value;
  }

  if (PRICE_REQUIRED.has(event as EventName) && typeof clean.displayed_price !== "string") {
    return NextResponse.json(
      { error: "displayed_price is required — exact price shown must be stored" },
      { status: 400 },
    );
  }

  try {
    await persistEvidence({ event, visitor_id, props: clean });
  } catch {
    console.error("evidence_persistence_failed");
    return NextResponse.json({ error: "evidence store unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
