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
  | "ftl-elbo-beach-cam";

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
