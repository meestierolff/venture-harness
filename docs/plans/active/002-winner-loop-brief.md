# Ja — dit is de definitieve Core-prompt

Winner Loop hoort als een **installeerbare capabilitypack binnen de Venture Harness Distribution Engine**, niet als een vierde los bedrijf. De keten uit je document is precies de juiste gesloten loop: `creative hypothesis → video → organic post → early signals → paid test → subscription → renewal → retained revenue`. De permanente `creative_id` moet vanaf de hypothese door render, organische post, Spark Ad, attribution en RevenueCat-cohort heen blijven bestaan.

Ook de financiële grens is juist: organische productie en meting kunnen policy-bound autonoom verlopen, maar de eerste betaalde euro vereist een afzonderlijke menselijke goedkeuring. Automatisch pauzeren bij slechte tracking of een harde limiet mag wel; automatische budgetverhogingen en VBO horen niet in V1.

De actuele openbare repo is nog steeds v0.1: één Next.js-validatietemplate met `pnpm init:venture`, handmatige deployment, een graphskill zonder duurzame executor en een distributioncontract dat automatische posting categorisch verbiedt. De wekelijkse workflow verwerkt alleen al aanwezige lokale data en uploadt een rapportartifact. Dat betekent dat Sol een echte architectuurmigratie moet uitvoeren en niet alleen Winner Loop-bestanden aan de bestaande template moet toevoegen.

De providerarchitectuur moet capabilities detecteren in plaats van functies te veronderstellen. TikTok ondersteunt officiële direct-post- en draftflows; Spark Ads gebruiken eigen of geautoriseerde organische posts. TikTok biedt VBO-strategieën, maar de readiness en huidige providervereisten moeten bij uitvoering opnieuw uit officiële documentatie en accountstate worden vastgesteld. ([TikTok voor Ontwikkelaars][1]) RevenueCat kan subscription lifecycle- en revenue-events server-side leveren, inclusief renewals, maar bepaalt zelf niet welke campagne een installatie veroorzaakte; daarvoor blijft een attributionprovider, Apple-attributie of expliciet aangeleverde attributioncontext nodig. ([RevenueCat][2]) Apple-attributie blijft privacybeperkt en levert onder voorwaarden geaggregeerde postbacks, waardoor Winner Loop deterministische, provider-attributed, privacy-aggregated en modeled resultaten uit elkaar moet houden. ([Apple Developer][3])

Zernio, Postiz, HeyGen en Higgsfield hebben inmiddels agentgerichte CLI-, MCP- of API-oppervlakken, maar Venture Harness moet ze alsnog achter eigen providercontracten zetten en nooit één jonge leverancier als onvervangbare kern gebruiken. ([Zernio API Documentation][4])

Gebruik de onderstaande prompt **in plaats van alle eerdere afzonderlijke prompts**. Hij bevat het geïntegreerde eindontwerp.

---

## Ultieme Sol 5.6 Ultra-prompt

