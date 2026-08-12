/**
 * Persistent founder settings.
 *
 * These are properties of the founder's machine, not of any one venture, so
 * they live beside the credential catalog in the user config directory rather
 * than inside a venture or inside the Core checkout. A founder who re-clones
 * Venture Harness keeps their ventures root.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FounderConfig {
  readonly schemaVersion: 1;
  /** Absolute directory that holds one sibling directory per venture. */
  readonly venturesRoot?: string;
}

export const FOUNDER_CONFIG_KEYS = ["ventures-root"] as const;
export type FounderConfigKey = (typeof FOUNDER_CONFIG_KEYS)[number];

export function defaultFounderConfigPath(
  options: { homeDirectory?: string; xdgConfigHome?: string } = {},
): string {
  const configRoot = options.xdgConfigHome
    ? resolve(options.xdgConfigHome)
    : join(resolve(options.homeDirectory ?? homedir()), ".config");
  return join(configRoot, "venture-harness", "founder.json");
}

export function loadFounderConfig(path = defaultFounderConfigPath()): FounderConfig {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { schemaVersion: 1 };
  const value = JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error("unsupported founder config; expected schemaVersion 1");
  }
  if (value.venturesRoot !== undefined && typeof value.venturesRoot !== "string") {
    throw new Error("founder config venturesRoot must be a string");
  }
  return {
    schemaVersion: 1,
    ...(typeof value.venturesRoot === "string" ? { venturesRoot: value.venturesRoot } : {}),
  };
}

export function saveFounderConfig(config: FounderConfig, path = defaultFounderConfigPath()): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

/**
 * Validate a candidate ventures root and return its canonical path.
 *
 * The root must be explicit and writable, and it must be disentangled from the
 * Venture Harness checkout in both directions: a root inside Core would put
 * independent ventures under Core's version control, and a root containing Core
 * would let venture materialization write over the harness itself.
 */
export function resolveVenturesRoot(candidate: string, options: { coreRoot: string }): string {
  if (!candidate.trim()) {
    throw new Error("ventures-root must be a non-empty absolute path");
  }
  const expanded = candidate.startsWith("~/") ? join(homedir(), candidate.slice(2)) : candidate;
  if (!isAbsolute(expanded)) {
    throw new Error(
      `ventures-root must be an absolute path; received ${candidate}. Next: pass an absolute directory such as ~/Projects/ventures.`,
    );
  }
  const target = resolve(expanded);
  if (existsSync(target)) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `ventures-root must not be a symbolic link; received ${target}. Next: point ventures-root at the real directory.`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(`ventures-root must be a directory; received ${target}`);
    }
  } else {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  // Compare canonical paths so a symlinked ancestor cannot hide containment.
  const canonicalTarget = realpathSync(target);
  const canonicalCore = realpathSync(resolve(options.coreRoot));
  if (contains(canonicalCore, canonicalTarget)) {
    throw new Error(
      `ventures-root must not be inside the Venture Harness repository (${canonicalCore}). ` +
        "Ventures are independent products with their own Git history. " +
        "Next: choose a sibling directory such as ~/Projects/ventures.",
    );
  }
  if (contains(canonicalTarget, canonicalCore)) {
    throw new Error(
      `ventures-root must not contain the Venture Harness repository (${canonicalCore}). ` +
        "Next: choose a directory that holds only ventures, such as ~/Projects/ventures.",
    );
  }
  return canonicalTarget;
}

export const VENTURES_ROOT_UNSET_MESSAGE =
  "No ventures root is configured, so there is no safe directory to materialize an independent venture into.\n" +
  "Next: run vh config set ventures-root <absolute-path> (for example ~/Projects/ventures), or run vh stack connect founder-default.";

/**
 * Resolve where a launch should materialize its venture.
 *
 * Returns undefined only when nothing is configured; callers decide whether
 * that is fatal. A non-interactive launch must treat it as fatal rather than
 * silently writing a venture into the Core checkout.
 */
export function configuredVenturesRoot(options: {
  coreRoot: string;
  configPath?: string;
}): string | undefined {
  const config = loadFounderConfig(options.configPath ?? defaultFounderConfigPath());
  if (!config.venturesRoot) return undefined;
  return resolveVenturesRoot(config.venturesRoot, { coreRoot: options.coreRoot });
}

export function venturePathWithin(venturesRoot: string, slug: string): string {
  const target = resolve(venturesRoot, slug);
  const child = relative(venturesRoot, target);
  if (!child || child.startsWith("..") || child.includes(sep) || isAbsolute(child)) {
    throw new Error(`venture slug ${slug} does not name a direct child of the ventures root`);
  }
  return target;
}

/**
 * Resolve one venture output beneath an already configured ventures root.
 *
 * Lexical containment is not sufficient here: an existing symlink anywhere in
 * the requested path could otherwise redirect materialization or continuation
 * outside the configured root. Missing suffixes are allowed for a new venture,
 * but every existing component must be a real directory that still resolves
 * beneath the canonical root.
 */
export function resolveVentureOutputWithinRoot(venturesRoot: string, output: string): string {
  const canonicalRoot = realpathSync(resolve(venturesRoot));
  const target = resolve(canonicalRoot, output);
  const child = relative(canonicalRoot, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Founder launch output escapes the configured ventures root");
  }

  let cursor = canonicalRoot;
  const parts = child.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Founder launch output must not traverse a symbolic link: ${cursor}. ` +
          "Next: choose a real directory beneath the configured ventures root.",
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        index === parts.length - 1
          ? `Founder launch output must be a directory: ${cursor}`
          : `Founder launch output parent must be a directory: ${cursor}`,
      );
    }
    const canonicalCursor = realpathSync(cursor);
    if (!contains(canonicalRoot, canonicalCursor)) {
      throw new Error("Founder launch output resolves outside the configured ventures root");
    }
  }
  return target;
}
