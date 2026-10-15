// Strict parsing for query strings (REST) and tool arguments (MCP). Never guesses:
// "" is not 0, "1e3" is not 1000, and out-of-range numbers are refused.

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export function parseNumber(raw: string, name: string, min: number, max: number): Parsed<number> {
  const t = raw.trim();
  if (t.length === 0 || t.length > 24 || !DECIMAL.test(t)) return fail(`${name} must be a number.`);
  const n = Number(t);
  if (!Number.isFinite(n) || n < min || n > max) return fail(`${name} must be between ${min} and ${max}.`);
  return { ok: true, value: n };
}

export function parseInteger(raw: string, name: string, min: number, max: number): Parsed<number> {
  const t = raw.trim();
  if (!/^\d{1,6}$/.test(t)) return fail(`${name} must be a whole number from ${min} to ${max}.`);
  const n = Number(t);
  if (n < min || n > max) return fail(`${name} must be a whole number from ${min} to ${max}.`);
  return { ok: true, value: n };
}

export function parseBool(raw: string, name: string): Parsed<boolean> {
  const t = raw.trim().toLowerCase();
  if (t === "true" || t === "1") return { ok: true, value: true };
  if (t === "false" || t === "0") return { ok: true, value: false };
  return fail(`${name} must be true or false.`);
}

export const LAT_RANGE: [number, number] = [-90, 90];
export const LON_RANGE: [number, number] = [-180, 180];

/** The names a route accepts. Used to refuse unknown keys, and by the OpenAPI parity test. */
export const BEACH_LIST_QUERY_KEYS = ["state", "region"] as const;
export const NEAREST_QUERY_KEYS = ["lat", "lon", "limit", "scores"] as const;

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
