import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [{ url: `${SITE_URL}/`, lastModified, changeFrequency: "weekly", priority: 1 }];
}
