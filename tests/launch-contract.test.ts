import { format } from "prettier";
import { describe, expect, it } from "vitest";
import {
  compileFounderIdea,
  decimalPriceToMinorUnits,
  founderBriefFromLaunchContract,
  LaunchContractSourceError,
  launchContractSchema,
  launchDecisionFromContract,
  parseLaunchContractSource,
  renderFounderIdea,
  renderLaunchContractYaml,
  renderProductConstitution,
} from "@/lib/founder-launch";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";

describe("Launch Contract", () => {
  it("round-trips as the front matter of canonical idea.md", () => {
    const contract = launchReceiptContract();
    const markdown = renderFounderIdea(contract);

    expect(parseLaunchContractSource(markdown)).toEqual(contract);
    expect(markdown).toContain("The YAML front matter is the canonical Launch Contract");
  });

  it("accepts valid bare YAML and leaves unambiguous prose on the bounded idea path", () => {
    const contract = launchReceiptContract();
    expect(parseLaunchContractSource(renderLaunchContractYaml(contract))).toEqual(contract);

    const prose = [
      "# Receipt helper",
      "",
      "A founder wants one careful receipt workflow.",
      "The venture: should remain small, and the product: should prove one outcome.",
    ].join("\n");
    expect(parseLaunchContractSource(prose)).toBeUndefined();
    expect(compileFounderIdea(prose).sourceKind).toBe("markdown_idea");
  });

  it("fails closed for unclosed canonical front matter instead of sharpening it as prose", () => {
    const source = `---\n${renderLaunchContractYaml(launchReceiptContract())}`;

    expect(() => parseLaunchContractSource(source)).toThrowError(LaunchContractSourceError);
    expect(() => compileFounderIdea(source)).toThrowError(
      expect.objectContaining({
        code: "LAUNCH_CONTRACT_SOURCE_INVALID",
        schemaVersion: "1",
        invalidPath: "$frontMatter",
        validationProblem: expect.stringContaining("not closed"),
      }),
    );
  });

  it("reports unsupported versions and missing required fields with exact repair context", () => {
    const valid = renderLaunchContractYaml(launchReceiptContract());
    const unsupported = valid.replace("schemaVersion: 1", "schemaVersion: 2");
    expect(() => parseLaunchContractSource(unsupported)).toThrowError(
      expect.objectContaining({
        code: "LAUNCH_CONTRACT_SOURCE_INVALID",
        schemaVersion: "2",
        invalidPath: "schemaVersion",
      }),
    );

    const missingCurrency = valid.replace(/^  currency: EUR\n/mu, "");
    let caught: unknown;
    try {
      parseLaunchContractSource(missingCurrency);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LaunchContractSourceError);
    expect(caught).toMatchObject({
      schemaVersion: "1",
      invalidPath: "business.currency",
      validationProblem: expect.any(String),
      expectedShape: expect.stringContaining("schemaVersion: 1"),
      remediation: expect.stringContaining("correct business.currency"),
    });
    expect((caught as Error).message).toMatch(
      /schema version: 1; invalid path: business\.currency; validation problem: .+; expected v1 shape: .+; exact remediation: correct business\.currency/u,
    );
  });

  it("rejects an invalid decimal price without losing the structured commercial terms", () => {
    const malformed = renderLaunchContractYaml(launchReceiptContract()).replace(
      "priceHypothesis: 9",
      "priceHypothesis: 9.999",
    );

    expect(() => parseLaunchContractSource(malformed)).toThrowError(
      expect.objectContaining({
        code: "LAUNCH_CONTRACT_SOURCE_INVALID",
        invalidPath: "business.priceHypothesis",
        validationProblem: "priceHypothesis must use at most two decimal places",
      }),
    );
    expect(() => compileFounderIdea(malformed)).toThrowError(LaunchContractSourceError);
  });

  it("preserves contracts across formatting and YAML multiline values", async () => {
    const base = launchReceiptContract();
    const contract = launchReceiptContract({
      distribution: {
        ...base.distribution,
        initialMessage: "Publish one honest receipt.\nKeep every evidence caveat visible.",
      },
    });
    const before = renderFounderIdea(contract);
    const after = await format(before, { parser: "markdown" });

    expect(parseLaunchContractSource(before)).toEqual(contract);
    expect(parseLaunchContractSource(after)).toEqual(contract);
    expect(parseLaunchContractSource(after)?.distribution.initialMessage).toContain("\n");
  });

  it("drives the existing brief, mode, payment, and capability router", () => {
    const contract = launchReceiptContract({
      venture: {
        ...launchReceiptContract().venture,
        domain: "receipt.example.test",
      },
    });
    const brief = founderBriefFromLaunchContract(contract);
    const decision = launchDecisionFromContract(contract);

    expect(brief).toMatchObject({
      id: "launch-receipt",
      monetization_model: "subscription",
      primary_success_signal: "launch_receipt_published",
      domain: "receipt.example.test",
      needs: {
        authenticated_product: true,
        database: true,
        transactional_email: true,
        analytics: true,
        scheduled_learning: false,
      },
    });
    expect(decision.mode.selectedMode).toBe("product_first");
    expect(decision.payment.provider).toBe("stripe");
    expect(decision.capabilities).toEqual(
      expect.arrayContaining([
        "authenticated_product",
        "database",
        "transactional_email",
        "stripe",
      ]),
    );
  });

  it("keeps small-bet infrastructure off unless the selected journey names it", () => {
    const contract = launchReceiptContract({
      product: {
        ...launchReceiptContract().product,
        oneCoreFeature: "A one-page local calculator",
        primaryJourney: ["Enter two public numbers", "See one calculation"],
        trustRequirements: ["Visible focus and accessible labels"],
      },
      business: {
        model: "free",
        priceHypothesis: null,
        currency: "EUR",
        paymentProvider: "none",
        commercialCommitmentEvent: "Completed primary calculation",
      },
    });
    const brief = founderBriefFromLaunchContract(contract);

    expect(brief.needs).toEqual({
      authenticated_product: false,
      database: false,
      file_storage: false,
      transactional_email: false,
      lifecycle_email: false,
      feedback: false,
      analytics: false,
      search_discovery: false,
      scheduled_learning: false,
    });
  });

  it("keeps a reviewed web Agent Surface separate from the mobile rail", () => {
    const contract = launchReceiptContract();
    const brief = founderBriefFromLaunchContract({
      ...contract,
      agentNative: {
        customerAgentSurfaceRequired: true,
        serviceBlueprintRequired: true,
        outcomeCommands: ["publish_verified_receipt"],
      },
    });

    expect(brief.app_kind).toBe("web");
    expect(
      launchDecisionFromContract({
        ...contract,
        agentNative: {
          customerAgentSurfaceRequired: true,
          serviceBlueprintRequired: true,
          outcomeCommands: ["publish_verified_receipt"],
        },
      }).capabilities,
    ).not.toContain("app_store_connect");
  });

  it("rejects credential material and inconsistent free commerce", () => {
    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        truth: {
          ...launchReceiptContract().truth,
          facts: [`Stripe token ${["sk", "test", "abcdefghijklmnopqrstuvwxyz123456"].join("_")}`],
        },
      }),
    ).toThrow(/credential values are forbidden/);
    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        business: {
          model: "free",
          priceHypothesis: 9,
          currency: "EUR",
          paymentProvider: "stripe",
          commercialCommitmentEvent: "completed journey",
        },
      }),
    ).toThrow(/free launch/);

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        business: {
          ...launchReceiptContract().business,
          model: "subscription",
          priceHypothesis: 19,
          paymentProvider: "none",
          commercialCommitmentEvent: "published receipt",
        },
      }),
    ).toThrow(/priced subscription or one-time launch/);
  });

  it("rejects deceptive intent, unsafe medical actions, and fundamental contradictions at the contract boundary", () => {
    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        product: {
          ...launchReceiptContract().product,
          trustRequirements: [
            ...launchReceiptContract().product.trustRequirements,
            "Present invented customer testimonials as verified reviews",
          ],
        },
      }),
    ).toThrow(/deceptive or fabricated/);

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        product: {
          ...launchReceiptContract().product,
          trustRequirements: [
            "Do not fabricate customer reviews; later invent customer testimonials for launch",
          ],
        },
      }),
    ).toThrow(/deceptive or fabricated/);

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        product: {
          ...launchReceiptContract().product,
          oneCoreFeature: "Calculate and prescribe insulin doses directly to patients",
          trustRequirements: ["No clinician review may be required"],
        },
      }),
    ).toThrow(/licensed-clinician review safeguard/);

    const reversible = launchReceiptContract({
      truth: {
        ...launchReceiptContract().truth,
        contradictions: ["The founder is unsure whether the CTA says publish or share"],
      },
    });
    expect(founderBriefFromLaunchContract(reversible).unsafe_non_defaultable_choice).toBeNull();

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        truth: {
          ...launchReceiptContract().truth,
          contradictions: [
            "Fundamental: the product must both publish and never publish a receipt",
          ],
        },
      }),
    ).toThrow(/Resolve fundamental Launch Contract contradiction/);
  });

  it("accepts exact cent prices and rejects normalized impossible dates", () => {
    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        business: { ...launchReceiptContract().business, priceHypothesis: 0.29 },
      }),
    ).not.toThrow();
    expect(decimalPriceToMinorUnits(0.29)).toBe(29);
    expect(
      compileFounderIdea(
        renderFounderIdea(
          launchReceiptContract({
            business: { ...launchReceiptContract().business, priceHypothesis: 0.29 },
          }),
        ),
      ).commercialTerms.monthlyPrice,
    ).toBe(0.29);
    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        decision: { ...launchReceiptContract().decision, reviewDate: "2026-02-30" },
      }),
    ).toThrow(/real YYYY-MM-DD/);
  });

  it("preserves one-time and service price hypotheses without inventing recurrence", () => {
    for (const model of ["one_time", "service"] as const) {
      const contract = launchReceiptContract({
        business: {
          ...launchReceiptContract().business,
          model,
          priceHypothesis: 149,
        },
      });
      const compiled = compileFounderIdea(renderFounderIdea(contract));

      expect(compiled.commercialTerms).toEqual({
        currency: "EUR",
        monthlyPrice: null,
        annualPrice: null,
        oneTimePrice: 149,
      });
    }
  });

  it("preserves usage and take-rate models with explicit reviewed bases and honest rails", () => {
    for (const model of ["usage", "take_rate"] as const) {
      expect(
        launchContractSchema.parse({
          ...launchReceiptContract(),
          business: {
            ...launchReceiptContract().business,
            model,
            paymentProvider: "none",
            priceHypothesis: model === "usage" ? 0.25 : 12,
            commercialCommitmentEvent:
              model === "usage"
                ? "Founder agrees to test EUR 0.25 per processed receipt"
                : "Founder agrees to test a 12 percent take rate per transaction",
          },
        }),
      ).toMatchObject({ business: { model } });
    }

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        business: {
          ...launchReceiptContract().business,
          model: "usage",
          paymentProvider: "stripe",
          commercialCommitmentEvent: "Founder agrees to test EUR 9 per processed receipt",
        },
      }),
    ).toThrow(/does not yet implement usage meters/);

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        business: {
          ...launchReceiptContract().business,
          model: "take_rate",
          paymentProvider: "none",
          priceHypothesis: null,
          commercialCommitmentEvent: "Founder agrees to test 12 percent per transaction",
        },
      }),
    ).toThrow(/explicit reviewed amount/);

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        business: {
          ...launchReceiptContract().business,
          model: "service",
          paymentProvider: "revenuecat",
        },
      }),
    ).toThrow(/native subscription or one-time/);

    expect(() =>
      launchContractSchema.parse({
        ...launchReceiptContract(),
        business: {
          ...launchReceiptContract().business,
          paymentProvider: "none",
          commercialCommitmentEvent: "Stripe checkout started",
        },
      }),
    ).toThrow(/requires a compatible reviewed payment provider/);
  });

  it("renders the complete truth taxonomy and venture scope", () => {
    const constitution = renderProductConstitution(launchReceiptContract());

    for (const truthClass of [
      "FACT",
      "FOUNDER_ASSUMPTION",
      "MODEL_INFERENCE",
      "FIXTURE",
      "EXTERNALLY_VERIFIED",
      "UNKNOWN",
      "CONTRADICTORY",
    ]) {
      expect(constitution).toContain(truthClass);
    }
    expect(constitution).toContain("Project-management suite");
    expect(constitution).toContain("Models may not invent provider state");

    const unverifiedExternal = renderProductConstitution(
      launchReceiptContract({
        truth: {
          ...launchReceiptContract().truth,
          externalEvidence: ["A founder says ten users asked for it"],
        },
      }),
    );
    expect(unverifiedExternal).toContain(
      "UNKNOWN — Founder-supplied external evidence awaits provenance and read-back",
    );
    expect(unverifiedExternal).not.toContain(
      "EXTERNALLY_VERIFIED — A founder says ten users asked for it",
    );
  });
});
