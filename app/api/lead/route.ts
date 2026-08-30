/**
 * Qualified-lead intake. The submission persists FIRST (Layer 3);
 * analytics events are recorded server-side afterwards and their failure
 * never fails the submission. Personal data lives only in the submissions
 * table — nothing here reaches GA or Vercel.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedJson, validatePublicJsonRequest } from "@/lib/bounded-json";
import { qualifyLead } from "@/lib/qualification";
import { persistEvidence, persistSubmission } from "@/lib/evidence-store";
import { allowRequest, clientRateLimitKey } from "@/lib/rate-limit";
import { VISITOR_ID_PATTERN } from "@/lib/visitor-id";

const LEAD_BODY_MAX_BYTES = 8_192;

const bodySchema = z
  .object({
    form_id: z.literal("qualification-application"),
    visitor_id: z.string().regex(VISITOR_ID_PATTERN),
    role: z.string().min(1).max(200),
    company_size: z.string().min(1).max(50),
    budget_band: z.string().min(1).max(50),
    timeline: z.string().min(1).max(50),
    contact: z.string().max(200), // stored in submissions only, never analytics
    notes: z.string().max(2000).optional().default(""),
    // Honeypot: accepted by the schema so bots see a normal success, then
    // silently dropped below when non-empty.
    website: z.string().max(500).optional().default(""),
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
  if (!allowRequest(`lead:${clientKey}`, 10, 5)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const body = await readBoundedJson(request, LEAD_BODY_MAX_BYTES);
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
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid submission" }, { status: 400 });
  }
  const data = parsed.data;

  // Honeypot: record as spam, never as a lead.
  if (data.website !== "") {
    return NextResponse.json({ ok: true }); // silent success to the bot
  }

  const result = qualifyLead(data);

  // 1. Persist the submission — the commercial evidence. Failure is loud.
  try {
    await persistSubmission({
      form_id: data.form_id,
      payload: {
        role: data.role,
        company_size: data.company_size,
        budget_band: data.budget_band,
        timeline: data.timeline,
        contact: data.contact,
        notes: data.notes,
      },
      qualified: result.qualified,
      qualification_tier: result.tier,
    });
  } catch {
    console.error("lead_submission_persistence_failed");
    return NextResponse.json(
      { error: "could not save your application — please retry" },
      { status: 503 },
    );
  }

  // 2. Server-side evidence events — fire-and-forget, never fail the lead.
  try {
    await persistEvidence({
      event: "form_submission_confirmed",
      visitor_id: data.visitor_id,
      props: { form_id: data.form_id, qualified: result.qualified },
    });
    if (result.qualified) {
      await persistEvidence({
        event: "qualification_completed",
        visitor_id: data.visitor_id,
        props: { form_id: data.form_id, qualification_tier: result.tier },
      });
    }
  } catch {
    console.error("lead_post_submission_evidence_failed");
  }

  return NextResponse.json({ ok: true, qualified: result.qualified, tier: result.tier });
}
