/**
 * Camera registry + pure scheduling helpers for uw-frame.
 *
 * Kept separate from index.ts (and free of any Cloudflare/puppeteer imports)
 * so the cadence/daylight decisions can be unit-tested with plain Date
 * objects — no headless browser, no KV, no fetch.
 */

/** Stable id for each camera. Used as the KV key suffix and the ?cam= value. */
export type CameraId =
  | "deerfield-spinner-uw"
  | "deerfield-beach-cam"
  | "deerfield-surf-cam"
  | "deerfield-pier-cam"
  | "ftl-elbo-beach-cam"
  | "fort-myers-beach-cam"
  | "pensacola-sria-west-cam"
  | "siesta-beach-cam"
  | "white-sands-ami-cam"
  | "holmes-beach-cam"
  | "margaritaville-fmb-cam"
  | "pink-shell-fmb-cam"
  | "enco-sterling-reef-cam"
  | "enco-shores-of-panama-cam"
  | "sharkys-pcb-cam"
  | "fort-zachary-taylor-cam"
  | "sunset-grille-marathon-cam"
  // --- Florida Atlantic coast cams (2026-10-17, branch cams-atlantic). Append-only block. ---
  | "jax-beach-bw-cam"
  | "jax-pier-overview-cam"
  | "st-augustine-pier-cam"
  | "st-augustine-surf-cam"
  | "vilano-surf-station-cam"
  | "ormond-cam-180"
  | "dunlawton-cam-180"
  | "new-smyrna-cam-180"
  | "ponce-inlet-cam-180"
  | "hollywood-broadwalk-cam"
  | "dania-pier-cam"
  | "jupiter-reef-club-cam"
  | "key-west-southernmost-waterside-cam"
  | "key-west-southernmost-shores-cam"
  | "sombrero-beach-cam";

/**
 * "hourly"       — grabbed on every cron tick (today's Spinner behaviour).
 * "3h-daylight"  — grabbed only on a "surface hour" (see isSurfaceCamHour)
 *                  AND only while it's daylight in Eastern time. The spec
 *                  this worker was built from asked for every 2 hours; see
 *                  the BROWSER-RENDERING BUDGET comment in index.ts for why
 *                  that was widened to 3 hours instead.
 */
export type Cadence = "hourly" | "3h-daylight";

export interface CameraSpec {
  readonly id: CameraId;
  readonly videoId: string;
  readonly label: string;
  readonly purpose: string;
  readonly cadence: Cadence;
}

/**
 * Single source of truth for every camera this worker grabs. Deerfield
 * Beach's surface cams exist ONLY as YouTube live streams on the City's
 * channel — there is no still-image feed — so each one gets the same
 * embed-and-screenshot treatment as the original underwater cam. Fort
 * Lauderdale Beach's cam (Elbo Room's public YouTube live stream, owner
 * approved) is the same shape: no still-image feed, so it's grabbed the
 * same way.
 * The Gulf and Keys entries (Siesta Key, Anna Maria Island, Fort Myers Beach,
 * Panama City Beach, Key West, Marathon; added 2026-10-16) and the Florida
 * Atlantic entries after them (added 2026-10-17) are owner-credited business,
 * public-body and re-streamed cams. All stay on "3h-daylight", the slowest
 * cadence here, and sit at the END of the list so the tick budget (index.ts)
 * cuts them first if a tick runs long.
 */
