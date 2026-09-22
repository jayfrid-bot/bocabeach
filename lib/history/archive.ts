// Pure core of the hourly history archiver (docs/HISTORY_AND_IMAGERY_PLAN.md
// Part A). `rowFromConditions` does the actual mapping and has no I/O — the
// archive route (app/api/history/archive/route.ts) is the thin I/O shell that
// calls `getConditions`, maps with this, and upserts.

import type { ConditionsResponse, Location } from "@/lib/types";
import { deriveMetrics, SCORING_CONFIG_VERSION, SCORING_ENGINE_VERSION } from "@/lib/score";
import { computeSunTimes } from "@/lib/sources/sun";
import type { ArchiveCandidate, BeachHourlyRow } from "@/lib/history/types";

/** The UTC hour a given instant falls in, as the ISO string that keys
 *  `beach_hourly.hour_utc` — always :00:00.000Z, floored down. */
export function hourUtcOf(ms: number): string {
  const floored = Math.floor(ms / 3_600_000) * 3_600_000;
  return new Date(floored).toISOString();
}

/**
 * The beach-local wall-clock date/hour and the UTC offset (minutes, local −
 * UTC) at `ms`, for IANA zone `tz`. DST-safe: Intl resolves the zone's actual
 * offset for THIS instant, not a fixed one, so a fall-back 1 AM (two distinct
 * instants, same local hour) gets two different `utc_offset_minutes` and a
 * spring-forward 2 AM (an instant no local wall clock ever reads) simply
 * never occurs as an input.
 */
export function localHourParts(
  tz: string,
  ms: number,
): { date: string; hour: number; offsetMinutes: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  // Treat the local wall-clock numbers as if they were UTC, then diff against
  // the real UTC instant — the standard trick for reading an Intl offset.
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((asUtcMs - ms) / 60_000);
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { date, hour, offsetMinutes };
}

/**
 * Coverage tier for a beach, per the plan: `full` needs both cams AND a
 * water-quality config (Healthy Beaches sites); `standard` needs an observed
 * (buoy) wave reading AND a water temperature; else `limited`.
 */
export function coverageTier(
  loc: Location,
  res: ConditionsResponse,
): "full" | "standard" | "limited" {
  const hasCams = !!loc.cams && loc.cams.length > 0;
  const hasWaterQualityConfig = !!loc.healthyBeaches;
  if (hasCams && hasWaterQualityConfig) return "full";
  const observedWaves = typeof res.snapshot.buoy.data?.waveHeightFt === "number";
  const d = deriveMetrics(res.snapshot);
  const hasWaterTemp = typeof d.waterTempF === "number";
  if (observedWaves && hasWaterTemp) return "standard";
  return "limited";
}

/** `process.env.NEXT_PUBLIC_GIT_SHA` — the same short SHA the app footer
 *  shows (baked in at build by next.config.mjs). `null` in a dev/test process
 *  that never went through that build step. */
export function currentBuildSha(): string | null {
  return process.env.NEXT_PUBLIC_GIT_SHA || null;
}

/**
 * Map a `getConditions` result into a `beach_hourly` row keyed by the UTC
 * hour of `res.snapshot.generatedAt` — "archive what was shown", never
 * recomputed against a different clock — UNLESS the caller passes
 * `opts.hourUtc`: the route claims a specific hour (fresh, at claim time,
 * via `store.claimHistoryBuild`) before it ever fetches, and that claimed
 * hour — not whatever hour the (cached, up to ~120s stale) snapshot happens
 * to have been generated in — is what the row must be keyed and localized
 * by, or the claimed hour silently goes unfilled while a different hour
 * dedupes or gets clobbered (Codex round-2 finding #1). `snapshot_generated_at`
 * always stays the snapshot's own clock regardless. Pure: no I/O, no
 * Date.now() (the caller's `nowMs` only stamps `archived_at`).
 */
