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
//   A jump is EXPLAINED, and never alerts, only by a cause that (a) is allowed to explain THAT
//   signal and (b) pushed the number the way it moved. The signal-to-cause matrix
//   (CAUSE_MATRIX), with each cause's direction:
//
//     cause      explains            only when
//     rain       score, clarity,     rain_now went from 0 to 1 (rain STARTED; a sand jump must be a
//                sand               DROP)
//     lightning  score, clarity      lightning_near went from 0 to 1
//     caps       score               a cap was ADDED (digits ignored, so "~35% covered" is one cap)
//     wind       score, surf,        the wind moved 5 mph or more, either way
//                clarity
//     official   surf, score         the new wave reading is a buoy observation; for a score drop,
//                                    the factor that FELL most is the waves
//     cloud      sand, score         cloud cover moved 30 points or more; for sand the sand moved the
//                                    opposite way (more cloud, cooler); for a score drop, the factor
//                                    that FELL most is the sky and cloud cover ROSE
//
//   So a cap change cannot hide a clarity or sand anomaly, rain cannot hide a surf jump, and a
//   buoy cannot excuse a score drop that something else caused. A score drop's cause is its LARGEST
//   DECLINE: the factor whose share of the score fell most (an improving factor never leads a drop).
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

/** Which causes may explain which signal (see the header). */
export const CAUSE_MATRIX: Record<JumpSignal, readonly ExplainReason[]> = {
  score: ["rain", "lightning", "caps", "wind", "official-observation", "cloud"],
  clarity: ["rain", "lightning", "wind"],
  surf: ["wind", "official-observation"],
  sand: ["rain", "cloud"],
};

/** The row columns the watchdog reads. */
export type JumpRow = Pick<
  BeachHourlyRow,
  | "slug"
  | "hour_utc"
  | "local_date"
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
  /** The factor that FELL most (the largest decline); set for score jumps only. */
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
 * The factor whose share of the score FELL most between two hours (the largest decline), or
 * null when either hour has no factor breakdown or nothing fell. A factor with no data in one
 * hour counts as 0 points there. An improving factor is never returned: the cause of a score
 * drop must be something that went down. Pure.
 */
export function largestDecline(prevFactorsJson: string | null, curFactorsJson: string | null): FactorCause | null {
  const prev = contributions(parseFactors(prevFactorsJson));
  const cur = contributions(parseFactors(curFactorsJson));
  if (!prev.size || !cur.size) return null;
  let best: FactorCause | null = null;
  for (const key of new Set([...prev.keys(), ...cur.keys()])) {
    const delta = (cur.get(key)?.points ?? 0) - (prev.get(key)?.points ?? 0);
    if (delta < 0 && (best == null || delta < best.delta)) {
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

/** True when `next` has a cap `prev` did not. */
function capAdded(prev: Set<string>, next: Set<string>): boolean {
  for (const v of next) if (!prev.has(v)) return true;
  return false;
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

/**
 * Which causes explain a jump between these two rows: those the matrix allows for the signal,
 * whose own condition holds, in the direction the jump moved. `delta` is to - from; `cause` is
 * the largest decline (score jumps only). Pure.
 */
export function explainReasons(
  signal: JumpSignal,
  prev: JumpRow,
  cur: JumpRow,
  cause: FactorCause | null,
  delta: number,
): ExplainReason[] {
  const allowed = CAUSE_MATRIX[signal];
  const reasons: ExplainReason[] = [];
  const add = (r: ExplainReason, holds: boolean) => {
    if (holds && allowed.includes(r)) reasons.push(r);
  };
  // A score or clarity jump is always a drop. A sand jump may go either way: rain only explains a cooling.
  const cooled = delta < 0;
  add("rain", prev.rain_now === 0 && cur.rain_now === 1 && (signal !== "sand" || cooled));
  add("lightning", prev.lightning_near === 0 && cur.lightning_near === 1);
  add("caps", prev.caps_json != null && cur.caps_json != null && capAdded(capSet(prev.caps_json), capSet(cur.caps_json)));
  const windA = num(prev.wind_mph);
  const windB = num(cur.wind_mph);
  add("wind", windA != null && windB != null && Math.abs(windB - windA) >= EXPLAIN_THRESHOLDS.windMph);
  add("official-observation", cur.wave_source === "observed" && (signal === "surf" || cause?.key === "waves"));
  const cloudA = num(prev.cloud_pct);
  const cloudB = num(cur.cloud_pct);
  if (cloudA != null && cloudB != null && Math.abs(cloudB - cloudA) >= EXPLAIN_THRESHOLDS.cloudPct) {
    const cloudDelta = cloudB - cloudA;
    if (signal === "sand") add("cloud", cloudDelta * delta < 0);
    else add("cloud", cause?.key === "sky" && cloudDelta > 0);
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
    found.push({ signal: "score", from: s0, to: s1, cause: largestDecline(prev.factors_json, cur.factors_json) });
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
    const delta = round1(f.to - f.from);
    const reasons = explainReasons(f.signal, prev, cur, f.cause, delta);
    return {
      signal: f.signal,
      from: f.from,
      to: f.to,
      delta,
      explained: reasons.length > 0,
      reasons,
      cause: f.cause,
    };
  });
}
