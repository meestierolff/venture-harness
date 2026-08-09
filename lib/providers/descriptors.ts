import type { ProviderDescriptor, ProviderId } from "./types";

const retryableStatusCodes = [408, 425, 429, 500, 502, 503, 504] as const;
const standardRedaction = [
  "Credential values and authorization headers",
  "Cookies, refresh tokens, private keys, and webhook signing secrets",
  "Connection strings and provider responses marked sensitive",
] as const;

function descriptor(
  input: Omit<ProviderDescriptor, "rateLimits" | "redactionRules" | "environments"> &
    Partial<Pick<ProviderDescriptor, "rateLimits" | "redactionRules" | "environments">>,
): ProviderDescriptor {
  return {
    ...input,
    environments: input.environments ?? ["preview", "production"],
    rateLimits: input.rateLimits ?? {
      source: "provider_headers",
      retryAfter: true,
      retryableStatusCodes,
      defaultMaxAttempts: 3,
      notes: "Respect provider retry headers and retry only classified transient failures.",
    },
    redactionRules: input.redactionRules ?? standardRedaction,
  };
}

export const providerDescriptors: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  github: descriptor({
    id: "github",
    displayName: "GitHub",
    capabilities: ["repository", "actions_secret", "repository_settings", "draft_pull_request"],
    authMethods: ["cli_session", "oauth", "restricted_api_key"],
    riskClass: "high",
    effectClasses: ["read", "reversible_external", "irreversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: ["repo", "workflow"],
    idempotency: {
      mode: "client_ledger",
      notes: "The adapter derives stable keys and verifies repository state before any replay.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: [
        "repository identity",
        "exact default-branch commit and source tree",
        "settings read-back",
        "pull request URL",
      ],
      notes: "Secret values cannot be read back; only secret metadata can be verified.",
    },
    transports: ["cli"],
    limitations: [
      "GitHub never returns Actions secret values after write; verification is metadata-only.",
      "Existing repositories with a different default-branch tree are never overwritten by source publication.",
    ],
  }),
  vercel: descriptor({
    id: "vercel",
    displayName: "Vercel",
    capabilities: ["project", "environment_variable", "deployment", "domain", "web_analytics"],
    authMethods: ["cli_session", "api_key"],
    riskClass: "high",
    effectClasses: ["read", "local_write", "reversible_external", "manual"],
    reversibility: "conditionally_reversible",
    requiredScopes: [],
    environments: ["local", "preview", "production"],
    idempotency: {
      mode: "client_ledger",
      notes: "Stable plan keys prevent blind duplicate project and domain operations.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["project inspection", "deployment inspection", "domain inspection"],
      notes: "Environment variable values remain write-only and are verified by metadata.",
    },
    transports: ["cli", "manual"],
    limitations: [
      "Vercel environment variable values are not returned in readable form after write.",
      "Vercel documents Web Analytics enablement in the dashboard; no undocumented write endpoint is assumed.",
    ],
  }),
  neon: descriptor({
    id: "neon",
    displayName: "Neon",
    capabilities: [
      "project",
      "branch",
      "database",
      "role",
      "schema_migration",
      "read_write_health_check",
    ],
    authMethods: ["api_key", "connection_string"],
    credentialRequirements: [
      {
        capabilities: ["project", "branch", "database", "role"],
        acceptedKinds: ["api_key"],
        purpose: "Neon control-plane provisioning",
      },
      {
        capabilities: ["schema_migration", "read_write_health_check"],
        acceptedKinds: ["connection_string"],
        purpose: "PostgreSQL migration and health-check access",
      },
    ],
    riskClass: "critical",
    effectClasses: ["read", "reversible_external", "irreversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: [],
    idempotency: {
      mode: "client_ledger",
      notes: "Create operations require stable names and read-back before replay.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: [
        "project or branch id",
        "database metadata",
        "role metadata",
        "schema migration ledger",
        "disposable read/write probe",
      ],
      notes:
        "The API key provisions Neon resources. A separately brokered database connection verifies migrations and read/write access.",
    },
    transports: ["cli"],
    limitations: [
      "Neon create responses may contain database credentials; only the declared connection URI field may be captured directly into an already-registered writable credential reference, and raw output must never be persisted.",
      "A missing, wrong-provider, or read-only capture target blocks before project creation.",
    ],
  }),
  stripe: descriptor({
    id: "stripe",
    displayName: "Stripe",
    capabilities: ["product", "price", "webhook", "billing_portal"],
    authMethods: ["restricted_api_key", "api_key"],
    riskClass: "critical",
    effectClasses: ["read", "financial", "reversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: [],
    environments: ["sandbox", "production"],
    idempotency: {
      mode: "native_and_client_ledger",
      keyPlacement: "header",
      notes: "Every POST sends Stripe's Idempotency-Key and is also recorded locally.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["resource id", "livemode", "active state", "configured amount/currency"],
      notes: "A successful POST is not enough; GET the created object and compare it.",
    },
    transports: ["http"],
    limitations: [
      "Price objects are immutable for amount and currency; corrections require a new price.",
    ],
  }),
  revenuecat: descriptor({
    id: "revenuecat",
    displayName: "RevenueCat",
    capabilities: ["project_bootstrap", "app", "entitlement", "offering", "webhook"],
    authMethods: ["restricted_api_key", "manual"],
    riskClass: "critical",
    effectClasses: ["read", "financial", "reversible_external", "manual"],
    reversibility: "conditionally_reversible",
    requiredScopes: [
      "project_configuration:apps:read_write",
      "project_configuration:entitlements:read_write",
      "project_configuration:offerings:read_write",
      "project_configuration:integrations:read_write",
    ],
    environments: ["sandbox", "production"],
    idempotency: {
      mode: "client_ledger",
      notes: "RevenueCat v2 operations use deterministic resource identifiers where supported.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["project id", "app id", "entitlement id", "offering state"],
      notes: "Project and key creation remain human-gated prerequisites.",
    },
    transports: ["http", "manual"],
    limitations: [
      "Create the RevenueCat project and secret API key in the dashboard before v2 API setup.",
    ],
  }),
  brevo: descriptor({
    id: "brevo",
    displayName: "Brevo",
    capabilities: [
      "sending_domain",
      "sending_domain_verification",
      "sender",
      "template",
      "webhook",
    ],
    authMethods: ["api_key"],
    riskClass: "high",
    effectClasses: ["read", "communication", "reversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: [],
    idempotency: {
      mode: "client_ledger",
      notes: "Resource identity and read-back prevent duplicate sender and webhook setup.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["domain authentication state", "sender id", "template id", "webhook id"],
      notes: "DNS authentication can stay pending after the API accepts a domain.",
    },
    transports: ["http"],
    limitations: [
      "Sending-domain authentication is asynchronous and requires external DNS records.",
    ],
  }),
  google: descriptor({
    id: "google",
    displayName: "Google",
    capabilities: [
      "analytics_property",
      "analytics_web_stream",
      "site_verification_token",
      "site_verification",
      "search_console_site",
      "search_console_sitemap",
    ],
    authMethods: ["oauth", "service_account"],
    riskClass: "high",
    effectClasses: ["read", "reversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: [
      "https://www.googleapis.com/auth/analytics.edit",
      "https://www.googleapis.com/auth/siteverification",
      "https://www.googleapis.com/auth/webmasters",
    ],
    idempotency: {
      mode: "client_ledger",
      notes: "Google create calls are preceded by stable lookup and followed by read-back.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["property name", "stream measurement id", "verified site", "sitemap status"],
      notes: "Search Console data can lag after verification and sitemap submission.",
    },
    transports: ["http"],
    limitations: [
      "Site verification requires publishing the returned token through DNS or the website before insertion succeeds.",
    ],
  }),
  bing: descriptor({
    id: "bing",
    displayName: "Bing Webmaster Tools",
    capabilities: ["site", "sitemap", "url_submission"],
    authMethods: ["oauth", "api_key"],
    riskClass: "medium",
    effectClasses: ["read", "reversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: [],
    idempotency: {
      mode: "client_ledger",
      notes: "Site and feed identity are stored locally to avoid blind resubmission.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["site list", "feed list", "submission response"],
      notes: "Indexing is asynchronous and is never inferred from request acceptance.",
    },
    transports: ["http"],
    limitations: [
      "Bing Webmaster API surfaces are legacy and availability must be checked during doctor.",
    ],
  }),
  dns: descriptor({
    id: "dns",
    displayName: "DNS provider",
    capabilities: ["record"],
    authMethods: ["manual"],
    riskClass: "critical",
    effectClasses: ["manual", "reversible_external", "irreversible_external"],
    reversibility: "manual",
    requiredScopes: [],
    idempotency: {
      mode: "manual",
      notes: "The human operator must check for an existing record before writing.",
    },
    verification: {
      mode: "manual",
      evidence: ["authoritative DNS lookup", "record value", "TTL"],
      notes: "Propagation and authoritative read-back are required.",
    },
    transports: ["manual"],
    limitations: [
      "No provider-neutral DNS write API is assumed; this adapter emits a manual record plan only.",
    ],
  }),
  mijndomein: descriptor({
    id: "mijndomein",
    displayName: "MijnDomein",
    capabilities: ["record", "domain_attachment"],
    authMethods: ["manual"],
    riskClass: "critical",
    effectClasses: ["manual", "reversible_external", "irreversible_external"],
    reversibility: "manual",
    requiredScopes: [],
    idempotency: {
      mode: "manual",
      notes: "Inspect the MijnDomein control panel before adding or changing a record.",
    },
    verification: {
      mode: "manual",
      evidence: ["control-panel screenshot", "authoritative DNS lookup"],
      notes: "The adapter does not claim an undocumented MijnDomein API.",
    },
    transports: ["manual"],
    limitations: [
      "No supported MijnDomein provisioning API is assumed; all changes remain human-gated.",
    ],
  }),
  app_store_connect: descriptor({
    id: "app_store_connect",
    displayName: "App Store Connect",
    capabilities: [
      "first_app_record",
      "build_processing",
      "testflight_group",
      "build_group_assignment",
      "build_metadata",
    ],
    authMethods: ["jwt_private_key", "manual"],
    riskClass: "critical",
    effectClasses: ["manual", "reversible_external", "irreversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: [],
    environments: ["testflight", "production"],
    idempotency: {
      mode: "client_ledger",
      notes: "Use stable app and group identifiers; the first app record stays manual.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["App Store Connect app id", "bundle id", "TestFlight group id"],
      notes: "A human must attest the first app record before subsequent API plans run.",
    },
    transports: ["http", "manual"],
    limitations: [
      "The App Store Connect API cannot create the first app record; create it in the web interface.",
    ],
  }),
  eas: descriptor({
    id: "eas",
    displayName: "Expo Application Services",
    capabilities: ["app_store_prerequisite", "app_store_connection", "ios_build", "ios_submit"],
    authMethods: ["cli_session", "api_key"],
    riskClass: "critical",
    effectClasses: ["manual", "reversible_external", "irreversible_external"],
    reversibility: "conditionally_reversible",
    requiredScopes: [],
    environments: ["preview", "testflight", "production"],
    idempotency: {
      mode: "client_ledger",
      notes: "Build and submission ids are recorded; retries must target an existing build.",
    },
    verification: {
      mode: "response_and_read_back",
      evidence: ["EAS build id", "build status", "submission id", "submission status"],
      notes: "A completed build does not prove App Store submission acceptance.",
    },
    transports: ["cli", "manual"],
    limitations: [
      "EAS cannot remove Apple's requirement to create the first App Store Connect app record manually.",
    ],
  }),
};

export function getProviderDescriptor(id: ProviderId): ProviderDescriptor {
  return providerDescriptors[id];
}
