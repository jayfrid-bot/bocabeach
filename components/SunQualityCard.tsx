"use client";

import { useEffect, useState } from "react";
import { fmtTime } from "@/lib/format";
import type { NerdInfo } from "@/lib/nerdInfo";
import {
  goldenHourTiming,
  goldenTrack,
  type GoldenHourTiming,
  type GoldenTarget,
  type GoldenWindowInput,
} from "@/lib/goldenHourTiming";
import {
  nearestHourlyPoint,
  nextSunEvent,
  peakColorTime,
  sunEventQuality,
  sunQualityBandMeta,
  type CloudMix,
  type GoldenWindowIso,
  type HorizonPath,
  type HourlyCloudPoint,
  type PeakColorTime,
  type SunEventKind,
  type SunEventQuality,
  type SunEventTime,
} from "@/lib/sunQuality";
import { FlipCard, NerdBack } from "@/components/FlipCard";

// Gradient stops line up with lib/sunQuality.ts's BAND_CUTOFFS (dud <20,
// plain <45, good <70, vivid <90, epic >=90) — same idiom as
// StormActivityMeter/AirQualityMeter's meter gradients.
const GRADIENT =
  "linear-gradient(to right, #64748b 20%, #94a3b8 45%, #fbbf24 70%, #fb923c 90%, #f97316 100%)";

/** The golden window itself, drawn on the timeline track: amber → orange → rose,
 *  the light the window is named for. No illustration, just the segment. */
const GOLDEN_SEGMENT = "linear-gradient(to right, #fbbf24, #fb923c, #fb7185)";

/** How close (minutes) the event must be for a "right now" satellite beam-path
 *  reading to speak for it — a live cloud observation can't vouch for a sunrise
 *  hours away. Aligns with nearestHourlyPoint's forecast tolerance. */
const BEAM_IMMINENT_MINUTES = 90;

export interface SunQualityCardProps {
  /** Current instant; injectable for tests/SSR determinism. Defaults to now. */
  now?: Date;
  /** IANA timezone for the displayed time, e.g. "America/New_York". */
  tz: string;
  /** Today's sun times (ISO strings) + real elevation golden windows, e.g. from
   *  lib/sources/sun.ts's SunData. */
  today: {
    sunrise?: string;
    sunset?: string;
    goldenAm?: GoldenWindowIso;
    goldenEve?: GoldenWindowIso;
  };
  /** Tomorrow's sunrise (ISO) + its morning golden window — used once today's
   *  windows have closed. */
  tomorrow?: { sunriseIso?: string; goldenAm?: GoldenWindowIso };
  /** Hourly forecast cloud/humidity points to read the event-hour reading from. */
  hourly: readonly HourlyCloudPoint[];
  /** Current air-clarity reading (aerosol optical depth + PM2.5) — a small
   *  modifier on the color score. Optional/honest-null. */
  airQuality?: { aod?: number; pm2_5?: number } | null;
  /** Satellite beam/horizon-path cloud right now (GOES) + its wrapper status —
   *  used as the clear-path input ONLY when fresh and the event is imminent. */
  goesCloud?: { beamCloudPct?: number | null; cloudPct?: number; status?: string } | null;
}

function eventIcon(event: SunEventKind): string {
  return event === "sunrise" ? "🌅" : "🌇";
}

function eventLabel(event: SunEventKind): string {
  return event === "sunrise" ? "Sunrise" : "Sunset";
}

/** A COMPLETE low/mid/high split — the only case the level-based curve trusts
 *  (see lib/sunQuality.ts). A partial split falls back to the total-cloud path. */
function hasCompleteLevelSplit(cloud: CloudMix | undefined): boolean {
  return !!cloud && cloud.lowPct != null && cloud.midPct != null && cloud.highPct != null;
}

function cloudLine(cloud: CloudMix | undefined): string {
  if (!cloud) return "No forecast cloud reading for this hour.";
  if (hasCompleteLevelSplit(cloud)) {
    return `low ${cloud.lowPct}% · mid ${cloud.midPct}% · high ${cloud.highPct}%`;
  }
  if (cloud.totalPct != null) {
    return `${cloud.totalPct}% total cloud (level split not available)`;
  }
  return "No forecast cloud reading for this hour.";
}

