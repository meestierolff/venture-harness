export type BoundedJsonError = "invalid_content_length" | "invalid_json" | "payload_too_large";

export type BoundedJsonResult =
  { ok: true; value: unknown } | { ok: false; error: BoundedJsonError };

export type PublicJsonRequestError = "cross_origin" | "unsupported_media_type";

export type PublicJsonRequestResult = { ok: true } | { ok: false; error: PublicJsonRequestError };

/**
 * Validate the browser-facing JSON request boundary before reading a byte of
 * the body. Non-browser clients may omit Origin, but a supplied Origin must be
 * the exact request origin. Requiring application/json also keeps these routes
 * behind the browser's CORS preflight boundary.
 */
export function validatePublicJsonRequest(request: Request): PublicJsonRequestResult {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, error: "unsupported_media_type" };
  }

  const suppliedOrigin = request.headers.get("origin");
  if (suppliedOrigin === null) return { ok: true };

  try {
    const origin = new URL(suppliedOrigin);
    const requestOrigin = new URL(request.url).origin;
    if (
      suppliedOrigin !== origin.origin ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.origin !== requestOrigin
    ) {
      return { ok: false, error: "cross_origin" };
    }
  } catch {
    return { ok: false, error: "cross_origin" };
  }

  return { ok: true };
}

function contentLengthExceedsLimit(value: string, maxBytes: number): boolean | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  return BigInt(value) > BigInt(maxBytes);
}

/**
 * Read and decode a JSON request without ever buffering more than maxBytes.
 * Content-Length is only an early refusal; the streamed byte count remains
 * authoritative because clients and intermediaries can omit or misstate it.
 */
export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<BoundedJsonResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const exceedsLimit = contentLengthExceedsLimit(declaredLength, maxBytes);
    if (exceedsLimit === null) return { ok: false, error: "invalid_content_length" };
    if (exceedsLimit) return { ok: false, error: "payload_too_large" };
  }

  if (!request.body) return { ok: false, error: "invalid_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (byteLength + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: "payload_too_large" };
      }
      byteLength += value.byteLength;
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}
