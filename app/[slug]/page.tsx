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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const loc = getLocation(slug);
  return {
    title: loc ? `${loc.name} — Is It Beach Day?` : "Is It Beach Day?",
    description: loc
      ? `Live ${loc.name} beach conditions and a composite Beach Day score.`
      : undefined,
  };
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
  return (
    <ConditionsDashboard
      slug={slug}
      initial={data}
      browseHref={browseHref}
      isNativeApp={isNativeApp}
    />
  );
}
