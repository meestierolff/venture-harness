/**
 * Raw crawler verification against a RUNNING site (build + start, or a
 * deployed URL). Fetches key routes with three user agents and asserts the
 * server-rendered HTML before JavaScript runs.
 *
 * The crawler validates every initial and redirected URL. Loopback is allowed
 * only for the internally started quality-profile server or the default local
 * invocation; private, link-local, metadata, multicast, and credential-bearing
 * targets fail closed.
 *
 *   pnpm verify:raw-html
 *   pnpm verify:raw-html -- --url https://example.com
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Reporter } from "./lib/util";

const urlFlag = process.argv.indexOf("--url");
const BASE = urlFlag !== -1 ? process.argv[urlFlag + 1] : "http://localhost:3000";
const ALLOW_LOOPBACK = process.argv.includes("--allow-loopback") || urlFlag === -1;

const USER_AGENTS: Record<string, string> = {
  browser:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "googlebot-like": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "bingbot-like": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
};

const ROUTES: { path: string; expectPrice: boolean }[] = [{ path: "/", expectPrice: false }];

export type AuditHostResolver = (hostname: string) => Promise<string[]>;

export interface AuditUrlOptions {
  allowLoopback?: boolean;
  resolveHost?: AuditHostResolver;
}

export interface AuditFetchOptions extends AuditUrlOptions {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function parseIpv6(address: string): number[] | null {
  let candidate = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (candidate.includes("%") || (candidate.match(/::/g) ?? []).length > 1) return null;
  const ipv4Tail = candidate.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4Tail) {
    const octets = parseIpv4(ipv4Tail);
    if (!octets) return null;
    candidate =
      candidate.slice(0, -ipv4Tail.length) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [leftRaw, rightRaw] = candidate.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = candidate.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (
    groups.length !== 8 ||
    missing < 0 ||
    groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

export function isLoopbackAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) return ipv4[0] === 127;
  const ipv6 = parseIpv6(address);
  if (!ipv6) return false;
  if (ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1) return true;
  const embedded =
    ipv6.slice(0, 5).every((group) => group === 0) && (ipv6[5] === 0 || ipv6[5] === 0xffff)
      ? [ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff].join(".")
      : null;
  return embedded ? isLoopbackAddress(embedded) : false;
}

export function isNonPublicAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const ipv6 = parseIpv6(address);
  if (!ipv6) return true;
  if (ipv6.every((group) => group === 0) || isLoopbackAddress(address)) return true;
  const [first, second] = ipv6;
  if ((first & 0xfe00) === 0xfc00) return true; // unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x0100 && second === 0) return true; // discard-only
  if (first === 0x0064 && second === 0xff9b) return true; // NAT64 translation
  if (first === 0x2002) return true; // 6to4 can conceal an IPv4 target
  if (first === 0x2001 && (second === 0 || second === 0x0db8)) return true;
  if (first === 0x2001 && second >= 0x0020 && second <= 0x002f) return true; // ORCHID
  if (first === 0x3fff) return true; // documentation range
  if (ipv6.slice(0, 5).every((group) => group === 0) && [0, 0xffff].includes(ipv6[5])) {
    const embedded = [ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff].join(".");
    return isNonPublicAddress(embedded);
  }
  return false;
}

const systemResolver: AuditHostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export async function validateAuditUrl(raw: string, options: AuditUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Audit URL must be an absolute HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("Audit URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) throw new Error("Audit URL must not contain credentials.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "metadata.google.internal" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    if (!(options.allowLoopback && (hostname === "localhost" || hostname.endsWith(".localhost")))) {
      throw new Error("Audit URL resolves through a non-public hostname.");
    }
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await (options.resolveHost ?? systemResolver)(hostname);
  if (addresses.length === 0) throw new Error("Audit URL hostname resolved to no addresses.");
  for (const address of addresses) {
    if (isNonPublicAddress(address) && !(options.allowLoopback && isLoopbackAddress(address))) {
      throw new Error("Audit URL resolves to a non-public network address.");
    }
  }
  return url;
}

export async function fetchWithValidatedRedirects(
  raw: string,
  init: RequestInit = {},
  options: AuditFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  let current = await validateAuditUrl(raw, options);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect response has no Location header.");
    if (redirects === maxRedirects) throw new Error("Audit URL exceeded the redirect limit.");
    const next = await validateAuditUrl(new URL(location, current).href, options);
    if (current.protocol === "https:" && next.protocol !== "https:") {
      throw new Error("Audit URL redirect attempted to downgrade HTTPS.");
    }
    await response.body?.cancel();
    current = next;
  }
  throw new Error("Audit URL exceeded the redirect limit.");
}

/** Semantic core-content check: require a server-rendered main region with a
 * real content element. It deliberately avoids a word-count threshold; a
 * concise product can be complete and a long page can still be empty filler. */
