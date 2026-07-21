/**
 * Sync canonical skills (skills/) to agent-specific generated copies:
 *   .agents/skills/  (OpenAI Codex)
 *   .claude/skills/  (Claude Code)
 *
 * Deterministic output; removes stale generated files; reports changed
 * paths; exits non-zero on invalid skill metadata. Generated copies are
 * committed so agents need no build step to discover skills.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./lib/util";
import {
  actualTree,
  discoverSkills,
  expectedTree,
  missingSections,
  TARGET_DIRS,
  type Target,
} from "./lib/skill-sync";
import { readFileSync } from "node:fs";

const { skills, issues } = discoverSkills();

for (const skill of skills) {
  const md = readFileSync(join(ROOT, "skills", skill.name, "SKILL.md"), "utf8");
  for (const section of missingSections(md)) {
    issues.push({ skill: skill.name, problem: `missing required section "${section}"` });
  }
}

if (issues.length > 0) {
  console.error("sync-agent-skills: invalid skill metadata — nothing written.");
  for (const i of issues) console.error(`  ${i.skill}: ${i.problem}`);
  console.error("→ Fix skills/<name>/SKILL.md and rerun pnpm agents:sync");
  process.exit(1);
}

let changed = 0;
for (const target of Object.keys(TARGET_DIRS) as Target[]) {
  const base = TARGET_DIRS[target];
  const expected = expectedTree(target);
  const actual = actualTree(target);

  // Write new/updated files.
  for (const [rel, content] of [...expected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const current = actual.get(rel);
    if (current === content) continue;
    const abs = join(ROOT, base, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    console.log(`${current === undefined ? "created" : "updated"}  ${base}/${rel}`);
    changed++;
  }

  // Remove stale files (and their now-empty parents via rmSync on files only).
  for (const rel of [...actual.keys()].sort()) {
    if (expected.has(rel)) continue;
    const abs = join(ROOT, base, rel);
    if (existsSync(abs)) {
      rmSync(abs);
      console.log(`removed  ${base}/${rel}`);
      changed++;
    }
  }
  // Remove empty directories left behind.
  for (const rel of [...actual.keys()].sort().reverse()) {
    const dir = dirname(join(ROOT, base, rel));
    try {
      rmSync(dir, { recursive: false });
      // rmSync on a non-empty dir throws; empty dirs get removed.
    } catch {
      /* non-empty or already gone — fine */
    }
  }
}

console.log(
  changed === 0
    ? `sync-agent-skills: already in sync (${skills.length} skills, ${Object.keys(TARGET_DIRS).length} targets)`
    : `sync-agent-skills: ${changed} path(s) changed for ${skills.length} skills`,
);
