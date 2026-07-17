"use client";

import { useState } from "react";
import type { DayWindow, ForecastDay, Wrapped } from "@/lib/types";
import { fmtTime, fmtTimeCompact, scoreColor, scoreTextClass } from "@/lib/format";

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
  peakBreakdown: DayWindow["peakBreakdown"];
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
      peakBreakdown: d.peakBreakdown,
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
      peakBreakdown: undefined,
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
      : d.peakScore == null
        ? "hourly forecast not available for this day yet"
        : "no good window",
  );
  bits.push(d.peakBreakdown ? "activate for anticipated scoring details" : "no scoring detail available");
  return bits.join(", ");
}

/** Full-width panel showing the anticipated scoring behind a day's peak. */
function DayDetailPanel({ d, tz, panelId }: { d: MergedDay; tz: string; panelId: string }) {
  const b = d.peakBreakdown;
  if (!b) return null;
  return (
    <div
      id={panelId}
      role="region"
      aria-label={`Anticipated scoring for ${d.dow} ${mdLabel(d.date)}`}
      className="col-span-7 min-w-0 rounded-xl bg-white/90 p-3 ring-1 ring-slate-900/10 dark:bg-slate-900/80 dark:ring-white/10 sm:rounded-2xl sm:p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white sm:text-base">
          {d.dow} {mdLabel(d.date)} — anticipated score{" "}
          <span className={scoreTextClass(b.score)}>
            {b.score} ({b.rating})
          </span>
        </h3>
        {d.best ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Best window: {fmtTime(d.best.startIso, tz)}–{fmtTime(d.best.endIso, tz)}
          </p>
        ) : null}
      </div>

      {b.caps.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
          {b.caps.map((c) => (
            <li key={c}>⚠️ {c}</li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-3 divide-y divide-slate-900/5 dark:divide-white/10">
        {b.subScores.map((sc) => (
          <li
            key={sc.key}
            className="flex min-w-0 items-center justify-between gap-2 py-1.5 text-xs sm:text-sm"
          >
            <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
              {sc.label}
              {sc.display ? (
                <span className="ml-1 text-slate-400 dark:text-slate-500">· {sc.display}</span>
              ) : null}
            </span>
            {sc.score != null ? (
              <span
                className="flex h-6 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-slate-950"
                style={{ background: scoreColor(sc.score) }}
              >
                {sc.score}
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-slate-400 dark:text-slate-500">
                unknown
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
        Anticipated at {fmtTime(b.time, tz)} — the day&apos;s projected peak hour. A forecast
        estimate; some factors (like today&apos;s seaweed and crowds) aren&apos;t knowable this
        far ahead.
      </p>
    </div>
  );
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
  const [selected, setSelected] = useState<string | null>(null);
  const merged = mergeDays(days, forecast.data ?? []);
  if (merged.length === 0) return null;

  const selectedDay = merged.find((d) => d.date === selected && d.peakBreakdown) ?? null;

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
        7-day outlook — best beach times
      </h2>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        Sky, temps, and the best window to go each day, by Beach Day score. Tap
        a day for the anticipated scoring behind it. A forecast estimate —
        conditions can change.
      </p>
      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {merged.map((d) => {
          const expandable = !!d.peakBreakdown;
          const isOpen = selectedDay?.date === d.date;
          const panelId = `day-detail-${d.date}`;
          return (
            <button
              key={d.date}
              type="button"
              disabled={!expandable}
              aria-expanded={expandable ? isOpen : undefined}
              aria-controls={expandable ? panelId : undefined}
              aria-label={ariaLabel(d, tz)}
              onClick={() => expandable && setSelected(isOpen ? null : d.date)}
              className={`min-w-0 rounded-xl bg-white/80 p-1 text-center ring-1 ring-slate-900/10 transition dark:bg-slate-900/70 dark:ring-white/10 sm:rounded-2xl sm:p-3 ${
                expandable
                  ? "cursor-pointer hover:ring-ocean-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean-500 disabled:cursor-default"
                  : "cursor-default"
              } ${isOpen ? "ring-2 ring-ocean-500 dark:ring-ocean-400" : ""}`}
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
                ) : d.peakScore == null ? (
                  // No scored hours AT ALL for this day — we never looked, so
                  // saying "no good window" would be a lie about the beach.
                  // (Root cause was an hourly/daily fetch-window mismatch; this
                  // stays as an honest guard if the hourly feed ever runs short.)
                  <span className="text-slate-400">—</span>
                ) : (
                  // Scored, but nothing good left (e.g. today after sunset).
                  <>
                    <span className="text-slate-400 sm:hidden">—</span>
                    <span className="hidden text-slate-400 sm:inline">no good window</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
        {selectedDay ? (
          <DayDetailPanel d={selectedDay} tz={tz} panelId={`day-detail-${selectedDay.date}`} />
        ) : null}
      </div>
    </section>
  );
}