export function hasServerRenderedCoreContent(html: string): boolean {
  const main = html.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) return false;
  const withoutNonContent = main
    .replace(/<(script|style|template)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
  return [
    ...withoutNonContent.matchAll(
      /<(p|section|article|ul|ol|dl|table|form)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
    ),
  ].some((match) => /[\p{L}\p{N}]/u.test(match[2].replace(/<[^>]+>/g, " ")));
}

async function main() {
  const r = new Reporter("verify-raw-html");
  let validatedBase: URL;
  try {
    validatedBase = await validateAuditUrl(BASE, { allowLoopback: ALLOW_LOOPBACK });
  } catch (error) {
    r.fail(
      "audit URL",
      String(error),
      "use a public HTTP(S) URL without credentials or private targets",
    );
    return r.finish();
  }

  try {
    const response = await fetchWithValidatedRedirects(
      validatedBase.href,
      {},
      {
        allowLoopback: ALLOW_LOOPBACK,
      },
    );
    await response.body?.cancel();
  } catch {
    console.log(`SKIP verify-raw-html: no server reachable at ${validatedBase.origin}`);
    console.log("→ run: pnpm build && pnpm start   (then rerun) — or pass --url <deployed site>");
    process.exit(2);
  }

  for (const route of ROUTES) {
    for (const [uaName, ua] of Object.entries(USER_AGENTS)) {
      const label = `${route.path} [${uaName}]`;
      let html: string;
      try {
        const res = await fetchWithValidatedRedirects(
          new URL(route.path, validatedBase).href,
          { headers: { "user-agent": ua } },
          { allowLoopback: ALLOW_LOOPBACK },
        );
        if (!res.ok) {
          r.fail(label, `HTTP ${res.status}`, "fix the route or the server");
          continue;
        }
        html = await res.text();
      } catch (error) {
        r.fail(label, `fetch failed: ${String(error)}`, "check the URL boundary and server logs");
        continue;
      }
      const checks: [string, boolean, string][] = [
        ["title", /<title>[^<]{3,}<\/title>/.test(html), "add a real <title>"],
        ["canonical", /<link[^>]+rel="canonical"/.test(html), "emit metadata.alternates.canonical"],
        ["h1", /<h1[\s>]/.test(html), "server-render exactly one H1"],
        [
          "core content",
          hasServerRenderedCoreContent(html),
          "server-render a semantic <main> with a real content element",
        ],
        ["internal links", /<a[^>]+href="\//.test(html), "server-render internal links"],
        ["structured data", /application\/ld\+json/.test(html), "render <StructuredData> JSON-LD"],
      ];
      if (route.expectPrice) {
        checks.push([
          "price text",
          /(€|EUR|\$|USD|£|GBP)\s?\d|price/i.test(html.replace(/<[^>]+>/g, " ")),
          "render plain-HTML price facts on pricing routes",
        ]);
      }
      const failed = checks.filter(([, okFlag]) => !okFlag);
      if (failed.length === 0) r.ok(label);
      else {
        for (const [what, , next] of failed) {
          r.fail(`${label} ${what}`, "missing in raw HTML", next);
        }
      }
    }
  }
  r.finish();
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) void main();
