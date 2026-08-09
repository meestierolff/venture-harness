import { request as httpsRequest } from "node:https";
import { Redactor } from "../credentials";
import type { HttpFetcher, HttpRequest, HttpResponse } from "../providers";
import {
  validateProviderUrl,
  type ProviderHostResolver,
  type ValidatedProviderUrl,
} from "../security";

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
  /** Fixture/test seam. Production requests use the DNS-pinned native path. */
  fetch?: typeof globalThis.fetch;
  redactor?: Redactor;
  onRequest?: (metadata: RedactedHttpRequestMetadata) => void;
  maxResponseBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  allowedHosts?: readonly string[];
  resolveHost?: ProviderHostResolver;
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

interface RawHttpResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

function withoutCrossHostSecrets(
  headers: Readonly<Record<string, string>>,
  sensitiveHeaders: readonly string[],
): Readonly<Record<string, string>> {
  const sensitive = new Set([
    ...ALWAYS_SENSITIVE_HEADERS,
    ...sensitiveHeaders.map((name) => name.toLowerCase()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase())),
  );
}

/** Native fetch transport that exposes only redacted request metadata. */
export class NativeHttpFetcher implements HttpFetcher {
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly redactor: Redactor;
  private readonly onRequest?: (metadata: RedactedHttpRequestMetadata) => void;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly timeoutMs: number;
  private readonly allowedHosts?: readonly string[];
  private readonly resolveHost?: ProviderHostResolver;

  constructor(options: NativeHttpFetcherOptions = {}) {
    this.fetchImpl = options.fetch;
    this.redactor = options.redactor ?? new Redactor();
    this.onRequest = options.onRequest;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.allowedHosts = options.allowedHosts;
    this.resolveHost = options.resolveHost;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new Error("Native HTTP response limit is invalid");
    }
    if (!Number.isSafeInteger(this.maxRedirects) || this.maxRedirects < 0) {
      throw new Error("Native HTTP redirect limit is invalid");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Native HTTP timeout is invalid");
    }
  }

  private async requestOnce(
    request: HttpRequest,
    validated: ValidatedProviderUrl,
    headers: Readonly<Record<string, string>>,
    body: string | undefined,
  ): Promise<RawHttpResponse> {
    if (this.fetchImpl) {
      const response = await this.fetchImpl(validated.url, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
        redirect: "manual",
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxResponseBytes) {
        throw new Error(`Provider response exceeded ${this.maxResponseBytes} bytes`);
      }
      return { status: response.status, headers: response.headers, bytes };
    }

    const pinned = validated.addresses[0]!;
    return new Promise<RawHttpResponse>((resolve, reject) => {
      const nativeRequest = httpsRequest(
        validated.url,
        {
          method: request.method,
          headers,
          signal: request.signal,
          lookup: (_hostname, _options, callback) => {
            callback(null, pinned.address, pinned.family);
          },
        },
        (response) => {
          const chunks: Uint8Array[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > this.maxResponseBytes) {
              response.destroy(
                new Error(`Provider response exceeded ${this.maxResponseBytes} bytes`),
              );
              return;
            }
            chunks.push(Uint8Array.from(chunk));
          });
          response.once("error", reject);
          response.once("end", () => {
            const responseHeaderBag = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value))
                value.forEach((entry) => responseHeaderBag.append(name, entry));
              else if (value !== undefined) responseHeaderBag.set(name, String(value));
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: responseHeaderBag,
              bytes: Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
            });
          });
        },
      );
      nativeRequest.setTimeout(this.timeoutMs, () => {
        nativeRequest.destroy(new Error(`Provider request exceeded ${this.timeoutMs}ms`));
      });
      nativeRequest.once("error", reject);
      if (body !== undefined) nativeRequest.write(body);
      nativeRequest.end();
    });
  }

  async fetch(request: HttpRequest): Promise<HttpResponse> {
    let validated = await validateProviderUrl(request.url, {
      allowedHosts: this.allowedHosts,
      resolveHost: this.resolveHost,
    });
    const metadata: RedactedHttpRequestMetadata = {
      method: request.method,
      url: safeUrl(validated.url.href, request.sensitiveUrl, this.redactor),
      headers: safeHeaders(request.headers, request.sensitiveHeaders, this.redactor),
      hasBody: request.body !== undefined,
    };
    this.onRequest?.(metadata);

    let headers = request.headers;
    let requestBody = request.body;
    let response: RawHttpResponse | null = null;
    try {
      for (let redirect = 0; redirect <= this.maxRedirects; redirect++) {
        response = await this.requestOnce(request, validated, headers, requestBody);
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (redirect === this.maxRedirects) throw new Error("Provider redirect limit exceeded");
        if (request.method !== "GET") {
          throw new Error("Provider write redirects are forbidden");
        }
        const location = response.headers.get("location");
        if (!location) throw new Error("Provider redirect omitted its target");
        const next = await validateProviderUrl(new URL(location, validated.url), {
          allowedHosts: this.allowedHosts,
          resolveHost: this.resolveHost,
        });
        if (next.url.hostname !== validated.url.hostname) {
          headers = withoutCrossHostSecrets(headers, request.sensitiveHeaders);
        }
        validated = next;
        requestBody = undefined;
      }
    } catch (error) {
      const reason = this.redactor.redactText(
        error instanceof Error ? error.message : String(error),
      );
      throw new Error(`${request.method} ${metadata.url} failed: ${reason}`);
    }
    if (!response) throw new Error(`${request.method} ${metadata.url} failed without a response`);
    const text = new TextDecoder().decode(response.bytes);
    let parsedBody: unknown;
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text) as unknown;
      } catch {
        parsedBody = text;
      }
    }
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: parsedBody,
    };
  }
}
