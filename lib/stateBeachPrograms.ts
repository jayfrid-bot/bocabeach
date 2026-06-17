// Per-state beach water-quality / advisory programs.
//
// There is no single national real-time beach-advisory feed (EPA's BEACON
// aggregator runs ~a year behind), so for beaches outside our real-time
// coverage (currently FL's Healthy Beaches) the honest thing is to point the
// user at their own state's monitoring program. This is the link map behind
// that "check {STATE}'s program ↗" guidance.
//
// Each coastal state runs a BEACH Act grant program. Deep links below are the
// stable public landing pages; anything not listed falls back to EPA's national
// beach page, which is authoritative and never a dead end. Labels stay generic
// ("{State} beach water program") so the text is honest even on the fallback.

export interface StateProgram {
  /** Display label, e.g. "California beach water-quality program". */
  name: string;
  /** Public landing page for the program (or EPA national page as fallback). */
  url: string;
}

/** Two-letter code → full state name, for the coastal/Gulf/Pacific + territories. */
export const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  CA: "California",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MS: "Mississippi",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NY: "New York",
  NC: "North Carolina",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  TX: "Texas",
  VA: "Virginia",
  WA: "Washington",
  PR: "Puerto Rico",
  VI: "U.S. Virgin Islands",
};

const EPA_NATIONAL = "https://www.epa.gov/beaches";

// Deep links verified as live, stable government landing pages. States not in
// this table fall back to the EPA national page (still authoritative).
const PROGRAM_URLS: Record<string, string> = {
  AL: "https://www.adph.org/beaches/",
  CA: "https://www.waterboards.ca.gov/water_issues/programs/beaches/",
  CT: "https://portal.ct.gov/dph/environmental-health/recreational-water/recreational-water",
  DE: "https://dnrec.delaware.gov/watershed-stewardship/recreational-water/",
  FL: "https://www.floridahealth.gov/environmental-health/beach-water-quality/",
  HI: "https://eha-cloud.doh.hawaii.gov/cwb/",
  LA: "https://beach.ldh.la.gov/",
  ME: "https://www.mainehealthybeaches.org/",
  MD: "https://health.maryland.gov/beaches",
  MA: "https://www.mass.gov/marine-and-freshwater-beach-testing-in-massachusetts",
  MS: "https://www.mdeq.ms.gov/water/beaches/",
  NH: "https://www.des.nh.gov/water/healthy-swimming/beaches",
  NJ: "https://www.njbeaches.org/",
  NY: "https://www.health.ny.gov/environmental/outdoors/beaches/",
  NC: "https://www.deq.nc.gov/about/divisions/marine-fisheries/marine-fisheries-coastal-recreational-water-quality",
  OR: "https://www.oregon.gov/oha/ph/healthyenvironments/recreation/beaches/pages/index.aspx",
  RI: "https://health.ri.gov/find/beaches",
  SC: "https://des.sc.gov/programs/water/recreational-water-quality/beach-monitoring",
  TX: "https://cgis.glo.texas.gov/Beachwatch/",
  VA: "https://www.vdh.virginia.gov/environmental-health/beach-monitoring/",
  WA: "https://ecology.wa.gov/water-shorelines/water-quality/bacteria/beach-monitoring",
};

/**
 * The beach water-quality program for a two-letter state code. Always returns a
 * usable link (the EPA national page when we have no state-specific deep link).
 * Returns null only for an unrecognized / missing code.
 */
export function stateProgram(code: string | undefined): StateProgram | null {
  if (!code) return null;
  const cc = code.trim().toUpperCase();
  const stateName = US_STATE_NAMES[cc];
  if (!stateName) return null;
  return {
    name: `${stateName} beach water program`,
    url: PROGRAM_URLS[cc] ?? EPA_NATIONAL,
  };
}

/**
 * Best-effort two-letter state code from a Location.region string. `buildRegion`
 * emits region strings that end in the state code ("Palm Beach County, FL",
 * "Outer Banks, NC", or bare "TX"), so the trailing uppercase pair is the code.
 */
export function stateCodeFromRegion(region: string | undefined): string | undefined {
  if (!region) return undefined;
  const m = region.match(/\b([A-Z]{2})\s*$/);
  return m && US_STATE_NAMES[m[1]] ? m[1] : undefined;
}
