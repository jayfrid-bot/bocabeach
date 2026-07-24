"use client";

import { useEffect, useState } from "react";
import { fmtTime } from "@/lib/format";
import type { NerdInfo } from "@/lib/nerdInfo";
import {
  goldenHourProgress,
  nearestHourlyPoint,
  nextSunEvent,
  peakColorTime,
  sunEventQuality,
  sunQualityBandMeta,
  type CloudMix,
  type GoldenWindowIso,
  type HorizonPath,
  type HourlyCloudPoint,
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

// Warm sunrise→sunset progress-bar gradient for the live golden-hour track —
// same quiet "gradient fill on a rounded track" idiom as MoonPanel's cycle
// progress bar, just warmed up to match this card's subject.
const GOLDEN_PROGRESS_GRADIENT = "linear-gradient(to right, #f59e0b, #fb923c, #f97316)";

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
   *  sunset has passed. */
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
    explainer:
      "Will the sky put on a color show, or is it a clear-but-plain bust? The best sunrises and sunsets aren't the clearest ones — they need a mid/high cloud DECK to act as a canvas the low sun's red and orange light can paint onto, AND a clear enough horizon for that low beam to reach it. Golden hour is the low-angle window itself: the sun from +6° above the horizon down to −4° below it — so it straddles the sunrise/sunset, not stopping at it. Roughly 30-60% mid/high cloud is the color sweet spot; a perfectly clear sky is clean but plain; and a heavy LOW cloud deck sitting on the horizon blocks the beam before it reaches whatever's above.",
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

/** "Sunset 8:11 PM · golden hour 7:39–8:27 PM" — the true elevation window,
 *  which for a sunset runs PAST sunset (down to the sun at −4°). All times in `tz`. */
function eventTimeLine(next: SunEventTime, tz: string): string {
  const eventTime = fmtTime(next.timeIso, tz);
  const goldenStart = fmtTime(next.goldenStartIso, tz);
  const goldenEnd = fmtTime(next.goldenEndIso, tz);
  return `${eventLabel(next.event)} ${eventTime} · golden hour ${goldenStart}–${goldenEnd}`;
}

/** "Peak color ~8:22 PM (11 min after sunset)" / "…(11 min before sunrise)" /
 *  "…around sunset". Null when there's no usable event time. */
function peakColorLine(
  next: SunEventTime,
  tz: string,
  cloud: CloudMix | undefined,
  clearPathEstimate: number | undefined,
): string | null {
  const peak = peakColorTime({
    event: next.event,
    eventIso: next.timeIso,
    peakAnchorIso: next.peakAnchorIso,
    highPct: cloud?.highPct,
    clearPathScore: clearPathEstimate,
  });
  if (!peak) return null;
  const at = fmtTime(peak.iso, tz);
  const m = peak.minutesFromEvent;
  if (m === 0) return `Peak color ~${at} (around ${next.event})`;
  const rel = m > 0 ? `${m} min after ${next.event}` : `${-m} min before ${next.event}`;
  return `Peak color ~${at} (${rel})`;
}

function SunQualityFront({
  next,
  tz,
  result,
  progress,
  peakLine,
}: {
  next: SunEventTime;
  tz: string;
  result: SunEventQuality;
  /** 0-100 when `now` is live and inside the golden-hour window; null
   *  otherwise (pre-mount, or simply outside the window). */
  progress: number | null;
  peakLine: string | null;
}) {
  const { score, band, note } = result;
  const meta = band ? sunQualityBandMeta(band) : null;
  const pct = Math.min(100, Math.max(0, score ?? 0));

  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>{eventIcon(next.event)}</span>
        <span>Golden hour</span>
      </div>

      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        How colorful the next sunrise/sunset should look, judged from the cloud mix.
      </div>

      <div className="mt-2 flex flex-1 flex-col justify-center">
        {score == null || !meta ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">No forecast yet.</div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-slate-900 dark:text-white sm:text-3xl">
                {score}
              </span>
              <span className="text-xs font-medium" style={{ color: meta.color }}>
                {meta.label}
              </span>
            </div>
            <div className="relative mt-2.5 h-2 rounded-full" style={{ background: GRADIENT }}>
              <div
                className="absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-2 ring-slate-900"
                style={{ left: `${pct}%` }}
                aria-hidden
              />
            </div>
          </>
        )}
        <div className="mt-2 min-h-8 break-words text-xs text-slate-600 dark:text-slate-400 line-clamp-3">
          {note}
        </div>
        {peakLine ? (
          <div className="mt-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            {peakLine}
          </div>
        ) : null}
      </div>

      <div className="mt-2 border-t border-slate-900/10 pt-2 dark:border-white/10">
        {progress != null ? (
          <>
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>In golden hour now</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="relative mt-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className="h-1.5 rounded-full"
                style={{ width: `${progress}%`, background: GOLDEN_PROGRESS_GRADIENT }}
              />
            </div>
          </>
        ) : (
          <div className="text-xs text-slate-600 dark:text-slate-400">{eventTimeLine(next, tz)}</div>
        )}
      </div>
    </div>
  );
}

