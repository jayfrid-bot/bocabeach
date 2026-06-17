import type { MetadataRoute } from "next";
import { listLocations } from "@/config/locations";

const BASE = "https://isitbeachday.com";

// Served at /sitemap.xml. Enumerates every live beach so crawlers discover the
// on-demand (ISR) beach pages that aren't prerendered at build, plus the public
// "find your beach" page.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const locs = listLocations();

  // In single-beach mode "/" IS the beach, so don't also emit a /<slug> URL.
  const beaches: MetadataRoute.Sitemap =
    locs.length === 1
      ? []
      : locs.map((l) => ({
          url: `${BASE}/${l.slug}`,
          lastModified: now,
          changeFrequency: "daily" as const,
          priority: 0.8,
        }));

  return [
    { url: BASE, lastModified: now, changeFrequency: "daily", priority: 1 },
    ...(locs.length > 1
      ? [
          {
            url: `${BASE}/find`,
            lastModified: now,
            changeFrequency: "weekly" as const,
            priority: 0.7,
          },
        ]
      : []),
    ...beaches,
  ];
}
