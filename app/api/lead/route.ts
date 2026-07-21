/**
 * Qualified-lead intake. The submission persists FIRST (Layer 3);
 * analytics events are recorded server-side afterwards and their failure
 * never fails the submission. Personal data lives only in the submissions
 * table — nothing here reaches GA or Vercel.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { qualifyLead } from "@/lib/qualification";
import { persistEvidence, persistSubmission } from "@/lib/evidence-store";
import { allowRequest } from "@/lib/rate-limit";

const bodySchema = z
  .object({
    form_id: z.string().min(1).max(50),
    visitor_id: z.string().min(6).max(64),
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
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  if (!allowRequest(`lead:${ip}`, 10, 5)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  let parsed;
  try {
    parsed = bodySchema.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
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
      visitor_id: data.visitor_id,
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
  } catch (error) {
    console.error("submission persistence failed:", error);
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
  } catch (error) {
    console.error("post-submission evidence failed (submission is safe):", error);
  }

  return NextResponse.json({ ok: true, qualified: result.qualified, tier: result.tier });
}
