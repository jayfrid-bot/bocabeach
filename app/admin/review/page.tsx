import type { Metadata } from "next";
import { QualityReview } from "@/components/admin/QualityReview";

// Owner review screen for the data-quality loop (docs/QUALITY_PLAN.md). The page
// is an empty shell for anyone else: its data comes from /api/quality/owner/list,
// which answers only the owner's device. Not indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Quality review",
  robots: { index: false, follow: false },
};

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ alert?: string }> }) {
  const { alert } = await searchParams;
  const id = Number(alert);
  return <QualityReview focusAlertId={Number.isInteger(id) && id > 0 ? id : null} />;
}
