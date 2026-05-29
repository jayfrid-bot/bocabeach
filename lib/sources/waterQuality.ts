import type {
  Location,
  WaterQualityData,
  WaterQualityRating,
  WaterQualitySite,
  Wrapped,
} from "@/lib/types";
import { fetchWithTimeout, nowIso } from "@/lib/util";

const ATTRIBUTION = "Florida Healthy Beaches Program (floridahealth.gov)";

/**
 * Water quality from the FL Healthy Beaches Program.
 *
 * The program's public results are rendered by a Caspio DataPage embedded on the
 * floridahealth.gov beach-water-quality page. The DataPage's "deploy by URL"
 * endpoint serves the same data as plain server-rendered HTML — no headless
 * browser needed — when queried by county:
 *
 *   https://b3.caspio.com/dp/<appKey>?County=<County>&CPIpage=<n>
 *
 * Each row carries the sampling location, sample date, the raw enterococci value
 * (embedded as `var enterococcus = '<cfu>'`) and an Advisory Yes/No flag. We map
 * enterococci CFU/100ml to a rating using the program's own thresholds:
 *   good 0-35  ·  moderate 36-70  ·  poor 71+    (advisory issued above 70).
 *
 * The appKey can be overridden via FL_HEALTHY_BEACHES_APPKEY if the deployment
 * changes. Everything is best-effort and self-contained: any failure degrades to
 * a null payload so the rest of the page keeps working.
 */
const APPKEY =
  process.env.FL_HEALTHY_BEACHES_APPKEY ?? "cb8a100003f7272d1f294c7b8cc9";
const CASPIO_BASE = "https://b3.caspio.com/dp";
const PER_PAGE = 10; // Caspio default page size
const MAX_PAGES = 8; // safety bound (~80 county sites)
const REVALIDATE = 43200; // 12h — the program samples weekly

// --- enterococci -> rating -------------------------------------------------
/**
 * Map an enterococci reading (CFU / 100 ml of marine water) to a rating using
 * the FL Healthy Beaches thresholds: good 0-35, moderate 36-70, poor 71+.
 */
export function rateEnterococci(cfu: number): WaterQualityRating {
  if (!Number.isFinite(cfu) || cfu < 0) return "unknown";
  if (cfu <= 35) return "good";
  if (cfu <= 70) return "moderate";
  return "poor";
}

