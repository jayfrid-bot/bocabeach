// Presentation helpers (safe to import on the client).

export function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(new Date(iso));
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
  if (ft < 3) return { label: "Light chop", note: "a little texture, easy swim" };
  if (ft < 4.5) return { label: "Choppy", note: "noticeable waves and push" };
  if (ft < 6) return { label: "Really choppy", note: "strong push — heads-up swimming" };
  if (ft < 9) return { label: "Big waves", note: "powerful surf — watch the flags" };
  return { label: "Very rough", note: "heavy surf — follow lifeguard flags" };
}

/** The brand's plain-English answer to "is it beach day?" for a 0-100 score. */
export function beachDayVerdict(score: number): string {
  if (score >= 80) return "Yes!";
  if (score >= 65) return "Pretty much";
  if (score >= 45) return "Maybe";
  return "Not really";
}

/** Accent color for a 0-100 score. */
export function scoreColor(score: number): string {
  if (score >= 80) return "#34d399"; // emerald-400
  if (score >= 65) return "#a3e635"; // lime-400
  if (score >= 45) return "#fbbf24"; // amber-400
  return "#fb7185"; // rose-400
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
