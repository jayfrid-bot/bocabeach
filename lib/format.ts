// Presentation helpers (safe to import on the client).

export function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(new Date(iso));
}

/**
 * Ultra-compact time for tight spaces, e.g. "6a" or "6:30p" — drops the
 * minutes when they're :00 and collapses AM/PM to a single letter. Used by
 * the mobile best-times strip, where a full "6:00 AM" won't fit a ~45px tile.
 */
export function fmtTimeCompact(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  const suffix = dayPeriod.toLowerCase().startsWith("p") ? "p" : "a";
  return minute && minute !== "00" ? `${hour}:${minute}${suffix}` : `${hour}${suffix}`;
}

/** Short calendar date, e.g. "May 26", in the given timezone. */
export function fmtDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  }).format(new Date(iso));
}

export function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Plain-English sea state for a combined wave height (ft) — what the water
 * actually feels like, not just a number. Bands follow how SoFla beach days
 * read in practice: under a foot is flat; swimming gets pushy past ~3 ft;
 * 6 ft+ is surf, not swimming. Descriptive only — flags rule safety.
 */
export function seaState(waveHeightFt: number): { label: string; note: string } {
  const ft = Math.max(0, waveHeightFt);
  if (ft < 1) return { label: "Calm", note: "flat, glassy water" };
  if (ft < 2) return { label: "Gentle", note: "small lapping waves" };
  if (ft < 2.5) return { label: "Light chop", note: "a little texture, easy swim" };
  if (ft < 3) return { label: "Choppy", note: "noticeable waves and push" };
  if (ft < 4.5) return { label: "Really choppy", note: "strong push — heads-up swimming" };
  if (ft < 7) return { label: "Big waves", note: "powerful surf — watch the flags" };
  return { label: "Very rough", note: "heavy surf — follow lifeguard flags" };
}

/** The brand's plain-English answer to "is it beach day?" for a 0-100 score. */
export function beachDayVerdict(score: number): string {
  if (score >= 80) return "Yes!";
  if (score >= 65) return "Pretty much";
  if (score >= 45) return "Maybe";
  return "Not really";
}

/** Accent color for a 0-100 score. Used for the gauge arc fill. */
export function scoreColor(score: number): string {
  if (score >= 80) return "#34d399"; // emerald-400
  if (score >= 65) return "#a3e635"; // lime-400
  if (score >= 45) return "#fbbf24"; // amber-400
  return "#fb7185"; // rose-400
}

/**
 * Tailwind text color for a 0-100 score, mirroring scoreColor's bands but with
 * light/dark variants for verdict/rating TEXT — the 400-level hex from
 * scoreColor fails WCAG AA on a white background, so text uses 600/400.
 */
export function scoreTextClass(score: number): string {
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 65) return "text-lime-600 dark:text-lime-400";
  if (score >= 45) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

// --- Continuous color interpolation ----------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Linearly interpolate a hex color across an ordered list of stops for a
 * fraction 0..1 (clamped, and out-of-range values pin to the nearest end
 * stop). Lets bars driven by a continuous value (e.g. avg/maxRank) shade
 * smoothly instead of jumping between a fixed set of categorical colors.
 */
export function interpolateColor(fraction: number, stops: string[]): string {
  if (stops.length === 0) return "#000000";
  if (stops.length === 1) return stops[0];
  const t = Math.min(1, Math.max(0, fraction));
  const segments = stops.length - 1;
  const scaled = t * segments;
  const i = Math.min(segments - 1, Math.floor(scaled));
  const localT = scaled - i;
  const [r1, g1, b1] = hexToRgb(stops[i]);
  const [r2, g2, b2] = hexToRgb(stops[i + 1]);
  return rgbToHex(r1 + (r2 - r1) * localT, g1 + (g2 - g1) * localT, b1 + (b2 - b1) * localT);
}

// --- US EPA Air Quality Index bands ----------------------------------------
export interface AqiBand {
  /** Inclusive upper bound of the band. */
  max: number;
  label: string;
  color: string;
}

/** Standard US EPA AQI categories (0-50 Good … 301+ Hazardous). */
export const AQI_BANDS: AqiBand[] = [
  { max: 50, label: "Good", color: "#34d399" }, // emerald-400
  { max: 100, label: "Moderate", color: "#fbbf24" }, // amber-400
  { max: 150, label: "Unhealthy for sensitive groups", color: "#fb923c" }, // orange-400
  { max: 200, label: "Unhealthy", color: "#fb7185" }, // rose-400
  { max: 300, label: "Very unhealthy", color: "#c084fc" }, // purple-400
  { max: Infinity, label: "Hazardous", color: "#9f1239" }, // rose-800
];

/** Top of the meter's plotted scale; AQI above this pins to the end. */
export const AQI_SCALE_MAX = 300;

export function aqiBand(aqi: number): AqiBand {
  return AQI_BANDS.find((b) => aqi <= b.max) ?? AQI_BANDS[AQI_BANDS.length - 1];
}
export const aqiCategory = (aqi: number): string => aqiBand(aqi).label;
export const aqiColor = (aqi: number): string => aqiBand(aqi).color;
