// What the Apple Watch app shows, computed here with the website's own logic so
// the wrist never says something the page does not. The watch decodes this and
// nothing else (GET /api/watch/<slug>); it has no safety rules of its own.
//
// Every decision below comes from the same functions the dashboard uses:
//   score + live rip cap ... lib/score.ts (applyLiveRipCap) + lib/ripRisk (ripCapFor)
//   flags, rip, advisories, lightning, rain ... deriveMetrics (lib/score.ts), which runs
//     lib/hazards/assess.ts (most recent strike within 5 mi; stale radar = unknown)
//     and lib/ripRisk/resolve.ts (the independent NOAA model + SRF word + alerts)
//   rain on the way ... lib/rainNowcast.ts
//   best time ... lib/scoreBands.ts goodWindow (Decent or better only)
// Missing data is null or an absent line, never a guess.

import { applyLiveRipCap, deriveMetrics, type Derived } from "@/lib/score";
import { ripCapFor } from "@/lib/ripRisk";
import { rainNowcast } from "@/lib/rainNowcast";
import { goodWindow, scoreBand } from "@/lib/scoreBands";
import { PRECIP_RADAR_STALE_MINUTES } from "@/lib/sources/precipRadar";
import type { ConditionsResponse, FlagColor } from "@/lib/types";

export type WatchTone = "calm" | "caution" | "danger";
export type WatchLineKind = "hazard" | "safety" | "water" | "best";

export interface WatchLine {
  kind: WatchLineKind;
  /** Short enough for one or two lines on a small watch. */
  text: string;
  tone: WatchTone;
}

export interface WatchView {
  /** Bump only when a field changes meaning. */
  v: 1;
  slug: string;
  name: string;
  /** 0-100, or null when there was no usable data. */
  score: number | null;
  /** "Excellent" | "Good" | "Decent" | "Marginal" | "Poor"; null with no score. */
  rating: string | null;
  /** Lowercase rating word: the key for the band's color (lib/scoreBands.ts). */
  band: string | null;
  /** The score was built from too little live data. */
  limitedData: boolean;
  /** In display order: hazards (at most 2), flags and rip, water, best time. */
  lines: WatchLine[];
  waterTempF: number | null;
  /** When the server built the conditions snapshot. */
  generatedAt: string | null;
  /** When this view was computed. */
  capturedAt: string;
}

const TONE_RANK: Record<WatchTone, number> = { calm: 0, caution: 1, danger: 2 };
const MAX_HAZARDS = 2;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// ---- lines ------------------------------------------------------------------

function hazardLines(res: ConditionsResponse, d: Derived): WatchLine[] {
  const found: { rank: number; line: WatchLine }[] = [];
  const add = (rank: number, text: string, tone: WatchTone) =>
    found.push({ rank, line: { kind: "hazard", text, tone } });

  const s = res.snapshot;

  // Stay-out reasons (lib/safetyLine.ts swimSafety).
  if (d.lightningWithin5mi) {
    const mi = s.lightning?.data?.nearestMi;
    add(100, finite(mi) ? `Lightning ${Math.round(mi * 10) / 10} mi away` : "Lightning within 5 mi", "danger");
  }
  if (d.severeAlert) add(90, "Severe weather warning", "danger");
  if (d.noSwimAdvisory) add(85, "No-swim advisory", "danger");
  if (d.waterAdvisory) add(80, "Water quality advisory", "danger");

  // Cautions.
  if (d.highSurfAdvisory) add(60, "High surf advisory", "caution");
  if (d.surfAdvisory) add(55, "Beach hazards advisory", "caution");
  if (d.hazardRain?.active) {
    const storm = d.hazardRain.severity === "storm";
    add(
      storm ? 70 : 50,
      storm ? "Thunderstorm" : d.hazardRain.latched ? "Rain in the last 20 min" : "Raining now",
      "caution",
    );
  } else {
    // Rain on its way, only from a radar frame that is still fresh.
    const radar = s.precipRadar;
    const age = radar?.data?.frameAgeMinutes;
    const next = finite(age) && age <= PRECIP_RADAR_STALE_MINUTES ? rainNowcast(radar) : null;
    if (next?.kind === "approaching" && finite(next.etaMinutes)) {
      add(40, `Rain in ~${next.etaMinutes} min`, "caution");
    }
  }
  if (finite(d.waveHeightFt) && d.waveHeightFt > 4) {
    add(30, `Rough water, ~${Math.round(d.waveHeightFt)} ft`, "caution");
  }

  return found
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_HAZARDS)
    .map((f) => f.line);
}

