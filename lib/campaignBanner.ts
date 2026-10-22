// The "Re-elect Marci Woodward" strip (owner, 2026-10-22). One endorsement, one race, one end time.
//
// Who sees it: only people who can vote in Palm Beach County Commission District 4 —
// visitors viewing a beach inside the district, or visitors whose connection Cloudflare places
// in a District 4 ZIP code (approximate near the district line). Website only for now: the
// iPhone app is in App Review, so the apps skip it (see CampaignBanner).
//
// It switches itself off when the polls close (7:00 PM Eastern, election day). The server
// check and the page both test the time, so a page saved on a phone never shows it late.
// After the election this file and its route/component can be deleted.

export const CAMPAIGN = {
  id: "woodward-2026",
  headline: "Re-elect Marci Woodward",
  sub: "County Commissioner, District 4. An incredible advocate for our beaches.",
  cta: "Learn more",
  href: "https://marciwoodward.com/",
  /** Polls close 7:00 PM Eastern on Tuesday, November 3, 2026 (EST, UTC−5). */
  endIso: "2026-11-04T00:00:00Z",
  /** Optional legal line; null = none (owner's call, 2026-10-22). */
  disclaimer: null as string | null,
  /** App beaches inside District 4. */
  beaches: ["boca-raton"] as readonly string[],
  /** ZIP codes in or mostly in District 4: Boca Raton, Highland Beach, east Delray Beach,
   *  Gulf Stream, Boynton Beach's east side, Ocean Ridge, Briny Breezes, Manalapan, Lantana,
   *  Hypoluxo, South Palm Beach. West-Boca unincorporated ZIPs (33428, 33496, 33498) are out. */
  zips: ["33431", "33432", "33433", "33434", "33486", "33487", "33444", "33483", "33435", "33436", "33462"] as readonly string[],
} as const;

export function campaignLive(nowMs: number): boolean {
  return nowMs < Date.parse(CAMPAIGN.endIso);
}

export function campaignForBeach(slug: string | null | undefined, nowMs: number): boolean {
  return campaignLive(nowMs) && !!slug && CAMPAIGN.beaches.includes(slug);
}

export function campaignForZip(zip: string | null | undefined, nowMs: number): boolean {
  return campaignLive(nowMs) && !!zip && CAMPAIGN.zips.includes(zip.slice(0, 5));
}
