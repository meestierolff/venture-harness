import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { artifactReferenceSchema } from "../config/contracts";
import { routeLaunch, type FounderBrief } from "../launch";

const selectedContextFileSchema = z
  .object({
    path: artifactReferenceSchema,
    reason: z.string().min(1).max(500),
    estimatedTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const buildContextManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(200),
    nodeId: z.string().min(1).max(200),
    selectedFiles: z.array(selectedContextFileSchema).max(80),
    estimatedTotalTokens: z.number().int().nonnegative().nullable(),
    tokenCap: z.number().int().positive().max(500_000),
    selectionTruncated: z.boolean(),
    omittedFileCount: z.number().int().nonnegative(),
    capabilitiesRequired: z.array(z.string().min(1)).min(1),
    excludedOptionalPacks: z.array(z.string().min(1)).min(1),
    selectionPolicy: z.literal("contract_capability_minimum_v1"),
  })
  .strict();

export type BuildContextManifest = z.infer<typeof buildContextManifestSchema>;

const ALWAYS_SELECTED: Readonly<Record<string, string>> = {
  "config/launch-contract.yaml": "Canonical downstream business and product decisions.",
  "docs/product/PRODUCT_CONSTITUTION.md": "Truth, promise, scope, and model boundaries.",
  "docs/product/PRODUCT_TRUTH.md": "Public claim status and evidence boundary.",
  "PROJECT.md": "Compact venture map and direct verification commands.",
  "AGENTS.md": "Repository-local operating and safety rules.",
  "package.json": "Existing deterministic scripts and exact dependency surface.",
  "skills/design-director/SKILL.md": "Selected product-design method and accessibility rules.",
  "skills/design-director/references/originality-audit.md":
    "Selected anti-template and originality review contract.",
};

const DISCOVERY_SELECTED: Readonly<Record<string, string>> = {
  "config/seo.yaml": "Selected crawlability, ownership, indexing, and structured-data contract.",
  "skills/seo-aeo-engine/SKILL.md": "Selected truthful web-discovery implementation method.",
  "skills/seo-aeo-engine/references/technical-discovery.md":
    "Selected raw-HTML, canonical, sitemap, robots, and structured-data checks.",
};

export const DEFAULT_BUILD_CONTEXT_TOKEN_CAP = 32_000 as const;

const PRODUCT_ROOTS = ["app", "src", "tests/e2e"] as const;
const EXCLUDED_OPTIONAL_PACKS = [
  "Winner Loop",
  "DistributionPR",
  "paid acquisition",
  "Fleet",
  "recursive customer tenancy",
  "customer Provider Connections",
  "customer Agent Grants",
] as const;

function contained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

function regularFileWithinRoot(root: string, reference: string): boolean {
  const absolute = resolve(root, reference);
  if (!contained(root, absolute)) return false;
  const relation = relative(root, absolute);
  let cursor = root;
  for (const component of relation.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    if (!existsSync(cursor)) return false;
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) return false;
    if (cursor === absolute) return metadata.isFile();
    if (!metadata.isDirectory()) return false;
  }
  return false;
}

function regularFiles(root: string, reference: string): string[] {
  const absolute = resolve(root, reference);
  if (!contained(root, absolute) || !existsSync(absolute)) return [];
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) return [];
  if (metadata.isFile()) return [reference];
  if (!metadata.isDirectory()) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) return [];
      const child = `${reference}/${entry.name}`;
      return entry.isDirectory() ? regularFiles(root, child) : entry.isFile() ? [child] : [];
    });
}

function selectedProviderContracts(
  brief: FounderBrief,
  paymentProvider?: string,
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  if (brief.needs.analytics) {
    files["config/analytics.yaml"] = "Selected analytics capability and privacy constraints.";
  }
  if (brief.needs.search_discovery) {
    files["config/seo.yaml"] = "Selected crawlability and discovery contract.";
  }
  if ((paymentProvider ?? (brief.monetization_model !== "none" ? "selected" : "none")) !== "none") {
    files["config/offer.yaml"] = "Selected commerce price and claim boundary.";
  }
  if (brief.app_kind !== "web") {
    files["config/mobile.yaml"] = "Selected native rail contract.";
  }
  return files;
}

