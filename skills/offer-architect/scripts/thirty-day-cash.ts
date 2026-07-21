/**
 * Thirty-day cash calculator — deterministic, no model calls.
 *
 * Reads config/offer.yaml (pricing + economics) and prints whether one
 * customer's first-30-day cash recovers the assumed CAC, with all
 * assumptions restated. Values may be overridden via CLI flags for
 * scenario runs, e.g.:
 *
 *   pnpm tsx skills/offer-architect/scripts/thirty-day-cash.ts \
 *     --monthly 199 --setup 500 --cac 350 --delivery 40 --onboarding 60
 *
 * Exit code 0 always (it reports; it does not gate). Missing inputs are
 * reported as UNKNOWN, never guessed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

type Num = number | null;

function flag(name: string): Num {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : null;
}

function num(v: unknown): Num {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const root = resolve(import.meta.dirname ?? __dirname, "../../..");
let offer: Record<string, unknown> = {};
try {
  offer = parse(readFileSync(resolve(root, "config/offer.yaml"), "utf8")) ?? {};
} catch {
  // config unreadable -> everything must come from flags
}

const pricing = (offer.pricing ?? {}) as Record<string, unknown>;
const economics = (offer.economics ?? {}) as Record<string, unknown>;

const monthly = flag("monthly") ?? num(pricing.monthly_price);
const setup = flag("setup") ?? num(pricing.implementation_fee) ?? 0;
const cac = flag("cac") ?? num(economics.cac_assumption);
const delivery = flag("delivery") ?? num(economics.delivery_cost_monthly);
const onboarding = flag("onboarding") ?? num(economics.onboarding_cost) ?? 0;
const currency =
  flag("currency") !== null ? String(flag("currency")) : String(pricing.currency ?? "EUR");

console.log("thirty-day-cash — deterministic calculator");
console.log("");
console.log("Assumptions (state them; do not trust silently):");
console.log(`  monthly price        : ${monthly ?? "UNKNOWN"} ${currency}`);
console.log(`  setup fee (one-time) : ${setup} ${currency}`);
console.log(`  CAC assumption       : ${cac ?? "UNKNOWN"} ${currency}`);
console.log(`  delivery cost / 30d  : ${delivery ?? "UNKNOWN"} ${currency}`);
console.log(`  onboarding cost      : ${onboarding} ${currency}`);
console.log("");

if (monthly === null || cac === null || delivery === null) {
  console.log("RESULT: INCOMPLETE — fill config/offer.yaml (pricing.monthly_price,");
  console.log("economics.cac_assumption, economics.delivery_cost_monthly) or pass flags.");
  console.log("Unknown inputs are a bootstrap blocker, not a guess opportunity.");
  process.exit(0);
}

const cashIn30 = monthly + setup;
const cost30 = delivery + onboarding;
const contribution = cashIn30 - cost30;
const netAfterCac = contribution - cac;
const margin = cashIn30 > 0 ? contribution / cashIn30 : 0;
// Payback: months of contribution needed to cover CAC (setup counted once).
const monthlyContribution = monthly - delivery;
let paybackDays: string;
if (netAfterCac >= 0) {
  paybackDays = "<= 30";
} else if (monthlyContribution <= 0) {
  paybackDays = "NEVER (monthly contribution <= 0)";
} else {
  const extraMonths = -netAfterCac / monthlyContribution;
  paybackDays = String(Math.ceil(30 + extraMonths * 30));
}

console.log("Result (one customer, first 30 days):");
console.log(`  cash collected       : ${cashIn30} ${currency}`);
console.log(`  delivery + onboarding: ${cost30} ${currency}`);
console.log(
  `  contribution         : ${contribution} ${currency} (margin ${(margin * 100).toFixed(0)}%)`,
);
console.log(`  after CAC            : ${netAfterCac} ${currency}`);
console.log(`  payback period       : ${paybackDays} days`);
console.log("");
console.log(
  netAfterCac >= 0
    ? "THIRTY-DAY CASH: RECOVERED — CAC is repaid within the first 30 days under these assumptions."
    : "THIRTY-DAY CASH: NOT RECOVERED — restructure the offer (setup fee, annual prepay, price) or lower CAC. Do not launch on hope.",
);
console.log("");
console.log("Limitations: single-customer model; ignores churn, refunds, payment");
console.log("timing, and taxes. Assumptions above are hypotheses until evidenced.");