// --- pure parsing ----------------------------------------------------------
export interface HealthyBeachesSample {
  /** SPLocation name exactly as published (typically upper-case). */
  location: string;
  /** Sample date label as shown, e.g. "5/26/2026". */
  sampledLabel?: string;
  /** ISO date (UTC midnight) for sorting/most-recent selection. */
  sampledAt?: string;
  /** Raw enterococci CFU/100ml, or undefined for "NR" / no result. */
  enterococci?: number;
  advisory: boolean;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8217;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** "5/26/2026" -> "2026-05-26T00:00:00.000Z" (UTC midnight), or undefined. */
function labelToIso(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const m = label.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  const t = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * Parse one Caspio results page into sample rows. Resilient to column
 * reordering: it reads each data row's text rather than relying on cell order.
 */
export function parseHealthyBeaches(html: string): HealthyBeachesSample[] {
  const out: HealthyBeachesSample[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const rowHtml = m[1];
    if (!/cbResultSetTableCell/.test(rowHtml)) continue;

    // Raw enterococci value is embedded in an inline script: var enterococcus = 'NN'
    const entMatch = rowHtml.match(/var\s+enterococcus\s*=\s*'([^']*)'/i);
    if (!entMatch) continue;

    const text = stripTags(rowHtml);

    // "Location: SPANISH RIVER" up to the next "Date:" label.
    const locMatch = text.match(/Location:\s*(.+?)\s*Date:/i);
    if (!locMatch) continue;
    const location = locMatch[1].trim();

    // The "Date:" column precedes the map cell's "Sample Date:", so the first
    // match is the sample date we want.
    const dateMatch = text.match(/Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const sampledLabel = dateMatch ? dateMatch[1] : undefined;

    // The Advisory column reads "Advisory: Yes" / "Advisory: No"; the map cell
    // uses "Advisory: 0/-1" and the info cell "Advisory *A ..." — Yes|No is unique.
    const advMatch = text.match(/Advisory:\s*(Yes|No)\b/i);

    const cfu = Number(entMatch[1]);
    out.push({
      location,
      sampledLabel,
      sampledAt: labelToIso(sampledLabel),
      enterococci: Number.isFinite(cfu) ? cfu : undefined,
      advisory: advMatch ? advMatch[1].toLowerCase() === "yes" : false,
    });
  }
  return out;
}

/** Parse the "Records 1-10 of 50" footer to learn the total record count. */
export function parseTotalRecords(html: string): number | null {
  const m = html.match(/Records\s+\d+\s*-\s*\d+\s+of\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

const RANK: Record<WaterQualityRating, number> = {
  unknown: 0,
  good: 1,
  moderate: 2,
  poor: 3,
};

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSe\b/, "SE")
    .trim();
}

/**
 * Reduce raw samples to one most-recent reading per configured site and roll
 * them up into the overall rating (worst site wins) + advisory flag.
 */
export function summarizeWaterQuality(
  samples: HealthyBeachesSample[],
  siteNames: string[],
): WaterQualityData {
  const sites: WaterQualitySite[] = [];
  let advisory = false;

  for (const name of siteNames) {
    const key = name.trim().toUpperCase();
    const matches = samples.filter((s) => s.location.trim().toUpperCase() === key);
    if (matches.length === 0) {
      sites.push({ name: titleCase(name), rating: "unknown" });
      continue;
    }
    matches.sort((a, b) => (b.sampledAt ?? "").localeCompare(a.sampledAt ?? ""));
    const latest = matches[0];
    const rating =
      latest.enterococci != null ? rateEnterococci(latest.enterococci) : "unknown";
    if (latest.advisory) advisory = true;
    sites.push({
      name: titleCase(latest.location),
      rating,
      enterococci: latest.enterococci,
      sampledAt: latest.sampledAt,
    });
  }

  let overall: WaterQualityRating = "unknown";
  for (const s of sites) if (RANK[s.rating] > RANK[overall]) overall = s.rating;

  return { overall, advisory, sites };
}

// --- fetch -----------------------------------------------------------------
async function fetchCountyPage(county: string, page: number): Promise<string> {
  const url =
    `${CASPIO_BASE}/${APPKEY}?County=${encodeURIComponent(county)}&CPIpage=${page}`;
  const res = await fetchWithTimeout(url, {
    timeoutMs: 7000,
    next: { revalidate: REVALIDATE },
  });
  if (!res.ok) throw new Error(`Healthy Beaches ${county} p${page} -> ${res.status}`);
  return res.text();
}

export async function fetchWaterQuality(
  loc: Location,
): Promise<Wrapped<WaterQualityData>> {
  const fetchedAt = nowIso();
  const cfg = loc.healthyBeaches;
  if (!cfg || cfg.sites.length === 0) {
    return {
      source: ATTRIBUTION,
      status: "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      note: "no FL Healthy Beaches sites configured for this location",
      data: { overall: "unknown", advisory: false, sites: [] },
    };
  }

  try {
    // Page 1 tells us the total record count; fetch the rest in parallel so a
    // far-down (alphabetical) site doesn't serialize many round-trips.
    const first = await fetchCountyPage(cfg.county, 1);
    const samples = parseHealthyBeaches(first);

    const wanted = new Set(cfg.sites.map((s) => s.trim().toUpperCase()));
    for (const s of samples) wanted.delete(s.location.trim().toUpperCase());

    const total = parseTotalRecords(first);
    const totalPages = Math.min(
      MAX_PAGES,
      total ? Math.ceil(total / PER_PAGE) : 1,
    );

    if (wanted.size > 0 && totalPages > 1) {
      const pages = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          fetchCountyPage(cfg.county, i + 2).then(parseHealthyBeaches).catch(() => []),
        ),
      );
      for (const rows of pages) samples.push(...rows);
    }

    const data = summarizeWaterQuality(samples, cfg.sites);
    const known = data.sites.some((s) => s.rating !== "unknown");
    return {
      source: `FL Healthy Beaches (${cfg.county} County)`,
      status: known ? "ok" : "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: known
        ? undefined
        : "no recent samples found for configured sites — treated as no active advisory",
    };
  } catch (e) {
    return {
      source: ATTRIBUTION,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