/**
 * Resolve the satellite beam/horizon-path clearness for the factor model —
 * present (with `fresh:true`) only when GOES delivered a reading, its wrapper is
 * "ok" (not stale), and the event is within BEAM_IMMINENT_MINUTES of `now`
 * (deterministic: `now` is the server-pinned snapshot time, so SSR and hydration
 * agree). Beam-path cloud is preferred; overhead cloudPct is the honest fallback.
 */
function resolveHorizon(
  goes: SunQualityCardProps["goesCloud"],
  eventIso: string,
  now: Date,
): HorizonPath | undefined {
  if (!goes || goes.status !== "ok") return undefined;
  const pct = goes.beamCloudPct ?? goes.cloudPct;
  if (pct == null) return undefined;
  const dt = Math.abs(Date.parse(eventIso) - now.getTime());
  if (!Number.isFinite(dt)) return undefined;
  const fresh = dt <= BEAM_IMMINENT_MINUTES * 60_000;
  return { cloudPct: pct, fresh };
}

/** Builds the flip-card back's NerdInfo. When the richer factor model ran, the
 *  transparent per-factor breakdown leads (the spinoff app's differentiator);
 *  otherwise the simpler cloud-canvas explainer stands. Self-contained (no
 *  lib/nerdInfo.ts registry entry) — see the integration note in lib/sunQuality.ts. */
function buildSunQualityNerdInfo(args: {
  event: SunEventKind;
  timeIso: string;
  tz: string;
  cloud: CloudMix | undefined;
  humidityPct: number | undefined;
  result: SunEventQuality;
  peakLine: string | null;
  goldenLine: string;
}): NerdInfo {
  const { event, timeIso, tz, cloud, humidityPct, result, peakLine, goldenLine } = args;
  const meta = result.band ? sunQualityBandMeta(result.band) : null;
  const time = fmtTime(timeIso, tz);
  const knownTotalOnly = !hasCompleteLevelSplit(cloud) && !!cloud && cloud.totalPct != null;
  const b = result.breakdown;

  const computation: string[] =
    result.score == null
      ? ["No forecast cloud reading for this hour yet."]
      : b
        ? [
            // Transparent factor-by-factor breakdown — each shown plainly.
            `Horizon path: ${b.horizonPath}`,
            `Cloud canvas: ${b.cloudCanvas}`,
            ...(b.airClarity ? [`Air clarity: ${b.airClarity}`] : []),
            ...(b.humidity ? [`Humidity: ${b.humidity}`] : []),
            `→ ${result.score}/100 (${result.band})`,
            goldenLine,
            ...(peakLine ? [peakLine] : []),
          ]
        : [
            `${cloudLine(cloud)} at ${time}`,
            ...(humidityPct != null ? [`${humidityPct}% humidity`] : []),
            `→ ${result.score}/100 (${result.band})`,
            goldenLine,
            ...(peakLine ? [peakLine] : []),
          ];

  return {
    title: `${eventLabel(event)} color potential`,
    weightPct: null,
    // The band scale + the cloud-mix sentence live here (not on the front) so
    // the front stays at standard tile density — see SunQualityFront.
    visual: (
      <div>
        <div className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
          How colorful the next sunrise or sunset should be, judged from the cloud mix.
        </div>
        <div className="relative mt-2 h-2 rounded-full" style={{ background: GRADIENT }}>
          {result.score != null && meta ? (
            <div
              className="absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-2 ring-slate-900"
              style={{ left: `${Math.min(100, Math.max(0, result.score))}%` }}
              aria-hidden
            />
          ) : null}
        </div>
        <div className="mt-1.5 break-words text-xs leading-snug text-slate-600 dark:text-slate-400">
          {result.note}
        </div>
      </div>
    ),
    explainer:
      "How colorful will this sunrise or sunset be — rich color, or clear but plain? The best ones aren't the clearest ones — they need a mid/high cloud DECK to act as a canvas the low sun's red and orange light can paint onto, AND a clear enough horizon for that low beam to reach it. Golden hour is the low-angle window itself: the sun from +6° above the horizon down to −4° below it — so it straddles the sunrise/sunset, not stopping at it. Roughly 30-60% mid/high cloud is the color sweet spot; a perfectly clear sky is clean but plain; and a heavy LOW cloud deck sitting on the horizon blocks the beam before it reaches whatever's above.",
    formula:
      "score = 0.40·clearPath + 0.40·canvas + 0.20·seasonalPrior, × aerosol × humidity modifiers. clearPath = 100 − beam-path cloud% (satellite, when a fresh sample is near the event) else 100 − low-cloud est. canvas = 100 − |0.5·mid + 0.7·high − 50|·2.2 − 0.9·low (high cloud weighted above mid). Modifiers: clean air (AOD<0.15) small bonus, haze/PM2.5 penalties (−25%/−35% caps), humidity >60% penalty (−15% cap). Peak color lags to the sun's −2°→−4° window when there's a high-cloud deck. Every constant is a tuned heuristic except the low-cloud clear-path blocker (Corfidi/NOAA). Without the atmospheric/satellite inputs, a simpler cloud-canvas curve is used instead. Golden/blue-hour times come from a solar-elevation solve (+6°/−4°/−6°), not a fixed 60-min window.",
    computation,
    sources: [
      "Open-Meteo hourly forecast — cloud cover by level (low/mid/high) + humidity",
      "Open-Meteo air quality — aerosol optical depth (CAMS) + PM2.5",
      "NOAA GOES-19 ABI — beam-path cloud (horizon clearness), when fresh",
      "Sun/golden-hour times — computed locally (NOAA solar-position algorithm)",
    ],
    notes: knownTotalOnly
      ? "Cloud-by-level wasn't available for this hour, so this falls back to total cloud cover on a flatter, more conservative curve — the real color potential could be higher or lower."
      : b && b.horizonPath.startsWith("~")
        ? "The horizon path here is estimated from low cloud, not confirmed by satellite (no fresh beam-path sample near the event) — treat clear-path as a best guess."
        : "Needs BOTH a moderate mid/high deck AND a low deck that stays out of the way. Peak-color timing and the modifiers are research-informed heuristics, not guarantees.",
  };
}

