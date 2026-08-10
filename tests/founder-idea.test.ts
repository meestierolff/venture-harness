import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileFounderIdea } from "@/lib/founder-launch";

describe("founder idea compilation", () => {
  it("compiles a concise founder idea into the canonical routed brief", () => {
    const compiled = compileFounderIdea(
      readFileSync("fixtures/ideas/synthetic-founder-web.md", "utf8"),
    );

    expect(compiled).toMatchObject({
      sourceKind: "markdown_idea",
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      assumptionsAdded: [],
      commercialTerms: {
        currency: "EUR",
        monthlyPrice: 24.5,
        annualPrice: null,
      },
      brief: {
        id: "exception-desk",
        name: "Exception Desk",
        app_kind: "web",
        requested_mobile_stack: "none",
        monetization_model: "subscription",
        synthetic: true,
        domain: "exception-desk.example.test",
        smallest_core_journey: expect.stringContaining("invoice draft"),
        needs: {
          authenticated_product: true,
          database: true,
          transactional_email: true,
          analytics: true,
          search_discovery: true,
          scheduled_learning: true,
        },
      },
    });
  });

  it("accepts a complete structured brief without weakening its facts", () => {
    const source = readFileSync("fixtures/web-saas/brief.yaml", "utf8");
    const compiled = compileFounderIdea(source);

    expect(compiled.sourceKind).toBe("structured_brief");
    expect(compiled.assumptionsAdded).toEqual([]);
    expect(compiled.brief).toMatchObject({
      id: "synthetic-web-saas",
      synthetic: true,
      primary_success_signal: "synthetic_invoice_draft_confirmed",
    });
  });

  it("turns missing non-critical detail into explicit assumptions", () => {
    const compiled = compileFounderIdea("# Narrow tool\n\nA reversible helper for one useful job.");

    expect(compiled.brief.id).toBe("narrow-tool");
    expect(compiled.assumptionsAdded).toHaveLength(5);
    expect(compiled.brief.assumptions).toEqual(compiled.assumptionsAdded);
    expect(compiled.commercialTerms).toEqual({
      currency: "EUR",
      monthlyPrice: null,
      annualPrice: null,
    });
  });

  it("rejects credential-shaped idea content before it becomes durable state", () => {
    expect(() =>
      compileFounderIdea(
        "# Unsafe idea\nToken: whsec_secondary_founderidea1234567890\nOutcome: never persist this",
      ),
    ).toThrow(/forbidden credential-like material/);
    // This value must stay unclassifiable so that it isolates the
    // credential-labeled-field guard. A value the classifier recognises would
    // be caught one branch earlier and prove nothing about this guard.
    expect(() =>
      compileFounderIdea(
        "# Unsafe idea\nAudience: support teams\nBrevo API key: arbitrary unclassified placeholder\nOutcome: ship safely",
      ),
    ).toThrow(/credential-labeled field/);
  });
});
