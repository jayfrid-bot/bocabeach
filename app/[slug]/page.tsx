import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConditions } from "@/lib/conditions";
import { getLocation, listLocations } from "@/config/locations";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";

export const revalidate = 300;

export function generateStaticParams() {
  return listLocations().map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const loc = getLocation(slug);
  return {
    title: loc ? `${loc.name} Beach Conditions` : "Beach Conditions",
    description: loc
      ? `Live ${loc.name} beach conditions and a composite Surf / Beach Day score.`
      : undefined,
  };
}

export default async function BeachPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getConditions(slug);
  if (!data) notFound();
  return <ConditionsDashboard slug={slug} initial={data} />;
}
