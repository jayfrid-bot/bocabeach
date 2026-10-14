// The hourly watchdog's brain (docs/QUALITY_PLAN.md, "Catch"). Pure: it takes
// two consecutive `beach_hourly` rows of one beach and says which readings
// jumped, and for each one whether something real explains it.
//
//   Jump thresholds (one hour to the next):
//     score   dropped by 15 or more
//     surf    changed by 2 ft or more   (estimated surf; raw wave_ft when a row has no surf_ft)
//     sand    changed by 10 F or more
//     clarity dropped by 15 or more points
//
//   A jump is EXPLAINED, and never alerts, when any of these holds:
//     rain       rain_now changed between the two hours
//     lightning  lightning_near changed
//     caps       the set of active score caps changed (flags, advisories, rain
//                and wind caps; digits are ignored so "~35% covered" is one cap)
//     wind       the wind moved by 5 mph or more
//     official   the biggest score contributor is the wave reading and it comes
//                from an official observation (the buoy); for a surf jump, the
//                new wave reading is itself a buoy reading
//     cloud      the sky moved by 30 points or more of cloud cover, and the jump
//                is a sand change or a score change led by the sky factor
//
// Only an unexplained jump alerts. Thresholds and rules live here, in one place.

import type { BeachHourlyRow } from "@/lib/history/types";

export const JUMP_THRESHOLDS = {
  scoreDrop: 15,
  surfFt: 2,
  sandF: 10,
  clarityDrop: 15,
} as const;

export const EXPLAIN_THRESHOLDS = {
  windMph: 5,
  cloudPct: 30,
} as const;

/** The most hours apart two rows may be and still be compared. */
export const MAX_GAP_HOURS = 2;

export type JumpSignal = "score" | "surf" | "sand" | "clarity";
export type ExplainReason = "rain" | "lightning" | "caps" | "wind" | "official-observation" | "cloud";

/** The row columns the watchdog reads. */
export type JumpRow = Pick<
  BeachHourlyRow,
  | "slug"
  | "hour_utc"
  | "score"
  | "wave_ft"
  | "surf_ft"
  | "wave_source"
  | "sand_temp_f"
  | "clarity_pct"
  | "rain_now"
  | "lightning_near"
  | "wind_mph"
  | "cloud_pct"
  | "caps_json"
  | "factors_json"
>;

export interface FactorCause {
  key: string;
  label: string;
  /** Change in this factor's share of the score, in score points. */
  delta: number;
}

export interface Detection {
  signal: JumpSignal;
  from: number;
  to: number;
  /** to - from, rounded to one decimal. */
  delta: number;
  explained: boolean;
  reasons: ExplainReason[];
  /** The factor that moved the score most; set for score jumps only. */
  cause: FactorCause | null;
}

const HOUR_MS = 3_600_000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

interface Factor {
  key: string;
  label: string;
  score: number | null;
  weight: number;
}

function parseFactors(json: string | null): Factor[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: Factor[] = [];
    for (const f of raw) {
      if (!f || typeof f !== "object") continue;
      const o = f as Record<string, unknown>;
      if (typeof o.key !== "string") continue;
      const weight = num(o.weight);
      if (weight == null) continue;
      out.push({ key: o.key, label: typeof o.label === "string" ? o.label : o.key, score: num(o.score), weight });
    }
    return out;
  } catch {
    return [];
  }
}

/** Each factor's share of the 0-100 score: score x weight / the weights that had data. */
function contributions(factors: Factor[]): Map<string, { label: string; points: number }> {
  const present = factors.filter((f) => f.score != null);
  const total = present.reduce((a, f) => a + f.weight, 0);
  const out = new Map<string, { label: string; points: number }>();
  if (total <= 0) return out;
  for (const f of present) out.set(f.key, { label: f.label, points: ((f.score as number) * f.weight) / total });
  return out;
}

/**
 * The factor whose share of the score changed most between two hours (by
 * absolute size), or null when either hour has no factor breakdown. A factor
 * that had no data in one hour counts as 0 points there. Pure.
 */
export function biggestContributor(prevFactorsJson: string | null, curFactorsJson: string | null): FactorCause | null {
  const prev = contributions(parseFactors(prevFactorsJson));
  const cur = contributions(parseFactors(curFactorsJson));
  if (!prev.size || !cur.size) return null;
  let best: FactorCause | null = null;
  for (const key of new Set([...prev.keys(), ...cur.keys()])) {
    const delta = (cur.get(key)?.points ?? 0) - (prev.get(key)?.points ?? 0);
    if (best == null || Math.abs(delta) > Math.abs(best.delta)) {
      best = { key, label: (cur.get(key) ?? prev.get(key))?.label ?? key, delta: round1(delta) };
    }
  }
  return best;
}