/** "Peak color ~8:22 PM (11 min after sunset)" / "…(11 min before sunrise)" /
 *  "…around sunset" — the flip back's line. Null without a peak time. */
function peakColorLine(peak: PeakColorTime | null, event: SunEventKind, tz: string): string | null {
  if (!peak) return null;
  const at = fmtTime(peak.iso, tz);
  const m = peak.minutesFromEvent;
  if (m === 0) return `Peak color ~${at} (around ${event})`;
  const rel = m > 0 ? `${m} min after ${event}` : `${-m} min before ${event}`;
  return `Peak color ~${at} (${rel})`;
}

/** "7:18–8:03 PM" — one meridiem when both ends share it, two when they don't
 *  (a window that crosses noon or midnight). */
function fmtRange(startIso: string, endIso: string, tz: string): string {
  const a = fmtTime(startIso, tz);
  const b = fmtTime(endIso, tz);
  const [aTime, aMer] = a.split(" ");
  const [, bMer] = b.split(" ");
  return aMer && aMer === bMer ? `${aTime}–${b}` : `${a}–${b}`;
}

/** The card's ISO windows in the shape lib/goldenHourTiming.ts wants. Undefined
 *  when the snapshot didn't carry that elevation window. */
function toWindow(w: GoldenWindowIso | undefined): GoldenWindowInput | undefined {
  if (!w?.goldenStartIso || !w.goldenEndIso) return undefined;
  return { start: w.goldenStartIso, end: w.goldenEndIso, peakAnchorIso: w.peakAnchorIso };
}

/** The sun event a timing target is built around, in lib/sunQuality.ts's shape,
 *  so the color score and the flip back describe the window the front shows. */
function targetEvent(target: GoldenTarget | null): SunEventTime | null {
  if (!target?.eventIso) return null;
  return {
    event: target.kind === "am" ? "sunrise" : "sunset",
    timeIso: target.eventIso,
    goldenStartIso: target.start.toISOString(),
    goldenEndIso: target.end.toISOString(),
    goldenFromElevation: true,
    peakAnchorIso: target.peakAnchorIso,
  };
}

