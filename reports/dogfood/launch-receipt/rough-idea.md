# Rough idea: Launch Receipt

> **DOGFOOD INPUT — PLANNED AND UNVERIFIED.** This brief contains no customer,
> model, provider, deployment, payment, or live-journey evidence.

Build a very small web product for indie hackers who are preparing to launch a
SaaS. Their launch requirements, proof, and remaining actions are scattered
across notes, provider dashboards, and messages.

The useful outcome is one focused launch checklist and a clean public read-only
receipt that distinguishes what is ready, what has proof, and what still needs
work. The primary journey is: sign in with an owner email, create one launch,
complete the essential checklist, preview it, publish it, and open the public
receipt. Persist the launch and publication state in Postgres.

Use a subscription hypothesis of exactly EUR 9.00 per month through Stripe for
the web product. Founder-alpha verification must create and read back only
Stripe test-mode product, recurring price, webhook, and portal resources. It
must never create a real charge. Publishing the receipt—not checkout—is the
primary success signal: `launch_receipt_published`.

An optional founder-authorized transactional copy of the published receipt may
use Brevo when that account is available, but email, Google/Bing setup, and a
custom domain must remain explicit non-blocking actions. The verified Vercel
production URL is enough for the first launch; DNS is manual.

Make readiness feel like a calm evidence ledger, not a startup dashboard:
strong hierarchy, explicit draft/published and ready/remaining states, a
memorable publish-to-receipt transition, accessible contrast and focus, useful
empty/error/loading states, responsive desktop/mobile composition, and reduced
motion support. Label every sample.

Do not build project management, teams, a generic startup dashboard, provider
automation inside the product, custom checklist templates, file uploads, an
agent API/CLI/MCP/SDK, mobile apps, a Venture Harness control plane, Winner
Loop, Fleet, advertising, or automated outreach.
