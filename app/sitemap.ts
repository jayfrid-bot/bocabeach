import type { MetadataRoute } from "next";

// Served at /sitemap.xml. Single-page app today; add per-location URLs here if
// config/locations.ts ever grows past one beach.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://isitbeachday.com",
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
