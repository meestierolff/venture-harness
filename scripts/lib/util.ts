/** Shared helpers for harness scripts. Deterministic, no model calls. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

export const ROOT = process.cwd();

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  ".vercel",
  ".data",
  "coverage",
]);

/** Recursively list files under dir (absolute), returning root-relative paths. */
export function walk(dir: string, ignore: Set<string> = DEFAULT_IGNORE): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (ignore.has(e)) continue;
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else out.push(relative(ROOT, full));
    }
  };
  visit(dir);
  return out;
}

export function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

export function loadYaml<T = unknown>(relPath: string): T {
  return parse(readText(relPath)) as T;
}

/** Uniform check reporting: OK/FAIL lines with exact next actions. */
export class Reporter {
  private failures: string[] = [];
  constructor(private title: string) {
    console.log(`== ${title} ==`);
  }
  ok(check: string): void {
    console.log(`OK   ${check}`);
  }
  fail(check: string, reason: string, next: string): void {
    this.failures.push(check);
    console.log(`FAIL ${check}: ${reason}\n     → ${next}`);
  }
  /** Prints summary; exits non-zero when failures exist. */
  finish(): never {
    if (this.failures.length === 0) {
      console.log(`${this.title}: all checks passed`);
      process.exit(0);
    }
    console.log(`${this.title}: ${this.failures.length} failure(s): ${this.failures.join(", ")}`);
    process.exit(1);
  }
}

/** Parse minimal frontmatter (--- yaml ---) from a markdown string. */
export function parseFrontmatter(
  md: string,
): { data: Record<string, unknown>; body: string } | null {
  if (!md.startsWith("---")) return null;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return null;
  const raw = md.slice(3, end);
  const body = md.slice(md.indexOf("\n", end + 1) + 1);
  try {
    const data = parse(raw) as Record<string, unknown>;
    return { data: data ?? {}, body };
  } catch {
    return null;
  }
}

/** Naive CSV parser for simple export files (no embedded newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const split = (line: string): string[] => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}
