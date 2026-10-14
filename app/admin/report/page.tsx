import type { Metadata } from "next";
import { ReportConditions } from "@/components/admin/ReportConditions";
import { listLocations } from "@/config/locations";

// Owner "Report conditions" sheet (docs/QUALITY_PLAN.md). A public shell: saving
// goes through /api/quality/owner/report, which only the owner's device passes.
// ?slug=<beach> picks the beach (the beach page's owner link sets it). Not indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Report conditions",
  robots: { index: false, follow: false },
};

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ slug?: string }> }) {
  const { slug } = await searchParams;
  const beaches = listLocations().map((l) => ({ slug: l.slug, name: l.name }));
  return <ReportConditions beaches={beaches} initialSlug={typeof slug === "string" ? slug : null} />;
}