/**
 * The timeline track — the card's only graphic. A thin rail spanning a fixed
 * stretch around the golden window (90 min before it opens to 30 min after it
 * closes), the window drawn as a warm segment, three ticks (window open, the
 * sun event, window close) and a "now" marker. No illustration: the geometry
 * IS the information. Pure positions from the `now` it is handed, so the server
 * and the client draw the same track.
 */
function GoldenTrack({
  target,
  nowMs,
  during,
  tz,
}: {
  target: GoldenTarget;
  nowMs: number;
  during: boolean;
  tz: string;
}) {
  const track = goldenTrack(target, nowMs);
  const eventWord = target.kind === "am" ? "sunrise" : "sunset";
  const width = Math.max(1, track.endPct - track.startPct);
  // Labels are nudged in from the rail's ends so a 10px word can't spill out of
  // the card; the ticks themselves stay at their true time positions.
  const labelAt = (pct: number) => Math.min(92, Math.max(8, pct));

  const ticks: { pct: number; text: string }[] = [
    { pct: track.startPct, text: "golden" },
    ...(track.eventPct != null ? [{ pct: track.eventPct, text: eventWord }] : []),
    { pct: track.endPct, text: "end" },
  ];

  return (
    <div
      className="mt-3"
      role="img"
      aria-label={`Golden hour ${fmtRange(target.start.toISOString(), target.end.toISOString(), tz)}${
        target.eventIso ? `, ${eventWord} ${fmtTime(target.eventIso, tz)}` : ""
      }`}
    >
      <div className="relative h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className={`absolute inset-y-0 rounded-full ${during ? "ring-1 ring-amber-300/70" : ""}`}
          style={{
            left: `${track.startPct}%`,
            width: `${width}%`,
            background: GOLDEN_SEGMENT,
            boxShadow: during ? "0 0 10px 1px rgba(251, 146, 60, 0.6)" : undefined,
          }}
          aria-hidden
        />
        {/* "now": a 2px rule through the rail with a dot on top. Pinned to the
            nearest edge (and dimmed) when now falls outside the drawn span. */}
        <div
          className={`absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full ${
            during ? "bg-amber-500" : "bg-slate-500 dark:bg-slate-300"
          } ${track.nowOutside ? "opacity-40" : ""}`}
          style={{ left: `${track.nowPct}%` }}
          aria-hidden
        />
        <div
          className={`absolute -top-[7px] h-1.5 w-1.5 -translate-x-1/2 rounded-full ${
            during ? "bg-amber-500" : "bg-slate-500 dark:bg-slate-300"
          } ${track.nowOutside ? "opacity-40" : ""}`}
          style={{ left: `${track.nowPct}%` }}
          aria-hidden
        />
      </div>

      <div className="relative h-1" aria-hidden>
        {ticks.map((t) => (
          <span
            key={t.text}
            className="absolute top-0 h-1 w-px -translate-x-1/2 bg-slate-300 dark:bg-slate-600"
            style={{ left: `${t.pct}%` }}
          />
        ))}
      </div>
      <div className="relative h-3" aria-hidden>
        {ticks.map((t) => (
          <span
            key={t.text}
            className="absolute top-0 -translate-x-1/2 text-[10px] leading-3 text-slate-400 dark:text-slate-500"
            style={{ left: `${labelAt(t.pct)}%` }}
          >
            {t.text}
          </span>
        ))}
      </div>
    </div>
  );
}

