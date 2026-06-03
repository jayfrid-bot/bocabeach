import type { CityOfficialData, FlagColor, Location, Wrapped } from "@/lib/types";
import { fetchWithTimeout, nowIso } from "@/lib/util";

const ATTRIBUTION = "City of Boca Raton Ocean Rescue (myboca.us)";

/** Strip HTML tags and collapse whitespace into a single searchable text blob. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function detectFlags(text: string): FlagColor[] {
  // Only inspect text within ~70 chars of the word "flag" so place names like
  // "Red Reef Beach" in the hazards section aren't mistaken for a red flag.
  const t = text.toLowerCase().replace(/red reef/g, "reef");
  const windows: string[] = [];
  const re = /flags?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    windows.push(t.slice(Math.max(0, m.index - 70), m.index + 70));
  }
  const ctx = windows.join(" | ");

  const flags: FlagColor[] = [];
  // Order matters: check double-red before red.
  if (/double\s*red/.test(ctx)) flags.push("double-red");
  if (/\bpurple\b/.test(ctx)) flags.push("purple");
  if (!/double\s*red/.test(ctx) && /\bred\b/.test(ctx)) flags.push("red");
  if (/\byellow\b/.test(ctx)) flags.push("yellow");
  if (/\bgreen\b/.test(ctx)) flags.push("green");
  return flags.length ? flags : ["unknown"];
}

function ratingFor(text: string, activity: string): string | undefined {
  // e.g. "Swimming rated 'Fair'", "Surfing rated Poor: Unrideable"
  const re = new RegExp(
    `${activity}[^.]*?\\b(excellent|good|fair|poor)\\b`,
    "i",
  );
  const m = text.match(re);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : undefined;
}

function detectList(text: string, terms: Record<string, RegExp>): string[] {
  const found: string[] = [];
  for (const [label, re] of Object.entries(terms)) {
    if (re.test(text)) found.push(label);
  }
  return found;
}

/**
 * Pull the City's own posted update label, e.g.
 * "Tuesday June 2, 2026 (Update 10:00 am)" — the authoritative "last updated"
 * (their HTML carries it, so it's truthful regardless of our fetch cache).
 */
function detectUpdatedLabel(text: string): string | undefined {
  const m = text.match(
    /(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day\s+[A-Za-z]+\s+\d{1,2},?\s+\d{4}(?:\s*\(Updated?[^)]*\))?/,
  );
  return m ? m[0].replace(/\s+/g, " ").trim() : undefined;
}

/**
 * Detect an active City swim/beach advisory from the CivicPlus alert bar that
 * appears site-wide (links to /AlertCenter.aspx?AID=...). Runs on the raw HTML
 * so it can read the anchor + href. Only surfaces swim/beach/water advisories
 * or closures — not generic city alerts (sanitation, payments, etc.).
 */
export function detectNoSwimAdvisory(
  html: string,
): { title: string; url: string } | undefined {
  const linkRe =
    /<a\b[^>]*href="(\/AlertCenter\.aspx\?AID=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const path = m[1];
    const title = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/read on\.{0,3}/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) continue;
    const swimRelated =
      /no[\s-]*swim|do not swim|swim\s*advisory|water\s*(advisory|quality|contact)|beach\s*(advisory|closure|closed)/i.test(
        title,
      ) || /no-?swim/i.test(path);
    if (swimRelated) {
      return { title, url: `https://www.myboca.us${path}` };
    }
  }
  return undefined;
}

/** Heuristic parser for the manually-compiled City conditions page. Best-effort. */
export function parseCityConditions(html: string): CityOfficialData {
  const text = htmlToText(html);
  const lower = text.toLowerCase();

  const marineLife = detectList(lower, {
    jellyfish: /jellyfish|sea\s*lice|man[\s-]*o[\s-]*war|sea\s*pest/,
    seaweed: /seaweed|sargassum/,
  });
  const hazards = detectList(lower, {
    "rip currents": /rip\s*current/,
    "shoreline drop-offs": /drop[\s-]*off/,
    "rocks (Red Reef)": /red\s*reef|rocks/,
    "hot sand": /hot\s*sand/,
  });

  return {
    flags: detectFlags(lower),
    swimmingRating: ratingFor(text, "swimming"),
    snorkelingRating: ratingFor(text, "snorkel"),
    surfingRating: ratingFor(text, "surfing"),
    marineLife,
    hazards,
    updatedLabel: detectUpdatedLabel(text),
    noSwimAdvisory: detectNoSwimAdvisory(html),
    summary: text.slice(0, 280),
  };
}

export async function fetchCityOfficial(
  loc: Location,
): Promise<Wrapped<CityOfficialData>> {
  const fetchedAt = nowIso();
  if (!loc.cityConditionsUrl) {
    return {
      source: ATTRIBUTION,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: "no city conditions URL configured for this location",
    };
  }
  try {
    const res = await fetchWithTimeout(loc.cityConditionsUrl, {
      // Flags are the authoritative safety override and the City changes them
      // intra-day, so keep this the freshest scrape (1h). The page also posts its
      // own "Update HH:MM" label, surfaced in the UI for true last-updated time.
      next: { revalidate: 3600 }, // 1h
    });
    if (!res.ok) throw new Error(`city page -> ${res.status}`);
    const data = parseCityConditions(await res.text());
    return {
      source: ATTRIBUTION,
      // Heuristic scrape of a hand-edited page — flag it as best-effort.
      status: "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
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
