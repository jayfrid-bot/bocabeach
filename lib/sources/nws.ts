import type { Location, NwsAlert, NwsData, RipRisk, SrfPeriod, Wrapped } from "@/lib/types";
import { fetchWithTimeout, fetchedAtOf, nowIso, oldestIso } from "@/lib/util";

const ATTRIBUTION = "NOAA/NWS (api.weather.gov)";

// --- pure parsers ----------------------------------------------------------
interface AlertsJson {
  features?: {
    properties?: {
      id?: string;
      event?: string;
      severity?: string;
      /** CAP status: "Actual" | "Test" | "Exercise" | "Draft" | "System". */
      status?: string;
      /** CAP messageType: "Alert" | "Update" | "Cancel" | "Ack" | "Error". */
      messageType?: string;
      headline?: string;
      description?: string;
      sent?: string | null;
      effective?: string | null;
      onset?: string | null;
      ends?: string | null;
      expires?: string | null;
      /** api.weather.gov gives this as an array of full alert URLs (not the
       *  raw CAP "sender,identifier,sent" triples) — parseAlerts joins them
       *  space-separated so the identifiers are still substring-extractable. */
      references?: { "@id"?: string }[] | string | null;
    };
  }[];
}

// NWS issues routine TEST/exercise products (e.g. the monthly National Tsunami
// Warning Center test) that carry a real event name + "Extreme" severity but a
// status other than "Actual" (the headline starts "TEST"). They must never reach
// the score, safety banner, or push, so drop anything non-"Actual" at the source.
const NON_ACTUAL = new Set(["Test", "Exercise", "Draft", "System"]);

/**
 * Map the NWS active-alerts GeoJSON to a compact alert list (real alerts only).
 *
 * Keeps onset/effective/ends/expires as raw ISO strings — NEVER computed as a
 * boolean here. Every consumer resolves "is this actually in effect" against a
 * passed `now` via lib/ripRisk's shared resolve function; this parser only
 * carries the timestamps through. A "Cancel"/"Update" messageType still carries
 * the same `id` as the alert it replaces — api.weather.gov's /alerts/active
 * already reflects current cancellation status (cancelled alerts drop out of
 * the feed), so per-fetch parsing is sufficient; `id`/`status`/`messageType`
 * are preserved anyway so a caller that DOES merge across polls can dedupe/
 * replace by id.
 */
export function parseAlerts(json: AlertsJson): NwsAlert[] {
  return (json.features ?? [])
    .map((f) => f.properties ?? {})
    .filter((p) => p.event && !NON_ACTUAL.has(p.status ?? "Actual"))
    .map((p) => ({
      id: p.id ?? undefined,
      event: p.event as string,
      severity: p.severity ?? "Unknown",
      headline: p.headline ?? undefined,
      description: p.description ?? undefined,
      status: p.status ?? undefined,
      messageType: p.messageType ?? undefined,
      references: Array.isArray(p.references)
        ? p.references.map((r) => r?.["@id"]).filter(Boolean).join(" ") || undefined
        : (p.references ?? undefined),
      sent: p.sent ?? undefined,
      effective: p.effective ?? undefined,
      onset: p.onset ?? undefined,
      ends: p.ends ?? p.expires ?? undefined,
      expires: p.expires ?? undefined,
    }));
}

/**
 * Pull today's rip-current risk for a zone out of a Surf Zone Forecast (SRF)
 * product. Kept for back-compat (the existing lib/ripRiskCurve.ts hourly-curve
 * card anchors to this single word) — it's just `parseSrfPeriods(...)[0]`.
 */
export function parseRipRisk(productText: string, zone: string): RipRisk {
  return parseSrfPeriods(productText, zone)[0]?.level ?? "unknown";
}

const PERIOD_HEADER_RE = /^\.([A-Z][A-Z .]*?)\.{3}/gm;

