import type { Metadata } from "next";
import { listLocations } from "@/config/locations";
import { getConditions } from "@/lib/conditions";
import { LogoMark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";
import { isNativeAppRequest } from "@/lib/nativeRequest";

// Dynamic so we can read the request User-Agent to detect the native app shell
// AND so the in-app WebView always gets fresh, uncached HTML (which references
// the latest JS chunks) instead of a stale cached shell. Source data fetches
// keep their own caching, so this stays cheap.
export const dynamic = "force-dynamic";

/** The flagship beach shown at "/": the curated one (Boca), else the first. */
function primaryLocation() {
  const locs = listLocations();
  return locs.find((l) => l.tier !== "auto") ?? locs[0];
}

// The homepage stays the flagship beach (Boca) for now; the full national
// picker lives at /find, linked from the dashboard's "＋ Other beaches" pill.
export async function generateMetadata(): Promise<Metadata> {
  const loc = primaryLocation();
  return {
    title: `${loc.name} — Is It Beach Day?`,
    description: `Live ${loc.name} beach conditions and a composite Beach Day score.`,
  };
}

export default async function Home() {
  const locations = listLocations();
  const primary = primaryLocation();
  // Show the "＋ Other beaches" link only once there's more than the flagship.
  const browseHref = locations.length > 1 ? "/find" : undefined;

  // Render the flagship dashboard directly. The dashboard shows its own
  // "Conditions unavailable" state when score.dataAvailable is false (a
  // partial/total source outage), so a non-null result always renders here.
  // A null result means we couldn't load conditions at all — handle that
  // explicitly rather than rendering a broken dashboard.
  const isNativeApp = await isNativeAppRequest();
  const data = await getConditions(primary.slug);
  if (data) {
    return (
      <ConditionsDashboard
        slug={primary.slug}
        initial={data}
        browseHref={browseHref}
        isNativeApp={isNativeApp}
      />
    );
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="mb-2 flex w-full justify-end">
        <ThemeToggle />
      </div>
      <LogoMark size={64} />
      <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
        We couldn&apos;t load conditions
      </h1>
      <p className="text-slate-600 dark:text-slate-400">
        The data sources didn&apos;t respond just now. Give it another shot in a
        moment.
      </p>
      {/* Plain href to "/" re-runs the server fetch — a full reload without a
          client component, since this page is a Server Component. A <Link>
          soft-navigation would reuse the cached RSC payload and not retry the
          failed data load, so a hard anchor is intentional here. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/"
        className="inline-flex min-h-[40px] items-center rounded-full bg-slate-900/5 px-5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-900/10 transition hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10"
      >
        Try again
      </a>
    </main>
  );
}
