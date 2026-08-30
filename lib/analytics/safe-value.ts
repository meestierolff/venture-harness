const EMAIL_LIKE = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/iu;
const CREDENTIAL_LABELED =
  /(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key|password|authorization)\s*[:=]\s*\S+/iu;
const CREDENTIAL_SHAPED =
  /(?:\bBearer\s+\S+|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\bghp_[A-Za-z0-9]+|\bgithub_pat_[A-Za-z0-9_]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/u;

export function isSafeAnalyticsString(value: string): boolean {
  return (
    value.length <= 300 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !EMAIL_LIKE.test(value) &&
    !CREDENTIAL_LABELED.test(value) &&
    !CREDENTIAL_SHAPED.test(value)
  );
}

const ROUTE = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*\/?)?$/u;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const DISPLAYED_PRICE =
  /^(?:Free|Custom|Contact(?: us)?|(?:[A-Z]{3}|[€$£¥])\s?\d[\d.,]*(?:\s?(?:\/|per\s)(?:month|year|week|unit))?(?:\s(?:incl\.?|excl\.?)\sVAT)?)$/u;

const ROUTE_PROPERTIES = new Set(["route", "from_route", "to_route", "landing_route"]);
const DOMAIN_PROPERTIES = new Set(["target_domain", "referrer_domain"]);
const BOOLEAN_PROPERTIES = new Set(["qualified"]);
const INTEGER_PROPERTIES = new Set(["step_index"]);
const PRICE_PROPERTIES = new Set(["displayed_price"]);

const PROPERTY_ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  assignment_scope: new Set(["visitor", "session", "account"]),
  billing_period: new Set(["weekly", "monthly", "annual", "one_time"]),
  consent_scope: new Set(["analytics"]),
  from_state: new Set(["unset", "accepted", "declined"]),
  platform: new Set(["web", "ios", "android"]),
  provider: new Set(["stripe", "revenuecat", "apple", "google_play"]),
  qualification_tier: new Set(["qualified", "nurture", "unqualified"]),
  to_period: new Set(["weekly", "monthly", "annual", "one_time"]),
  to_state: new Set(["accepted", "declined"]),
};

const PROPERTY_REGISTRIES: Readonly<Record<string, ReadonlySet<string>>> = {
  error_type: new Set(["required"]),
  field_id: new Set(["role", "company_size", "budget_band", "timeline", "contact"]),
  form_id: new Set(["qualification-application"]),
  section_id: new Set(["hero", "how-it-works", "proof", "apply"]),
};
const ROUTE_REGISTRY = new Set(["/"]);
const DOMAIN_REGISTRY = new Set<string>();
const DISPLAYED_PRICE_REGISTRY = new Set<string>();

/**
 * Property-aware public analytics boundary. Free-form strings are never
 * accepted: identifiers are normalized tokens, routes have no query/hash,
 * domains are hostnames, and prices must look like exact displayed prices.
 */
export function isSafeAnalyticsProperty(key: string, value: string | number | boolean): boolean {
  if (BOOLEAN_PROPERTIES.has(key)) return typeof value === "boolean";
  if (INTEGER_PROPERTIES.has(key)) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000;
  }
  if (typeof value !== "string" || !isSafeAnalyticsString(value)) return false;
  const allowed = PROPERTY_ENUMS[key];
  if (allowed) return allowed.has(value);
  if (ROUTE_PROPERTIES.has(key)) {
    return value.length <= 200 && ROUTE.test(value) && ROUTE_REGISTRY.has(value);
  }
  if (DOMAIN_PROPERTIES.has(key)) {
    return value.length <= 253 && DOMAIN.test(value) && DOMAIN_REGISTRY.has(value);
  }
  if (PRICE_PROPERTIES.has(key)) {
    return (
      value.length <= 100 && DISPLAYED_PRICE.test(value) && DISPLAYED_PRICE_REGISTRY.has(value)
    );
  }
  return PROPERTY_REGISTRIES[key]?.has(value) ?? false;
}
