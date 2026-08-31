import { stringify } from "yaml";
import type { SeedDefinition, SeedFileTemplate, SeedId } from "./types";
import { AGENTIC_WEB_PNPM_LOCK } from "./web-seed-lock";

const CORE_VERSION = "0.2.0";

function file(
  path: string,
  ownership: SeedFileTemplate["ownership"],
  content: string,
): SeedFileTemplate {
  return Object.freeze({ path, ownership, content });
}

function yaml(value: unknown): string {
  return stringify(value, { lineWidth: 100, sortMapEntries: false });
}

const repositoryFiles: readonly SeedFileTemplate[] = [
  file(
    ".github/workflows/venture-core.yml",
    "core_owned",
    "name: Venture Core\non:\n  pull_request:\n  workflow_dispatch:\njobs:\n  verify:\n    uses: {{workflowRepository}}/.github/workflows/venture-verify.yml@{{workflowRefSha}}\n",
  ),
  file(
    "src/app-shell.ts",
    "merge_managed",
    'export const ventureShell = { venture: "{{ventureSlug}}", rail: "{{rail}}", runtime: "0.2" } as const;\n',
  ),
  file(
    "src/product/identity.json",
    "venture_owned",
    '{\n  "name": "{{ventureName}}",\n  "slug": "{{ventureSlug}}",\n  "designStatus": "venture-specific-scaffold",\n  "paletteSeed": "{{accentHue}}:{{secondaryHue}}:{{motifStep}}"\n}\n',
  ),
  file(
    "src/design/theme.css",
    "venture_owned",
    ':root {\n  --venture-name: "{{ventureName}}";\n  --accent: oklch(42% 0.13 {{accentHue}});\n  --accent-soft: oklch(93% 0.035 {{accentHue}});\n  --accent-secondary: oklch(52% 0.11 {{secondaryHue}});\n  --motif-step: {{motifStep}}px;\n}\n',
  ),
  file(
    "config/venture-policy.json",
    "venture_owned",
    '{\n  "ventureId": "{{ventureSlug}}",\n  "productionEffectsRequireGrant": true,\n  "advertisingSpendRequiresSeparateSpendGrant": true\n}\n',
  ),
  file(
    "README.md",
    "venture_owned",
    "# {{ventureName}}\n\nIndependent venture repository materialized from `{{seedId}}@{{seedVersion}}`.\n\nThe initial web surface is an honest, noindex-by-default product scaffold. Run `pnpm verify` locally, review the Launch Contract and Product Constitution, and verify provider state before any production launch.\n",
  ),
];

const recursiveServiceFiles: readonly SeedFileTemplate[] = [
  file(
    "runtime/bootstrap.ts",
    "core_owned",
    'import { createVentureRuntime, defineRecursiveServiceCommand, defineRecursiveServiceReconcileCommand, type VentureRuntimeOptions } from "@venture-harness/agent-runtime";\nimport type { OrganizationMembership } from "@venture-harness/organizations";\n\nexport const VENTURE_ID = "{{ventureSlug}}";\nexport const PRIMARY_SERVICE_COMMAND = defineRecursiveServiceCommand({\n  id: "{{ventureSlug}}.execute",\n  title: "Execute {{ventureName}} service",\n  description: "Execute the primary customer Service Blueprint for {{ventureName}}.",\n});\nexport const PRIMARY_SERVICE_RECONCILE_COMMAND = defineRecursiveServiceReconcileCommand({\n  id: "{{ventureSlug}}.reconcile",\n  executionCommandId: PRIMARY_SERVICE_COMMAND.id,\n  title: "Reconcile {{ventureName}} service",\n  description: "Read back and settle the primary customer Service Blueprint for {{ventureName}} without repeating it.",\n});\n\nexport function createRuntime(\n  memberships: readonly OrganizationMembership[],\n  options: Omit<VentureRuntimeOptions, "memberships" | "recursiveCommands" | "recursiveReconcileCommands">,\n) {\n  return createVentureRuntime({ ...options, memberships, recursiveCommands: [PRIMARY_SERVICE_COMMAND], recursiveReconcileCommands: [PRIMARY_SERVICE_RECONCILE_COMMAND] });\n}\n',
  ),
  file(
    "service-blueprints/primary.json",
    "venture_owned",
    '{\n  "schemaVersion": 1,\n  "id": "{{ventureSlug}}.primary",\n  "version": 1,\n  "commandId": "{{ventureSlug}}.execute",\n  "outcome": "Deliver the venture-specific primary outcome",\n  "requiredCapabilities": [],\n  "usageUnit": "completed_outcome",\n  "billingUnit": "completed_outcome",\n  "completionCriteria": ["verified outcome evidence"]\n}\n',
  ),
];

const routeFactor = (rationale: string) => ({ level: "unknown", rationale });

const ventureConfig = {
  venture: {
    name: "{{ventureName}}",
    legal_name: null,
    domain: null,
    market: null,
    target_market: null,
    language: "en",
    locale: "en",
    currency: "EUR",
    timezone: "UTC",
    stage: "build",
    repository_visibility: "{{repositoryVisibility}}",
    production_status: "none",
    harness_version: CORE_VERSION,
    app_kind: "web",
    launch_mode: "thin_mvp",
    business_model: "unselected",
    monetization_model: "unselected",
    risk_profile: "unassessed",
    privacy_profile: "minimal",
    mobile_stack: "none",
    outcomes: {
      primary: { statement: null, success_signal: null },
      secondary: [],
    },
    capabilities: {
      active: ["public_website"],
      open: [],
    },
    extensions: {},
  },
  validation: {
    stage: "build",
    minimum_days: null,
    target_days: null,
    maximum_days: null,
    launch_date: null,
    decision_date: null,
    primary_conversion: null,
    qualification_rule: null,
    build_threshold: null,
    iterate_threshold: null,
    stop_threshold: null,
  },
  infrastructure: {
    domain_registered: false,
    vercel_project_created: false,
    neon_database_created: false,
    ga4_property_created: false,
    vercel_analytics_enabled: false,
    google_search_console_verified: false,
    bing_webmaster_verified: false,
  },
  extensions: {},
};

const launchConfig = {
  contract_version: 1,
  launch: {
    selected_mode: "thin_mvp",
    confidence: 0,
    rationale: "Seed default only; reroute from the founder brief before launch.",
    rejected_alternatives: [],
    assumptions: [
      "The smallest useful web journey is unresolved until the founder brief compiles.",
    ],
    evidence_that_could_change_choice: [
      "A complete founder brief and smallest-useful-product assessment.",
    ],
    rail: {
      app_kind: "web",
      mobile_stack: "none",
      rationale: "This seed is an independently buildable ordinary web product.",
    },
    routing_factors: {
      smallest_useful_build_cost: routeFactor("Assess from the founder brief."),
      smallest_useful_build_time: routeFactor("Assess from the founder brief."),
      reversibility: routeFactor("Assess the smallest useful implementation."),
      regulatory_or_safety_risk: routeFactor("No venture risk assessment exists yet."),
      real_usage_required: routeFactor("Determine whether real usage is needed to prove value."),
      marketplace_cold_start: routeFactor("Determine whether the venture is a marketplace."),
      operational_burden: routeFactor("Assess delivery and support burden."),
      founder_evidence: routeFactor("No founder evidence is compiled yet."),
      concierge_delivery_fit: routeFactor("Assess whether concierge delivery can be honest."),
      app_store_required: routeFactor("The selected seed has no app-store rail."),
    },
    progressive_commitment: {
      specific_user_or_audience: null,
      problem_or_job: null,
      intended_outcome: null,
      smallest_core_journey: null,
      primary_success_signal: null,
      material_constraints: [],
      known_truths: [],
      unresolved_assumptions: [],
      blocking_issues: [],
    },
    extensions: {},
  },
  extensions: {},
};

const mobileConfig = {
  contract_version: 1,
  mobile: {
    stack: "none",
    rationale: "The ordinary web seed does not include a mobile rail.",
    bundle_identifier: null,
    app_scheme: null,
    app_store_connect: {
      team_id: null,
      app_id: null,
      sku: null,
      primary_language: "en",
      credential_ref: null,
      first_app_record: { state: "not_required", manual_action_ref: null },
    },
    eas: {
      project_id: null,
      credential_ref: null,
      build_profiles: ["development", "preview", "production"],
      submit_enabled: false,
    },
    signing: { credential_ref: null, certificates_in_git_forbidden: true },
    metadata_artifact_ref: null,
    screenshot_flow_artifact_ref: null,
    extensions: {},
  },
  extensions: {},
};

const analyticsConfig = {
  providers: {},
  consent: {
    default_mode: "strict",
    google_analytics: "opt_in",
    vercel_analytics: "opt_in",
    allow_withdrawal: true,
    settings_link_required: true,
  },
  collection: {
    track_material_behaviour: true,
    collect_keystrokes: false,
    collect_mouse_movement: false,
    session_replay: false,
    send_form_values_to_analytics: false,
    send_search_text_to_third_parties: false,
    send_email_to_analytics: false,
    enable_advertising_features: false,
  },
  prohibited_properties: [
    "email",
    "name",
    "message",
    "search_text",
    "form_value",
    "free_text",
    "user_content",
  ],
  events: {},
  event_packs: { active: [] },
  core_journeys: {},
};

function disabledLoop(cadence: string, expression: string, destination: string) {
  return {
    cadence,
    enabled: false,
    trigger: { kind: "cron", expression },
    inputs: [],
    primary_metrics: [],
    guardrail_metrics: [],
    metric_definitions: [],
    candidate_rules: [],
    decision_rules: [],
    maximum_actions: cadence === "weekly" ? 3 : 1,
    maximum_iterations: 1,
    autonomy: "propose",
    authorized_effect_types: ["none", "local_write", "git_write"],
    output_destination: destination,
    next_run_at: null,
    stop_condition: "Stop when required data is missing or stale; report the exact missing source.",
    extensions: {},
  };
}

const loopsConfig = {
  contract_version: 1,
  loops: {
    daily_early_signal: disabledLoop("daily", "0 6 * * *", "reports/learning/daily"),
    weekly_growth: disabledLoop("weekly", "0 6 * * 1", "reports/learning/weekly"),
    biweekly_product: disabledLoop("biweekly", "0 7 1,15 * *", "reports/learning/biweekly"),
    monthly_strategy: disabledLoop("monthly", "0 8 1 * *", "reports/learning/monthly"),
  },
  extensions: {},
};

function unconfiguredProvider(capabilityIds: readonly string[], selectedTransport = "none") {
  return {
    state: "unconfigured",
    capability_ids: capabilityIds,
    external_resource_ids: {},
    account_id: null,
    team_id: null,
    region: null,
    selected_transport: selectedTransport,
    credential_ref: null,
    required_scopes: [],
    last_verified_at: null,
    evidence_artifact_ref: null,
    error_code: null,
    error_message: null,
    retryable: null,
    next_action: null,
    manual_action_ref: null,
    extensions: {},
  };
}

const providersConfig = {
  contract_version: 1,
  providers: {
    github: unconfiguredProvider([]),
    vercel: unconfiguredProvider(["public_website", "vercel_analytics"]),
    neon: unconfiguredProvider(["database"]),
    stripe: unconfiguredProvider(["stripe"]),
    revenuecat: unconfiguredProvider(["revenuecat"]),
    brevo: unconfiguredProvider(["transactional_email", "lifecycle_email"]),
    google: unconfiguredProvider(["ga4", "gsc"]),
    bing: unconfiguredProvider(["bing_webmaster"]),
    dns: unconfiguredProvider(["public_website"], "manual"),
    mijndomein: unconfiguredProvider(["public_website"], "manual"),
    app_store_connect: unconfiguredProvider(["app_store_connect", "ios_aso"]),
    eas: unconfiguredProvider(["eas"]),
  },
  extensions: {},
};

interface PolicyProfileOverrides {
  allowed_side_effect_classes?: readonly string[];
  allowed_risk_classes?: readonly string[];
  allowed_environments?: readonly string[];
  unknown_external_costs_allowed?: boolean;
  max_email_recipients?: number;
  production_deploy_allowed?: boolean;
  live_products_and_prices_allowed?: boolean;
  actual_charges_allowed?: boolean;
  transactional_test_email_allowed?: boolean;
  dns_additions_allowed?: boolean;
}

