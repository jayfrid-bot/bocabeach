"use client";

// ---------------------------------------------------------------------------
// "Coming up" card (Phase 2B, Crew F) — renders lib/skyEvents.ts's
// buildComingUp() output. Matches the dashboard's existing card look
// (SunQualityCard.tsx/MetricCard.tsx: rounded-2xl white/80 card, ring, dark
// mode variants). See docs/SKY_EVENTS_PLAN.md §1, §9, §12.
//
// All formatting happens HERE, at the display edge, from the UTC ISO
// instants buildComingUp carries — never inside lib/skyEvents.ts (§9). Every
// time is explicit weekday/date/time; never "tonight" (§1).
//
// LAYOUT: this card is denser than a MetricCard tile (up to 3 rows, each
// with a title/time line, a short line, and sometimes a countdown) — it's
// built to run FULL WIDTH, not as a member of the existing 2-up phone grid.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { fmtDate, fmtTime } from "@/lib/format";
import { SUN_QUALITY_BANDS } from "@/lib/sunQuality";
import type {
  EclipseSkyEvent,
  LaunchSkyEvent,
  MeteorSkyEvent,
  MoonSkyEvent,
  SkyEvent,
  SkyEventsCardData,
  SkyEventsCardRow,
  SkyRatingLabel,
  TideSkyEvent,
} from "@/lib/skyEventsTypes";

export interface SkyEventsCardProps {
  /** Output of lib/skyEvents.ts's `buildComingUp()` — pass straight through.
   *  `null` (or a card with no rows) renders nothing (§1 — never an empty or
   *  placeholder card). */
  data: SkyEventsCardData | null;
  /** Beach IANA timezone, e.g. "America/New_York" or "Pacific/Honolulu" —
   *  every time on the card is formatted here from buildComingUp's UTC ISO
   *  instants (§9). */
  tz: string;
  /** The conditions snapshot's pinned instant — drives the SSR/first-render
   *  countdown so server HTML and first client paint agree exactly; a
   *  client-only clock (below) takes over the live launch countdown after
   *  mount, same hydration-safe convention as SunQualityCard/RipRiskCard. */
  nowMs: number;
}

