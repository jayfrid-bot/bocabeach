import Link from "next/link";
import { listLocations } from "@/config/locations";
import { getConditions } from "@/lib/conditions";
import { scoreColor } from "@/lib/format";

export const revalidate = 300;

function ScoreChip({ label, score }: { label: string; score: number }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold text-slate-950"
        style={{ background: scoreColor(score) }}
      >
        {score}
      </span>
      <span className="text-xs text-slate-400">{label}</span>
    </div>
  );
}

export default async function Home() {
  const locations = listLocations();
  const cards = await Promise.all(
    locations.map(async (loc) => ({
      loc,
      data: await getConditions(loc.slug),
    })),
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <header className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-white sm:text-5xl">
          Beach Conditions
        </h1>
        <p className="mt-3 text-slate-400">
          Live tides, water &amp; air temp, wind, waves, and cams — distilled into a
          composite Surf and Beach Day score.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map(({ loc, data }) => (
          <Link
            key={loc.slug}
            href={`/${loc.slug}`}
            className="group rounded-2xl bg-slate-900/70 p-5 ring-1 ring-white/10 transition hover:ring-ocean-500/50"
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">{loc.name}</h2>
                <p className="text-sm text-slate-400">{loc.region}</p>
              </div>
              <span className="text-slate-500 transition group-hover:text-ocean-300">
                →
              </span>
            </div>
            <div className="mt-5 flex gap-6">
              {data ? (
                <>
                  <ScoreChip label="Beach Day" score={data.scores.beachDay.score} />
                  <ScoreChip label="Surf" score={data.scores.surf.score} />
                </>
              ) : (
                <span className="text-sm text-slate-500">Conditions unavailable</span>
              )}
            </div>
          </Link>
        ))}
      </div>

      <p className="mt-10 text-center text-xs text-slate-600">
        Built to expand to every beach town — add a location in{" "}
        <code className="text-slate-400">config/locations.ts</code>.
      </p>
    </main>
  );
}
