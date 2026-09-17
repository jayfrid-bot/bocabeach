import type { Location, LocationPublic } from "@/lib/types";
import generatedRaw from "./locations.generated.json";

/**
 * Machine-added locations (from the admin console's "Add" → GitHub commit). Kept
 * in a separate JSON so the hand-curated TS below stays the human source of truth
 * while admin-added beaches are trivial to append programmatically.
 */
const GENERATED = generatedRaw as Location[];

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
    // Due-east-facing Atlantic shoreline: wind blowing straight onshore comes
    // FROM ~90° (E). Enables the man-o'-war + shark SE-FL advisories here.
    coastNormalDeg: 90,
    coast: "atlantic",
    noaaTideStationId: "8722816", // Boca Raton
    noaaTideStationFallbackId: "8722670", // Lake Worth Pier
    // Observed water level comes from the Lake Worth Pier GAUGE (~18 mi north):
    // 8722816 is a subordinate PREDICTION station and publishes no observations.
    noaaWaterLevelStationId: "8722670",
    ndbcBuoyId: "LKWF1", // Lake Worth Pier C-MAN (nearest)
    ndbcBuoyFallbackId: "FWYF1", // Fowey Rocks
    // SPLocation names as published by the FL Healthy Beaches feed (Palm Beach county).
    healthyBeaches: {
      county: "Palm Beach",
      sites: ["SPANISH RIVER", "SOUTH INLET PARK", "RED REEF PARK"],
    },
    cityConditionsUrl: "https://www.myboca.us/2464/Beach-Conditions",
    cityConditionsAttribution: "City of Boca Raton Ocean Rescue (myboca.us)",
    surfZone: { office: "MFL", name: "Palm Beach" }, // NWS Miami Surf Zone Forecast

    cams: [
      {
        // view s4 = "Main Shot" on video-monitoring.com/beachcams/boca/.
        id: "boca-south",
        name: "Boca Raton South Beach Cam",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/boca/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/boca",
          view: "s4",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3456,
        lon: -80.0701,
      },
      {
        // Same bocainlet feed, view s8 = the north-side beach & shoreline.
        id: "boca-inlet-north",
        name: "Boca Raton Inlet — North Beach",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/bocainlet/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/bocainlet",
          view: "s8",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3354,
        lon: -80.0703,
      },
      {
        // Same boca feed, view s11 = the close shoreline & surf (swimmers/surfers).
        id: "boca-south-surf",
        name: "Boca Raton South Beach — Shoreline & Surf",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/boca/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/boca",
          view: "s11",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3456,
        lon: -80.0701,
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
          base: "https://video-monitoring.com/beachcams/bocainlet",
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
          base: "https://video-monitoring.com/beachcams/bocainlet",
          view: "s16",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3354,
        lon: -80.0703,
      },
      {
        // Same bocainlet feed, view s12 = the rock jetty / inlet channel.
        id: "boca-inlet-jetty",
        name: "Boca Raton Inlet — Jetty",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/bocainlet/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/bocainlet",
          view: "s12",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        lat: 26.3354,
        lon: -80.0703,
      },
    ],
  },
  {
    slug: "deerfield-beach",
    name: "Deerfield Beach",
    region: "Broward County, FL",
    lat: 26.3165,
    lon: -80.0742,
    timezone: "America/New_York",
    // Shoreline runs ~N4°E, so wind blowing straight onshore comes FROM ~94° (E,
    // shading ESE). Enables the man-o'-war + shark SE-FL advisories here.
    coastNormalDeg: 94,
    coast: "atlantic",
    noaaTideStationId: "8722832", // Deerfield Beach, Hillsboro River (predictions only)
    noaaTideStationFallbackId: "8722956", // South Port Everglades
    // 8722832 is a subordinate PREDICTION station and publishes no observations.
    // Observed water level comes from the South Port Everglades GAUGE
    // (~16.5 mi south) instead.
    noaaWaterLevelStationId: "8722956",
    ndbcBuoyId: "41122", // Hollywood Beach Waverider (waves + air/water temp, live)
    ndbcBuoyFallbackId: "LKWF1", // Lake Worth Pier C-MAN (air/water temp only, no waves)
    // SPLocation names as published by the FL Healthy Beaches feed (Broward county).
    healthyBeaches: {
      county: "Broward",
      sites: ["DEERFIELD BEACH PIER", "DEERFIELD BEACH SE 10TH ST"],
    },
    // The City's conditions page redirects to an ArcGIS dashboard — not
    // scrapable HTML — so it's kept only as the human "see official page"
    // link; flagsFeedUrl below is what lib/sources/cityOfficial.ts actually reads.
    cityConditionsUrl: "https://www.deerfield-beach.com/286/Beach-Conditions-and-Flags",
    cityConditionsAttribution: "City of Deerfield Beach Ocean Rescue",
    flagsFeedUrl: "https://uw-frame.entwined-app.workers.dev/flags?slug=deerfield-beach",
    surfZone: { office: "MFL", name: "Broward" }, // NWS Miami Surf Zone Forecast

    cams: [
      {
        // City of Deerfield Beach's YouTube livestream "Beach Camera" (sand
        // & crowd view), courtesy the uw-frame Cloudflare Worker's headless-
        // Chrome frame grab (see workers/uw-frame/); proxied same-origin via
        // /api/cam/deerfield-beach-cam.
        id: "deerfield-beach-cam",
        name: "Deerfield Beach Cam",
        provider: "City of Deerfield Beach",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=rdeoEeJ00xA",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=deerfield-beach-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=deerfield-beach-cam",
        attribution: "Live stream courtesy City of Deerfield Beach",
        lat: 26.3165,
        lon: -80.0742,
      },
      {
        // "Surf Camera" livestream — shoreline & surf view.
        id: "deerfield-surf-cam",
        name: "Deerfield Beach — Surf Cam",
        provider: "City of Deerfield Beach",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=hIeFPNHfuoY",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=deerfield-surf-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=deerfield-surf-cam",
        attribution: "Live stream courtesy City of Deerfield Beach",
        lat: 26.3165,
        lon: -80.0742,
      },
      {
        // "Fishing Camera" livestream — the International Fishing Pier.
        id: "deerfield-pier-cam",
        name: "Deerfield Beach — Fishing Pier Cam",
        provider: "City of Deerfield Beach",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=H33wtprQqSM",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=deerfield-pier-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=deerfield-pier-cam",
        attribution: "Live stream courtesy City of Deerfield Beach",
        lat: 26.3172,
        lon: -80.0738,
      },
      {
        // "Spinner the Sea Cam" — an underwater livestream off the pier.
        // Read hourly (not every 10 min) by the vision job's separate uw
        // calibration pass — see scripts/cam_seaweed.py's UW_FRAME_URL.
        id: "deerfield-spinner-uw",
        name: "Spinner the Sea Cam (underwater)",
        provider: "City of Deerfield Beach",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=SHfAtWHr9Ks",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=deerfield-spinner-uw",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=deerfield-spinner-uw",
        attribution: "Live stream courtesy City of Deerfield Beach",
        lat: 26.3172,
        lon: -80.0738,
      },
    ],
  },
  {
    slug: "fort-lauderdale",
    name: "Fort Lauderdale Beach",
    region: "Broward County, FL",
    // The public beach at Las Olas Blvd & A1A. The resolver's coastal gate
    // rejects "Fort Lauderdale" (the geocoded city centroid is inland), so this
    // entry is hand-curated like Deerfield.
    lat: 26.1195,
    lon: -80.1035,
    timezone: "America/New_York",
    // The shoreline runs roughly north-south here (a few degrees east of north),
    // so wind blowing straight onshore comes from ~94° (E). This also enables
    // the southeast Florida man-o'-war and shark advisories.
    coastNormalDeg: 94,
    coast: "atlantic",
    noaaTideStationId: "8722939", // Bahia Mar Yacht Club, 0.5 mi (predictions)
    noaaTideStationFallbackId: "8722956", // South Port Everglades
    // Bahia Mar only publishes predictions. The measured water level comes
    // from the South Port Everglades gauge, 2.7 mi south.
    noaaWaterLevelStationId: "8722956",
    ndbcBuoyId: "41122", // Hollywood Beach Waverider, 8 mi south (waves + water temp)
    ndbcBuoyFallbackId: "LKWF1", // Lake Worth Pier (air/water temp, no waves)
    // Site names exactly as published by the FL Healthy Beaches feed (Broward).
    // Sebastian Street sits just north of Las Olas; Bahia Mar is just south.
    healthyBeaches: {
      county: "Broward",
      sites: ["SEBASTIAN STREET", "BAHIA MAR"],
    },
    surfZone: { office: "MFL", name: "Broward" }, // NWS Miami Surf Zone Forecast
    // Fire Rescue posts flags/conditions once a day as plain text, but a
    // plain fetch gets a 403 bot-block — Browser Rendering loads it fine, so
    // flagsFeedUrl (the uw-frame worker, same pattern as Deerfield) is what
    // lib/sources/cityOfficial.ts actually reads; cityConditionsUrl is kept
    // only as the human "see official page" link.
    cityConditionsUrl: "https://www.fortlauderdale.gov/Government/Departments/Fire-Rescue/Beach-Conditions",
    cityConditionsAttribution: "City of Fort Lauderdale Ocean Rescue",
    flagsFeedUrl: "https://uw-frame.entwined-app.workers.dev/flags?slug=fort-lauderdale",
    cams: [
      {
        // Elbo Room's public YouTube livestream "Fort Lauderdale Beach
        // LIVE: Surf, Wind & Golden Hour" — looks over the beach and ocean
        // at Las Olas Blvd & A1A. Owner approved for this use. Frames come
        // from the owner's Mac courier (scripts/cam_courier_local.sh),
        // same as Deerfield's cams — see workers/uw-frame/.
        id: "ftl-elbo-beach-cam",
        name: "Fort Lauderdale Beach Cam",
        provider: "Elbo Room",
        embedType: "image",
        url: "https://www.elboroom.com/beach-cam/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=ftl-elbo-beach-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=ftl-elbo-beach-cam",
        attribution: "Live stream courtesy Elbo Room (ElboRoom.com)",
        lat: 26.1195,
        lon: -80.1035,
      },
    ],
  },
];

/** Hand-curated entries first, then admin-added (generated) ones; deduped by slug. */
function allLocations(): Location[] {
  const seen = new Set(LOCATIONS.map((l) => l.slug));
  const added = GENERATED.filter((l) => l && l.slug && !seen.has(l.slug));
  return [...LOCATIONS, ...added];
}

export function listLocations(): Location[] {
  return allLocations();
}

export function getLocation(slug: string): Location | undefined {
  return allLocations().find((l) => l.slug === slug);
}

export function toPublicLocation(l: Location): LocationPublic {
  return {
    slug: l.slug,
    name: l.name,
    region: l.region,
    lat: l.lat,
    lon: l.lon,
    timezone: l.timezone,
    tier: l.tier,
  };
}
