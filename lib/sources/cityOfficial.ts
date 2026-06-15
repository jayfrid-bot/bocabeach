import type { CityOfficialData, FlagColor, Location, Wrapped } from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso } from "@/lib/util";

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
  // A posted flag color caps the Beach Day score (red -> 85, double-red -> 5),
  // so we only trust assignment-like phrasings: either a color directly before
  // "flag(s)", or colors listed in the clause a "flags" anchor introduces
  // ("Today's flags: Yellow and Purple"). Within that clause we count a color
  // only when it is "terminated" like a list item — directly followed (after an
  // optional "(severity)" note) by a list separator, sentence punctuation, or
  // the clause end. That is what stops the adjective "red" in "watch for red
  // tide", "red drum", or "near Red Rock jetty" from manufacturing a false red
  // flag, while still capturing real one- and multi-color postings. "Red Reef"
  // is neutralized up front. Nothing matching => "unknown" (does not cap).
  const t = text.toLowerCase().replace(/red reef/g, "reef");

  // A color token, double-red first so "red" doesn't shadow it.
  const COLOR = "(double\\s*red|red|yellow|green|purple)";

  const found = new Set<FlagColor>();
  const add = (raw: string) => {
    const c = raw.replace(/\s+/g, "");
    if (c === "doublered") found.add("double-red");
    else found.add(c as FlagColor);
  };

  // Form 1: "<color> flag(s)" — color immediately before flag(s).
  const beforeRe = new RegExp(`\\b${COLOR}\\s+flags?\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = beforeRe.exec(t)) !== null) add(m[1]);

  // Form 2: a "flags" anchor introducing a color list — "flags: yellow and
  // purple", "flags flying: ...", "today's flags are ...". We scan the flags
  // sentence but only accept a color that is list-terminated (lookahead for a
  // separator / punctuation / end), so an adjective like "red tide" later in the
  // same sentence is ignored.
  const listColor = new RegExp(
    `\\b${COLOR}\\b(?:\\s*\\([^)]*\\))?(?=\\s*(?:[,;.&/]|and\\b|or\\b|$))`,
    "g",
  );
  const anchorRe = /\bflags?\b(?:\s+(?:are|is|flying|posted|currently|today))?\s*[:\-–—]?\s*([^.;\n]*)/g;
  while ((m = anchorRe.exec(t)) !== null) {
    const clause = m[1] ?? "";
    let c: RegExpExecArray | null;
    listColor.lastIndex = 0;
    while ((c = listColor.exec(clause)) !== null) add(c[1]);
  }

  // If a double-red was posted, drop a bare "red" so we don't emit both for the
  // same "double red flag" phrasing.
  if (found.has("double-red")) found.delete("red");

  return found.size ? [...found] : ["unknown"];
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
    // "SWIM ADVISORY LIFTED …", "… Rescinded", "… Reopened" announce that an
    // advisory is OVER — that's good news, not an active advisory. Skip these so
    // they don't show the red banner or cap the Beach Day score.
    if (
      /\b(lifted|rescind(?:ed)?|cancel(?:l?ed)?|cleared|re-?open(?:ed)?|removed|ended|expired|no longer)\b/i.test(
        title,
      )
    ) {
      continue;
    }
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
  let fetchedAt = nowIso();
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
      // Flags + advisories are the authoritative safety override and the City
      // re-posts the report each morning (and can change flags intra-day), so keep
      // this the freshest scrape — 15 min — so a stale overnight copy isn't served
      // for long after they update. The page also posts its own dated "Update"
      // label, surfaced in the UI as the true last-updated time.
      next: { revalidate: 900 }, // 15 min
    });
    fetchedAt = fetchedAtOf(res);
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
