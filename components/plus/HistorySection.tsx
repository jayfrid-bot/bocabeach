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
 * Plus, with data: a horizontal strip of day cells (newest first); tap one
 * for its hourly score bar row, a one-line stat summary, and that day's
 * caps. Below the strip, a handful of LIFETIME records — never bounded by
 * the 7/14/30 window on screen (lib/history/summary.ts `recordsFromRows`).
 */

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { scoreColor } from "@/lib/format";
import { plusApi, type HistoryResult } from "@/lib/plus/api";
import {
  daysBetweenLocalDates,
  shiftLocalDate,
  shortMonthDay,
  weekdayLongOf,
  weekdayOf,
  type DaySummary,
  type HistoryBestEver,
} from "@/lib/history/summary";
import { bootstrapInstallToken } from "@/lib/plus/client";
import { MetricCard } from "@/components/MetricCard";
import { LevelBarChart, type LevelBar } from "@/components/LevelBarChart";

type DaysWindow = 7 | 14 | 30;

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

/** "high 87°, water 85°, sand up to 137°, surf to 3.2 ft, crowds peak 40%,
 *  seaweed up to 5%" — only the fields this day actually has. Reads
 *  `surfMaxFt` (the estimated breaking-surf height), never the raw
 *  significant-wave-height column — see DaySummary.surfMaxFt's own doc. */
function statsLine(d: DaySummary): string {
  const parts: string[] = [];
  if (d.airHighF != null) parts.push(`high ${Math.round(d.airHighF)}°`);
  if (d.waterF != null) parts.push(`water ${Math.round(d.waterF)}°`);
  if (d.sandMaxF != null) parts.push(`sand up to ${Math.round(d.sandMaxF)}°`);
  if (d.surfMaxFt != null) parts.push(`surf to ${d.surfMaxFt.toFixed(1)} ft`);
  if (d.crowdPeakPct != null) parts.push(`crowds peak ${Math.round(d.crowdPeakPct)}%`);
  if (d.seaweedMaxPct != null) parts.push(`seaweed up to ${Math.round(d.seaweedMaxPct)}%`);
  return parts.join(" · ");
}

/** Full weekday + date + best score, for the day cell's accessible name —
 *  the visible cell only has room for the 3-letter weekday. */
function dayCellAriaLabel(day: DaySummary): string {
  const bits = [`${weekdayLongOf(day.date)} ${shortMonthDay(day.date)}`];
  bits.push(day.best ? `best ${day.best.score} at ${hour12Label(day.best.localHour)}` : "no score available");
  if (day.partial) bits.push("partial day");
  return bits.join(", ");
}

const CHIP_BASE =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-3 text-sm font-medium transition disabled:cursor-not-allowed";
const CHIP_ON = "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white";
const CHIP_OFF = "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white";
const CHIP_DISABLED = "cursor-not-allowed text-slate-400 dark:text-slate-600";

