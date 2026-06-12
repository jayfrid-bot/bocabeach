import type { Metadata } from "next";
import Link from "next/link";
import { listLocations } from "@/config/locations";
import { getConditions } from "@/lib/conditions";
import { beachDayVerdict, scoreColor } from "@/lib/format";
import { LogoMark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConditionsDashboard } from "@/components/ConditionsDashboard";

export const revalidate = 300;

/**
 * When there's only one beach, the homepage IS that beach — no intermediate
 * card click. The multi-location card grid below is kept for the day a second
 * location is added to config/locations.ts.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locs = listLocations();
  if (locs.length === 1) {
    return {
      title: `${locs[0].name} — Is It Beach Day?`,
      description: `Live ${locs[0].name} beach conditions and a composite Beach Day score.`,
    };
  }
  return {};
}

export default async function Home() {
  const locations = listLocations();

  // Single-location mode: render the full dashboard directly.
  if (locations.length === 1) {
    const data = await getConditions(locations[0].slug);
    if (data) return <ConditionsDashboard slug={locations[0].slug} initial={data} />;
  }

  const cards = await Promise.all(
    locations.map(async (loc) => ({
      loc,
      data: await getConditions(loc.slug),
    })),
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-2 flex justify-end">
        <ThemeToggle />
      </div>
      <header className="mb-10 flex flex-col items-center text-center">
        <LogoMark size={72} />
        <h1 className="mt-5 text-4xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-5xl">
          Is it beach day<span className="text-amber-400">?</span>
        </h1>
        <p className="mt-3 max-w-xl text-slate-600 dark:text-slate-400">
          One answer to one question. Live tides, water &amp; air temp, wind,
          waves, water quality, and cams — distilled into a single Beach Day
          score.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map(({ loc, data }) => (
          <Link
            key={loc.slug}
            href={`/${loc.slug}`}
            className="group rounded-2xl bg-white/80 dark:bg-slate-900/70 p-5 ring-1 ring-slate-900/10 dark:ring-white/10 transition hover:ring-amber-400/40"
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">{loc.name}</h2>
                <p className="text-sm text-slate-600 dark:text-slate-400">{loc.region}</p>
              </div>
              <span className="text-slate-500 transition group-hover:text-amber-300">
                →
              </span>
            </div>
            <div className="mt-5">
              {data ? (
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-11 w-11 items-center justify-center rounded-full text-base font-bold text-slate-950"
                    style={{ background: scoreColor(data.score.score) }}
                  >
                    {data.score.score}
                  </span>
                  <div>
                    <div
                      className="text-lg font-semibold leading-tight"
                      style={{ color: scoreColor(data.score.score) }}
                    >
                      {beachDayVerdict(data.score.score)}
                    </div>
                    <div className="text-xs text-slate-500">
                      Beach Day score right now
                    </div>
                  </div>
                </div>
              ) : (
                <span className="text-sm text-slate-500">
                  Conditions unavailable
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>

      <p className="mt-10 text-center text-xs text-slate-400 dark:text-slate-600">
        Built to expand to every beach town — add a location in{" "}
        <code className="text-slate-600 dark:text-slate-400">config/locations.ts</code>.
      </p>
      <p className="mt-3 text-center text-xs text-slate-400 dark:text-slate-600">
        Feedback or ideas?{" "}
        <a href="mailto:hello@isitbeachday.com" className="text-ocean-700 dark:text-ocean-300 hover:underline">
          hello@isitbeachday.com
        </a>
      </p>
    </main>
  );
}
