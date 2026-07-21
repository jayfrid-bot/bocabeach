import type { MetadataRoute } from "next";
import { listLocations } from "@/config/locations";

const BASE = "https://isitbeachday.com";

// Served at /sitemap.xml. All URLs live on the apex (canonical) domain so the
// www/app duplicates never enter the index. Beach pages change with live
// conditions, so they carry an "hourly" change frequency.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  // The flagship beach's /<slug> permanently redirects to "/" (see
  // app/[slug]/page.tsx) — a sitemap must not list a redirecting URL, and the
  // homepage entry below IS that page.
  const all = listLocations();
  const flagship = all.find((l) => l.tier !== "auto") ?? all[0];

  const beaches: MetadataRoute.Sitemap = all
    .filter((l) => l.slug !== flagship?.slug)
    .map((l) => ({
      url: `${BASE}/${l.slug}`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    }));

  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "hourly", priority: 1.0 },
    { url: `${BASE}/find`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    ...beaches,
  ];
}
