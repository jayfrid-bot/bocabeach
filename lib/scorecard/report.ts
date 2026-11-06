// Scorecard report: raw query results in, computed metrics and Markdown out.
//
// Pure (no I/O, no clock reads — `raw.asOf` is the clock), so scripts/scorecard.ts
// can fetch from D1 and tests can feed saved results through the same path.
// Nothing here throws: a section whose input failed to load, or whose metric
// code threw, becomes `{ ok: false, error }` and renders as "Not available —".

import {
  AMAZING_CUTOFF,
  CALL_MIN_LEAD_MIN,
  GREAT_CUTOFF,
  MIN_ROWS_PER_DAY,
  CAM_STALE_HOURS,
  FLAG_ORDER,
  SWIM_LEVELS,
  HEADLINE_LEAD_MAX,
  HEADLINE_LEAD_MIN,
  afterglowMetrics,
  dataHealth,
  sunFairMetrics,
  sunFixList,
  rainMetrics,
  safetyMetrics,
  sunColorMetrics,
  windowMetrics,
  type AfterglowSide,
  type CallCell,
  type CamDistanceFn,
  type DaylightFn,
  type EventLocalDateFn,
  type FairVersion,
  type ErrorGroup,
  type HealthResult,
  type HourlyRow,
  type Rate,
  type RainResult,
  type SafetyResult,
  type SunColorResult,
  type SunFairResult,
  type SunPredictionRow,
  type WindowResult,
} from "@/lib/scorecard/metrics";
import { courierFleet, listOfflineCams, type CamEvidence, type OfflineCam, type RosterCam } from "@/lib/camStatus";

// --- Input ------------------------------------------------------------------

export interface RawSunObservation {
  slug: string;
  event_kind: "sunrise" | "sunset";
  event_date_local: string;
  cam_id: string;
  event_iso: string;
  view: string;
  observed_score: number;
  scored_at: string;
}

export type RawDatasetName =
  | "hourly"
  | "sunPredictions"
  | "sunObservations"
  | "camLatest"
  | "camEvidence"
  | "sunPredictionsLast24h"
  | "sunLifetime";

/** Lifetime counts for the sun-color log (the pairs below are only the last `sunWindowDays`). */
export interface SunLifetime {
  forecastRows: number;
  forecastEvents: number;
  pairedRows: number;
  observations: number;
  firstArchivedAt: string | null;
}

/** Saved query results. A dataset that failed to load is null, with the reason in `errors`. */
export interface RawData {
  /** The report's clock, ISO UTC. */
  asOf: string;
  /** How many days of hourly rows were requested. */
  days: number;
  hourly: HourlyRow[] | null;
  sunPredictions: SunPredictionRow[] | null;
  sunObservations: RawSunObservation[] | null;
  camLatest: { slug: string; captured_at_utc: string }[] | null;
  /** What each cam's source said about its newest good frame, read when the report ran
   *  (uw-frame /cams and the county latest.json feeds). Missing in older saved files. */
  camEvidence?: CamEvidence[] | null;
  /** The newest courier-delivered good frame in uw-frame /cams (ISO), null = none;
   *  missing = /cams was not read. Drives the courier breaker (lib/camStatus.ts). */
  courierNewestGoodAt?: string | null;
  sunPredictionsLast24h: number | null;
  /** Days back the sun-color forecasts and camera readings were read (events in this window). */
  sunWindowDays?: number;
  sunLifetime?: SunLifetime | null;
  /** Dataset -> first line of its error. A dataset with an error AND rows is partial. */
  errors: Partial<Record<RawDatasetName, string>>;
}

export interface BuildOptions {
  daylight?: DaylightFn;
  tierOf?: (slug: string) => "curated" | "auto" | undefined;
  expectedPerDay?: (slug: string) => number | undefined;
  /** The sun-color model version live in the app now (lib/sunQuality.ts SUN_QUALITY_VERSION),
   *  so it shows as "collecting" even before it has a row. */
  currentSunVersion?: string;
  /** A sun cam's facing from config/sun-cams.json (east or west). */
  camFacing?: (camId: string) => "east" | "west" | undefined;
  /** A beach's distance from a sun cam (config/sun-cams.json): a shared cam's reading
   *  is graded once, for the nearest beach. */
  camDistance?: CamDistanceFn;
  /** The local date of an event at a beach (its own time zone). */
  localDateOf?: EventLocalDateFn;
  /** Every cam the offline rule judges (lib/camStatus.ts camRoster over config/locations.ts). */
  camRoster?: RosterCam[];
}

// --- Output -----------------------------------------------------------------

export type Section<T> = { ok: true; result: T } | { ok: false; error: string };

export interface SunSection extends SunColorResult {
  /** Solar camera readings that matched no forecast row (null when unknown). Afterglow readings are counted apart. */
  observationsWithoutForecast: number | null;
  /** Afterglow (antisolar) camera readings in the window: stored, never scored (null when unknown). */
  afterglowObservations: number | null;
  /** Camera readings in the archive. */
  observations: number | null;
  /** Forecast rows loaded. */
  forecastRows: number;
  windowDays: number | null;
  lifetime: SunLifetime | null;
  /** The fair grade: per-cam rank and top tier, per model version, on the forecast people see. */
  fair: SunFairResult;
  /** Afterglow readings graded by rank (null when the camera readings did not load). */
  afterglow: { sunset: AfterglowSide; sunrise: AfterglowSide } | null;
  /** "What to fix next", from the numbers above by fixed rules. */
  fixes: string[];
}

export interface Scorecard {
  asOf: string;
  days: number;
  /** Days back the sun-color forecasts were read (null when unknown). */
  sunWindowDays: number | null;
  headlines: { sun: string; rain: string; window: string; safety: string; health: string };
  warnings: string[];
  sun: Section<SunSection>;
  rain: Section<RainResult>;
  window: Section<WindowResult>;
  safety: Section<SafetyResult>;
  health: Section<HealthResult>;
}

// --- Formatting helpers -----------------------------------------------------

