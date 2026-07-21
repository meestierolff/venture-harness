/**
 * Validate that relative markdown links resolve to existing files.
 * External links (http/https/mailto) and pure anchors are skipped.
 * Generated skill copies are skipped (checked at their canonical source).
 */
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { ROOT, Reporter, readText, walk } from "./lib/util";

const r = new Reporter("validate-links");

const SKIP_PREFIXES = [".agents/", ".claude/skills/", "node_modules/", ".next/"];
const files = walk(ROOT).filter(
  (f) => f.endsWith(".md") && !SKIP_PREFIXES.some((p) => f.startsWith(p)),
);

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let broken = 0;
let total = 0;

for (const file of files) {
  const text = readText(file);
  for (const match of text.matchAll(LINK_RE)) {
    const target = match[1];
    if (/^(https?:|mailto:|#|tel:)/.test(target)) continue;
    total++;
    const clean = target.split("#")[0];
    if (clean === "") continue;
    // Links may be repo-root-relative (leading /) or file-relative.
    const resolved = clean.startsWith("/")
      ? join(ROOT, clean)
      : normalize(join(ROOT, dirname(file), clean));
    if (!existsSync(resolved)) {
      broken++;
      r.fail(`${file}`, `broken link → ${target}`, "fix the path or create the target");
    }
  }
}

if (broken === 0) r.ok(`${total} relative links resolve across ${files.length} markdown files`);
r.finish();