export function rowFromConditions(
  res: ConditionsResponse,
  loc: Location,
  nowMs: number,
  opts?: { hourUtc?: string },
): BeachHourlyRow {
  const snap = res.snapshot;
  const generatedMs = Date.parse(snap.generatedAt);
  const anchorMs = Number.isFinite(generatedMs) ? generatedMs : nowMs;
  const hourUtc = opts?.hourUtc ?? hourUtcOf(anchorMs);
  // local_date/local_hour/utc_offset_minutes describe the row's own key (the
  // claimed hour), not necessarily the instant the snapshot happened to be
  // generated at — deriveMetrics below still uses the snapshot's real
  // anchorMs, since that reflects genuine data freshness, not the row's key.
  const localAnchorMs = opts?.hourUtc ? Date.parse(opts.hourUtc) : anchorMs;
  const d = deriveMetrics(snap, anchorMs);
  const { date, hour, offsetMinutes } = localHourParts(loc.timezone, localAnchorMs);

  const subs = res.score.subScores;
  let availableWeight = 0;
  let observedWeight = 0;
  const missing: string[] = [];
  for (const s of subs) {
    if (s.score == null) {
      missing.push(s.key);
      continue;
    }
    availableWeight += s.weight;
    if (s.key === "waterTemp" && d.waterTempSource?.kind === "buoy") observedWeight += s.weight;
    if (s.key === "waves" && d.waveHeightSource?.kind === "buoy") observedWeight += s.weight;
  }

  const waveSource: BeachHourlyRow["wave_source"] =
    d.waveHeightSource?.kind === "buoy" ? "observed" : d.waveHeightSource?.kind === "model" ? "model" : null;

  const rainNow =
    d.nowcastRaining ||
    (typeof d.weatherCode === "number" &&
      ((d.weatherCode >= 51 && d.weatherCode <= 67) || (d.weatherCode >= 80 && d.weatherCode <= 99)))
      ? 1
      : 0;

  return {
    slug: loc.slug,
    hour_utc: hourUtc,
    snapshot_generated_at: snap.generatedAt,
    archived_at: new Date(nowMs).toISOString(),
    local_date: date,
    local_hour: hour,
    utc_offset_minutes: offsetMinutes,
    timezone: loc.timezone,

    score: res.score.score,
    raw_score: res.score.rawScore,
    rating: res.score.rating,
    available_weight: round2(availableWeight),
    observed_weight: round2(observedWeight),
    coverage_tier: coverageTier(loc, res),

    air_temp_f: numOrNull(d.airTempF),
    water_temp_f: numOrNull(d.waterTempF),
    sand_temp_f: numOrNull(d.sandTempF),
    wave_ft: numOrNull(d.waveHeightFt),
    wave_source: waveSource,
    wind_mph: numOrNull(d.windSpeedMph),
    gust_mph: numOrNull(snap.buoy.data?.windGustMph),
    uv: numOrNull(d.uvIndex),
    cloud_pct: numOrNull(d.cloudCoverPct),
    rain_now: rainNow,
    lightning_near: d.lightningWithin5mi ? 1 : 0,
    tide_state: snap.tides.data?.trend ?? null,
    crowd_pct: numOrNull(d.crowdPct),
    seaweed_pct: numOrNull(d.sargassumCoveragePct),
    seaweed_level: d.sargassumLevel ?? null,
    clarity_pct: numOrNull(d.clarityPct),

    engine_version: SCORING_ENGINE_VERSION,
    scoring_config_version: SCORING_CONFIG_VERSION,
    build_sha: currentBuildSha(),
    row_kind: "snapshot",
    archive_reason: "cron",

    caps_json: JSON.stringify(res.score.caps ?? []),
    factors_json: JSON.stringify(
      subs.map((s) => ({ key: s.key, label: s.label, score: s.score, weight: s.weight, display: s.display })),
    ),
    missing_json: JSON.stringify(missing),
    extra_json: null,
  };
}

function numOrNull(v: number | undefined | null): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Is the sun up (± nothing — plain sunrise/sunset) at `loc` on its own local
 * calendar `date` (YYYY-MM-DD), at instant `ms`? Reused for the daylight-only
 * archiving rule for `tier: "auto"` beaches — curated beaches archive every
 * hour regardless.
 */
export function isDaylightAt(loc: { lat: number; lon: number }, ms: number, date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return false;
  const t = computeSunTimes(loc.lat, loc.lon, y, m, d);
  if (!t.sunrise || !t.sunset) return false;
  return ms >= t.sunrise.getTime() && ms <= t.sunset.getTime();
}

/**
 * Should `candidate` be archived right now? Curated beaches: always (every
 * hour). Auto beaches: only when the sun is up at their own local hour — see
 * plan §Design, "Hours". The candidate list itself (which beaches have no row
 * for the current UTC hour yet) is a store concern (`listArchiveCandidates`);
 * this is the pure daylight predicate it filters auto beaches through.
 */
export function shouldArchiveNow(candidate: ArchiveCandidate, nowMs: number): boolean {
  if (candidate.tier === "curated") return true;
  const { date } = localHourParts(candidate.timezone, nowMs);
  return isDaylightAt(candidate, nowMs, date);
}

/**
 * Fair candidate ordering (Codex round-3 finding #1): a beach with NO
 * beach_hourly row at all (`lastHour` undefined) sorts before every beach
 * that has one; among beaches that do, the one whose most recent row is
 * OLDEST sorts first. Ties (including "both never archived") break by slug,
 * for a stable, deterministic order both stores agree on.
 */
export function compareByLastHourThenSlug(
  aLastHour: string | undefined,
  aSlug: string,
  bLastHour: string | undefined,
  bSlug: string,
): number {
  if (aLastHour === undefined && bLastHour === undefined) return aSlug < bSlug ? -1 : aSlug > bSlug ? 1 : 0;
  if (aLastHour === undefined) return -1;
  if (bLastHour === undefined) return 1;
  if (aLastHour !== bLastHour) return aLastHour < bLastHour ? -1 : 1;
  return aSlug < bSlug ? -1 : aSlug > bSlug ? 1 : 0;
}
