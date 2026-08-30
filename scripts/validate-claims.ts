/**
 * Public claims must trace to product truth. This is a structural and
 * provenance gate: it checks register completeness, evidence-path existence,
 * status-specific public labels, and forbidden wording. It does not turn local
 * files or passing tests into production/live proof.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, Reporter, loadYaml, readText, walk } from "./lib/util";

export const VALID_CLAIM_STATUSES = new Set([
  "LIVE",
  "CONCIERGE",
  "PROTOTYPE",
  "PLANNED",
  "UNDER REVIEW",
  "UNVERIFIED",
]);

export interface ProductTruthClaim {
  id: string;
  claim: string;
  status: string;
  evidence: string;
  owner: string;
  lastVerified: string;
  allowedWording: string;
  forbiddenWording: string;
}

export interface ParsedClaimsRegister {
  claims: Map<string, ProductTruthClaim>;
  errors: string[];
}

export function parseClaimsRegister(markdown: string): ParsedClaimsRegister {
  const claims = new Map<string, ProductTruthClaim>();
  const errors: string[] = [];
  for (const match of markdown.matchAll(/^\|\s*(truth-\d+)\s*\|(.+)\|\s*$/gm)) {
    const cells = match[0]
      .split("|")
      .map((cell) => cell.trim())
      .slice(1, -1);
    if (cells.length !== 8) {
      errors.push(`${match[1]} has ${cells.length}/8 required fields`);
      continue;
    }
    const [id, claim, status, evidence, owner, lastVerified, allowedWording, forbiddenWording] =
      cells;
    const fields = {
      claim,
      status,
      evidence,
      owner,
      lastVerified,
      allowedWording,
      forbiddenWording,
    };
    for (const [field, value] of Object.entries(fields)) {
      if (!value || value === "—") errors.push(`${id} ${field} is empty`);
    }
    if (claims.has(id)) errors.push(`${id} is duplicated`);
    claims.set(id, {
      id,
      claim,
      status,
      evidence,
      owner,
      lastVerified,
      allowedWording,
      forbiddenWording,
    });
  }
  return { claims, errors };
}

export function claimEvidencePaths(evidence: string): string[] {
  return evidence
    .split(";")
    .map((path) => path.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

export function hasRequiredPublicStatusLabel(status: string, context: string): boolean {
  const normalized = context.toLowerCase();
  if (status === "LIVE") return true;
  if (status === "CONCIERGE")
    return /concierge|human[- ]delivered|delivered by (?:a )?human/.test(normalized);
  if (status === "PROTOTYPE") {
    return /prototype|demo|fixture|mock|synthetic|\blocal(?:ly)?\b|\btested\b|\btests?\b/.test(
      normalized,
    );
  }
  if (status === "PLANNED") {
    return /planned|future|\bwill\b|not (?:yet )?(?:built|connected|available)/.test(normalized);
  }
  return false;
}

function stripWordingSyntax(value: string): string {
  return value
    .replace(/[`“”"]/g, "")
    .replace(/^any claim that\s+/i, "")
    .replace(/\s+claims?$/i, "")
    .trim();
}

export function forbiddenClaimPhrases(value: string): string[] {
  const quoted = [...value.matchAll(/[“"`]([^”"`]{8,})[”"`]/g)].map((match) => match[1]);
  const clauses = value.split(/\s+or\s+|,\s*/i);
  return [...new Set([...quoted, ...clauses].map(stripWordingSyntax))].filter((phrase) => {
    const words = phrase.split(/\s+/).filter(Boolean);
    return phrase.length >= 14 && (words.length >= 2 || phrase.includes("-"));
  });
}

export function occurrenceIsNegated(text: string, offset: number): boolean {
  const prefix = text.slice(Math.max(0, offset - 64), offset).toLowerCase();
  return /(?:\b(?:no|not|never|without|cannot)\b|\b(?:do|does|is|are) not\b)[^.!?\n]{0,48}$/.test(
    prefix,
  );
}

function publicCopyFiles(): string[] {
  const directories = [
    "app",
    "components",
    "docs/public",
    "docs/assets",
    "examples/sample-venture",
    "reports/dogfood/launch-receipt",
  ]
    .filter((directory) => existsSync(join(ROOT, directory)))
    .flatMap((directory) => walk(join(ROOT, directory)))
    .filter((file) => /\.(?:[cm]?[jt]sx?|csv|json|mdx?|svg|txt|ya?ml)$/.test(file));
  return [
    ...new Set(
      [
        ...directories,
        "README.md",
        "NOTICE.md",
        "PROJECT.md",
        "package.json",
        "docs/brand/COPY.md",
        "docs/engineering/STANDARD_SAAS_TOKEN_BENCHMARK_PROTOCOL.md",
        "docs/product/FEATURE_STATUS.md",
        "docs/product/PRODUCT.md",
      ].filter((file) => existsSync(join(ROOT, file))),
    ),
  ].sort();
}

