/**
 * Layer 3 evidence intake: experiment lifecycle, commercial intent,
 * consent ledger. Anonymous visitor id only — personal data is rejected by
 * schema (unknown keys stripped, prohibited keys refused). Pricing events
 * must carry the exact displayed_price string.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { EVENTS, type EventName } from "@/lib/analytics/taxonomy";
import { persistEvidence } from "@/lib/evidence-store";
import { allowRequest } from "@/lib/rate-limit";

const PRICE_REQUIRED = new Set<EventName>([
  "pricing_variant_exposed",
  "plan_selected",
  "monthly_plan_selected",
  "annual_plan_selected",
  "pilot_selected",
  "checkout_intent",
  "reservation_intent",
]);

const bodySchema = z.object({
  event: z.string(),
  visitor_id: z.string().min(6).max(64),
  props: z.record(z.union([z.string().max(300), z.number(), z.boolean()])).default({}),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  if (!allowRequest(`evidence:${ip}`, 60, 20)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  let parsed;
  try {
    parsed = bodySchema.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const { event, visitor_id, props } = parsed.data;
  const spec = EVENTS[event as EventName];
  if (!spec || !spec.neon) {
    return NextResponse.json({ error: "unknown or non-persistable event" }, { status: 400 });
  }

  // Allowed-props filtering — defence in depth against PII smuggling.
  const allowed = new Set<string>(spec.props);
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
  } catch (error) {
    console.error("evidence persistence failed:", error);
    return NextResponse.json({ error: "evidence store unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
