> **DOGFOOD OUTPUT — PLANNED AND UNVERIFIED.** This generated local artifact is
> not customer, provider, deployment, or live-product evidence.

# Launch Receipt Product Constitution

- Category: A focused web app that helps an indie SaaS founder complete one launch checklist and publish an honest read-only readiness receipt.
- Promise: Complete one focused launch checklist and publish a clean receipt that separates ready, remaining, and evidenced work
- Proposition hypothesis: Turn scattered launch checks into one evidence-aware checklist and a shareable read-only launch receipt
- First user: An indie hacker or small SaaS founder preparing a first product launch
- Job to be done: Launch requirements, evidence, and remaining actions are scattered across notes and provider dashboards
- Native product object: A persisted launch checklist that becomes one public read-only receipt with explicit draft, ready, remaining, and evidence states
- Primary journey: The founder signs in with an owner email and creates one launch. -> The founder completes the essential checklist and adds optional evidence references. -> The founder previews and publishes the receipt, then opens its public read-only URL.
- Business-model boundary: subscription; stripe; price EUR 9; one commitment event (The founder starts a EUR 9 monthly subscription through a Stripe test-mode checkout used only for launch verification.).
- First learning question: Will the target user produce launch_receipt_published before 2026-09-08?

## Truth register

- FACT — This file is planned dogfood input and is not live customer or provider evidence.
- FACT — The requested rail is a web product for indie hackers and small SaaS founders preparing a launch.
- FACT — The founder requested exactly EUR 9 per month as a Stripe test-mode price hypothesis and prohibited any real charge.
- FACT — Publishing a receipt, not checkout, is the primary success signal.
- FOUNDER_ASSUMPTION — One focused checklist plus a read-only receipt is sufficient for the first useful outcome.
- FOUNDER_ASSUMPTION — Founders will enter readiness states and optional evidence references manually.
- FOUNDER_ASSUMPTION — Email sign-in and an unguessable public receipt URL are acceptable for the first dogfood journey.
- FOUNDER_ASSUMPTION — A recurring EUR 9 subscription may fit the launch-readiness job.
- MODEL_INFERENCE — Publishing a stable public receipt requires persisted state and owner authorization.
- MODEL_INFERENCE — Stripe test-mode verification requires payments and entitlements on the initial rail even though a real charge is forbidden.
- MODEL_INFERENCE — A founder-authorized transactional receipt email can remain deferred without blocking the Vercel production URL journey.
- UNKNOWN — Which checklist items founders consider indispensable
- UNKNOWN — What evidence references founders are willing to publish
- UNKNOWN — Whether receipts are primarily private coordination records or public trust artifacts
- UNKNOWN — Whether a recurring subscription matches an episodic launch job
- FIXTURE — Any sample or synthetic data must be visibly labeled at its public surface.

Truth classes are FACT, FOUNDER_ASSUMPTION, MODEL_INFERENCE, FIXTURE, EXTERNALLY_VERIFIED, UNKNOWN, and CONTRADICTORY.

Models may improve framing, prioritization, language, design, and implementation. Models may not invent provider state, users, demand, metrics, results, customers, revenue, reviews, source URLs, or testimonials.

## Capability scope

- frontend — REQUIRED
- backend — REQUIRED
- database — REQUIRED
- authentication — REQUIRED
- authorization — REQUIRED
- payments — REQUIRED
- entitlements — REQUIRED
- transactionalEmail — DEFERRED
- analytics — REQUIRED
- privacyAndConsent — REQUIRED
- seo — REQUIRED
- aeo — REQUIRED
- geo — REQUIRED
- agentSurface — NOT_APPLICABLE
- scheduledLearning — DEFERRED

## Scope exclusions

- Project-management features
- Teams or customer organizations
- A generic startup dashboard
- Provider automation inside the product
- Custom checklist templates
- File uploads
- Customer agent API, CLI, MCP, or SDK surfaces
- Native mobile apps
- Another Venture Harness control plane
- Winner Loop, Fleet, advertising, or automated outreach