function SunQualityFront({
  timing,
  nowMs,
  tz,
  scored,
  result,
  peak,
}: {
  /** Where we stand relative to the next golden window. */
  timing: GoldenHourTiming;
  /** The instant the track is drawn for — the pinned snapshot time on the
   *  server and first paint, the live clock after mount. */
  nowMs: number;
  tz: string;
  /** The sun event the color score belongs to (null when there are no times). */
  scored: SunEventTime | null;
  result: SunEventQuality;
  peak: PeakColorTime | null;
}) {
  const target = timing.target;
  const during = timing.phase === "during";
  const kind: SunEventKind = target
    ? target.kind === "am"
      ? "sunrise"
      : "sunset"
    : (scored?.event ?? "sunset");

  const meta = result.band ? sunQualityBandMeta(result.band) : null;
  const colorLine =
    result.score == null || !meta
      ? `${eventLabel(kind)} color: —`
      : `${eventLabel(kind)} color: ${meta.label}${
          peak ? ` · peak color ~${fmtTime(peak.iso, tz)}` : ""
        }`;

  const windowStart = target ? target.start.toISOString() : scored?.goldenStartIso;
  const windowEnd = target ? target.end.toISOString() : scored?.goldenEndIso;
  const eventIso = target?.eventIso ?? scored?.timeIso;
  const timesLine =
    windowStart && windowEnd
      ? `${fmtRange(windowStart, windowEnd, tz)}${
          eventIso ? ` · ${kind} ${fmtTime(eventIso, tz)}` : ""
        }`
      : " ";

  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>{eventIcon(kind)}</span>
        <span className="truncate">Golden hour</span>
      </div>

      <div className="flex flex-1 flex-col justify-center">
        {/* The countdown IS the headline — it's what you open this tile for. */}
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xl font-semibold leading-tight tabular-nums text-slate-900 dark:text-white sm:text-2xl">
            {/* Keep "2h 14m" on one line — the wrap split "7h / 7m" in the 4-col grid. */}
            {timing.headline.replace(/(\d+h) (\d+m)/, "$1\u00a0$2")}
          </span>
          {timing.badge ? (
            <span
              className={`text-xs font-medium tabular-nums ${
                during
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {timing.badge}
            </span>
          ) : null}
        </div>

        {/* Two lines allowed: in the mobile 2-up grid the full window + event
            won't fit one line, and these times are the point of the card. */}
        <div
          className="mt-1 min-h-4 text-xs leading-snug tabular-nums text-slate-500 dark:text-slate-400 line-clamp-2"
          title={timesLine.trim() || undefined}
        >
          {timesLine}
        </div>

        {target ? <GoldenTrack target={target} nowMs={nowMs} during={during} tz={tz} /> : null}

        {/* Two lines allowed at every width, matching timesLine above: with a
            "Vivid"/"Sunrise" band label plus the "· peak color ~H:MM AM/PM"
            suffix, this line can run long enough to wrap even in the wider
            4-col desktop card (~200px) — a `sm:line-clamp-1` here once
            clipped it mid-sentence on desktop (caught by e2e/layout.spec.ts;
            the phone-width fix alone wasn't sufficient at every width). */}
        <div
          className="mt-3 min-h-4 text-xs tabular-nums text-slate-500 dark:text-slate-400 line-clamp-2"
          title={colorLine}
        >
          {colorLine}
        </div>
      </div>
    </div>
  );
}

/**
 * "Golden hour" card: how long until the next golden hour (or how long is left
 * once you're standing in it), the exact window and its sunrise/sunset, a plain
 * timeline that lights up while the window is open, and — demoted to one quiet
 * line — how colorful that sunrise/sunset should be (lib/sunQuality.ts's factor
 * model off the forecast cloud mix + air clarity + satellite horizon), with the
 * peak-color time. Self-contained and props-driven — matches the
 * FlipCard(front/back) convention used across ConditionsDashboard.tsx. Renders a
 * "no sun times" front when there's genuinely nothing to show.
 *
 * The window straddles its event (+6°→−4°), so the countdown follows the WINDOW,
 * not the event — see lib/goldenHourTiming.ts. That's why this card no longer
 * leans on `nextSunEvent` for its timing: between sunset and the window's close
 * the "next event" is already tomorrow's sunrise, while golden hour is happening.
 *
 * HYDRATION SAFETY: `now` (from the caller) pins the server render, the color
 * score and the deterministic satellite-freshness gate to the snapshot's
 * generatedAt. The live countdown and the track's "now" marker additionally read
 * a client-only clock (`clientNowMs`, null until mount), so the server HTML and
 * the first client render agree exactly.
 */
export function SunQualityCard({
  now,
  tz,
  today,
  tomorrow,
  hourly,
  airQuality,
  goesCloud,
}: SunQualityCardProps) {
  const nowD = now ?? new Date();

  const [clientNowMs, setClientNowMs] = useState<number | null>(null);
  useEffect(() => {
    setClientNowMs(Date.now());
    const id = setInterval(() => setClientNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const fmt = (d: Date) => fmtTime(d.toISOString(), tz);

  // Real elevation windows when the snapshot carries them; otherwise fall back
  // to whatever window `nextSunEvent` can build (an older snapshot's ±60-min
  // approximation), so the card still counts down rather than going blank.
  const next = nextSunEvent(nowD, today, tomorrow);
  const realWindows = { am: toWindow(today.goldenAm), eve: toWindow(today.goldenEve) };
  const hasReal = !!realWindows.am || !!realWindows.eve;
  const fallback: GoldenWindowInput | undefined = next
    ? { start: next.goldenStartIso, end: next.goldenEndIso, peakAnchorIso: next.peakAnchorIso }
    : undefined;
  const sunsetMs = today.sunset ? Date.parse(today.sunset) : Number.NaN;
  const fallbackIsTomorrow =
    !!next && next.event === "sunrise" && Number.isFinite(sunsetMs) && nowD.getTime() >= sunsetMs;

  const timingArgs = {
    windows: hasReal
      ? realWindows
      : fallbackIsTomorrow
        ? {}
        : next?.event === "sunrise"
          ? { am: fallback }
          : { eve: fallback },
    sunrise: today.sunrise,
    sunset: today.sunset,
    tomorrowAmWindow: hasReal
      ? toWindow(tomorrow?.goldenAm)
      : fallbackIsTomorrow
        ? fallback
        : undefined,
    tomorrowSunrise: tomorrow?.sunriseIso ?? (fallbackIsTomorrow ? next?.timeIso : undefined),
    formatTime: fmt,
  };

  // Pinned timing drives everything the server must reproduce (the scored event,
  // the color score, the flip back); the live one only refreshes the countdown
  // and the marker after mount.
  const pinned = goldenHourTiming({ ...timingArgs, now: nowD });
  const live = clientNowMs == null ? pinned : goldenHourTiming({ ...timingArgs, now: clientNowMs });

  const scored = targetEvent(pinned.target) ?? next;

  if (!scored) {
    return (
      <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>🌅</span>
          <span>Golden hour</span>
        </div>
        <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No sun times for this beach right now.
        </div>
      </div>
    );
  }

  const point = nearestHourlyPoint(scored.timeIso, hourly);
  const horizon = resolveHorizon(goesCloud, scored.timeIso, nowD);
  const result = sunEventQuality({
    cloud: point?.cloud,
    humidityPct: point?.humidityPct,
    aod: airQuality?.aod,
    pm2_5: airQuality?.pm2_5,
    horizon,
  });

  // A rough clear-path estimate purely for the peak-color "reasonably clear"
  // gate (mirrors the factor model's clearPath: fresh beam, else low-cloud est.).
  const clearPathEstimate = horizon?.fresh
    ? Math.max(0, 100 - horizon.cloudPct)
    : point?.cloud.lowPct != null
      ? Math.max(0, 100 - point.cloud.lowPct * 1.1)
      : undefined;
  const peak = peakColorTime({
    event: scored.event,
    eventIso: scored.timeIso,
    peakAnchorIso: scored.peakAnchorIso,
    highPct: point?.cloud.highPct,
    clearPathScore: clearPathEstimate,
  });
  const peakLine = peakColorLine(peak, scored.event, tz);
  const goldenLine = scored.goldenFromElevation
    ? `Golden hour ${fmtTime(scored.goldenStartIso, tz)}–${fmtTime(scored.goldenEndIso, tz)} (true elevation window)`
    : `Golden hour ${fmtTime(scored.goldenStartIso, tz)}–${fmtTime(scored.goldenEndIso, tz)} (≈60-min estimate)`;

  const info = buildSunQualityNerdInfo({
    event: scored.event,
    timeIso: scored.timeIso,
    tz,
    cloud: point?.cloud,
    humidityPct: point?.humidityPct,
    result,
    peakLine,
    goldenLine,
  });

  return (
    <FlipCard
      label="Golden hour"
      front={
        <SunQualityFront
          timing={live}
          nowMs={clientNowMs ?? nowD.getTime()}
          tz={tz}
          scored={scored}
          result={result}
          peak={peak}
        />
      }
      back={<NerdBack info={info} />}
    />
  );
}
