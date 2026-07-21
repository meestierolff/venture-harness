"use client";

/**
 * Pricing table with the pricing-evidence contract wired in:
 *  - on mount, records pricing_variant_exposed with the EXACT price
 *    strings being rendered (displayed_price is what analysis trusts)
 *  - plan selection records plan_selected with the same exact string
 *  - billing toggle records billing_period_changed
 * Plans come from the server (config/offer.yaml via app/pricing/page.tsx).
 * In template state the plans are labeled placeholders.
 */
import { useEffect, useState } from "react";
import { track } from "@/lib/analytics/track";

export interface PricingPlan {
  key: string;
  name: string;
  monthlyPrice: string; // exact string rendered, e.g. "EUR 199/month"
  annualPrice: string; // exact string rendered, e.g. "EUR 1990/year"
  features: string[];
  cta: string;
}

export function PricingTable({
  plans,
  experimentId = "",
  variantKey = "",
}: {
  plans: PricingPlan[];
  experimentId?: string;
  variantKey?: string;
}) {
  const [period, setPeriod] = useState<"monthly" | "annual">("monthly");

  useEffect(() => {
    for (const plan of plans) {
      track("pricing_variant_exposed", {
        experiment_id: experimentId,
        variant_key: variantKey || plan.key,
        displayed_price: period === "monthly" ? plan.monthlyPrice : plan.annualPrice,
        billing_period: period,
      });
    }
    // Exposure is recorded once per rendered configuration on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePeriod = (to: "monthly" | "annual") => {
    setPeriod(to);
    track("billing_period_changed", { to_period: to });
  };

  const selectPlan = (plan: PricingPlan) => {
    const displayedPrice = period === "monthly" ? plan.monthlyPrice : plan.annualPrice;
    track("plan_selected", {
      plan_key: plan.key,
      displayed_price: displayedPrice,
      billing_period: period,
      experiment_id: experimentId,
      variant_key: variantKey || plan.key,
    });
    track(period === "monthly" ? "monthly_plan_selected" : "annual_plan_selected", {
      plan_key: plan.key,
      displayed_price: displayedPrice,
    });
  };

  return (
    <div>
      <div role="group" aria-label="Billing period" className="billing-toggle">
        <button
          type="button"
          aria-pressed={period === "monthly"}
          onClick={() => togglePeriod("monthly")}
        >
          Monthly
        </button>
        <button
          type="button"
          aria-pressed={period === "annual"}
          onClick={() => togglePeriod("annual")}
        >
          Annual
        </button>
      </div>
      <div className="plan-grid">
        {plans.map((plan) => (
          <article key={plan.key} className="plan">
            <h3>{plan.name}</h3>
            <p className="plan-price">
              {period === "monthly" ? plan.monthlyPrice : plan.annualPrice}
            </p>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <button type="button" onClick={() => selectPlan(plan)}>
              {plan.cta}
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
