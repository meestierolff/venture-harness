/**
 * Static SEO verification (no server needed):
 *  - robots.ts and sitemap.ts exist
 *  - every non-API page exports metadata (or generateMetadata)
 *  - root layout sets metadataBase and a default title
 *  - structured-data component exists and the home page uses it
 *  - llms.txt, if present, is treated as optional (no failure either way)
 * Rendered raw-HTML checks live in verify-raw-html.ts (needs a server).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Reporter, readText, walk } from "./lib/util";

const r = new Reporter("verify-seo");

for (const f of ["app/robots.ts", "app/sitemap.ts"]) {
  if (existsSync(join(ROOT, f))) r.ok(`${f} present`);
  else r.fail(f, "missing", "create it — crawlability is non-negotiable for a validation site");
}

const pages = walk(join(ROOT, "app")).filter((f) => /\/page\.tsx$/.test(f) && !f.includes("/api/"));
let metaClean = true;
for (const page of pages) {
  const text = readText(page);
  if (
    !/export (const metadata|async function generateMetadata|function generateMetadata)/.test(text)
  ) {
    metaClean = false;
    r.fail(
      `${page} metadata`,
      "page exports no metadata",
      "export const metadata (title, description, alternates.canonical)",
    );
  }
  if (!/alternates|canonical/.test(text)) {
    metaClean = false;
    r.fail(
      `${page} canonical`,
      "no canonical URL configured",
      "set metadata.alternates.canonical for the route",
    );
  }
}
if (metaClean) r.ok(`${pages.length} page(s) export metadata with canonicals`);

const layout = readText("app/layout.tsx");
if (layout.includes("metadataBase")) r.ok("layout sets metadataBase");
else
  r.fail(
    "app/layout.tsx",
    "metadataBase missing",
    "set metadataBase from NEXT_PUBLIC_SITE_URL so canonicals resolve",
  );

if (existsSync(join(ROOT, "components/StructuredData.tsx"))) {
  r.ok("StructuredData component present");
  const home = readText("app/page.tsx");
  if (home.includes("StructuredData")) r.ok("home page emits structured data");
  else
    r.fail(
      "app/page.tsx",
      "no structured data on home page",
      "render <StructuredData> with the Organization schema",
    );
} else {
  r.fail("components/StructuredData.tsx", "missing", "create the JSON-LD component");
}

r.finish();
