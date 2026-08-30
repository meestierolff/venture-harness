import type { MetadataRoute } from "next";
import { INDEXING_ENABLED, SITE_URL } from "@/lib/site-config";

export default function sitemap(): MetadataRoute.Sitemap {
  if (!INDEXING_ENABLED) return [];
  return [{ url: new URL("/", SITE_URL).toString(), changeFrequency: "weekly", priority: 1 }];
}