/** Cap strings without digits, so "~35% of the beach covered" and "~40% ..." are one cap. */
function capSet(json: string | null): Set<string> {
  const out = new Set<string>();
  if (!json) return out;
  try {
    const raw = JSON.parse(json) as unknown;
    if (Array.isArray(raw)) {
      for (const c of raw) if (typeof c === "string") out.add(c.replace(/\d+/g, "#").trim().toLowerCase());
    }
  } catch {
    /* an unreadable list counts as no caps */
  }
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** True when the two rows are one beach, in order, at most MAX_GAP_HOURS apart. */
export function comparable(prev: Pick<JumpRow, "slug" | "hour_utc">, cur: Pick<JumpRow, "slug" | "hour_utc">): boolean {
  if (prev.slug !== cur.slug) return false;
  const a = Date.parse(prev.hour_utc);
  const b = Date.parse(cur.hour_utc);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const gap = b - a;
  return gap > 0 && gap <= MAX_GAP_HOURS * HOUR_MS;
}

/** Which of the explain rules apply to a jump between these two rows. Pure. */
export function explainReasons(
  signal: JumpSignal,
  prev: JumpRow,
  cur: JumpRow,
  cause: FactorCause | null,
): ExplainReason[] {
  const reasons: ExplainReason[] = [];
  if (prev.rain_now != null && cur.rain_now != null && prev.rain_now !== cur.rain_now) reasons.push("rain");
  if (prev.lightning_near != null && cur.lightning_near != null && prev.lightning_near !== cur.lightning_near) {
    reasons.push("lightning");
  }
  if (prev.caps_json != null && cur.caps_json != null && !sameSet(capSet(prev.caps_json), capSet(cur.caps_json))) {
    reasons.push("caps");
  }
  const windA = num(prev.wind_mph);
  const windB = num(cur.wind_mph);
  if (windA != null && windB != null && Math.abs(windB - windA) >= EXPLAIN_THRESHOLDS.windMph) reasons.push("wind");
  if (cur.wave_source === "observed") {
    if (signal === "surf" || (signal === "score" && cause?.key === "waves")) reasons.push("official-observation");
  }
  const cloudA = num(prev.cloud_pct);
  const cloudB = num(cur.cloud_pct);
  if (
    cloudA != null &&
    cloudB != null &&
    Math.abs(cloudB - cloudA) >= EXPLAIN_THRESHOLDS.cloudPct &&
    (signal === "sand" || (signal === "score" && cause?.key === "sky"))
  ) {
    reasons.push("cloud");
  }
  return reasons;
}

/** The surf reading to compare: the estimated surf when both rows have it, else raw wave height. */
function surfPair(prev: JumpRow, cur: JumpRow): [number, number] | null {
  const a = num(prev.surf_ft);
  const b = num(cur.surf_ft);
  if (a != null && b != null) return [a, b];
  const c = num(prev.wave_ft);
  const d = num(cur.wave_ft);
  return c != null && d != null ? [c, d] : null;
}

/**
 * Every jump between two consecutive rows of one beach, each marked explained
 * or not. Empty when the rows are not comparable (other beach, wrong order, or
 * more than MAX_GAP_HOURS apart) or nothing crossed a threshold. Pure.
 */
export function detectJumps(prev: JumpRow, cur: JumpRow): Detection[] {
  if (!comparable(prev, cur)) return [];
  const found: Array<Pick<Detection, "signal" | "from" | "to"> & { cause: FactorCause | null }> = [];

  const s0 = num(prev.score);
  const s1 = num(cur.score);
  if (s0 != null && s1 != null && s0 - s1 >= JUMP_THRESHOLDS.scoreDrop) {
    found.push({ signal: "score", from: s0, to: s1, cause: biggestContributor(prev.factors_json, cur.factors_json) });
  }
  const surf = surfPair(prev, cur);
  if (surf && Math.abs(surf[1] - surf[0]) >= JUMP_THRESHOLDS.surfFt) {
    found.push({ signal: "surf", from: surf[0], to: surf[1], cause: null });
  }
  const t0 = num(prev.sand_temp_f);
  const t1 = num(cur.sand_temp_f);
  if (t0 != null && t1 != null && Math.abs(t1 - t0) >= JUMP_THRESHOLDS.sandF) {
    found.push({ signal: "sand", from: t0, to: t1, cause: null });
  }
  const c0 = num(prev.clarity_pct);
  const c1 = num(cur.clarity_pct);
  if (c0 != null && c1 != null && c0 - c1 >= JUMP_THRESHOLDS.clarityDrop) {
    found.push({ signal: "clarity", from: c0, to: c1, cause: null });
  }

  return found.map((f) => {
    const reasons = explainReasons(f.signal, prev, cur, f.cause);
    return {
      signal: f.signal,
      from: f.from,
      to: f.to,
      delta: round1(f.to - f.from),
      explained: reasons.length > 0,
      reasons,
      cause: f.cause,
    };
  });
}
