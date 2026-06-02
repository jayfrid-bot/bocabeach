import type { HourlyScore } from "@/lib/types";
import { fmtTime, scoreColor } from "@/lib/format";

const hourBucket = (iso: string) => Math.floor(new Date(iso).getTime() / 3_600_000);

/** Beach Day score forecast across today's daylight hours, one tile per hour. */
export function HourlyScoreStrip({
  hours,
  tz,
}: {
  hours: HourlyScore[];
  tz: string;
}) {
  if (hours.length === 0) return null;
  const nowBucket = hourBucket(new Date().toISOString());

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-white">Today&apos;s hourly score</h2>
      <p className="mb-3 text-xs text-slate-500">
        Beach Day score forecast through the day — sunrise to sunset.
      </p>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {hours.map((h) => {
          const isNow = hourBucket(h.time) === nowBucket;
          return (
            <div
              key={h.time}
              className={`w-16 shrink-0 rounded-2xl bg-slate-900/70 p-2.5 text-center ring-1 ${
                isNow ? "ring-2 ring-white/40" : "ring-white/10"
              }`}
            >
              <div className="text-[11px] font-medium uppercase text-slate-400">
                {fmtTime(h.time, tz)}
              </div>
              <div className="my-1 text-xl" title={h.rating} aria-label={h.rating}>
                {h.emoji || "•"}
              </div>
              <div
                className="text-lg font-bold leading-none"
                style={{ color: scoreColor(h.score) }}
              >
                {h.score}
              </div>
              {h.raining ? (
                <div className="mt-1 text-[11px] text-ocean-300" title="rain expected">
                  💧
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
