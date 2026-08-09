import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ProviderHostResolver = (hostname: string) => Promise<readonly string[]>;

export const OFFICIAL_PROVIDER_HTTP_HOSTS = Object.freeze([
  "analyticsadmin.googleapis.com",
  "analyticsdata.googleapis.com",
  "api.appstoreconnect.apple.com",
  "api.brevo.com",
  "api.revenuecat.com",
  "api.stripe.com",
  "app.revenuecat.com",
  "appstoreconnect.apple.com",
  "mijn.mijndomein.nl",
  "searchconsole.googleapis.com",
  "ssl.bing.com",
  "vercel.com",
  "www.googleapis.com",
] as const);

function parseIpv4(address: string): readonly number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function parseIpv6(address: string): readonly number[] | null {
  let candidate = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (candidate.includes("%") || (candidate.match(/::/g) ?? []).length > 1) return null;
  const ipv4Tail = candidate.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4Tail) {
    const octets = parseIpv4(ipv4Tail);
    if (!octets) return null;
    candidate =
      candidate.slice(0, -ipv4Tail.length) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
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

export function isPublicInternetAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a! >= 224
    );
  }
  const ipv6 = parseIpv6(address);
  if (!ipv6) return false;
  const [first = 0, second = 0] = ipv6;
  if (ipv6.every((group) => group === 0)) return false;
  if (ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x0100 && second === 0) return false;
  if (first === 0x0064 && second === 0xff9b) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  if (first === 0x2001 && (second === 0 || second === 0x0db8)) return false;
  if (first === 0x2001 && second >= 0x0020 && second <= 0x002f) return false;
  if (ipv6.slice(0, 5).every((group) => group === 0) && [0, 0xffff].includes(ipv6[5]!)) {
    const embedded = [ipv6[6]! >> 8, ipv6[6]! & 0xff, ipv6[7]! >> 8, ipv6[7]! & 0xff].join(".");
    return isPublicInternetAddress(embedded);
  }
  return true;
}

const systemResolver: ProviderHostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);

export interface ProviderUrlPolicy {
  allowedHosts?: readonly string[];
  resolveHost?: ProviderHostResolver;
}

export interface ValidatedProviderUrl {
  url: URL;
  addresses: readonly { address: string; family: 4 | 6 }[];
}

/**
 * Validate a provider URL before transport. Host matching is exact, every DNS
 * answer must be public, and the returned addresses are the only addresses a
 * production transport may use for this request.
 */
export async function validateProviderUrl(
  raw: string | URL,
  policy: ProviderUrlPolicy = {},
): Promise<ValidatedProviderUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Provider URL must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("Provider URL must use HTTPS");
  if (url.username || url.password) throw new Error("Provider URL must not contain credentials");
  if (url.hash) throw new Error("Provider URL must not contain a fragment");
  if (url.port && url.port !== "443") throw new Error("Provider URL must use the HTTPS port");
  const hostname = url.hostname.toLowerCase();
  const allowed = new Set(
    (policy.allowedHosts ?? OFFICIAL_PROVIDER_HTTP_HOSTS).map((host) => host.toLowerCase()),
  );
  if (!allowed.has(hostname)) throw new Error("Provider URL host is not allowlisted");
  if (isIP(hostname)) throw new Error("Provider URL must use an allowlisted DNS hostname");
  const resolved = await (policy.resolveHost ?? systemResolver)(hostname);
  if (resolved.length === 0) throw new Error("Provider URL resolved to no addresses");
  const unique = [...new Set(resolved)];
  const addresses = unique.map((address) => {
    const family = isIP(address);
    if ((family !== 4 && family !== 6) || !isPublicInternetAddress(address)) {
      throw new Error("Provider URL resolved to a non-public address");
    }
    return { address, family } as const;
  });
  return Object.freeze({ url, addresses: Object.freeze(addresses) });
}