const DASH = "—";
const pct = (v: number | null | undefined): string => (v == null ? DASH : `${Math.round(v * 100)}%`);
const pct1 = (v: number | null | undefined): string => (v == null ? DASH : `${v}%`);
const num = (v: number | null | undefined, d = 1): string => (v == null ? DASH : v.toFixed(d));
const signed = (v: number | null | undefined, d = 1): string =>
  v == null ? DASH : `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** A rate as a percent, or "n=<count>, collecting" while its own denominator is too small. */
const rateCell = (r: Rate): string => (r.value != null ? pct(r.value) : (r.collecting ?? DASH));
const oneLine = (s: string): string => s.split("\n")[0].trim();

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

const BAND_LABEL: Record<string, string> = {
  dud: "Poor (under 20)",
  plain: "Fair (20–44)",
  good: "Good (45–69)",
  vivid: "Great (70–89)",
  epic: "Amazing (90+)",
};

const LEAD_LABEL: Record<string, string> = {
  "<0": "After the event (golden window)",
  "0–2h": "0–2 h before",
  "2–6h": "2–6 h before",
  "6–12h": "6–12 h before",
  "12–24h": "12–24 h before",
  "24h+": "24 h or more before",
};

function errorRows(groups: ErrorGroup[], label: (k: string) => string): (string | number)[][] {
  return groups.map((g) => [
    label(g.key),
    g.events,
    g.rows,
    g.mae == null ? g.collecting ?? DASH : num(g.mae),
    g.bias == null ? DASH : signed(g.bias),
  ]);
}

const ERR_HEADERS = ["", "Events", "Forecasts", "Typical miss (pts)", "Bias (pts)"];

// --- Build ------------------------------------------------------------------

function guard<T>(name: string, fn: () => T): Section<T> {
  try {
    return { ok: true, result: fn() };
  } catch (e) {
    return { ok: false, error: `${name}: ${oneLine(e instanceof Error ? e.message : String(e))}` };
  }
}

const unavailable = (why: string | undefined, fallback: string): Section<never> => ({
  ok: false,
  error: why ? oneLine(why) : fallback,
});

/** Does an observation line up with a forecast event? (Same beach and kind, within 15 minutes.) */
function matchesForecast(o: RawSunObservation, paired: SunPredictionRow[]): boolean {
  const t = Date.parse(o.event_iso);
  return paired.some(
    (p) =>
      p.slug === o.slug &&
      p.event_kind === o.event_kind &&
      Math.abs(Date.parse(p.event_iso) - t) <= 15 * 60_000 + 10,
  );
}

/** The cams hidden on the page as offline when the report ran; null when not checked. */
function offlineCamsOf(raw: RawData, roster: RosterCam[] | undefined, nowMs: number): OfflineCam[] | null {
  if (!roster || !raw.camEvidence) return null;
  return listOfflineCams(roster, raw.camEvidence, nowMs, courierFleet(raw.courierNewestGoodAt, nowMs));
}

/** The courier breaker as the report states it; null when the courier is up or /cams was not read. */
function courierDownOf(raw: RawData, nowMs: number): { since: string | null; newest: string | null } | null {
  if (!raw.camEvidence || raw.courierNewestGoodAt === undefined) return null;
  const f = courierFleet(raw.courierNewestGoodAt, nowMs);
  if (f.down !== true) return null;
  return { since: f.sinceMs == null ? null : new Date(f.sinceMs).toISOString(), newest: raw.courierNewestGoodAt };
}

/** "Nov 6, 2:05 PM ET" — the owner reads the scorecard in Eastern time. */
function etTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms))} ET`;
}

/** One offline cam, for the data-health list. */
export function offlineCamLine(c: OfflineCam): string {
  const since = c.since ? `offline since ${etTime(c.since)}` : "no good frame stored";
  const last = c.lastGoodFrameAt ? `, last good frame ${etTime(c.lastGoodFrameAt)}` : "";
  const tried = c.lastAttempt
    ? `, last try ${etTime(c.lastAttempt.at)}${c.lastAttempt.blank ? " (blank)" : ""}`
    : "";
  return `${c.id} (${c.slug}): ${since}${last}${tried}`;
}