/** "Yellow + purple flags", "Double red flag"; null when no flag is known. */
function flagText(flags: readonly FlagColor[]): { text: string; tone: WatchTone } | null {
  const order: FlagColor[] = ["double-red", "red", "yellow", "green", "purple"];
  const present = order.filter((f) => flags.includes(f));
  if (!present.length) return null;
  const name = (f: FlagColor) => (f === "double-red" ? "double red" : f);
  const first = present[0];
  const words = present.map(name);
  const text =
    present.length === 1
      ? `${words[0][0].toUpperCase()}${words[0].slice(1)} flag`
      : `${words[0][0].toUpperCase()}${words[0].slice(1)} + ${words.slice(1).join(" + ")} flags`;
  const tone: WatchTone =
    first === "double-red" || first === "red" ? "danger" : first === "green" ? "calm" : "caution";
  return { text, tone };
}

function ripText(d: Derived): { text: string; tone: WatchTone } | null {
  const rip = d.ripNow;
  if (!rip) return null;
  if (rip.source === "alert") return { text: "Rip alert", tone: "caution" };
  if (rip.level === "high") return { text: "Rip high", tone: "caution" };
  if (rip.level === "moderate") return { text: "Rip moderate", tone: "caution" };
  if (rip.level === "low") return { text: "Rip low", tone: "calm" };
  return null;
}

function safetyLine(d: Derived): WatchLine | null {
  const flag = flagText(d.flags ?? []);
  const rip = ripText(d);
  const parts = [flag, rip].filter((p): p is { text: string; tone: WatchTone } => p != null);
  if (!parts.length) return null;
  const tone = parts.reduce<WatchTone>((t, p) => (TONE_RANK[p.tone] > TONE_RANK[t] ? p.tone : t), "calm");
  return { kind: "safety", text: parts.map((p) => p.text).join(" · "), tone };
}

/** "4–6 PM", or "11 AM–1 PM" when the halves of the day differ. In the beach's own time zone. */
export function windowText(startIso: string, endIso: string, timeZone: string): string | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  const parts = (ms: number) => {
    const p = fmt.formatToParts(new Date(ms));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return { hour: get("hour"), minute: get("minute"), half: get("dayPeriod").toUpperCase() };
  };
  const clock = (p: ReturnType<typeof parts>, withHalf: boolean) =>
    `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}${withHalf ? ` ${p.half}` : ""}`;
  const a = parts(start);
  const b = parts(end);
  return `${clock(a, a.half !== b.half)}–${clock(b, true)}`;
}

function bestLine(res: ConditionsResponse, nowMs: number): WatchLine | null {
  const today = res.multiDayWindows?.[0];
  const best = today?.best;
  if (!best) return null;
  const end = Date.parse(best.endIso);
  // Today's window is built from time still ahead; one that has ended is stale.
  if (!Number.isFinite(end) || end <= nowMs) return null;
  if (!goodWindow(best)) return { kind: "best", text: "No good window today", tone: "calm" };
  const text = windowText(best.startIso, best.endIso, res.snapshot.location.timezone);
  return text ? { kind: "best", text: `Best ${text}`, tone: "calm" } : null;
}

// ---- the view ---------------------------------------------------------------

export function buildWatchView(res: ConditionsResponse, nowMs: number = Date.now()): WatchView {
  const snap = res.snapshot;
  // Never earlier than the snapshot's own clock (same rule as the dashboard).
  const generatedMs = Date.parse(snap.generatedAt);
  const now = Number.isFinite(generatedMs) ? Math.max(nowMs, generatedMs) : nowMs;

  const d = deriveMetrics(snap, now);
  const scored = applyLiveRipCap(res.score, ripCapFor(d.ripNow), d.ripNow);
  const hasScore = scored.dataAvailable !== false && finite(scored.score);
  const score = hasScore ? Math.max(0, Math.min(100, Math.round(scored.score))) : null;
  const band = score == null ? null : scoreBand(score);

  const lines: WatchLine[] = [...hazardLines(res, d)];
  const safety = safetyLine(d);
  if (safety) lines.push(safety);
  const waterTempF = finite(d.waterTempF) && d.waterTempF > -10 && d.waterTempF < 150 ? Math.round(d.waterTempF) : null;
  if (waterTempF != null) lines.push({ kind: "water", text: `Water ${waterTempF}°F`, tone: "calm" });
  const best = bestLine(res, now);
  if (best) lines.push(best);

  return {
    v: 1,
    slug: snap.location.slug,
    name: snap.location.name,
    score,
    rating: band?.rating ?? null,
    band: band ? band.rating.toLowerCase() : null,
    limitedData: scored.dataCoverage === "limited",
    lines,
    waterTempF,
    generatedAt: snap.generatedAt ?? null,
    capturedAt: new Date(now).toISOString(),
  };
}
