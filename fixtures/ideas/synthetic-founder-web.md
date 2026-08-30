---
schemaVersion: 1
synthetic: true
venture:
  name: Exception Desk
  slug: exception-desk
  domain: exception-desk.example.test
  oneSentenceThesis: A calm reconciliation desk for recurring service invoices.
  targetUser: Small service-business operators reconciling recurring client work
  painfulJob: Delivered work and recurring invoices drift across spreadsheets
  desiredOutcome: See an accurate exception list and prepare the next invoice run
  proposition: Reconcile recurring service delivery into one explainable exception list before the next invoice run
  differentiation: One fixture-honest exception workflow replaces a generic finance dashboard
  founderAdvantage: Direct experience reconciling recurring client delivery and invoices
product:
  oneCoreFeature: An authenticated persisted exception desk for labeled invoice fixtures
  primaryJourney:
    - Sign in as the labeled fixture operator
    - Import the labeled synthetic fixture
    - Review every reconciliation exception
    - Confirm the invoice draft
  primaryCta: Confirm invoice draft
  explicitNotBuilding:
    - Sending or charging an invoice
    - A general accounting suite
    - Multi-organization administration
  designThesis: A warm paper ledger with dense operational clarity and a visible confirmation seal
  trustRequirements:
    - Authentication for the operator workspace
    - Persisted exception state in the database
    - Transactional email only to an explicitly authorized test identity
    - Privacy-safe analytics for the success signal
    - Search-crawlable public product information
business:
  model: subscription
  priceHypothesis: 24.5
  currency: EUR
  paymentProvider: stripe
  commercialCommitmentEvent: A Stripe test-mode subscription checkout is started
distribution:
  firstChannel: Search discovery and warm founder outreach
  firstUserHabitat: Small service-business operator communities
  initialMessage: Reconcile delivered work and recurring invoices in one calm exception desk.
  firstValidationAction: Ask five relevant operators to complete the labeled reconciliation journey
decision:
  launchMode: thin_mvp
  primarySuccessSignal: invoice_draft_confirmed
  reviewDate: 2026-09-12
  continueRule: Continue when relevant operators confirm accurate invoice drafts
  changeRule: Change the import or review flow when operators cannot explain an exception
  stopRule: Stop when the target operators do not value a dedicated reconciliation desk
truth:
  facts:
    - The founder supplied this synthetic Golden Path fixture
  assumptions:
    - A EUR 24.50 monthly subscription may fit the workflow
  inferences:
    - An exception-first desk is the smallest credible product surface
  contradictions: []
  unknowns:
    - Whether real operators will pay for the workflow
  externalEvidence: []
agentNative:
  customerAgentSurfaceRequired: false
  serviceBlueprintRequired: false
  outcomeCommands: []
capabilities:
  frontend: REQUIRED
  backend: REQUIRED
  database: REQUIRED
  authentication: REQUIRED
  authorization: REQUIRED
  payments: REQUIRED
  entitlements: REQUIRED
  transactionalEmail: REQUIRED
  analytics: REQUIRED
  privacyAndConsent: REQUIRED
  seo: REQUIRED
  aeo: DEFERRED
  geo: DEFERRED
  agentSurface: NOT_APPLICABLE
  scheduledLearning: NOT_APPLICABLE
---

# Exception Desk

SYNTHETIC FIXTURE — NOT LIVE PROVIDER OR CUSTOMER EVIDENCE.

The Launch Contract above is the canonical input. It is carried as YAML front
matter rather than a bare document body so that Markdown formatting cannot
reflow it: a bare body loses the indentation and list structure the schema
depends on, and the contract then silently degrades to an unstructured idea.