export function buildScorecard(raw: RawData, opts: BuildOptions = {}): Scorecard {
  const nowMs = Date.parse(raw.asOf);
  const warnings: string[] = [];
  if (raw.hourly && raw.errors.hourly) warnings.push(`Some hourly rows are missing. ${oneLine(raw.errors.hourly)}`);
  if (raw.sunPredictions && raw.errors.sunPredictions) {
    warnings.push(`Some sun-color forecasts are missing. ${oneLine(raw.errors.sunPredictions)}`);
  }

  const hourlyOff = (): Section<never> => unavailable(raw.errors.hourly, "No hourly rows were loaded.");

  const sun: Section<SunSection> = raw.sunPredictions
    ? guard("sun color", () => {
        const m = sunColorMetrics(raw.sunPredictions as SunPredictionRow[], { nowMs });
        const pairedRows = (raw.sunPredictions as SunPredictionRow[]).filter((r) => r.observed_score != null);
        const obs = raw.sunObservations;
        const fair = sunFairMetrics(raw.sunPredictions as SunPredictionRow[], {
          nowMs,
          currentVersion: opts.currentSunVersion,
          camDistance: opts.camDistance,
          localDateOf: opts.localDateOf,
        });
        const afterglow = obs
          ? afterglowMetrics(
              raw.sunPredictions as SunPredictionRow[],
              obs.filter((o) => o.view === "antisolar"),
              { nowMs, facingOf: opts.camFacing, camDistance: opts.camDistance, localDateOf: opts.localDateOf },
            )
          : null;
        return {
          ...m,
          fair,
          afterglow,
          fixes: sunFixList(fair, afterglow),
          forecastRows: (raw.sunPredictions as SunPredictionRow[]).length,
          windowDays: raw.sunWindowDays ?? null,
          lifetime: raw.sunLifetime ?? null,
          observations: obs ? obs.length : null,
          observationsWithoutForecast: obs ? obs.filter((o) => o.view !== "antisolar" && !matchesForecast(o, pairedRows)).length : null,
          afterglowObservations: obs ? obs.filter((o) => o.view === "antisolar").length : null,
        };
      })
    : unavailable(raw.errors.sunPredictions, "No sun-color forecasts were loaded.");

  const rows = raw.hourly;
  const rain: Section<RainResult> = rows ? guard("rain", () => rainMetrics(rows)) : hourlyOff();
  const window: Section<WindowResult> = rows
    ? guard("window", () => windowMetrics(rows, { daylight: opts.daylight }))
    : hourlyOff();
  const safety: Section<SafetyResult> = rows
    ? guard("safety", () => safetyMetrics(rows, { daylight: opts.daylight }))
    : hourlyOff();
  const health: Section<HealthResult> = guard("data health", () =>
    dataHealth({
      rows: rows ?? [],
      camLatest: raw.camLatest,
      camsOffline: offlineCamsOf(raw, opts.camRoster, nowMs),
      courierDown: courierDownOf(raw, nowMs),
      sunObs: raw.sunObservations
        ? {
            count: raw.sunObservations.length,
            latestScoredAt: raw.sunObservations.reduce<string | null>(
              (m, o) => (m == null || o.scored_at > m ? o.scored_at : m),
              null,
            ),
            latestEventIso: raw.sunObservations.reduce<string | null>(
              (m, o) => (m == null || o.event_iso > m ? o.event_iso : m),
              null,
            ),
          }
        : null,
      sunPredictionsLast24h: raw.sunPredictionsLast24h,
      nowMs,
      tierOf: opts.tierOf,
      expectedPerDay: opts.expectedPerDay,
    }),
  );
  // Without hourly rows the row-count half of data health is meaningless.
  const healthFinal: Section<HealthResult> = rows ? health : unavailable(raw.errors.hourly, "No hourly rows were loaded.");

  return {
    asOf: raw.asOf,
    days: raw.days,
    sunWindowDays: raw.sunWindowDays ?? null,
    headlines: {
      sun: sunHeadline(sun),
      rain: rainHeadline(rain),
      window: windowHeadline(window),
      safety: safetyHeadline(safety),
      health: healthHeadline(healthFinal),
    },
    warnings,
    sun,
    rain,
    window,
    safety,
    health: healthFinal,
  };
}

// --- Headlines --------------------------------------------------------------

const na = (s: Section<unknown>): string | null => (s.ok ? null : `Not available — ${s.error}`);

function sunHeadline(s: Section<SunSection>): string {
  if (!s.ok) return na(s) as string;
  const r = s.result;
  const f = r.fair;
  if (f.versions.length === 0) {
    const cams = r.observations == null ? "camera readings unknown" : plural(r.observations, "camera reading");
    return `${r.collecting ?? "No forecasts yet"}. (${plural(r.events, "event")} forecast, ${cams} so far.)`;
  }
  const parts = f.versions.map((v) => {
    const label = `Model ${v.version}${v.current ? " (live now)" : ""}`;
    if (!v.ready) return `${label}: ${v.collecting} (${plural(v.events, "event")} with a forecast 30–120 min out).`;
    const rank =
      v.rank.rho != null
        ? `fair rank correlation ${signed(v.rank.rho, 2)} (${plural(v.rank.events, "event")} on ${plural(v.rank.cams, "cam")})`
        : `fair rank correlation ${v.rank.collecting}`;
    const g = v.tiers.great;
    const tier =
      g.hitRate.value != null
        ? `Great calls in the cam's own top 25%: ${g.hits} of ${g.calls}`
        : `Great calls in the cam's own top 25%: ${g.hitRate.collecting}`;
    return `${label}: ${plural(v.pairs, "pair")}; ${rank}; ${tier}.`;
  });
  const cov = f.coverage
    .filter((c) => c.pastEvents > 0)
    .map((c) => `${c.withHeadline} of ${c.pastEvents} past ${c.kind}s (${pct(c.share)})`);
  if (cov.length) parts.push(`A forecast 30–120 min out exists for ${cov.join(" and ")}.`);
  return parts.join(" ");
}

function rainHeadline(s: Section<RainResult>): string {
  if (!s.ok) return na(s) as string;
  const r = s.result;
  if (!r.ready) return `${r.collecting}. (${plural(r.calls, "rain call")} archived.)`;
  const p = r.dryPromise;
  if (p.n === 0) return `${plural(r.scored, "scored call")}; none said "dry for the next 2+ hrs".`;
  if (p.rate.value == null) {
    return `"Dry for the next 2+ hrs" calls: ${p.rate.collecting} (needs ${p.rate.min}); ${p.rainedOn} of ${p.n} saw radar rain within 2 hours.`;
  }
  return `Of ${plural(p.n, '"dry for the next 2+ hrs" call')}, ${p.rainedOn} (${pct(p.rate.value)}) saw radar rain within 2 hours.`;
}

function windowHeadline(s: Section<WindowResult>): string {
  if (!s.ok) return na(s) as string;
  const r = s.result;
  const censored = `${plural(r.skipped.censoredDay, "day")} left out for missing hours`;
  if (!r.ready) return `${r.collecting}. (${plural(r.completeDays, "complete day")}; ${censored}.)`;
  return (
    `${plural(r.daysScored, "complete day")} (${censored}). Inside our window the archived hours averaged ${num(r.realizedInWindow)}; ` +
    `the best 3 hours in a row averaged ${num(r.realizedBest3h)} (gap ${num(r.gapPts)}). ` +
    `The best hour fell inside our window on ${pct(r.peakInWindowShare)} of those days.`
  );
}

