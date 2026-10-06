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
  dataHealth,
  rainMetrics,
  safetyMetrics,
  sunColorMetrics,
  windowMetrics,
  type DaylightFn,
  type ErrorGroup,
  type HealthResult,
  type HourlyRow,
  type Rate,
  type RainResult,
  type SafetyResult,
  type SunColorResult,
  type SunPredictionRow,
  type WindowResult,
} from "@/lib/scorecard/metrics";

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
}

// --- Output -----------------------------------------------------------------

export type Section<T> = { ok: true; result: T } | { ok: false; error: string };

export interface SunSection extends SunColorResult {
  /** Camera readings that matched no forecast row (null when unknown). */
  observationsWithoutForecast: number | null;
  /** Camera readings in the archive. */
  observations: number | null;
  /** Forecast rows loaded. */
  forecastRows: number;
  windowDays: number | null;
  lifetime: SunLifetime | null;
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
        return {
          ...m,
          forecastRows: (raw.sunPredictions as SunPredictionRow[]).length,
          windowDays: raw.sunWindowDays ?? null,
          lifetime: raw.sunLifetime ?? null,
          observations: obs ? obs.length : null,
          observationsWithoutForecast: obs ? obs.filter((o) => !matchesForecast(o, pairedRows)).length : null,
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
  if (!r.ready) {
    const cams = r.observations == null ? "camera readings unknown" : plural(r.observations, "camera reading");
    return `${r.collecting}. (${plural(r.events, "event")} forecast, ${cams} so far.)`;
  }
  const g = r.calls.great;
  const parts = [
    `${plural(r.pairedEvents, "pair")}. Typical miss ${num(r.overall.mae)} points; bias ${signed(r.overall.bias)} (plus means we run high).`,
  ];
  if (r.calls.ready) {
    parts.push(
      `Great-or-better calls: ${g.hits} of ${g.calls} were right; ${g.misses} of ${g.observedAtOrAbove} real ones were missed.`,
    );
  } else {
    parts.push(`Calls: ${r.calls.collecting}.`);
  }
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
    `- Events loaded (a forecast made ${CALL_MIN_LEAD_MIN}+ minutes ahead, or a camera reading)` +
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
    out.push(
      `- Camera readings in the window: ${r.observations}` +
        (r.observationsWithoutForecast ? `; ${r.observationsWithoutForecast} of them matched no forecast row, so they cannot be scored.` : "."),
    );
  }

  if (r.pairedEvents > 0) {
    out.push(
      "",
      "Bias is forecast minus camera, so a plus means we ran high. Typical miss is the average size of the error.",
      "",
      "### Error overall and by group",
      "",
      table(ERR_HEADERS, [
        ...errorRows([r.overall], () => "All pairs"),
        ...errorRows(r.byLead, (k) => `Lead: ${LEAD_LABEL[k] ?? k}`),
        ...errorRows(r.byBand, (k) => `We said: ${BAND_LABEL[k] ?? k}`),
        ...errorRows(r.byBeach, (k) => `Beach: ${k}`),
        ...errorRows(r.byAlgo, (k) => `Model version: ${k}`),
        ...errorRows(r.byView, (k) => `Camera view: ${k}`),
      ]),
    );
  }

  const c = r.calls;
  if (c.events > 0) {
    out.push(
      "",
      "### Our call versus what happened",
      "",
      `The call is our last forecast made at least ${CALL_MIN_LEAD_MIN} minutes before the event. ` +
        `Great means ${GREAT_CUTOFF} or more. Amazing means ${AMAZING_CUTOFF} or more. ` +
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
      "### How often we say Great or Amazing",
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
  return out.join("\n");
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
    `- Left out: ${r.skipped.censoredDay} censored days (missing hours), ${r.skipped.incompleteDay} still in progress, ${r.skipped.noEarlyWindow} with no early window.`,
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
