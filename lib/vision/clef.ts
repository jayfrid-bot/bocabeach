// Cloudflare Clef 27B (`@cf/cloudflare/clef`) as a FALLBACK cam reader.
//
// Pure helpers for POST /api/vision/clef: the request Clef gets and the way its
// answers become a reading. Nothing here touches a binding or the network.
//
// EVIDENCE RULE. The request and the answer mapping below are copied from
// scripts/clef_vision_backtest.mjs (`beachQuestions`, `uwQuestions`, `bodyFor`,
// `scoreValue`, `deriveClef`) so that docs/benchmarks/clef-vision-2026-10-12/
// stays the evidence for production behavior. lib/vision/clef.test.ts replays
// every cached backtest answer through `deriveClef` and compares it with the
// backtest's own function, and deep-compares the questions. Change a question,
// a band or the mapping here and that test fails until the backtest is re-run.
//
// Clef takes a list of questions (choice / score / noul), not one free-form
// prompt, and returns probabilities. It cannot return an integer or a percent,
// so people and the percent scores come from `score` questions over the
// production prompt's own anchor bands, interpolated by probability.

export const CLEF_MODEL = "@cf/cloudflare/clef";

/** Largest JSON body the route accepts. A 768 px q60 frame is ~50-120 KB, ~160 KB as base64. */
export const MAX_CLEF_BODY_BYTES = 400 * 1024;

export type ClefKind = "surface" | "underwater";

// -- Words (same lists as scripts/cam_seaweed.py) -------------------------------
export const SEAWEED = ["none", "low", "moderate", "high"] as const;
export const CROWD = ["empty", "quiet", "moderate", "busy", "packed"] as const;
export const WATER = ["clear", "slightly_murky", "murky", "churned"] as const;
export const UW_CLARITY = ["clear", "slightly_hazy", "hazy", "murky"] as const;

/** A frame is "unreadable" (too dark, blurred or blocked) at this probability, as in the backtest. */
export const UNREADABLE_P = 0.5;

// anchor bands -> a representative number for each band
const BANDS = {
  seaweed_pct: { v: [0, 5, 30, 60, 95], c: ["0 = clean", "5 = thin wrack line", "30 = clear bands", "60 = heavy mats", "90+ = nearly all covered"] },
  crowd_pct: { v: [0, 25, 50, 75, 100], c: ["0 = empty", "25 = quiet, a few people", "50 = moderate, steady", "75 = busy, crowded", "100 = packed holiday peak"] },
  people: { v: [0, 2, 7, 18, 43, 105, 200], c: ["0 people", "1 to 3 people", "4 to 10 people", "11 to 25 people", "26 to 60 people", "61 to 150 people", "more than 150 people"] },
  water_pct: {
    v: [10, 30, 50, 67, 82, 95],
    c: [
      "<20 = opaque",
      "20-39 = poor, brown or heavily suspended",
      "40-59 = noticeably murky/sandy",
      "60-74 = decent but visibly tinted green, a typical fair day",
      "75-89 = very clear blue-green",
      "90-100 = exceptional glass-clear tropical water (rare here)",
    ],
  },
  uw_pct: { v: [10, 30, 50, 70, 90], c: ["0-20 = opaque", "20-40 = murky", "40-60 = hazy", "60-80 = slightly hazy", "80-100 = gin-clear"] },
} as const;

type Question = Record<string, unknown>;