function policyProfile(overrides: PolicyProfileOverrides = {}) {
  return {
    allowed_capabilities: ["*"],
    allowed_side_effect_classes: ["none"],
    allowed_risk_classes: ["low"],
    allowed_environments: ["local"],
    max_estimated_spend: { amount: 0, currency: "EUR" },
    unknown_external_costs_allowed: false,
    max_email_recipients: 0,
    production_deploy_allowed: false,
    live_products_and_prices_allowed: false,
    actual_charges_allowed: false,
    transactional_test_email_allowed: false,
    dns_additions_allowed: false,
    nameserver_changes_allowed: false,
    app_store_submission_allowed: false,
    extensions: {},
    ...overrides,
  };
}

const productionSideEffects = [
  "none",
  "local_write",
  "git_write",
  "external_read",
  "reversible_external_write",
  "preview_deploy",
  "production_deploy",
  "transactional_email",
  "dns_addition",
];

const policiesConfig = {
  contract_version: 1,
  authorization: {
    default_profile: "read_only",
    profiles: {
      read_only: policyProfile({
        allowed_side_effect_classes: ["none", "external_read"],
        allowed_environments: ["local", "test", "preview", "production"],
      }),
      build_local: policyProfile({
        allowed_side_effect_classes: ["none", "local_write", "git_write"],
        allowed_risk_classes: ["low", "moderate"],
        allowed_environments: ["local", "test"],
      }),
      preview_launch: policyProfile({
        allowed_side_effect_classes: [
          "none",
          "local_write",
          "git_write",
          "external_read",
          "reversible_external_write",
          "preview_deploy",
        ],
        allowed_risk_classes: ["low", "moderate", "high"],
        allowed_environments: ["local", "test", "preview"],
        unknown_external_costs_allowed: true,
      }),
      standard_launch: policyProfile({
        allowed_side_effect_classes: productionSideEffects,
        allowed_risk_classes: ["low", "moderate", "high", "critical"],
        allowed_environments: ["local", "test", "preview", "production"],
        max_email_recipients: 1,
        unknown_external_costs_allowed: true,
        production_deploy_allowed: true,
        transactional_test_email_allowed: true,
        dns_additions_allowed: true,
      }),
      live_commerce_launch: policyProfile({
        allowed_side_effect_classes: [
          ...productionSideEffects,
          "live_commerce_config",
          "customer_charge",
        ],
        allowed_risk_classes: ["low", "moderate", "high", "critical"],
        allowed_environments: ["local", "test", "preview", "production"],
        max_email_recipients: 1,
        unknown_external_costs_allowed: true,
        production_deploy_allowed: true,
        live_products_and_prices_allowed: true,
        actual_charges_allowed: true,
        transactional_test_email_allowed: true,
        dns_additions_allowed: true,
      }),
      mobile_testflight: policyProfile({
        allowed_side_effect_classes: [
          "none",
          "local_write",
          "git_write",
          "external_read",
          "reversible_external_write",
          "preview_deploy",
          "production_deploy",
          "dns_addition",
          "testflight_upload",
        ],
        allowed_risk_classes: ["low", "moderate", "high", "critical"],
        allowed_environments: ["local", "test", "preview", "production"],
        unknown_external_costs_allowed: true,
        production_deploy_allowed: true,
        dns_additions_allowed: true,
      }),
      autofix_low_risk: policyProfile({
        allowed_side_effect_classes: ["none", "local_write", "git_write"],
        allowed_environments: ["local", "test"],
      }),
    },
    active_envelopes: [],
    always_require_distinct_checkpoint_for: [
      "external_delete",
      "destructive_data_change",
      "nameserver_change",
      "bulk_communication",
      "customer_charge",
      "app_store_publication",
    ],
    extensions: {},
  },
  extensions: {},
};

const offerConfig = {
  icp: { description: null, disqualifiers: [] },
  offer: { sentence: null, day_one_win: null, guarantee: null },
  pricing: {
    currency: "EUR",
    monthly_price: null,
    annual_price: null,
    one_time_price: null,
    implementation_fee: null,
    annual_waives_implementation_fee: false,
    usage_price: null,
    upsell: null,
  },
  economics: {
    cac_assumption: null,
    delivery_cost_monthly: null,
    onboarding_cost: null,
    target_contribution_margin: 0.7,
    payback_target_days: null,
  },
};

const ordinaryWebFiles: readonly SeedFileTemplate[] = [
  file("pnpm-lock.yaml", "merge_managed", AGENTIC_WEB_PNPM_LOCK),
  file(
    "PROJECT.md",
    "venture_owned",
    `# {{ventureName}}

## Purpose

Build the smallest trustworthy product described by \`config/launch-contract.yaml\`. The generated neutral surface is a temporary scaffold, not the finished product.

## Source of truth

1. \`config/launch-contract.yaml\` — the typed founder decision when created through the public sharpen-and-launch path.
2. \`docs/product/PRODUCT_CONSTITUTION.md\` — product identity, truth classes, boundaries, and learning question.
3. \`docs/product/idea.md\` — human review surface for the same contract.
4. \`docs/product/PRODUCT_TRUTH.md\` — claims and evidence ceiling.

## Product boundary

- One primary journey; product-specific implementation and design remain venture-owned.
- Provider configuration begins unconfigured and credential-free.
- Analytics begins with no provider, event, experiment, or scheduled-learning assumptions.
- Recursive tenancy, customer Agent Surfaces, Winner Loop, DistributionPR, Fleet, and mobile tooling are absent unless the Launch Contract selects them.
`,
  ),
  file(
    "AGENTS.md",
    "venture_owned",
    `# {{ventureName}} agent instructions

Read \`PROJECT.md\`, \`config/launch-contract.yaml\` when present, \`docs/product/PRODUCT_CONSTITUTION.md\`, \`docs/product/PRODUCT_TRUTH.md\`, and the relevant typed config before changing product code.

Use \`skills/design-director/SKILL.md\` for the first product/design pass. Use \`skills/seo-aeo-engine/SKILL.md\` only when \`web_seo_aeo_geo\` is REQUIRED in the selected build context. Implement only the Launch Contract's core journey and explicit capabilities. Missing non-critical detail becomes a labeled assumption; never invent users, provider state, demand, queries, traffic, citations, metrics, revenue, reviews, or evidence.

Keep credentials and private runtime state out of Git and model context. Product and design files are venture-owned; Core upgrades may not overwrite them. Run \`pnpm verify:fast\` for focused work and \`pnpm verify\` before completion.
`,
  ),
  file(
    "docs/product/PRODUCT_CONSTITUTION.md",
    "venture_owned",
    `# {{ventureName}} Product Constitution

This placeholder records no proposition or evidence. The public founder launch replaces it from the reviewed \`config/launch-contract.yaml\` before product work begins.

Until then, every capability, provider connection, customer outcome, metric, and commercial result is UNKNOWN. Samples must be labeled FIXTURE. Models may improve framing and implementation but may not invent evidence.
`,
  ),
  file(
    "docs/product/idea.md",
    "venture_owned",
    `# {{ventureName}} idea

The canonical founder path writes the human-readable sharpened idea here and the typed source to \`config/launch-contract.yaml\`. This seed placeholder makes no product or market claim.
`,
  ),
  file(
    "skills/design-director/SKILL.md",
    "core_owned",
    `---
name: design-director
description: Turn this venture's Launch Contract and Product Constitution into an original, accessible product identity and primary journey. Use for the first product/design pass and material redesigns.
---

# Design director

## Inputs

Read \`config/launch-contract.yaml\`, \`docs/product/PRODUCT_CONSTITUTION.md\`, \`PROJECT.md\`, and existing product/design files. If the Launch Contract is absent, stop design judgment and report that exact missing input.

## Process

1. Extract the target user, painful job, desired outcome, one core feature, primary journey, design thesis, trust requirements, explicit exclusions, and truth boundaries.
2. Write one venture-specific visual thesis. Choose type, colour, spacing, shape, density, and motion because they support that thesis.
3. Implement real product UI for the primary journey at mobile and desktop sizes, with visible focus, semantic structure, readable contrast, and reduced-motion behavior.
4. Add one memorable interaction only when it clarifies product state or progress. Label sample data as FIXTURE.
5. Run the originality audit in \`references/originality-audit.md\`, then run the relevant quality commands.

## Ownership and truth

Product and design files are venture-owned: application pages, product components, copy, identity, themes, illustrations, and product-specific tests. Do not copy Venture Harness branding or another venture. Do not add testimonials, customer logos, metrics, outcomes, integrations, or provider state without evidence in Product Truth.
`,
  ),
  file(
    "skills/design-director/references/originality-audit.md",
    "core_owned",
    `# Originality audit

Reject the result if any answer is yes without a product-specific reason:

- Is it a generic purple AI gradient, interchangeable bento grid, or row of identical feature cards?
- Does it use filler stock imagery, an arbitrary icon logo, fake social proof, fake metrics, or unlabeled sample data?
- Is it a static marketing page when the Launch Contract requires an application journey?
- Could the interface belong to an unrelated product after changing only the name?
- Does it copy Venture Harness identity or overwrite venture-owned design?

Require a coherent design thesis, useful hierarchy, product-specific states, keyboard-visible focus, reduced motion, mobile layout, accessible contrast, one clear primary action, and one purposeful memorable interaction. Unsupported claims fail the audit.
`,
  ),
  file(
    "skills/seo-aeo-engine/SKILL.md",
    "core_owned",
    `---
name: seo-aeo-engine
description: Implement truthful technical SEO/AEO only when the Launch Contract requires web_seo_aeo_geo.
---

# SEO/AEO engine

Read \`config/launch-contract.yaml\`, \`config/seo.yaml\`, Product Truth, and \`references/technical-discovery.md\`. If the capability is not REQUIRED, do not add discovery infrastructure. If a required file is missing, stop.

Keep one intentional canonical owner per user task. Put the direct answer and decisive limitation in raw HTML. Give every owner a unique accurate title, description, visible H1, self-canonical, and useful next step. Keep auth, account, edit, draft, API, private, user-generated, and noindex routes out of sitemaps. Structured data must parse and describe visible verified facts only. Never invent queries, traffic, citations, ratings, reviews, people, customers, outcomes, or provider state.

Indexing remains disabled until a verified production origin, product-truth review, successful raw-HTML/crawl checks, and the explicit \`NEXT_PUBLIC_INDEXING_ENABLED=true\` opt-in. A sitemap, indexing request, or crawler receipt proves neither indexation nor demand.
`,
  ),
  file(
    "skills/seo-aeo-engine/references/technical-discovery.md",
    "core_owned",
    `# Technical discovery checklist

For each intended public owner, verify a stable 200 response, raw HTML proposition and limitation, unique title and description, one H1, absolute self-canonical, useful internal link, mobile/accessibility baseline, and truthful parseable JSON-LD when present.

The sitemap may contain only preferred public 200 owners. Exclude auth, account, edit, draft, API, search-result, private, user-generated, parameterized, redirected, and noindex routes. Robots, meta robots, canonical, sitemap, internal links, and structured-data identifiers must agree. Search crawling and model-training permission are separate policy choices.
`,
  ),
  file(
    "config/seo.yaml",
    "venture_owned",
    `schema_version: 1
maturity: pre-launch
indexing:
  default: disabled
  activation: verified_production_plus_explicit_environment_opt_in
  environment_flag: NEXT_PUBLIC_INDEXING_ENABLED=true
canonical_owners:
  - route: /
    user_task: venture-specific primary journey
    state: candidate_until_product_review
excluded_route_prefixes:
  - /api
  - /auth
  - /account
  - /edit
  - /draft
  - /private
  - /user
excluded_routes:
  - /status
structured_data: visible_verified_facts_only
query_evidence: missing
live_indexation: unknown
`,
  ),
  file(
    "app/layout.tsx",
    "merge_managed",
    `import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../src/design/theme.css";
import "./globals.css";
import { INDEXING_ENABLED, SITE, SITE_URL } from "../src/config/site";

export const metadata: Metadata = {
  metadataBase: SITE_URL,
  title: { default: SITE.name, template: "%s | " + SITE.name },
  description: SITE.description,
  robots: { index: INDEXING_ENABLED, follow: INDEXING_ENABLED },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
  ),
  file(
    "app/page.tsx",
    "venture_owned",
    `import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "../src/config/site";

export const metadata: Metadata = {
  title: SITE.name,
  description: SITE.description,
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <main className="shell">
      <header className="masthead" aria-labelledby="venture-title">
        <p className="eyebrow">Independent web product scaffold</p>
        <h1 id="venture-title">{{ventureName}}</h1>
        <p className="lede">
          A focused foundation for the venture-specific primary journey. Capabilities remain
          unverified until the launch flow builds and tests them.
        </p>
        <Link className="primaryAction" href="/status">
          Review launch status
        </Link>
      </header>
      <section className="statusStrip" aria-labelledby="current-state">
        <h2 id="current-state">Current state</h2>
        <p>Buildable scaffold · provider effects unconfigured · indexing disabled by default</p>
      </section>
    </main>
  );
}
`,
  ),
  file(
    "app/status/page.tsx",
    "venture_owned",
    `import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "../../src/config/site";

export const metadata: Metadata = {
  title: "Launch status",
  description: "Current local verification boundary for " + SITE.name + ".",
  alternates: { canonical: "/status" },
  robots: { index: false, follow: false },
};

export default function StatusPage() {
  return (
    <main className="shell compact">
      <p className="eyebrow">Product truth</p>
      <h1>{{ventureName}} is not launched yet.</h1>
      <p className="lede">
        This repository contains a working web foundation. Provider accounts, customer outcomes,
        commerce, and production state require separate verified evidence.
      </p>
      <Link className="textLink" href="/">Return home</Link>
    </main>
  );
}
`,
  ),
  file(
    "app/api/health/route.ts",
    "core_owned",
    `export function GET() {
  const localServerNonce = process.env.VH_LOCAL_SERVER_NONCE;
  return Response.json({
    status: "ok",
    venture: "{{ventureSlug}}",
    evidence: "local_build_shape",
    ...(localServerNonce ? { localServerNonce } : {}),
  });
}
`,
  ),
  file(
    "app/robots.ts",
    "merge_managed",
    `import type { MetadataRoute } from "next";
import { INDEXING_ENABLED, SITE_URL } from "../src/config/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: INDEXING_ENABLED ? "/" : undefined, disallow: INDEXING_ENABLED ? undefined : "/" },
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  };
}
`,
  ),
  file(
    "app/sitemap.ts",
    "merge_managed",
    `import type { MetadataRoute } from "next";