function safetyHeadline(s: Section<SafetyResult>): string {
  if (!s.ok) return na(s) as string;
  const r = s.result;
  if (!r.ready) return `${r.collecting}. (${plural(r.informative.beachDays, "beach-day")} with a green or yellow flag.)`;
  const i = r.informative;
  if (!i.ready) return `${plural(r.beachDays, "beach-day")} with a flag. Green/yellow agreement: ${i.collecting}.`;
  return (
    `${plural(r.beachDays, "beach-day")} with a flag. On green and yellow days our swim message agreed with the flag ` +
    `${rateCell(i.agreement)} of the time (${i.agreeDays} of ${i.beachDays}).`
  );
}

/** "16, 17, 18, 19" for the local hours that go missing. */
const hourList = (hours: number[]): string => hours.join(", ");

function healthHeadline(s: Section<HealthResult>): string {
  if (!s.ok) return na(s) as string;
  const r = s.result;
  const curatedThin = r.underMin.filter((b) => b.tier !== "auto").length;
  const parts = [
    `${plural(r.beaches, "beach", "beaches")} archiving.`,
    `Extra data on ${pct1(r.extra.last24hPct)} of the last 24 hours' rows.`,
    r.underMin.length > 0
      ? `${plural(r.underMin.length, "beach", "beaches")} under ${MIN_ROWS_PER_DAY} rows a day (${curatedThin} of them curated).`
      : `No beach under ${MIN_ROWS_PER_DAY} rows a day.`,
  ];
  if (r.hourGaps && r.hourGaps.missing.length) {
    parts.push(`Beaches that should archive all day miss local hours ${hourList(r.hourGaps.missing.map((m) => m.hour))} on most days.`);
  }
  if (r.camsStale.length) parts.push(`${plural(r.camsStale.length, "camera")} silent for over ${CAM_STALE_HOURS} hours.`);
  if (r.courierDown) {
    parts.push(`The home-server courier is down${r.courierDown.since ? ` since ${etTime(r.courierDown.since)}` : ""}.`);
  }
  if (r.camsOffline?.length) parts.push(`${plural(r.camsOffline.length, "camera")} offline and hidden on the page.`);
  return parts.join(" ");
}

// --- Markdown ---------------------------------------------------------------

function sunSection(s: Section<SunSection>): string {
  if (!s.ok) return `Not available — ${s.error}`;
  const r = s.result;
  const out: string[] = [
    "We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. " +
      "One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.",
    "",
    `- Events loaded (with a scored forecast row or a camera reading)` +
      (r.windowDays != null ? `, last ${r.windowDays} days` : "") +
      `: ${r.events}.`,
    `- Pairs: ${r.pairedEvents} (${r.pairedRows} forecast rows). ${r.ready ? "Enough to score." : `Status: ${r.collecting}.`}`,
  ];
  if (r.lifetime) {
    out.push(
      `- Lifetime: ${r.lifetime.forecastEvents} events and ${r.lifetime.forecastRows} forecast rows logged` +
        (r.lifetime.firstArchivedAt ? ` since ${r.lifetime.firstArchivedAt.slice(0, 10)}` : "") +
        `; ${r.lifetime.pairedRows} rows paired; ${plural(r.lifetime.observations, "camera reading")}.`,
    );
  }
  if (r.observations != null) {
    const notes: string[] = [];
    if (r.afterglowObservations) {
      notes.push(`${r.afterglowObservations} are afterglow (the cam looked away from the sun), kept but never scored`);
    }
    if (r.observationsWithoutForecast) {
      notes.push(`${r.observationsWithoutForecast} matched no forecast row, so they cannot be scored`);
    }
    out.push(`- Camera readings in the window: ${r.observations}` + (notes.length ? `; ${notes.join("; ")}.` : "."));
  }

  out.push(...fairBlocks(r));

  if (r.pairedEvents > 0) {
    out.push(
      "",
      "### Error overall and by group (raw camera scale)",
      "",
      "These tables use each cam's raw score, every lead time and every model version mixed. Raw scales differ by cam, so read them as a rough guide, not a grade. " +
        "Bias is forecast minus camera, so a plus means we ran high. Typical miss is the average size of the error.",
      "",
      table(ERR_HEADERS, [
        ...errorRows([r.overall], () => "All pairs"),
        ...errorRows(r.byLead, (k) => `Lead: ${LEAD_LABEL[k] ?? k}`),
        ...errorRows(r.byBand, (k) => `We said: ${BAND_LABEL[k] ?? k}`),
        ...errorRows(r.byBeach, (k) => `Beach: ${k}`),
        ...errorRows(r.byAlgo, (k) => `Model version: ${k}`),
        ...errorRows(r.byView, (k) => `Camera view: ${k === "afterglow" ? "afterglow (not scored)" : k}`),
      ]),
    );
  }

  const c = r.calls;
  if (c.events > 0) {
    out.push(
      "",
      "### Our call versus what happened (raw camera scale)",
      "",
      `The call is our last forecast made at least ${CALL_MIN_LEAD_MIN} minutes before the event. ` +
        `Great means ${GREAT_CUTOFF} or more, on the forecast and on the RAW camera score. Amazing means ${AMAZING_CUTOFF} or more. ` +
        "Some cams give 70+ to most clear skies, so the raw \"it happened\" and \"miss\" counts here are mostly a property of the cam. The fair top-tier table above is the grade. " +
        `Each rate needs 10 cases in its own denominator; until then it shows "n=<count>, collecting". ` +
        (c.ready ? "" : `Pairs: ${c.collecting}. Counts so far:`),
      "",
      table(
        ["", `Great (${GREAT_CUTOFF}+)`, `Amazing (${AMAZING_CUTOFF}+)`],
        [
          ["Events with a call", c.events, c.events],
          ["We called it, and it happened (hit)", c.great.hits, c.amazing.hits],
          ["We called it, and it did not (false alarm)", c.great.falseAlarms, c.amazing.falseAlarms],
          ["It happened, and we did not call it (miss)", c.great.misses, c.amazing.misses],
          ["Neither", c.great.correctNegatives, c.amazing.correctNegatives],
          ["Hit rate (share of our calls that happened)", rateCell(c.great.hitRate), rateCell(c.amazing.hitRate)],
          [
            "False-alarm rate (share of our calls that did not)",
            rateCell(c.great.falseAlarmRate),
            rateCell(c.amazing.falseAlarmRate),
          ],
          ["Miss rate (share of real ones we did not call)", rateCell(c.great.missRate), rateCell(c.amazing.missRate)],
        ],
      ),
    );
  }

  const d = r.distribution;
  if (d.overall.allEvents > 0) {
    out.push(
      "",
      "### How often we say Great or Amazing (camera columns on the raw scale)",
      "",
      `The model is built so about ${pct(d.target.great)} of events are Great or better, and about ${pct(d.target.amazing)} are Amazing. ` +
        "Shares wait for 10 events in a row.",
      "",
      table(
        ["", "Events", "Forecast Great+", "Forecast Amazing", "Paired events", "Forecast Great+ (paired)", "Camera Great+", "Camera Amazing"],
        [
          ["Design target", "", pct(d.target.great), pct(d.target.amazing), "", "", pct(d.target.great), pct(d.target.amazing)],
          ...[d.overall, ...d.byBeach].map((x) => [
            x.key === "all" ? "All beaches" : x.key,
            x.allEvents,
            pct(x.predGreatAll),
            pct(x.predAmazingAll),
            x.pairedEvents,
            pct(x.predGreatPaired),
            pct(x.obsGreat),
            pct(x.obsAmazing),
          ]),
        ],
      ),
    );
  }

  out.push(...afterglowBlocks(r));
  out.push("", "### What to fix next", "", "Made from the numbers above by fixed rules (see docs/scorecards/README.md).", "");
  out.push(...(r.fixes.length ? r.fixes.map((x) => `- ${x}`) : ["- Nothing crosses a rule this week."]));
  return out.join("\n");
}

