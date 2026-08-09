import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import {
  VH_BUILD_PROVENANCE_PATH,
  assertReviewedCoreSourceState,
  buildVhExecutable,
  createVhBuildProvenance,
  loadVhBuildProvenance,
  writeVhBuildProvenance,
} from "./build-vh-executable.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArguments(args) {
  let target;
  let sourceCommit;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--source-commit") {
      if (sourceCommit !== undefined || !args[index + 1] || args[index + 1] === "--") {
        throw new Error("--source-commit requires exactly one full reviewed Git commit SHA");
      }
      sourceCommit = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown workspace build option: ${argument}`);
    if (target !== undefined) throw new Error("workspace build accepts at most one package target");
    target = argument;
  }
  return { target, sourceCommit };
}

function workspaceEntries() {
  const entries = [];
  for (const parent of ["packages", "apps"]) {
    for (const name of readdirSync(resolve(root, parent))) {
      const directory = resolve(root, parent, name);
      if (!statSync(directory).isDirectory()) continue;
      const manifestPath = join(directory, "package.json");
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        entries.push({ directory, manifest, shortName: manifest.name.split("/").at(-1) });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return entries;
}

function sourceFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
    }
  };
  visit(join(directory, "src"));
  return files.sort();
}

function commonJsEntries(entry, outputDirectory) {
  if (!entry.directory.startsWith(resolve(root, "packages"))) return [];
  const exports = entry.manifest.exports ?? {};
  return Object.values(exports).flatMap((conditions) => {
    if (
      conditions === null ||
      Array.isArray(conditions) ||
      typeof conditions !== "object" ||
      typeof conditions.require !== "string" ||
      !conditions.require.startsWith("./dist/") ||
      !conditions.require.endsWith(".cjs")
    ) {
      return [];
    }
    const stem = conditions.require.slice("./dist/".length, -".cjs".length);
    return [
      {
        source: join(entry.directory, "src", `${stem}.ts`),
        output: join(outputDirectory, `${stem}.cjs`),
      },
    ];
  });
}

function installBuild(stagingDirectory, distDirectory) {
  const stagedArtifacts = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) visit(path);
      else stagedArtifacts.push(relative(stagingDirectory, path));
    }
  };
  visit(stagingDirectory);
  mkdirSync(distDirectory, { recursive: true });
  for (const artifact of stagedArtifacts) {
    const destination = join(distDirectory, artifact);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(join(stagingDirectory, artifact), destination);
  }

  const expected = new Set(stagedArtifacts);
  const removeStale = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        removeStale(path);
        if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
      } else if (!expected.has(relative(distDirectory, path))) {
        rmSync(path, { force: true });
      }
    }
  };
  removeStale(distDirectory);
  rmSync(stagingDirectory, { recursive: true, force: true });

  // Keep this assertion close to installation: an interrupted compiler must
  // never replace a previously usable package with an empty entrypoint.
  if (!stagedArtifacts.includes("index.js") || !existsSync(join(distDirectory, "index.js"))) {
    throw new Error(`atomic workspace build did not install ${distDirectory}/index.js`);
  }
}

const entries = workspaceEntries();
const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]));
const ordered = [];
const visiting = new Set();
const visited = new Set();
function visit(entry) {
  if (visited.has(entry.manifest.name)) return;
  if (visiting.has(entry.manifest.name))
    throw new Error(`workspace dependency cycle at ${entry.manifest.name}`);
  visiting.add(entry.manifest.name);
  for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
    const candidate = byName.get(dependency);
    if (candidate) visit(candidate);
  }
  visiting.delete(entry.manifest.name);
  visited.add(entry.manifest.name);
  ordered.push(entry);
}
for (const entry of entries) visit(entry);

const { target, sourceCommit: requestedSourceCommit } = parseArguments(process.argv.slice(2));
let selected = ordered;
if (target) {
  const requested = entries.find(
    (entry) =>
      entry.shortName === target ||
      entry.manifest.name === target ||
      entry.directory.endsWith(`/${target}`),
  );
  if (!requested) throw new Error(`unknown workspace target: ${target}`);
  const needed = new Set();
  const collect = (entry) => {
    if (needed.has(entry.manifest.name)) return;
    needed.add(entry.manifest.name);
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      const candidate = byName.get(dependency);
      if (candidate) collect(candidate);
    }
  };
  collect(requested);
  selected = ordered.filter((entry) => needed.has(entry.manifest.name));
}

const buildsRootCli =
  !target || selected.some(({ manifest }) => manifest.name === "@venture-harness/cli-generator");
if (requestedSourceCommit && !buildsRootCli) {
  throw new Error("--source-commit is valid only when the selected build includes the root CLI");
}
const provenancePath = resolve(root, VH_BUILD_PROVENANCE_PATH);
const reviewedSourceCommit = buildsRootCli
  ? (requestedSourceCommit ?? loadVhBuildProvenance(provenancePath).coreSourceCommit)
  : undefined;
if (reviewedSourceCommit) {
  assertReviewedCoreSourceState({ rootDirectory: root, sourceCommit: reviewedSourceCommit });
}

const tsc = resolve(root, "node_modules/typescript/bin/tsc");
for (const entry of selected) {
  const dist = join(entry.directory, "dist");
  const staging = mkdtempSync(join(entry.directory, ".dist-build-"));
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        "--pretty",
        "false",
        "--declaration",
        "--declarationMap",
        "--sourceMap",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--lib",
        "ES2023,DOM",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--rootDir",
        join(entry.directory, "src"),
        "--outDir",
        staging,
        ...sourceFiles(entry.directory),
      ],
      { cwd: root, stdio: "inherit" },
    );
    for (const commonJsEntry of commonJsEntries(entry, staging)) {
      await bundle({
        entryPoints: [commonJsEntry.source],
        outfile: commonJsEntry.output,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        packages: "external",
        sourcemap: true,
        legalComments: "none",
      });
    }
    installBuild(staging, dist);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  process.stdout.write(`built ${entry.manifest.name}\n`);
}

if (buildsRootCli) {
  const binDirectory = resolve(root, "bin");
  mkdirSync(binDirectory, { recursive: true });
  const stagingDirectory = mkdtempSync(join(binDirectory, ".vh-executable-"));
  try {
    const stagedExecutable = join(stagingDirectory, "vh.mjs");
    const provenance = await buildVhExecutable({
      rootDirectory: root,
      outfile: stagedExecutable,
      sourceCommit: reviewedSourceCommit,
    });
    chmodSync(stagedExecutable, 0o755);
    const recorded = createVhBuildProvenance({
      executable: stagedExecutable,
      packageVersion: provenance.packageVersion,
      sourceCommit: provenance.workflowRefSha,
    });
    renameSync(stagedExecutable, resolve(binDirectory, "vh.mjs"));
    writeVhBuildProvenance(provenancePath, recorded);
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  process.stdout.write(`built venture-harness CLI bundle from Core ${reviewedSourceCommit}\n`);
}
