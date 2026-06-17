import type { Metadata } from "next";
import { listLocations, toPublicLocation } from "@/config/locations";
import { getConditions } from "@/lib/conditions";
import { LogoMark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";
import { BeachFinder } from "@/components/BeachFinder";

export const revalidate = 300;

/**
 * When there's only one beach, the homepage IS that beach — no intermediate
 * click. With many beaches it's the national "find your beach" picker.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locs = listLocations();
  if (locs.length === 1) {
    return {
      title: `${locs[0].name} — Is It Beach Day?`,
      description: `Live ${locs[0].name} beach conditions and a composite Beach Day score.`,
    };
  }
  return {
    title: "Is It Beach Day? — Live conditions for US beaches",
    description:
      "One score answering one question for beaches across the US: live tides, water & air temp, wind, waves, UV, water quality, lightning, and NWS safety alerts.",
  };
}

export default async function Home() {
  const locations = listLocations();

  // Single-location mode: render the full dashboard directly. The dashboard
  // shows its own "Conditions unavailable" state when score.dataAvailable is
  // false (a partial/total source outage), so a non-null result always renders
  // here. A null result means we couldn't load conditions at all — handle that
  // explicitly rather than falling through to the multi-location card grid,
  // whose single card would link to /<slug> and 301 right back here.
  if (locations.length === 1) {
    const data = await getConditions(locations[0].slug);
    if (data) return <ConditionsDashboard slug={locations[0].slug} initial={data} />;
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
          The data sources didn&apos;t respond just now. Give it another shot in
          a moment.
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

  // Many beaches: a lightweight picker. We intentionally do NOT fetch conditions
  // for every beach here — that's dozens of multi-source fetches per render.
  // Each beach's score loads on its own page. The finder is pure client-side
  // filtering over a tiny public list (name/region/lat/lon).
  const beaches = locations.map(toPublicLocation);

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-2 flex justify-end">
        <ThemeToggle />
      </div>
      <header className="mb-8 flex flex-col items-center text-center">
        <LogoMark size={72} />
        <h1 className="mt-5 text-4xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-5xl">
          Is it beach day<span className="text-amber-400">?</span>
        </h1>
        <p className="mt-3 max-w-xl text-slate-600 dark:text-slate-400">
          One answer to one question, for {beaches.length} beaches across the US.
          Live tides, water &amp; air temp, wind, waves, UV, water quality, and
          NWS safety alerts — distilled into a single Beach Day score.
        </p>
      </header>

      <BeachFinder beaches={beaches} />

      <p className="mt-10 text-center text-xs text-slate-400 dark:text-slate-600">
        Don&apos;t see your beach?{" "}
        <a href="mailto:hello@isitbeachday.com" className="text-ocean-700 dark:text-ocean-300 hover:underline">
          Tell us where to add next
        </a>
      </p>
    </main>
  );
}
