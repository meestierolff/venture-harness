import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputFlag = process.argv.indexOf("--output");
const output =
  outputFlag >= 0
    ? resolve(process.argv[outputFlag + 1])
    : mkdtempSync(join(tmpdir(), "vh-workspace-pack-"));

execFileSync(process.execPath, [resolve(root, "scripts/workspace-build.mjs")], {
  cwd: root,
  stdio: "inherit",
});
execFileSync(process.execPath, [resolve(root, "scripts/workspace-check.mjs")], {
  cwd: root,
  stdio: "inherit",
});

const packed = [];
function pack(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  execFileSync("pnpm", ["pack", "--pack-destination", output], { cwd: directory, stdio: "pipe" });
  const prefix = `${manifest.name.replace("@venture-harness/", "venture-harness-")}-${manifest.version}`;
  const artifact = readdirSync(output).find(
    (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
  );
  if (!artifact) throw new Error(`pack artifact missing for ${manifest.name}`);
  packed.push({ name: manifest.name, path: join(output, artifact) });
}

pack(root);
for (const name of readdirSync(join(root, "packages")).sort()) {
  const directory = join(root, "packages", name);
  if (statSync(directory).isDirectory()) pack(directory);
}
process.stdout.write(`${JSON.stringify({ output, packed }, null, 2)}\n`);
