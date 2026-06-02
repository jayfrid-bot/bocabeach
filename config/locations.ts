import type { Location, LocationPublic } from "@/lib/types";

/**
 * The whole multi-town design lives here: adding a beach town = adding one entry.
 * Everything downstream (data fetching, scoring, routing, UI) is driven off this list.
 *
 * To add a town you need: lat/lon (beach-side), the nearest NOAA tide station id,
 * the nearest NDBC buoy id, optional FL Healthy Beaches site names + a city
 * conditions page to scrape, and its cams.
 */
export const LOCATIONS: Location[] = [
  {
    slug: "boca-raton",
    name: "Boca Raton",
    region: "Palm Beach County, FL",
    lat: 26.3587,
    lon: -80.0686,
    timezone: "America/New_York",
    noaaTideStationId: "8722816", // Boca Raton
    noaaTideStationFallbackId: "8722670", // Lake Worth Pier
    ndbcBuoyId: "LKWF1", // Lake Worth Pier C-MAN (nearest)
    ndbcBuoyFallbackId: "FWYF1", // Fowey Rocks
    // SPLocation names as published by the FL Healthy Beaches feed (Palm Beach county).
    healthyBeaches: {
      county: "Palm Beach",
      sites: ["SPANISH RIVER", "SOUTH INLET PARK", "RED REEF PARK"],
    },
    cityConditionsUrl: "https://www.myboca.us/2464/Beach-Conditions",
    cams: [
      {
        // bocasurfcam.com publishes a fresh full-res JPEG at most_recent_image.php;
        // proxied via /api/cam/boca-surf so it serves same-origin over https.
        id: "boca-surf",
        name: "Boca Surf Cam",
        provider: "bocasurfcam.com",
        embedType: "image",
        url: "http://www.bocasurfcam.com/",
        snapshotUrl: "http://bocasurfcam.com/most_recent_image.php",
        attribution: "Live still courtesy bocasurfcam.com",
        lat: 26.3492,
        lon: -80.0701,
      },
      {
        // Same operator/setup as bocasurfcam — live still at most_recent_image.php
        // (view over Lake Boca Raton / the inlet). Proxied via /api/cam/lake-boca.
        id: "lake-boca",
        name: "Lake Boca Cam",
        provider: "lakebocacam.com",
        embedType: "image",
        url: "http://lakebocacam.com/",
        snapshotUrl: "http://lakebocacam.com/most_recent_image.php",
        attribution: "Live still courtesy lakebocacam.com",
        lat: 26.3387,
        lon: -80.0716,
      },
      {
        // Live still resolved from video-monitoring.com's latest.json (view s4 =
        // the main inlet shot), proxied same-origin via /api/cam/boca-inlet.
        id: "boca-inlet",
        name: "Boca Raton Inlet Cam",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/bocainlet/",
        snapshotFeed: {
          base: "http://video-monitoring.com/beachcams/bocainlet",
          view: "s4",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3354,
        lon: -80.0703,
      },
      {
        // Same bocainlet feed, view s16 = the surf & shoreline angle.
        id: "boca-inlet-surf",
        name: "Boca Raton Inlet — Surf & Shoreline",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/bocainlet/",
        snapshotFeed: {
          base: "http://video-monitoring.com/beachcams/bocainlet",
          view: "s16",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3354,
        lon: -80.0703,
      },
      {
        // view s4 = "Main Shot" on video-monitoring.com/beachcams/boca/.
        id: "boca-south",
        name: "Boca Raton South Beach Cam",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/boca/",
        snapshotFeed: {
          base: "http://video-monitoring.com/beachcams/boca",
          view: "s4",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3456,
        lon: -80.0701,
      },
      {
        name: "Surfline — Boca Raton",
        provider: "Surfline",
        embedType: "link",
        url: "https://www.surfline.com/surf-reports-forecasts-cams/united-states/florida/palm-beach-county/boca-raton/4148411",
        attribution: "Surfline (Premium cam, link only — no embedding/scraping)",
        lat: 26.36,
        lon: -80.07,
      },
    ],
  },
  {
    slug: "deerfield-beach",
    name: "Deerfield Beach",
    region: "Broward County, FL",
    lat: 26.317, // Deerfield Beach Pier
    lon: -80.0748,
    timezone: "America/New_York",
    noaaTideStationId: "8722816", // Boca Raton (~3 mi north)
    noaaTideStationFallbackId: "8722956", // South Port Everglades
    ndbcBuoyId: "LKWF1", // Lake Worth Pier C-MAN (nearest north)
    ndbcBuoyFallbackId: "FWYF1", // Fowey Rocks
    healthyBeaches: {
      county: "Broward",
      sites: ["DEERFIELD BEACH PIER", "DEERFIELD BEACH SE 10TH ST"],
    },
    cams: [
      {
        name: "Deerfield Beach Camera",
        provider: "City of Deerfield Beach (YouTube)",
        embedType: "iframe",
        url: "https://www.youtube.com/embed/rdeoEeJ00xA",
      },
      {
        name: "Deerfield Beach Pier Camera",
        provider: "City of Deerfield Beach (YouTube)",
        embedType: "iframe",
        url: "https://www.youtube.com/embed/H33wtprQqSM",
      },
      {
        name: "Deerfield Beach Surf Camera",
        provider: "City of Deerfield Beach (YouTube)",
        embedType: "iframe",
        url: "https://www.youtube.com/embed/hIeFPNHfuoY",
      },
      {
        name: "City of Deerfield Beach — all live cams",
        provider: "City of Deerfield Beach",
        embedType: "link",
        url: "https://www.deerfield-beach.com/1474/Livestream-Cameras",
      },
      {
        name: "Surfline — Deerfield Beach",
        provider: "Surfline",
        embedType: "link",
        url: "https://www.surfline.com/surf-reports-forecasts-cams/united-states/florida/broward-county/deerfield-beach/4153071",
        attribution: "Surfline (Premium cam, link only — no embedding/scraping)",
      },
    ],
  },
];

export function listLocations(): Location[] {
  return LOCATIONS;
}

export function getLocation(slug: string): Location | undefined {
  return LOCATIONS.find((l) => l.slug === slug);
}

export function toPublicLocation(l: Location): LocationPublic {
  return {
    slug: l.slug,
    name: l.name,
    region: l.region,
    lat: l.lat,
    lon: l.lon,
    timezone: l.timezone,
  };
}