export function beachQuestions(): Record<string, Question> {
  return {
    seaweed: {
      type: "choice",
      instructions:
        "Seaweed = brown/golden sargassum on the sand and in shallow water. Which level is visible? none=clean sand, low=thin wrack line or scattered patches, moderate=clear bands, high=heavy mats over much of the shore.",
      criteria: {
        none: "Clean sand.",
        low: "Thin wrack line or scattered patches.",
        moderate: "Clear bands.",
        high: "Heavy mats over much of the shore.",
      },
    },
    seaweed_pct: {
      type: "score",
      instructions:
        "seaweed_pct = percent of the visible sand/shoreline covered by sargassum (0=clean, 5=thin wrack line, 30=clear bands, 60=heavy mats, 90+=nearly all covered).",
      criteria: BANDS.seaweed_pct.c,
    },
    crowd: {
      type: "choice",
      instructions:
        "Crowd = how busy the beach looks from people on the sand and in the water (and cars in any visible parking lot): empty=nobody, quiet=a few people, moderate=steady, busy=crowded, packed=very crowded.",
      criteria: {
        empty: "Nobody.",
        quiet: "A few people.",
        moderate: "Steady.",
        busy: "Crowded.",
        packed: "Very crowded.",
      },
    },
    crowd_pct: {
      type: "score",
      instructions: "crowd_pct = how full the beach looks, 0=empty to 100=packed holiday peak.",
      criteria: BANDS.crowd_pct.c,
    },
    people: {
      type: "score",
      instructions: "people = approx visible people (count everyone on the sand and in the water).",
      criteria: BANDS.people.c,
    },
    water: {
      type: "choice",
      instructions:
        "Water = how clear the OCEAN WATER itself looks where it is visible (judge color and transparency of the water beyond the breaking surf, not whitewater foam). IMPORTANT: floating seaweed patches and brown seaweed mats are NOT murkiness - seaweed is graded separately; judge the water transparency in areas FREE of seaweed, and don't let sun glare or surface brightness read as murk. Use unknown if open water is not clearly visible in this frame.",
      criteria: {
        clear: "Blue-green and transparent.",
        slightly_murky: "Greenish with some suspended sand.",
        murky: "Brown/tea-colored water itself.",
        churned: "Heavily stirred-up sand throughout.",
        unknown: "Open water is not clearly visible in this frame.",
      },
    },
    water_pct: {
      type: "score",
      instructions:
        "water_pct = water clarity 0-100. Use the FULL scale and discriminate. Most days fall 55-80 - reserve 85+ for genuinely exceptional transparency.",
      criteria: BANDS.water_pct.c,
    },
    // Extra (not in the production prompt): the "unreadable" check.
    unreadable: {
      type: "noul",
      instructions: "Is this frame too dark, blurred, or blocked to read anything reliably (night, lens covered, no view of the beach or water)?",
    },
  };
}

export function uwQuestions(): Record<string, Question> {
  return {
    uw_clarity: {
      type: "choice",
      instructions:
        "Judge how far you can SEE through the water: clear=fish/structures/pilings crisp at distance, slightly_hazy=objects visible but soft, hazy=only near objects visible, murky=heavy particulates, little visibility.",
      criteria: {
        clear: "Fish/structures/pilings crisp at distance.",
        slightly_hazy: "Objects visible but soft.",
        hazy: "Only near objects visible.",
        murky: "Heavy particulates, little visibility.",
      },
    },
    uw_pct: {
      type: "score",
      instructions: "uw_pct = underwater visibility 0-100 where 100=gin-clear and 0=opaque.",
      criteria: BANDS.uw_pct.c,
    },
    unreadable: {
      type: "noul",
      instructions: "If the frame is too dark to judge (night/no light), answer yes. Is this frame too dark to judge?",
    },
  };
}

const beachState = () => ({
  task: "This is a live beach webcam photo. Read it with the rubric in the questions.",
  photos: "One photo: this frame.",
});
const uwState = () => ({
  task: "This is a frame from an UNDERWATER ocean webcam (a camera submerged off a fishing pier, looking through the water).",
  photos: "One photo: this frame.",
});

export interface ClefRequest {
  state: { task: string; photos: string };
  images: string[];
  questions: Record<string, Question>;
}

/** The exact request the backtest sent (`bodyFor`), minus the REST-only `model` field. */
export function buildClefRequest(kind: ClefKind, imageBase64: string): ClefRequest {
  const uw = kind === "underwater";
  return {
    state: uw ? uwState() : beachState(),
    images: ["data:image/jpeg;base64," + imageBase64],
    questions: uw ? uwQuestions() : beachQuestions(),
  };
}

// -- Reading the answers (verbatim port of the backtest) -----------------------

type Ans = Record<string, unknown> | null | undefined;

// probability-weighted position on a score question, then interpolated onto
// the band values (so a 50/50 split between two bands lands between them)
function scoreValue(a: unknown, values: readonly number[]): number | null {
  if (!a || typeof a !== "object") return null;
  const o = a as { probabilities?: unknown; score?: unknown };
  const probs = o.probabilities;
  let e: number | null = null;
  if (probs && typeof probs === "object") {
    let sum = 0;
    let w = 0;
    for (const k of Object.keys(probs)) {
      const lv = Number(k);
      const p = Number((probs as Record<string, unknown>)[k]);
      if (!Number.isFinite(lv) || !Number.isFinite(p) || p < 0) continue;
      sum += p;
      w += lv * p;
    }
    if (sum > 0) e = w / sum;
  }
  if (e == null && typeof o.score === "number") e = o.score;
  if (e == null) return null;
  const idx = Math.max(0, Math.min(values.length - 1, e));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return values[lo] + (values[hi] - values[lo]) * (idx - lo);
}

