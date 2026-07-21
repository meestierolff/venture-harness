/**
 * Server-side lead qualification. TEMPLATE RULE ONLY — every venture
 * replaces this with the qualification rule recorded in
 * docs/product/VALIDATION.md and config/venture.yaml. The rule runs on the
 * server so qualification cannot be spoofed client-side.
 */
export interface LeadFields {
  role: string;
  company_size: string;
  budget_band: string;
  timeline: string;
}

export interface QualificationResult {
  qualified: boolean;
  tier: "qualified" | "nurture" | "unqualified";
  reasons: string[];
}

export function qualifyLead(fields: LeadFields): QualificationResult {
  const reasons: string[] = [];
  if (!fields.role.trim()) reasons.push("missing role");
  if (fields.company_size === "" || fields.company_size === "none")
    reasons.push("no company context");
  if (fields.budget_band === "" || fields.budget_band === "no_budget") reasons.push("no budget");
  if (fields.timeline === "" || fields.timeline === "someday") reasons.push("no urgency");

  if (reasons.length === 0) return { qualified: true, tier: "qualified", reasons };
  if (reasons.length <= 1) return { qualified: false, tier: "nurture", reasons };
  return { qualified: false, tier: "unqualified", reasons };
}
