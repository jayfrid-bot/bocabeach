import type { Location, WaterQualityData, Wrapped } from "@/lib/types";
import { nowIso } from "@/lib/util";

const ATTRIBUTION = "Florida Healthy Beaches Program (floridahealth.gov)";

/**
 * Water quality from the FL Healthy Beaches Program.
 *
 * NOTE: floridahealthybeaches.com is a client-rendered app with no documented
 * public API, so a reliable connector needs either their internal data endpoint
 * or a headless scrape. For v1 this returns an "unknown / no advisory" best-effort
 * result so the rest of the page degrades gracefully. Wire up the real source here.
 *
 * Implementation hint: capture the XHR the site makes in the browser network tab,
 * or sample the county DOH advisory page, then map enterococci CFU/100ml ->
 * good (0-35) / moderate (36-70) / poor (71+).
 */
export async function fetchWaterQuality(
  loc: Location,
): Promise<Wrapped<WaterQualityData>> {
  const fetchedAt = nowIso();
  const sites = loc.healthyBeachesSites ?? [];
  return {
    source: ATTRIBUTION,
    status: "best-effort",
    fetchedAt,
    attribution: ATTRIBUTION,
    note: "live FL Healthy Beaches feed not yet wired up — treated as no active advisory",
    data: {
      overall: "unknown",
      advisory: false,
      sites: sites.map((name) => ({ name, rating: "unknown" as const })),
    },
  };
}
