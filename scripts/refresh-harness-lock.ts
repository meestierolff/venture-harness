import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import {
  HARNESS_OWNED_CONFIG_PATHS,
  harnessLockSchema,
  loadHarnessLock,
} from "../lib/config/harness-lock";

const root = resolve(process.cwd());
const existing = loadHarnessLock(join(root, "harness.lock"));
const sourceFlag = process.argv.indexOf("--source-commit");
const sourceCommit =
  (sourceFlag >= 0 ? process.argv[sourceFlag + 1] : undefined) ??
  process.env.VH_REVIEWED_SOURCE_SHA;
if (!sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
  throw new Error(
    "lock:refresh requires --source-commit <reviewed 40-character SHA>; founder-alpha must not claim an unpublished stable release",
  );
}
const resolvedSource = execFileSync("git", ["rev-parse", "--verify", `${sourceCommit}^{commit}`], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
if (resolvedSource !== sourceCommit) {
  throw new Error(`Reviewed source commit did not resolve exactly to ${sourceCommit}`);
}
const roots: Array<{ path: string; ownership: "harness" | "generated" }> = [
  { path: ".github", ownership: "harness" },
  { path: "bin", ownership: "harness" },
  { path: "fixtures", ownership: "harness" },
  { path: "lib", ownership: "harness" },
  { path: "migrations", ownership: "harness" },
  { path: "scripts", ownership: "harness" },
  { path: "skills", ownership: "harness" },
  { path: "tests", ownership: "harness" },
  { path: ".agents/skills", ownership: "generated" },
  { path: ".claude/skills", ownership: "generated" },
];
const rootFiles = [
  ".gitignore",
  "eslint.config.mjs",
  "next.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
];
const harnessConfig = [...HARNESS_OWNED_CONFIG_PATHS];

function filesBelow(path: string): string[] {
  const absolute = join(root, path);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesBelow(child);
    if (entry.isFile()) return [child];
    return [];
  });
}

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(join(root, path)))
    .digest("hex");
}

const managed = [
  ...roots.flatMap(({ path, ownership }) =>
    filesBelow(path).map((file) => ({ path: file, ownership, sha256: sha256(file) })),
  ),
  ...[...rootFiles, ...harnessConfig].map((path) => ({
    path,
    ownership: "harness" as const,
    sha256: sha256(path),
  })),
]
  .map((file) => ({ ...file, path: relative(root, join(root, file.path)) }))
  .sort((a, b) => a.path.localeCompare(b.path));

const lock = harnessLockSchema.parse({
  ...existing,
  source: { kind: "local", ref: sourceCommit },
  managed_files: managed,
});
writeFileSync(
  join(root, "harness.lock"),
  stringify(lock, { lineWidth: 100, sortMapEntries: false }),
  "utf8",
);
console.log(`harness.lock refreshed with ${managed.length} managed file hashes`);
