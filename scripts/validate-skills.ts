/**
 * Validate canonical skills: frontmatter, naming, descriptions, required
 * sections, and Codex metadata files. Faster subset of agents:check for
 * use while editing skills.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT, Reporter } from "./lib/util";
import { discoverSkills, missingSections } from "./lib/skill-sync";

const r = new Reporter("validate-skills");
const { skills, issues } = discoverSkills();

if (skills.length === 0)
  r.fail("skills present", "no skills found", "skills/ must contain skill directories");

for (const i of issues) r.fail(`skill ${i.skill}`, i.problem, "fix the skill and rerun");

for (const skill of skills) {
  const md = readFileSync(join(ROOT, "skills", skill.name, "SKILL.md"), "utf8");
  const missing = missingSections(md);
  if (missing.length > 0) {
    r.fail(
      `${skill.name} sections`,
      `missing: ${missing.join(", ")}`,
      "add the required sections to SKILL.md",
    );
  }
  // Codex metadata: required for every skill, must agree with frontmatter.
  const metaPath = join(ROOT, "skills", skill.name, "agents/openai.yaml");
  if (!existsSync(metaPath)) {
    r.fail(
      `${skill.name} codex metadata`,
      "agents/openai.yaml missing",
      "add Codex metadata (name, description, entrypoint)",
    );
  } else {
    const meta = parse(readFileSync(metaPath, "utf8")) as { name?: string; entrypoint?: string };
    if (meta.name !== skill.name)
      r.fail(
        `${skill.name} codex metadata`,
        `name "${meta.name}" != skill name`,
        "align agents/openai.yaml name with the directory",
      );
    if (meta.entrypoint !== "SKILL.md")
      r.fail(
        `${skill.name} codex metadata`,
        "entrypoint must be SKILL.md",
        "set entrypoint: SKILL.md",
      );
  }
  // Skills must not embed current venture state.
  if (/config\/venture\.yaml.+launch_date:\s*20/.test(md))
    r.fail(
      `${skill.name} state leak`,
      "contains concrete venture state",
      "skills are procedures; state lives in docs/ and config/",
    );
}

if (issues.length === 0) r.ok(`${skills.length} skills structurally valid`);
r.finish();
