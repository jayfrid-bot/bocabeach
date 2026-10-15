// Strict parsing for query strings (REST) and tool arguments (MCP). Never guesses:
// "" is not 0, "1e3" is not 1000, and out-of-range numbers are refused.

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

// Strict and canonical: one spelling per value, so the same question is always asked the
// same way (no whitespace, no plus sign, no exponent, no leading zeros, no "5.", no ".5",
// no negative zero). Anything else is a 400, never a quiet guess.
export const DECIMAL_PATTERN = "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$";
const DECIMAL = new RegExp(DECIMAL_PATTERN);
// The same rules as parseNumber(raw, "lat" | "lon", ...), written as one pattern each so the
// OpenAPI document can state them exactly: canonical decimal, at most 24 characters, no -0,
// and inside the range (-90..90, -180..180). A test checks pattern and parser agree.
const NO_NEGATIVE_ZERO = "(?!-0(\\.0+)?$)";
export const LAT_PATTERN = `^(?=.{1,24}$)${NO_NEGATIVE_ZERO}-?(90(\\.0+)?|[1-8]?[0-9](\\.[0-9]+)?)$`;
export const LON_PATTERN = `^(?=.{1,24}$)${NO_NEGATIVE_ZERO}-?(180(\\.0+)?|1[0-7][0-9](\\.[0-9]+)?|[1-9]?[0-9](\\.[0-9]+)?)$`;
const LAT_RE = new RegExp(LAT_PATTERN);
const LON_RE = new RegExp(LON_PATTERN);
const INTEGER = /^(0|[1-9]\d{0,5})$/;
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export function parseNumber(raw: string, name: string, min: number, max: number): Parsed<number> {
  if (raw.length === 0 || raw.length > 24 || !DECIMAL.test(raw)) {
    return fail(`${name} must be a plain decimal number such as 26.35 (no spaces, plus sign, exponent or leading zeros).`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fail(`${name} must be between ${min} and ${max}.`);
  if (n === 0 && raw.startsWith("-")) return fail(`${name} must be written as 0, not -0.`);
  return { ok: true, value: n };
}

/** Latitude, judged by the very pattern the OpenAPI document publishes (no rounding at the edges). */
export function parseLat(raw: string): Parsed<number> {
  if (!LAT_RE.test(raw)) {
    return fail("lat must be a plain decimal from -90 to 90, such as 26.35 (no spaces, plus sign, exponent, leading zeros or -0).");
  }
  return { ok: true, value: Number(raw) };
}

/** Longitude, judged by the very pattern the OpenAPI document publishes. */
export function parseLon(raw: string): Parsed<number> {
  if (!LON_RE.test(raw)) {
    return fail("lon must be a plain decimal from -180 to 180, such as -80.07 (no spaces, plus sign, exponent, leading zeros or -0).");
  }
  return { ok: true, value: Number(raw) };
}

export function parseInteger(raw: string, name: string, min: number, max: number): Parsed<number> {
  if (!INTEGER.test(raw)) return fail(`${name} must be a whole number from ${min} to ${max}, with no leading zeros.`);
  const n = Number(raw);
  if (n < min || n > max) return fail(`${name} must be a whole number from ${min} to ${max}.`);
  return { ok: true, value: n };
}

/** Exactly "true" or "false". */
export function parseBool(raw: string, name: string): Parsed<boolean> {
  if (raw === "true") return { ok: true, value: true };
  if (raw === "false") return { ok: true, value: false };
  return fail(`${name} must be exactly true or false.`);
}

/** Free text filters: not empty, no space at either end, no control characters, never cut short. */
export const TEXT_PARAM_PATTERN = "^\\S(.*\\S)?$";
export function parseText(raw: string, name: string, maxLen: number): Parsed<string> {
  if (raw.length === 0) return fail(`${name} must not be empty. Leave it out instead.`);
  if (raw.length > maxLen) return fail(`${name} is too long (at most ${maxLen} characters).`);
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw !== raw.trim()) {
    return fail(`${name} must not have spaces at either end or control characters.`);
  }
  return { ok: true, value: raw };
}

export const LAT_RANGE: [number, number] = [-90, 90];
export const LON_RANGE: [number, number] = [-180, 180];

/** The names a route accepts. Used to refuse unknown keys, and by the OpenAPI parity test. */
export const MAX_STATE_LEN = 40;
export const MAX_REGION_LEN = 80;
export const BEACH_LIST_QUERY_KEYS = ["state", "region"] as const;
export const NEAREST_QUERY_KEYS = ["lat", "lon", "limit", "scores"] as const;
export const OUTLOOK_QUERY_KEYS = ["days"] as const;

/** An unknown or repeated query key is an error, so junk cannot mint cache entries. */
export function checkQueryKeys(sp: URLSearchParams, allowed: readonly string[]): Parsed<true> {
  const seen = new Set<string>();
  for (const key of sp.keys()) {
    if (!allowed.includes(key)) {
      return fail(`Unknown query parameter "${key.slice(0, 40)}". Allowed: ${allowed.join(", ") || "none"}.`);
    }
    if (seen.has(key)) return fail(`Query parameter "${key}" was given more than once.`);
    seen.add(key);
  }
  return { ok: true, value: true };
}
