import { describe, expect, it } from "vitest";
import { resolveSiteConfig } from "@/lib/site-config";

describe("root-site indexing gate", () => {
  it("fails closed for previews, missing opt-in, HTTP, and malformed origins", () => {
    const base = {
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
    } as NodeJS.ProcessEnv;

    expect(resolveSiteConfig({ ...base }).indexingEnabled).toBe(false);
    expect(
      resolveSiteConfig({
        ...base,
        NEXT_PUBLIC_SITE_URL: "https://venture.example",
        NEXT_PUBLIC_INDEXING_ENABLED: "false",
      }).indexingEnabled,
    ).toBe(false);
    expect(
      resolveSiteConfig({
        ...base,
        NEXT_PUBLIC_SITE_URL: "http://venture.example",
        NEXT_PUBLIC_INDEXING_ENABLED: "true",
      }).indexingEnabled,
    ).toBe(false);
    expect(
      resolveSiteConfig({
        ...base,
        NEXT_PUBLIC_SITE_URL: "https://venture.example/path",
        NEXT_PUBLIC_INDEXING_ENABLED: "true",
      }).indexingEnabled,
    ).toBe(false);
    expect(
      resolveSiteConfig({
        ...base,
        VERCEL_ENV: "preview",
        NEXT_PUBLIC_SITE_URL: "https://venture.example",
        NEXT_PUBLIC_INDEXING_ENABLED: "true",
      }).indexingEnabled,
    ).toBe(false);
  });

  it("enables indexing only for an exact HTTPS origin in verified Vercel production", () => {
    const result = resolveSiteConfig({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SITE_URL: "https://venture.example",
      NEXT_PUBLIC_INDEXING_ENABLED: "true",
    } as NodeJS.ProcessEnv);

    expect(result.siteUrl.toString()).toBe("https://venture.example/");
    expect(result.indexingEnabled).toBe(true);
  });
});
