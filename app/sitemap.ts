import type { MetadataRoute } from "next";
import { listLocations } from "@/config/locations";

const BASE = "https://isitbeachday.com";

// Served at /sitemap.xml. Enumerates every live beach so crawlers discover the
// on-demand (ISR) beach pages that aren't prerendered at build, plus the public
// "find your beach" page.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const locs = listLocations();

  // The flagship beach is canonical at "/" (its /<slug> 301s home), so emit
  // every OTHER beach's URL but not the flagship's.
  const primary = locs.find((l) => l.tier !== "auto") ?? locs[0];
  const beaches: MetadataRoute.Sitemap =
    locs.length === 1
      ? []
      : locs
          .filter((l) => l.slug !== primary?.slug)
          .map((l) => ({
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