function choiceOf<T extends string>(a: unknown, allowed: readonly T[]): T | null {
  const c = a && typeof a === "object" ? (a as { choice?: unknown }).choice : null;
  return typeof c === "string" && (allowed as readonly string[]).includes(c) ? (c as T) : null;
}

function noul(a: unknown): number | null {
  const n = a && typeof a === "object" ? (a as { noul?: unknown }).noul : null;
  return typeof n === "number" ? n : null;
}

export interface DerivedBeach {
  seaweed: (typeof SEAWEED)[number] | null;
  covPct: number | null;
  crowd: (typeof CROWD)[number] | null;
  crowdPct: number | null;
  people: number | null;
  water: (typeof WATER)[number] | null;
  waterUnknown: boolean;
  waterPct: number | null;
  unreadableP: number | null;
  ok: boolean;
}
export interface DerivedUw {
  uwLevel: (typeof UW_CLARITY)[number] | null;
  uwPct: number | null;
  unreadableP: number | null;
  ok: boolean;
}

/** Clef answers -> the same fields the backtest scored. null = missing or bad; `ok` = nothing missing. */
export function deriveClef(ans: Ans, uw: true): DerivedUw | null;
export function deriveClef(ans: Ans, uw: false): DerivedBeach | null;
export function deriveClef(ans: Ans, uw: boolean): DerivedBeach | DerivedUw | null;
export function deriveClef(ans: Ans, uw: boolean): DerivedBeach | DerivedUw | null {
  if (!ans) return null;
  if (uw) {
    const lvl = choiceOf(ans.uw_clarity, UW_CLARITY);
    const pct = scoreValue(ans.uw_pct, BANDS.uw_pct.v);
    const un = noul(ans.unreadable);
    return { uwLevel: lvl, uwPct: pct == null ? null : Math.round(pct), unreadableP: un, ok: lvl != null && pct != null && un != null };
  }
  const seaweed = choiceOf(ans.seaweed, SEAWEED);
  const crowd = choiceOf(ans.crowd, CROWD);
  const water = choiceOf(ans.water, [...WATER, "unknown"] as const);
  const cov = scoreValue(ans.seaweed_pct, BANDS.seaweed_pct.v);
  const cp = scoreValue(ans.crowd_pct, BANDS.crowd_pct.v);
  const ppl = scoreValue(ans.people, BANDS.people.v);
  const wp = scoreValue(ans.water_pct, BANDS.water_pct.v);
  const un = noul(ans.unreadable);
  const r: DerivedBeach = {
    seaweed,
    covPct: cov == null ? null : Math.round(cov),
    crowd,
    crowdPct: cp == null ? null : Math.round(cp),
    people: ppl == null ? null : Math.round(ppl),
    water: water === "unknown" ? null : (water as DerivedBeach["water"]),
    waterUnknown: water === "unknown",
    waterPct: wp == null ? null : Math.round(wp),
    unreadableP: un,
    ok: false,
  };
  r.ok = seaweed != null && crowd != null && water != null && cov != null && cp != null && ppl != null && wp != null && un != null;
  return r;
}

// -- The reading the route returns (the shape assess() returns elsewhere) -------

export interface SurfaceReading {
  level: (typeof SEAWEED)[number];
  coveragePct: number;
  note: string;
  crowd: (typeof CROWD)[number];
  crowdPct: number;
  people: number;
  crowdNote: string;
  water: (typeof WATER)[number] | null;
  waterPct: number;
  waterNote: string;
}
export interface UnderwaterReading {
  level: (typeof UW_CLARITY)[number];
  pct: number;
  note: string;
}

/** Surface reading from derived answers, or null when any field is missing. Mirrors _parse_out in cam_seaweed.py. */
export function surfaceReading(d: DerivedBeach | null): SurfaceReading | null {
  if (!d || !d.ok || d.seaweed == null || d.crowd == null || d.covPct == null || d.crowdPct == null || d.people == null || d.waterPct == null) {
    return null;
  }
  return {
    level: d.seaweed,
    coveragePct: clampPct(d.covPct),
    note: "",
    crowd: d.crowd,
    crowdPct: clampPct(d.crowdPct),
    people: d.people,
    crowdNote: "",
    water: d.water, // "unknown" already became null
    waterPct: clampPct(d.waterPct),
    waterNote: "",
  };
}

