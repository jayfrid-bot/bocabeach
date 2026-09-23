// Pure helpers behind the Sun panel's arc dial: where the sun/moon sit on the
// arc right now, golden-hour windows, and the "time until" payoff line. No
// Date.now()/Math.random() in here — every function takes `nowMs` explicitly
// so the component can stay hydration-safe (SSR renders a neutral state,
// then the mounted clock supplies a real `nowMs`).

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Round to 2 decimals so SSR and client hydration paths agree exactly on
 *  SVG coordinates (same convention as ScoreWheel/WaveHeightCard). */
export const round2 = (v: number): number => Math.round(v * 100) / 100;

// --- Daylight position -------------------------------------------------

export interface DaySpan {
  sunriseMs: number;
  sunsetMs: number;
  /** Solar noon, if known — used to make the arc's apex land on the real
   *  peak instead of assuming it's the midpoint of sunrise/sunset. */
  solarNoonMs?: number;
}

export function isDaylight(nowMs: number, span: DaySpan): boolean {
  return span.sunsetMs > span.sunriseMs && nowMs >= span.sunriseMs && nowMs <= span.sunsetMs;
}

/**
 * Progress through the daylight arc, 0 (sunrise) to 1 (sunset), clamped.
 * When solar noon is known and falls strictly between sunrise and sunset,
 * uses a two-segment mapping (sunrise→noon = [0, 0.5], noon→sunset =
 * [0.5, 1]) so the visual apex is honest to the real peak — many days the
 * solar noon isn't exactly the midpoint of sunrise/sunset. Falls back to a
 * straight linear fraction when noon is missing or degenerate.
 */
export function daylightFraction(nowMs: number, span: DaySpan): number {
  const { sunriseMs, sunsetMs, solarNoonMs } = span;
  if (sunsetMs <= sunriseMs) return 0.5;
  if (solarNoonMs != null && solarNoonMs > sunriseMs && solarNoonMs < sunsetMs) {
    if (nowMs <= solarNoonMs) {
      return 0.5 * clamp01((nowMs - sunriseMs) / (solarNoonMs - sunriseMs));
    }
    return 0.5 + 0.5 * clamp01((nowMs - solarNoonMs) / (sunsetMs - solarNoonMs));
  }
  return clamp01((nowMs - sunriseMs) / (sunsetMs - sunriseMs));
}

// --- Golden hour ---------------------------------------------------------

export interface GoldenHourWindow {
  startMs: number;
  endMs: number;
}

/** Golden hour, per lib/sources/sun.ts: 20 min before to 20 min after
 *  sunrise, and the same either side of sunset — the default fallback when
 *  the snapshot's own goldenAm/EveStart/EndIso fields aren't available
 *  (older cached snapshots). NOT the first/last full hour of daylight. */
const DEFAULT_GOLDEN_HALF_MS = 20 * 60_000;

/** Either side's window, straight from the snapshot's own
 *  goldenAm/EveStart/EndIso fields (already epoch ms here — the caller
 *  parses the ISO strings). Passing these keeps the arc's shading and
 *  "golden now" read in exact agreement with the Sunrise/Sunset color card,
 *  which reads the very same fields. */
export interface GoldenHourExplicit {
  morning?: GoldenHourWindow;
  evening?: GoldenHourWindow;
}

/**
 * Golden-hour windows straddling real sunrise/sunset: the snapshot's own
 * bounds when given (`explicit`), else ±20 min around each event. Windows
 * are NOT clamped to [sunrise, sunset] — golden hour spans that boundary by
 * design, half before and half after — so `isGoldenHour` reads true for the
 * whole window even though the arc's own geometry only extends
 * sunrise→sunset (drawing clips itself for free: `daylightFraction` already
 * clamps any time outside that range to 0 or 1). On a day shorter than the
 * window would need, the two windows are clamped to meet at the midpoint
 * rather than overlap.
 */
export function goldenHourWindows(
  span: DaySpan,
  explicit?: GoldenHourExplicit,
): { morning: GoldenHourWindow; evening: GoldenHourWindow } | null {
  const { sunriseMs, sunsetMs } = span;
  if (sunsetMs <= sunriseMs) return null;
  const half = Math.min(DEFAULT_GOLDEN_HALF_MS, (sunsetMs - sunriseMs) / 2);
  const morning = explicit?.morning ?? { startMs: sunriseMs - half, endMs: sunriseMs + half };
  const evening = explicit?.evening ?? { startMs: sunsetMs - half, endMs: sunsetMs + half };
  return { morning, evening };
}

export function isGoldenHour(nowMs: number, span: DaySpan, explicit?: GoldenHourExplicit): boolean {
  const w = goldenHourWindows(span, explicit);
  if (!w) return false;
  return (
    (nowMs >= w.morning.startMs && nowMs <= w.morning.endMs) ||
    (nowMs >= w.evening.startMs && nowMs <= w.evening.endMs)
  );
}