/**
 * Parse EVERY period ("TODAY", "TONIGHT", "FRIDAY", ...) in a zone's SRF
 * segment, keeping the period label with its rip-current word — not just the
 * first (today's) match.
 *
 * TIME WINDOW ASSUMPTION (documented, not guaranteed by the product itself —
 * the SRF text gives no explicit start/end per period, only labels):
 *  - "TODAY"    -> issuance time (`issuedAt`) through 6 PM local that day.
 *  - "TONIGHT"  -> 6 PM local through 6 AM local the next day.
 *  - a named day (e.g. "FRIDAY") -> 6 AM through 6 PM local that date, the
 *    NEXT occurrence of that weekday on/after the day TODAY refers to.
 * These are the NWS's own standard SRF period conventions, but if `issuedAt`
 * or `tz` isn't supplied, windows are omitted (label + level only) rather than
 * guessed — a period without a window is still usable for its word, just not
 * for "is this the current period" resolution.
 */
export function parseSrfPeriods(
  productText: string,
  zone: string,
  opts?: { issuedAt?: string; tz?: string },
): SrfPeriod[] {
  const escaped = zone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const seg = productText
    .split("$$")
    .find((s) => new RegExp(escaped, "i").test(s));
  if (!seg) return [];

  // Split the zone segment into per-period chunks on ".LABEL..." headers.
  const headers: { label: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  PERIOD_HEADER_RE.lastIndex = 0;
  while ((m = PERIOD_HEADER_RE.exec(seg))) {
    headers.push({ label: m[1].trim(), index: m.index });
  }
  if (!headers.length) {
    // No explicit period headers in this zone's segment — fall back to a
    // single "TODAY" period from the first Rip Current Risk line, matching
    // the old single-word behavior.
    const lm = seg.match(/Rip Current Risk[\s*.:]*\b(Low|Moderate|High)\b/i);
    if (!lm) return [];
    const period: SrfPeriod = { label: "TODAY", level: lm[1].toLowerCase() as RipRisk };
    return [applyWindow(period, opts)];
  }

  const periods: SrfPeriod[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : seg.length;
    const chunk = seg.slice(start, end);
    const lm = chunk.match(/Rip Current Risk[\s*.:]*\b(Low|Moderate|High)\b/i);
    if (!lm) continue;
    periods.push(applyWindow({ label: headers[i].label, level: lm[1].toLowerCase() as RipRisk }, opts));
  }
  return periods;
}

const DAY_MS = 86_400_000;

/** Local-time-of-day (hour, in `tz`) -> a UTC ISO string for the given UTC day
 *  boundary `dayStartMs` (the previous UTC midnight), by re-deriving the
 *  offset from Intl and adjusting. Simple approach: build a Date at the given
 *  UTC instant, read its local wall-clock hour in `tz`, and binary-adjust.
 *  For the 6 AM / 6 PM boundaries this needs only whole-hour precision. */
function localHourToUtcIso(anchorMs: number, hourLocal: number, tz: string): string {
  // Start from the anchor instant's own UTC date, then walk to the instant
  // whose local wall-clock in `tz` reads `hourLocal`:00.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(anchorMs));
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const mo = Number(parts.find((p) => p.type === "month")?.value);
  const da = Number(parts.find((p) => p.type === "day")?.value);
  // Guess UTC ms for hourLocal:00 on that local date, then correct for the
  // zone's actual offset by comparing what that guess reads back as.
  let guess = Date.UTC(y, mo - 1, da, hourLocal, 0, 0);
  for (let i = 0; i < 2; i++) {
    const back = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
    }).formatToParts(new Date(guess));
    const hh = Number(back.find((p) => p.type === "hour")?.value);
    const mm = Number(back.find((p) => p.type === "minute")?.value);
    const diffMin = (hourLocal - hh) * 60 - mm;
    guess += diffMin * 60_000;
  }
  return new Date(guess).toISOString();
}

