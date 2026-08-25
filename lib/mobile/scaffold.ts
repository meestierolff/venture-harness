import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { renderMobileTemplates } from "./templates";
import {
  MobileScaffoldError,
  mobileScaffoldManifestSchema,
  mobileScaffoldRequestSchema,
  mobileScaffoldResultSchema,
  type MobileScaffoldManifest,
  type MobileScaffoldRequest,
  type MobileScaffoldResult,
  type MobileScaffoldStack,
} from "./types";

const MANIFEST_NAME = ".venture-scaffold.json";
const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function defaultMobileScaffoldDirectory(stack: MobileScaffoldStack): string {
  return stack === "expo_react_native" ? "mobile/expo" : "mobile/ios";
}

function placeholderBundleIdentifier(ventureId: string): string {
  return `com.example.${ventureId}`;
}

function relativeReference(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function pathInside(root: string, reference: string): string {
  const absolute = resolve(root, reference);
  const rel = relative(root, absolute);
  if (rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep)) {
    return absolute;
  }
  throw new MobileScaffoldError("unsafe_path", `Path escapes repository root: ${reference}`);
}

function assertNoSymlinkBetween(root: string, absolute: string): void {
  const rel = relative(root, absolute);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const status = lstatSync(current);
    if (status.isSymbolicLink()) {
      throw new MobileScaffoldError(
        "unsafe_path",
        `Scaffold path traverses a symbolic link: ${relativeReference(root, current)}`,
      );
    }
  }
}

function ensureDirectory(root: string, absolute: string): void {
  const rel = relative(root, absolute);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current)) {
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new MobileScaffoldError(
          "unsafe_path",
          `Expected a real directory at ${relativeReference(root, current)}.`,
        );
      }
      continue;
    }
    mkdirSync(current, { mode: 0o755 });
  }
}

function readExactFile(root: string, path: string, expected: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new MobileScaffoldError(
        "output_conflict",
        `Refusing to replace non-file scaffold target ${relativeReference(root, path)}.`,
      );
    }
    throw error;
  }
  let actual: string;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new MobileScaffoldError(
        "output_conflict",
        `Refusing to replace non-file scaffold target ${relativeReference(root, path)}.`,
      );
    }
    actual = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (actual !== expected) {
    throw new MobileScaffoldError(
      "output_conflict",
      `Refusing to overwrite existing content at ${relativeReference(root, path)}.`,
    );
  }
  return actual;
}

function writeCreateOnly(root: string, path: string, content: string): "created" | "unchanged" {
  assertNoSymlinkBetween(root, path);
  ensureDirectory(root, dirname(path));
  if (readExactFile(root, path, content) !== null) return "unchanged";

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o644);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    return "created";
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (readExactFile(root, path, content) !== null) return "unchanged";
      throw new MobileScaffoldError(
        "io_failure",
        `A concurrent writer removed ${relativeReference(root, path)} before read-back.`,
      );
    }
    throw new MobileScaffoldError(
      "io_failure",
      `Could not create ${relativeReference(root, path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function generateMobileScaffold(
  rootDirectory: string,
  requestInput: MobileScaffoldRequest,
): MobileScaffoldResult {
  const request = mobileScaffoldRequestSchema.parse(requestInput);
  const root = realpathSync(resolve(rootDirectory));
  if (!lstatSync(root).isDirectory()) {
    throw new MobileScaffoldError("unsafe_path", `Repository root is not a directory: ${root}`);
  }

  const outputDirectory = request.outputDirectory ?? defaultMobileScaffoldDirectory(request.stack);
  const output = pathInside(root, outputDirectory);
  assertNoSymlinkBetween(root, output);

  const bundleIdentifier =
    request.bundleIdentifier ?? placeholderBundleIdentifier(request.ventureId);
  const appScheme = request.appScheme ?? request.ventureId;
  const rendered = renderMobileTemplates(request, bundleIdentifier, appScheme);
  const templateFiles = [...rendered.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const limitations = [
    ...rendered.limitations,
    ...(request.bundleIdentifier
      ? []
      : [
          `The bundle identifier ${bundleIdentifier} is a local placeholder and must be replaced by a reviewed identifier before signing or provider setup.`,
        ]),
  ];
  const manifest = mobileScaffoldManifestSchema.parse({
    schemaVersion: 1,
    generator: "venture-harness/mobile-scaffold",
    templateVersion: "1.0.0",
    stack: request.stack,
    ventureId: request.ventureId,
    displayName: request.displayName,
    outputDirectory,
    identity: {
      bundleIdentifier,
      bundleIdentifierState: request.bundleIdentifier ? "configured" : "local_placeholder",
      appScheme,
      appSchemeState: request.appScheme ? "configured" : "derived",
    },
    files: templateFiles.map((file) => ({
      path: `${outputDirectory}/${file.relativePath}`,
      sha256: sha256(file.content),
    })),
    safeguards: {
      noOverwrite: true,
      credentialsPersisted: false,
      signingMaterialPersisted: false,
      submissionConfigured: false,
    },
    limitations,
  } satisfies MobileScaffoldManifest);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = `${outputDirectory}/${MANIFEST_NAME}`;
  const absoluteManifestPath = pathInside(root, manifestPath);

  if (existsSync(output)) {
    const outputStatus = lstatSync(output);
    if (outputStatus.isSymbolicLink() || !outputStatus.isDirectory()) {
      throw new MobileScaffoldError(
        "output_conflict",
        `Refusing to replace existing scaffold output ${outputDirectory}.`,
      );
    }
    const entries = readdirSync(output);
    if (entries.length > 0 && !existsSync(absoluteManifestPath)) {
      throw new MobileScaffoldError(
        "output_conflict",
        `Refusing to add a scaffold inside existing unowned directory ${outputDirectory}.`,
      );
    }
  }

  if (existsSync(absoluteManifestPath)) {
    readExactFile(root, absoluteManifestPath, manifestContent);
  }
  for (const file of templateFiles) {
    const absolute = pathInside(root, `${outputDirectory}/${file.relativePath}`);
    if (existsSync(absolute)) readExactFile(root, absolute, file.content);
  }

  const createdFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const write = (path: string, content: string) => {
    const absolute = pathInside(root, path);
    const bucket = writeCreateOnly(root, absolute, content);
    (bucket === "created" ? createdFiles : unchangedFiles).push(path);
  };

  write(manifestPath, manifestContent);
  for (const file of templateFiles) write(`${outputDirectory}/${file.relativePath}`, file.content);

  readExactFile(root, absoluteManifestPath, manifestContent);
  for (const file of templateFiles) {
    const absolute = pathInside(root, `${outputDirectory}/${file.relativePath}`);
    const readBack = readExactFile(root, absolute, file.content);
    if (readBack === null || sha256(readBack) !== sha256(file.content)) {
      throw new MobileScaffoldError(
        "io_failure",
        `Hash read-back failed for ${relativeReference(root, absolute)}.`,
      );
    }
  }

  return mobileScaffoldResultSchema.parse({
    manifest,
    manifestPath,
    createdFiles,
    unchangedFiles,
  });
}
