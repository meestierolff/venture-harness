/**
 * Consent verification (static):
 *  - config: strict default (relaxing requires a consent ADR), withdrawal
 *    allowed, settings link required, forbidden collection all false
 *  - taxonomy: consent events go first-party only; any ga4 event that is
 *    recordable pre-consent must also have a first-party (neon) leg
 *  - code: GA loads only through the consent-gated AnalyticsScripts
 *    component, starts denied, and disables immediately on withdrawal;
 *    analytics clients without a proven shutdown API are not loaded
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Reporter, readText, loadYaml, walk } from "./lib/util";
import type { z } from "zod";
import { analyticsSchema } from "../lib/config/schemas";

const r = new Reporter("verify-consent");
const analytics = analyticsSchema.parse(loadYaml("config/analytics.yaml")) as z.infer<
  typeof analyticsSchema
>;

// 1. Config posture ----------------------------------------------------------
if (analytics.consent.default_mode === "strict") r.ok("consent default_mode is strict");
else {
  const adrs = existsSync(join(ROOT, "docs/decisions"))
    ? readdirSync(join(ROOT, "docs/decisions")).filter((f) => /consent/i.test(f))
    : [];
  if (adrs.length > 0)
    r.ok(`consent mode "${analytics.consent.default_mode}" backed by ADR: ${adrs[0]}`);
  else
    r.fail(
      "consent mode",
      `"${analytics.consent.default_mode}" without a consent ADR`,
      "add docs/decisions/ADR-XXX-consent-*.md recording the human decision, or restore strict",
    );
}
r.ok("withdrawal + settings link enforced by schema");
r.ok(
  "prohibited collection flags enforced by schema (keystrokes/replay/forms/search/email/ads all false)",
);

// 2. Taxonomy consent semantics ---------------------------------------------
let taxonomyClean = true;
for (const [name, ev] of Object.entries(analytics.events)) {
  const isConsentEvent = name.startsWith("consent_") || name.startsWith("analytics_");
  if (isConsentEvent && ev.destinations.some((d) => d !== "neon")) {
    taxonomyClean = false;
    r.fail(
      `event ${name}`,
      "consent event has third-party destination",
      "consent events go to first-party storage only",
    );
  }
  if (
    ev.consent === "none" &&
    ev.destinations.includes("ga4") &&
    !ev.destinations.includes("neon")
  ) {
    taxonomyClean = false;
    r.fail(
      `event ${name}`,
      "pre-consent event with ONLY a third-party destination",
      "add a neon leg or set consent: analytics",
    );
  }
  if (ev.consent === "none" && ev.destinations.includes("vercel")) {
    taxonomyClean = false;
    r.fail(
      `event ${name}`,
      "pre-consent event routed to vercel while vercel_analytics is opt_in",
      "set consent: analytics or drop the vercel destination",
    );
  }
}
if (taxonomyClean) r.ok("taxonomy consent semantics coherent");

// 3. Code gating -------------------------------------------------------------
const codeFiles = ["app", "components", "lib"]
  .filter((d) => existsSync(join(ROOT, d)))
  .flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => /\.(ts|tsx)$/.test(f));
// Match the host at a URL or attribute boundary rather than anywhere in the
// text: a bare substring also matches a lookalike such as
// "googletagmanager.com.example.test", which is a different origin.
const GA_HOST_REFERENCE = /(?:^|[/@."'`])googletagmanager\.com(?:[/:"'`]|$)/m;
const gaFiles = codeFiles.filter((f) => GA_HOST_REFERENCE.test(readText(f)));
if (gaFiles.length === 1 && gaFiles[0] === "components/AnalyticsScripts.tsx") {
  const src = readText(gaFiles[0]);
  if (src.includes('consent !== "accepted"') || src.includes('consent === "accepted"'))
    r.ok("GA referenced only in AnalyticsScripts.tsx, behind the consent gate");
  else
    r.fail(
      "AnalyticsScripts.tsx",
      "GA present but no consent gate found",
      'gate script injection on consent === "accepted"',
    );
} else if (gaFiles.length === 0) {
  r.fail(
    "GA loader",
    "no consent-gated GA loader found",
    "keep components/AnalyticsScripts.tsx as the single gated loader",
  );
} else {
  for (const f of gaFiles.filter((x) => x !== "components/AnalyticsScripts.tsx"))
    r.fail(
      f,
      "references Google Analytics outside the gated loader",
      "route all GA loading through components/AnalyticsScripts.tsx",
    );
}

const analyticsLoader = readText("components/AnalyticsScripts.tsx");
const requiredBoundaryMarkers = [
  ["validGaMeasurementId", "validate the GA4 measurement id before use"],
  ["JSON.stringify", "serialize inline-script values with JSON.stringify"],
  ["ga-consent-default", "emit an immediate first-party consent default"],
  ['analytics_storage: "denied"', "default analytics storage to denied"],
  ["ga-disable-", "set the GA disable flag on withdrawal"],
  ['"update",', "send an immediate consent update on every state change"],
  ["CONSENT_CHANGE_EVENT", "listen synchronously for consent withdrawal"],
] as const;
for (const [marker, remediation] of requiredBoundaryMarkers) {
  if (analyticsLoader.includes(marker)) r.ok(`GA boundary contains ${marker}`);
  else r.fail("AnalyticsScripts.tsx", `missing ${marker}`, remediation);
}

const unsupportedLoaderPattern = /_vercel\/insights\/script\.js|va\.vercel-scripts\.com/u;
const unsupportedLoaderFiles = codeFiles.filter((file) =>
  unsupportedLoaderPattern.test(readText(file)),
);
if (unsupportedLoaderFiles.length === 0) {
  r.ok("no Vercel Web Analytics loader without an immediate withdrawal API");
} else {
  for (const file of unsupportedLoaderFiles) {
    r.fail(
      file,
      "loads Vercel Web Analytics without a proven immediate shutdown API",
      "remove the loader until withdrawal can stop the client synchronously",
    );
  }
}

// gtag must not be called outside the analytics lib.
for (const f of codeFiles) {
  if (f.startsWith("lib/analytics/") || f === "components/AnalyticsScripts.tsx") continue;
  if (/\bgtag\s*\(/.test(readText(f)))
    r.fail(f, "direct gtag call", "use lib/analytics/track.ts — it enforces consent and PII rules");
}
r.ok("no scattered direct gtag calls");

r.finish();