function main(): never {
  const r = new Reporter("validate-claims");
  const truth = readText("docs/product/PRODUCT_TRUTH.md");
  const parsed = parseClaimsRegister(truth);
  for (const error of parsed.errors) {
    r.fail("claims register", error, "complete every unique eight-field PRODUCT_TRUTH row");
  }
  if (parsed.claims.size > 0) r.ok(`claims register parsed (${parsed.claims.size} claim(s))`);
  else r.fail("claims register", "no claims parsed", "restore the PRODUCT_TRUTH claims table");

  const today = new Date().toISOString().slice(0, 10);
  for (const claim of parsed.claims.values()) {
    if (!VALID_CLAIM_STATUSES.has(claim.status)) {
      r.fail(
        `${claim.id} status`,
        `${JSON.stringify(claim.status)} is invalid`,
        "use LIVE|CONCIERGE|PROTOTYPE|PLANNED|UNDER REVIEW|UNVERIFIED",
      );
    }
    const parsedDate = new Date(`${claim.lastVerified}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(claim.lastVerified) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== claim.lastVerified
    ) {
      r.fail(
        `${claim.id} last verified`,
        "date is not valid ISO YYYY-MM-DD",
        "record the actual verification date",
      );
    } else if (claim.lastVerified > today) {
      r.fail(
        `${claim.id} last verified`,
        "date is in the future",
        "record only completed verification",
      );
    }
    const evidencePaths = claimEvidencePaths(claim.evidence);
    if (evidencePaths.length === 0) {
      r.fail(
        `${claim.id} evidence`,
        "no evidence paths",
        "record repository-relative evidence paths",
      );
    }
    for (const path of evidencePaths) {
      if (path.startsWith("/") || path.split("/").includes("..") || !existsSync(join(ROOT, path))) {
        r.fail(
          `${claim.id} evidence`,
          `${JSON.stringify(path)} does not resolve inside the repository`,
          "repair or remove stale evidence references; a prose assertion is not evidence",
        );
      }
    }
  }
  if (parsed.claims.size > 0) r.ok("claim statuses, dates, and evidence paths checked");

  const codeDirectories = ["app", "components"].filter((directory) =>
    existsSync(join(ROOT, directory)),
  );
  const publicCodeFiles = codeDirectories
    .flatMap((directory) => walk(join(ROOT, directory)))
    .filter((file) => /\.(?:tsx?|mdx?)$/.test(file));
  let usages = 0;
  for (const file of publicCodeFiles) {
    const text = readText(file);
    for (const match of text.matchAll(/TruthClaim[^>]*\bid="([^"]+)"/g)) {
      usages++;
      const claim = parsed.claims.get(match[1]);
      if (!claim) {
        r.fail(
          file,
          `references unknown claim id ${JSON.stringify(match[1])}`,
          "add the claim through $product-truth or fix the id",
        );
        continue;
      }
      if (claim.status === "UNVERIFIED" || claim.status === "UNDER REVIEW") {
        r.fail(
          file,
          `public surface uses ${claim.status} claim ${claim.id}`,
          "verify it or remove the public use",
        );
        continue;
      }
      const offset = match.index ?? 0;
      const context = text.slice(Math.max(0, offset - 500), Math.min(text.length, offset + 800));
      if (!hasRequiredPublicStatusLabel(claim.status, context)) {
        r.fail(
          file,
          `${claim.status} claim ${claim.id} lacks a nearby status label`,
          "label prototype/demo/test, concierge/human delivery, or planned/future status visibly",
        );
      }
    }
  }
  r.ok(`TruthClaim usages checked (${usages} on public code surfaces)`);

  const copyFiles = publicCopyFiles();
  const content = loadYaml<{ banned_phrases: string[] }>("config/content.yaml");
  let bannedHits = 0;
  for (const file of copyFiles) {
    const text = readText(file);
    const lower = text.toLowerCase();
    for (const phrase of content.banned_phrases) {
      if (!lower.includes(phrase.toLowerCase())) continue;
      bannedHits++;
      r.fail(
        file,
        `contains banned phrase ${JSON.stringify(phrase)}`,
        "rewrite or record a reviewed content-contract change",
      );
    }
    for (const claim of parsed.claims.values()) {
      for (const phrase of forbiddenClaimPhrases(claim.forbiddenWording)) {
        let offset = lower.indexOf(phrase.toLowerCase());
        while (offset >= 0) {
          if (!occurrenceIsNegated(text, offset)) {
            bannedHits++;
            r.fail(
              file,
              `matches forbidden wording for ${claim.id}: ${JSON.stringify(phrase)}`,
              "remove the overclaim or add production read-back evidence and update PRODUCT_TRUTH first",
            );
          }
          offset = lower.indexOf(phrase.toLowerCase(), offset + phrase.length);
        }
      }
    }
  }
  if (bannedHits === 0) {
    r.ok(
      `no banned or registered forbidden wording across ${copyFiles.length} public copy surfaces`,
    );
  }

  return r.finish();
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) main();