/** Underwater reading from derived answers, or null when any field is missing. Mirrors _parse_uw. */
export function underwaterReading(d: DerivedUw | null): UnderwaterReading | null {
  if (!d || !d.ok || d.uwLevel == null || d.uwPct == null) return null;
  return { level: d.uwLevel, pct: clampPct(d.uwPct), note: "" };
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** True when Clef says the frame is too dark, blurred or blocked to read. */
export function isUnreadable(p: number | null): boolean {
  return p != null && p >= UNREADABLE_P;
}

// -- Workers AI binding ------------------------------------------------------------

/** The slice of the Workers AI binding we use (avoids a @cloudflare/workers-types dep). */
export interface AiBindingLike {
  run(model: string, input: unknown): Promise<unknown>;
}

/** The Worker env fields this feature reads. */
export interface ClefEnv {
  AI?: AiBindingLike;
  /** Bearer token for POST /api/vision/clef (shared with the capture script; same as the cam archive). */
  INGEST_TOKEN?: string;
}

/**
 * Pull `{answers, inputTokens}` out of what `env.AI.run` returned. The REST API
 * wrapped it as `{success, result: {answers, usage}}`; the binding returns the
 * inner object. Both are accepted. `success: false` yields no answers.
 */
export function unwrapClefResult(raw: unknown): { answers: Record<string, unknown> | null; inputTokens: number | null } {
  const top = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (top.success === false) return { answers: null, inputTokens: null };
  const inner = top.answers === undefined && top.result && typeof top.result === "object" ? (top.result as Record<string, unknown>) : top;
  const answers = inner.answers && typeof inner.answers === "object" ? (inner.answers as Record<string, unknown>) : null;
  const usage = inner.usage && typeof inner.usage === "object" ? (inner.usage as Record<string, unknown>) : null;
  const t = usage?.input_tokens;
  return { answers, inputTokens: typeof t === "number" && Number.isFinite(t) ? t : null };
}

// -- Strict validation (runs BEFORE the mapping) ---------------------------------
//
// deriveClef (a verbatim port, so the backtest stays the evidence) is lenient:
// it skips probability keys it cannot read and clamps indices. That is fine for
// a recorded run and wrong for production, where a malformed reply must become a
// 502, never a plausible-looking number. This check rejects what the backtest's
// 229 real replies never contain.

/** Largest sum of a question's probabilities we accept (real replies sum to ~1). */
const MAX_PROB_SUM = 1.05;

const isProb = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function checkProbabilities(probs: unknown, allowedKeys: readonly string[]): string | null {
  if (!probs || typeof probs !== "object" || Array.isArray(probs)) return "probabilities not an object";
  let sum = 0;
  let count = 0;
  for (const [k, v] of Object.entries(probs as Record<string, unknown>)) {
    if (!allowedKeys.includes(k)) return `probability key ${JSON.stringify(k).slice(0, 20)} outside the question's options`;
    if (!isProb(v)) return `probability for ${k} not a number in [0,1]`;
    sum += v;
    count += 1;
  }
  if (count === 0 || sum <= 0) return "probabilities empty or all zero";
  if (sum > MAX_PROB_SUM) return "probabilities sum above 1";
  return null;
}

function checkQuestion(name: string, q: Question, a: unknown): string | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return `${name}: missing`;
  const o = a as Record<string, unknown>;
  if (q.type === "noul") {
    return isProb(o.noul) ? null : `${name}: noul not a number in [0,1]`;
  }
  if (q.type === "choice") {
    const options = Object.keys(q.criteria as Record<string, unknown>);
    if (typeof o.choice !== "string" || !options.includes(o.choice)) return `${name}: choice outside the options`;
    if (o.probabilities !== undefined) {
      const bad = checkProbabilities(o.probabilities, options);
      if (bad) return `${name}: ${bad}`;
    }
    return null;
  }
  // score: indices 0 .. bands-1
  const bands = (q.criteria as readonly string[]).length;
  const indices = Array.from({ length: bands }, (_, i) => String(i));
  if (o.probabilities !== undefined) {
    const bad = checkProbabilities(o.probabilities, indices);
    if (bad) return `${name}: ${bad}`;
  } else if (typeof o.score !== "number") {
    return `${name}: no probabilities and no score`;
  }
  if (o.score !== undefined && !(typeof o.score === "number" && Number.isFinite(o.score) && o.score >= 0 && o.score <= bands - 1)) {
    return `${name}: score outside 0..${bands - 1}`;
  }
  return null;
}

/** Why a reply must not be mapped, or null when every answer is well formed. */
export function validateClefAnswers(answers: Record<string, unknown> | null, kind: ClefKind): string | null {
  if (!answers) return "no answers";
  const questions = kind === "underwater" ? uwQuestions() : beachQuestions();
  for (const [name, q] of Object.entries(questions)) {
    const bad = checkQuestion(name, q, answers[name]);
    if (bad) return bad;
  }
  return null;
}