/**
 * "Golden hour" card: when the next golden hour is (the TRUE elevation window,
 * +6°→−4°, which straddles the sun event rather than stopping at it), whether
 * sunrise or sunset is next, a live in-window progress track, how colorful it
 * should look (lib/sunQuality.ts's factor model off the forecast cloud mix +
 * air clarity + satellite horizon), and when color should peak.
 * Self-contained and props-driven — matches the FlipCard(front/back) +
 * MetricCard-style front convention used across ConditionsDashboard.tsx. Renders
 * a "no sun times" front when there's genuinely nothing to show.
 *
 * HYDRATION SAFETY: `now` (from the caller) pins the server render and the
 * event/score selection — including the deterministic satellite-freshness gate —
 * to the snapshot's generatedAt for SSR stability. The live golden-hour progress
 * bar is additionally gated on a client-only clock (`clientNowMs`, null until
 * mount) so the server HTML and first client render agree exactly.
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
  const next = nextSunEvent(nowD, today, tomorrow);

  const [clientNowMs, setClientNowMs] = useState<number | null>(null);
  useEffect(() => {
    setClientNowMs(Date.now());
    const id = setInterval(() => setClientNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!next) {
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

  const point = nearestHourlyPoint(next.timeIso, hourly);
  const horizon = resolveHorizon(goesCloud, next.timeIso, nowD);
  const result = sunEventQuality({
    cloud: point?.cloud,
    humidityPct: point?.humidityPct,
    aod: airQuality?.aod,
    pm2_5: airQuality?.pm2_5,
    horizon,
  });

  // A rough clear-path estimate purely for the peak-color "reasonably clear"
  // gate (mirrors the factor model's clearPath: fresh beam, else low-cloud est.).
  const clearPathEstimate =
    horizon?.fresh
      ? Math.max(0, 100 - horizon.cloudPct)
      : point?.cloud.lowPct != null
        ? Math.max(0, 100 - point.cloud.lowPct * 1.1)
        : undefined;
  const peakLine = peakColorLine(next, tz, point?.cloud, clearPathEstimate);
  const goldenLine = next.goldenFromElevation
    ? `Golden hour ${fmtTime(next.goldenStartIso, tz)}–${fmtTime(next.goldenEndIso, tz)} (true elevation window)`
    : `Golden hour ${fmtTime(next.goldenStartIso, tz)}–${fmtTime(next.goldenEndIso, tz)} (≈60-min estimate)`;

  const info = buildSunQualityNerdInfo({
    event: next.event,
    timeIso: next.timeIso,
    tz,
    cloud: point?.cloud,
    humidityPct: point?.humidityPct,
    result,
    peakLine,
    goldenLine,
  });

  // Live progress only once the client clock has landed post-mount, so SSR
  // and hydration render the same "no bar yet" state.
  const progress = clientNowMs != null ? goldenHourProgress(new Date(clientNowMs), next) : null;

  return (
    <FlipCard
      label="Golden hour"
      front={<SunQualityFront next={next} tz={tz} result={result} progress={progress} peakLine={peakLine} />}
      back={<NerdBack info={info} />}
    />
  );
}
