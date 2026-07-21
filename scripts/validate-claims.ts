/**
 * Public claims must trace to product truth:
 *  - PRODUCT_TRUTH.md claims table parses and every row is complete
 *  - no UNVERIFIED / UNDER REVIEW claim is referenced by public surfaces
 *  - every <TruthClaim id="..."> used in app/components exists in the register
 *  - banned phrases (config/content.yaml) do not appear in public copy
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Reporter, readText, loadYaml, walk } from "./lib/util";

const r = new Reporter("validate-claims");

// 1. Parse the claims register ----------------------------------------------
const truth = readText("docs/product/PRODUCT_TRUTH.md");
interface Claim {
  id: string;
  status: string;
}
const claims = new Map<string, Claim>();
const rowRe = /^\|\s*(truth-\d+)\s*\|(.+)\|$/gm;
for (const m of truth.matchAll(rowRe)) {
  const cells = m[0]
    .split("|")
    .map((c) => c.trim())
    .filter((_, i, arr) => i > 0 && i < arr.length - 1);
  // cells: id, claim, status, evidence, owner, last verified, allowed, forbidden
  if (cells.length < 8) {
    r.fail(
      `claim ${m[1]}`,
      `row has ${cells.length}/8 required fields`,
      "complete the row: id, claim, status, evidence, owner, last verified, allowed wording, forbidden wording",
    );
    continue;
  }
  const empty = cells.findIndex((c) => c === "" || c === "—");
  if (empty >= 2) {
    // id/claim caught above; any other empty required cell fails.
    r.fail(`claim ${m[1]}`, `field ${empty + 1} is empty`, "fill every field or remove the claim");
  }
  claims.set(cells[0], { id: cells[0], status: cells[2] });
}
if (claims.size > 0) r.ok(`claims register parsed (${claims.size} claim(s))`);
else
  r.fail(
    "claims register",
    "no claims parsed from PRODUCT_TRUTH.md",
    "keep at least the template example row format intact",
  );

const VALID_STATUS = new Set([
  "LIVE",
  "CONCIERGE",
  "PROTOTYPE",
  "PLANNED",
  "UNDER REVIEW",
  "UNVERIFIED",
]);
for (const c of claims.values()) {
  if (!VALID_STATUS.has(c.status))
    r.fail(
      `claim ${c.id} status`,
      `"${c.status}" is not a valid status`,
      "use LIVE|CONCIERGE|PROTOTYPE|PLANNED|UNDER REVIEW|UNVERIFIED",
    );
}

// 2. TruthClaim usage in public surfaces ------------------------------------
const PUBLIC_DIRS = ["app", "components"].filter((d) => existsSync(join(ROOT, d)));
const publicFiles = PUBLIC_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) =>
  /\.(tsx|ts|mdx?)$/.test(f),
);
let usages = 0;
for (const file of publicFiles) {
  const text = readText(file);
  for (const m of text.matchAll(/TruthClaim[^>]*\bid="([^"]+)"/g)) {
    usages++;
    const claim = claims.get(m[1]);
    if (!claim) {
      r.fail(
        `${file}`,
        `references unknown claim id "${m[1]}"`,
        "add the claim to PRODUCT_TRUTH.md via $product-truth, or fix the id",
      );
    } else if (claim.status === "UNVERIFIED" || claim.status === "UNDER REVIEW") {
      r.fail(
        `${file}`,
        `public surface uses ${claim.status} claim "${m[1]}"`,
        "verify the claim or remove it from the public surface",
      );
    }
  }
}
r.ok(`TruthClaim usages checked (${usages} on public surfaces)`);

// 3. Banned phrases in public copy ------------------------------------------
const content = loadYaml<{ banned_phrases: string[] }>("config/content.yaml");
const COPY_SURFACES = [...publicFiles, "docs/brand/COPY.md"].filter((f) =>
  existsSync(join(ROOT, f)),
);
let bannedHits = 0;
for (const file of COPY_SURFACES) {
  const text = readText(file).toLowerCase();
  for (const phrase of content.banned_phrases) {
    if (text.includes(phrase.toLowerCase())) {
      bannedHits++;
      r.fail(
        `${file}`,
        `contains banned phrase "${phrase}"`,
        "rewrite per config/content.yaml tone rules (or record a decision to unban)",
      );
    }
  }
}
if (bannedHits === 0) r.ok(`no banned phrases across ${COPY_SURFACES.length} public copy surfaces`);

r.finish();
