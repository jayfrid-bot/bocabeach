"use client";

/**
 * "Last N days" — a look back at recent conditions at this beach, from the
 * hourly archive (docs/HISTORY_AND_IMAGERY_PLAN.md Part A, collecting since
 * 2026-09-22). Plus only, and app-only: POST /api/history/[slug] requires
 * the native app User-Agent, so — same rule as NotifyButton/BeachModeCard —
 * this renders nothing in a normal browser.
 *
 * Free: the same heading, one muted line, and a door into the existing Plus
 * onboarding/paywall (the same onDoor callback BeachModeCard's door uses —
 * never a dead end).
 * Plus, no rows yet: an honest "still collecting" line, no error.
 * Plus, with data: a horizontal strip of day cells; tap one for its hourly
 * score bar row, a one-line stat summary, and that day's caps. Below the
 * strip, a handful of records since the archive began.
 */

import { useState } from "react";
import useSWR from "swr";
import { scoreColor } from "@/lib/format";
import { plusApi, type HistoryResult } from "@/lib/plus/api";
import { weekdayOf, type DaySummary } from "@/lib/history/summary";
import { MetricCard } from "@/components/MetricCard";
import { LevelBarChart, type LevelBar } from "@/components/LevelBarChart";

type DaysWindow = 7 | 14 | 30;

/** "2026-09-22" -> "Sep 22". Pure calendar formatting — `date` is already a
 *  bare beach-local calendar day, so this reads it as UTC noon purely to get
 *  Intl to format the right day, never as a real instant. */
function monthDayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** 0-23 -> "2 PM". */
function hour12Label(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** 0-23 -> "2p" — tight enough for the hourly bar chart's x-axis. */
function hour12Compact(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? "a" : "p"}`;
}

/** "high 87°, water 85°, sand up to 137°, waves to 3.2 ft, crowds peak 40%,
 *  seaweed up to 5%" — only the fields this day actually has. */
function statsLine(d: DaySummary): string {
  const parts: string[] = [];
  if (d.airHighF != null) parts.push(`high ${Math.round(d.airHighF)}°`);
  if (d.waterF != null) parts.push(`water ${Math.round(d.waterF)}°`);
  if (d.sandMaxF != null) parts.push(`sand up to ${Math.round(d.sandMaxF)}°`);
  if (d.waveMaxFt != null) parts.push(`waves to ${d.waveMaxFt.toFixed(1)} ft`);
  if (d.crowdPeakPct != null) parts.push(`crowds peak ${Math.round(d.crowdPeakPct)}%`);
  if (d.seaweedMaxPct != null) parts.push(`seaweed up to ${Math.round(d.seaweedMaxPct)}%`);
  return parts.join(" · ");
}

const CHIP_BASE = "inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-full px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40";
const CHIP_ON = "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white";
const CHIP_OFF = "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white";

function DaysChip({
  value,
  label,
  active,
  disabled,
  onSelect,
}: {
  value: DaysWindow;
  label: string;
  active: boolean;
  disabled?: boolean;
  onSelect: (v: DaysWindow) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      disabled={disabled}
      aria-pressed={active}
      className={`${CHIP_BASE} ${active ? CHIP_ON : CHIP_OFF}`}
    >
      {label}
    </button>
  );
}

function DayCell({
  day,
  isOpen,
  onToggle,
}: {
  day: DaySummary;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const expandable = day.hourly.length > 0;
  const panelId = `history-day-${day.date}`;
  return (
    <button
      type="button"
      disabled={!expandable}
      aria-expanded={expandable ? isOpen : undefined}
      aria-controls={expandable ? panelId : undefined}
      onClick={() => expandable && onToggle()}
      className={`min-h-[64px] w-16 shrink-0 rounded-xl bg-white/80 p-1.5 text-center ring-1 ring-slate-900/10 transition dark:bg-slate-900/70 dark:ring-white/10 sm:w-20 sm:rounded-2xl sm:p-2 ${
        expandable
          ? "cursor-pointer hover:ring-ocean-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean-500"
          : "cursor-default"
      } ${isOpen ? "ring-2 ring-ocean-500 dark:ring-ocean-400" : ""}`}
    >
      <div className="truncate text-[9px] font-medium uppercase leading-tight text-slate-600 dark:text-slate-400 sm:text-xs">
        {day.weekday}
      </div>
      <div className="truncate text-[8px] leading-tight text-slate-400 dark:text-slate-500 sm:text-[10px]" aria-hidden>
        {monthDayLabel(day.date)}
      </div>
      {day.best ? (
        <div
          className="mx-auto mt-1 flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold tabular-nums text-slate-950 sm:h-9 sm:w-9 sm:text-sm"
          style={{ background: scoreColor(day.best.score) }}
          title={`Best score: ${day.best.score} at ${hour12Label(day.best.localHour)}`}
        >
          {day.best.score}
        </div>
      ) : (
        <div className="mx-auto mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold text-slate-500 dark:bg-slate-800 sm:h-9 sm:w-9 sm:text-sm">
          —
        </div>
      )}
      <div className="mt-0.5 truncate text-[8px] tabular-nums leading-tight text-slate-600 dark:text-slate-300 sm:text-[10px]">
        {day.best ? `best ${hour12Label(day.best.localHour)}` : " "}
      </div>
      {day.partial ? (
        <div className="mt-0.5 text-[7px] uppercase tracking-wide text-amber-600 dark:text-amber-400" aria-hidden>
          partial
        </div>
      ) : null}
    </button>
  );
}

function DayDetail({ day }: { day: DaySummary }) {
  const bars: LevelBar[] = day.hourly.map((h) => ({
    key: String(h.localHour),
    rank: h.score,
    color: scoreColor(h.score),
    label: hour12Compact(h.localHour),
    tooltip: `${hour12Label(h.localHour)} — score ${h.score}`,
  }));
  const line = statsLine(day);

  return (
    <div
      id={`history-day-${day.date}`}
      role="region"
      aria-label={`${day.weekday} ${monthDayLabel(day.date)} details`}
      className="col-span-full rounded-xl bg-white/90 p-3 ring-1 ring-slate-900/10 dark:bg-slate-900/80 dark:ring-white/10 sm:rounded-2xl sm:p-4"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white sm:text-base">
        {day.weekday} {monthDayLabel(day.date)}
        {day.partial ? (
          <span className="ml-2 align-middle text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            partial day
          </span>
        ) : null}
      </h3>

      {bars.length > 0 ? (
        <div className="mt-2">
          <LevelBarChart
            title="Hourly score"
            subtitle="Beach Day score for each archived hour"
            ariaLabel={`Hourly Beach Day score, ${day.weekday} ${monthDayLabel(day.date)}`}
            bars={bars}
            maxRank={100}
            axisLow="0"
            axisHigh="100"
          />
        </div>
      ) : null}

      {line ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{line}</p>
      ) : null}

      {day.caps.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {day.caps.map((c) => (
            <li
              key={c}
              className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300"
            >
              {c}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const RECORD_TILES = (r: NonNullable<HistoryResult["records"]>) => {
  const tiles: { key: string; icon: string; label: string; value: string; sub: string }[] = [];
  if (r.bestDay) {
    tiles.push({
      key: "best",
      icon: "\u{1f3c6}",
      label: "Best day",
      value: String(r.bestDay.score),
      sub: `${weekdayOf(r.bestDay.date)} ${monthDayLabel(r.bestDay.date)}`,
    });
  }
  if (r.hottestSand) {
    tiles.push({
      key: "sand",
      icon: "\u{1f525}",
      label: "Hottest sand",
      value: `${Math.round(r.hottestSand.sandTempF)}°`,
      sub: `${monthDayLabel(r.hottestSand.date)}, ${hour12Label(r.hottestSand.localHour)}`,
    });
  }
  if (r.biggestWaves) {
    tiles.push({
      key: "waves",
      icon: "\u{1f30a}",
      label: "Biggest waves",
      value: `${r.biggestWaves.waveFt.toFixed(1)} ft`,
      sub: `${monthDayLabel(r.biggestWaves.date)}, ${hour12Label(r.biggestWaves.localHour)}`,
    });
  }
  if (r.quietestDay) {
    tiles.push({
      key: "quiet",
      icon: "\u{1f9d8}",
      label: "Quietest day",
      value: `${Math.round(r.quietestDay.crowdPct)}% peak`,
      sub: `${weekdayOf(r.quietestDay.date)} ${monthDayLabel(r.quietestDay.date)}`,
    });
  }
  return tiles;
};

export function HistorySection({
  slug,
  native,
  entitled,
  deviceId,
  onDoor,
}: {
  slug: string;
  /** Server-detected native shell — same signal NotifyButton/BeachModeCard
   *  gate on. The API route itself is app-only, so there is nothing useful
   *  to show in a plain browser. */
  native: boolean;
  entitled: boolean;
  deviceId: string;
  /** Opens the existing Plus onboarding/paywall sheet — the same door
   *  BeachModeCard's onDoor prop opens. Never a dead end. */
  onDoor: () => void;
}) {
  const [days, setDays] = useState<DaysWindow>(7);
  const [openDate, setOpenDate] = useState<string | null>(null);

  const canFetch = native && entitled && !!deviceId;

  type HistoryKey = readonly [string, string, DaysWindow, string];
  type EligibilityKey = readonly [string, string, DaysWindow, string, string];

  const { data } = useSWR<HistoryResult, Error, HistoryKey | null>(
    canFetch ? (["history", slug, days, deviceId] as const) : null,
    (key: HistoryKey) => plusApi.fetchHistory(key[3], key[1], key[2]),
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  // A quiet second read at the 14-day window, purely to learn whether the
  // 30-day chip should unlock — independent of whichever window is on
  // screen, and cached separately (SWR key includes "eligibility") so
  // switching chips never re-triggers it.
  const { data: eligibility } = useSWR<HistoryResult, Error, EligibilityKey | null>(
    canFetch ? (["history", slug, 14, deviceId, "eligibility"] as const) : null,
    (key: EligibilityKey) => plusApi.fetchHistory(key[3], key[1], key[2]),
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  );
  const thirtyEnabled = !!eligibility?.ok && eligibility.days.length >= 14;

  if (!native) return null;

  const heading = entitled ? `Last ${days} days` : "Last 7 days";

  return (
    <section aria-labelledby="history-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="history-heading" className="text-balance text-lg font-semibold text-slate-900 dark:text-white">
          {heading}
        </h2>
        {entitled ? (
          <div role="group" aria-label="Days shown" className="inline-flex rounded-full bg-slate-900/5 p-1 dark:bg-white/5">
            <DaysChip value={7} label="7" active={days === 7} onSelect={setDays} />
            <DaysChip value={14} label="14" active={days === 14} onSelect={setDays} />
            <DaysChip value={30} label="30" active={days === 30} disabled={!thirtyEnabled} onSelect={setDays} />
          </div>
        ) : null}
      </div>

      {!entitled ? (
        <button
          type="button"
          onClick={onDoor}
          className="mt-3 flex w-full items-center gap-3 rounded-2xl bg-white/80 p-4 text-left ring-1 ring-slate-900/10 transition hover:ring-ocean-400 dark:bg-slate-900/70 dark:ring-white/10"
        >
          <span aria-hidden className="shrink-0 text-xl leading-none">
            {"\u{1f4c5}"}
          </span>
          <span className="min-w-0 flex-1 text-sm text-slate-600 dark:text-slate-400">
            Plus shows the last 30 days at this beach.
          </span>
          <span aria-hidden className="shrink-0 text-slate-400">
            {"›"}
          </span>
        </button>
      ) : !data ? (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Loading…</p>
      ) : !data.ok ? (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Couldn&apos;t load history right now. Try again in a minute.
        </p>
      ) : data.days.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          History starts collecting the first time someone opens this beach — check back tomorrow.
        </p>
      ) : data.days.length === 1 ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          Collecting — check back in a few days.
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-1 gap-2">
            <div className="flex gap-1.5 overflow-x-auto pb-1 sm:gap-2">
              {data.days.map((d) => (
                <DayCell
                  key={d.date}
                  day={d}
                  isOpen={openDate === d.date}
                  onToggle={() => setOpenDate((cur) => (cur === d.date ? null : d.date))}
                />
              ))}
            </div>
            {openDate ? (
              (() => {
                const day = data.days.find((d) => d.date === openDate);
                return day ? <DayDetail day={day} /> : null;
              })()
            ) : null}
          </div>

          {data.records && RECORD_TILES(data.records).length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                Records since Sept 22
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {RECORD_TILES(data.records).map((t) => (
                  <MetricCard key={t.key} icon={t.icon} label={t.label} value={t.value} sub={t.sub} />
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
