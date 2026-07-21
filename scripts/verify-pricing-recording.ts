/**
 * Pricing-recording verification: the exact price shown must be the exact
 * price stored.
 *  - pricing/commercial taxonomy events carry displayed_price
 *  - pricing experiment variants declare displayed_offer + displayed_price
 *  - the PricingTable component forwards displayedPrice into both the
 *    exposure record and the selection record
 *  - the evidence API schema requires displayed_price for plan selections
 */
import { Reporter, loadYaml, readText } from "./lib/util";
import { analyticsSchema, experimentsSchema } from "../lib/config/schemas";

const r = new Reporter("verify-pricing-recording");
const analytics = analyticsSchema.parse(loadYaml("config/analytics.yaml"));
const experiments = experimentsSchema.parse(loadYaml("config/experiments.yaml"));

// 1. Taxonomy: price-bearing events carry displayed_price --------------------
const PRICE_EVENTS = [
  "pricing_variant_exposed",
  "plan_selected",
  "monthly_plan_selected",
  "annual_plan_selected",
  "pilot_selected",
  "checkout_intent",
  "reservation_intent",
];
let taxOk = true;
for (const name of PRICE_EVENTS) {
  const ev = analytics.events[name];
  if (!ev) {
    taxOk = false;
    r.fail(`event ${name}`, "missing from taxonomy", "restore it — pricing evidence depends on it");
    continue;
  }
  if (!ev.props.includes("displayed_price")) {
    taxOk = false;
    r.fail(
      `event ${name}`,
      "does not carry displayed_price",
      "add displayed_price to its allowed props",
    );
  }
  if (!ev.neon) {
    taxOk = false;
    r.fail(
      `event ${name}`,
      "not persisted to neon",
      "price-bearing evidence must reach first-party storage",
    );
  }
}
if (taxOk) r.ok("price-bearing events carry displayed_price into neon");

// 2. Experiment variants declare exact strings -------------------------------
let expOk = true;
for (const exp of experiments.experiments) {
  for (const v of exp.variants) {
    if (!v.displayed_price || !v.displayed_offer) {
      expOk = false;
      r.fail(
        `${exp.id}/${v.key}`,
        "variant missing displayed_offer/displayed_price",
        "declare the exact strings shown to visitors",
      );
    }
  }
}
if (expOk) r.ok("experiment variants declare exact displayed offer and price");

// 3. Component forwards the displayed price ---------------------------------
const pricing = readText("components/PricingTable.tsx");
if (pricing.includes("displayed_price")) r.ok("PricingTable records displayed_price");
else
  r.fail(
    "components/PricingTable.tsx",
    "does not record displayed_price",
    "pass the rendered price string into track()/evidence calls",
  );

// 4. Evidence API requires it ------------------------------------------------
const evidence = readText("app/api/evidence/route.ts");
if (/displayed_price/.test(evidence)) r.ok("evidence API handles displayed_price");
else
  r.fail(
    "app/api/evidence/route.ts",
    "schema does not include displayed_price",
    "require displayed_price for plan-selection events",
  );

r.finish();