```text
/goal

Transform the existing public repository `meestierolff/venture-harness`
from its current v0.1 demand-validation template into Venture Harness
v0.2.0-alpha.1: a modular, open-source, provider-neutral and agent-native
factory for creating, launching, operating and centrally upgrading independent
software and delegated-automation businesses.

Venture Harness must enable this complete recursive model:

1. Venture Harness Core turns one founder idea and one Launch Grant into a new,
   independently owned Venture Repository.
2. The new repository receives a pinned, versioned Venture Seed and Venture
   Runtime.
3. Venture Harness creates the company-owned infrastructure in the accounts
   selected by the founder: source control, hosting, database, payments, email,
   analytics, search, domains and other assets.
4. The launched company has its own brand, design, business model,
   subscriptions, customer organizations, Connection Hub, ServiceBlueprints,
   API, CLI, MCP server and SDK.
5. Paying customers of that launched company can authorize their own external
   stacks to the company.
6. The launched company orchestrates those customer-owned providers into a
   business-specific end-to-end outcome.
7. The customer can operate that outcome through the company’s UI or through
   the customer’s own AI agent using the company-specific API, CLI, MCP or SDK.
8. Changes to Venture Harness Core are released through versioned packages,
   managed files, migrations and release manifests, then automatically tested,
   rolled out and verified across independent venture repositories without
   overwriting their unique application, design or business logic.
9. Winner Loop becomes an installable Distribution Engine capability pack:
   creative hypothesis → generated video → organic TikTok test → normalized
   metrics → winner recommendation → manually approved Spark Ad test →
   attribution and RevenueCat cohort outcome.
10. DistributionPR consumes Winner Loop and other market learnings and turns
    them into evidence-backed product, website, onboarding, paywall, tracking,
    ASO and content pull requests.

The final framework should embody:

> Independent ventures, centrally evolved.

And:

> Connect your assets once. Give the orchestrator an outcome. Venture Harness
> builds, launches and improves the system around it.

Do not stop at an audit, plan, architecture document, directory migration,
empty interfaces, mock dashboard, TODO-heavy provider shells, generated types
without runtime behavior or an unexecuted dry run.

Implement the smallest coherent but genuinely functional vertical system,
migrate useful v0.1 behavior, add deterministic fixtures, run all applicable
checks, fix failures, commit coherent slices and open a draft pull request
when GitHub authentication permits.

==================================================
0. OPERATING DIRECTIVE
==================================================

Work directly in the existing repository.

Create a dedicated implementation branch, for example:

`sol/vh-core-v0.2-winner-loop`

Do not modify generated `.agents/**` or `.claude/skills/**` files manually.
Modify canonical skills and regenerate them.

Do not ask the founder to repeat information contained in this prompt or the
repository.

Do not pause for preference questions that can be resolved through a safe,
reversible and documented default.

Use current official provider documentation before implementing any external
integration.

Do not invent APIs, scopes, OAuth support, metrics, provider identifiers or
account capabilities.

When credentials are unavailable:

- implement the adapter contract;
- implement auth discovery;
- implement dry-run behavior;
- implement fixtures;
- implement contract tests;
- implement redaction;
- report live verification as pending;
- never describe mocked state as live provider state.

Do not create paid campaigns or incur advertising spend while developing the
framework.

Do not publish packages, create public releases or alter production provider
accounts unless the active authorization explicitly permits those effects.

Repository work, commits and a draft pull request are in scope.

==================================================
1. INSPECT AND BASELINE THE CURRENT REPOSITORY
==================================================

Before editing, inspect at minimum:

- Git history and current HEAD;
- README.md;
- AGENTS.md;
- ARCHITECTURE.md;
- PROJECT.md;
- SECURITY.md;
- CONTRIBUTING.md;
- NOTICE.md;
- SOURCES.md;
- package.json;
- pnpm-lock.yaml;
- tsconfig and Next.js configuration;
- config/**;
- lib/**;
- app/**;
- components/**;
- scripts/**;
- tests/**;
- evals/**;
- skills/**;
- .agents/**;
- .claude/**;
- .github/**;
- docs/**;
- memory/**;
- data/**;
- examples/**;
- inputs/**.

Confirm the current behavior rather than trusting prose.

Record the baseline in an active migration plan and ADRs.

Known current-state findings that must be verified and addressed:

- v0.1 is primarily one Next.js validation-site template;
- `pnpm init:venture` changes local names and documents but does not launch a
  company;
- every venture is assumed to start with a 30–90-day validation website;
- a pricing experiment is effectively mandatory;
- infrastructure is represented by booleans;
- deployment is documented rather than executed;
- automatic publishing and sending are schema-level forbidden;
- workflow graphs are plans rather than a durable runtime;
- weekly analysis relies on pre-existing local exports;
- database schemas exist primarily in documentation rather than real
  migrations;
- child ventures are detached copies requiring manual cherry-picking;
- no shared fleet upgrade controller exists;
- no unique venture API/CLI/MCP/SDK generator exists;
- no recursive customer Connection Hub exists;
- no Winner Loop exists;
- the SEO/AEO skill has grown much larger than its executable data layer.

Preserve useful v0.1 behavior unless deliberately migrated or deprecated:

- agent-neutral canonical instructions;
- deterministic skill synchronization;
- YAML plus Zod contracts;
- product-truth register;
- claim verification;
- analytics PII restrictions;
- exact displayed-price recording;
- first-party commercial evidence;
- consent-first analytics defaults;
- deterministic experiment assignment primitives;
- raw-HTML crawler checks;
- SEO foundations;
- anti-template design process;
- cumulative correction promotion;
- synthetic fixtures;
- public release hygiene.

==================================================
2. CANONICAL PRODUCT MODEL AND TERMINOLOGY
==================================================

Use these terms consistently in code, schemas and documentation.

Venture Harness Core:
The public open-source factory, execution kernel, provider SDK, graph runtime,
generators, migration system, package set and upgrade engine.

Venture Fleet Controller:
The deployable controller that tracks independent venture repositories and
rolls Core releases through them. Its code may be open source, but real fleet
registry data, repository mappings, deployments and credentials are private.

Venture Seed:
A versioned, reproducible starting codebase for a category of company.

Launch Grant:
The founder’s single authorization to create a Venture Repository and all
allowed company-owned resources.

Venture Repository:
The independent repository and codebase belonging to one launched company.

Venture Runtime:
The versioned shared runtime inherited by each venture: auth, organizations,
billing, connections, credential brokerage, orchestration, agent gateway,
assets, audit, metering and loops.

Stack Profile:
The mapping from abstract company-infrastructure capabilities to concrete
provider connections, external accounts, teams and organizations.

ServiceBlueprint:
A venture-specific, versioned description of one customer outcome, its graph,
required capabilities, inputs, outputs, policies, evaluations, usage units and
loops.

Connector Manifest:
The venture-specific definition of which customer providers are required,
alternative, recommended or optional for each ServiceBlueprint.

Agent Surface:
The venture-specific API, CLI, MCP server, SDK and UI actions generated from
typed Command Contracts.

Customer Service Grant:
The paying customer’s authorization for the launched venture to execute
specific ServiceBlueprints using selected customer connections.

Provider Connection:
A tenant- and venture-scoped delegated provider authorization.

Spend Grant:
A separate, explicit authorization for advertising or other external spend.
A Launch Grant or Customer Service Grant does not imply a Spend Grant.

Winner Loop:
An installable Distribution Engine pack that discovers promising creatives
organically, proposes bounded paid tests and connects creative lineage to
subscriber cohort quality.

DistributionPR:
A pack that converts evidence into repository changes and measurable product
improvements.

==================================================
3. FUNDAMENTAL OWNERSHIP MODEL
==================================================

Venture Harness is an operator, not the owner of venture or customer assets.

Company-owned resources must be created under the selected founder or company
accounts:

- repository under the selected GitHub/GitLab owner;
- deployment under the selected hosting team;
- database under the selected database organization;
- analytics under the selected analytics account;
- search properties under the selected owner;
- payment products under that company’s commerce account;
- RevenueCat project under that company’s developer account;
- email resources under that company’s email account;
- domains under the founder or company;
- TikTok and Meta assets under that venture’s business accounts;
- creative assets under the selected customer or venture providers.

When delegated access is revoked:

- Venture Harness loses access;
- the external resources remain owned by the founder, venture or customer;
- no cascade deletion occurs;
- only affected scheduled work is paused;
- reauthorization resumes only affected graph nodes.

Support these ownership modes:

- `customer_owned`;
- `venture_owned`;
- `customer_owned_dedicated_account`;
- `platform_managed_customer_subaccount`;
- `platform_owned_demo`;
- `transfer_pending`.

Default production company resources to `venture_owned`.

Default production end-customer provider resources to `customer_owned`.

Use `platform_owned_demo` only for synthetic fixtures, demos and disposable
sandboxes.

Managed subaccounts require explicit disclosure and an offboarding/transfer
policy.

==================================================
4. FOUR IDENTITY LAYERS
==================================================

Model these actors independently:

1. Venture Harness operator;
2. launched venture;
3. paying customer organization and user;
4. customer-connected AI agent.

Every command and effect must retain:

- operator identity;
- venture identity;
- customer organization where applicable;
- customer user where applicable;
- invoking agent identity where applicable;
- active subscription;
- entitlement;
- Service Grant;
- Authorization Envelope;
- Provider Connection;
- run;
- graph node;
- correlation and causation IDs.

Never collapse these identities into one shared “user”.

==================================================
5. THREE STACK CLASSES
==================================================

Model separately:

A. CompanyStack

Owned by the launched venture and required to operate the company.

Examples:

- repository;
- hosting;
- database;
- company commerce;
- company analytics;
- search;
- email;
- domains;
- app-store account;
- public agent surfaces.

B. CustomerStack

Owned by the paying end customer and used by the launched venture to deliver a
service.

Examples:

- social accounts;
- ad accounts;
- creative providers;
- repositories;
- hosting;
- analytics;
- payments;
- affiliate providers;
- attribution providers;
- email and CRM.

C. AgentAccessStack

The customer’s external AI agents and machine credentials for operating the
venture outcome.

Examples:

- ChatGPT;
- Claude;
- Codex;
- Cursor;
- OpenClaw;
- a custom API client;
- a service account.

A credential from one stack class must never be substituted into another.

==================================================
6. TARGET MONOREPO ARCHITECTURE
==================================================

Migrate to a pnpm workspace.

Use this target as a strong default and document any justified deviation:

venture-harness/
  apps/
    control-plane/
    api/
    worker/
    docs/
    fleet-controller/
  packages/
    core/
    config/
    cli/
    command-bus/
    events/
    audit/
    assets/
    credentials/
    policy/
    organizations/
    billing/
    entitlements/
    connections/
    orchestrator/
    workflow-backend-local/
    provider-sdk/
    provider-registry/
    agent-runtime/
    agent-gateway/
    api-generator/
    cli-generator/
    mcp-generator/
    sdk-generator/
    pack-runtime/
    seed-runtime/
    upgrades/
    migrations/
    loops/
    evaluations/
    telemetry/
    ui/
  providers/
    github/
    gitlab/
    vercel/
    cloudflare/
    neon/
    supabase/
    stripe/
    revenuecat/
    brevo/
    resend/
    google/
    bing/
    dns/
    apple/
    postiz/
    zernio/
    tiktok-content/
    tiktok-ads/
    meta-ads/
    heygen/
    higgsfield/
    appsflyer/
    adjust/
    singular/
    branch/
  packs/
    validate-first/
    ship-to-users/
    distribution-pr/
    winner-loop/
    web-saas/
    ios-subscription/
  seeds/
    agentic-web-saas/
    agentic-ios-subscription/
    hybrid-agentic-service/
  schemas/
  migrations/
    core/
  examples/
  tests/

Do not create microservices only to match directory names.

The first self-hosted runtime may use:

- one control-plane/API process;
- one worker process;
- SQLite for local runtime state;
- Postgres/Neon for hosted runtime state.

Keep interfaces independent enough to support future hosted scaling.

==================================================
7. VENTURE MATERIALIZATION AND LAUNCH GRANT
==================================================

A new remote repository or external resource may only be created after the
Launch Grant because creation is itself an external effect.

Canonical lifecycle:

IdeaDraft
  -> deterministic preflight
  -> LaunchGrant
  -> isolated local venture workspace
  -> remote Venture Repository creation
  -> Venture Seed materialization
  -> harness.lock creation
  -> Venture Manifest compilation
  -> ServiceBlueprint compilation
  -> unique application and design
  -> Connector Manifest generation
  -> unique Agent Surface generation
  -> CompanyStack provisioning
  -> source push
  -> preview verification
  -> production deployment
  -> end-to-end verification
  -> operating loops.

Implement a typed LaunchGrant containing:

- owner organization;
- venture name and slug;
- selected seed;
- selected Stack Profile;
- repository destination and visibility;
- provider account destinations;
- autonomy profile;
- allowed external effects;
- model budget;
- external resource budget;
- production deployment permission;
- domain permission;
- live commerce configuration permission;
- expiry;
- granting actor;
- revocation state.

One explicit production launch request may create and apply this grant.

Do not ask for repeated approval for reversible effects inside the grant.

Do not treat advertising spend as implicitly included.

Commands:

- `vh idea compile`;
- `vh grant create`;
- `vh grant inspect`;
- `vh venture plan`;
- `vh venture launch`;
- `vh venture status`;
- `vh venture resume`;
- `vh venture verify`.

Example intended semantics:

`vh venture launch
   --idea ./ideas/payout-rank.md
   --owner-org launch-company
   --stack founder-default
   --seed hybrid-agentic-service
   --repository payout-rank
   --autonomy owner-live-launch
   --environment production
   --apply
   --non-interactive`

==================================================
8. VERSIONED VENTURE SEEDS
==================================================

A Venture Seed is a reproducible starting point, not a permanent detached copy.

Each seed includes:

- application shell;
- Venture Runtime integration;
- authentication;
- users, organizations and memberships;
- subscriptions and entitlements;
- customer Connection Hub;
- command bus;
- ServiceBlueprint runtime;
- agent gateway;
- API/CLI/MCP/SDK generators;
- audit and usage infrastructure;
- migrations;
- quality profiles;
- private/public data boundaries;
- managed-file manifest.

Every materialized venture receives:

- `harness.lock`;
- Core version;
- seed ID and version;
- runtime package versions;
- provider package versions;
- generator versions;
- migration state;
- managed-file checksums;
- venture-owned file boundaries;
- update channel;
- last verified upgrade.

Use three ownership classes for repository files.

Core-owned:
May be replaced or regenerated.

Merge-managed:
Use three-way merging against the previous Core baseline.

Venture-owned:
Never overwrite automatically.

Venture-owned examples:

- unique product application;
- business design;
- ServiceBlueprints;
- Command Contracts;
- venture policies;
- venture migrations;
- venture tests;
- brand assets;
- customer journeys;
- pricing and business model.

==================================================
9. PROVIDER-NEUTRAL CAPABILITIES
==================================================

The kernel must reference capabilities rather than provider names.

Examples:

- `source.repository.create`;
- `source.repository.write`;
- `hosting.web.deploy`;
- `database.postgres.provision`;
- `database.migrations.apply`;
- `commerce.web_subscription`;
- `commerce.native_subscription`;
- `email.transactional`;
- `analytics.web.read`;
- `search.google.read`;
- `search.bing.read`;
- `distribution.content.publish`;
- `distribution.content.metrics.read`;
- `ads.organic_post.boost`;
- `ads.campaign.create`;
- `ads.insights.read`;
- `creative.video.generate`;
- `creative.image.generate`;
- `attribution.campaign.read`;
- `subscription.lifecycle.read`.

A Provider Adapter declares which capabilities and operation versions it
supports.

A Stack Profile binds CompanyStack capabilities to concrete providers.

A Connector Manifest binds customer-facing service capabilities to provider
alternatives.

Provider selection must record:

- selected provider;
- selected external account;
- capability;
- feature availability;
- rationale;
- fallback;
- current verification date;
- provider limitations.

==================================================
10. FOUNDER DEFAULT STACK AND ALTERNATIVES
==================================================

Ship a default Stack Profile optimized for the current founder:

- GitHub for source control;
- Vercel for web hosting;
- Neon Postgres for database;
- Stripe for web SaaS, B2B and service commerce;
- RevenueCat for native digital subscriptions and purchases;
- Brevo for transactional and lifecycle email;
- Google Analytics for web analytics;
- Google Search Console for Google search;
- Bing Webmaster for Bing search;
- MijnDomein as registrar with manual or delegated DNS;
- Postiz or Zernio as optional distribution providers;
- HeyGen or Higgsfield as optional creative providers.

These are defaults, not kernel dependencies.

Allow alternative adapters such as:

- GitLab;
- Cloudflare;
- Supabase;
- Paddle;
- Resend;
- PostHog;
- other compatible providers.

Do not describe an alternative as supported until its adapter and contract
tests exist.

Payment routing default:

- native digital subscription -> RevenueCat;
- web SaaS -> Stripe;
- B2B/service commerce -> Stripe;
- no monetization -> none;
- hybrid -> only with one documented entitlement source of truth.

==================================================
11. CUSTOMER-OWNED AUTHORIZATION AND CONNECTION HUB
==================================================

Implement these domain objects:

- User;
- Organization;
- OrganizationMembership;
- ServiceSubscription;
- ProviderConnection;
- StackProfile;
- Venture;
- ExternalResource;
- Asset;
- ServiceGrant;
- AuthorizationEnvelope;
- AgentGrant;
- SpendGrant;
- Run;
- Event.

ProviderConnection lifecycle:

- unconfigured;
- authorization_created;
- waiting_for_user;
- exchanging;
- selecting_account;
- connected;
- verified;
- degraded;
- reconnect_required;
- revoked;
- failed.

Supported auth methods:

- OAuth authorization code;
- OAuth device flow;
- app installation;
- official CLI session;
- API key vault;
- service account;
- JWT/private key;
- invited service user;
- managed subaccount;
- manual DNS.

The Connection Hub must be generated from the venture’s Connector Manifest and
show:

- required connections;
- one-of alternatives;
- recommended connections;
- optional connections;
- external account and owner;
- scopes;
- health;
- last verification;
- services using the connection;
- reconnect;
- revoke;
- ownership statement.

Do not expose raw credentials.

==================================================
12. LOCAL OWNER MODE AND HOSTED MULTI-TENANT MODE
==================================================

Local owner mode may reuse a verified official CLI session.

Hosted SaaS mode must never use one global provider CLI login for all tenants.

Every hosted provider operation requires:

- organization ID;
- venture ID;
- provider connection ID;
- external account ID;
- authorization envelope;
- idempotency key.

The worker resolves the secret immediately before one operation, never sends it
to the model and discards the plaintext after use.

Implement tenant isolation tests proving that one organization or venture
cannot:

- enumerate another’s connections;
- resolve another’s credentials;
- inspect another’s assets;
- execute using another connection;
- read another’s runs;
- receive another’s webhook;
- access another’s agent token.

==================================================
13. CREDENTIAL BROKER
==================================================

Support:

- OAuth access and refresh tokens;
- API keys;
- restricted keys;
- JWT/private keys;
- service accounts;
- official CLI sessions;
- CI credentials.

Backends:

- system keychain;
- environment/CI;
- encrypted hosted vault;
- in-memory test backend;
- optional 1Password-compatible backend.

Rules:

- no secret values in Git;
- no secret values in event logs;
- no secret values in model context;
- no secret values in reports;
- config contains credential references only;
- refresh remains tenant- and venture-scoped;
- credentials can be tested, rotated and revoked;
- missing scopes produce exact remediation.

Commands:

- `vh auth login`;
- `vh auth status`;
- `vh auth test`;
- `vh auth revoke`;
- `vh stack connect`;
- `vh stack doctor`.

==================================================
14. ONE COMMAND BUS AND UNIQUE AGENT SURFACES
==================================================

Define every business operation once as a typed Command Contract.

A Command Contract includes:

- command ID;
- description;
- input schema;
- output schema;
- required entitlement;
- required capabilities;
- risk and effect class;
- autonomy requirement;
- usage-metering unit;
- rate limits;
- audit metadata;
- idempotency behavior.

Generate from the same contract:

- application command handler;
- REST/OpenAPI operation;
- CLI command;
- MCP tool;
- SDK method;
- UI action schema;
- auth scopes;
- usage hook;
- documentation.

There must be no duplicated business logic in interface controllers.

Every launched venture receives its own branded Agent Surface.

Payout Rank examples:

- binary: `payout-rank`;
- MCP prefix: `payout_rank`;
- SDK: `@payout-rank/sdk`;
- API namespace: `/v1`;
- commands:
  - `opportunities.scan`;
  - `campaigns.plan`;
  - `campaigns.launch`;
  - `campaigns.status`;
  - `results.sync`;
  - `campaigns.optimize`.

ShipToUsers examples:

- binary: `ship-to-users`;
- MCP prefix: `ship_to_users`;
- SDK: `@ship-to-users/sdk`;
- commands:
  - `product.audit`;
  - `launch.plan`;
  - `launch.execute`;
  - `deployment.verify`;
  - `distribution.start`;
  - `learning.review`.

Customer AI agents receive venture-level scopes, not downstream provider
credentials.

==================================================
15. JSON-FIRST `vh` CLI
==================================================

Implement a real `vh` executable.

All commands support human-readable output and `--json`.

Machine mode:

- JSON on stdout;
- structured JSON errors on stderr;
- stable exit codes;
- no interactive prompt under `--non-interactive`;
- exact remediation;
- redacted logs.

Core commands:

- `vh doctor`;
- `vh auth ...`;
- `vh org ...`;
- `vh stack ...`;
- `vh pack ...`;
- `vh seed ...`;
- `vh idea compile`;
- `vh grant ...`;
- `vh venture ...`;
- `vh provider ...`;
- `vh run ...`;
- `vh data sync`;
- `vh learn ...`;
- `vh fleet ...`;
- `vh upgrade`;
- `vh verify ...`.

Suggested exit categories:

0 success
1 invalid input
2 provider/network failure
3 authentication/scope failure
4 verification failure
5 external write conflict
6 external action required
7 policy or budget denial
8 terminal workflow failure

==================================================
16. EVENT, AUDIT AND ASSET MODEL
==================================================

Implement an append-only event log for important intents, state transitions,
provider effects, approvals, budget reservations, asset changes and outcomes.

Each event contains:

- event ID;
- schema version;
- organization;
- venture;
- customer;
- actor;
- agent;
- run and node;
- kind;
- occurred time;
- correlation and causation IDs;
- sanitized payload;
- artifact references;
- provider effect;
- prior hash;
- current hash.

Use a per-workspace tamper-evident hash chain.

Do not event-source every application table without reason.

Implement an Asset Vault with:

- immutable versions;
- content hashes;
- source and rights;
- created-by actor/run;
- derived-from lineage;
- used-by lineage;
- ownership;
- visibility;
- retention;
- truth references;
- disclosure state;
- paid-use eligibility.

==================================================
17. PROVIDER SDK
==================================================

Create a typed provider lifecycle:

- discover;
- doctor;
- plan;
- estimate;
- apply;
- read back;
- verify;
- reconcile unknown outcome;
- retry;
- compensate when safe.

Every operation declares:

- operation ID;
- capability;
- schemas;
- auth methods;
- scopes;
- environments;
- effect class;
- risk;
- reversibility;
- idempotency;
- unknown-outcome strategy;
- rate-limit class;
- concurrency group;
- timeout;
- verification operation;
- redaction;
- cost semantics.

A timeout is not proof that nothing happened.

Before retrying an external write, search for the intended resource using an
idempotency key, deterministic label or provider metadata.

Never blindly duplicate:

- repositories;
- cloud projects;
- databases;
- products;
- prices;
- email templates;
- DNS records;
- social posts;
- ads;
- campaigns;
- render jobs.

==================================================
18. DURABLE GRAPH ENGINEERING
==================================================

Upgrade graph engineering from a procedural skill to an actual runtime.

Support node states:

- pending;
- ready;
- running;
- waiting_for_auth;
- waiting_for_external_action;
- waiting_for_approval;
- succeeded;
- failed_retryable;
- failed_terminal;
- skipped;
- compensated;
- cancelled.

Node contract:

- ID;
- purpose;
- kind;
- capability;
- dependencies;
- conditions;
- structured input;
- output schema;
- deterministic validator;
- transport;
- model tier;
- risk;
- effect;
- authorization;
- idempotency;
- timeout;
- retry and backoff;
- concurrency;
- budget;
- cache;
- worktree isolation;
- compensation;
- evidence artifact;
- completion criterion.

Runtime behavior:

- DAG validation;
- cycle detection;
- topological scheduling;
- parallel independent nodes;
- fan-out and fan-in;
- conditional routing;
- atomic checkpointing;
- crash recovery;
- resume;
- cancellation;
- failure isolation;
- budget enforcement;
- no repeat of verified effects;
- unknown-outcome reconciliation;
- bounded evaluator loops;
- model and provider usage accounting;
- sanitized event streaming.

Support:

- queue;
- steer;
- supersede.

A steer invalidates only affected nodes.

==================================================
19. LOOP ENGINEERING
==================================================

Implement recurring graphs with explicit:

- trigger;
- input sources;
- freshness;
- primary metrics;
- guardrails;
- decision rules;
- maximum actions;
- maximum iterations;
- autonomy level;
- allowed effects;
- output;
- next run;
- stop condition.

Loops:

- inner build loop;
- provider verification loop;
- launch loop;
- daily early-signal loop;
- weekly growth loop;
- biweekly product loop;
- monthly strategy loop;
- Winner Loop metric snapshots;
- creative fatigue loop;
- fleet upgrade loop.

Autonomy levels:

- observe;
- report;
- propose;
- open_pr;
- apply_low_risk;
- apply_within_policy.

Do not enforce exactly one change per week globally.

Use one active conceptual hypothesis per affected decision surface when
attribution matters.

==================================================
20. VENTURE FLEET AND AUTOMATIC CORE UPGRADES
==================================================

Independent venture repositories must remain linked to Core through upgrades,
not through a shared production runtime dependency.

Use four mechanisms:

1. versioned public Core packages;
2. managed files and `vh upgrade`;
3. pinned reusable CI workflows;
4. a Fleet Controller.

Implement `harness.lock` containing:

- Core version;
- seed version;
- package versions;
- provider adapter versions;
- generator versions;
- migrations;
- managed-file manifest;
- update channel;
- last verified upgrade.

A Core release emits a machine-readable release manifest:

- version;
- changed packages;
- affected capabilities;
- migrations;
- compatibility;
- required checks;
- rollout risk;
- rollback information.

Fleet Controller flow:

Core release
  -> determine affected ventures
  -> canary selection
  -> upgrade branch
  -> `vh upgrade`
  -> package update
  -> managed-file regeneration
  -> codemods
  -> migrations
  -> venture-specific tests
  -> preview deployment
  -> end-to-end verification
  -> automatic merge if policy allows
  -> production deployment
  -> production smoke test
  -> verified fleet state.

Use canary and batch rollout.

Pause on:

- failed migration;
- failed CI;
- failed preview;
- failed primary journey;
- failed production smoke;
- unexpected budget or provider effects.

Do not directly bind production ventures to `main`.

Pin:

- package versions;
- release manifests;
- workflow commit SHAs;
- migration versions.

The real fleet registry and credentials remain private.

==================================================
21. PACK RUNTIME
==================================================

Implement installable, versioned packs containing:

- manifest;
- required Core version;
- capabilities;
- ServiceBlueprints;
- skills;
- agent roles;
- connectors;
- event schemas;
- migrations;
- evaluations;
- UI metadata;
- installation state.

Create:

- `validate-first`;
- `ship-to-users`;
- `distribution-pr`;
- `winner-loop`;
- `web-saas`;
- `ios-subscription`.

The current 30/60/90-day methodology moves into `validate-first`.

It must no longer block all ventures.

Winner Loop is not a separate venture by default.

It is:

- an installable Distribution Engine pack;
- enabled in ShipToUsers where relevant;
- installable by any compatible mobile subscription venture;
- potentially productizable later without changing the Core abstraction.

==================================================
22. WINNER LOOP PURPOSE
==================================================

Implement Winner Loop as:

> Test organically. Scale with proof.

Canonical lifecycle:

creative hypothesis
  -> interpretable variant
  -> production asset
  -> rights and compliance review
  -> organic TikTok post or draft
  -> metric snapshots
  -> normalized evidence
  -> baseline-adjusted winner recommendation
  -> paid-test proposal
  -> explicit Spend Grant
  -> bounded TikTok Spark Ad test
  -> tracking and attribution validation
  -> subscription and renewal cohort
  -> winner, iteration, pause or rejection
  -> DistributionPR learning.

Winner Loop must generate market data for ventures that do not yet have enough
traffic for conventional analytics-driven optimization.

Do not optimize for views alone.

Do not use a universal 100k-view winner rule.

Do not describe organic correlation as deterministic user-level attribution.

==================================================
23. PERMANENT CREATIVE IDENTITY AND LINEAGE
==================================================

The central invariant:

Every produced creative variant receives one permanent internal
`creative_id`.

That creative ID must remain traceable through:

- hypothesis;
- script;
- storyboard;
- prompt version;
- render request;
- exported video;
- asset manifest;
- social publication;
- provider post ID;
- organic metric snapshots;
- paid-test proposal;
- Spark Ad;
- Meta adaptation;
- ad campaign, ad group and ad;
- click and deep-link metadata where available;
- attribution provider;
- RevenueCat/Stripe lifecycle evidence;
- cohort reports;
- winner evaluation;
- fatigue state;
- DistributionPR outputs.

Provider IDs are mappings, never the canonical creative identity.

Use:

- `hypothesis_id`;
- `creative_family_id`;
- `creative_id`;
- `derived_from_creative_id`;
- `platform_variant_of_creative_id`.

The exact same unmodified creative on multiple destinations keeps the same
creative ID.

A materially adapted creative receives a new creative ID with lineage to its
parent.

Do not mutate historical creative identity.

Implement a Creative Attribution Ledger.

==================================================
24. WINNER LOOP DOMAIN MODEL
==================================================

Implement at minimum:

- CreativeHypothesis;
- CreativeVariable;
- CreativeFamily;
- CreativeVariant;
- CreativeManifest;
- RenderJob;
- OrganicPublication;
- OrganicMetricSnapshot;
- MetricDefinition;
- AccountBaseline;
- FormatBaseline;
- WinnerEvaluation;
- PaidTestProposal;
- SpendGrant;
- SpendReservation;
- PaidCampaign;
- PaidAdGroup;
- PaidAd;
- AttributionMapping;
- SubscriptionEvent;
- RevenueEvent;
- CohortSnapshot;
- FatigueEvaluation;
- WinnerRecommendation.

Recommended status model:

- DRAFT;
- READY_FOR_PRODUCTION;
- RENDERING;
- ASSET_READY;
- RIGHTS_BLOCKED;
- READY_FOR_ORGANIC_REVIEW;
- ORGANIC_DRAFT;
- ORGANIC_PUBLISHED;
- ORGANIC_SIGNAL;
- BOOST_CANDIDATE;
- NEEDS_VARIANTS;
- PAID_TEST_PROPOSED;
- PAID_TEST_APPROVED;
- PAID_TEST_RUNNING;
- PAID_PROOF;
- SCALE_ELIGIBLE;
- SCALE_RECOMMENDED;
- FATIGUED;
- REJECTED;
- ARCHIVED.

Status transitions must be validated.

==================================================
25. CREATIVE MANIFEST AND RIGHTS
==================================================

Every creative asset has a manifest containing:

- creative ID;
- hypothesis ID;
- script version;
- prompts;
- source assets;
- screen recording;
- avatar or voice source;
- music and media licenses;
- testimonial consent reference;
- creator authorization;
- AI-generated state;
- disclosure requirements;
- approved regions;
- approved channels;
- approved for organic;
- approved for paid;
- expiry;
- product-truth references;
- prohibited claims;
- reviewer;
- approval event.

Do not convert organic content into paid content unless:

- rights are valid;
- claims are permitted;
- disclosure state is correct;
- creator authorization is valid;
- paid-use eligibility is true.

Never use fabricated testimonials or unapproved likenesses.

==================================================
26. GROWTH CONTRACT
==================================================

Create a machine-readable Growth Contract per venture.

Fields:

goal:
- primary event;
- secondary events;
- optimization event.

economics:
- subscription price;
- store fees;
- taxes;
- refunds;
- variable serving cost;
- generation cost;
- expected subscriber lifetime;
- target CAC;
- hard maximum CAC;
- payback target;
- retention guardrails;
- refund guardrails;
- minimum net contribution margin.

organic:
- allowed accounts;
- maximum posts;
- account types;
- review policy;
- duplicate-content rules;
- snapshot cadence.

paid:
- test budget per creative;
- daily creative cap;
- daily account cap;
- monthly cap;
- currency;
- approval threshold;
- auto-pause;
- auto-scale;
- allowed networks;
- allowed geographies;
- allowed objectives;
- stop conditions.

compliance:
- rights;
- AI disclosures;
- prohibited claims;
- restricted audiences;
- platform rules;
- data and consent requirements.

Use currency minor units for spend ledgers.

==================================================
27. CREATIVE EXPERIMENT MATRIX
==================================================

Generate interpretable hypotheses rather than many random videos.

Dimensions may include:

- problem;
- audience;
- emotion;
- hook;
- opening frame;
- format;
- speaker;
- proof type;
- CTA;
- offer;
- duration;
- destination;
- platform.

Each experiment must state:

- hypothesis;
- variable under test;
- controls;
- expected signal;
- guardrails;
- required sample;
- decision criteria.

Avoid changing many conceptual dimensions in one comparison.

Use models to propose and write.

Use deterministic code to enumerate, deduplicate, assign IDs and validate the
matrix.

==================================================
28. CREATIVE PRODUCTION
==================================================

Abstract creative generation behind capabilities.

Support adapters such as:

- HeyGen;
- Higgsfield;
- local renderer/FFmpeg;
- future providers.

Do not invent a REST API when a provider only exposes an official CLI, MCP or
another supported interface.

Provider operation must:

- create render job;
- persist request;
- map provider job ID;
- poll or receive webhook;
- reconcile unknown outcome;
- copy final asset to the venture/customer asset vault where licensing allows;
- retain provenance;
- produce thumbnail/captions;
- verify duration, aspect ratio and media format.

The creative can combine:

- real app recordings;
- product interaction;
- subtitles;
- voice-over;
- licensed B-roll;
- avatar;
- native platform treatments;
- real approved reviews.

Do not default every creative to a synthetic talking head.

==================================================
29. ORGANIC PUBLISHING
==================================================

Support organic modes:

- `automatic_within_policy`;
- `review_before_publish`;
- `send_as_platform_draft`.

Default the first Winner Loop release to `review_before_publish`.

A venture owner may preauthorize `automatic_within_policy` under explicit
account, volume, channel and content restrictions.

Do not create or encourage:

- fake personas;
- engagement farms;
- coordinated manipulation;
- moderation evasion;
- mass duplicate posting;
- unauthorized account use.

Support provider alternatives:

- Zernio;
- Postiz;
- native TikTok Content Posting;
- future providers.

Feature-detect:

- direct publish;
- draft upload;
- privacy controls;
- duet/stitch settings;
- media requirements;
- analytics availability;
- provider review state.

==================================================
30. ORGANIC METRIC INGESTION
==================================================

Create scheduled metric snapshots, configurable by platform, such as:

- 30 minutes;
- 2 hours;
- 6 hours;
- 24 hours;
- 72 hours;
- 7 days.

Potential metrics:

- views;
- view velocity;
- early hold;
- longer hold;
- average watch time;
- watch-time ratio;
- completion;
- rewatches;
- likes;
- shares;
- saves;
- comments;
- profile visits;
- outbound clicks;
- app-store visits;
- installs;
- trials;
- purchases.

Do not assume all metrics are available.

Every metric value records:

- provider;
- provider account;
- definition;
- unit;
- availability;
- source object;
- reporting window;
- latency;
- fetched time;
- attribution window;
- confidence;
- raw reference;
- normalized value;
- missing reason.

Missing is not zero.

Different provider definitions must not be silently combined.

==================================================
31. BASELINE-ADJUSTED WINNER EVALUATION
==================================================

Implement baseline-adjusted evaluation.

Use:

- account baseline;
- format baseline;
- duration baseline;
- geography;
- account age;
- sample size;
- metric freshness;
- downstream-intent metrics;
- uncertainty.

A configurable initial score may consider:

- velocity versus account baseline;
- completion;
- watch-time ratio;
- shares;
- saves;
- profile visits;
- clicks;
- qualitative buying-intent comments.

Do not hard-code example weights as permanent truth.

Persist scoring-version and input data.

Use conservative confidence intervals or Bayesian/posterior methods where
appropriate, but do not add statistical sophistication without interpretable
outputs and tests.

A recommendation explains:

- evidence;
- missing data;
- uncertainty;
- interpretation;
- next test;
- why spend is or is not justified.

Possible recommendation:

- no signal;
- gather more data;
- create CTA variants;
- boost candidate;
- do not boost;
- paid-test candidate;
- fatigue detected.

==================================================
32. SPARK AD PAID TEST FLOW
==================================================

A paid test is a distinct experiment.

A TikTok organic winner is not automatically a Meta winner.

Flow:

organic post
  -> verify provider post identity
  -> verify Spark Ad eligibility
  -> create PaidTestProposal
  -> calculate economics and stop conditions
  -> show exact account, objective, event, geography and budget
  -> explicit human approval
  -> create Spend Grant
  -> reserve budget
  -> create bounded paid test
  -> verify provider state
  -> ingest spend and outcomes
  -> automatically pause on hard guardrail
  -> recommend next action.

The first paid euro requires human approval.

A Launch Grant, Customer Service Grant or organic-publishing policy does not
authorize spend.

The proposal must show:

- source creative and post;
- provider account;
- objective;
- optimization event;
- total budget;
- daily cap;
- start/end;
- stop conditions;
- tracking health;
- attribution confidence;
- target CAC;
- hard maximum CAC;
- expected payback;
- current readiness;
- rights/compliance state.

Approval options:

- approve exact test;
- edit budget;
- reject;
- create variants first.

==================================================
33. SPEND SAFETY
==================================================

Implement:

- immutable Spend Grant;
- spend reservations;
- transactional budget ledger;
- per-creative cap;
- per-campaign cap;
- per-account daily cap;
- venture daily/monthly cap;
- customer cap;
- currency;
- validity window;
- kill switch;
- reconciliation with provider spend.

Concurrency must not allow two jobs to exceed one cap.

Automatically pause when:

- tracking health fails;
- attribution mapping breaks;
- provider policy warning appears;
- hard budget is reached;
- no-trial/no-purchase stop condition triggers;
- refund or anomaly guardrail triggers;
- rights become invalid;
- connection is revoked.

Do not automatically increase a budget in V1.

Do not modify payment methods.

Do not move money across ventures.

Do not spend from Venture Harness-owned ad accounts for customer ventures.

==================================================
34. OPTIMIZATION READINESS LADDER
==================================================

Do not use VBO, value optimization, target ROAS or autonomous scaling as a
universal default.

Implement readiness stages:

- NO_SIGNAL;
- TRACKING_SETUP;
- HIGH_INTENT_EVENT_READY;
- PURCHASE_READY;
- VALUE_READY;
- SCALE_READY.

Readiness requires:

- healthy event delivery;
- correct currency and value;
- event deduplication;
- acceptable data latency;
- sufficient conversion volume;
- reliable attribution;
- stable economics;
- provider-side eligibility;
- acceptable refund and retention quality;
- explicit venture policy.

When purchases are insufficient, recommend or use the nearest meaningful
high-intent event only if the Growth Contract permits it.

Move to purchase/subscription optimization only with reliable purchase
signals.

Move to value optimization only when:

- value data is reliable;
- provider confirms eligibility;
- conversion volume is sufficient;
- attribution is healthy;
- cohort quality supports the action.

Do not hard-code provider thresholds that may change.

Adapters must:

- inspect current provider/account eligibility where possible;
- retain last verification;
- link to the official rule in internal evidence;
- fail closed when eligibility is unknown.

V1:

- recommendations only for scaling;
- no automatic budget increases;
- no cross-platform automatic allocation;
- no automatic VBO activation.

Later automation requires a separate explicitly approved Scale Envelope.

==================================================
35. ATTRIBUTION LEDGER
==================================================

RevenueCat is a subscription lifecycle and revenue source, not the sole
campaign attribution engine.

Design the system around:

- attribution provider/MMP;
- campaign metadata;
- creative ID;
- provider post/ad IDs;
- deep links;
- click IDs;
- UTMs;
- RevenueCat subscriber and event data;
- Stripe events;
- Apple privacy-preserving postbacks;
- optional self-reported attribution;
- time/geographic experiments;
- future incrementality tests.

Classify every attribution result:

- DETERMINISTIC;
- PROVIDER_ATTRIBUTED;
- PRIVACY_AGGREGATED;
- CORRELATED;
- MODELED;
- INCREMENTAL_EXPERIMENT;
- UNKNOWN.

Never display modeled or correlated results as deterministic.

Record:

- source;
- window;
- method;
- confidence;
- limitations;
- identity keys;
- mapping version;
- data freshness.

==================================================
36. REVENUECAT COHORT OUTCOME
==================================================

Implement creative-level or creative-family cohort reporting only when
attribution quality supports it.

Cohort periods:

- D0;
- D7;
- D30;
- D90;
- configurable later.

Metrics:

- spend;
- impressions;
- clicks;
- installs;
- onboarding completion;
- paywall views;
- trials;
- initial subscribers;
- later conversions;
- renewals;
- cancellations;
- refunds;
- net revenue;
- active subscribers;
- CAC;
- trial-to-paid;
- ROAS;
- retention;
- payback.

Every cohort report includes:

- creative ID;
- attribution classification;
- attribution provider;
- reporting window;
- RevenueCat project;
- currency normalization;
- net/gross definition;
- missing data;
- data freshness;
- known limitations.

Subscription webhook ingestion must:

- verify signatures;
- handle duplicate events idempotently;
- handle out-of-order delivery;
- store provider event ID;
- reconcile state;
- support sandbox separation;
- preserve refunds and negative revenue.

==================================================
37. META RETESTING
==================================================

Do not automatically assume that a TikTok winner is a Meta winner.

A Meta adaptation may change:

- opening frame;
- duration;
- text placement;
- caption;
- CTA;
- destination;
- safe areas;
- attribution tags.

A material adaptation receives a new creative ID linked to its parent.

Track network status separately:

- TikTok organic state;
- TikTok paid state;
- Meta paid state.

Require a separate paid test and Spend Grant per network unless an explicit
multi-network grant exists.

==================================================
38. PROVIDER ADAPTERS FOR WINNER LOOP
==================================================

Implement provider-neutral contracts and honest capability matrices for:

Social publishing and analytics:

- Zernio;
- Postiz;
- native TikTok;
- future providers.

Creative generation:

- HeyGen;
- Higgsfield;
- local renderer;
- future providers.

Paid acquisition:

- Zernio ads abstraction;
- native TikTok Ads;
- native Meta Ads.

Attribution:

- AppsFlyer;
- Adjust;
- Singular;
- Branch;
- Apple privacy-attribution ingestion where applicable.

Subscription and revenue:

- RevenueCat;
- Stripe.

For every provider:

- use official interfaces;
- detect features;
- distinguish local and hosted auth;
- declare review/partner requirements;
- implement doctor, plan, apply, verify and reconcile;
- test redaction;
- never rely on undocumented behavior.

Do not copy AGPL Postiz implementation code into Venture Harness.

Use Postiz as an external adapter through official interfaces.

==================================================
39. DISTRIBUTIONPR INTEGRATION
==================================================

Winner Loop must emit structured learnings consumable by DistributionPR.

Examples:

- hooks with high reach but weak intent;
- product demos with lower reach but better paid CAC;
- paywall mismatch;
- CTA quality differences;
- price-anchor effects;
- audience/retention differences;
- onboarding friction;
- attribution defects;
- landing-page message mismatch;
- App Store screenshot/message opportunities.

DistributionPR may propose:

- landing page changes;
- onboarding changes;
- paywall changes;
- pricing presentation;
- App Store metadata and screenshots;
- deep-link fixes;
- tracking fixes;
- campaign pages;
- product-led creative variants.

Every DistributionPR includes:

- evidence;
- creative IDs;
- cohort windows;
- hypothesis;
- confidence;
- implementation;
- preview;
- measurement plan;
- rollback;
- limitations.

==================================================
40. RECURSIVE VENTURE RUNTIME
==================================================

Every launched company inherits:

- auth;
- organizations;
- memberships;
- subscriptions;
- entitlements;
- customer Connection Hub;
- tenant credential broker;
- provider runtime;
- ServiceBlueprint runtime;
- durable orchestration;
- customer asset vault;
- policy engine;
- usage metering;
- audit;
- agent gateway;
- data ingestion;
- scheduled loops;
- revocation;
- offboarding.

A venture contributes:

- unique application;
- unique design;
- proposition;
- pricing;
- business model;
- Connector Manifest;
- ServiceBlueprints;
- Command Contracts;
- evaluation criteria;
- outcome metrics.

A Payout Rank customer’s connection must not be visible to ShipToUsers or
DistributionPR without a separate explicit grant.

==================================================
41. REFERENCE SERVICE BLUEPRINTS
==================================================

Create synthetic reference blueprints.

Payout Rank:

- opportunity discovery;
- campaign planning;
- creative generation;
- distribution;
- outcome measurement;
- business-specific agent commands;
- customer connectors such as Postiz/Zernio and HeyGen/Higgsfield;
- no claim that all live affiliate providers are implemented.

ShipToUsers:

- product audit;
- repository work;
- infrastructure;
- production launch;
- commerce;
- analytics/search;
- distribution;
- learning;
- customer-facing agent commands.

Winner Loop:

- mobile subscription wedge;
- creative hypothesis;
- video;
- TikTok organic;
- metric snapshots;
- winner proposal;
- manual Spark Ad approval;
- bounded paid test;
- RevenueCat cohort.

DistributionPR:

- evidence ingestion;
- opportunity;
- repository PR;
- preview;
- outcome measurement.

All use the same Venture Runtime.

All retain unique product identities.

==================================================
42. ANALYTICS EVENT PACKS
==================================================

Replace the fixed universal event taxonomy with composable packs:

- core_product;
- web_acquisition;
- lead_generation;
- onboarding;
- authentication;
- subscription;
- one_time_payment;
- content;
- experiment;
- mobile;
- feedback;
- reliability;
- distribution;
- winner_loop;
- paid_acquisition;
- attribution;
- cohort.

Activate only relevant packs.

Preserve:

- no PII in third-party analytics;
- exact prices;
- first-party commercial evidence;
- independent high-intent persistence;
- typed properties;
- explicit attribution windows;
- provider provenance.

Winner Loop events may include:

- creative_hypothesis_created;
- creative_render_requested;
- creative_render_completed;
- creative_approved_for_organic;
- organic_post_published;
- organic_metric_snapshot;
- winner_evaluation_completed;
- boost_candidate_recommended;
- paid_test_proposed;
- spend_grant_approved;
- paid_test_started;
- paid_test_paused;
- paid_test_completed;
- subscription_event_ingested;
- cohort_snapshot_calculated;
- creative_paid_proof;
- creative_fatigued.

Do not send raw scripts, customer messages or private creative inputs to
third-party analytics.

==================================================
43. DIRECT DATA INGESTION AND DATA QUALITY
==================================================

Direct provider connectors are the primary data path.

CSV remains an offline/manual fallback.

Every normalized dataset records:

- source;
- external account/property;
- fetched time;
- reporting window;
- timezone;
- dimensions;
- release/app version;
- sampling;
- threshold limitations;
- attribution method;
- data-quality state.

Implement:

- ingestion cursors;
- webhook deduplication;
- scheduled snapshots;
- retry;
- reconciliation;
- freshness;
- raw sanitized references;
- missing-data reasons.

Scheduled workflows must fetch actual connected data or use explicitly labeled
fixtures.

Do not generate empty reports from absent local CSV files and call the loop
operational.

==================================================
44. WEB, IOS AND HYBRID RAILS
==================================================

Web default:

- Next.js;
- server-rendered public content;
- provider-neutral environment contract;
- real migrations;
- public site, authenticated application or both.

Mobile:

- Expo React Native;
- SwiftUI;
- auto router.

Prefer Expo for fast cross-platform MVPs and shared TypeScript.

Prefer SwiftUI for deeply Apple-native or on-device products.

Hybrid:

- Vercel-hosted support/privacy/marketing;
- mobile app;
- shared contracts;
- one entitlement source of truth;
- separate web SEO and ASO.

Winner Loop first wedge:

- mobile subscription apps using RevenueCat;
- one venture;
- limited legitimate TikTok accounts;
- one creative provider;
- one social publishing provider;
- one attribution provider;
- no automated scaling.

==================================================
45. QUALITY PROFILES
==================================================

Implement capability-aware:

`vh verify fast`

- affected lint/format;
- targeted tests;
- schemas;
- graph;
- skill parity;
- secret/PII baseline.

`vh verify mvp`

- typecheck;
- build;
- core journeys;
- migrations;
- active provider contracts;
- event packs;
- accessibility;
- responsive behavior;
- public metadata/raw HTML;
- product truth;
- provider dry run.

`vh verify release`

- full tests;
- e2e;
- screenshots;
- accessibility;
- crawler agents;
- checkout and webhooks;
- migration upgrade;
- graph resume/idempotency;
- sandbox provider verification;
- mobile/TestFlight readiness;
- Winner Loop spend and attribution safety;
- fleet upgrade fixture;
- secret scan.

Do not run irrelevant checks.

Do not weaken checks to get green.

==================================================
46. WINNER LOOP TEST REQUIREMENTS
==================================================

Test:

- creative ID immutability;
- lineage;
- exact mapping to render/post/ad;
- missing metrics are not zero;
- metric definitions stay provider-scoped;
- baseline scoring versioning;
- no paid test without Spend Grant;
- budget reservation concurrency;
- hard caps;
- automatic pause;
- no automatic scale;
- no VBO without readiness;
- rights block;
- disclosure block;
- unknown provider outcome reconciliation;
- duplicate webhook handling;
- out-of-order subscription events;
- attribution classification;
- RevenueCat cohort calculation;
- refunds;
- currency handling;
- revocation;
- cross-venture isolation;
- DistributionPR evidence linkage.

Use property-based or concurrency tests where valuable.

==================================================
47. PUBLIC OPEN-SOURCE CONTRIBUTION
==================================================

Keep Venture Harness public.

Present it honestly as pre-alpha until the working vertical slice is proven.

Create a high-quality public project experience:

- clear README;
- architecture diagrams;
- “what works today” matrix;
- quickstart;
- local demo;
- synthetic walkthroughs;
- provider authoring guide;
- pack authoring guide;
- seed authoring guide;
- ServiceBlueprint guide;
- Agent Surface guide;
- fleet upgrade guide;
- Winner Loop methodology;
- security model;
- threat model;
- data ownership;
- offboarding;
- roadmap;
- changelog;
- governance;
- Code of Conduct;
- contribution guide.

Explain Postiz and Buzz as architectural influences without copying their code.

Winner Loop documentation should communicate:

- organic testing before spend;
- creative-to-revenue lineage;
- human approval before paid testing;
- hard budget caps;
- no premature VBO;
- honest attribution;
- customer ownership.

Do not market planned behavior as live.

==================================================
48. SECURITY AND PUBLIC REPOSITORY SAFETY
==================================================

Strengthen:

- Gitleaks or equivalent;
- CodeQL or justified equivalent;
- Dependabot;
- dependency review;
- lockfile integrity;
- secret scanning guidance;
- branch protection guidance;
- push protection guidance;
- signed webhook validation;
- tenant isolation;
- SSRF protections;
- upload validation;
- path traversal;
- command injection;
- callback validation;
- OAuth state and PKCE;
- redirect allowlists;
- spend kill switches;
- audit integrity.

Expand public release checks to include:

- reports;
- artifacts;
- image metadata review declarations;
- refresh tokens;
- provider secrets;
- JWTs;
- webhook secrets;
- database URLs;
- private URLs;
- likely PII;
- full-history scan guidance.

No real venture data belongs in the public Core repository.

==================================================
49. MIGRATE CURRENT V0.1 CORRECTLY
==================================================

Move current validation-specific behavior into `packs/validate-first`.

Refactor universal rules:

- validation website is not always first;
- 30–90 days is optional;
- pricing experiments are optional;
- production deploy can be authorized by Launch Grant;
- organic publishing can be policy-authorized;
- paid spend remains separately approval-gated.

Refactor the oversized SEO/AEO skill into:

- concise router skill;
- focused resources;
- data contracts;
- executable connectors;
- validators.

Preserve useful current content.

Correct current code/document drift, including:

- experiment assignment runtime;
- consent withdrawal claims;
- real migrations;
- evidence idempotency;
- distributed rate-limit abstraction;
- bot/spam behavior;
- public-release checker scope;
- weekly data ingestion;
- upgrade mechanism.

==================================================
50. SYNTHETIC END-TO-END FIXTURES
==================================================

Create labeled synthetic fixtures.

Fixture A: web SaaS launch

- idea compile;
- Launch Grant;
- repository materialization;
- GitHub/Vercel/Neon mock or sandbox;
- Stripe test;
- Brevo test;
- Google/Bing plan;
- production-like verification.

Fixture B: iOS subscription venture

- RevenueCat Test Store;
- App Store external action;
- TestFlight-ready path;
- ASO;
- agent surface.

Fixture C: recursive Payout Rank-style service

- venture subscription;
- customer Connection Hub;
- Postiz/Zernio alternative;
- HeyGen/Higgsfield alternative;
- customer AI Agent Grant;
- ServiceBlueprint execution.

Fixture D: Winner Loop

- hypothesis;
- creative ID;
- render fixture;
- organic TikTok fixture;
- metric snapshots;
- winner recommendation;
- paid-test proposal;
- manual approval;
- spend reservation;
- Spark Ad fixture;
- RevenueCat subscription events;
- D0/D7/D30 cohort;
- no auto-scale.

Fixture E: fleet upgrade

- two independent synthetic venture repositories;
- unique code/design;
- Core upgrade;
- managed-file regeneration;
- package updates;
- migration;
- preview verification;
- preservation of venture-owned files.

Never call fixtures live.

==================================================
51. CI
==================================================

Add workflows for:

- fast changed-surface checks;
- full PR quality;
- graph runtime;
- provider contracts;
- migrations;
- agent parity;
- synthetic launch fixtures;
- recursive tenancy;
- Winner Loop safety;
- fleet upgrade;
- public release security;
- web production build;
- mobile configuration validation.

Use concurrency cancellation.

Pin third-party Actions appropriately.

Use fixtures where protected credentials are absent.

==================================================
52. IMPLEMENTATION ORDER
==================================================

Implement in coherent vertical slices.

Recommended order:

1. repository audit and ADRs;
2. pnpm workspace migration;
3. v0.2 schemas and terminology;
4. harness.lock and managed-file manifest;
5. command bus;
6. event/audit store;
7. asset vault;
8. credential broker;
9. autonomy and Spend Grants;
10. provider SDK;
11. durable graph runtime;
12. JSON-first CLI;
13. GitHub/Vercel/Neon vertical launch;
14. seed and pack runtime;
15. recursive Venture Runtime;
16. Agent Surface generators;
17. fleet upgrade engine;
18. migrate validate-first;
19. direct data ingestion;
20. Winner Loop domain model;
21. creative adapters and fixtures;
22. organic publishing and metrics;
23. winner evaluator;
24. paid-test approval and spend safety;
25. attribution and RevenueCat cohorts;
26. DistributionPR linkage;
27. control-plane UX;
28. public docs and security;
29. full fixtures and release verification.

Keep the repository usable after every slice.

Commit coherent slices with clear messages.

==================================================
53. DEFINITION OF DONE
==================================================

The work is complete only when:

- Venture Harness is a pnpm workspace with a real Core architecture;
- current useful v0.1 behavior is migrated;
- validate-first is optional;
- Launch Grants exist;
- a new independent Venture Repository can be materialized from a versioned
  seed;
- provider choices are capability-based;
- founder defaults exist but are replaceable;
- customer-owned infrastructure is modeled correctly;
- recursive customer connections are tenant- and venture-scoped;
- a launched venture can define unique ServiceBlueprints;
- API, CLI, MCP, SDK and UI derive from one Command Contract;
- raw downstream credentials never enter model context;
- graph runs persist, resume and reconcile unknown effects;
- Winner Loop exists as a pack;
- creative ID persists through the full funnel;
- organic metrics retain definition and confidence;
- winner recommendations are baseline-adjusted;
- no paid test can start without a valid Spend Grant;
- concurrent execution cannot exceed hard budgets;
- auto-pause works;
- auto-scaling is disabled by default;
- VBO requires explicit readiness;
- RevenueCat cohorts preserve attribution limitations;
- DistributionPR can cite Winner Loop evidence;
- Core releases can upgrade independent ventures through a tested fleet flow;
- venture-owned files survive upgrades;
- all synthetic fixtures pass;
- public docs match real behavior;
- no secrets or real customer data are committed;
- generated agent copies are synchronized;
- relevant CI is green;
- implementation commits exist;
- a draft pull request is open when permissions permit.

==================================================
54. REQUIRED VERIFICATION
==================================================

Run the equivalent of:

- frozen install;
- workspace validation;
- agent sync;
- agent parity;
- skill validation;
- config validation;
- document/link/claim validation;
- unit tests;
- integration tests;
- tenancy tests;
- provider contract tests;
- graph resume/idempotency tests;
- migration tests;
- Winner Loop tests;
- spend concurrency tests;
- attribution tests;
- fleet upgrade fixture;
- typecheck;
- lint;
- formatting;
- web production build;
- fast verification;
- MVP verification;
- release verification;
- raw HTML crawler checks;
- secret scan;
- dependency review.

A skipped test is not a pass.

For every live-unverified capability report:

- what was not verified;
- why;
- required credential/account/review;
- exact command;
- expected evidence.

==================================================
55. FINAL REPORT
==================================================

End in this exact order:

1. What changed.
2. Current Core architecture.
3. Migrated v0.1 behavior.
4. Launch Grant and venture materialization.
5. Provider portability and founder defaults.
6. Recursive Venture Runtime and customer authorization.
7. Unique API/CLI/MCP/SDK generation.
8. Graph and loop runtime.
9. Fleet update behavior.
10. Winner Loop architecture.
11. Creative ID and attribution behavior.
12. Paid spend and VBO safety.
13. DistributionPR integration.
14. Commands and tests run.
15. What passed.
16. What could not be live-verified.
17. Remaining genuine external actions.
18. Public open-source readiness.
19. Commits and draft PR.
20. Exact command for the first real one-prompt venture launch.
21. Exact command for running the synthetic Winner Loop fixture.

Do not conclude with recommendations alone.

Implement, test, fix, commit and report.
```

Deze prompt maakt Winner Loop niet tot een geïsoleerde growthfeature. Hij gebruikt Winner Loop als de zwaarste bewijsproef voor vrijwel alle kernprincipes van Venture Harness: providerportabiliteit, customer-owned assets, duurzame graphs, lineage, agentinterfaces, menselijke spendgoedkeuring, budgetintegriteit, eerlijke attributie, RevenueCat-cohorten, DistributionPR en automatische Core-upgrades.

[1]: https://developers.tiktok.com/products/content-posting-api?utm_source=chatgpt.com "Content Posting API | TikTok for Developers"
[2]: https://www.revenuecat.com/docs/integrations/integrations?utm_source=chatgpt.com "Events Overview | In-App Subscriptions Made Easy – RevenueCat"
[3]: https://developer.apple.com/app-store/ad-attribution/?utm_source=chatgpt.com "Ad Attribution - App Store - Apple Developer"
[4]: https://docs.zernio.com/mcp?utm_source=chatgpt.com "MCP - Zernio API"
