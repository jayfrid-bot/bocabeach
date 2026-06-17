import type { Metadata } from "next";
import { AdminConsole } from "@/components/admin/AdminConsole";

// Owner console at the fixed path /admin/yf. No login: resolving + previewing
// are harmless; the "Add" commit is separately gated by ADMIN_GH_TOKEN (absent
// => disabled), so this page is safe to expose. Not indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminConsole />;
}
