import type { Location, NwsAlert, NwsData, RipRisk, Wrapped } from "@/lib/types";
import { fetchWithTimeout, nowIso } from "@/lib/util";

const ATTRIBUTION = "NOAA/NWS (api.weather.gov)";

// --- pure parsers ----------------------------------------------------------
interface AlertsJson {
  features?: {
    properties?: {
      event?: string;
      severity?: string;
      headline?: string;
      ends?: string | null;
      expires?: string | null;
    };
  }[];
}

/** Map the NWS active-alerts GeoJSON to a compact alert list. */
export function parseAlerts(json: AlertsJson): NwsAlert[] {
  return (json.features ?? [])
    .map((f) => f.properties ?? {})
    .filter((p) => p.event)
    .map((p) => ({
      event: p.event as string,
      severity: p.severity ?? "Unknown",
      headline: p.headline ?? undefined,
      ends: p.ends ?? p.expires ?? undefined,
    }));
}

/**
 * Pull today's rip-current risk for a zone out of a Surf Zone Forecast (SRF)
 * product. The product is split into per-zone segments by `$$`; within the
 * matching zone the first "Rip Current Risk*....High/Moderate/Low" is today's.
 */
export function parseRipRisk(productText: string, zone: string): RipRisk {
  const escaped = zone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const seg = productText
    .split("$$")
    .find((s) => new RegExp(escaped, "i").test(s) && /Rip Current Risk/i.test(s));
  if (!seg) return "unknown";
  const m = seg.match(/Rip Current Risk[\s*.:]*\b(Low|Moderate|High)\b/i);
  return m ? (m[1].toLowerCase() as RipRisk) : "unknown";
}

// --- fetch -----------------------------------------------------------------
async function fetchRipRisk(office: string, zone: string): Promise<RipRisk> {
  try {
    const list = await fetchWithTimeout(
      `https://api.weather.gov/products/types/SRF/locations/${office}`,
      { timeoutMs: 7000, next: { revalidate: 3600 } },
    );
    if (!list.ok) return "unknown";
    const graph = ((await list.json())["@graph"] ?? []) as { id?: string }[];
    if (!graph.length || !graph[0].id) return "unknown";
    const prod = await fetchWithTimeout(
      `https://api.weather.gov/products/${graph[0].id}`,
      { timeoutMs: 7000, next: { revalidate: 3600 } },
    );
    if (!prod.ok) return "unknown";
    return parseRipRisk((await prod.json()).productText ?? "", zone);
  } catch {
    return "unknown";
  }
}

export async function fetchNws(loc: Location): Promise<Wrapped<NwsData>> {
  const fetchedAt = nowIso();
  const sz = loc.surfZone;
  try {
    const [alertsRes, ripCurrentRisk] = await Promise.all([
      fetchWithTimeout(
        `https://api.weather.gov/alerts/active?point=${loc.lat},${loc.lon}`,
        { timeoutMs: 7000, next: { revalidate: 900 } }, // 15m — alerts change
      ),
      sz ? fetchRipRisk(sz.office, sz.name) : Promise.resolve<RipRisk>("unknown"),
    ]);
    const alerts = alertsRes.ok ? parseAlerts(await alertsRes.json()) : [];
    return {
      source: "NWS (alerts + Surf Zone Forecast)",
      status: "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: { alerts, ripCurrentRisk },
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