const versionLabel = (v: FairVersion): string => `${v.version}${v.current ? " (live now)" : ""}`;
const rho2 = (v: number | null | undefined): string => (v == null ? DASH : signed(v, 2));
const kindName = (k: string): string => (k === "sunrise" ? "Sunrise" : k === "sunset" ? "Sunset" : k);

function tierCell(c: CallCell): string {
  const rate = c.hitRate.value != null ? pct(c.hitRate.value) : (c.hitRate.collecting ?? DASH);
  return `${c.hits} of ${c.calls} (${rate})`;
}

/** The fair grade, coverage, per-cam ranks, top-tier calls and the raw band table, per model version. */
function fairBlocks(r: SunSection): string[] {
  const f = r.fair;
  if (f.versions.length === 0) return [];
  const out: string[] = [
    "",
    "### The fair grade, by model version",
    "",
    "Each camera has its own raw scale. On the same sunsets Holmes Beach averages 74 and White Sands 5, so a raw 70 means different skies on different cams. " +
      "The fair grade asks only about order inside one cam. " +
      `It uses the forecast people see: the one closest to 60 minutes before the event, made ${HEADLINE_LEAD_MIN} to ${HEADLINE_LEAD_MAX} minutes ahead. ` +
      "Each event has one truth cam, the one the server picked: a cam that looks at the sun, the nearest one, then by cam id. " +
      "Rank correlation runs from −1 to +1. 0 means no skill; a plus means our higher forecasts went with better skies on that cam. " +
      `A cam counts once it has ${f.camMin} pairs. The pooled number is the average over cams, weighted by each cam's pairs. ` +
      `A real Great is in that cam's own top 25% for that event kind, and a real Amazing in its top 10%. ` +
      `A version needs ${f.min} pairs before it shows any number. Newest version first.`,
    "",
    table(
      [
        "Model version",
        "Forecast rows loaded",
        "Past events with a 30–120 min forecast",
        "Pairs",
        "Fair rank correlation",
        "Sunrises",
        "Sunsets",
        "Great calls in the cam's top 25%",
        "Amazing calls in the cam's top 10%",
        "Raw typical miss (pts)",
        "Raw bias (pts)",
      ],
      f.versions.map((v) => [
        versionLabel(v),
        v.rows,
        v.events,
        v.pairs,
        v.rank.rho != null
          ? `${rho2(v.rank.rho)} (${plural(v.rank.events, "event")}, ${plural(v.rank.cams, "cam")})`
          : (v.rank.collecting ?? DASH),
        v.rank.byKind.sunrise.rho != null ? `${rho2(v.rank.byKind.sunrise.rho)} (n=${v.rank.byKind.sunrise.events})` : DASH,
        v.rank.byKind.sunset.rho != null ? `${rho2(v.rank.byKind.sunset.rho)} (n=${v.rank.byKind.sunset.events})` : DASH,
        tierCell(v.tiers.great),
        tierCell(v.tiers.amazing),
        v.raw.mae == null ? (v.raw.collecting ?? DASH) : num(v.raw.mae),
        signed(v.raw.bias),
      ]),
    ),
    "",
    "In the top-tier columns, \"3 of 8\" means 3 of our 8 Great calls landed in the cam's top 25%. Chance alone gives 25% (Amazing: 10%). " +
      `A rate needs 10 calls; until then it shows "n=<count>, collecting". Only cams with ${f.camMin}+ events of their own have a scale.`,
  ];
  const thin = f.camScales.filter((c) => !c.counted);
  if (thin.length) {
    out.push(
      "",
      `Cams with fewer than ${f.camMin} events of their own, so no scale yet (left out of the top-tier counts): ` +
        thin.map((c) => `${c.cam} (${c.kind}, ${c.events})`).join(", ") +
        ".",
    );
  }

  out.push(
    "",
    "### Coverage of the forecast people see",
    "",
    `How many past events have a forecast made ${HEADLINE_LEAD_MIN} to ${HEADLINE_LEAD_MAX} minutes before them. An event without one cannot enter the fair grade.`,
    "",
    table(
      ["Event", "Past events", "With a 30–120 min forecast", "Share", "With a camera reading", "Of those, with the forecast", "Share"],
      f.coverage.map((c) => [
        kindName(c.kind),
        c.pastEvents,
        c.withHeadline,
        pct(c.share),
        c.pairedEvents,
        c.pairedWithHeadline,
        pct(c.pairedShare),
      ]),
    ),
  );

  const camRows = f.versions.flatMap((v) =>
    v.cams.map((c) => [versionLabel(v), c.cam, kindName(c.kind), c.pairs, c.rho != null && v.ready ? rho2(c.rho) : (v.ready ? c.collecting : v.collecting) ?? DASH]),
  );
  if (camRows.length) {
    out.push(
      "",
      "### Rank correlation per cam",
      "",
      `Our forecast (30–120 min out) against the cam's own score, by rank. Each cam needs ${f.camMin} pairs. ` +
        "Boca Raton and Deerfield Beach share the Deerfield cams. Each reading counts once, for the beach nearest the cam (Deerfield Beach).",
      "",
      table(["Model version", "Cam", "Event", "Pairs", "Rank correlation"], camRows),
    );
  }

  const bandRows = f.versions.flatMap((v) =>
    v.rawByBand.map((g) => [
      versionLabel(v),
      BAND_LABEL[g.key] ?? g.key,
      g.events,
      g.mae == null ? (g.collecting ?? DASH) : num(g.mae),
      signed(g.bias),
    ]),
  );
  if (bandRows.length) {
    out.push(
      "",
      "### The forecast people see, by band (raw camera scale)",
      "",
      "Each band needs 10 events. Bias is forecast minus the raw camera score.",
      "",
      table(["Model version", "We said", "Events", "Typical miss (pts)", "Bias (pts)"], bandRows),
    );
  }
  return out;
}