import { INDEXING_ENABLED, SITE_URL } from "../src/config/site";

export default function sitemap(): MetadataRoute.Sitemap {
  if (!INDEXING_ENABLED) return [];
  return [
    { url: new URL("/", SITE_URL).toString(), changeFrequency: "weekly", priority: 1 },
  ];
}
`,
  ),
  file(
    "app/globals.css",
    "venture_owned",
    `* { box-sizing: border-box; }
html { background: #f5f2e9; color: #151b1c; }
body { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
a { color: inherit; }
a:focus-visible { outline: 3px solid var(--accent-secondary); outline-offset: 4px; }
.shell { min-height: 100vh; padding: clamp(1.5rem, 5vw, 5rem); display: grid; align-content: space-between; gap: 4rem; }
.shell::before { content: ""; width: min(14rem, 42vw); height: var(--motif-step); background: var(--accent); display: block; }
.masthead, .compact { max-width: 58rem; }
.eyebrow { color: var(--accent); font-size: .78rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
h1, h2 { font-family: Georgia, "Times New Roman", serif; font-weight: 500; letter-spacing: -.035em; margin: 0; text-wrap: balance; }
h1 { font-size: clamp(3rem, 10vw, 7.5rem); line-height: .92; max-width: 11ch; }
h2 { font-size: clamp(1.5rem, 4vw, 2.25rem); }
.lede { max-width: 46rem; font-size: clamp(1.1rem, 2vw, 1.35rem); line-height: 1.65; margin: 1.75rem 0; }
.primaryAction { display: inline-block; background: var(--accent); color: white; padding: .9rem 1.15rem; border: 2px solid var(--accent); font-weight: 750; text-decoration: none; }
.primaryAction:hover { background: #151b1c; border-color: #151b1c; }
.statusStrip { border-top: 1px solid #9c9a91; padding-top: 1.25rem; display: grid; grid-template-columns: minmax(10rem, .35fr) 1fr; gap: 1.5rem; }
.statusStrip p { margin: .35rem 0 0; line-height: 1.6; }
.compact { align-content: start; }
.textLink { color: var(--accent); font-weight: 750; text-underline-offset: .25em; }
@media (max-width: 42rem) {
  .shell { align-content: start; gap: 3rem; }
  .statusStrip { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`,
  ),
  file(
    "src/config/site.ts",
    "merge_managed",
    `function exactHttpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = value.includes("://") ? value : \`https://\${value}\`;
  const parsed = new URL(candidate);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("The configured site URL must be one exact HTTP(S) origin");
  }
  return parsed.origin;
}

const explicitSiteOrigin = exactHttpOrigin(process.env.NEXT_PUBLIC_SITE_URL);
const vercelProductionOrigin = exactHttpOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);
const configuredSiteUrl =
  explicitSiteOrigin ?? vercelProductionOrigin ?? "https://local-e2e.example.invalid";
const verifiedProductionEnvironment =
  process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production";

export const SITE_URL = new URL(configuredSiteUrl);
export const INDEXING_ENABLED =
  verifiedProductionEnvironment &&
  Boolean(explicitSiteOrigin ?? vercelProductionOrigin) &&
  SITE_URL.protocol === "https:" &&
  process.env.NEXT_PUBLIC_INDEXING_ENABLED === "true";
export const SITE = Object.freeze({
  name: "{{ventureName}}",
  slug: "{{ventureSlug}}",
  description:
    "An independently buildable product scaffold; capabilities require launch-time verification.",
});
`,
  ),
  file(
    "src/analytics/events.ts",
    "merge_managed",
    `// The focused seed has no universal analytics events. The Launch Contract
// and implemented primary journey must justify each allowlisted event.
export const ANALYTICS_EVENT_NAMES = [] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];
export interface SafeAnalyticsProperties {
  route_id?: string;
  journey_id?: string;
  surface_id?: string;
  outcome_id?: string;
  release_version?: string;
}

export function analyticsEvent(name: AnalyticsEventName, properties: SafeAnalyticsProperties) {
  return Object.freeze({ name, properties: Object.freeze({ ...properties }) });
}
`,
  ),
  file(
    "scripts/github-publish-source.ts",
    "core_owned",
    String.raw`import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const MAX_ENTRIES = 10_000;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_PATH_BYTES = 1_024;
const MAX_PATH_COMPONENT_BYTES = 255;
const COMMIT_MESSAGE = "chore: publish verified venture source";
const BOOTSTRAP_PATH = ".venture-harness-bootstrap";
const BOOTSTRAP_CONTENT = Buffer.from("venture-harness-source-bootstrap-v1\n", "utf8");
const RUNTIME_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
  "CI",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
] as const;
const GIT_ENVIRONMENT_OVERRIDES = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);

type Visibility = "private" | "public" | "internal";
type TreeMode = "100644" | "100755";

interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

interface SourceEntry {
  path: string;
  mode: TreeMode;
  oid: string;
  content: Buffer;
}

interface SourceSnapshot {
  treeOid: string;
  entries: readonly SourceEntry[];
}

interface RepositoryState {
  visibility: Visibility;
  archived: boolean;
  defaultBranch: string | null;
}

interface BranchState {
  commitOid: string;
  treeOid: string;
}

function commandEnvironment(command: string, overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    NPM_CONFIG_GLOBALCONFIG: nullDevice,
    NPM_CONFIG_USERCONFIG: nullDevice,
    npm_config_globalconfig: nullDevice,
    npm_config_userconfig: nullDevice,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
  for (const name of RUNTIME_ENVIRONMENT_KEYS) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const executable = command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  for (const [name, value] of Object.entries(overrides)) {
    if (
      executable !== "git" ||
      !GIT_ENVIRONMENT_OVERRIDES.has(name) ||
      !isAbsolute(value) ||
      value.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("Refusing unsupported direct-command environment field " + name);
    }
    environment[name] = value;
  }
  return environment;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; input?: Buffer } = { cwd: process.cwd() },
): CommandResult {
  if (!command || /\s/.test(command) || ["sh", "bash", "zsh", "fish"].includes(command)) {
    throw new Error("Refusing an unsafe command binary");
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: commandEnvironment(command, options.env ?? {}),
    input: options.input,
    encoding: null,
    shell: false,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) {
    const code = "code" in result.error ? String(result.error.code) : "spawn_error";
    throw new Error("Direct " + command + " invocation failed (" + code + ")");
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function success(result: CommandResult, label: string): Buffer {
  if (result.exitCode !== 0) {
    throw new Error(label + " failed with exit code " + result.exitCode + "; no remote state was inferred");
  }
  return result.stdout;
}

function isMissing(result: CommandResult): boolean {
  return result.exitCode !== 0 && /(?:HTTP\s+(?:404|409)|not found|repository is empty)/i.test(result.stderr);
}

function json(stdout: Buffer, label: string): unknown {
  try {
    return JSON.parse(stdout.toString("utf8")) as unknown;
  } catch {
    throw new Error(label + " did not return valid JSON");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " did not return one JSON object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " did not return one non-empty string");
  }
  return value;
}

function assertRepository(repository: string): void {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository) ||
    repository.endsWith(".git")
  ) {
    throw new Error("GitHub repository must be an exact owner/name target");
  }
}

function assertVisibility(value: string): asserts value is Visibility {
  if (value !== "private" && value !== "public" && value !== "internal") {
    throw new Error("Unsupported GitHub repository visibility");
  }
}

function assertBranch(branch: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith(".lock")
  ) {
    throw new Error("GitHub default branch is not a safe exact ref");
  }
}

function assertOid(oid: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(label + " is not an exact SHA-1 object id");
}

const CREDENTIAL_STORE_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pypirc",
  ".git-credentials",
  ".terraformrc",
  "terraform.rc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const CREDENTIAL_STORE_SUFFIXES = [
  "/.docker/config.json",
  "/.config/containers/auth.json",
  "/.config/gcloud/application_default_credentials.json",
  "/.aws/credentials",
  "/.kube/config",
  "/.cargo/credentials",
  "/.cargo/credentials.toml",
  "/.gem/credentials",
] as const;

function isCredentialStorePath(path: string): boolean {
  const normalized = "/" + path.toLowerCase();
  const name = normalized.split("/").at(-1) ?? "";
  return (
    CREDENTIAL_STORE_BASENAMES.has(name) ||
    CREDENTIAL_STORE_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    /(?:^|[/_.-])service[-_]?account(?:[/_.-]|$).*\.json$/u.test(normalized) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(name)
  );
}

function assertSourcePath(path: string): void {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    Buffer.from(path, "utf8").toString("utf8") !== path ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part, "utf8") > MAX_PATH_COMPONENT_BYTES ||
        part.toLowerCase() === ".git",
    )
  ) {
    throw new Error("Local source contains an unsafe path");
  }
  if (
    path === BOOTSTRAP_PATH ||
    path === ".venture" ||
    path.startsWith(".venture/") ||
    path === "reports" ||
    path.startsWith("reports/")
  ) {
    throw new Error("Local source contains a reserved private runtime path");
  }
  const name = path.split("/").at(-1) ?? path;
  const environmentFile = /^\.env(?:\..+)?$/.test(name);
  const reviewedExample = name === ".env.example" || /^\.env(?:\..+)?\.example$/.test(name);
  if (environmentFile && !reviewedExample) {
    throw new Error("Local source contains an unreviewed environment file");
  }
  if (isCredentialStorePath(path)) {
    throw new Error("Local source contains credential-store path " + JSON.stringify(path));
  }
}

const CREDENTIAL_PATTERNS = [
  new RegExp("\\bsk-" + "proj-[A-Za-z0-9_-]{16,}", "iu"),
  new RegExp("\\bsk-" + "[A-Za-z0-9_-]{20,}", "iu"),
  new RegExp("\\b(?:sk|rk|pk|atk)_" + "(?:live|test)?_?[A-Za-z0-9_-]{8,}", "iu"),
  new RegExp("\\bwh" + "sec_[A-Za-z0-9_-]{8,}", "iu"),
  new RegExp("\\bxkey" + "sib-[A-Za-z0-9_-]{12,}", "iu"),
  new RegExp("\\b(?:gh" + "[pousr]_[A-Za-z0-9_]{20,}|github" + "_pat_[A-Za-z0-9_]{20,})\\b", "iu"),
  new RegExp("\\bxox" + "[baprs]-[A-Za-z0-9-]{10,}", "iu"),
  new RegExp("\\b(?:AKIA|ASIA)" + "[A-Z0-9]{16}\\b", "u"),
  new RegExp("\\bbearer\\s+" + "[A-Za-z0-9._~+/=-]{8,}", "iu"),
  new RegExp("-----BEGIN " + "[A-Z ]*PRIVATE KEY-----", "u"),
  new RegExp("\\beyJ" + "[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b", "iu"),
  new RegExp("[?&](?:access_token|api_key|token|secret)=" + "[^&\\s]{6,}", "iu"),
  new RegExp("\\b[A-Za-z][A-Za-z0-9+.-]*://" + "[^\\s/:@]+:[^\\s/@]+@", "iu"),
] as const;
const CREDENTIAL_REFERENCE = /^cred:\/\/[A-Za-z0-9][A-Za-z0-9/_:.-]*$/u;
const BENIGN_CREDENTIAL_PLACEHOLDER =
  /^(?:REPLACE(?:_WITH)?_[A-Z0-9_]+|YOUR_[A-Z0-9_]+|<[^<>\r\n]{1,80}>|\[(?:REDACTED|MASKED)\])$/u;
const CREDENTIAL_LABELED_LINE =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}\s+)?(?:access[ _-]?token|refresh[ _-]?token|id[ _-]?token|api[ _-]?key|client[ _-]?secret|private[ _-]?key|password|secret|credential(?:[ _-]?value)?|authorization(?:\s+header)?)\s*[:=]\s*\S+/iu;
const CONFIG_LITERAL = /^[A-Za-z0-9._~+/=-]{12,}$/u;

function containsCredentialLabeledLiteral(value: string): boolean {
  for (const line of value.split(/\r?\n/u)) {
    if (!CREDENTIAL_LABELED_LINE.test(line)) continue;
    const separator = line.search(/[:=]/u);
    if (separator < 0) continue;
    let literal = line.slice(separator + 1).trim().replace(/,\s*$/u, "");
    const quote = literal[0];
    if ((quote === '"' || quote === "'") && literal.at(-1) === quote) {
      literal = literal.slice(1, -1);
    }
    if (CREDENTIAL_REFERENCE.test(literal) || BENIGN_CREDENTIAL_PLACEHOLDER.test(literal)) {
      continue;
    }
    if (CONFIG_LITERAL.test(literal) && /[0-9._~+/=-]/u.test(literal)) return true;
  }
  return false;
}

function assertCredentialFreeBuffer(path: string, content: Buffer): void {
  const value = content.toString("utf8");
  const pattern = CREDENTIAL_PATTERNS.some((candidate) => candidate.test(value));
  const labeled = containsCredentialLabeledLiteral(value);
  if (pattern || labeled) {
    const category = labeled ? "credential_labeled_text" : "credential_pattern";
    throw new Error(
      "Local source blob " + JSON.stringify(path) + " contains credential-like content (" + category + ")",
    );
  }
}

interface SourceTreeDirectory {
  readonly directories: Map<string, SourceTreeDirectory>;
  readonly entries: Map<string, Pick<SourceEntry, "mode" | "oid">>;
}

function sourceTreeOid(entries: readonly SourceEntry[]): string {
  const root = (): SourceTreeDirectory => ({ directories: new Map(), entries: new Map() });
  const tree = root();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let directory = tree;
    for (const [index, part] of parts.entries()) {
      const leaf = index === parts.length - 1;
      if (leaf) {
        if (directory.directories.has(part) || directory.entries.has(part)) {
          throw new Error("Local source tree contains a conflicting path");
        }
        directory.entries.set(part, { mode: entry.mode, oid: entry.oid });
      } else {
        if (directory.entries.has(part)) throw new Error("Local source tree contains a conflicting path");
        let child = directory.directories.get(part);
        if (!child) {
          child = root();
          directory.directories.set(part, child);
        }
        directory = child;
      }
    }
  }
  const hash = (directory: SourceTreeDirectory): string => {
    const children = [
      ...[...directory.entries.entries()].map(([name, entry]) => ({
        name,
        sortName: Buffer.from(name, "utf8"),
        mode: entry.mode,
        oid: entry.oid,
      })),
      ...[...directory.directories.entries()].map(([name, child]) => ({
        name,
        sortName: Buffer.from(name + "/", "utf8"),
        mode: "40000",
        oid: hash(child),
      })),
    ].sort((left, right) => Buffer.compare(left.sortName, right.sortName));
    const body = Buffer.concat(
      children.map((child) =>
        Buffer.concat([
          Buffer.from(child.mode + " " + child.name + "\0", "utf8"),
          Buffer.from(child.oid, "hex"),
        ]),
      ),
    );
    return createHash("sha1")
      .update(Buffer.from("tree " + body.byteLength + "\0", "utf8"))
      .update(body)
      .digest("hex");
  };
  return hash(tree);
}

function validateSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  assertOid(snapshot.treeOid, "Local source tree id");
  if (snapshot.entries.length === 0) throw new Error("Refusing to publish an empty source tree");
  if (snapshot.entries.length > MAX_ENTRIES) throw new Error("Local source exceeds the entry safety limit");
  const exactPaths = new Set<string>();
  const portablePaths = new Set<string>();
  const entries: SourceEntry[] = [];
  let totalBytes = 0;
  for (const candidate of snapshot.entries) {
    assertSourcePath(candidate.path);
    if (exactPaths.has(candidate.path)) throw new Error("Local source tree contains a duplicate path");
    exactPaths.add(candidate.path);
    const portablePath = candidate.path.normalize("NFC").toLowerCase();
    if (portablePaths.has(portablePath)) throw new Error("Local source tree contains an ambiguous path");
    portablePaths.add(portablePath);
    if (candidate.mode !== "100644" && candidate.mode !== "100755") {
      throw new Error("Local source contains an unsupported tree entry");
    }
    assertOid(candidate.oid, "Local source blob id");
    const content = Buffer.from(candidate.content);
    if (content.byteLength > MAX_BLOB_BYTES) throw new Error("Local source blob exceeds the safety limit");
    totalBytes += content.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Local source exceeds the aggregate safety limit");
    if (gitBlobOid(content) !== candidate.oid) {
      throw new Error("Local source blob does not match its exact object id");
    }
    assertCredentialFreeBuffer(candidate.path, content);
    entries.push(Object.freeze({ path: candidate.path, mode: candidate.mode, oid: candidate.oid, content }));
  }
  if (sourceTreeOid(entries) !== snapshot.treeOid) {
    throw new Error("Local source tree id does not match its exact validated entries");
  }
  return Object.freeze({ treeOid: snapshot.treeOid, entries: Object.freeze(entries) });
}

const PREFLIGHT_IGNORED_ROOTS = new Set([
  ".git",
  ".next",
  ".venture",
  "coverage",
  "dist",
  "node_modules",
  "reports",
]);

function assertPrivateRegularSourceTree(root: string): void {
  const visit = (directory: string, relativeDirectory = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
      if (!relativeDirectory && PREFLIGHT_IGNORED_ROOTS.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("Local source contains a symbolic link at " + path);
      }
      if (metadata.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error("Local source contains a non-private or non-regular entry at " + path);
      }
    }
  };
  visit(root);
}

function loadSnapshot(root: string): SourceSnapshot {
  const sourceRoot = realpathSync(root);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "vh-child-source-"));
  const gitDirectory = join(temporaryRoot, "source.git");
  const gitEnvironment = { GIT_DIR: gitDirectory, GIT_WORK_TREE: sourceRoot };
  try {
    assertPrivateRegularSourceTree(sourceRoot);
    success(
      run("git", ["init", "--bare", "--object-format=sha1", gitDirectory], { cwd: sourceRoot }),
      "Initialize isolated source index",
    );
    success(
      run("git", ["add", "-A", "--", "."], { cwd: sourceRoot, env: gitEnvironment }),
      "Snapshot local venture source",
    );
    const treeOid = success(run("git", ["write-tree"], { cwd: sourceRoot, env: gitEnvironment }), "Write local source tree")
      .toString("utf8")
      .trim();
    assertOid(treeOid, "Local source tree id");
    const listing = success(
      run("git", ["ls-tree", "-r", "-z", "--full-tree", treeOid], {
        cwd: sourceRoot,
        env: gitEnvironment,
      }),
      "List local source tree",
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (listing.length === 0) throw new Error("Refusing to publish an empty source tree");
    if (listing.length > MAX_ENTRIES) throw new Error("Local source exceeds the entry safety limit");

    const entries: SourceEntry[] = [];
    let totalBytes = 0;
    for (const row of listing) {
      const separator = row.indexOf("\t");
      if (separator < 0) throw new Error("Local source tree returned a malformed entry");
      const [mode, type, oid] = row.slice(0, separator).split(" ");
      const path = row.slice(separator + 1);
      if (type !== "blob" || !["100644", "100755"].includes(mode ?? "")) {
        throw new Error("Local source contains an unsupported tree entry");
      }
      assertSourcePath(path);
      assertOid(oid ?? "", "Local source blob id");
      const content = success(
        run("git", ["cat-file", "blob", oid!], { cwd: sourceRoot, env: gitEnvironment }),
        "Read local source blob",
      );
      if (content.byteLength > MAX_BLOB_BYTES) throw new Error("Local source blob exceeds the safety limit");
      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Local source exceeds the aggregate safety limit");
      entries.push({ path, mode: mode as TreeMode, oid: oid!, content });
    }
    return validateSnapshot({ treeOid, entries });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function gh(path: string, options: { method?: string; body?: unknown } = {}): CommandResult {
  const args = ["api", path];
  if (options.method) args.push("--method", options.method);
  if (options.body !== undefined) args.push("--input", "-");
  return run("gh", args, {
    cwd: process.cwd(),
    ...(options.body === undefined
      ? {}
      : { input: Buffer.from(JSON.stringify(options.body), "utf8") }),
  });
}

function readRepository(repository: string): RepositoryState | null {
  const result = gh("repos/" + repository);
  if (isMissing(result)) return null;
  const response = record(json(success(result, "Read GitHub repository"), "GitHub repository"), "GitHub repository");
  if (text(response.full_name, "GitHub repository name").toLowerCase() !== repository.toLowerCase()) {
    throw new Error("GitHub repository read-back returned a different target");
  }
  const visibility = text(response.visibility, "GitHub repository visibility");
  assertVisibility(visibility);
  if (typeof response.archived !== "boolean") throw new Error("GitHub repository archived state is missing");
  const defaultBranch = response.default_branch == null ? null : text(response.default_branch, "GitHub default branch");
  if (defaultBranch) assertBranch(defaultBranch);
  return { visibility, archived: response.archived, defaultBranch };
}

function assertRepositoryState(state: RepositoryState, visibility: Visibility): void {
  if (state.visibility !== visibility) {
    throw new Error("GitHub repository visibility differs from the authorized target");
  }
  if (state.archived) throw new Error("GitHub repository is archived");
}

function readBranch(repository: string, branch: string): BranchState | null {
  const reference = gh("repos/" + repository + "/git/ref/heads/" + encodeURIComponent(branch));
  if (isMissing(reference)) return null;
  const ref = record(json(success(reference, "Read GitHub branch"), "GitHub branch"), "GitHub branch");
  const commitOid = text(record(ref.object, "GitHub branch object").sha, "GitHub branch commit id");
  assertOid(commitOid, "GitHub branch commit id");
  const commitResult = gh("repos/" + repository + "/git/commits/" + commitOid);
  const commit = record(json(success(commitResult, "Read GitHub commit"), "GitHub commit"), "GitHub commit");
  const treeOid = text(record(commit.tree, "GitHub commit tree").sha, "GitHub commit tree id");
  assertOid(treeOid, "GitHub commit tree id");
  return { commitOid, treeOid };
}

function createRepository(repository: string, visibility: Visibility): void {
  success(
    run("gh", ["repo", "create", repository, "--" + visibility], { cwd: process.cwd() }),
    "Create GitHub repository",
  );
}

function gitBlobOid(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from("blob " + content.byteLength + "\0", "utf8"))
    .update(content)
    .digest("hex");
}

function bootstrapRepository(repository: string): void {
  const result = gh("repos/" + repository + "/contents/" + BOOTSTRAP_PATH, {
    method: "PUT",
    body: {
      message: "chore: initialize source publication",
      content: BOOTSTRAP_CONTENT.toString("base64"),
    },
  });
  const response = record(
    json(success(result, "Initialize empty GitHub repository"), "GitHub bootstrap response"),
    "GitHub bootstrap response",
  );
  const content = record(response.content, "GitHub bootstrap content");
  if (text(content.sha, "GitHub bootstrap blob id") !== gitBlobOid(BOOTSTRAP_CONTENT)) {
    throw new Error("GitHub bootstrap blob did not hash back to the trusted marker");
  }
}

function isTrustedBootstrapTree(repository: string, treeOid: string): boolean {
  const result = gh("repos/" + repository + "/git/trees/" + treeOid + "?recursive=1");
  const response = record(
    json(success(result, "Read GitHub bootstrap tree"), "GitHub bootstrap tree"),
    "GitHub bootstrap tree",
  );
  if (response.truncated !== false || !Array.isArray(response.tree) || response.tree.length !== 1) {
    return false;
  }
  const entry = record(response.tree[0], "GitHub bootstrap tree entry");
  return (
    entry.path === BOOTSTRAP_PATH &&
    entry.mode === "100644" &&
    entry.type === "blob" &&
    entry.sha === gitBlobOid(BOOTSTRAP_CONTENT)
  );
}

function uploadSnapshot(
  repository: string,
  branch: string,
  parentCommitOid: string,
  snapshot: SourceSnapshot,
): string {
  const uploaded = new Set<string>();
  for (const entry of snapshot.entries) {
    if (uploaded.has(entry.oid)) continue;
    if (gitBlobOid(entry.content) !== entry.oid) {
      throw new Error("Validated local source blob changed before upload");
    }
    const blobResult = gh("repos/" + repository + "/git/blobs", {
      method: "POST",
      body: { content: entry.content.toString("base64"), encoding: "base64" },
    });
    const blob = record(json(success(blobResult, "Create GitHub source blob"), "GitHub source blob"), "GitHub source blob");
    if (text(blob.sha, "GitHub source blob id") !== entry.oid) {
      throw new Error("GitHub blob read-back did not match the local source blob");
    }
    uploaded.add(entry.oid);
  }
  if (sourceTreeOid(snapshot.entries) !== snapshot.treeOid) {
    throw new Error("Validated local source tree changed before upload");
  }
  const treeResult = gh("repos/" + repository + "/git/trees", {
    method: "POST",
    body: {
      tree: snapshot.entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: "blob",
        sha: entry.oid,
      })),
    },
  });
  const tree = record(json(success(treeResult, "Create GitHub source tree"), "GitHub source tree"), "GitHub source tree");
  if (text(tree.sha, "GitHub source tree id") !== snapshot.treeOid) {
    throw new Error("GitHub tree read-back did not match the exact local source tree");
  }
  const commitResult = gh("repos/" + repository + "/git/commits", {
    method: "POST",
    body: { message: COMMIT_MESSAGE, tree: snapshot.treeOid, parents: [parentCommitOid] },
  });
  const commit = record(json(success(commitResult, "Create GitHub source commit"), "GitHub source commit"), "GitHub source commit");
  const commitOid = text(commit.sha, "GitHub source commit id");
  assertOid(commitOid, "GitHub source commit id");
  const commitTree = text(record(commit.tree, "GitHub source commit tree").sha, "GitHub source commit tree id");
  if (commitTree !== snapshot.treeOid) throw new Error("GitHub commit did not retain the exact source tree");
  success(
    gh("repos/" + repository + "/git/refs/heads/" + encodeURIComponent(branch), {
      method: "PATCH",
      body: { sha: commitOid, force: false },
    }),
    "Advance GitHub default branch",
  );
  return commitOid;
}

async function verify(
  repository: string,
  visibility: Visibility,
  branch: string,
  commitOid: string,
  treeOid: string,
): Promise<{ repository: string; visibility: Visibility; branch: string; commitOid: string; treeOid: string; verified: true }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = readRepository(repository);
    if (state) {
      assertRepositoryState(state, visibility);
      if (state.defaultBranch !== null && state.defaultBranch !== branch) {
        throw new Error("GitHub default branch read-back differs from the published branch");
      }
      if (state.defaultBranch === branch) {
        const remote = readBranch(repository, branch);
        if (remote) {
          if (remote.commitOid !== commitOid) throw new Error("GitHub branch points to a different commit");
          if (remote.treeOid !== treeOid) throw new Error("GitHub commit points to a different source tree");
          return { repository, visibility, branch, commitOid, treeOid, verified: true };
        }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("GitHub exact source read-back remained unavailable");
}

interface ChildDirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

interface ChildFileIdentity {
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function fileIdentity(metadata: Stats): ChildFileIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedAtMs: metadata.mtimeMs,
    changedAtMs: metadata.ctimeMs,
  };
}

function sameFileIdentity(metadata: Stats, expected: ChildFileIdentity): boolean {
  return (
    metadata.dev === expected.device &&
    metadata.ino === expected.inode &&
    metadata.size === expected.size &&
    metadata.mtimeMs === expected.modifiedAtMs &&
    metadata.ctimeMs === expected.changedAtMs
  );
}

function sameNodeIdentity(metadata: Stats, expected: ChildFileIdentity): boolean {
  return metadata.dev === expected.device && metadata.ino === expected.inode;
}

function assertOwnerControlled(metadata: Stats, label: string): void {
  const uid = currentUid();
  if (uid !== null && metadata.uid !== uid) {
    throw new Error(label + " must be owned by the current user");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(label + " must not be writable by group or other users");
  }
}

function assertDirectoryMetadata(metadata: Stats, label: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(label + " must be a real non-symlink directory");
  }
  assertOwnerControlled(metadata, label);
}

function assertBoundaryMetadata(metadata: Stats, label: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(label + " must be a real non-symlink directory");
  }
  try {
    assertOwnerControlled(metadata, label);
  } catch (error) {
    const rootOwnedStickyDirectory =
      currentUid() !== null &&
      metadata.uid === 0 &&
      (metadata.mode & 0o1000) !== 0 &&
      (metadata.mode & 0o002) !== 0;
    if (!rootOwnedStickyDirectory) throw error;
  }
}

function assertRenameProtected(path: string, metadata: Stats, label: string): void {
  const parent = dirname(path);
  if (parent === path) return;
  const parentMetadata = lstatSync(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(label + " parent must be a real non-symlink directory");
  }
  const writableByAnotherPrincipal = (parentMetadata.mode & 0o022) !== 0;
  const stickyDirectory = (parentMetadata.mode & 0o1000) !== 0;
  const uid = currentUid();
  const stickyProtectsEntry = stickyDirectory && uid !== null && metadata.uid === uid;
  if (writableByAnotherPrincipal && !stickyProtectsEntry) {
    throw new Error(label + " parent permits another OS principal to rename the protected root");
  }
}

function directoryIdentity(path: string, metadata: Stats): ChildDirectoryIdentity {
  return { path, device: metadata.dev, inode: metadata.ino };
}

function sameDirectoryIdentity(metadata: Stats, expected: ChildDirectoryIdentity): boolean {
  return metadata.dev === expected.device && metadata.ino === expected.inode;
}

/**
 * A standalone cooperative filesystem boundary for installing child Git state.
 * Node has no descriptor-relative renameat2 API, so this combines an exclusive
 * owner-only lock with canonical containment and inode checks around every path
 * mutation. A process running as the same OS user can ignore the cooperative
 * lock; every mismatch therefore fails closed and leaves changed paths alone.
 */
class ChildGitPathLock {
  readonly root: ChildDirectoryIdentity;
  readonly lockPath: string;

  private readonly label = "Verified child Git installation";
  private readonly lockDescriptor: number;
  private lockIdentity: ChildFileIdentity | null = null;
  private released = false;

  constructor(rootDir: string, lockName: string) {
    const requested = resolve(rootDir);
    const canonical = realpathSync(requested);
    const rootMetadata = lstatSync(canonical);
    assertBoundaryMetadata(rootMetadata, this.label + " root");
    assertRenameProtected(canonical, rootMetadata, this.label + " root");
    this.root = directoryIdentity(canonical, rootMetadata);
    if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.lock$/u.test(lockName)) {
      throw new Error(this.label + " lock name is invalid");
    }
    this.lockPath = join(canonical, lockName);

    try {
      this.lockDescriptor = openSync(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(this.label + " is already locked; inspect " + this.lockPath + " before retrying");
      }
      throw error;
    }

    try {
      fchmodSync(this.lockDescriptor, 0o600);
      const metadata = fstatSync(this.lockDescriptor);
      this.lockIdentity = fileIdentity(metadata);
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(this.label + " lock is not one private regular file");
      }
      assertOwnerControlled(metadata, this.label + " lock");
      writeFileSync(
        this.lockDescriptor,
        JSON.stringify({ schemaVersion: 1, pid: process.pid, operation: this.label }) + "\n",
        "utf8",
      );
      fsyncSync(this.lockDescriptor);
      this.lockIdentity = fileIdentity(fstatSync(this.lockDescriptor));
      this.assertRoot();
      if (!sameFileIdentity(lstatSync(this.lockPath), this.lockIdentity)) {
        throw new Error(this.label + " lock path changed during acquisition");
      }
    } catch (error) {
      closeSync(this.lockDescriptor);
      try {
        const current = lstatSync(this.lockPath);
        if (this.lockIdentity && sameNodeIdentity(current, this.lockIdentity)) {
          unlinkSync(this.lockPath);
        }
      } catch {
        // Never unlink a changed lock path.
      }
      this.released = true;
      throw error;
    }
  }

  assertRoot(): void {
    if (this.released) throw new Error(this.label + " lock has already been released");
    const metadata = lstatSync(this.root.path);
    assertBoundaryMetadata(metadata, this.label + " root");
    if (!sameDirectoryIdentity(metadata, this.root) || realpathSync(this.root.path) !== this.root.path) {
      throw new Error(this.label + " root changed while the lock was held");
    }
  }

  private contained(path: string, label: string, allowRoot = false): string {
    const absolute = resolve(path);
    const child = relative(this.root.path, absolute);
    if (
      (!allowRoot && child === "") ||
      child === ".." ||
      child.startsWith(".." + sep) ||
      isAbsolute(child)
    ) {
      throw new Error(label + " escapes the locked child Git boundary");
    }
    return absolute;
  }

  captureDirectory(path: string, label: string): ChildDirectoryIdentity {
    const absolute = this.contained(path, label, true);
    this.assertRoot();
    if (absolute === this.root.path) return this.root;
    const child = relative(this.root.path, absolute);
    let cursor = this.root.path;
    let metadata: Stats | null = null;
    for (const part of child.split(sep)) {
      cursor = join(cursor, part);
      metadata = lstatSync(cursor);
      assertDirectoryMetadata(metadata, label + " path " + cursor);
      if (realpathSync(cursor) !== cursor) {
        throw new Error(label + " must not traverse a symbolic-link alias");
      }
    }
    this.assertRoot();
    if (!metadata) throw new Error(label + " directory metadata is unavailable");
    return directoryIdentity(absolute, metadata);
  }

  assertDirectory(path: string, expected: ChildDirectoryIdentity, label: string): void {
    const absolute = this.contained(path, label, true);
    if (absolute !== expected.path) throw new Error(label + " path changed unexpectedly");
    const current = this.captureDirectory(absolute, label);
    if (current.device !== expected.device || current.inode !== expected.inode) {
      throw new Error(label + " changed while the child Git lock was held");
    }
  }

  assertMissing(path: string, label: string): void {
    const absolute = this.contained(path, label);
    const parent = this.captureDirectory(dirname(absolute), label + " parent");
    if (pathEntryExists(absolute)) throw new Error(label + " already exists");
    this.assertDirectory(parent.path, parent, label + " parent");
  }

  renameDirectory(
    source: string,
    target: string,
    expectedSource: ChildDirectoryIdentity,
    label: string,
  ): ChildDirectoryIdentity {
    const absoluteSource = this.contained(source, label + " source");
    const absoluteTarget = this.contained(target, label + " target");
    this.assertDirectory(absoluteSource, expectedSource, label + " source");
    const sourceParent = this.captureDirectory(dirname(absoluteSource), label + " source parent");
    const targetParent = this.captureDirectory(dirname(absoluteTarget), label + " target parent");
    this.assertMissing(absoluteTarget, label + " target");
    this.assertDirectory(sourceParent.path, sourceParent, label + " source parent");
    this.assertDirectory(targetParent.path, targetParent, label + " target parent");
    renameSync(absoluteSource, absoluteTarget);
    this.assertDirectory(sourceParent.path, sourceParent, label + " source parent");
    this.assertDirectory(targetParent.path, targetParent, label + " target parent");
    const installed = this.captureDirectory(absoluteTarget, label + " target");
    if (
      installed.device !== expectedSource.device ||
      installed.inode !== expectedSource.inode ||
      pathEntryExists(absoluteSource)
    ) {
      throw new Error(label + " directory identity changed during rename");
    }
    return installed;
  }

  removeDirectory(path: string, expected: ChildDirectoryIdentity, label: string): void {
    const absolute = this.contained(path, label);
    this.assertDirectory(absolute, expected, label);
    const parent = this.captureDirectory(dirname(absolute), label + " parent");
    this.assertDirectory(parent.path, parent, label + " parent");
    rmSync(absolute, { recursive: true, force: false });
    this.assertDirectory(parent.path, parent, label + " parent");
    if (pathEntryExists(absolute)) throw new Error(label + " still exists after removal");
  }

  release(): void {
    if (this.released) return;
    let releaseError: unknown = null;
    try {
      this.assertRoot();
      const pathMetadata = lstatSync(this.lockPath);
      if (!this.lockIdentity || !sameFileIdentity(pathMetadata, this.lockIdentity)) {
        throw new Error(this.label + " lock path changed before release");
      }
      closeSync(this.lockDescriptor);
      if (!sameFileIdentity(lstatSync(this.lockPath), this.lockIdentity)) {
        throw new Error(this.label + " lock path changed during release");
      }
      unlinkSync(this.lockPath);
    } catch (error) {
      releaseError = error;
      try {
        closeSync(this.lockDescriptor);
      } catch {
        // The descriptor may already be closed.
      }
    } finally {
      this.released = true;
    }
    if (releaseError) throw releaseError;
  }
}

function githubOriginMatches(origin: string, repository: string): boolean {
  const normalized = origin.trim().replace(/\/+$/u, "").replace(/\.git$/iu, "");
  const expected = repository.toLowerCase();
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/iu)?.[1];
  const scp = normalized.match(/^git@github\.com:([^/]+\/[^/]+)$/iu)?.[1];
  const ssh = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/iu)?.[1];
  return [https, scp, ssh].some((candidate) => candidate?.toLowerCase() === expected);
}

function gitText(cwd: string, args: string[], label: string): string {
  return success(run("git", args, { cwd }), label).toString("utf8").trim();
}

function ensureWorkingRepository(
  repository: string,
  branch: string,
  commitOid: string,
): { originUrl: string; branch: string; head: string; clean: true } {
  assertRepository(repository);
  assertBranch(branch);
  assertOid(commitOid, "Verified GitHub commit id");
  const requestedRoot = resolve(process.cwd());
  const requestedRootMetadata = lstatSync(requestedRoot);
  if (requestedRootMetadata.isSymbolicLink() || !requestedRootMetadata.isDirectory()) {
    throw new Error("Child working repository root must be a real directory");
  }
  const root = realpathSync(requestedRoot);
  const boundary = new ChildGitPathLock(
    dirname(root),
    ".git-install-" + createHash("sha256").update(root).digest("hex").slice(0, 16) + ".lock",
  );
  const rootIdentity = boundary.captureDirectory(root, "Child working repository root");
  const gitPath = join(root, ".git");
  let installed = false;
  let installedGitIdentity: ChildDirectoryIdentity | null = null;

  const rootGitText = (args: string[], label: string): string => {
    boundary.assertDirectory(root, rootIdentity, "Child working repository root");
    if (installedGitIdentity) {
      boundary.assertDirectory(gitPath, installedGitIdentity, "Child .git metadata");
    }
    const output = gitText(root, args, label);
    boundary.assertDirectory(root, rootIdentity, "Child working repository root");
    if (installedGitIdentity) {
      boundary.assertDirectory(gitPath, installedGitIdentity, "Child .git metadata");
    }
    return output;
  };

  try {
    if (!pathEntryExists(gitPath)) {
      const parent = boundary.root.path;
      const temporaryRoot = mkdtempSync(join(parent, "." + basename(root) + "-git-"));
      const temporaryIdentity = boundary.captureDirectory(
        temporaryRoot,
        "Child Git staging directory",
      );
      const cloneDirectory = join(temporaryRoot, "clone");
      try {
        success(
          run(
            "gh",
            [
              "repo",
              "clone",
              repository,
              cloneDirectory,
              "--",
              "--no-checkout",
              "--single-branch",
              "--branch",
              branch,
            ],
            { cwd: parent },
          ),
          "Clone verified GitHub repository metadata",
        );
        boundary.assertDirectory(
          temporaryRoot,
          temporaryIdentity,
          "Child Git staging directory",
        );
        const cloneIdentity = boundary.captureDirectory(
          cloneDirectory,
          "Verified GitHub metadata clone",
        );
        const stagedGit = join(cloneDirectory, ".git");
        if (!pathEntryExists(stagedGit)) {
          throw new Error("Verified GitHub metadata clone did not produce a normal .git directory");
        }
        const cloneGitIdentity = boundary.captureDirectory(
          stagedGit,
          "Verified GitHub metadata clone .git",
        );
        const cloneGitText = (args: string[], label: string): string => {
          boundary.assertDirectory(
            cloneDirectory,
            cloneIdentity,
            "Verified GitHub metadata clone",
          );
          boundary.assertDirectory(
            stagedGit,
            cloneGitIdentity,
            "Verified GitHub metadata clone .git",
          );
          const output = gitText(cloneDirectory, args, label);
          boundary.assertDirectory(
            cloneDirectory,
            cloneIdentity,
            "Verified GitHub metadata clone",
          );
          boundary.assertDirectory(
            stagedGit,
            cloneGitIdentity,
            "Verified GitHub metadata clone .git",
          );
          return output;
        };
        if (cloneGitText(["rev-parse", "HEAD"], "Read cloned GitHub HEAD") !== commitOid) {
          throw new Error("Cloned GitHub HEAD differs from verified remote HEAD");
        }
        if (cloneGitText(["symbolic-ref", "--short", "HEAD"], "Read cloned GitHub branch") !== branch) {
          throw new Error("Cloned GitHub branch differs from the verified default branch");
        }
        if (!githubOriginMatches(cloneGitText(["remote", "get-url", "origin"], "Read cloned GitHub origin"), repository)) {
          throw new Error("Cloned GitHub origin differs from the verified repository");
        }
        boundary.assertMissing(
          gitPath,
          "Child Git state appeared during metadata staging; refusing overwrite",
        );
        boundary.assertDirectory(root, rootIdentity, "Child working repository root");
        installedGitIdentity = boundary.renameDirectory(
          stagedGit,
          gitPath,
          cloneGitIdentity,
          "Verified child Git metadata install",
        );
        installed = true;
        rootGitText(["read-tree", commitOid], "Bind child Git index to verified remote tree");
      } finally {
        if (pathEntryExists(temporaryRoot)) {
          boundary.removeDirectory(
            temporaryRoot,
            temporaryIdentity,
            "Child Git staging directory",
          );
        }
      }
    } else {
      const gitMetadata = lstatSync(gitPath);
      if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) {
        throw new Error("Existing child .git must be a normal directory; refusing to replace it");
      }
      installedGitIdentity = boundary.captureDirectory(gitPath, "Existing child .git");
    }

    if (realpathSync(rootGitText(["rev-parse", "--show-toplevel"], "Resolve child Git root")) !== root) {
      throw new Error("Child Git root differs from the venture root");
    }
    const originUrl = rootGitText(["remote", "get-url", "origin"], "Read child Git origin");
    if (!githubOriginMatches(originUrl, repository)) throw new Error("Child Git origin differs from the verified repository");
    const localBranch = rootGitText(["symbolic-ref", "--short", "HEAD"], "Read child Git branch");
    if (localBranch !== branch) throw new Error("Child Git branch differs from the verified default branch");
    const head = rootGitText(["rev-parse", "HEAD"], "Read child Git HEAD");
    if (head !== commitOid) throw new Error("Child Git HEAD differs from verified remote HEAD");
    const remoteHead = rootGitText(["rev-parse", "refs/remotes/origin/" + branch], "Read child remote-tracking HEAD");
    if (remoteHead !== commitOid) throw new Error("Child remote-tracking HEAD differs from verified remote HEAD");
    if (rootGitText(["status", "--porcelain=v1", "--untracked-files=all"], "Read child Git status")) {
      throw new Error("Child Git working tree is not clean after verified publication");
    }
    if (rootGitText(["ls-files", "--", ".venture", "reports"], "Check private runtime tracking")) {
      throw new Error("Child Git repository tracks private runtime state or launch reports");
    }
    return { originUrl, branch: localBranch, head, clean: true };
  } catch (error) {
    if (installed && installedGitIdentity) {
      try {
        boundary.assertDirectory(root, rootIdentity, "Child working repository root");
        boundary.removeDirectory(gitPath, installedGitIdentity, "Partially installed child .git");
      } catch {
        // Never chase a changed compensation path; leave it for inspection.
      }
    }
    throw error;
  } finally {
    boundary.release();
  }
}

function options(args: string[], required: string[]): Record<string, string> {
  if (args.length !== required.length * 2) throw new Error("Unexpected source publication arguments");
  const allowed = new Set(required);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!allowed.has(flag) || flag in parsed || !value || value.startsWith("--")) {
      throw new Error("Invalid source publication arguments");
    }
    parsed[flag] = value;
  }
  for (const flag of required) if (!(flag in parsed)) throw new Error("Missing required " + flag + " value");
  return parsed;
}

async function main(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (command !== "apply" && command !== "verify") {
    throw new Error("Expected apply or verify; no provider operation was attempted");
  }
  const required = command === "apply"
    ? ["--repository", "--visibility"]
    : ["--repository", "--visibility", "--branch", "--commit", "--tree"];
  const parsed = options(rest, required);
  const repository = parsed["--repository"]!;
  const visibility = parsed["--visibility"]!;
  assertRepository(repository);
  assertVisibility(visibility);

  if (command === "verify") {
    const branch = parsed["--branch"]!;
    const commitOid = parsed["--commit"]!;
    const treeOid = parsed["--tree"]!;
    assertBranch(branch);
    assertOid(commitOid, "Expected GitHub commit id");
    assertOid(treeOid, "Expected GitHub tree id");
    const verified = await verify(repository, visibility, branch, commitOid, treeOid);
    return { ...verified, workingRepository: ensureWorkingRepository(repository, branch, commitOid) };
  }

  const snapshot = loadSnapshot(process.cwd());
  let repositoryState = readRepository(repository);
  let created = false;
  if (!repositoryState) {
    createRepository(repository, visibility);
    created = true;
    repositoryState = readRepository(repository);
    if (!repositoryState) throw new Error("GitHub accepted creation but repository read-back is unavailable");
  }
  assertRepositoryState(repositoryState, visibility);
  let branch = repositoryState.defaultBranch;
  let remote = branch ? readBranch(repository, branch) : null;
  if (!remote) {
    bootstrapRepository(repository);
    repositoryState = readRepository(repository);
    if (!repositoryState) throw new Error("GitHub bootstrap repository read-back is unavailable");
    assertRepositoryState(repositoryState, visibility);
    branch = repositoryState.defaultBranch;
    if (!branch) throw new Error("GitHub bootstrap did not create a default branch");
    remote = readBranch(repository, branch);
    if (!remote) throw new Error("GitHub bootstrap branch read-back is unavailable");
  }
  if (!branch || !remote) throw new Error("GitHub default branch state is incomplete");
  const targetBranch = branch;
  const baseRemote = remote;
  assertBranch(targetBranch);
  if (baseRemote.treeOid === snapshot.treeOid) {
    const verified = await verify(
      repository,
      visibility,
      targetBranch,
      baseRemote.commitOid,
      snapshot.treeOid,
    );
    return { ...verified, created, source: "local_git_tree" as const };
  }
  if (!isTrustedBootstrapTree(repository, baseRemote.treeOid)) {
    throw new Error("GitHub repository already contains a different tree; refusing to overwrite it");
  }
  const commitOid = uploadSnapshot(
    repository,
    targetBranch,
    baseRemote.commitOid,
    snapshot,
  );
  const verified = await verify(
    repository,
    visibility,
    targetBranch,
    commitOid,
    snapshot.treeOid,
  );
  return { ...verified, created, source: "local_git_tree" as const };
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "GitHub source publication failed without a safe diagnostic") + "\n",
  );
  process.exitCode = 1;
}
`,
  ),
  file(
    "playwright.config.ts",
    "core_owned",
    `import { defineConfig, devices } from "@playwright/test";

const configuredBaseURL = process.env.PLAYWRIGHT_BASE_URL?.trim();
if (!configuredBaseURL) {
  throw new Error("PLAYWRIGHT_BASE_URL is required; use the generated local browser runner or pass one exact deployed origin");
}
const baseURL = configuredBaseURL;
const parsedBaseURL = new URL(baseURL);

if (!["http:", "https:"].includes(parsedBaseURL.protocol) || parsedBaseURL.username || parsedBaseURL.password) {
  throw new Error("PLAYWRIGHT_BASE_URL must be an HTTP(S) origin without embedded credentials");
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "line",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? ".venture/private/test-results",
  use: {
    baseURL: parsedBaseURL.origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
`,
  ),
  file(
    "scripts/run-local-browser-check.ts",
    "core_owned",
    String.raw`import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const ALLOWED_SPECS = new Set([
  "tests/e2e/post-deploy-readonly.spec.ts",
  "tests/e2e/primary-journey.spec.ts",
  "tests/e2e/primary-journey-cleanup.spec.ts",
]);
const READY_TIMEOUT_MS = 120_000;

async function reserveLoopbackPort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") {
    reservation.close();
    throw new Error("Could not reserve an ephemeral loopback port");
  }
  const port = address.port;
  reservation.close();
  await once(reservation, "close");
  return port;
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  const forced = setTimeout(() => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  }, 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(forced);
  }
}

async function runPlaywright(
  spec: string,
  environment: NodeJS.ProcessEnv,
): Promise<Error | null> {
  const playwright = spawn(
    "pnpm",
    ["exec", "playwright", "test", spec, "--retries=0"],
    { cwd: process.cwd(), env: environment, stdio: "inherit" },
  );
  const [code, signal] = (await once(playwright, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  return code === 0
    ? null
    : new Error("Playwright " + spec + " exited " + (code ?? signal ?? "without status"));
}

async function main(): Promise<void> {
  const [spec] = process.argv.slice(2);
  if (!spec || !ALLOWED_SPECS.has(spec)) {
    throw new Error("Expected one allowlisted repository-relative Playwright spec");
  }
  let port = await reserveLoopbackPort();
  let origin = "http://127.0.0.1:" + port;
  const expectedPublicOrigin =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://local-e2e.example.invalid";
  const serverNonce = randomBytes(24).toString("hex");
  const environment = {
    ...process.env,
    NEXT_PUBLIC_SITE_URL: expectedPublicOrigin,
    NEXT_PUBLIC_INDEXING_ENABLED: "true",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VH_LOCAL_SERVER_NONCE: serverNonce,
  };
  let output = "";
  let server: ChildProcess | null = null;
  const spawnServer = () => {
    output = "";
    const child = spawn(
      process.execPath,
      [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const append = (chunk: Buffer | string) => {
      output = (output + String(chunk)).slice(-20_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return child;
  };
  server = spawnServer();

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let addressRetries = 0;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) {
        if (/EADDRINUSE/u.test(output) && addressRetries < 2) {
          addressRetries += 1;
          port = await reserveLoopbackPort();
          origin = "http://127.0.0.1:" + port;
          server = spawnServer();
          continue;
        }
        throw new Error("Local production server exited before readiness:\n" + output);
      }
      try {
        const health = await fetch(origin + "/api/health", {
          signal: AbortSignal.timeout(1_000),
        });
        const body = health.ok ? await health.json() as { localServerNonce?: unknown } : null;
        if (body?.localServerNonce === serverNonce) break;
      } catch {
        // Continue within the bounded readiness window.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    const health = await fetch(origin + "/api/health", {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    const healthBody = health?.ok
      ? await health.json().catch(() => null) as { localServerNonce?: unknown } | null
      : null;
    if (
      server.exitCode !== null ||
      server.signalCode !== null ||
      healthBody?.localServerNonce !== serverNonce
    ) {
      throw new Error("Owned local production server was not ready:\n" + output);
    }

    const journeyContract = spec.includes("primary-journey")
      ? JSON.parse(readFileSync("tests/e2e/primary-journey.contract.json", "utf8")) as {
          production: { identity: { label: string } };
        }
      : null;
    const browserEnvironment = {
      ...environment,
      PLAYWRIGHT_BASE_URL: origin,
      EXPECTED_PUBLIC_ORIGIN: expectedPublicOrigin,
      VH_PRIMARY_JOURNEY_RUN_ID: "local-mvp-" + process.pid,
      VH_PRIMARY_JOURNEY_NONCE: randomBytes(24).toString("hex"),
      VH_PRIMARY_JOURNEY_TEST_IDENTITY:
        journeyContract?.production.identity.label ?? "local-mvp-test-identity",
    };
    const primaryError = await runPlaywright(spec, browserEnvironment);
    if (spec === "tests/e2e/primary-journey.spec.ts") {
      const journeyReadBackError = await runPlaywright(
        "tests/e2e/post-deploy-readonly.spec.ts",
        { ...browserEnvironment, VH_PRIMARY_JOURNEY_OBSERVER_PHASE: "journey_readback" },
      );
      if (journeyReadBackError) throw journeyReadBackError;
      const cleanupError = await runPlaywright(
        "tests/e2e/primary-journey-cleanup.spec.ts",
        browserEnvironment,
      );
      if (cleanupError) throw cleanupError;
      const cleanupReadBackError = await runPlaywright(
        "tests/e2e/post-deploy-readonly.spec.ts",
        { ...browserEnvironment, VH_PRIMARY_JOURNEY_OBSERVER_PHASE: "cleanup_readback" },
      );
      if (cleanupReadBackError) throw cleanupReadBackError;
    }
    if (primaryError) throw primaryError;
  } finally {
    if (server) await stopServer(server);
    const lingering = await fetch(origin + "/api/health", {
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    if (lingering) throw new Error("Owned local production listener remained after teardown");
  }
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
`,
  ),
  file(
    "tests/e2e/post-deploy-readonly.spec.ts",
    "core_owned",
    String.raw`import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("deployed public surface has raw HTML and a responsive accessibility baseline", async ({ page, request }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD") await route.continue();
    else await route.abort("blockedbyclient");
  });

  const observerPhase = process.env.VH_PRIMARY_JOURNEY_OBSERVER_PHASE;
  if (observerPhase) {
    const runId = process.env.VH_PRIMARY_JOURNEY_RUN_ID;
    const nonce = process.env.VH_PRIMARY_JOURNEY_NONCE;
    const identityLabel = process.env.VH_PRIMARY_JOURNEY_TEST_IDENTITY;
    if (!runId || !nonce || !identityLabel) throw new Error("Primary-journey observer bindings are required");
    const contract = JSON.parse(readFileSync("tests/e2e/primary-journey.contract.json", "utf8")) as {
      journeyId: string;
      steps: string[];
      production: {
        identity: { label: string };
        readBack: { method: "GET"; path: string; protocol: "venture_harness_primary_journey_v1" };
      };
    };
    expect(identityLabel).toBe(contract.production.identity.label);
    const response = await request.get(contract.production.readBack.path, {
      headers: {
        "x-venture-harness-run-id": runId,
        "x-venture-harness-nonce": nonce,
        "x-venture-harness-test-identity": identityLabel,
      },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(200);
    const observed = await response.json() as Record<string, unknown>;
    expect(observed).toMatchObject({
      protocol: contract.production.readBack.protocol,
      runId,
      nonce,
      journeyId: contract.journeyId,
      identityLabel,
      completedSteps: contract.steps,
      phase: observerPhase,
    });
    console.log("VH_PRIMARY_JOURNEY_OBSERVER_RESULT " + JSON.stringify({
      schemaVersion: 1,
      phase: observerPhase,
      runId,
      nonce,
      journeyId: contract.journeyId,
      identityLabel,
      completedSteps: contract.steps,
      project: testInfo.project.name,
      writes: observed.writes,
      removedWriteIds: observed.removedWriteIds,
      remainingWrites: observed.remainingWrites,
    }));
    return;
  }

  const smoke = await request.get("/", { failOnStatusCode: false });
  expect(smoke.status()).toBeGreaterThanOrEqual(200);
  expect(smoke.status()).toBeLessThan(400);
  const rawHtml = await smoke.text();
  expect(rawHtml).toMatch(/<main(?:\s|>)/iu);
  expect(rawHtml).toMatch(/<h1(?:\s|>)/iu);
  expect(rawHtml).toMatch(/<title>[^<]+<\/title>/iu);
  expect(rawHtml).toMatch(/<meta[^>]+name=["']description["'][^>]+content=["'][^"']+["']/iu);
  expect(rawHtml).toMatch(/<link[^>]+rel=["']canonical["'][^>]*>/iu);

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  expect(response!.status()).toBeLessThan(400);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
  expect((await page.locator("h1").innerText()).trim().length).toBeGreaterThan(0);
  expect((await page.title()).trim().length).toBeGreaterThan(0);
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description?.trim().length ?? 0).toBeGreaterThan(0);

  const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
  expect(canonical).not.toBeNull();
  const canonicalUrl = new URL(canonical!);
  const canonicalOrigin = canonicalUrl.origin;
  expect(canonicalOrigin).not.toMatch(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|$)/u);
  expect(canonicalUrl.protocol).toBe("https:");
  expect(canonicalUrl.pathname).toBe("/");
  expect(canonicalUrl.search).toBe("");
  expect(canonicalUrl.hash).toBe("");
  if (process.env.EXPECTED_PUBLIC_ORIGIN) {
    expect(canonicalOrigin).toBe(new URL(process.env.EXPECTED_PUBLIC_ORIGIN).origin);
  }
  const robotsContent =
    (await page.locator('meta[name="robots"]').getAttribute("content"))?.toLowerCase() ?? "";
  const indexingEnabled = /(?:^|,)\s*index(?:\s*,|$)/u.test(robotsContent) &&
    !/(?:^|,)\s*noindex(?:\s*,|$)/u.test(robotsContent);

  const robots = await request.get("/robots.txt", { failOnStatusCode: false });
  expect(robots.status()).toBe(200);
  const robotsText = await robots.text();
  expect(robotsText).toContain("Sitemap: " + canonicalOrigin + "/sitemap.xml");
  const sitemap = await request.get("/sitemap.xml", { failOnStatusCode: false });
  expect(sitemap.status()).toBe(200);
  const sitemapText = await sitemap.text();
  if (indexingEnabled) {
    expect(robotsText).toContain("Allow: /");
    expect(robotsText).not.toContain("Disallow: /");
    expect(sitemapText).toContain("<loc>" + canonicalOrigin + "/</loc>");
    expect(sitemapText).not.toMatch(/\/(?:api|auth|account|edit|draft|private|status|user)(?:\/|<)/u);
    expect(sitemapText).not.toMatch(/<loc>[^<]*\?[^<]*<\/loc>/u);
    expect(await page.locator('a[href^="/"]').count()).toBeGreaterThan(0);
  } else {
    expect(robotsContent).toContain("noindex");
    expect(robotsText).toContain("Disallow: /");
    expect(sitemapText).not.toContain("<loc>");
  }

  const bodyText = await page.locator("body").innerText();
  const structuredDataBlocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const visibleFactKeys = new Set(["name", "description", "price"]);
  const inspectStructuredData = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspectStructuredData);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "@type" && ["AggregateRating", "Review"].includes(String(child))) {
        throw new Error("Unverified rating/review structured data is forbidden");
      }
      if (visibleFactKeys.has(key) && typeof child === "string") expect(bodyText).toContain(child);
      inspectStructuredData(child);
    }
  };
  for (const block of structuredDataBlocks) inspectStructuredData(JSON.parse(block));

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  const unnamedInteractiveControls = await page
    .locator('a:visible, button:visible, input:visible, select:visible, textarea:visible')
    .evaluateAll((elements) =>
      elements.filter((element) => {
        const html = element as HTMLElement;
        const label =
          html.getAttribute("aria-label") ??
          html.getAttribute("aria-labelledby") ??
          html.getAttribute("title") ??
          html.textContent ??
          (element instanceof HTMLInputElement ? element.value || element.placeholder : "");
        return label.trim().length === 0;
      }).length,
    );
  expect(unnamedInteractiveControls).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.keyboard.press("Tab");
  const focusEvidence = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return false;
    const style = getComputedStyle(active);
    return style.outlineStyle !== "none" || style.boxShadow !== "none";
  });
  expect(focusEvidence).toBe(true);
  expect(runtimeErrors).toEqual([]);
  console.log(
    "VH_DEPLOYMENT_SURFACE_RESULT " +
      JSON.stringify({
        schemaVersion: 1,
        project: testInfo.project.name,
        rawServerHtml: true,
        accessibilityAxe: true,
        accessibleNamesAndLandmarks: true,
        keyboardFocus: true,
        responsiveOverflow: true,
        indexingEnabled,
        structuredDataBlocks: structuredDataBlocks.length,
      }),
  );
});
`,
  ),
  file(
    "next.config.mjs",
    "core_owned",
    `/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
`,
  ),
  file(
    "tsconfig.json",
    "core_owned",
    `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", ".next/types/**/*.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
`,
  ),
  file(
    "next-env.d.ts",
    "core_owned",
    `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Generated by the Venture Harness web seed. Next.js may maintain this file.
`,
  ),
  file(
    ".env.example",
    "merge_managed",
    "NEXT_PUBLIC_SITE_URL=http://localhost:3000\nNEXT_PUBLIC_INDEXING_ENABLED=false\n",
  ),
  file(
    "docs/product/PRODUCT_TRUTH.md",
    "venture_owned",
    `# {{ventureName}} product truth

This register describes only the generated seed state.

| Claim | Status | Evidence | Public boundary |
| --- | --- | --- | --- |
| The repository contains an independently buildable Next.js web scaffold. | local implementation | package.json, app/, next.config.mjs | Do not call it launched until production read-back and the primary journey pass. |
| Analytics starts disabled, with no universal provider or event assumptions. | local contract | config/analytics.yaml, src/analytics/events.ts | The product journey must justify each consented allowlisted event; no delivery is claimed. |
| Provider configuration is credential-reference-only. | local contract | config/providers.yaml, config/connectors.json | Every provider starts unconfigured. |

No customer, revenue, outcome, provider connection, deployment, or market evidence is claimed.
`,
  ),
  file("config/venture.yaml", "venture_owned", yaml(ventureConfig)),
  file("config/launch.yaml", "venture_owned", yaml(launchConfig)),
  file("config/mobile.yaml", "venture_owned", yaml(mobileConfig)),
  file("config/analytics.yaml", "venture_owned", yaml(analyticsConfig)),
  file("config/loops.yaml", "venture_owned", yaml(loopsConfig)),
  file("config/providers.yaml", "venture_owned", yaml(providersConfig)),
  file("config/policies.yaml", "venture_owned", yaml(policiesConfig)),
  file("config/offer.yaml", "venture_owned", yaml(offerConfig)),
  file(
    "tests/seed-contract.test.mjs",
    "core_owned",
    `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync("venture.manifest.json", "utf8"));
const connectors = readFileSync("config/connectors.json", "utf8");
const providers = readFileSync("config/providers.yaml", "utf8");
const seo = readFileSync("config/seo.yaml", "utf8");
const site = readFileSync("src/config/site.ts", "utf8");
const layout = readFileSync("app/layout.tsx", "utf8");
const sitemap = readFileSync("app/sitemap.ts", "utf8");
const statusPage = readFileSync("app/status/page.tsx", "utf8");

test("ordinary web seed stays an ordinary app", () => {
  assert.equal(manifest.rail, "web");
  assert.equal("serviceBlueprints" in manifest, false);
  assert.equal("agentSurface" in manifest, false);
});

test("tracked connector metadata is credential-free", () => {
  assert.equal(connectors.includes("externalAccountId"), false);
  assert.equal(connectors.includes("credential"), false);
  const credentialReferenceLines = providers
    .split(/\\r?\\n/u)
    .filter((line) => /(?:^|_)credential_ref:/u.test(line));
  for (const line of credentialReferenceLines) {
    const value = line.slice(line.indexOf(":") + 1).trim().replace(/^['"]|['"]$/gu, "");
    assert.equal(value === "null" || /^cred:\\/\\/[a-z0-9][a-z0-9._/-]*$/iu.test(value), true);
  }
  assert.equal(
    /(?:sk_(?:live|test)_[A-Za-z0-9]{12,}|whsec_[A-Za-z0-9]{12,}|xkeysib-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|Bearer\\s+[A-Za-z0-9._~-]{12,})/u.test(
      providers,
    ),
    false,
  );
});

test("discovery stays explicit, owner-based, and noindex by default", () => {
  assert.match(seo, /default: disabled/u);
  assert.match(seo, /query_evidence: missing/u);
  assert.match(site, /NEXT_PUBLIC_INDEXING_ENABLED === "true"/u);
  assert.doesNotMatch(layout, /alternates:\\s*\\{\\s*canonical/u);
  assert.match(sitemap, /if \\(!INDEXING_ENABLED\\) return \\[\\]/u);
  assert.doesNotMatch(sitemap, /\\/status/u);
  assert.match(statusPage, /robots:\\s*\\{ index: false, follow: false \\}/u);
});
`,
  ),
];

const recursiveRuntimePackages = Object.freeze({
  "@venture-harness/core": CORE_VERSION,
  "@venture-harness/agent-runtime": CORE_VERSION,
  "@venture-harness/command-bus": CORE_VERSION,
  "@venture-harness/credentials": CORE_VERSION,
  "@venture-harness/connections": CORE_VERSION,
  "@venture-harness/entitlements": CORE_VERSION,
  "@venture-harness/audit": CORE_VERSION,
  "@venture-harness/events": CORE_VERSION,
  "@venture-harness/telemetry": CORE_VERSION,
  "@venture-harness/organizations": CORE_VERSION,
  "@venture-harness/agent-gateway": CORE_VERSION,
  "@venture-harness/api-generator": CORE_VERSION,
  "@venture-harness/cli-generator": CORE_VERSION,
  "@venture-harness/mcp-generator": CORE_VERSION,
  "@venture-harness/sdk-generator": CORE_VERSION,
  "@venture-harness/ui": CORE_VERSION,
});

const recursiveGeneratorVersions = Object.freeze({
  api: CORE_VERSION,
  cli: CORE_VERSION,
  mcp: CORE_VERSION,
  sdk: CORE_VERSION,
  ui: CORE_VERSION,
});

interface DefinitionOptions {
  serviceRuntime: SeedDefinition["serviceRuntime"];
  runtimePackages: Readonly<Record<string, string>>;
  developmentPackages?: Readonly<Record<string, string>>;
  packageScripts?: Readonly<Record<string, string>>;
  generatorVersions?: Readonly<Record<string, string>>;
  files?: readonly SeedFileTemplate[];
}

function definition(
  id: SeedId,
  rail: SeedDefinition["rail"],
  options: DefinitionOptions,
): SeedDefinition {
  return Object.freeze({
    id,
    version: CORE_VERSION,
    rail,
    serviceRuntime: options.serviceRuntime,
    coreCompatibility: "^0.2.0",
    runtimePackages: Object.freeze({ ...options.runtimePackages }),
    developmentPackages: Object.freeze({ ...(options.developmentPackages ?? {}) }),
    packageScripts: Object.freeze({
      ...(options.packageScripts ?? { verify: "pnpm typecheck && pnpm test" }),
    }),
    generatorVersions: Object.freeze({
      ...(options.generatorVersions ?? recursiveGeneratorVersions),
    }),
    files: Object.freeze([...repositoryFiles, ...(options.files ?? [])]),
  });
}

export const VENTURE_SEEDS: Readonly<Record<SeedId, SeedDefinition>> = Object.freeze({
  "agentic-web-saas": definition("agentic-web-saas", "web", {
    serviceRuntime: "none",
    runtimePackages: {
      next: "15.5.21",
      react: "19.2.7",
      "react-dom": "19.2.7",
    },
    developmentPackages: {
      "@axe-core/playwright": "4.12.1",
      "@playwright/test": "1.62.1",
      "@types/node": "22.20.1",
      "@types/react": "19.2.17",
      "@types/react-dom": "19.2.3",
      tsx: "4.23.1",
      typescript: "5.9.3",
    },
    packageScripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
      test: "node --test tests/*.test.mjs",
      "test:e2e:readonly":
        "tsx scripts/run-local-browser-check.ts tests/e2e/post-deploy-readonly.spec.ts",
      "test:e2e:primary-journey":
        "tsx scripts/run-local-browser-check.ts tests/e2e/primary-journey.spec.ts",
      verify: "pnpm typecheck && pnpm test && pnpm build",
      "verify:fast": "pnpm typecheck && pnpm test",
      "verify:mvp":
        "pnpm verify:fast && pnpm build && pnpm test:e2e:readonly && pnpm test:e2e:primary-journey",
    },
    generatorVersions: { ui: CORE_VERSION },
    files: ordinaryWebFiles,
  }),
  "agentic-ios-subscription": definition("agentic-ios-subscription", "ios", {
    serviceRuntime: "recursive",
    runtimePackages: {
      ...recursiveRuntimePackages,
      "@venture-harness/billing": CORE_VERSION,
      "@venture-harness/provider-sdk": CORE_VERSION,
    },
    files: recursiveServiceFiles,
  }),
  "hybrid-agentic-service": definition("hybrid-agentic-service", "hybrid", {
    serviceRuntime: "recursive",
    runtimePackages: {
      ...recursiveRuntimePackages,
      "@venture-harness/billing": CORE_VERSION,
      "@venture-harness/loops": CORE_VERSION,
      "@venture-harness/provider-sdk": CORE_VERSION,
    },
    files: recursiveServiceFiles,
  }),
});

export function ventureSeed(id: SeedId, version: string): SeedDefinition {
  const seed = VENTURE_SEEDS[id];
  if (seed.version !== version) {
    throw new Error(`Unsupported seed version ${id}@${version}`);
  }
  return seed;
}
