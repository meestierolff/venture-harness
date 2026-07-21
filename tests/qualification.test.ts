import { describe, expect, it } from "vitest";
import { qualifyLead } from "@/lib/qualification";

describe("qualifyLead (template rule)", () => {
  it("qualifies a complete, funded, urgent lead", () => {
    const result = qualifyLead({
      role: "operations manager",
      company_size: "11-50",
      budget_band: "100-500",
      timeline: "now",
    });
    expect(result).toMatchObject({ qualified: true, tier: "qualified" });
  });

  it("routes a single-gap lead to nurture, not qualified", () => {
    const result = qualifyLead({
      role: "operations manager",
      company_size: "11-50",
      budget_band: "no_budget",
      timeline: "now",
    });
    expect(result.qualified).toBe(false);
    expect(result.tier).toBe("nurture");
    expect(result.reasons).toContain("no budget");
  });

  it("marks empty submissions unqualified with reasons", () => {
    const result = qualifyLead({ role: "", company_size: "", budget_band: "", timeline: "" });
    expect(result.tier).toBe("unqualified");
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
