import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getConditions } from "@/lib/conditions";
import { getLocation, listLocations } from "@/config/locations";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";

export const revalidate = 300;

export function generateStaticParams() {
  // When there's only one beach, "/" is the canonical URL — don't prerender
  // the slug page, just let the redirect below handle any old link.
  return listLocations().length === 1 ? [] : listLocations().map((l) => ({ slug: l.slug }));
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
  // Single-location mode: "/" is canonical. Old "/boca-raton" links 301 home,
  // consolidating analytics under one URL and preserving any shared links.
  const all = listLocations();
  if (all.length === 1 && slug === all[0].slug) permanentRedirect("/");
  const data = await getConditions(slug);
  if (!data) notFound();
  return <ConditionsDashboard slug={slug} initial={data} />;
}
