import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getConditions } from "@/lib/conditions";
import { getLocation, listLocations } from "@/config/locations";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";

export const revalidate = 300;

export function generateStaticParams() {
  // When there's only one beach, "/" is the canonical URL — don't prerender
  // the slug page, just let the redirect below handle any old link.
  const all = listLocations();
  if (all.length === 1) return [];
  // Prerender only curated, non-flagship beaches at build (the flagship 301s to
  // "/"). Auto-resolved (seeded) beaches render on-demand via ISR (dynamicParams
  // defaults true) and cache per the revalidate window — so build time stays
  // flat as the national list grows into the hundreds, while crawlers still get
  // fully server-rendered pages.
  const primary = all.find((l) => l.tier !== "auto") ?? all[0];
  return all
    .filter((l) => l.tier !== "auto" && l.slug !== primary?.slug)
    .map((l) => ({ slug: l.slug }));
}

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
  const data = await getConditions(slug);
  if (!data) notFound();
  // With more than the flagship, offer a way back to the national picker.
  const browseHref = all.length > 1 ? "/find" : undefined;
  return <ConditionsDashboard slug={slug} initial={data} browseHref={browseHref} />;
}