function applyWindow(period: SrfPeriod, opts?: { issuedAt?: string; tz?: string }): SrfPeriod {
  const tz = opts?.tz;
  const issuedAt = opts?.issuedAt;
  if (!tz || !issuedAt) return period;
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs)) return period;

  const label = period.label.toUpperCase();
  if (label === "TODAY") {
    return { ...period, start: issuedAt, end: localHourToUtcIso(issuedMs, 18, tz) };
  }
  if (label === "TONIGHT") {
    const start = localHourToUtcIso(issuedMs, 18, tz);
    const end = localHourToUtcIso(issuedMs + DAY_MS, 6, tz);
    return { ...period, start, end };
  }
  const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const dayIdx = DAY_NAMES.findIndex((d) => label.startsWith(d));
  if (dayIdx < 0) return period;
  // Walk forward day-by-day from the issuance date until the local weekday matches.
  for (let k = 1; k <= 8; k++) {
    const candidateMs = issuedMs + k * DAY_MS;
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
      .format(new Date(candidateMs))
      .toUpperCase();
    if (wd === DAY_NAMES[dayIdx]) {
      return {
        ...period,
        start: localHourToUtcIso(candidateMs, 6, tz),
        end: localHourToUtcIso(candidateMs, 18, tz),
      };
    }
  }
  return period;
}

// --- fetch -----------------------------------------------------------------
async function fetchSrf(
  office: string,
  zone: string,
  tz?: string,
): Promise<{ risk: RipRisk; periods: SrfPeriod[]; at?: string }> {
  try {
    const list = await fetchWithTimeout(
      `https://api.weather.gov/products/types/SRF/locations/${office}`,
      { timeoutMs: 7000, next: { revalidate: 3600 } },
    );
    if (!list.ok) return { risk: "unknown", periods: [] };
    const graph = ((await list.json())["@graph"] ?? []) as { id?: string }[];
    if (!graph.length || !graph[0].id) return { risk: "unknown", periods: [] };
    const prod = await fetchWithTimeout(
      `https://api.weather.gov/products/${graph[0].id}`,
      { timeoutMs: 7000, next: { revalidate: 3600 } },
    );
    if (!prod.ok) return { risk: "unknown", periods: [] };
    const json = (await prod.json()) as { productText?: string; issuanceTime?: string };
    const periods = parseSrfPeriods(json.productText ?? "", zone, {
      issuedAt: json.issuanceTime,
      tz,
    });
    return {
      risk: periods[0]?.level ?? "unknown",
      periods,
      at: fetchedAtOf(prod),
    };
  } catch {
    return { risk: "unknown", periods: [] };
  }
}

export async function fetchNws(loc: Location): Promise<Wrapped<NwsData>> {
  const fetchedAt = nowIso();
  const sz = loc.surfZone;
  try {
    const [alertsRes, rip] = await Promise.all([
      fetchWithTimeout(
        `https://api.weather.gov/alerts/active?point=${loc.lat},${loc.lon}`,
        { timeoutMs: 7000, next: { revalidate: 900 } }, // 15m — alerts change
      ),
      sz
        ? fetchSrf(sz.office, sz.name, loc.timezone)
        : Promise.resolve<{ risk: RipRisk; periods: SrfPeriod[]; at?: string }>({
            risk: "unknown",
            periods: [],
          }),
    ]);
    const alerts = alertsRes.ok ? parseAlerts(await alertsRes.json()) : [];
    return {
      source: "NWS (alerts + Surf Zone Forecast)",
      status: "ok",
      fetchedAt: oldestIso(alertsRes.ok ? fetchedAtOf(alertsRes) : undefined, rip.at),
      attribution: ATTRIBUTION,
      data: { alerts, ripCurrentRisk: rip.risk, srfPeriods: rip.periods },
    };
  } catch (e) {
    return {
      source: "NWS (alerts + Surf Zone Forecast)",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
