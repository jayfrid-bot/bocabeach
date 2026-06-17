import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminPageAllowed } from "@/lib/admin/auth";
import { AdminConsole } from "@/components/admin/AdminConsole";

// Secret-URL admin console: /admin/<ADMIN_TOKEN>. Open in local dev; in
// production the path segment must equal the configured ADMIN_TOKEN (fails
// closed when unset). Never indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default async function AdminPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!adminPageAllowed(token)) notFound();
  return <AdminConsole token={token} />;
}
