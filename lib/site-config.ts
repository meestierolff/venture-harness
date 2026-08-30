export interface SiteConfig {
  siteUrl: URL;
  indexingEnabled: boolean;
}

function exactHttpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const candidate = value.includes("://") ? value : `https://${value}`;
    const parsed = new URL(candidate);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolveSiteConfig(environment: NodeJS.ProcessEnv): SiteConfig {
  const explicitValue = environment.NEXT_PUBLIC_SITE_URL;
  const vercelValue = environment.VERCEL_PROJECT_PRODUCTION_URL;
  const explicitOrigin = exactHttpOrigin(explicitValue);
  const vercelProductionOrigin = exactHttpOrigin(vercelValue);
  const invalidSuppliedOrigin =
    (Boolean(explicitValue) && !explicitOrigin) ||
    (Boolean(vercelValue) && !vercelProductionOrigin);
  const configuredOrigin = explicitOrigin ?? vercelProductionOrigin ?? "http://localhost:3000";
  const siteUrl = new URL(configuredOrigin);
  const verifiedProductionEnvironment =
    environment.VERCEL === "1" && environment.VERCEL_ENV === "production";

  return {
    siteUrl,
    indexingEnabled:
      !invalidSuppliedOrigin &&
      verifiedProductionEnvironment &&
      siteUrl.protocol === "https:" &&
      Boolean(explicitOrigin ?? vercelProductionOrigin) &&
      environment.NEXT_PUBLIC_INDEXING_ENABLED === "true",
  };
}

const resolved = resolveSiteConfig(process.env);

export const SITE_URL = resolved.siteUrl;
export const INDEXING_ENABLED = resolved.indexingEnabled;
