import { Redactor } from "../credentials";
import type { HttpFetcher, HttpRequest, HttpResponse } from "../providers";

const ALWAYS_SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

export interface RedactedHttpRequestMetadata {
  method: HttpRequest["method"];
  url: string;
  headers: Readonly<Record<string, string>>;
  hasBody: boolean;
}

export interface NativeHttpFetcherOptions {
  fetch?: typeof globalThis.fetch;
  redactor?: Redactor;
  onRequest?: (metadata: RedactedHttpRequestMetadata) => void;
  maxResponseBytes?: number;
}

function safeUrl(url: string, sensitive: boolean, redactor: Redactor): string {
  if (sensitive) {
    try {
      const parsed = new URL(url);
      if (parsed.username) parsed.username = "[REDACTED]";
      if (parsed.password) parsed.password = "[REDACTED]";
      for (const key of [...parsed.searchParams.keys()]) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
      return parsed.toString();
    } catch {
      return "[REDACTED URL]";
    }
  }
  return redactor.redactText(url);
}

function safeHeaders(
  headers: Readonly<Record<string, string>>,
  sensitiveHeaders: readonly string[],
  redactor: Redactor,
): Readonly<Record<string, string>> {
  const sensitive = new Set(sensitiveHeaders.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      sensitive.has(name.toLowerCase()) || ALWAYS_SENSITIVE_HEADERS.has(name.toLowerCase())
        ? "[REDACTED]"
        : redactor.redactText(value),
    ]),
  );
}

function responseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {};
  for (const name of [
    "content-type",
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ]) {
    const value = headers.get(name);
    if (value !== null) safe[name] = value;
  }
  return safe;
}

/** Native fetch transport that exposes only redacted request metadata. */
export class NativeHttpFetcher implements HttpFetcher {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly redactor: Redactor;
  private readonly onRequest?: (metadata: RedactedHttpRequestMetadata) => void;
  private readonly maxResponseBytes: number;

  constructor(options: NativeHttpFetcherOptions = {}) {
    if (!options.fetch && typeof globalThis.fetch !== "function") {
      throw new Error("Native fetch is unavailable in this Node runtime");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.redactor = options.redactor ?? new Redactor();
    this.onRequest = options.onRequest;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  }

  async fetch(request: HttpRequest): Promise<HttpResponse> {
    const metadata: RedactedHttpRequestMetadata = {
      method: request.method,
      url: safeUrl(request.url, request.sensitiveUrl, this.redactor),
      headers: safeHeaders(request.headers, request.sensitiveHeaders, this.redactor),
      hasBody: request.body !== undefined,
    };
    this.onRequest?.(metadata);

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      });
    } catch (error) {
      const reason = this.redactor.redactText(
        error instanceof Error ? error.message : String(error),
      );
      throw new Error(`${request.method} ${metadata.url} failed: ${reason}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) {
      throw new Error(
        `${request.method} ${metadata.url} returned more than ${this.maxResponseBytes} bytes`,
      );
    }
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      body,
    };
  }
}
