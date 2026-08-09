import type { CredentialReference, CredentialTester } from "../credentials";
import type { FounderStackConnection } from "../founder-launch";
import type { HttpFetcher, HttpRequest } from "../providers";

interface Probe {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly sensitiveHeaders: readonly string[];
  readonly sensitiveUrl?: boolean;
  readonly validate?: (body: unknown) => boolean;
  readonly accountId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = record(value)?.[key];
  return typeof field === "string" || typeof field === "number" ? String(field) : null;
}

function targetFor(connection: FounderStackConnection | null, provider: string): string | null {
  if (!connection) return null;
  if (provider === "neon") {
    const role = connection.roles["database.postgres"];
    return role.organizationId ?? role.accountId ?? null;
  }
  if (provider === "stripe") return connection.roles["commerce.web"].accountId ?? null;
  if (provider === "revenuecat") {
    const role = connection.roles["commerce.native"];
    return role.organizationId ?? role.accountId ?? null;
  }
  if (provider === "brevo") return connection.roles["email.transactional"].accountId ?? null;
  if (provider === "google") {
    return (
      connection.launchDefaults.google.analyticsAccountId ??
      connection.roles["growth.google"].accountId ??
      null
    );
  }
  return null;
}

function bearer(secret: string): Readonly<Record<string, string>> {
  return { Authorization: `Bearer ${secret}` };
}

function probeFor(
  provider: string,
  secret: string,
  connection: FounderStackConnection | null,
): Probe | null {
  const target = targetFor(connection, provider);
  if (provider === "neon") {
    return target
      ? {
          url: `https://console.neon.tech/api/v2/projects?limit=1&org_id=${encodeURIComponent(target)}`,
          headers: bearer(secret),
          sensitiveHeaders: ["Authorization"],
          accountId: target,
        }
      : {
          url: "https://console.neon.tech/api/v2/users/me",
          headers: bearer(secret),
          sensitiveHeaders: ["Authorization"],
        };
  }
  if (provider === "stripe") {
    return {
      url: "https://api.stripe.com/v1/account",
      headers: { Authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}` },
      sensitiveHeaders: ["Authorization"],
      ...(target
        ? { accountId: target, validate: (body: unknown) => stringField(body, "id") === target }
        : {}),
    };
  }
  if (provider === "revenuecat") {
    return {
      url: target
        ? `https://api.revenuecat.com/v2/projects/${encodeURIComponent(target)}/apps?limit=1`
        : "https://api.revenuecat.com/v2/projects?limit=1",
      headers: bearer(secret),
      sensitiveHeaders: ["Authorization"],
      ...(target ? { accountId: target } : {}),
    };
  }
  if (provider === "brevo") {
    return {
      url: "https://api.brevo.com/v3/account",
      headers: { "api-key": secret },
      sensitiveHeaders: ["api-key"],
      ...(target
        ? {
            accountId: target,
            validate: (body: unknown) =>
              [stringField(body, "organization_id"), stringField(body, "user_id")].includes(target),
          }
        : {}),
    };
  }
  if (provider === "google") {
    return {
      url: "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
      headers: bearer(secret),
      sensitiveHeaders: ["Authorization"],
      ...(target
        ? {
            accountId: target,
            validate: (body: unknown) => {
              const summaries = record(body)?.accountSummaries;
              return (
                Array.isArray(summaries) &&
                summaries.some(
                  (summary) => stringField(summary, "account") === `accounts/${target}`,
                )
              );
            },
          }
        : {}),
    };
  }
  if (provider === "bing") {
    return {
      url: `https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(secret)}`,
      headers: {},
      sensitiveHeaders: [],
      sensitiveUrl: true,
    };
  }
  return null;
}

export function createDefaultFounderCredentialTesters(options: {
  readonly fetcher: HttpFetcher;
  readonly connection?: FounderStackConnection | null;
}): Partial<Record<string, CredentialTester>> {
  const testers: Partial<Record<string, CredentialTester>> = {};
  for (const provider of ["neon", "stripe", "revenuecat", "brevo", "google", "bing"] as const) {
    testers[provider] = async (secret: string, reference: CredentialReference) => {
      const probe = probeFor(provider, secret, options.connection ?? null);
      if (!probe || reference.provider !== provider) {
        return { ok: false, message: `${provider} credential metadata does not match the probe` };
      }
      const request: HttpRequest = {
        method: "GET",
        url: probe.url,
        headers: probe.headers,
        sensitiveHeaders: probe.sensitiveHeaders,
        sensitiveUrl: probe.sensitiveUrl ?? false,
      };
      try {
        const response = await options.fetcher.fetch(request);
        const responseAccepted = response.status >= 200 && response.status < 300;
        const identityAccepted = !probe.validate || probe.validate(response.body);
        if (!responseAccepted || !identityAccepted) {
          return {
            ok: false,
            message: responseAccepted
              ? `${provider} credential cannot access the exact Founder Stack account`
              : `${provider} credential probe returned HTTP ${response.status}`,
          };
        }
        return {
          ok: true,
          // Organization/project/property targets prove access to the selected
          // Founder Stack destination, but they are not necessarily the
          // credential account identity stored on the reference. Preserve the
          // account identity recorded at login instead of overwriting it with
          // a differently scoped provider resource identifier.
          ...((provider === "stripe" || provider === "brevo") && probe.accountId
            ? { accountId: probe.accountId }
            : {}),
          message: `${provider} credential passed a read-only official API probe`,
        };
      } catch {
        return { ok: false, message: `${provider} credential read-only probe was unavailable` };
      }
    };
  }
  return testers;
}
