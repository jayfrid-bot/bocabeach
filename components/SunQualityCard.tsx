import { fmtTime } from "@/lib/format";
import type { NerdInfo } from "@/lib/nerdInfo";
import {
  nearestHourlyPoint,
  nextSunEvent,
  sunEventQuality,
  sunQualityBandMeta,
  type CloudMix,
  type HourlyCloudPoint,
  type SunEventKind,
  type SunEventQuality,
} from "@/lib/sunQuality";
import { FlipCard, NerdBack } from "@/components/FlipCard";

// Gradient stops line up with lib/sunQuality.ts's BAND_CUTOFFS (dud <20,
// plain <45, good <70, vivid <90, epic >=90) — same idiom as
// StormActivityMeter/AirQualityMeter's meter gradients.
const GRADIENT =
  "linear-gradient(to right, #64748b 20%, #94a3b8 45%, #fbbf24 70%, #fb923c 90%, #f97316 100%)";

export interface SunQualityCardProps {
  /** Current instant; injectable for tests/SSR determinism. Defaults to now. */
  now?: Date;
  /** IANA timezone for the displayed time, e.g. "America/New_York". */
  tz: string;
  /** Today's sun times (ISO strings), e.g. from lib/sources/sun.ts's SunData. */
  today: { sunrise?: string; sunset?: string };
  /** Tomorrow's sunrise (ISO) — only used once today's sunset has passed. */
  tomorrowSunrise?: string;
  /** Hourly forecast cloud/humidity points to read the event-hour reading from. */
  hourly: readonly HourlyCloudPoint[];
}

function eventIcon(event: SunEventKind): string {
  return event === "sunrise" ? "🌅" : "🌇";
}

function eventLabel(event: SunEventKind): string {
  return event === "sunrise" ? "Sunrise" : "Sunset";
}

function cloudLine(cloud: CloudMix | undefined): string {
  if (!cloud) return "No forecast cloud reading for this hour.";
  const hasLevel = cloud.lowPct != null || cloud.midPct != null || cloud.highPct != null;
  if (hasLevel) {
    return `low ${cloud.lowPct ?? 0}% · mid ${cloud.midPct ?? 0}% · high ${cloud.highPct ?? 0}%`;
  }
  if (cloud.totalPct != null) {
    return `${cloud.totalPct}% total cloud (level split not available)`;
  }
  return "No forecast cloud reading for this hour.";
}

/** Builds the flip-card back's NerdInfo locally (no lib/nerdInfo.ts registry
 *  entry — this module stays fully self-contained; see the integration note
 *  in lib/sunQuality.ts for wiring this into that registry later). */
function buildSunQualityNerdInfo(args: {
  event: SunEventKind;
  timeIso: string;
  tz: string;
  cloud: CloudMix | undefined;
  humidityPct: number | undefined;
  result: SunEventQuality;
}): NerdInfo {
  const { event, timeIso, tz, cloud, humidityPct, result } = args;
  const time = fmtTime(timeIso, tz);
  const knownTotalOnly =
    !!cloud &&
    cloud.lowPct == null &&
    cloud.midPct == null &&
    cloud.highPct == null &&
    cloud.totalPct != null;

  const computation: string[] =
    result.score == null
      ? ["No forecast cloud reading for this hour yet."]
      : [
          `${cloudLine(cloud)} at ${time}`,
          ...(humidityPct != null ? [`${humidityPct}% humidity`] : []),
          `→ ${result.score}/100 (${result.band})`,
        ];

  return {
    title: `${eventLabel(event)} sky show`,
    weightPct: null,
    explainer:
      "Will the sky put on a color show, or is it a clear-but-plain bust? The best sunrises and sunsets aren't the clearest ones — they need a mid/high cloud DECK to act as a canvas the low sun's red and orange light can paint onto. Roughly 30-60% mid/high cloud is the sweet spot: enough surface up there to catch color, not so much it blocks the sun outright. A perfectly clear sky is clean but plain — nothing up there to paint color onto. And a heavy LOW cloud deck (near-total, ~85%+) is the opposite of magic: it sits right at the horizon and blocks the direct beam before it ever reaches whatever's above, so it can kill the show even under a promising mid/high deck.",
    formula:
      "colorCanvas = screenBlend(mid%, high%); score = curve(colorCanvas: 0%→40, 30-60%→90-97 peak, 100%→15) × lowCloudPenalty(low%: ≤30%→none, →~90% by a near-total low deck) + up to +5 for humidity <60%. Total-cloud-only readings use a flatter, lower-ceiling curve instead, since the level split (beneficial mid/high vs. blocking low) isn't known.",
    computation,
    sources: [
      "Open-Meteo hourly forecast — total cloud cover (cloud-by-level not yet fetched by this app)",
      "Sun times — computed locally (NOAA solar-position algorithm)",
    ],
    notes: knownTotalOnly
      ? "This app doesn't fetch cloud-by-level yet, so this reading falls back to total cloud cover on a flatter, more conservative curve — the real color potential could be higher or lower than shown."
      : "Needs BOTH things to line up for a truly vivid sky: a moderate mid/high deck AND a low deck that stays out of the way.",
  };
}

function SunQualityFront({
  event,
  timeIso,
  tz,
  result,
}: {
  event: SunEventKind;
  timeIso: string;
  tz: string;
  result: SunEventQuality;
}) {
  const time = fmtTime(timeIso, tz);
  const { score, band, note } = result;
  const meta = band ? sunQualityBandMeta(band) : null;
  const pct = Math.min(100, Math.max(0, score ?? 0));

  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>{eventIcon(event)}</span>
          <span>{eventLabel(event)} show</span>
        </div>
        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{time}</span>
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
      </div>
    </div>
  );
}

/**
 * Sunrise/sunset "sky show" card: scores the NEXT sun event (today's sunrise
 * if it hasn't happened, else today's sunset, else tomorrow's sunrise) for
 * how likely it is to put on a real color show, via lib/sunQuality.ts's pure
 * `sunEventQuality`. Self-contained and props-driven — matches the
 * FlipCard(front/back) + MetricCard-style front convention used across
 * ConditionsDashboard.tsx (see e.g. UvCard, StormActivityMeter). Renders a
 * "no sun times" front when there's genuinely nothing to show, rather than a
 * fabricated score.
 */
export function SunQualityCard({ now, tz, today, tomorrowSunrise, hourly }: SunQualityCardProps) {
  const nowD = now ?? new Date();
  const next = nextSunEvent(nowD, today, tomorrowSunrise);

  if (!next) {
    return (
      <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>🌅</span>
          <span>Sky show</span>
        </div>
        <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No sun times for this beach right now.
        </div>
      </div>
    );
  }

  const point = nearestHourlyPoint(next.timeIso, hourly);
  const result = sunEventQuality({ cloud: point?.cloud, humidityPct: point?.humidityPct });
  const info = buildSunQualityNerdInfo({
    event: next.event,
    timeIso: next.timeIso,
    tz,
    cloud: point?.cloud,
    humidityPct: point?.humidityPct,
    result,
  });

  return (
    <FlipCard
      label={`${eventLabel(next.event)} sky show`}
      front={<SunQualityFront event={next.event} timeIso={next.timeIso} tz={tz} result={result} />}
      back={<NerdBack info={info} />}
    />
  );
}
