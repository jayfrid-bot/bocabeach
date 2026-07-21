import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getConditions } from "@/lib/conditions";
import { getLocation, listLocations } from "@/config/locations";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";
import { isNativeAppRequest } from "@/lib/nativeRequest";

// Dynamic so we can read the request User-Agent to detect the native app shell
// and serve it fresh, uncached HTML (referencing the latest JS chunks). Source
// data fetches keep their own caching, so render stays cheap; build time stays
// flat since nothing is prerendered.
export const dynamic = "force-dynamic";

const SITE_URL = "https://isitbeachday.com";

function beachTitle(name: string): string {
  return `Is It Beach Day at ${name}? Live Score & Conditions`;
}

function beachDescription(name: string, region: string): string {
  return `Live ${name} (${region}) beach conditions: today's Beach Day score, water & sand temperature, rip current risk, seaweed levels, lightning radar, crowd levels and webcams — updated all day.`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const loc = getLocation(slug);
  if (!loc) {
    // Unknown slug → the page 404s; leave the default (template) title in place.
    return {};
  }
  const title = beachTitle(loc.name);
  const description = beachDescription(loc.name, loc.region);
  const canonical = `${SITE_URL}/${loc.slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${title} · Is It Beach Day?`,
      description,
      url: canonical,
      // Re-declare the share image: Next does not deep-merge openGraph, so an
      // override here would otherwise drop the site-wide file-convention image.
      images: [{ url: "https://isitbeachday.com/opengraph-image", width: 1200, height: 630, alt: "Is It Beach Day?" }],
    },
  };
}

// JSON.stringify, then neutralize "<" so the JSON-LD can't break out of its
// <script> tag (our data has no user input, but keep it robust regardless).
function ldJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function BeachPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // "/" IS the flagship beach (the curated one, else the first), so its /<slug>
  // 301s home — one canonical URL, no duplicate content, shared links preserved.
  const all = listLocations();
  const primary = all.find((l) => l.tier !== "auto") ?? all[0];
  if (primary && slug === primary.slug) permanentRedirect("/");
  const isNativeApp = await isNativeAppRequest();
  const data = await getConditions(slug);
  if (!data) notFound();
  // With more than the flagship, offer a way back to the national picker.
  const browseHref = all.length > 1 ? "/find" : undefined;

  const loc = getLocation(slug);
  const jsonLd = loc
    ? {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Beach",
            name: loc.name,
            url: `${SITE_URL}/${loc.slug}`,
            geo: {
              "@type": "GeoCoordinates",
              latitude: loc.lat,
              longitude: loc.lon,
            },
            address: {
              "@type": "PostalAddress",
              addressRegion: loc.region,
              addressCountry: "US",
            },
          },
          {
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
              { "@type": "ListItem", position: 2, name: "Find your beach", item: `${SITE_URL}/find` },
              { "@type": "ListItem", position: 3, name: loc.name, item: `${SITE_URL}/${loc.slug}` },
            ],
          },
        ],
      }
    : null;

  return (
    <>
      {jsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: ldJson(jsonLd) }}
        />
      ) : null}
      <ConditionsDashboard
        slug={slug}
        initial={data}
        browseHref={browseHref}
        isNativeApp={isNativeApp}
      />
    </>
  );
}
