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
  // --- Atlantic coast beach cams (2026-10-17, branch cams-atlantic). Append-only block: keep new Atlantic beaches here. ---
  {
    slug: "jacksonville-beach",
    name: "Jacksonville Beach",
    region: "Duval County, FL",
    updatedAt: "2026-10-17",
    // Jacksonville Beach Pier. This hand-curated entry replaces the auto-resolved one in locations.generated.json, whose pin sat near Mayport, about 6.6 mi north of the pier.
    lat: 30.2934,
    lon: -81.389,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8720291", // Jacksonville Beach, 0.7 mi
    noaaTideStationFallbackId: "8720218", // MAYPORT (BAR PILOT DOCK), 7.6 mi
    // The primary station is a subordinate PREDICTION station or sits on a lagoon, so the measured water level
    // comes from the MAYPORT (BAR PILOT DOCK) gauge, 8 mi away.
    noaaWaterLevelStationId: "8720218",
    ndbcBuoyId: "LTJF1", // Little Talbot Island (water temp, no waves)
    ndbcBuoyFallbackId: "41117", // St. Augustine nearshore wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Duval).
    healthyBeaches: {
      county: "Duval",
      sites: ["BEACH BLVD ACCESS", "HOPKINS ST ACCESS"],
    },
    surfZone: { office: "JAX", name: "Nassau-Duval-Flagler-St. Johns" }, // NWS surf zone forecast block
    cams: [
      {
        // Best Western Oceanfront Jacksonville Beach / 911 Surf Report runs this public YouTube livestream (Jacksonville Beach Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "jax-beach-bw-cam",
        name: "Jacksonville Beach Cam",
        provider: "Best Western Oceanfront Jacksonville Beach / 911 Surf Report",
        embedType: "image",
        url: "https://911surfreport.com/live-beach-cams/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=jax-beach-bw-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=jax-beach-bw-cam",
        attribution: "Live stream courtesy Best Western Oceanfront Jacksonville Beach and 911 Surf Report",
        lat: 30.2934,
        lon: -81.389,
      },
      {
        // The Jacksonville Beach Pier / Beach Life Rentals / 911 Surf Report runs this public YouTube livestream (Jacksonville Beach Pier — Overview). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "jax-pier-overview-cam",
        name: "Jacksonville Beach Pier — Overview",
        provider: "The Jacksonville Beach Pier / Beach Life Rentals / 911 Surf Report",
        embedType: "image",
        url: "https://jaxpiercam.com",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=jax-pier-overview-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=jax-pier-overview-cam",
        attribution: "Live stream courtesy The Jacksonville Beach Pier, Beach Life Rentals and 911 Surf Report",
      },
    ],
  },
  {
    slug: "st-augustine-beach",
    name: "St. Augustine Beach",
    region: "St. Johns County, FL",
    updatedAt: "2026-10-17",
    // St. Augustine Beach Pier.
    lat: 29.8571,
    lon: -81.2659,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8720587", // St. Augustine Beach, 0.2 mi
    noaaTideStationFallbackId: "8720576", // St. Augustine, city dock, 3.6 mi
    ndbcBuoyId: "SAUF1", // St. Augustine pier (water temp, no waves)
    ndbcBuoyFallbackId: "41117", // St. Augustine nearshore wave buoy
    // No healthyBeaches: the FL Healthy Beaches feed returns no records for St. Johns County (checked 2026-10-17).
    surfZone: { office: "JAX", name: "Nassau-Duval-Flagler-St. Johns" }, // NWS surf zone forecast block
    cams: [
      {
        // The Surf Station runs this public YouTube livestream (St. Augustine Beach Pier Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "st-augustine-pier-cam",
        name: "St. Augustine Beach Pier Cam",
        provider: "The Surf Station",
        embedType: "image",
        url: "https://www.surf-station.com/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=st-augustine-pier-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=st-augustine-pier-cam",
        attribution: "Live stream courtesy The Surf Station (surf-station.com)",
      },
      {
        // The Surf Station runs this public YouTube livestream (St. Augustine Beach Surf Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "st-augustine-surf-cam",
        name: "St. Augustine Beach Surf Cam",
        provider: "The Surf Station",
        embedType: "image",
        url: "https://www.surf-station.com/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=st-augustine-surf-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=st-augustine-surf-cam",
        attribution: "Live stream courtesy The Surf Station (surf-station.com)",
      },
    ],
  },
  {
    slug: "vilano-beach",
    name: "Vilano Beach",
    region: "St. Johns County, FL",
    updatedAt: "2026-10-17",
    // Vilano Beach. The Surf Station cam looks over the dunes of North Vilano toward South Ponte Vedra, a few miles north of this pin; its exact spot is unconfirmed, so the cam carries no coordinates of its own.
    lat: 29.9184,
    lon: -81.2907,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8720587", // St. Augustine Beach, 4.6 mi
    noaaTideStationFallbackId: "8720554", // Vilano Beach, Tolomato River, 0.6 mi
    ndbcBuoyId: "SAUF1", // St. Augustine pier (water temp, no waves)
    ndbcBuoyFallbackId: "41117", // St. Augustine nearshore wave buoy
    // No healthyBeaches: the FL Healthy Beaches feed returns no records for St. Johns County (checked 2026-10-17).
    surfZone: { office: "JAX", name: "Nassau-Duval-Flagler-St. Johns" }, // NWS surf zone forecast block
    cams: [
      {
        // The Surf Station runs this public YouTube livestream (North Vilano — South Ponte Vedra Surf Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        // No DVR on this stream, so it cannot feed the sun-cam check.
        id: "vilano-surf-station-cam",
        name: "North Vilano — South Ponte Vedra Surf Cam",
        provider: "The Surf Station",
        embedType: "image",
        url: "https://www.surf-station.com/",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=vilano-surf-station-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=vilano-surf-station-cam",
        attribution: "Live stream courtesy The Surf Station (surf-station.com)",
      },
    ],
  },
  {
    slug: "ormond-beach",
    name: "Ormond Beach",
    region: "Volusia County, FL",
    updatedAt: "2026-10-17",
    // Ormond-by-the-Sea (Bicentennial Park), at the north end of Ormond Beach, where Volusia County's lifeguard-tower cam stands. The city of Ormond Beach is about 3.5 mi south.
    lat: 29.338,
    lon: -81.0612,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8720954", // Ormond Beach, Halifax River, 3.7 mi
    noaaTideStationFallbackId: "8721120", // Daytona Beach Shores, Sunglow Pier, 14.5 mi
    ndbcBuoyId: "41069", // Ponce de Leon Inlet C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41070", // Ponce de Leon Inlet wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Volusia).
    healthyBeaches: {
      county: "Volusia",
      sites: ["BICENTENNIAL PARK"],
    },
    surfZone: { office: "MLB", name: "Coastal Volusia-Mainland Northern Brevard" }, // NWS surf zone forecast block
    cams: [
      {
        // Volusia County Beach Safety runs this public YouTube livestream (Ormond Beach Cam 180). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "ormond-cam-180",
        name: "Ormond Beach Cam 180",
        provider: "Volusia County Beach Safety",
        embedType: "image",
        url: "https://www.volusia.org/services/public-protection/beach-safety/beachcams-and-daily-safety-report.stml",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=ormond-cam-180",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=ormond-cam-180",
        attribution: "Live stream courtesy Volusia County Beach Safety",
      },
    ],
  },
  {
    slug: "dunlawton-beach",
    name: "Dunlawton Beach",
    region: "Volusia County, FL",
    updatedAt: "2026-10-17",
    // Dunlawton Beach, Port Orange and Daytona Beach Shores, between Daytona Beach and Ponce Inlet.
    lat: 29.1513,
    lon: -80.9686,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8721120", // Daytona Beach Shores, Sunglow Pier, 0.5 mi
    noaaTideStationFallbackId: "8721147", // Ponce de Leon Inlet, 6.9 mi
    ndbcBuoyId: "41069", // Ponce de Leon Inlet C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41070", // Ponce de Leon Inlet wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Volusia).
    healthyBeaches: {
      county: "Volusia",
      sites: ["DUNLAWTON"],
    },
    surfZone: { office: "MLB", name: "Coastal Volusia-Mainland Northern Brevard" }, // NWS surf zone forecast block
    cams: [
      {
        // Volusia County Beach Safety runs this public YouTube livestream (Dunlawton Beach Cam 180). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "dunlawton-cam-180",
        name: "Dunlawton Beach Cam 180",
        provider: "Volusia County Beach Safety",
        embedType: "image",
        url: "https://www.volusia.org/services/public-protection/beach-safety/beachcams-and-daily-safety-report.stml",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=dunlawton-cam-180",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=dunlawton-cam-180",
        attribution: "Live stream courtesy Volusia County Beach Safety",
      },
    ],
  },
  {
    slug: "new-smyrna-beach",
    name: "New Smyrna Beach",
    region: "Volusia County, FL",
    updatedAt: "2026-10-17",
    // Flagler Avenue beach approach, New Smyrna Beach.
    lat: 29.0383,
    lon: -80.8955,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8721164", // New Smyrna Beach, 1.7 mi
    noaaTideStationFallbackId: "8721147", // Ponce de Leon Inlet, 2.1 mi
    ndbcBuoyId: "41069", // Ponce de Leon Inlet C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41070", // Ponce de Leon Inlet wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Volusia).
    healthyBeaches: {
      county: "Volusia",
      sites: ["FLAGLER AVE"],
    },
    surfZone: { office: "MLB", name: "Coastal Volusia-Mainland Northern Brevard" }, // NWS surf zone forecast block
    cams: [
      {
        // Volusia County Beach Safety runs this public YouTube livestream (New Smyrna Beach Cam 180). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        // No DVR on this stream, so it cannot feed the sun-cam check.
        id: "new-smyrna-cam-180",
        name: "New Smyrna Beach Cam 180",
        provider: "Volusia County Beach Safety",
        embedType: "image",
        url: "https://www.volusia.org/services/public-protection/beach-safety/beachcams-and-daily-safety-report.stml",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=new-smyrna-cam-180",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=new-smyrna-cam-180",
        attribution: "Live stream courtesy Volusia County Beach Safety",
      },
    ],
  },
  {
    slug: "ponce-inlet",
    name: "Ponce Inlet",
    region: "Volusia County, FL",
    updatedAt: "2026-10-17",
    // Lighthouse Point Park beach, Ponce Inlet (south end of the Volusia beaches). The cam's exact spot on the Ponce Inlet beach is unconfirmed, so it carries no coordinates of its own.
    lat: 29.0789,
    lon: -80.9198,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8721147", // Ponce de Leon Inlet, 1.1 mi
    noaaTideStationFallbackId: "8721164", // New Smyrna Beach, 3.8 mi
    ndbcBuoyId: "41069", // Ponce de Leon Inlet C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41070", // Ponce de Leon Inlet wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Volusia).
    healthyBeaches: {
      county: "Volusia",
      sites: ["LIGHTHOUSE POINT PARK"],
    },
    surfZone: { office: "MLB", name: "Coastal Volusia-Mainland Northern Brevard" }, // NWS surf zone forecast block
    cams: [
      {
        // Volusia County Beach Safety runs this public YouTube livestream (Ponce Inlet Beach Cam 180). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        // No DVR on this stream, so it cannot feed the sun-cam check.
        id: "ponce-inlet-cam-180",
        name: "Ponce Inlet Beach Cam 180",
        provider: "Volusia County Beach Safety",
        embedType: "image",
        url: "https://www.volusia.org/services/public-protection/beach-safety/beachcams-and-daily-safety-report.stml",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=ponce-inlet-cam-180",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=ponce-inlet-cam-180",
        attribution: "Live stream courtesy Volusia County Beach Safety",
      },
    ],
  },
  {
    slug: "hollywood-beach",
    name: "Hollywood Beach",
    region: "Broward County, FL",
    updatedAt: "2026-10-17",
    // The Broadwalk at Johnson Street, Hollywood Beach.
    lat: 26.016,
    lon: -80.1153,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722979", // Hollywood Beach, 1.7 mi
    noaaTideStationFallbackId: "8722956", // South Port Everglades, ICWW, 4.5 mi
    // The primary station is a subordinate PREDICTION station or sits on a lagoon, so the measured water level
    // comes from the South Port Everglades, ICWW gauge, 5 mi away.
    noaaWaterLevelStationId: "8722956",
    ndbcBuoyId: "41122", // Hollywood Beach Waverider (waves + water temp)
    // Site names exactly as published by the FL Healthy Beaches feed (Broward).
    healthyBeaches: {
      county: "Broward",
      sites: ["HARRISON STREET", "MINNESOTA STREET"],
    },
    surfZone: { office: "MFL", name: "Coastal Broward" }, // NWS surf zone forecast block
    cams: [
      {
        // City of Hollywood runs this public YouTube livestream (Hollywood Beach Broadwalk Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "hollywood-broadwalk-cam",
        name: "Hollywood Beach Broadwalk Cam",
        provider: "City of Hollywood",
        embedType: "image",
        url: "https://www.hollywoodfl.org/1047/Hollywood-Beach-Webcams",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=hollywood-broadwalk-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=hollywood-broadwalk-cam",
        attribution: "Live stream courtesy City of Hollywood",
      },
    ],
  },
  {
    slug: "dania-beach",
    name: "Dania Beach",
    region: "Broward County, FL",
    updatedAt: "2026-10-17",
    // Dania Beach Pier.
    lat: 26.058,
    lon: -80.1119,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722979", // Hollywood Beach, 1.3 mi
    noaaTideStationFallbackId: "8722956", // South Port Everglades, ICWW, 1.7 mi
    // The primary station is a subordinate PREDICTION station or sits on a lagoon, so the measured water level
    // comes from the South Port Everglades, ICWW gauge, 2 mi away.
    noaaWaterLevelStationId: "8722956",
    ndbcBuoyId: "41122", // Hollywood Beach Waverider (waves + water temp)
    // Site names exactly as published by the FL Healthy Beaches feed (Broward).
    healthyBeaches: {
      county: "Broward",
      sites: ["DANIA BEACH", "CUSTER ST BEACH"],
    },
    surfZone: { office: "MFL", name: "Coastal Broward" }, // NWS surf zone forecast block
    cams: [
      {
        // City of Dania Beach runs this public YouTube livestream (Dania Beach Pier Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        // No DVR on this stream, so it cannot feed the sun-cam check.
        id: "dania-pier-cam",
        name: "Dania Beach Pier Cam",
        provider: "City of Dania Beach",
        embedType: "image",
        url: "https://www.daniabeachfl.gov/piercam",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=dania-pier-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=dania-pier-cam",
        attribution: "Live stream courtesy City of Dania Beach",
      },
    ],
  },
  {
    slug: "singer-island",
    name: "Singer Island",
    region: "Palm Beach County, FL",
    updatedAt: "2026-10-17",
    // Singer Island and Palm Beach Shores, just north of Lake Worth Inlet (Riviera Beach municipal beach).
    lat: 26.7823,
    lon: -80.0318,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722588", // Port of Palm Beach, 1.5 mi
    noaaTideStationFallbackId: "8722670", // Lake Worth Pier (ocean), 11.7 mi
    // The primary station is a subordinate PREDICTION station or sits on a lagoon, so the measured water level
    // comes from the Lake Worth Pier (ocean) gauge, 12 mi away.
    noaaWaterLevelStationId: "8722670",
    ndbcBuoyId: "LKWF1", // Lake Worth Pier C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41122", // Hollywood Beach Waverider (waves + water temp)
    // Site names exactly as published by the FL Healthy Beaches feed (Palm Beach).
    healthyBeaches: {
      county: "Palm Beach",
      sites: ["RIVIERA MUNICIPAL BEACH", "OCEAN REEF PARK"],
    },
    surfZone: { office: "MFL", name: "Coastal Palm Beach" }, // NWS surf zone forecast block
    cams: [
      {
        // Palm Beach County ERM / video-monitoring.com: still read from the lakeworthinlet feed, view s6, the same way as the Boca Raton cams.
        id: "lake-worth-inlet-surf",
        name: "Lake Worth Inlet — Surf & Beach",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/lakeworthinlet/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/lakeworthinlet",
          view: "s6",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
      },
      {
        // Palm Beach County ERM / video-monitoring.com: still read from the lakeworthinlet feed, view s4, the same way as the Boca Raton cams.
        id: "lake-worth-inlet-beach",
        name: "Lake Worth Inlet — Beach",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/lakeworthinlet/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/lakeworthinlet",
          view: "s4",
        },
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
      },
    ],
  },
  {
    slug: "jupiter",
    name: "Jupiter",
    region: "Palm Beach County, FL",
    updatedAt: "2026-10-17",
    // Jupiter Beach Park, just south of Jupiter Inlet.
    lat: 26.9401,
    lon: -80.0715,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722495", // Jupiter Inlet, south jetty, 0.2 mi
    noaaTideStationFallbackId: "8722670", // Lake Worth Pier (ocean), 22.7 mi
    // The primary station is a subordinate PREDICTION station or sits on a lagoon, so the measured water level
    // comes from the Lake Worth Pier (ocean) gauge, 23 mi away.
    noaaWaterLevelStationId: "8722670",
    ndbcBuoyId: "LKWF1", // Lake Worth Pier C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41114", // Fort Pierce wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Palm Beach).
    healthyBeaches: {
      county: "Palm Beach",
      sites: ["JUPITER BEACH PARK", "DUBOIS PARK"],
    },
    surfZone: { office: "MFL", name: "Coastal Palm Beach" }, // NWS surf zone forecast block
    cams: [
      {
        // Jupiter Inlet District / video-monitoring.com: still read from the jupiter feed, view s2, the same way as the Boca Raton cams.
        id: "jupiter-inlet-beach",
        name: "Jupiter Inlet — Beach",
        provider: "Jupiter Inlet District / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/jupiter/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/jupiter",
          view: "s2",
        },
        attribution: "Live still courtesy Jupiter Inlet District / video-monitoring.com",
      },
      {
        // Jupiter Inlet District / video-monitoring.com: still read from the jupiter feed, view s33, the same way as the Boca Raton cams.
        id: "jupiter-inlet-surf",
        name: "Jupiter Inlet — Shoreline & Surf",
        provider: "Jupiter Inlet District / video-monitoring.com",
        embedType: "image",
        url: "https://video-monitoring.com/beachcams/jupiter/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/jupiter",
          view: "s33",
        },
        attribution: "Live still courtesy Jupiter Inlet District / video-monitoring.com",
      },
      {
        // Jupiter Reef Club runs this public YouTube livestream (Jupiter Reef Club Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        // No DVR on this stream, so it cannot feed the sun-cam check. The resort's own site is gone; the Town of Jupiter page lists the cam.
        id: "jupiter-reef-club-cam",
        name: "Jupiter Reef Club Cam",
        provider: "Jupiter Reef Club",
        embedType: "image",
        url: "https://www.jupiter.fl.us/2096/Jup-Life-Live-Cams",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=jupiter-reef-club-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=jupiter-reef-club-cam",
        attribution: "Live stream courtesy Jupiter Reef Club",
      },
    ],
  },
  {
    slug: "jensen-beach",
    name: "Jensen Beach",
    region: "Martin County, FL",
    updatedAt: "2026-10-17",
    // Jensen Public Beach, Hutchinson Island (Martin County).
    lat: 27.2556,
    lon: -80.1969,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722366", // Seminole Shores, 5.5 mi
    noaaTideStationFallbackId: "8722329", // Jensen Beach Causeway Park, 1.3 mi
    ndbcBuoyId: "41068", // Cape Canaveral C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41114", // Fort Pierce wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Martin).
    healthyBeaches: {
      county: "Martin",
      sites: ["JENSEN PUBLIC BEACH", "BOB GRAHAM BEACH"],
    },
    surfZone: { office: "MLB", name: "Coastal Saint Lucie-Coastal Martin" }, // NWS surf zone forecast block
    cams: [
      {
        // Martin County / video-monitoring.com: still read from the jensen feed, view s1, the same way as the Boca Raton cams.
        id: "jensen-beach-cam",
        name: "Jensen Beach Cam",
        provider: "Martin County / video-monitoring.com",
        embedType: "image",
        url: "https://discovermartin.com/live-webcams/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/jensen",
          view: "s1",
        },
        attribution: "Live still courtesy Martin County / video-monitoring.com",
      },
      {
        // Martin County / video-monitoring.com: still read from the jensen feed, view s3, the same way as the Boca Raton cams.
        id: "jensen-beach-surf",
        name: "Jensen Beach — Shoreline & Surf",
        provider: "Martin County / video-monitoring.com",
        embedType: "image",
        url: "https://discovermartin.com/live-webcams/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/jensen",
          view: "s3",
        },
        attribution: "Live still courtesy Martin County / video-monitoring.com",
      },
    ],
  },
  {
    slug: "stuart-bathtub-beach",
    name: "Bathtub Beach",
    region: "Martin County, FL",
    updatedAt: "2026-10-17",
    // Bathtub Reef Park beach, Hutchinson Island (Stuart). The named reef pool sits close to the shore.
    lat: 27.1932,
    lon: -80.1628,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722366", // Seminole Shores, 0.7 mi
    noaaTideStationFallbackId: "8722375", // South Point, St. Lucie Inlet, 2.4 mi
    ndbcBuoyId: "41068", // Cape Canaveral C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41114", // Fort Pierce wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Martin).
    healthyBeaches: {
      county: "Martin",
      sites: ["BATHTUB PUBLIC BEACH"],
    },
    surfZone: { office: "MLB", name: "Coastal Saint Lucie-Coastal Martin" }, // NWS surf zone forecast block
    cams: [
      {
        // Martin County / video-monitoring.com: still read from the bathtub feed, view s9, the same way as the Boca Raton cams.
        id: "bathtub-beach-cam",
        name: "Bathtub Beach Cam",
        provider: "Martin County / video-monitoring.com",
        embedType: "image",
        url: "https://discovermartin.com/live-webcams/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/bathtub",
          view: "s9",
        },
        attribution: "Live still courtesy Martin County / video-monitoring.com",
      },
      {
        // Martin County / video-monitoring.com: still read from the bathtub feed, view s11, the same way as the Boca Raton cams.
        id: "bathtub-beach-surf",
        name: "Bathtub Beach — Surf",
        provider: "Martin County / video-monitoring.com",
        embedType: "image",
        url: "https://discovermartin.com/live-webcams/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/bathtub",
          view: "s11",
        },
        attribution: "Live still courtesy Martin County / video-monitoring.com",
      },
    ],
  },
  {
    slug: "hobe-sound",
    name: "Hobe Sound",
    region: "Martin County, FL",
    updatedAt: "2026-10-17",
    // Hobe Sound National Wildlife Refuge beach, Jupiter Island (Martin County's cam feed).
    lat: 27.0892,
    lon: -80.1268,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722495", // Jupiter Inlet, south jetty, 10.6 mi
    noaaTideStationFallbackId: "8722375", // South Point, St. Lucie Inlet, 5.1 mi
    // The primary station is a subordinate PREDICTION station or sits on a lagoon, so the measured water level
    // comes from the Lake Worth Pier (ocean) gauge, 33 mi away.
    noaaWaterLevelStationId: "8722670",
    ndbcBuoyId: "LKWF1", // Lake Worth Pier C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41114", // Fort Pierce wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Martin).
    healthyBeaches: {
      county: "Martin",
      sites: ["HOBE SOUND WILDLIFE REFUGE", "HOBE SOUND PUBLIC BEACH"],
    },
    surfZone: { office: "MLB", name: "Coastal Saint Lucie-Coastal Martin" }, // NWS surf zone forecast block
    cams: [
      {
        // Martin County / video-monitoring.com: still read from the hobesound feed, view s20, the same way as the Boca Raton cams.
        id: "hobe-sound-beach-cam",
        name: "Hobe Sound Beach Cam",
        provider: "Martin County / video-monitoring.com",
        embedType: "image",
        url: "https://discovermartin.com/live-webcams/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/hobesound",
          view: "s20",
        },
        attribution: "Live still courtesy Martin County / video-monitoring.com",
      },
      {
        // Martin County / video-monitoring.com: still read from the hobesound feed, view s22, the same way as the Boca Raton cams.
        id: "hobe-sound-beach-south-cam",
        name: "Hobe Sound — South Beach",
        provider: "Martin County / video-monitoring.com",
        embedType: "image",
        url: "https://discovermartin.com/live-webcams/",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/hobesound",
          view: "s22",
        },
        attribution: "Live still courtesy Martin County / video-monitoring.com",
      },
    ],
  },
  {
    slug: "sebastian-inlet",
    name: "Sebastian Inlet",
    region: "Indian River County, FL",
    updatedAt: "2026-10-17",
    // Sebastian Inlet State Park, north of the Indian River County line (Brevard side of the inlet is the park; Indian River County holds the south bank).
    lat: 27.8589,
    lon: -80.4472,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722004", // Sebastian Inlet bridge, 0.1 mi
    noaaTideStationFallbackId: "8722105", // Vero Beach (ocean), 14.1 mi
    ndbcBuoyId: "41068", // Cape Canaveral C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41113", // Cape Canaveral nearshore wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Indian River).
    healthyBeaches: {
      county: "Indian River",
      sites: ["COCONUT POINT SEBASTIAN INLET"],
    },
    surfZone: { office: "MLB", name: "Coastal Indian River-Mainland Southern Brevard" }, // NWS surf zone forecast block
    cams: [
      {
        // Sebastian Inlet District / video-monitoring.com: still read from the sebastian feed, view s18, the same way as the Boca Raton cams.
        id: "sebastian-inlet-beach-cam",
        name: "Sebastian Inlet — Beach",
        provider: "Sebastian Inlet District / video-monitoring.com",
        embedType: "image",
        url: "https://sebastianinletcam.com",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/sebastian",
          view: "s18",
        },
        attribution: "Live still courtesy Sebastian Inlet District / video-monitoring.com",
      },
      {
        // Sebastian Inlet District / video-monitoring.com: still read from the sebastian feed, view s22, the same way as the Boca Raton cams.
        id: "sebastian-inlet-south-beach-cam",
        name: "Sebastian Inlet — Beach & Jetty",
        provider: "Sebastian Inlet District / video-monitoring.com",
        embedType: "image",
        url: "https://sebastianinletcam.com",
        snapshotFeed: {
          base: "https://video-monitoring.com/beachcams/sebastian",
          view: "s22",
        },
        attribution: "Live still courtesy Sebastian Inlet District / video-monitoring.com",
      },
    ],
  },
  {
    slug: "wabasso-beach",
    name: "Wabasso Beach",
    region: "Indian River County, FL",
    updatedAt: "2026-10-17",
    // Wabasso Beach Park (Indian River County).
    lat: 27.7635,
    lon: -80.3971,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8722105", // Vero Beach (ocean), 6.8 mi
    noaaTideStationFallbackId: "8722059", // Wabasso, 1.8 mi
    ndbcBuoyId: "41068", // Cape Canaveral C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "41114", // Fort Pierce wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Indian River).
    healthyBeaches: {
      county: "Indian River",
      sites: ["WABASSO BEACH PARK"],
    },
    surfZone: { office: "MLB", name: "Coastal Indian River-Mainland Southern Brevard" }, // NWS surf zone forecast block
    cams: [
      {
        // Indian River County's Wabasso Beach cam. The video is built by the contractor Surf Guru, and its embed
        // allows only indianriver.gov to frame it, so this is a click-through to the county's own page, with no
        // still of our own (no archive, no vision read).
        name: "Wabasso Beach Cam",
        provider: "Indian River County",
        embedType: "link",
        url: "https://www.indianriver.gov/services/natural_resources/coastal_engineering/beach-cam.php",
        attribution: "Beach cam courtesy Indian River County Natural Resources (video by Surf Guru)",
      },
    ],
  },
  {
    slug: "key-west-south",
    name: "Key West — South Beach",
    region: "Monroe County, FL",
    updatedAt: "2026-10-17",
    // South Beach at the foot of Duval Street, in front of the Southernmost Beach Resort, on Key West's Atlantic shore. A separate beach from `key-west` (Fort Zachary Taylor, Gulf side, about 1 mi west).
    lat: 24.5467,
    lon: -81.7949,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8724580", // KEY WEST, 1.0 mi
    noaaTideStationFallbackId: "8724557", // Key West, south side, White Street Pier, 0.7 mi
    ndbcBuoyId: "KYWF1", // Key West C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "42095", // Satan Shoal wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Monroe).
    healthyBeaches: {
      county: "Monroe",
      sites: ["SOUTH BEACH", "HIGGS BEACH"],
    },
    // No surfZone: the Key West office (KEY) publishes no Surf Zone Forecast (not in the NWS SRF product list, 2026-10-17).
    cams: [
      {
        // Southernmost Beach Resort runs this public YouTube livestream (Key West South Beach — Waterside). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "key-west-southernmost-waterside-cam",
        name: "Key West South Beach — Waterside",
        provider: "Southernmost Beach Resort",
        embedType: "image",
        url: "https://www.southernmostbeachresort.com/webcams-2",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=key-west-southernmost-waterside-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=key-west-southernmost-waterside-cam",
        attribution: "Live stream courtesy Southernmost Beach Resort, Key West",
      },
      {
        // Southernmost Beach Resort runs this public YouTube livestream (Key West South Beach — Shores Pool). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "key-west-southernmost-shores-cam",
        name: "Key West South Beach — Shores Pool",
        provider: "Southernmost Beach Resort",
        embedType: "image",
        url: "https://www.southernmostbeachresort.com/webcams-2",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=key-west-southernmost-shores-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=key-west-southernmost-shores-cam",
        attribution: "Live stream courtesy Southernmost Beach Resort, Key West",
      },
    ],
  },
  {
    slug: "sombrero-beach",
    name: "Sombrero Beach",
    region: "Monroe County, FL",
    updatedAt: "2026-10-17",
    // Sombrero Beach, a City of Marathon park on the Atlantic side of Marathon.
    lat: 24.6918,
    lon: -81.0864,
    timezone: "America/New_York",
    // coastNormalDeg and coast are left unset on purpose: nobody has reviewed the shoreline normal, and their
    // presence switches on the orientation-dependent rip-current and 'over the water' copy (see Fort Myers Beach).
    noaaTideStationId: "8723971", // Boot Key Harbor bridge, Boot Key, 1.4 mi
    noaaTideStationFallbackId: "8723970", // VACA KEY, USCG STATION, FLORIDA BAY, 1.8 mi
    // The primary station is a subordinate PREDICTION station or sits on a lagoon, so the measured water level
    // comes from the VACA KEY, USCG STATION, FLORIDA BAY gauge, 2 mi away.
    noaaWaterLevelStationId: "8723970",
    ndbcBuoyId: "SMKF1", // Sombrero Key C-MAN (water temp, no waves)
    ndbcBuoyFallbackId: "42095", // Satan Shoal wave buoy
    // Site names exactly as published by the FL Healthy Beaches feed (Monroe).
    healthyBeaches: {
      county: "Monroe",
      sites: ["SOMBRERO BEACH"],
    },
    // No surfZone: the Key West office (KEY) publishes no Surf Zone Forecast (not in the NWS SRF product list, 2026-10-17).
    cams: [
      {
        // Monroe County Tourist Development Council (Florida Keys) runs this public YouTube livestream (Sombrero Beach Cam). Frames come from the owner's courier
        // (scripts/cam_courier_local.sh), as for Deerfield.
        id: "sombrero-beach-cam",
        name: "Sombrero Beach Cam",
        provider: "Monroe County Tourist Development Council (Florida Keys)",
        embedType: "image",
        url: "https://visitfloridakeys.com/discover-the-keys/see-the-keys/webcams/marathon",
        snapshotUrl: "https://uw-frame.entwined-app.workers.dev/frame?cam=sombrero-beach-cam",
        snapshotMetaUrl: "https://uw-frame.entwined-app.workers.dev/meta?cam=sombrero-beach-cam",
        attribution: "Live stream courtesy Monroe County Tourist Development Council (Florida Keys)",
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
