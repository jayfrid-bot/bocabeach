import type { MetadataRoute } from "next";
import type { Location } from "@/lib/types";
import { listLocations } from "@/config/locations";

const BASE = "https://isitbeachday.com";

// Stamped into the bundle at build time (see next.config.mjs) — the same
// value the footer shows as "last built". Reusing it here means every URL's
// lastModified changes only when the app is actually rebuilt/deployed, never
// on a per-request basis. Falls back to a fixed date (dev/test, where the env
// var isn't inlined) rather than `new Date()`, so it stays a stable constant.
const BUILD_DATE = new Date(process.env.NEXT_PUBLIC_BUILD_TIME ?? "2026-01-01T00:00:00.000Z");

// Machine-added beaches (config/locations.generated.json) don't carry their
// own `updatedAt`; that whole file's last-commit date stands in for all of
// them. Looked up once by hand — see the task that added this constant.
const GENERATED_UPDATED_AT = new Date("2026-06-22T00:00:00.000Z");

// A beach's lastModified is the newer of: when its config entry was actually
// added/updated, and when the app was last built — never "now".
function lastModifiedFor(loc: Location): Date {
  const contentDate = loc.updatedAt ? new Date(loc.updatedAt) : GENERATED_UPDATED_AT;
  return contentDate > BUILD_DATE ? contentDate : BUILD_DATE;
}

// Served at /sitemap.xml. All URLs live on the apex (canonical) domain so the
// www/app duplicates never enter the index. Beach pages change with live
// conditions, so they carry an "hourly" change frequency.
export default function sitemap(): MetadataRoute.Sitemap {
  // The flagship beach's /<slug> permanently redirects to "/" (see
  // app/[slug]/page.tsx) — a sitemap must not list a redirecting URL, and the
  // homepage entry below IS that page.
  const all = listLocations();
  const flagship = all.find((l) => l.tier !== "auto") ?? all[0];

  const beaches: MetadataRoute.Sitemap = all
    .filter((l) => l.slug !== flagship?.slug)
    .map((l) => ({
      url: `${BASE}/${l.slug}`,
      lastModified: lastModifiedFor(l),
      changeFrequency: "hourly",
      priority: 0.9,
    }));

  return [
    {
      url: `${BASE}/`,
      lastModified: flagship ? lastModifiedFor(flagship) : BUILD_DATE,
      changeFrequency: "hourly",
      priority: 1.0,
    },
    { url: `${BASE}/find`, lastModified: BUILD_DATE, changeFrequency: "daily", priority: 0.8 },
    { url: `${BASE}/support`, lastModified: BUILD_DATE, changeFrequency: "monthly", priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: BUILD_DATE, changeFrequency: "yearly", priority: 0.2 },
    ...beaches,
  ];
}