function afterglowTable(side: AfterglowSide): string[] {
  if (side.cams.length === 0) return ["No afterglow readings in the window."];
  const rows: (string | number)[][] = [];
  for (const c of side.cams) {
    const versions = [...new Set([...c.headline.map((x) => x.version), ...c.call.map((x) => x.version)])];
    const cellText = (x: { n: number; rho: number | null; collecting: string | null } | undefined) =>
      x == null ? "n=0" : x.rho != null ? `${rho2(x.rho)} (n=${x.n})` : `${x.collecting ?? DASH}`;
    const sat = c.cloud.rho != null ? `${rho2(c.cloud.rho)} (n=${c.cloud.n})` : (c.cloud.collecting ?? DASH);
    if (versions.length === 0) {
      rows.push([c.cam, c.readings, c.matched, DASH, "n=0", "n=0", sat]);
      continue;
    }
    versions.forEach((v, i) => {
      rows.push([
        i === 0 ? c.cam : "",
        i === 0 ? c.readings : "",
        i === 0 ? c.matched : "",
        v,
        cellText(c.headline.find((x) => x.version === v)),
        cellText(c.call.find((x) => x.version === v)),
        i === 0 ? sat : "",
      ]);
    });
  }
  const out = [
    table(
      [
        "Cam",
        "Afterglow readings",
        "Matched to a forecast event",
        "Model version",
        "Forecast 30–120 min out vs afterglow",
        "Call (60+ min out) vs afterglow",
        "Satellite cloud away from the sun vs afterglow",
      ],
      rows,
    ),
  ];
  const notes: string[] = [];
  if (side.unmatched) notes.push(`${side.unmatched} readings matched no forecast event`);
  if (side.wrongFacing) notes.push(`${side.wrongFacing} came from a cam whose registry facing does not fit, and were left out`);
  if (notes.length) out.push("", `${notes.join("; ")}.`);
  return out;
}

/** Afterglow (antisolar) readings, graded by rank per cam. Never part of the solar numbers. */
function afterglowBlocks(r: SunSection): string[] {
  const a = r.afterglow;
  if (!a) return ["", "### East-coast sunsets: the afterglow over the ocean", "", "Not available — the camera readings did not load."];
  return [
    "",
    "### East-coast sunsets: the afterglow over the ocean",
    "",
    "An east-facing cam looks away from the sun at sunset. It sees the afterglow on the clouds over the ocean. " +
      "On an east-coast beach that afterglow is what a beachgoer sees at sunset. " +
      "These readings are never the truth for the sunset's color, and they are not in any number above. " +
      `Here each cam is graded by rank only (Spearman, ${r.fair.camMin}+ events per cell). ` +
      "The satellite column is the mid and high cloud along the path away from the sun (breakdown_json.satellite.antiMidHighPct). " +
      "The satellite is read only within 60 minutes of the event, so only some events have it. It is evidence for a future afterglow forecast, not a grade.",
    "",
    ...afterglowTable(a.sunset),
    "",
    "### Gulf sunrises: the afterglow over the Gulf",
    "",
    "The same check for west-facing Gulf cams at sunrise. The sun rises behind them, over the land, and they see the afterglow on the clouds over the Gulf.",
    "",
    ...afterglowTable(a.sunrise),
  ];
}

function confusionTable(label: string, c: RainResult["next1h"]): string {
  return [
    `**${label}**`,
    "",
    table(
      ["Forecast said", "Radar saw rain", "Radar saw no rain"],
      [
        ["Rain", c.hits, c.falseAlarms],
        ["Dry", c.misses, c.correctDry],
      ],
    ),
    "",
    `When we forecast rain: radar confirmed it ${rateCell(c.hitRate)} of the time, and did not ${rateCell(c.falseAlarmRate)}. ` +
      `Of the times radar saw rain, we had forecast dry ${rateCell(c.missRate)}. ` +
      `Of our dry forecasts, ${rateCell(c.dryRainedOnRate)} got rained on.`,
  ].join("\n");
}

