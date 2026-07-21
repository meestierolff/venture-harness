/**
 * Verify the agent-adapter contract:
 *  - canonical skills are valid (metadata + required sections)
 *  - generated Codex and Claude copies exactly match expected output
 *  - no generated skill missing, none stale
 *  - AGENTS.md routes every skill; CLAUDE.md maps every skill; no extras
 *  - docs/agents/SKILLS.md indexes every skill
 *  - adapter docs reference commands that exist in package.json
 *  - GEMINI.md and Copilot instructions stay thin pointers (no duplicated
 *    constitution sections)
 */
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { ROOT, Reporter, readText } from "./lib/util";
import {
  actualTree,
  discoverSkills,
  expectedTree,
  missingSections,
  TARGET_DIRS,
  type Target,
} from "./lib/skill-sync";

const r = new Reporter("agent-parity");

// 1. Canonical skill validity ------------------------------------------------
const { skills, issues } = discoverSkills();
for (const skill of skills) {
  const md = readFileSync(join(ROOT, "skills", skill.name, "SKILL.md"), "utf8");
  for (const s of missingSections(md))
    issues.push({ skill: skill.name, problem: `missing section ${s}` });
}
if (issues.length === 0) r.ok("canonical skills valid");
else
  for (const i of issues)
    r.fail(`skill ${i.skill}`, i.problem, "fix skills/<name>/SKILL.md, then pnpm agents:sync");

// 2. Generated copies match --------------------------------------------------
for (const target of Object.keys(TARGET_DIRS) as Target[]) {
  const base = TARGET_DIRS[target];
  const expected = expectedTree(target);
  const actual = actualTree(target);
  let clean = true;
  for (const [rel, content] of expected) {
    if (!actual.has(rel)) {
      clean = false;
      r.fail(
        `${base}/${rel}`,
        "generated copy missing",
        "run pnpm agents:sync and commit the result",
      );
    } else if (actual.get(rel) !== content) {
      clean = false;
      r.fail(
        `${base}/${rel}`,
        "generated copy differs from canonical",
        "run pnpm agents:sync (never edit generated files)",
      );
    }
  }
  for (const rel of actual.keys()) {
    if (!expected.has(rel)) {
      clean = false;
      r.fail(
        `${base}/${rel}`,
        "stale generated file (no canonical source)",
        "run pnpm agents:sync to remove it",
      );
    }
  }
  if (clean) r.ok(`${base} matches canonical skills`);
}

// 3. Routing coverage --------------------------------------------------------
const agentsMd = readText("AGENTS.md");
const claudeMd = readText("CLAUDE.md");
const skillsIndex = readText("docs/agents/SKILLS.md");
for (const skill of skills) {
  if (!agentsMd.includes(`$${skill.name}`))
    r.fail(
      `AGENTS.md routes ${skill.name}`,
      "skill not in routing table",
      `add $${skill.name} to the AGENTS.md skill routing table`,
    );
  if (!claudeMd.includes(`/${skill.name}`))
    r.fail(
      `CLAUDE.md maps ${skill.name}`,
      "skill not in Claude mapping",
      `add $${skill.name} → /${skill.name} to CLAUDE.md`,
    );
  if (!skillsIndex.includes(`skills/${skill.name}/SKILL.md`))
    r.fail(
      `SKILLS.md indexes ${skill.name}`,
      "skill missing from index",
      "add a row to docs/agents/SKILLS.md",
    );
}
// Reverse direction: every routed $skill exists.
const routed = new Set([...agentsMd.matchAll(/\$([a-z0-9-]+)/g)].map((m) => m[1]));
const names = new Set(skills.map((s) => s.name));
for (const routedName of routed) {
  if (!names.has(routedName))
    r.fail(
      `routed skill ${routedName}`,
      "documented in AGENTS.md but skills/ has no such skill",
      `create skills/${routedName}/ or remove the route`,
    );
}
if ([...routed].every((n) => names.has(n)) && skills.every((s) => agentsMd.includes(`$${s.name}`)))
  r.ok("AGENTS.md ↔ skills/ routing is bijective");

// 4. CLAUDE.md must import AGENTS.md and not duplicate it --------------------
if (claudeMd.trimStart().startsWith("@AGENTS.md")) r.ok("CLAUDE.md imports AGENTS.md");
else r.fail("CLAUDE.md import", "does not start with @AGENTS.md", "make @AGENTS.md the first line");
for (const heading of ["## Hard rules", "## Definition of done", "## Skill routing"]) {
  if (claudeMd.includes(heading))
    r.fail(
      "CLAUDE.md thinness",
      `duplicates AGENTS.md section "${heading}"`,
      "remove the duplicated section; CLAUDE.md is an adapter",
    );
}

// 5. Thin adapters reference real commands, no duplicated constitution -------
const pkg = JSON.parse(readText("package.json")) as { scripts: Record<string, string> };
const commands = new Set(Object.keys(pkg.scripts).map((s) => `pnpm ${s}`));
commands.add("pnpm install");
const adapterFiles = ["GEMINI.md", ".github/copilot-instructions.md"];
for (const file of adapterFiles) {
  if (!existsSync(join(ROOT, file))) {
    r.fail(file, "adapter file missing", `create ${file} as a thin pointer to AGENTS.md`);
    continue;
  }
  const text = readText(file);
  const lineCount = text.split("\n").length;
  if (lineCount > 80)
    r.fail(
      `${file} thinness`,
      `${lineCount} lines (max 80 for a thin adapter)`,
      "move content into AGENTS.md/docs and keep the adapter a pointer",
    );
  for (const heading of ["## Hard rules", "## Definition of done", "## Skill routing"]) {
    if (text.includes(heading))
      r.fail(
        `${file} duplication`,
        `contains AGENTS.md section "${heading}"`,
        "adapters must point at AGENTS.md, not restate it",
      );
  }
  const referenced = [...text.matchAll(/pnpm [a-z0-9:-]+/g)].map((m) => m[0]);
  const unknown = referenced.filter((c) => !commands.has(c));
  if (unknown.length > 0)
    r.fail(
      `${file} commands`,
      `references unknown command(s): ${unknown.join(", ")}`,
      "fix the command or add the script to package.json",
    );
  if (!text.includes("AGENTS.md"))
    r.fail(`${file} pointer`, "does not reference AGENTS.md", "point the adapter at AGENTS.md");
}
r.ok("adapters are thin and reference real commands");

r.finish();