export function SkyEventsCard({ data, tz, nowMs }: SkyEventsCardProps) {
  const [clientNowMs, setClientNowMs] = useState<number | null>(null);
  useEffect(() => {
    setClientNowMs(Date.now());
    const id = setInterval(() => setClientNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!data || data.rows.length === 0) return null;
  const liveNowMs = clientNowMs ?? nowMs;

  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🔭</span>
        <span>Coming up</span>
      </div>

      <div className="mt-2 flex flex-col divide-y divide-slate-900/10 dark:divide-white/10">
        {data.rows.map((row, i) => (
          <SkyEventRow key={rowKey(row, i)} row={row} tz={tz} nowMs={liveNowMs} />
        ))}
      </div>

      <div className="mt-3 break-words text-xs text-slate-500 dark:text-slate-500">
        Forecasts and launch times can change.
      </div>
    </div>
  );
}

function SkyEventRow({ row, tz, nowMs }: { row: SkyEventsCardRow; tz: string; nowMs: number }) {
  const copy = describeRow(row, tz, nowMs);
  const countdown = copy.countdownTargetIso ? countdownLabel(copy.countdownTargetIso, nowMs) : null;

  return (
    <div className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 shrink-0">
          {copy.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm font-medium leading-snug text-slate-900 dark:text-white">
            {copy.title}
          </div>
          <div className="break-words text-xs leading-snug tabular-nums text-slate-500 dark:text-slate-400">
            {copy.timeLine}
          </div>
        </div>
      </div>

      <div className="break-words pl-6 text-xs leading-snug text-slate-600 dark:text-slate-300">
        {copy.shortLine}
      </div>

      {countdown ? (
        <div className="break-words pl-6 text-xs font-medium leading-snug tabular-nums text-amber-600 dark:text-amber-400">
          {countdown}
        </div>
      ) : null}

      {copy.ratable ? (
        <div className="flex items-center gap-1.5 pl-6">
          {copy.rating ? (
            <>
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: ratingColor(copy.rating.label) }}
              />
              <span
                className="text-xs font-semibold leading-snug"
                style={{ color: ratingColor(copy.rating.label) }}
              >
                {copy.rating.label}
              </span>
            </>
          ) : (
            <span className="text-xs leading-snug text-slate-400 dark:text-slate-500">Forecast later.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

// --- copy (§12) — exported pure helpers, tested directly (no React render
// harness in this repo: vitest.config.ts only includes **/*.test.ts, and
// there's no @testing-library/react dependency — same "test the pure
// exported helper" precedent SunQualityCard.test.ts already sets for
// `cardTitle`). --------------------------------------------------------------

export interface RowCopy {
  icon: string;
  /** The row's headline, e.g. "Full moon", "Perseids", "Falcon 9". */
  title: string;
  /** Explicit weekday/date/time — never "tonight" (§1, §9). */
  timeLine: string;
  /** One short, plain-English line (§12). */
  shortLine: string;
  /** Present only when `ratable` and a rating was actually computed. */
  rating: { label: SkyRatingLabel } | null;
  /** False only for tide — tides are never sky-rated (§5); the row shows no
   *  rating slot at all rather than a quiet "Forecast later" it can never
   *  earn. True for every other kind, whether or not `rating` came back
   *  null this time. */
  ratable: boolean;
  /** Launch-only: the instant a live countdown ticks toward — present only
   *  for a Minute-precision, still-future, non-Hold launch (§7). */
  countdownTargetIso?: string;
}

/** Dispatches on the row's underlying event(s). A 2-event row is always
 *  `[eclipse, moon]`, the merge order `lib/skyEvents.ts` builds (checked
 *  defensively, not assumed, in case that ordering ever changes). */
export function describeRow(row: SkyEventsCardRow, tz: string, nowMs: number): RowCopy {
  if (row.events.length === 2) {
    const [a, b] = row.events;
    const eclipse = (a.eventType === "eclipse" ? a : b) as EclipseSkyEvent;
    return describeEclipse(eclipse, tz, true);
  }

  const event = row.events[0] as SkyEvent;
  switch (event.eventType) {
    case "tide":
      return describeTide(event, tz);
    case "eclipse":
      return describeEclipse(event, tz, false);
    case "moon":
      return describeMoon(event, tz);
    case "meteor":
      return describeMeteor(event, tz);
    case "launch":
      return describeLaunch(event, tz, nowMs);
  }
}

function describeTide(e: TideSkyEvent, tz: string): RowCopy {
  const title = e.tier === "validated" ? "High-tide flooding possible" : "Very high tide";
  const timeLine = weekdayDateTime(e.episode.start, tz);
  const base =
    e.tier === "validated"
      ? "The predicted tide reaches this station's flood level. Wind and weather can raise it further."
      : "This is in the top 1% of predicted highs this year.";
  // An episode covering more than one qualifying high (§3's ≤30h/≤72h merge)
  // gets a plain "repeats through" clause rather than silently dropping the
  // later highs it represents.
  const spansMultipleHighs = Date.parse(e.episode.end) - Date.parse(e.episode.start) > 30 * 60_000;
  const shortLine = spansMultipleHighs
    ? `${base} Repeats through ${weekdayDateTime(e.episode.end, tz)}.`
    : base;
  return { icon: "🌊", title, timeLine, shortLine, rating: null, ratable: false };
}

function describeEclipse(e: EclipseSkyEvent, tz: string, merged: boolean): RowCopy {
  const kindWord = e.kind === "total" ? "Total" : "Partial";
  const title = merged ? `${kindWord} eclipse during the full moon` : `${kindWord} lunar eclipse`;
  const day = weekdayDate(e.visible.start, tz);
  const timeLine = e.peakIsVisible
    ? `${day}, peak ${fmtTime(e.peak, tz)}`
    : `${day}, visible here ${fmtRange(e.visible.start, e.visible.end, tz)}`;
  return {
    icon: "🌘",
    title,
    timeLine,
    shortLine: "Visible with the naked eye. No special equipment is needed.",
    rating: e.rating ? { label: e.rating.label } : null,
    ratable: true,
  };
}

function describeMoon(e: MoonSkyEvent, tz: string): RowCopy {
  const title = e.isSupermoon ? "Supermoon" : "Full moon";
  const timeLine = weekdayDate(e.fullMoonInstant, tz);
  const moonrise = fmtTime(e.moonriseLocal, tz);
  // "Over the water" leads when it's available — a second, manually-reviewed
  // check layered on the viewing window, curated beaches only (§4). Every
  // other beach still gets the plain moonrise time, never a blank line.
  const riseClause = e.overWater ? `Rises over the water at ${moonrise}.` : `Moonrise at ${moonrise}.`;
  const shortLine =
    e.isSupermoon && e.supermoonRank === 1
      ? `${riseClause} This is the closest full moon of the year.`
      : riseClause;
  return {
    icon: "🌕",
    title,
    timeLine,
    shortLine,
    rating: e.rating ? { label: e.rating.label } : null,
    ratable: true,
  };
}

/** "Best after midnight" when the shower's own best local window (already
 *  computed per beach by the adapter, §5/§6) starts in the small hours;
 *  "Best after dark" otherwise — a plain, two-state read on the beach's own
 *  local clock, never a hard-coded time. */
export function meteorTimingLine(e: MeteorSkyEvent, tz: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(
      new Date(e.bestLocalWindow.start),
    ),
  );
  return hour >= 0 && hour < 6 ? "Best after midnight." : "Best after dark.";
}

function describeMeteor(e: MeteorSkyEvent, tz: string): RowCopy {
  return {
    icon: "☄️",
    title: e.showerName,
    timeLine: `${weekdayDate(e.peak, tz)}, peak`,
    shortLine: meteorTimingLine(e, tz),
    rating: e.rating ? { label: e.rating.label } : null,
    ratable: true,
  };
}

const LAUNCH_STATUS_WORD: Record<LaunchSkyEvent["status"], string> = {
  Go: "Go",
  TBD: "Not yet confirmed",
  Hold: "On hold",
  Success: "Success",
  Failure: "Failure",
  Cancelled: "Cancelled",
  "In Flight": "In flight",
};

/** "Window 9:15–10:30 PM, Wed, Oct 8" for Minute precision; otherwise
 *  "[coarse date] — time not set" (§7's card rule — a countdown is never
 *  shown, or implied, for anything coarser than Minute precision). */
export function launchTimeLine(e: LaunchSkyEvent, tz: string): string {
  if (e.netPrecision === "Minute") {
    return `Window ${fmtRange(e.windowStart, e.windowEnd, tz)}, ${weekdayDate(e.net, tz)}`;
  }
  return `${coarseLaunchDate(e.net, e.netPrecision, tz)} — time not set`;
}

function coarseLaunchDate(iso: string, precision: LaunchSkyEvent["netPrecision"], tz: string): string {
  const d = new Date(iso);
  switch (precision) {
    case "Hour":
    case "Day":
      return weekdayDate(iso, tz);
    case "Month":
      return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: tz }).format(d);
    case "Quarter": {
      const month = Number(
        new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: tz }).format(d),
      );
      const quarter = Math.ceil(month / 3);
      const year = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: tz }).format(d);
      return `Q${quarter} ${year}`;
    }
    case "Year":
      return new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: tz }).format(d);
    default:
      return "Date not set";
  }
}

