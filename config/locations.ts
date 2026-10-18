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
    updatedAt: "2026-05-29",
    lat: 26.3587,
    lon: -80.0686,
    // North-to-south polyline along Boca's ~3-mile public beach stretch, so
    // "nearest beach" measures to the closest point on the sand rather than
    // to one pin near the middle. Coordinates are each park's OSM centroid,
    // geocoded via nominatim.openstreetmap.org 2026-09-23:
    //   Spanish River Park  26.3822, -80.0683
    //   Red Reef Park       26.3629, -80.0691
    //   South Beach Park    26.3535, -80.0699
    //   South Inlet Park    26.3347, -80.0730
    shore: [
      [26.3822, -80.0683],
      [26.3629, -80.0691],
      [26.3535, -80.0699],
      [26.3347, -80.073],
    ],
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
    ndbcBuoyId: "LKWF1", // Lake Worth Pier C-MAN (nearest — supplies water temp)
    // 41122 (Hillsboro/Dania nearshore Datawell, ~24 mi south) supplies OBSERVED
    // wave height + period: LKWF1 has no wave sensor (WVHT is "MM" 100% of ticks),
    // and the old FWYF1 fallback is a wave-less light station that is offline, so
    // Boca's wave height silently fell back to the Open-Meteo model, which reads
    // ~3x high nearshore (3.1 ft model vs 1.0 ft observed, 2026-09-18). The
    // field-by-field buoy merge keeps LKWF1's nearer water temp and fills waves
    // from 41122 — the same buoy neighboring Deerfield and Fort Lauderdale use.
    ndbcBuoyFallbackId: "41122", // Hillsboro/Dania nearshore buoy (observed waves)
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
    updatedAt: "2026-05-29",
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
    updatedAt: "2026-09-16",
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
  {
    slug: "fort-myers-beach",
    name: "Fort Myers Beach",
    region: "Lee County, FL",
    updatedAt: "2026-10-15",
    // Lynn Hall Memorial Park, by the Fort Myers Beach pier (Estero Island,
    // Gulf side). The resolver's own pick (a GNIS centroid) sits in the water
    // north of Bowditch Point, so this entry is hand-curated. The Gulf lies to
    // the southwest, so a clear evening sky is over the water: this is a WEST
    // coast beach (sunsets over the Gulf), unlike every other curated beach.
    lat: 26.4538,
    lon: -81.9571,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed
    // the shoreline normal (about 235 deg from the map), and its presence is
    // what switches on the orientation-dependent rip-current and "over the
    // water" copy. The owner can set both after a look at the map.
    noaaTideStationId: "8725366", // Matanzas Pass (fixed bridge), 0.3 mi (predictions)
    noaaTideStationFallbackId: "8725351", // Estero Island, Estero Bay
    // 8725366 is a subordinate PREDICTION station. The measured water level
    // comes from the Fort Myers gauge on the Caloosahatchee, ~14 mi north.
    noaaWaterLevelStationId: "8725520",
    ndbcBuoyId: "FMRF1", // Fort Myers C-MAN (water temp only, no waves)
    // No wave buoy on purpose: the nearest wave-reporting station (42098, Egmont
    // Channel) is ~99 mi north in Tampa Bay, and a buoy outranks the local wave
    // model (lib/score.ts), so it would set this beach's surf. The Gulf C-series
    // buoys off Fort Myers (42023/42013) and the coastal stations (NPSF1, VENF1)
    // report no wave height (checked 2026-10-15). Surf here is model-sourced and
    // labeled as such; no NWPS nearshore coverage either (config/nwpsRip.ts).
    noWaveStationReason:
      "No NDBC station within ~75 mi reports wave height (42023, 42013, NPSF1, VENF1 all MM, 2026-10-15); the nearest, 42098 Egmont Channel, is ~99 mi north in Tampa Bay. Surf is model-sourced and labeled.",
    // Site names exactly as published by the FL Healthy Beaches feed (Lee).
    healthyBeaches: {
      county: "Lee",
      sites: ["NEWTON PARK", "BOWDITCH PARK"],
    },
    surfZone: { office: "TBW", name: "Coastal Lee" }, // NWS Tampa Bay Surf Zone Forecast
    cams: [
      {
        // Visit Fort Myers (the Lee County Visitor & Convention Bureau) runs this
        // public YouTube livestream, "Fort Myers Beach Live Webcam", from the
        // Times Square block beside the pier. It looks over the beach and the
        // Gulf. Frames come from the owner's courier, as for Deerfield.
        id: "fort-myers-beach-cam",
        name: "Fort Myers Beach Cam",
        provider: "Visit Fort Myers",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=nj9jdOXXhEo",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=fort-myers-beach-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=fort-myers-beach-cam",
        attribution: "Live stream courtesy Visit Fort Myers (Lee County Visitor & Convention Bureau)",
        lat: 26.4533,
        lon: -81.9561,
      },
      {
        // Margaritaville Beach Resort Fort Myers Beach streams "License to Chill
        // Live Beach Cam" on its own YouTube channel, from the roof of the resort
        // on Crescent Street, looking west-south-west over the beach and the
        // Gulf. The owner's logo (top left) and an AccuWeather box (top right) are
        // burned into the frame. Added 2026-10-16 with credit and a link to the
        // resort's webcam page; it comes down the same day if the owner asks.
        id: "margaritaville-fmb-cam",
        name: "Fort Myers Beach — License to Chill",
        provider: "Margaritaville Beach Resort Fort Myers Beach",
        embedType: "image",
        url: "https://www.margaritavilleresorts.com/margaritaville-beach-resort-fort-myers-beach/webcam",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=margaritaville-fmb-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=margaritaville-fmb-cam",
        attribution: "Live stream courtesy Margaritaville Beach Resort Fort Myers Beach",
        lat: 26.4546,
        lon: -81.9539,
      },
      {
        // Pink Shell Beach Resort & Marina owns this view (its page,
        // pinkshell.com/live-webcams, is named in the stream description). The
        // stream we pull is the copy on the "Florida Live" YouTube channel, the only
        // live id found (2026-10-16). It looks west over the resort pool and beach.
        // Added with credit; it comes down the same day if the owner asks.
        id: "pink-shell-fmb-cam",
        name: "Fort Myers Beach — Pink Shell",
        provider: "Pink Shell Beach Resort & Marina",
        embedType: "image",
        url: "https://www.pinkshell.com/live-webcams/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=pink-shell-fmb-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=pink-shell-fmb-cam",
        attribution: "Live stream courtesy Pink Shell Beach Resort & Marina",
        lat: 26.4606,
        lon: -81.965,
      },
    ],
  },
  {
    slug: "pensacola-beach",
    name: "Pensacola Beach",
    region: "Escambia County, FL",
    updatedAt: "2026-10-15",
    // Casino Beach, beside the Pensacola Beach Gulf pier on Santa Rosa Island.
    // The Gulf is to the south and the island runs east-west, so a camera that
    // looks west along the sand sees the sun set over the water and the
    // spit. Time zone is Central.
    lat: 30.3303,
    lon: -87.1418,
    timezone: "America/Chicago",
    // coastNormalDeg and coast are left unset on purpose (about 180 deg from
    // the map, not reviewed); see the Fort Myers Beach entry.
    noaaTideStationId: "8729807", // Pensacola Beach Pier, 0.2 mi (predictions)
    noaaTideStationFallbackId: "8729840", // Pensacola
    // 8729807 publishes no observations. The measured water level comes from the
    // Pensacola gauge on the bay, ~6.6 mi north.
    noaaWaterLevelStationId: "8729840",
    ndbcBuoyId: "PCLF1", // Pensacola C-MAN (water temp only, no waves)
    ndbcBuoyFallbackId: "42012", // Orange Beach (waves, ~31 mi west)
    // Site names exactly as published by the FL Healthy Beaches feed (Escambia).
    healthyBeaches: {
      county: "Escambia",
      sites: ["CASINO BEACH", "PARK WEST - GULFSIDE"],
    },
    surfZone: { office: "MOB", name: "Escambia Coastal" }, // NWS Mobile Surf Zone Forecast
    cams: [
      {
        // Santa Rosa Island Authority (the public body that runs Pensacola Beach)
        // streams "SRIA - West Cam" on its own YouTube channel: a wide-angle view
        // west along Casino Beach. Its "East Cam" faces the other way and is not
        // used. Frames come from the owner's courier, as for Deerfield.
        id: "pensacola-sria-west-cam",
        name: "Pensacola Beach — West Cam",
        provider: "Santa Rosa Island Authority",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=HKIc6CYlMzI",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=pensacola-sria-west-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=pensacola-sria-west-cam",
        attribution: "Live stream courtesy Santa Rosa Island Authority",
        lat: 30.33,
        lon: -87.1424,
      },
    ],
  },
  // --- Gulf coast and Keys cams, added 2026-10-16 (owner decision: add every
  // usable Florida cam now, with the owner credited and linked; if an owner
  // objects, the cam comes down the same day). Research and owner contacts:
  // docs/research/2026-10-15-west-facing-cams.md and
  // docs/research/2026-10-16-cam-owner-contacts.md. Each beach below was run
  // through lib/resolve (nearest tide stations, NDBC stations, NWS surf zone).
  // coastNormalDeg and coast stay unset, as for Fort Myers Beach.
  {
    slug: "siesta-key",
    name: "Siesta Key",
    region: "Sarasota County, FL",
    updatedAt: "2026-10-16",
    // Siesta Beach (Siesta Key Public Beach). The beach faces west over the Gulf,
    // so the sun sets over the water. The pin is the beach registry's own point.
    lat: 27.2648,
    lon: -82.5507,
    timezone: "America/New_York",
    noaaTideStationId: "8726034", // Siesta Key, Big Sarasota Pass, 1.5 mi (predictions)
    noaaTideStationFallbackId: "8726083", // Sarasota, Sarasota Bay
    // No measured water level: the nearest real gauge (St. Petersburg) is ~34 mi
    // north, too far to say anything about this beach.
    ndbcBuoyId: "42098", // Egmont Channel Entrance (waves + water temp, ~32 mi north)
    // The Venice C-MAN (VENF1, 15 mi) reports no water temperature or waves
    // (2026-10-16), so the wave buoy is the only usable station.
    // Site name exactly as published by the FL Healthy Beaches feed (Sarasota).
    healthyBeaches: {
      county: "Sarasota",
      sites: ["SIESTA KEY BEACH"],
    },
    surfZone: { office: "TBW", name: "Coastal Sarasota" }, // NWS Tampa Bay Surf Zone Forecast
    cams: [
      {
        // "Siesta Beach Live", a public 24/7 YouTube stream from the beach. Visit
        // Sarasota County, the county's tourism body, promotes it and its page
        // links this exact video; other pages credit it as "Sarasota County
        // Webcam". Both names are credited. A high view west over the flat sand,
        // dunes and palmettos. Frames come from the owner's courier, as for
        // Deerfield.
        id: "siesta-beach-cam",
        name: "Siesta Beach Live",
        provider: "Sarasota County / Visit Sarasota County",
        embedType: "image",
        url: "https://www.visitsarasota.com/siesta-key-beach-cam",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=siesta-beach-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=siesta-beach-cam",
        attribution: "Live stream courtesy Sarasota County and Visit Sarasota County",
        lat: 27.2654,
        lon: -82.5528,
      },
    ],
  },
  {
    slug: "anna-maria-island",
    name: "Anna Maria Island",
    region: "Manatee County, FL",
    updatedAt: "2026-10-16",
    // Manatee Public Beach, Holmes Beach, mid-island. The island is about seven
    // miles long and faces the Gulf to the west. Both cams are in Holmes Beach,
    // within a mile of this pin, so Holmes Beach is a second cam here and not
    // its own beach.
    lat: 27.4998,
    lon: -82.714,
    timezone: "America/New_York",
    noaaTideStationId: "8726243", // Anna Maria Key, Bradenton Beach, 0.2 mi (predictions)
    noaaTideStationFallbackId: "8726282", // Anna Maria Key, city pier
    // Neither Anna Maria station publishes observations. The measured water level
    // comes from the St. Petersburg gauge, ~19 mi north.
    noaaWaterLevelStationId: "8726520",
    // Egmont Channel Entrance (waves + water temp, ~15 mi north). The resolver's
    // own pick, Port Manatee (PMAF1), sits inside Tampa Bay and reads bay water.
    ndbcBuoyId: "42098",
    // Site name exactly as published by the FL Healthy Beaches feed (Manatee).
    healthyBeaches: {
      county: "Manatee",
      sites: ["MANATEE PUBLIC BEACH NORTH"],
    },
    surfZone: { office: "TBW", name: "Coastal Manatee" }, // NWS Tampa Bay Surf Zone Forecast
    cams: [
      {
        // White Sands Beach Resort, 6504 Gulf Drive, streams its beach camera on its
        // own YouTube channel (WHITESANDSFLORIDA). A fisheye view along the sand
        // and the Gulf, south-west to west. The resort's name and a clock are
        // burned into the frame. Its second stream has no DVR and is not used.
        id: "white-sands-ami-cam",
        name: "Anna Maria Island — White Sands",
        provider: "White Sands Beach Resort",
        embedType: "image",
        url: "https://www.whitesandsbeachresort.com/beachcams-white-sands-anna-maria-island",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=white-sands-ami-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=white-sands-ami-cam",
        attribution: "Live stream courtesy White Sands Beach Resort",
        lat: 27.5117,
        lon: -82.722,
      },
      {
        // "Anna Maria Island - Holmes Beach, FL" on the "Beach Live Cams" YouTube
        // channel. REAL OWNER UNKNOWN: the channel is credited for now. The frame
        // shows loungers and a "Cedar Cove Resort Weather Station" sign on the sand,
        // so the camera may belong to Cedar Cove Resort in Holmes Beach; nobody
        // has confirmed that, and the credit and link should change once the owner
        // is known. The cam's own position is also unknown: lat/lon below is this
        // beach's pin.
        id: "holmes-beach-cam",
        name: "Holmes Beach",
        provider: "Beach Live Cams",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=_W0Gf1Le2qc",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=holmes-beach-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=holmes-beach-cam",
        attribution: "Live stream courtesy Beach Live Cams (YouTube channel)",
        lat: 27.4998,
        lon: -82.714,
      },
    ],
  },
  {
    slug: "panama-city-beach",
    name: "Panama City Beach",
    region: "Bay County, FL",
    updatedAt: "2026-10-16",
    // The Gulf beach in front of Laketown Wharf on South Thomas Drive, the middle
    // of the long Panama City Beach shoreline. Two of the three cams are within
    // half a mile; Sharky's is about four miles north-west on Front Beach Road.
    // The beach faces south here, so the sun sets along the sand, not out to sea.
    // Bay County is on Central time.
    lat: 30.1745,
    lon: -85.804,
    timezone: "America/Chicago",
    noaaTideStationId: "8729210", // Panama City Beach (Gulf pier gauge), 5 mi north-west
    noaaTideStationFallbackId: "8729108", // Panama City (St. Andrew Bay entrance)
    // 8729210 is a real gauge, so the measured water level comes from it too.
    noaaWaterLevelStationId: "8729210",
    ndbcBuoyId: "PCBF1", // Panama City Beach C-MAN (water temp only, no waves)
    // No wave buoy on purpose, as for Fort Myers Beach: the nearest wave-reporting
    // station (42039, deep Gulf) is ~98 mi south, and a buoy that far offshore
    // would set this beach's surf. The nearshore stations (42028, 42027, PACF1,
    // PCBF1) report no wave height. Surf is model-sourced and labeled as such.
    noWaveStationReason:
      "No NDBC station within ~95 mi reports wave height (PCBF1, PACF1, 42028 and 42027 are water-temperature stations, 2026-10-16); the nearest, 42039, is ~98 mi south in the deep Gulf. Surf is model-sourced and labeled.",
    // Site names exactly as published by the FL Healthy Beaches feed (Bay). Both
    // are at the north-west end of the beach, the nearest listed Gulf sites.
    healthyBeaches: {
      county: "Bay",
      sites: ["PCB CITY PIER", "BID-A-WEE BEACH"],
    },
    surfZone: { office: "TAE", name: "Coastal Bay" }, // NWS Tallahassee Surf Zone Forecast
    cams: [
      {
        // ENCO Electronic Systems (an engineering firm that runs beach cams for
        // resorts) streams "Sterling Reef Panama City Beach, FL" on its own
        // YouTube channel. A wide view west-south-west along the sand to the
        // Gulf pier. Added with credit; it comes down the same day if the owner
        // asks.
        id: "enco-sterling-reef-cam",
        name: "Panama City Beach — Sterling Reef",
        provider: "ENCO Electronic Systems",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=Y82E6_IVEdY",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=enco-sterling-reef-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=enco-sterling-reef-cam",
        attribution: "Live stream courtesy ENCO Electronic Systems",
        lat: 30.1712,
        lon: -85.7977,
      },
      {
        // ENCO's second Panama City Beach stream, "Shores of Panama". A beach
        // walkway with people in the foreground and the Gulf beyond it.
        id: "enco-shores-of-panama-cam",
        name: "Panama City Beach — Shores of Panama",
        provider: "ENCO Electronic Systems",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=GFsRPlw81W8",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=enco-shores-of-panama-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=enco-shores-of-panama-cam",
        attribution: "Live stream courtesy ENCO Electronic Systems",
        lat: 30.1755,
        lon: -85.8038,
      },
      {
        // Sharky's Beachfront Restaurant, 15201 Front Beach Road. Its own cam page
        // embeds two YouTube ids (VFqCaZhD3j4, Vonsne1kp4A); both answered "live
        // stream recording is not available" on 2026-10-16, so this is the copy
        // on the "Florida Live" channel, the only live id found. A deck with
        // diners in the foreground and the beach and Gulf behind; a thatch roof
        // takes the right edge. Swap in Sharky's own ids when they stream again.
        id: "sharkys-pcb-cam",
        name: "Panama City Beach — Sharky's",
        provider: "Sharky's Beachfront Restaurant",
        embedType: "image",
        url: "https://sharkysbeach.com/panama-city-beach-webcam-at-sharkys-beachfront-restaurant/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=sharkys-pcb-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=sharkys-pcb-cam",
        attribution: "Live stream courtesy Sharky's Beachfront Restaurant",
        lat: 30.2084,
        lon: -85.8636,
      },
    ],
  },
  {
    slug: "key-west",
    name: "Key West",
    region: "Monroe County, FL",
    updatedAt: "2026-10-16",
    // Fort Zachary Taylor Historic State Park beach, at the south-west tip of
    // Key West. Its water faces south-west, so the sun sets in view. Higgs and
    // Smathers beaches are on the other side of the island.
    lat: 24.5462,
    lon: -81.8104,
    timezone: "America/New_York",
    noaaTideStationId: "8724580", // Key West (real gauge), 0.7 mi (predictions + observations)
    noaaTideStationFallbackId: "8724557", // Key West, south side, White Street Pier
    noaaWaterLevelStationId: "8724580",
    ndbcBuoyId: "KYWF1", // Key West C-MAN (water temp only, no waves)
    ndbcBuoyFallbackId: "42095", // Satan Shoal (waves, ~14 mi south-west)
    // Site name exactly as published by the FL Healthy Beaches feed (Monroe).
    healthyBeaches: {
      county: "Monroe",
      sites: ["FT ZACHARY TAYLOR STATE PARK"],
    },
    // No surfZone: NWS Key West (KEY) issues no Surf Zone Forecast product
    // (checked 2026-10-16), so the rip-risk card has nothing to read here.
    cams: [
      {
        // Fort Zachary Taylor beach ("Beach Tiki - Beach View 2" is burned into the
        // frame), shared on the "Florida Live" YouTube channel. REAL OWNER NOT
        // CONFIRMED: the park's own site shows a beach cam too, but nobody has
        // shown it is this feed. Until then the credit names the beach and the
        // channel. The sky is only the top strip of the frame. The cam's own
        // position is not surveyed: lat/lon below is the beach pin.
        id: "fort-zachary-taylor-cam",
        name: "Key West — Fort Zachary Taylor",
        provider: "Florida Live",
        embedType: "image",
        url: "https://www.youtube.com/watch?v=sDXwrYQPeOQ",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=fort-zachary-taylor-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=fort-zachary-taylor-cam",
        attribution: "Live stream of Fort Zachary Taylor Beach, shared by Florida Live (YouTube channel)",
        lat: 24.5462,
        lon: -81.8104,
      },
    ],
  },
  {
    slug: "marathon",
    name: "Marathon",
    region: "Monroe County, FL",
    updatedAt: "2026-10-16",
    // The Gulf (Florida Bay) side of Marathon at Sunset Grille, Knights Key,
    // beside the old Seven Mile Bridge, where the sun sets in view. The Atlantic
    // beach (Sombrero Beach) is a separate branch's work (cams-atlantic) and is
    // not part of this entry.
    lat: 24.7065,
    lon: -81.1239,
    timezone: "America/New_York",
    noaaTideStationId: "8723970", // Vaca Key, Florida Bay (real gauge), ~1 mi (predictions + observations)
    noaaTideStationFallbackId: "8724008", // Knight Key Channel, Florida Bay
    noaaWaterLevelStationId: "8723970",
    ndbcBuoyId: "VCAF1", // Vaca Key C-MAN (water temp only, no waves)
    // Satan Shoal is the nearest wave station (~60 mi, off the Atlantic side), so
    // a wave read here is a far-off one.
    ndbcBuoyFallbackId: "42095",
    // No healthyBeaches: the Healthy Beaches sites in Marathon (Sombrero Beach) are
    // on the Atlantic side; none is at this bayside spot.
    // No surfZone: NWS Key West (KEY) issues no Surf Zone Forecast product.
    cams: [
      {
        // Sunset Grille & Raw Bar, 7 Knights Key Blvd, hosts this camera; Overseas
        // Media Group (its "Seek Florida Keys" brand) runs the cam and asks for
        // permission by email. A pool deck, palms and the old Seven Mile Bridge,
        // looking west across the water. The "omg" mark and the restaurant logo are
        // burned in. Added with credit; it comes down the same day if the owner asks.
        id: "sunset-grille-marathon-cam",
        name: "Marathon — Sunset Grille",
        provider: "Sunset Grille & Raw Bar / Seek Florida Keys",
        embedType: "image",
        url: "https://overseasmediagroup.com/webcams/sunset-grille-marathon/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=sunset-grille-marathon-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=sunset-grille-marathon-cam",
        attribution: "Live stream courtesy Sunset Grille & Raw Bar and Seek Florida Keys (Overseas Media Group)",
        lat: 24.7065,
        lon: -81.1239,
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
    shore: l.shore,
  };
}
