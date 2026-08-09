import { isAbsolute, relative, resolve, sep } from "node:path";

export const DEFAULT_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

const MIME_SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = Object.freeze({
  "image/png": (bytes) =>
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    ),
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/gif": (bytes) =>
    ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.slice(0, 6)).toString("ascii")),
  "image/webp": (bytes) =>
    Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP",
  "application/pdf": (bytes) => Buffer.from(bytes.slice(0, 5)).toString("ascii") === "%PDF-",
  "video/mp4": (bytes) => Buffer.from(bytes.slice(4, 8)).toString("ascii") === "ftyp",
  "application/json": (bytes) => {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return true;
    } catch {
      return false;
    }
  },
  "text/plain": (bytes) => {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return !text.includes("\0");
    } catch {
      return false;
    }
  },
});

export interface ValidateUploadInput {
  bytes: Uint8Array;
  declaredMime: string;
  allowedMimes: readonly string[];
  maxBytes?: number;
}

export function validateUpload(
  input: ValidateUploadInput,
): Readonly<{ mime: string; size: number }> {
  const mime = input.declaredMime.toLowerCase().split(";", 1)[0]!.trim();
  const maxBytes = input.maxBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Upload limit is invalid");
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > maxBytes) {
    throw new Error("Upload size is outside the allowed limit");
  }
  if (!input.allowedMimes.includes(mime) || !MIME_SIGNATURES[mime]) {
    throw new Error("Upload MIME type is not allowed");
  }
  if (!MIME_SIGNATURES[mime](input.bytes)) {
    throw new Error("Upload content does not match its declared MIME type");
  }
  return Object.freeze({ mime, size: input.bytes.byteLength });
}

export function safeUploadDestination(rootDirectory: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Upload path is invalid");
  }
  const root = resolve(rootDirectory);
  const destination = resolve(root, relativePath);
  const fromRoot = relative(root, destination);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Upload path escapes its storage root");
  }
  return destination;
}
