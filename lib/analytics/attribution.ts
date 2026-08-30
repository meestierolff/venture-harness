import type { EventProps } from "./taxonomy";

// Founder alpha has no evidence-backed campaign taxonomy. URL-controlled UTM
// values and referrers are therefore not forwarded. Add only reviewed exact
// values mapped to fixed, non-personal categories.
const CAMPAIGN_SOURCE_CATEGORY: Readonly<Record<string, string>> = Object.freeze({});
const CAMPAIGN_MEDIUM_CATEGORY: Readonly<Record<string, string>> = Object.freeze({});
const CAMPAIGN_NAME_CATEGORY: Readonly<Record<string, string>> = Object.freeze({});
const REFERRER_CATEGORY: Readonly<Record<string, string>> = Object.freeze({});

function mapped(
  values: URLSearchParams,
  parameter: string,
  categories: Readonly<Record<string, string>>,
): string | undefined {
  const raw = values.get(parameter);
  return raw ? categories[raw] : undefined;
}

export function safeLandingAttribution(search: string, referrer: string): EventProps {
  const values = new URLSearchParams(search);
  let referrerHost = "";
  try {
    referrerHost = referrer ? new URL(referrer).hostname : "";
  } catch {
    referrerHost = "";
  }
  return Object.fromEntries(
    [
      ["utm_source", mapped(values, "utm_source", CAMPAIGN_SOURCE_CATEGORY)],
      ["utm_medium", mapped(values, "utm_medium", CAMPAIGN_MEDIUM_CATEGORY)],
      ["utm_campaign", mapped(values, "utm_campaign", CAMPAIGN_NAME_CATEGORY)],
      ["referrer_domain", referrerHost ? REFERRER_CATEGORY[referrerHost] : undefined],
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
