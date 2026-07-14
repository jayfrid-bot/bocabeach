import type { DayWindow, ForecastDay, Wrapped } from "@/lib/types";
import { fmtTime, fmtTimeCompact, scoreColor } from "@/lib/format";

/**
 * One row per upcoming day, merging the sky/temps/rain forecast with the
 * best-window-by-Beach-Day-score analysis — previously two separate 7-day
 * strips (ForecastStrip + BestTimesStrip). Joined by `date` (both sides use
 * the beach's local YYYY-MM-DD); if a day's date doesn't line up between the
 * two feeds, falls back to positional (index) pairing so the row still shows
 * something rather than dropping data. A day present in only one dataset
 * still renders with whatever it has.
 */
interface MergedDay {
  date: string;
  dow: string;
  emoji: string;
  sky?: string;
  hi?: number;
  lo?: number;
  rain?: number;
  peakScore: number | null;
  best: DayWindow["best"];
}

function mergeDays(days: DayWindow[], forecast: ForecastDay[]): MergedDay[] {
  const forecastByDate = new Map(forecast.map((f) => [f.date, f]));
  const usedDates = new Set<string>();

  const merged: MergedDay[] = days.map((d, i) => {
    // Prefer a date match; fall back to same-index pairing if the two feeds'
    // dates don't line up (e.g. off-by-one from a source hiccup).
    const f = forecastByDate.get(d.date) ?? forecast[i];
    if (f) usedDates.add(f.date);
    return {
      date: d.date,
      dow: d.dow,
      emoji: f?.emoji || d.emoji,
      sky: f?.sky,
      hi: f?.hi,
      lo: f?.lo,
      rain: f?.rain,
      peakScore: d.peakScore,
      best: d.best,
    };
  });

  // Forecast-only days (e.g. the forecast feed runs longer than the
  // multi-day-window analysis) still get a tile, just with no score/window.
  for (const f of forecast) {
    if (usedDates.has(f.date)) continue;
    if (merged.some((m) => m.date === f.date)) continue;
    merged.push({
      date: f.date,
      dow: f.dow,
      emoji: f.emoji,
      sky: f.sky,
      hi: f.hi,
      lo: f.lo,
      rain: f.rain,
      peakScore: null,
      best: null,
    });
  }

  return merged;
}

/** "2026-07-15" -> "7/15" — cheap month/day label, no tz-aware Date parsing needed
 *  since the date string is already the beach's local calendar day. */
function mdLabel(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return "";
  const m = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  return Number.isFinite(m) && Number.isFinite(day) ? `${m}/${day}` : "";
}

function ariaLabel(d: MergedDay, tz: string): string {
  const bits = [d.dow];
  if (d.hi != null) bits.push(`high ${d.hi}°`);
  if (d.lo != null) bits.push(`low ${d.lo}°`);
  if (d.rain != null && d.rain >= 20) bits.push(`${d.rain}% chance of rain`);
  bits.push(d.peakScore != null ? `peak Beach Day score ${d.peakScore}` : "no score available");
  bits.push(
    d.best
      ? `best window ${fmtTime(d.best.startIso, tz)} to ${fmtTime(d.best.endIso, tz)}`
      : "no good window",
  );
  return bits.join(", ");
}

export function DayOutlookStrip({
  days,
  forecast,
  tz,
}: {
  days: DayWindow[];
  forecast: Wrapped<ForecastDay[]>;
  tz: string;
}) {
  const merged = mergeDays(days, forecast.data ?? []);
  if (merged.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
        7-day outlook — best beach times
      </h2>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        Sky, temps, and the best window to go each day, by Beach Day score. A
        forecast estimate — conditions can change.
      </p>
      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {merged.map((d) => (
          <div
            key={d.date}
            className="min-w-0 rounded-xl bg-white/80 p-1 text-center ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10 sm:rounded-2xl sm:p-3"
            aria-label={ariaLabel(d, tz)}
          >
            <div className="truncate text-[9px] font-medium uppercase leading-tight text-slate-600 dark:text-slate-400 sm:text-xs">
              {d.dow}
            </div>
            <div
              className="truncate text-[7px] leading-tight text-slate-400 dark:text-slate-500 sm:text-[10px]"
              aria-hidden
            >
              {mdLabel(d.date)}
            </div>

            <div className="my-0.5 text-base leading-none sm:my-1 sm:text-2xl" aria-hidden>
              {d.emoji || "🏖️"}
            </div>

            <div
              className="text-[9px] font-semibold leading-tight text-slate-900 dark:text-white sm:text-sm"
              aria-hidden
            >
              {d.hi != null ? `${d.hi}°` : "—"}
              <span className="text-slate-400 sm:hidden">/{d.lo != null ? `${d.lo}°` : "—"}</span>
            </div>
            <div className="hidden text-xs leading-tight text-slate-500 sm:block" aria-hidden>
              {d.lo != null ? `${d.lo}°` : "—"}
            </div>

            <div className="min-h-[10px] text-[8px] font-medium leading-tight text-ocean-700 dark:text-ocean-300 sm:min-h-[16px] sm:text-[11px]">
              {d.rain != null && d.rain >= 20 ? `💧${d.rain}%` : null}
            </div>

            {d.peakScore != null ? (
              <div
                className="mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-slate-950 sm:mt-1 sm:h-9 sm:w-9 sm:text-sm"
                style={{ background: scoreColor(d.peakScore) }}
                title={`Peak Beach Day score: ${d.peakScore}`}
                aria-hidden
              >
                {d.peakScore}
              </div>
            ) : (
              <div
                className="mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-500 dark:bg-slate-800 sm:mt-1 sm:h-9 sm:w-9 sm:text-sm"
                aria-hidden
              >
                —
              </div>
            )}

            <div className="mt-0.5 break-words text-[9px] leading-tight text-slate-600 dark:text-slate-300 sm:mt-2 sm:text-[11px]" aria-hidden>
              {d.best ? (
                <>
                  <span className="sm:hidden">
                    {fmtTimeCompact(d.best.startIso, tz)}
                    <span className="text-slate-400">–</span>
                    {fmtTimeCompact(d.best.endIso, tz)}
                  </span>
                  <span className="hidden sm:inline">
                    {fmtTime(d.best.startIso, tz)}
                    <span className="text-slate-400">–</span>
                    {fmtTime(d.best.endIso, tz)}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-slate-400 sm:hidden">—</span>
                  <span className="hidden text-slate-400 sm:inline">no good window</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
