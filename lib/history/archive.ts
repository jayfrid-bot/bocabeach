// Pure core of the hourly history archiver (docs/HISTORY_AND_IMAGERY_PLAN.md
// Part A). `rowFromConditions` does the actual mapping and has no I/O — the
// archive route (app/api/history/archive/route.ts) is the thin I/O shell that
// calls `getConditions`, maps with this, and upserts.

import type { ConditionsResponse, Location } from "@/lib/types";
import { deriveMetrics, SCORING_CONFIG_VERSION, SCORING_ENGINE_VERSION } from "@/lib/score";
import { computeSunTimes, type SunTimes } from "@/lib/sources/sun";
import { SUN_FORECAST_WINDOW_MS } from "@/lib/sunForecastWindow";
import type { ArchiveCandidate, BeachHourlyRow } from "@/lib/history/types";
import { extraJsonFor } from "@/lib/history/extra";

/** The UTC hour a given instant falls in, as the ISO string that keys
 *  `beach_hourly.hour_utc` — always :00:00.000Z, floored down. */
export function hourUtcOf(ms: number): string {
  const floored = Math.floor(ms / 3_600_000) * 3_600_000;
  return new Date(floored).toISOString();
}

// One Intl.DateTimeFormat per zone, reused. Building a formatter is the slow
// part of `localHourParts` (most of the ~2.3 ms the archiver spent ordering
// 63 candidates a minute); formatting with a built one is cheap.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function localFormatter(tz: string): Intl.DateTimeFormat {
  let dtf = FORMATTERS.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(tz, dtf);
  }
  return dtf;
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
  const parts = localFormatter(tz).formatToParts(new Date(ms));
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
  // Prefer the score's own completeness/missing-factor read (lib/score.ts'
  // scoreBeachDay) when present, so history and the UI never disagree about
  // what was missing — falling back to re-deriving from subScores for older
  // ScoreResult shapes/fixtures that predate those fields.
  const missing: string[] = res.score.missingFactors ?? [];
  for (const s of subs) {
    if (s.score == null) {
      if (res.score.missingFactors == null) missing.push(s.key);
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
    available_weight: round2(res.score.completeness ?? availableWeight),
    observed_weight: round2(observedWeight),
    coverage_tier: coverageTier(loc, res),

    air_temp_f: numOrNull(d.airTempF),
    water_temp_f: numOrNull(d.waterTempF),
    sand_temp_f: numOrNull(d.sandTempF),
    // wave_ft has always meant the RAW TOTAL significant wave height (Hs),
    // not the estimated surf (breaking) height — every row before migration
    // 0010 was written on that meaning, so writing the surf estimate here
    // instead would silently corrupt history (Codex review 2026-09-28 #1).
    // Reads `d.waveTotalHsFt`, NOT `d.waveSwellHeightFt` — the latter can
    // legitimately BE the swell component (Codex review round-2 #1: when the
    // total's own period was missing, `estimateSurfFromSources` may pair the
    // surf estimate with the swell reading instead), so it can no longer
    // stand in for "the raw total Hs" here. The surf estimate goes in the
    // new surf_ft column below.
    wave_ft: numOrNull(d.waveTotalHsFt),
    surf_ft: numOrNull(d.waveHeightFt),
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
    // Other proprietary readouts (lib/history/extra.ts); a failure inside any
    // block is logged and skipped there — this row always lands.
    extra_json: extraJsonFor(res, d, anchorMs),
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

const HOUR_MS = 3_600_000;

/**
 * Is this the clock hour in which one of the beach's sun forecasts OPENS?
 *
 * The sunrise/sunset color score shows from `event − SUN_FORECAST_WINDOW_MS`
 * (60 min, lib/sunForecastWindow.ts). To grade that forecast, every beach needs
 * an archived build (and so a `sun_event_predictions` row) in the UTC clock
 * hour that contains that instant. This returns true for exactly that hour, so
 * the archiver can build the beach first and from its sun reserve
 * (app/api/history/archive/route.ts).
 *
 * In that hour the event is always 0–120 min ahead. The answer stays the same
 * for the whole hour, so a beach never switches class in the middle of one.
 *
 * Events come from `computeSunTimes` for the beach's local date and the days
 * either side, so an event on the next local day (or one that falls on the next
 * UTC day, such as a West Coast sunset) is found too. A day with no sunrise or
 * sunset (polar day or night) gives false.
 */
export function sunWindowPriority(
  candidate: Pick<ArchiveCandidate, "lat" | "lon" | "timezone">,
  nowMs: number,
): boolean {
  return sunWindowEventMs(candidate, nowMs) !== null;
}

/**
 * The instant of the sun event whose forecast opens in `nowMs`'s UTC hour
 * (the rule in `sunWindowPriority`), or null when there is none. The archiver
 * builds the earliest event first (`orderArchiveCandidates`).
 */
export function sunWindowEventMs(
  candidate: Pick<ArchiveCandidate, "lat" | "lon" | "timezone">,
  nowMs: number,
): number | null {
  if (!Number.isFinite(nowMs)) return null;
  const hour = Math.floor(nowMs / HOUR_MS);
  const [y, m, d] = localHourParts(candidate.timezone, nowMs).date.split("-").map(Number);
  if (!y || !m || !d) return null;
  let found: number | null = null;
  for (const offset of [-1, 0, 1]) {
    for (const eventMs of sunEventsOn(candidate.lat, candidate.lon, y, m, d + offset)) {
      if (sunForecastHour(eventMs) === hour && (found === null || eventMs < found)) found = eventMs;
    }
  }
  return found;
}

/** The UTC hour number (ms / 1 h, floored) in which `eventMs`'s forecast opens. */
function sunForecastHour(eventMs: number): number {
  return Math.floor((eventMs - SUN_FORECAST_WINDOW_MS) / HOUR_MS);
}

// Sun times are a pure function of (lat, lon, date), so one cache serves every
// call in this isolate. Bounded: 63 beaches touch about 4 dates each a day.
const SUN_TIMES = new Map<string, SunTimes>();
const SUN_TIMES_MAX = 2048;

/** Sunrise and sunset (ms) for calendar date y-m-d (d may overflow; it is normalized). */
function sunEventsOn(lat: number, lon: number, y: number, m: number, d: number): number[] {
  const day = new Date(Date.UTC(y, m - 1, d));
  const yy = day.getUTCFullYear();
  const mm = day.getUTCMonth() + 1;
  const dd = day.getUTCDate();
  const key = `${lat},${lon},${yy}-${mm}-${dd}`;
  let t = SUN_TIMES.get(key);
  if (!t) {
    if (SUN_TIMES.size >= SUN_TIMES_MAX) SUN_TIMES.clear();
    t = computeSunTimes(lat, lon, yy, mm, dd);
    SUN_TIMES.set(key, t);
  }
  const out: number[] = [];
  if (t.sunrise) out.push(t.sunrise.getTime());
  if (t.sunset) out.push(t.sunset.getTime());
  return out;
}

/**
 * How many sun-forecast builds are still due in `nowMs`'s UTC day: one per
 * (beach, forecast hour) under the `sunWindowPriority` rule, for every forecast
 * hour from the current UTC hour to the end of the UTC day. A beach whose
 * forecast hour is the CURRENT hour counts only while it still has no row for
 * that hour — `pendingThisHour` holds those slugs; pass null to count them all.
 *
 * The archiver keeps this many budget units (plus a little slack) back from
 * ordinary builds, so the day's remaining sun forecasts can always be built.
 * Late in the UTC day the number is small, so ordinary builds run almost to
 * the daily max. Pure; sun times are cached per beach and date.
 */
export function sunBuildsDueToday(
  locations: ReadonlyArray<{ slug: string; lat: number; lon: number }>,
  nowMs: number,
  pendingThisHour: ReadonlySet<string> | null,
): number {
  if (!Number.isFinite(nowMs)) return 0;
  const hour = Math.floor(nowMs / HOUR_MS);
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  const endHour = Date.UTC(y, m - 1, d + 1) / HOUR_MS; // first hour of the next UTC day
  let due = 0;
  for (const loc of locations) {
    // Dates either side of the UTC date: a far-west beach's sunset belongs to
    // the previous calendar date, a far-east sunrise to the next one.
    const hours = new Set<number>();
    for (const offset of [-1, 0, 1]) {
      for (const eventMs of sunEventsOn(loc.lat, loc.lon, y, m, d + offset)) {
        const h = sunForecastHour(eventMs);
        if (h < hour || h >= endHour) continue;
        if (h === hour && pendingThisHour && !pendingThisHour.has(loc.slug)) continue;
        hours.add(h);
      }
    }
    due += hours.size;
  }
  return due;
}

/**
 * The archiver's candidate list, shared by both stores so they cannot drift:
 * drop beaches that already have a row this UTC hour; keep beaches the
 * daylight rule allows OR that are in their sun-forecast hour
 * (`sunWindowPriority` — the hour before sunrise is still dark for an auto
 * beach); then put sun-window beaches first, earliest event first (so an early
 * event is built before its lead drops under 30 min), and order the rest — and
 * any sun-window tie — fairly (`compareByLastHourThenSlug`).
 *
 * Each returned sun-window candidate carries `sunEventMs`, worked out once
 * here, so the caller need not recompute it.
 */
export function orderArchiveCandidates(
  all: ArchiveCandidate[],
  archivedThisHour: Set<string>,
  lastHourBySlug: Map<string, string>,
  nowMs: number,
): ArchiveCandidate[] {
  return all
    .filter((c) => !archivedThisHour.has(c.slug))
    .map((c) => ({ c, sunMs: sunWindowEventMs(c, nowMs) }))
    .filter(({ c, sunMs }) => sunMs !== null || shouldArchiveNow(c, nowMs))
    .sort((a, b) => {
      if ((a.sunMs === null) !== (b.sunMs === null)) return a.sunMs !== null ? -1 : 1;
      if (a.sunMs !== null && b.sunMs !== null && a.sunMs !== b.sunMs) return a.sunMs - b.sunMs;
      return compareByLastHourThenSlug(lastHourBySlug.get(a.c.slug), a.c.slug, lastHourBySlug.get(b.c.slug), b.c.slug);
    })
    .map(({ c, sunMs }) => (sunMs === null ? c : { ...c, sunEventMs: sunMs }));
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
