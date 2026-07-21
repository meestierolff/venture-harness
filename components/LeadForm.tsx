"use client";

/**
 * Qualified-application form. The POST to /api/lead is the commercial
 * evidence path and is independent of all tracking; analytics receives
 * form lifecycle events (ids and error types) but NEVER entered values.
 * The server records the neon legs of confirmation events, so client
 * tracking passes { neon: false } for those.
 */
import { useRef, useState, type FormEvent } from "react";
import { track } from "@/lib/analytics/track";
import { getVisitorId } from "@/lib/visitor";

const FORM_ID = "qualification-application";

export function LeadForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const started = useRef(false);

  const onFirstFocus = () => {
    if (!started.current) {
      started.current = true;
      track("form_started", { form_id: FORM_ID });
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const required = ["role", "company_size", "budget_band", "timeline", "contact"] as const;
    for (const field of required) {
      if (!String(fields.get(field) ?? "").trim()) {
        track("form_validation_error", {
          form_id: FORM_ID,
          field_id: field,
          error_type: "required",
        });
        setMessage("Please fill in all fields.");
        return;
      }
    }
    track("form_submitted", { form_id: FORM_ID });
    setStatus("sending");
    try {
      const response = await fetch("/api/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          form_id: FORM_ID,
          visitor_id: getVisitorId(),
          role: fields.get("role"),
          company_size: fields.get("company_size"),
          budget_band: fields.get("budget_band"),
          timeline: fields.get("timeline"),
          contact: fields.get("contact"),
          notes: fields.get("notes") ?? "",
          website: fields.get("website") ?? "", // honeypot
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = (await response.json()) as { qualified: boolean };
      // Server already persisted the neon legs — GA legs only from here.
      track(
        "form_submission_confirmed",
        { form_id: FORM_ID, qualified: result.qualified },
        { neon: false },
      );
      if (result.qualified) {
        track(
          "qualification_completed",
          { form_id: FORM_ID, qualification_tier: "qualified" },
          { neon: false },
        );
      }
      setStatus("done");
      setMessage(
        "Application received. We reply to qualified applications within two business days.",
      );
      form.reset();
    } catch {
      setStatus("error");
      setMessage("Could not save your application — please retry in a moment.");
    }
  };

  if (status === "done") return <p role="status">{message}</p>;

  return (
    <form onSubmit={onSubmit} aria-label="Qualification application">
      {/* Honeypot — hidden from humans, filled by bots. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="honeypot"
      />
      <label>
        Your role
        <input name="role" onFocus={onFirstFocus} maxLength={200} required />
      </label>
      <label>
        Company size
        <select name="company_size" onFocus={onFirstFocus} required defaultValue="">
          <option value="" disabled>
            Select…
          </option>
          <option value="1-10">1–10 people</option>
          <option value="11-50">11–50 people</option>
          <option value="51-200">51–200 people</option>
          <option value="200+">200+ people</option>
        </select>
      </label>
      <label>
        Budget for solving this
        <select name="budget_band" onFocus={onFirstFocus} required defaultValue="">
          <option value="" disabled>
            Select…
          </option>
          <option value="no_budget">No budget yet</option>
          <option value="under_100">Under 100 / month</option>
          <option value="100-500">100–500 / month</option>
          <option value="500+">500+ / month</option>
        </select>
      </label>
      <label>
        When do you want this solved?
        <select name="timeline" onFocus={onFirstFocus} required defaultValue="">
          <option value="" disabled>
            Select…
          </option>
          <option value="now">This month</option>
          <option value="quarter">This quarter</option>
          <option value="someday">Someday</option>
        </select>
      </label>
      <label>
        Work email (used only to reply — never sent to analytics)
        <input name="contact" type="email" onFocus={onFirstFocus} maxLength={200} required />
      </label>
      <label>
        Anything we should know? (optional)
        <textarea name="notes" onFocus={onFirstFocus} maxLength={2000} rows={3} />
      </label>
      <button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : "Apply"}
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </form>
  );
}
