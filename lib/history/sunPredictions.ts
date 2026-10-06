// Pure builder for `sun_event_predictions` rows (migrations/0013): for one
// conditions snapshot, score the NEXT sunrise and the NEXT sunset with the
// SAME `assembleSunEventQuality` the sun-color card and the push alert call
// (lib/sunAlert.ts), and keep the score together with every input behind it.
// Recording only — nothing here alters a score. No I/O, no clock reads.

import type { ConditionsResponse, Location } from "@/lib/types";
import { assembleSunEventQuality, sunQualityHourlyPoints } from "@/lib/sunAlert";
import {
  DEFAULT_SEASONAL_PRIOR,
  SUN_QUALITY_VERSION,
  sunModelPath,
  type SunEventKind,
} from "@/lib/sunQuality";
import { computeSunTimes } from "@/lib/sources/sun";
import { SCORING_ENGINE_VERSION } from "@/lib/score";
import { currentBuildSha } from "@/lib/history/archive";
import type { SunEventPredictionRow } from "@/lib/history/types";

interface PickedEvent {
  event: SunEventKind;
  timeIso: string;
  peakAnchorIso?: string;
}

const numOrNull = (v: number | undefined | null): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The next sunrise and the next sunset strictly after `nowMs` (so one event
 * of each kind, up to two entries). Today's time when it hasn't happened yet,
 * else tomorrow's — sunrise from the snapshot's own tomorrow fields, sunset
 * computed with the same solver the snapshot's sun data came from.
 */
export function nextSunEventsBoth(
  res: ConditionsResponse,
  loc: Pick<Location, "lat" | "lon">,
  nowMs: number,
): PickedEvent[] {
  const sun = res.snapshot.sun?.data;
  if (!sun) return [];
  const out: PickedEvent[] = [];

  const sunriseMs = sun.sunrise ? Date.parse(sun.sunrise) : NaN;
  if (Number.isFinite(sunriseMs) && nowMs < sunriseMs) {
    out.push({ event: "sunrise", timeIso: sun.sunrise!, peakAnchorIso: sun.goldenAmPeakIso });
  } else if (sun.tomorrowSunrise) {
    out.push({ event: "sunrise", timeIso: sun.tomorrowSunrise, peakAnchorIso: sun.tomorrowGoldenAmPeakIso });
  }

  const sunsetMs = sun.sunset ? Date.parse(sun.sunset) : NaN;
  if (Number.isFinite(sunsetMs) && nowMs < sunsetMs) {
    out.push({ event: "sunset", timeIso: sun.sunset!, peakAnchorIso: sun.goldenEvePeakIso });
  } else {
    // sun.date is the beach-local calendar day the snapshot's sun times fall on.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sun.date ?? "");
    if (m) {
      const tmr = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
      const t = computeSunTimes(loc.lat, loc.lon, tmr.getUTCFullYear(), tmr.getUTCMonth() + 1, tmr.getUTCDate());
      if (t.sunset) {
        out.push({
          event: "sunset",
          timeIso: t.sunset.toISOString(),
          peakAnchorIso: t.goldenEvePeak?.toISOString(),
        });
      }
    }
  }
  return out;
}

/**
 * Map a conditions result to its sun-event prediction rows (0-2). `opts.hourUtc`
 * is the claimed archive hour (same as `rowFromConditions`); `nowMs` only
 * stamps `archived_at`. The model's own clock is the snapshot's `generatedAt`,
 * exactly as `predictNextSunEvent` uses, so a row matches what the card would
 * have shown for that snapshot.
 */
export function sunEventRowsFromConditions(
  res: ConditionsResponse,
  loc: Pick<Location, "slug" | "lat" | "lon">,
  nowMs: number,
  opts: { hourUtc: string },
): SunEventPredictionRow[] {
  const snap = res.snapshot;
  const generatedMs = Date.parse(snap.generatedAt);
  const anchorMs = Number.isFinite(generatedMs) ? generatedMs : nowMs;
  const events = nextSunEventsBoth(res, loc, anchorMs);
  if (!events.length) return [];

  const hourly = sunQualityHourlyPoints(snap.hourly?.data);
  const goes = snap.goesCloud?.data ? { ...snap.goesCloud.data, status: snap.goesCloud.status } : null;
  const air = snap.airQuality?.data;

  return events.map((ev) => {
    const { point, horizon, horizonSource, result, peak } = assembleSunEventQuality(ev, {
      hourly,
      airQuality: air,
      goesCloud: goes,
      nowMs: anchorMs,
    });
    const path = sunModelPath({
      cloud: point?.cloud,
      humidityPct: point?.humidityPct,
      aod: air?.aod,
      pm2_5: air?.pm2_5,
      horizon,
    });
    const eventMs = Date.parse(ev.timeIso);
    return {
      slug: loc.slug,
      event_kind: ev.event,
      event_iso: ev.timeIso,
      as_of_hour_utc: opts.hourUtc,
      snapshot_generated_at: snap.generatedAt,
      archived_at: new Date(nowMs).toISOString(),
      lead_minutes: Math.round((eventMs - anchorMs) / 60_000),

      score: result.score,
      band: result.band,
      model_path: path,
      note: result.note,
      breakdown_json: result.breakdown ? JSON.stringify(result.breakdown) : null,

      low_cloud_pct: numOrNull(point?.cloud.lowPct),
      mid_cloud_pct: numOrNull(point?.cloud.midPct),
      high_cloud_pct: numOrNull(point?.cloud.highPct),
      total_cloud_pct: numOrNull(point?.cloud.totalPct),
      humidity_pct: numOrNull(point?.humidityPct),
      aod: numOrNull(air?.aod),
      pm2_5: numOrNull(air?.pm2_5),
      horizon_cloud_pct: horizon ? horizon.cloudPct : null,
      horizon_source: horizonSource,
      horizon_fresh: horizon ? (horizon.fresh ? 1 : 0) : null,
      seasonal_prior: path === "factor" ? DEFAULT_SEASONAL_PRIOR : null,
      point_time: point?.time ?? null,
      peak_color_iso: peak?.iso ?? null,
      peak_offset_minutes: peak ? peak.minutesFromEvent : null,

      algo_version: SUN_QUALITY_VERSION,
      engine_version: SCORING_ENGINE_VERSION,
      build_sha: currentBuildSha(),

      observed_score: null,
      observed_source: null,
      observed_at: null,
    };
  });
}