function rainSection(s: Section<RainResult>): string {
  if (!s.ok) return `Not available — ${s.error}`;
  const r = s.result;
  const out = [
    'The app says "dry" or "raining" from a weather model, with a note on when that changes. ' +
      'We turn that into a forecast for one hour ahead and two hours ahead. "Dry, rain in 25 min" is a rain forecast for both. ' +
      '"Raining, easing in 25 min" is a dry forecast for both. A change at or before the hour has happened by then. ' +
      "Then we check each forecast against the radar reading one and two hours later. " +
      "Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes. " +
      "A radar frame older than 25 minutes is not used.",
    "",
    `- Hours with a rain call: ${r.calls}.`,
    `- Scored (radar available one and two hours later): ${r.scored}. ${r.ready ? "Enough to score." : `Status: ${r.collecting}.`}`,
    `- Each rate needs enough cases in its own denominator (10 for the matrices, ${r.dryPromise.rate.min} for the headline); until then it shows "n=<count>, collecting".`,
  ];
  if (r.scored > 0) {
    const p = r.dryPromise;
    out.push(
      "",
      `Headline, the promise "Dry for the next 2+ hrs" (dry now, no rain forecast for 2 hours): ${plural(p.n, "call")} scored; ` +
        `${p.rainedOn} saw radar rain within 2 hours` +
        (p.rate.value != null ? ` (${pct(p.rate.value)}).` : ` (${p.rate.collecting}; needs ${p.rate.min}).`),
      "",
      confusionTable("Forecast one hour ahead, against radar one hour later", r.next1h),
      "",
      confusionTable("Forecast two hours ahead, against radar two hours later", r.next2h),
    );
  }
  return out.join("\n");
}

function windowSection(s: Section<WindowResult>): string {
  if (!s.ok) return `Not available — ${s.error}`;
  const r = s.result;
  const out = [
    "Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. " +
      "Then we compare it with the hourly scores we archived for that day. " +
      "Only a complete day counts: it must be over, have at least 8 scored daylight hours, have 80% of the daylight hours between its first and last archived hour, " +
      "start within 2 hours of sunrise, and reach 5 PM local (or the last daylight hour). " +
      "A day that fails this is censored: its archived hours cover only part of the day, so it has no honest best hour.",
    "",
    `- Complete days: ${r.completeDays}.`,
    `- Of those, with a window named by 10 AM: ${r.daysScored}. ${r.ready ? "Enough to score." : `Status: ${r.collecting}.`}`,
    `- Left out: ${r.skipped.censoredDay} censored days (missing hours), ${r.skipped.versionMixed} scored by two model versions (a deploy day), ${r.skipped.incompleteDay} still in progress, ${r.skipped.noEarlyWindow} with no early window. Outlook forecasts skipped across a model change: ${r.skipped.outlookVersionMismatch}.`,
  ];
  if (r.ready) {
    out.push(
      "",
      table(
        ["", "Value"],
        [
          ["Days scored", r.daysScored],
          ["Average window length (hours)", num(r.meanWindowHours)],
          ["Local hour the window was named (average)", num(r.meanPredictedAtHour)],
          ["Average archived score inside our window", num(r.realizedInWindow)],
          ["Average of the best 3 archived hours in a row", num(r.realizedBest3h)],
          ["Gap (points we left on the table)", num(r.gapPts)],
          ["Days the best hour fell inside our window", pct(r.peakInWindowShare)],
          ["Days our window score was within 10 points of the archived average inside it", pct(r.within10Share)],
          ["Window score minus archived average inside it (pts)", signed(r.windowScoreBias)],
        ],
      ),
      "",
      "The window score is the window's peak hour, so it runs a little above the window's average by design.",
    );
  }
  if (r.outlook.length) {
    out.push(
      "",
      "### Days ahead",
      "",
      "The peak score we promised some days ahead, against the best archived hour of that day. Only complete days count. Bias is promised minus archived.",
      "",
      table(
        ["Days ahead", "Days scored", "Typical miss (pts)", "Bias (pts)"],
        r.outlook.map((o) => [o.leadDays, o.days, o.mae == null ? o.collecting ?? DASH : num(o.mae), signed(o.bias)]),
      ),
    );
  } else {
    out.push("", "Days ahead: no outlook rows with a finished target day yet.");
  }
  return out.join("\n");
}

function safetySection(s: Section<SafetyResult>): string {
  if (!s.ok) return `Not available — ${s.error}`;
  const r = s.result;
  const out = [
    "We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. " +
      "The City posts one flag a beach a day, so we count beach-days, not hours. " +
      "A beach-day's flag is its most common flag. Our message is its most common swim level; a tie goes to the more serious one. " +
      "Only beaches with a posted flag count.",
    "",
    `- Beach-days with a swim message and a known flag: ${r.beachDays} (from ${r.hours} hourly rows). ${r.ready ? "Enough to score." : `Status: ${r.collecting}.`}`,
  ];
  if (r.beachDays > 0) {
    const flagRows = FLAG_ORDER.filter((f) => SWIM_LEVELS.some((l) => (r.crossTab[f]?.[l] ?? 0) > 0)).map((f) => [
      f,
      ...SWIM_LEVELS.map((l) => r.crossTab[f]?.[l] ?? 0),
    ]);
    out.push(
      "",
      "### Swim message by flag (beach-days)",
      "",
      table(["Flag", "Safe", "Caution", "Stay out"], flagRows),
      "",
      "A red or double-red flag sets \"stay out\" directly (lib/safetyLine.ts). Those rows say nothing about our own judgement. The next section leaves them out.",
    );
    const i = r.informative;
    out.push(
      "",
      "### Green and yellow flags only",
      "",
      `- Beach-days: ${i.beachDays} (${i.yellowDays} yellow, ${i.greenDays} green). ${i.ready ? "" : `Status: ${i.collecting}.`}`,
      `- Agreement (yellow with caution or stay out, or green with safe): ${i.agreeDays} of ${i.beachDays}; rate ${rateCell(i.agreement)}.`,
      `- Yellow flag, but we said safe: ${i.yellowWeSaidSafe}.`,
      `- Green flag, but we said caution or stay out: ${i.greenWeCautioned}.`,
    );
    if (i.greenReasons.length) {
      out.push("", "Why we cautioned under a green flag:", "", ...i.greenReasons.map((x) => `- ${x.reason}: ${plural(x.days, "beach-day")}`));
    }
  }
  return out.join("\n");
}