export function createBuildContextManifest(input: {
  rootDir: string;
  brief: FounderBrief;
  runId: string;
  nodeId: string;
  tokenCap?: number;
  capabilitiesRequired?: readonly string[];
  paymentProvider?: string;
  requireCanonicalContract?: boolean;
  agentNative?: {
    customerAgentSurfaceRequired: boolean;
    serviceBlueprintRequired: boolean;
  };
}): BuildContextManifest {
  const root = realpathSync(resolve(input.rootDir));
  const discoveryRequired =
    input.brief.needs.search_discovery ||
    input.capabilitiesRequired?.includes("web_seo_aeo_geo") === true;
  const reasons: Record<string, string> = {
    ...ALWAYS_SELECTED,
    ...selectedProviderContracts(input.brief, input.paymentProvider),
    ...(discoveryRequired ? DISCOVERY_SELECTED : {}),
  };
  const requiredPaths = new Set(Object.keys(reasons));
  const canonicalRequiredPaths = [
    "config/launch-contract.yaml",
    "docs/product/PRODUCT_CONSTITUTION.md",
    "PROJECT.md",
    "AGENTS.md",
    "skills/design-director/SKILL.md",
    "skills/design-director/references/originality-audit.md",
    ...(discoveryRequired ? Object.keys(DISCOVERY_SELECTED) : []),
  ];
  if (input.requireCanonicalContract) {
    const missing = canonicalRequiredPaths.filter((path) => !regularFileWithinRoot(root, path));
    if (missing.length > 0) {
      throw new Error(`Required Launch Contract build context is missing: ${missing.join(", ")}`);
    }
  }
  for (const productRoot of PRODUCT_ROOTS) {
    for (const file of regularFiles(root, productRoot)) {
      reasons[file] =
        input.nodeId === "review-product"
          ? "Existing product or primary-journey test selected for independent review."
          : "Existing seed/product surface selected for venture-specific implementation.";
    }
  }
  const candidates = Object.entries(reasons)
    .filter(([path]) => regularFileWithinRoot(root, path))
    .sort(([left], [right]) => {
      const priority = Number(requiredPaths.has(right)) - Number(requiredPaths.has(left));
      return priority || left.localeCompare(right);
    })
    .map(([path, reason]) => {
      const bytes = readFileSync(resolve(root, path)).byteLength;
      return { path, reason, estimatedTokens: Math.ceil(bytes / 4) };
    });
  const tokenCap = input.tokenCap ?? DEFAULT_BUILD_CONTEXT_TOKEN_CAP;
  const requiredTokens = candidates
    .filter(({ path }) => requiredPaths.has(path))
    .reduce((total, candidate) => total + (candidate.estimatedTokens ?? 0), 0);
  if (requiredTokens > tokenCap) {
    throw new Error(
      `Required build context needs approximately ${requiredTokens} tokens, above the ${tokenCap}-token cap`,
    );
  }
  const selectedFiles: typeof candidates = [];
  let estimatedTotalTokens = 0;
  for (const candidate of candidates) {
    const estimate = candidate.estimatedTokens ?? 0;
    if (
      selectedFiles.length >= 80 ||
      (!requiredPaths.has(candidate.path) && estimatedTotalTokens + estimate > tokenCap)
    ) {
      continue;
    }
    selectedFiles.push(candidate);
    estimatedTotalTokens += estimate;
  }
  if (input.requireCanonicalContract) {
    const unselected = canonicalRequiredPaths.filter(
      (path) => !selectedFiles.some((selected) => selected.path === path),
    );
    if (unselected.length > 0) {
      throw new Error(
        `Required Launch Contract build context was not selected as regular files: ${unselected.join(", ")}`,
      );
    }
  }
  const capabilitiesRequired = input.capabilitiesRequired ?? routeLaunch(input.brief).capabilities;
  const excludedOptionalPacks = [
    ...EXCLUDED_OPTIONAL_PACKS,
    ...(input.brief.app_kind === "web" ? ["RevenueCat", "iOS and TestFlight"] : []),
  ].filter((pack) => {
    if (
      input.agentNative?.customerAgentSurfaceRequired &&
      ["customer Provider Connections", "customer Agent Grants"].includes(pack)
    ) {
      return false;
    }
    return !(input.agentNative?.serviceBlueprintRequired && pack === "recursive customer tenancy");
  });
  return buildContextManifestSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    nodeId: input.nodeId,
    selectedFiles,
    estimatedTotalTokens,
    tokenCap,
    selectionTruncated: selectedFiles.length < candidates.length,
    omittedFileCount: candidates.length - selectedFiles.length,
    capabilitiesRequired,
    excludedOptionalPacks,
    selectionPolicy: "contract_capability_minimum_v1",
  });
}