function DaysChip({
  value,
  label,
  active,
  disabled,
  title,
  onSelect,
}: {
  value: DaysWindow;
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: (v: DaysWindow) => void;
}) {
  // aria-disabled (not the native `disabled` attribute) — the chip stays
  // focusable so a `title` tooltip and the aria-disabled state are both
  // discoverable, rather than the control disappearing from the tab order
  // (Codex review: "the disabled chip gets aria-disabled and a visible
  // title").
  return (
    <button
      type="button"
      onClick={() => !disabled && onSelect(value)}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      title={title}
      className={`${CHIP_BASE} ${disabled ? CHIP_DISABLED : active ? CHIP_ON : CHIP_OFF}`}
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
      aria-label={dayCellAriaLabel(day)}
      onClick={() => expandable && onToggle()}
      className={`min-h-[64px] w-16 shrink-0 rounded-xl bg-white/80 p-1.5 text-center ring-1 ring-slate-900/10 transition dark:bg-slate-900/70 dark:ring-white/10 sm:w-20 sm:rounded-2xl sm:p-2 ${
        expandable
          ? "cursor-pointer hover:ring-ocean-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ocean-500"
          : "cursor-default"
      } ${isOpen ? "ring-2 ring-ocean-500 dark:ring-ocean-400" : ""}`}
    >
      <div className="truncate text-[9px] font-medium uppercase leading-tight text-slate-600 dark:text-slate-400 sm:text-xs" aria-hidden>
        {day.weekday}
      </div>
      <div className="truncate text-[8px] leading-tight text-slate-400 dark:text-slate-500 sm:text-[10px]" aria-hidden>
        {shortMonthDay(day.date)}
      </div>
      {day.best ? (
        <div
          className="mx-auto mt-1 flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold tabular-nums text-slate-950 sm:h-9 sm:w-9 sm:text-sm"
          style={{ background: scoreColor(day.best.score) }}
          aria-hidden
        >
          {day.best.score}
        </div>
      ) : (
        <div
          className="mx-auto mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold text-slate-500 dark:bg-slate-800 sm:h-9 sm:w-9 sm:text-sm"
          aria-hidden
        >
          {"—"}
        </div>
      )}
      <div className="mt-0.5 truncate text-[8px] tabular-nums leading-tight text-slate-600 dark:text-slate-300 sm:text-[10px]" aria-hidden>
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
  // Every hour is a bar; only every 3rd hour gets an x-axis label ("6a 9a
  // 12p 3p 6p" style) so a full day's worth of bars doesn't crowd into
  // unreadable text at 390px (Codex review). Keyed by hourUtc, not
  // localHour — a fall-back DST day has two hours that both read as
  // local_hour 1 (see lib/history/archive.ts), and only hourUtc tells them
  // apart.
  const bars: LevelBar[] = day.hourly.map((h, i) => ({
    key: h.hourUtc,
    rank: h.score,
    color: scoreColor(h.score),
    label: i % 3 === 0 ? hour12Compact(h.localHour) : "",
    tooltip: `${hour12Label(h.localHour)} — score ${h.score}`,
  }));
  const line = statsLine(day);

  return (
    <div
      id={`history-day-${day.date}`}
      role="region"
      aria-label={`${day.weekday} ${shortMonthDay(day.date)} details`}
      className="col-span-full rounded-xl bg-white/90 p-3 ring-1 ring-slate-900/10 dark:bg-slate-900/80 dark:ring-white/10 sm:rounded-2xl sm:p-4"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white sm:text-base">
        {day.weekday} {shortMonthDay(day.date)}
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
            ariaLabel={`Hourly Beach Day score, ${day.weekday} ${shortMonthDay(day.date)}`}
            bars={bars}
            maxRank={100}
            axisLow="0"
            axisHigh="100"
          />
        </div>
      ) : null}

      {line ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{line}</p> : null}

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

export interface RecordTile {
  key: string;
  icon: string;
  label: string;
  value: string;
  sub: string;
  /** A small quiet second line (MetricCard's own `extra`) — only the
   *  "Biggest surf" tile uses this, to caption itself honestly when the
   *  surf estimate doesn't cover the whole archive (Codex review #2). */
  note?: string;
}

export function recordTiles(
  r: NonNullable<HistoryResult["records"]>,
  archiveStartedAt: string | null,
  surfSince: string | null,
  bestEver: HistoryBestEver | null = null,
): RecordTile[] {
  const tiles: RecordTile[] = [];
  if (bestEver) {
    // The one record that spans every beach, so it leads the list. The sub
    // line names the beach — or, when it is THIS beach, says so instead of
    // repeating a name the reader is already looking at. The phone's tile
    // is ~170px wide: MetricCard wraps (never truncates) `sub`, and the
    // longest beach name plus date still fits its 3-line clamp.
    const when = `${shortMonthDay(bestEver.date)}, ${hour12Label(bestEver.localHour)}`;
    tiles.push({
      key: "best-ever",
      icon: "\u{1f947}",
      label: "Best day ever",
      value: String(bestEver.score),
      sub: bestEver.isThisBeach ? `This beach! ${when}` : `${bestEver.name} \u00b7 ${when}`,
    });
  }
  if (r.bestDay) {
    tiles.push({
      key: "best",
      icon: "\u{1f3c6}",
      label: "Best day",
      value: String(r.bestDay.score),
      sub: `${shortMonthDay(r.bestDay.date)}, ${hour12Label(r.bestDay.localHour)}`,
    });
  }
  if (r.hottestSand) {
    tiles.push({
      key: "sand",
      icon: "\u{1f525}",
      label: "Hottest sand",
      value: `${Math.round(r.hottestSand.sandTempF)}°`,
      sub: `${shortMonthDay(r.hottestSand.date)}, ${hour12Label(r.hottestSand.localHour)}`,
    });
  }
  if (r.biggestSurf) {
    // The surf estimate (migration 0010) is newer than the archive itself,
    // so surfSince is normally LATER than archiveStartedAt — captioning
    // that gap keeps the tile honest instead of implying full coverage.
    // Never a wave_ft fallback: a beach whose surf_ft is always null simply
    // has no 'biggest_surf' record at all (r.biggestSurf would be null).
    const coverageNote =
      surfSince && archiveStartedAt && surfSince > archiveStartedAt ? `since ${shortMonthDay(surfSince)}` : undefined;
    tiles.push({
      key: "surf",
      icon: "\u{1f30a}",
      label: "Biggest surf",
      value: `${r.biggestSurf.surfFt.toFixed(1)} ft`,
      sub: `${shortMonthDay(r.biggestSurf.date)}, ${hour12Label(r.biggestSurf.localHour)}`,
      note: coverageNote,
    });
  }
  if (r.quietestDay) {
    // "Quietest time", not "day" — this is the single least-crowded 10 AM-6
    // PM reading on file, not a per-day aggregate, so the caption carries
    // the weekday too ("Mon Sept 28, 3 PM") to anchor it to a real moment.
    tiles.push({
      key: "quiet",
      icon: "\u{1f9d8}",
      label: "Quietest time",
      value: `${Math.round(r.quietestDay.crowdPct)}%`,
      sub: `${weekdayOf(r.quietestDay.date)} ${shortMonthDay(r.quietestDay.date)}, ${hour12Label(r.quietestDay.localHour)}`,
    });
  }
  return tiles;
}

type HistoryKey = readonly ["history", string, DaysWindow, string];

/** Fetch, then — on a 401 (no/stale install token server-side) — re-bootstrap
 *  the token ONCE and retry, the same shape lib/plus/client.ts's
 *  useHazardsAtPoint uses for /api/hazards. Anything other than 401 (ok,
 *  network, 403, 429, 500…) returns as-is, no retry. */
async function fetchHistoryWithRetry(deviceId: string, slug: string, days: DaysWindow): Promise<HistoryResult> {
  const first = await plusApi.fetchHistory(deviceId, slug, days);
  if (first.status !== 401) return first;
  const { token } = await bootstrapInstallToken({ forceRefresh: true });
  if (!token) return first;
  return plusApi.fetchHistory(deviceId, slug, days);
}

/**
 * The entitled-user render state, as a pure function of three independent
 * signals — never a permanent "Loading…" (Codex review round 2 #1): a
 * device that finished bootstrapping with NO install token is a genuine
 * dead end for this feature (the route requires one), so it renders the
 * SAME error + "Try again" a failed fetch does, rather than spinning
 * forever waiting for a token that isn't coming. `bootstrapDone` is tracked
 * SEPARATELY from `installToken` specifically so "still bootstrapping" and
 * "bootstrapped, but got nothing" are distinguishable — collapsing them
 * into one nullable field can't tell "haven't checked yet" from "checked,
 * there's nothing".
 */
export type HistoryViewState =
  | { kind: "loading" }
  | { kind: "no-token-error" }
  | { kind: "fetch-error" }
  | { kind: "data"; data: HistoryResult & { ok: true } };

export function resolveHistoryViewState(input: {
  bootstrapDone: boolean;
  installToken: string | null;
  data: HistoryResult | undefined;
}): HistoryViewState {
  if (!input.bootstrapDone) return { kind: "loading" };
  if (!input.installToken) return { kind: "no-token-error" };
  if (!input.data) return { kind: "loading" };
  if (!input.data.ok) return { kind: "fetch-error" };
  return { kind: "data", data: input.data as HistoryResult & { ok: true } };
}

/** The shape `bootstrapInstallToken` (lib/plus/client.ts) exports — named
 *  here so `retryHistoryFetch` below can take it as an injected dependency
 *  (testable without rendering) instead of importing the module function
 *  directly. */
export type BootstrapInstallToken = (opts?: {
  forceRefresh?: boolean;
}) => Promise<{ token: string | null }>;

/**
 * The "Try again" button's behavior, split by error kind (Codex review —
 * the bug this replaces: a single handler forced a token refresh on EVERY
 * retry, including a plain network/429/500 failure with a perfectly good
 * token already on file; since /api/devices mints a token exactly ONCE per
 * device, forceRefresh's `clearInstallToken()` on that path could
 * permanently strip a device of its only token, breaking history, hazards,
 * and Live Activities for good — no server-side recovery exists).
 *
 * - `fetch-error` (the token is presumably fine; the FETCH failed): only
 *   revalidates. Never calls `bootstrap` at all, so it can never clear
 *   anything.
 * - `no-token-error` (bootstrap already finished and found nothing): a
 *   PLAIN bootstrap (no `forceRefresh`) — this either reads back whatever
 *   is already cached or, for a device that has genuinely never had a
 *   token minted, makes the ordinary upsert call that mints one. Still
 *   never forceRefresh: that argument is reserved for a CONFIRMED-bad
 *   token, which is exactly what the 401 path inside
 *   `fetchHistoryWithRetry` above already handles, once, on its own —
 *   this button must never repeat that.
 *
 * Pure aside from the two injected effects, so the forceRefresh boundary is
 * unit-testable without rendering the component.
 */
export async function retryHistoryFetch(
  kind: "no-token-error" | "fetch-error",
  deps: { bootstrap: BootstrapInstallToken; mutate: () => unknown },
): Promise<{ token: string | null } | null> {
  if (kind === "fetch-error") {
    await deps.mutate();
    return null;
  }
  const { token } = await deps.bootstrap();
  await deps.mutate();
  return { token };
}

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

  // Don't fetch until this device actually has an install token (Codex
  // review): bootstrapping is deduped/cached at module scope
  // (lib/plus/client.ts), so this is a cache hit whenever usePlus's own
  // mount effect already minted one — this just makes the SWR key wait for
  // it instead of racing a fetch that's certain to 401/token-required.
  // `bootstrapDone` is tracked separately from `installToken` (round-2 #1)
  // so "still checking" and "checked, got nothing" render differently —
  // the latter is a genuine dead end for this feature and must show the
  // SAME error + retry a failed fetch does, never a permanent "Loading…".
  const [installToken, setInstallToken] = useState<string | null>(null);
  const [bootstrapDone, setBootstrapDone] = useState(false);
  useEffect(() => {
    if (!native || !entitled || !deviceId) return;
    let cancelled = false;
    setBootstrapDone(false);
    void bootstrapInstallToken().then(({ token }) => {
      if (cancelled) return;
      setInstallToken(token);
      setBootstrapDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, [native, entitled, deviceId]);

  const canFetch = native && entitled && !!deviceId && !!installToken;

  const { data, mutate } = useSWR<HistoryResult, Error, HistoryKey | null>(
    canFetch ? (["history", slug, days, deviceId] as const) : null,
    (key) => fetchHistoryWithRetry(key[3], key[1], key[2]),
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  const view = entitled ? resolveHistoryViewState({ bootstrapDone, installToken, data }) : null;

  // Dispatches to `retryHistoryFetch` — a `fetch-error` retry never touches
  // the token (see that function's doc for why a forced refresh there was a
  // real bug); a `no-token-error` retry runs a plain, non-forced bootstrap.
  // No-op outside the two error states (nothing to retry).
  const retry = useCallback(() => {
    if (view?.kind !== "no-token-error" && view?.kind !== "fetch-error") return;
    void retryHistoryFetch(view.kind, { bootstrap: bootstrapInstallToken, mutate }).then((result) => {
      if (!result) return; // fetch-error: nothing about the token changed
      setInstallToken(result.token);
      setBootstrapDone(true);
    });
  }, [view?.kind, mutate]);

  // 30-day chip eligibility is a SPAN check (archiveStartedAt vs today), not
  // a row/day COUNT — a beach with real gaps in its archive can still have
  // earned the 30-day window on the calendar (Codex review). `since` is
  // this response's own lower bound (today - (days-1)), so today is
  // recoverable from it without a second request.
  const todayLocal = data?.ok && data.since ? shiftLocalDate(data.since, days - 1) : null;
  const thirtyEnabled = !!(
    data?.ok &&
    data.archiveStartedAt &&
    todayLocal &&
    daysBetweenLocalDates(data.archiveStartedAt, todayLocal) >= 14
  );

  if (!native) return null;

  const heading = entitled ? `Last ${days} days` : "Last 7 days";
  const newestFirst = view?.kind === "data" ? [...view.data.days].reverse() : [];
  const tiles =
    view?.kind === "data" && view.data.records
      ? recordTiles(view.data.records, view.data.archiveStartedAt, view.data.surfSince, view.data.bestEver)
      : [];

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
            <DaysChip
              value={30}
              label="30"
              active={days === 30}
              disabled={!thirtyEnabled}
              title={thirtyEnabled ? undefined : "After 14 days of history"}
              onSelect={setDays}
            />
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
      ) : view?.kind === "loading" ? (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Loading…</p>
      ) : view?.kind === "no-token-error" || view?.kind === "fetch-error" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">Couldn&apos;t load history right now.</p>
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-[44px] items-center rounded-full bg-slate-900/5 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-900/10 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/20"
          >
            Try again
          </button>
        </div>
      ) : view?.kind === "data" ? (
        <>
          {view.data.days.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              No history for this beach yet — it&apos;s still collecting. Check back tomorrow.
            </p>
          ) : (
            <>
              {view.data.days.length === 1 ? (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Still collecting — check back in a few days.
                </p>
              ) : null}
              <div className="mt-3 grid grid-cols-1 gap-2">
                <div className="flex gap-1.5 overflow-x-auto pb-1 sm:gap-2">
                  {newestFirst.map((d) => (
                    <DayCell
                      key={d.date}
                      day={d}
                      isOpen={openDate === d.date}
                      onToggle={() => setOpenDate((cur) => (cur === d.date ? null : d.date))}
                    />
                  ))}
                </div>
                {openDate
                  ? (() => {
                      const day = view.data.days.find((d) => d.date === openDate);
                      return day ? <DayDetail day={day} /> : null;
                    })()
                  : null}
              </div>
            </>
          )}

          {tiles.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                {view.data.archiveStartedAt ? `Records since ${shortMonthDay(view.data.archiveStartedAt)}` : "Records"}
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {tiles.map((t) => (
                  <MetricCard key={t.key} icon={t.icon} label={t.label} value={t.value} sub={t.sub} extra={t.note} />
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