function healthSection(s: Section<HealthResult>): string {
  if (!s.ok) return `Not available — ${s.error}`;
  const r = s.result;
  const out: string[] = [
    `- Beaches with rows in the last 7 days: ${r.beaches}.`,
    `- Extra data (the prediction blocks) is on ${pct1(r.extra.windowPct)} of rows in this report's window, ${pct1(r.extra.last24hPct)} of the last 24 hours, ` +
      `and ${pct1(r.extra.sinceFirstPct)} of rows since the first one` +
      (r.extra.firstHourUtc ? ` (${r.extra.firstHourUtc.slice(0, 13).replace("T", " ")}Z).` : "."),
  ];
  const blocks = Object.entries(r.blockPct24h);
  if (blocks.length && r.extra.last24hPct != null && r.extra.last24hPct > 0) {
    out.push(`- Share of the last 24 hours' extra rows with each block: ${blocks.map(([k, v]) => `${k} ${pct1(v)}`).join(", ")}.`);
  }
  if (r.hourGaps) {
    const m = r.hourGaps.missing;
    out.push(
      m.length
        ? `- Local hours missing on beaches that should archive all 24 (${plural(r.hourGaps.beaches, "beach", "beaches")}, ${plural(r.hourGaps.days, "beach-day")}): ` +
            `${m.map((x) => `${x.hour} (${x.pct}% present)`).join(", ")}. "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.`
        : `- Beaches that should archive all 24 hours have rows for every local hour on at least 80% of days.`,
    );
  }
  if (r.underMin.length) {
    const SHOW = 10;
    out.push(
      `- Beaches under ${MIN_ROWS_PER_DAY} rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:`,
      "",
      table(
        ["Beach", "Tier", "Rows per day", "Expected", "Fewest in a day", "Days counted"],
        r.underMin.slice(0, SHOW).map((b) => [b.slug, b.tier ?? DASH, b.perDay, b.expected ?? DASH, b.minDay, b.days]),
      ),
      "",
    );
    if (r.underMin.length > SHOW) {
      const rest = r.underMin.slice(SHOW);
      out.push(
        `  And ${rest.length} more (${rest[0].perDay} to ${rest[rest.length - 1].perDay} rows a day).`,
        "",
      );
    }
  } else {
    out.push(`- No beach is under ${MIN_ROWS_PER_DAY} rows a day.`);
  }
  if (r.cams == null) {
    out.push("- Camera captures: not available.");
  } else if (r.cams.length === 0) {
    out.push("- Camera captures: none archived.");
  } else {
    out.push(
      `- Latest camera capture per beach (oldest first): ${r.cams
        .slice(0, 5)
        .map((c) => `${c.slug} ${c.ageHours} h ago`)
        .join(", ")}${r.cams.length > 5 ? `, and ${r.cams.length - 5} more` : ""}.` +
        (r.camsStale.length ? ` Silent for over ${CAM_STALE_HOURS} hours: ${r.camsStale.map((c) => c.slug).join(", ")}.` : ""),
    );
  }
  if (r.courierDown) {
    out.push(
      `- Courier down${r.courierDown.since ? ` since ${etTime(r.courierDown.since)}` : ""}` +
        (r.courierDown.newest ? ` (newest courier frame ${etTime(r.courierDown.newest)})` : " (no courier frame on record)") +
        ": its cameras stay on the page with an old picture and are not hidden one by one. Check the home server.",
    );
  }
  if (r.camsOffline == null) {
    out.push("- Cameras hidden as offline: not checked.");
  } else if (r.camsOffline.length === 0) {
    out.push("- Cameras hidden as offline: none.");
  } else {
    out.push(
      `- Cameras hidden as offline (they come back on their own with the first good frame): ${r.camsOffline.length}`,
      ...r.camsOffline.map((c) => `  - ${offlineCamLine(c)}`),
    );
  }
  out.push(
    r.sunObs
      ? `- Sun camera readings: ${r.sunObs.count}` +
          (r.sunObs.latestEventIso ? `; latest event ${r.sunObs.latestEventIso}` : "") +
          (r.sunObs.latestScoredAt ? `, scored ${r.sunObs.latestScoredAt}.` : ".")
      : "- Sun camera readings: not available.",
    r.sunPredictionsLast24h == null
      ? "- Sun-color forecast rows in the last 24 hours: not available."
      : `- Sun-color forecast rows in the last 24 hours: ${r.sunPredictionsLast24h}.`,
  );
  return out.join("\n");
}

/** The report as Markdown. */
export function renderMarkdown(card: Scorecard): string {
  const day = card.asOf.slice(0, 10);
  const h = card.headlines;
  const lines = [
    `# Prediction scorecard — ${day}`,
    "",
    `Data as of ${card.asOf.slice(0, 16).replace("T", " ")} UTC. Hourly rows cover the last ${card.days} days. ` +
      (card.sunWindowDays != null
        ? `Sun-color events cover the last ${card.sunWindowDays} days; lifetime counts are shown in that section. `
        : "Sun-color events cover everything since the log began. ") +
      'A system with too little data says "collecting" and shows counts only. That is expected early on. ' +
      "See docs/scorecards/README.md for definitions and minimums.",
    "",
  ];
  if (card.warnings.length) lines.push(...card.warnings.map((w) => `> Warning: ${w}`), "");
  lines.push(
    "## At a glance",
    "",
    `- **Sunrise and sunset color:** ${h.sun}`,
    `- **Rain forecast:** ${h.rain}`,
    `- **Best time to go:** ${h.window}`,
    `- **Safety message and flags:** ${h.safety}`,
    `- **Data health:** ${h.health}`,
    "",
    "## Sunrise and sunset color",
    "",
    sunSection(card.sun),
    "",
    "## Rain forecast",
    "",
    rainSection(card.rain),
    "",
    "## Best time to go",
    "",
    windowSection(card.window),
    "",
    "## Safety message and lifeguard flags",
    "",
    safetySection(card.safety),
    "",
    "## Data health",
    "",
    healthSection(card.health),
    "",
    "---",
    "",
    "Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.",
    "",
  );
  return lines.join("\n");
}
