import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VH_BUILD_PROVENANCE_PATH, verifyVhExecutableBuildParity } from "./build-vh-executable.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entries = [];
for (const parent of ["packages", "apps"]) {
  for (const directoryName of readdirSync(join(root, parent))) {
    const directory = join(root, parent, directoryName);
    if (!statSync(directory).isDirectory() || !existsSync(join(directory, "package.json")))
      continue;
    entries.push({
      parent,
      directory,
      manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
    });
  }
}

const errors = [];
const byName = new Map();
for (const entry of entries) {
  if (byName.has(entry.manifest.name)) errors.push(`duplicate package name ${entry.manifest.name}`);
  byName.set(entry.manifest.name, entry);
  if (!existsSync(join(entry.directory, "src/index.ts")))
    errors.push(`${entry.manifest.name} has no src/index.ts`);
  if (!existsSync(join(entry.directory, "dist/index.js")))
    errors.push(`${entry.manifest.name} has no built dist/index.js`);
  if (!existsSync(join(entry.directory, "dist/index.d.ts")))
    errors.push(`${entry.manifest.name} has no built dist/index.d.ts`);
  if (entry.parent === "packages") {
    const rootExport = entry.manifest.exports?.["."];
    if (!rootExport) {
      errors.push(`${entry.manifest.name} has no explicit root export`);
    } else {
      if (typeof rootExport.import !== "string")
        errors.push(`${entry.manifest.name} has no ESM import export`);
      if (typeof rootExport.require !== "string")
        errors.push(`${entry.manifest.name} has no CommonJS require export`);
      if (typeof rootExport.types !== "string")
        errors.push(`${entry.manifest.name} has no declaration export`);
    }
    for (const [subpath, conditions] of Object.entries(entry.manifest.exports ?? {})) {
      if (conditions === null || Array.isArray(conditions) || typeof conditions !== "object") {
        errors.push(`${entry.manifest.name} export ${subpath} must use explicit conditions`);
        continue;
      }
      for (const condition of ["types", "import", "require"]) {
        const target = conditions[condition];
        if (typeof target !== "string") {
          errors.push(`${entry.manifest.name} export ${subpath} has no ${condition} target`);
          continue;
        }
        if (!existsSync(join(entry.directory, target))) {
          errors.push(`${entry.manifest.name} export ${subpath} ${condition} target is missing`);
        }
      }
    }
    if (JSON.stringify(entry.manifest.files) !== JSON.stringify(["dist"]))
      errors.push(`${entry.manifest.name} pack allowlist must be [dist]`);
  }
}

for (const entry of entries) {
  const source = readdirSync(join(entry.directory, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(entry.directory, "src", name), "utf8"))
    .join("\n");
  const imports = [...source.matchAll(/from\s+["'](@venture-harness\/[^"']+)["']/g)].map(
    (match) => match[1],
  );
  for (const imported of new Set(imports)) {
    if (!byName.has(imported))
      errors.push(`${entry.manifest.name} imports unknown workspace package ${imported}`);
    if (!entry.manifest.dependencies?.[imported])
      errors.push(`${entry.manifest.name} does not declare ${imported}`);
  }
  for (const [dependency, version] of Object.entries(entry.manifest.dependencies ?? {})) {
    if (dependency.startsWith("@venture-harness/") && version !== "workspace:*") {
      errors.push(`${entry.manifest.name} must pin ${dependency} through workspace:*`);
    }
    if (entry.parent === "packages" && dependency.startsWith("@venture-harness/app-")) {
      errors.push(`${entry.manifest.name} reverses dependency direction into an app`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(name, stack = []) {
  if (visiting.has(name)) {
    errors.push(`dependency cycle: ${[...stack, name].join(" -> ")}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  const entry = byName.get(name);
  for (const dependency of Object.keys(entry?.manifest.dependencies ?? {})) {
    if (byName.has(dependency)) visit(dependency, [...stack, name]);
  }
  visiting.delete(name);
  visited.add(name);
}
for (const name of byName.keys()) visit(name);

const requiredPackages = [
  "core",
  "config",
  "command-bus",
  "events",
  "audit",
  "assets",
  "credentials",
  "policy",
  "organizations",
  "billing",
  "entitlements",
  "connections",
  "provider-sdk",
  "provider-registry",
  "orchestrator",
  "workflow-backend-local",
  "agent-runtime",
  "agent-gateway",
  "api-generator",
  "cli-generator",
  "mcp-generator",
  "sdk-generator",
  "pack-runtime",
  "seed-runtime",
  "upgrades",
  "migrations",
  "loops",
  "evaluations",
  "telemetry",
  "ui",
];
for (const name of requiredPackages) {
  if (!byName.has(`@venture-harness/${name}`)) errors.push(`required package missing: ${name}`);
}
for (const name of ["control-plane", "api", "worker", "docs", "fleet-controller"]) {
  if (!byName.has(`@venture-harness/app-${name}`)) errors.push(`required app missing: ${name}`);
}

const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!rootManifest.files?.includes("bin/vh.mjs"))
  errors.push("root package does not allowlist bin/vh.mjs");
if (!rootManifest.files?.includes(VH_BUILD_PROVENANCE_PATH))
  errors.push(`root package does not allowlist ${VH_BUILD_PROVENANCE_PATH}`);
if (!existsSync(join(root, "bin/vh.mjs"))) errors.push("built vh executable is missing");
if (!existsSync(join(root, VH_BUILD_PROVENANCE_PATH)))
  errors.push(`built vh provenance is missing: ${VH_BUILD_PROVENANCE_PATH}`);

let generatedParity;
if (existsSync(join(root, "bin/vh.mjs")) && existsSync(join(root, VH_BUILD_PROVENANCE_PATH))) {
  try {
    generatedParity = await verifyVhExecutableBuildParity({ rootDirectory: root });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      packages: requiredPackages.length,
      apps: 5,
      cycles: 0,
      vhGeneratedParity: generatedParity,
    })}\n`,
  );
}