function describeLaunch(e: LaunchSkyEvent, tz: string, nowMs: number): RowCopy {
  const lines = [e.whereToLook.line];
  if (e.padLightState === "twilight" || e.observerLightState === "twilight") {
    lines.push("Twilight launch. A bright plume may be visible.");
  }
  lines.push(`Status: ${LAUNCH_STATUS_WORD[e.status]}.`);

  const netMs = Date.parse(e.net);
  // A countdown only for Minute precision, still in the future, and never
  // for Hold — a stale minute-precision `net` on hold must not tick past
  // zero (§7).
  const countdownTargetIso =
    e.netPrecision === "Minute" && e.status !== "Hold" && Number.isFinite(netMs) && netMs > nowMs
      ? e.net
      : undefined;

  return {
    icon: "🚀",
    title: e.name,
    timeLine: launchTimeLine(e, tz),
    shortLine: lines.join(" "),
    rating: e.rating ? { label: e.rating.label } : null,
    ratable: true,
    countdownTargetIso,
  };
}

/** "Launches in 2h 14m." / "Launches in 42m." / a graceful "window open now"
 *  once the countdown reaches zero (rather than ever going negative) —
 *  ticks against the caller's live clock, hydration-safe (§9's convention). */
export function countdownLabel(targetIso: string, nowMs: number): string | null {
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return "Launch window open now.";
  const totalMin = Math.round(diffMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const parts = [h > 0 ? `${h}h` : null, `${m}m`].filter((p): p is string => p != null);
  return `Launches in ${parts.join(" ")}.`;
}

// --- small formatting/lookup helpers -----------------------------------------

/** "Thu, Oct 15" — short weekday + short date, beach-local. */
export function weekdayDate(iso: string, tz: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(iso));
  return `${weekday}, ${fmtDate(iso, tz)}`;
}

/** "Thu, Oct 15, 11:42 AM" — weekday + date + time, beach-local. */
export function weekdayDateTime(iso: string, tz: string): string {
  return `${weekdayDate(iso, tz)}, ${fmtTime(iso, tz)}`;
}

/** "7:18–8:03 PM" — one meridiem when both ends share it, two when they
 *  don't (a window crossing noon or midnight). Same shape as
 *  SunQualityCard.tsx's private `fmtRange`, duplicated rather than imported
 *  (small pure helper, keeps this module self-contained per repo
 *  convention). */
function fmtRange(startIso: string, endIso: string, tz: string): string {
  const a = fmtTime(startIso, tz);
  const b = fmtTime(endIso, tz);
  const [aTime, aMer] = a.split(" ");
  const [, bMer] = b.split(" ");
  return aMer && aMer === bMer ? `${aTime}–${b}` : `${a}–${b}`;
}

function ratingColor(label: SkyRatingLabel): string {
  return SUN_QUALITY_BANDS.find((b) => b.label === label)?.color ?? SUN_QUALITY_BANDS[0].color;
}

function eventId(e: SkyEvent): string {
  switch (e.eventType) {
    case "tide":
      return `tide:${e.stationId}:${e.episode.start}`;
    case "eclipse":
      return `eclipse:${e.peak}`;
    case "moon":
      return `moon:${e.fullMoonInstant}`;
    case "meteor":
      return `meteor:${e.showerId}:${e.peak}`;
    case "launch":
      return `launch:${e.ll2Id}`;
  }
}

function rowKey(row: SkyEventsCardRow, i: number): string {
  const key = row.events.map(eventId).join("+");
  return key || String(i);
}
