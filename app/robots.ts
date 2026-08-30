import type { MetadataRoute } from "next";
import { INDEXING_ENABLED, SITE_URL } from "@/lib/site-config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: INDEXING_ENABLED
      ? { userAgent: "*", allow: "/", disallow: ["/api/"] }
      : { userAgent: "*", disallow: "/" },
    ...(INDEXING_ENABLED ? { sitemap: new URL("/sitemap.xml", SITE_URL).toString() } : {}),
  };
}