export const CAMERA_REGISTRY: readonly CameraSpec[] = [
  {
    id: "deerfield-spinner-uw",
    videoId: "SHfAtWHr9Ks",
    label: "Spinner the Sea Cam",
    purpose: "underwater",
    cadence: "hourly",
  },
  {
    id: "deerfield-beach-cam",
    videoId: "rdeoEeJ00xA",
    label: "Deerfield Beach Cam",
    purpose: "crowd/sand",
    cadence: "3h-daylight",
  },
  {
    id: "deerfield-surf-cam",
    videoId: "hIeFPNHfuoY",
    label: "Deerfield Surf Cam",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "deerfield-pier-cam",
    videoId: "H33wtprQqSM",
    label: "Deerfield Pier Cam",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "ftl-elbo-beach-cam",
    videoId: "1j1lgppb0PY",
    label: "Fort Lauderdale Beach Cam (Elbo Room)",
    purpose: "crowd/sand",
    cadence: "3h-daylight",
  },
  {
    id: "fort-myers-beach-cam",
    videoId: "nj9jdOXXhEo",
    label: "Fort Myers Beach Cam (Visit Fort Myers)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "pensacola-sria-west-cam",
    videoId: "HKIc6CYlMzI",
    label: "Pensacola Beach West Cam (Santa Rosa Island Authority)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "siesta-beach-cam",
    videoId: "NLhxcyzXQxM",
    label: "Siesta Beach Live (Sarasota County / Visit Sarasota County)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "white-sands-ami-cam",
    videoId: "ecD9ZDXLE6A",
    label: "Anna Maria Island White Sands (White Sands Beach Resort)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "holmes-beach-cam",
    videoId: "_W0Gf1Le2qc",
    label: "Holmes Beach (Beach Live Cams)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "margaritaville-fmb-cam",
    videoId: "2qd9j2CbIpg",
    label: "Fort Myers Beach License to Chill (Margaritaville Beach Resort)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "pink-shell-fmb-cam",
    videoId: "uK-eZz0w-go",
    label: "Fort Myers Beach Pink Shell (Pink Shell Beach Resort & Marina)",
    purpose: "crowd/sand",
    cadence: "3h-daylight",
  },
  {
    id: "enco-sterling-reef-cam",
    videoId: "Y82E6_IVEdY",
    label: "Panama City Beach Sterling Reef (ENCO Electronic Systems)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "enco-shores-of-panama-cam",
    videoId: "GFsRPlw81W8",
    label: "Panama City Beach Shores of Panama (ENCO Electronic Systems)",
    purpose: "crowd/sand",
    cadence: "3h-daylight",
  },
  {
    id: "sharkys-pcb-cam",
    videoId: "EYs8y8gOwf0",
    label: "Panama City Beach Sharky's (Sharky's Beachfront Restaurant)",
    purpose: "crowd/sand",
    cadence: "3h-daylight",
  },
  {
    id: "fort-zachary-taylor-cam",
    videoId: "sDXwrYQPeOQ",
    label: "Key West Fort Zachary Taylor (shared by Florida Live)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "sunset-grille-marathon-cam",
    videoId: "SXMC-MzSncI",
    label: "Marathon Sunset Grille (Sunset Grille & Raw Bar / Seek Florida Keys)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  // --- Florida Atlantic coast cams (2026-10-17, branch cams-atlantic). Append-only block. All use the
  // slowest existing cadence (3h-daylight); the home-server courier paces its own grabs (scripts/courier_schedule.py). ---
  {
    id: "jax-beach-bw-cam",
    videoId: "bZ4uxyLqV-E",
    label: "Jacksonville Beach Cam (Best Western Oceanfront Jacksonville Beach)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "jax-pier-overview-cam",
    videoId: "EOTLy91Ycew",
    label: "Jacksonville Beach Pier — Overview (The Jacksonville Beach Pier)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "st-augustine-pier-cam",
    videoId: "Q6eZVkUKFxo",
    label: "St. Augustine Beach Pier Cam (The Surf Station)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "st-augustine-surf-cam",
    videoId: "H2q_DJc33kg",
    label: "St. Augustine Beach Surf Cam (The Surf Station)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "vilano-surf-station-cam",
    videoId: "o4BJ-eDgYrM",
    label: "North Vilano — South Ponte Vedra Surf Cam (The Surf Station)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "ormond-cam-180",
    videoId: "p1s7EdZgGvU",
    label: "Ormond Beach Cam 180 (Volusia County Beach Safety)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "dunlawton-cam-180",
    videoId: "3hwTkO_5KXo",
    label: "Dunlawton Beach Cam 180 (Volusia County Beach Safety)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "new-smyrna-cam-180",
    videoId: "550p9smwjPM",
    label: "New Smyrna Beach Cam 180 (Volusia County Beach Safety)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "ponce-inlet-cam-180",
    videoId: "ZCozdEGwkDI",
    label: "Ponce Inlet Beach Cam 180 (Volusia County Beach Safety)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "hollywood-broadwalk-cam",
    videoId: "cmkAbDUEoyA",
    label: "Hollywood Beach Broadwalk Cam (City of Hollywood)",
    purpose: "crowd/sand",
    cadence: "3h-daylight",
  },
  {
    id: "dania-pier-cam",
    videoId: "o1eTLR7Degs",
    label: "Dania Beach Pier Cam (City of Dania Beach)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "jupiter-reef-club-cam",
    videoId: "1FYgBpkM7SA",
    label: "Jupiter Reef Club Cam (Jupiter Reef Club)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "key-west-southernmost-waterside-cam",
    videoId: "UyfDBDRwPeI",
    label: "Key West South Beach — Waterside (Southernmost Beach Resort)",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
  {
    id: "key-west-southernmost-shores-cam",
    videoId: "gsDDwA96F6Q",
    label: "Key West South Beach — Shores Pool (Southernmost Beach Resort)",
    purpose: "crowd/sand",
    cadence: "3h-daylight",
  },
  {
    id: "sombrero-beach-cam",
    videoId: "jE4og3o_SXs",
    label: "Sombrero Beach Cam (Monroe County Tourist Development Council (Florida Keys))",
    purpose: "shoreline",
    cadence: "3h-daylight",
  },
] as const;

export function findCamera(id: string | null | undefined): CameraSpec | undefined {
  if (!id) return undefined;
  return CAMERA_REGISTRY.find((c) => c.id === id);
}

/** The hour-of-day (0-23) in America/New_York for a given instant. */
export function easternHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
  let h = parseInt(raw, 10);
  if (Number.isNaN(h)) h = 0;
  if (h === 24) h = 0; // some ICU builds print midnight as "24" in hour12:false
  return h;
}

/**
 * Daylight window for the surface cams: roughly 06:00-20:00 Eastern. This is
 * intentionally the same approximate window the cron trigger already covers
 * (see the trigger comment in wrangler.jsonc) — it exists as a second,
 * DST-aware gate because the cron itself is fixed UTC and drifts by an hour
 * across the EDT/EST boundary.
 */
export function isDaylightEastern(date: Date): boolean {
  const h = easternHour(date);
  return h >= 6 && h <= 20;
}

/**
 * "Surface hour" = a cron tick that lands on a UTC hour congruent to 1 mod 3
 * (10, 13, 16, 19, 22 UTC — i.e. every 3 hours, starting at the first tick of
 * the day). Combined with isDaylightEastern this gives the surface cams a
 * 3-hourly, daylight-only cadence without needing a second cron schedule.
 */
export function isSurfaceCamHour(date: Date): boolean {
  return date.getUTCHours() % 3 === 1;
}

/** Which registry entries are due to be grabbed at this cron tick. */
export function camsDueAtTick(
  date: Date,
  registry: readonly CameraSpec[] = CAMERA_REGISTRY
): CameraSpec[] {
  const surfaceDue = isDaylightEastern(date) && isSurfaceCamHour(date);
  return registry.filter((cam) => {
    if (cam.cadence === "hourly") return true;
    if (cam.cadence === "3h-daylight") return surfaceDue;
    return false;
  });
}