/**
 * Where to draw the golden-hour glow when it's golden hour but NOT
 * daylight — the pre-sunrise half of the morning window, or the post-sunset
 * half of the evening window. The arc's real sun dot only exists in
 * daylight (`arcPoint` at `daylightFraction`), so those two halves would
 * otherwise show plain night despite `isGoldenHour` reading true; this pins
 * the glow to whichever horizon end the window belongs to instead: 0
 * (sunrise end, left) before sunrise, 1 (sunset end, right) after sunset.
 * Returns null outside those two halves — ordinary daylight (where the
 * caller has a real position) or full night, both the caller's job.
 */
export function goldenHorizonEnd(nowMs: number, span: DaySpan, explicit?: GoldenHourExplicit): 0 | 1 | null {
  const w = goldenHourWindows(span, explicit);
  if (!w) return null;
  if (nowMs < span.sunriseMs && nowMs >= w.morning.startMs && nowMs <= w.morning.endMs) return 0;
  if (nowMs > span.sunsetMs && nowMs >= w.evening.startMs && nowMs <= w.evening.endMs) return 1;
  return null;
}

// --- Night position (moon on the arc's underside) -------------------------

/**
 * Progress through tonight's dark span, 0 (sunset) to 1 (next sunrise), for
 * positioning the moon on the underside of the arc. We only have TODAY's sun
 * times, so the far endpoint is estimated by mirroring today's day length
 * (day length shifts by only minutes day-to-day, so assuming tomorrow's
 * sunrise/yesterday's sunset land a similar night length is an honest
 * approximation, not a fabricated value). Returns null outside night or for
 * degenerate spans.
 */
export function nightProgress(nowMs: number, span: DaySpan): number | null {
  const { sunriseMs, sunsetMs } = span;
  if (sunsetMs <= sunriseMs) return null;
  const dayLenMs = sunsetMs - sunriseMs;
  const nightLenMs = DAY_MS - dayLenMs;
  if (nightLenMs <= 0) return null;
  if (nowMs > sunsetMs) {
    return clamp01((nowMs - sunsetMs) / nightLenMs);
  }
  if (nowMs < sunriseMs) {
    const estPrevSunsetMs = sunriseMs - nightLenMs;
    return clamp01((nowMs - estPrevSunsetMs) / nightLenMs);
  }
  return null;
}

// --- "Time until" payoff line ---------------------------------------------

/** "2h 10m" / "45m" — whole minutes, floor of zero. */
export function fmtDurationShort(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * The beach-goer payoff line: how much daylight is left, or how long until
 * sunrise. Returns null when we're past sunset (the arc's night state — moon
 * readout, not a fabricated next-sunrise countdown — carries the payoff then).
 */
export function daylightStatusLabel(nowMs: number, span: DaySpan): string | null {
  const { sunriseMs, sunsetMs } = span;
  if (sunsetMs <= sunriseMs) return null;
  if (nowMs < sunriseMs) {
    return `Sunrise in ${fmtDurationShort(sunriseMs - nowMs)}`;
  }
  if (nowMs <= sunsetMs) {
    return `Sunset in ${fmtDurationShort(sunsetMs - nowMs)}`;
  }
  return null;
}

// --- Arc geometry (pure, testable) -----------------------------------------

export interface ArcGeometry {
  width: number;
  paddingX: number;
  horizonY: number;
  apexY: number;
}

/** Point on the day arc for progress fraction f (0 = left/sunrise end, 1 =
 *  right/sunset end, 0.5 = apex). Coordinates rounded for SSR/hydration
 *  stability. */
export function arcPoint(f: number, geo: ArcGeometry): { x: number; y: number } {
  const t = clamp01(f);
  const x = geo.paddingX + t * (geo.width - 2 * geo.paddingX);
  const y = geo.horizonY - Math.sin(Math.PI * t) * (geo.horizonY - geo.apexY);
  return { x: round2(x), y: round2(y) };
}

/**
 * Mirror point on the arc's underside (below the horizon) for the moon's
 * night-progress fraction f (0 = sunset end, 1 = next-sunrise end). The sun
 * arcs left-to-right above the horizon ending at sunset (the RIGHT edge);
 * night continues the same rotational direction below the horizon from that
 * right edge back around to the following sunrise (the LEFT edge again) — so
 * this is deliberately the MIRROR IMAGE of arcPoint's x mapping, not a copy
 * of it, else the moon would appear to jump backward at dusk.
 */
export function nightArcPoint(
  f: number,
  geo: Pick<ArcGeometry, "width" | "paddingX" | "horizonY"> & { nightDepth: number },
): { x: number; y: number } {
  const t = clamp01(f);
  const x = geo.paddingX + (1 - t) * (geo.width - 2 * geo.paddingX);
  const y = geo.horizonY + Math.sin(Math.PI * t) * geo.nightDepth;
  return { x: round2(x), y: round2(y) };
}
