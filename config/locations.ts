import type { Location, LocationPublic } from "@/lib/types";

/**
 * The whole multi-town design lives here: adding a beach town = adding one entry.
 * Everything downstream (data fetching, scoring, routing, UI) is driven off this list.
 *
 * To add a town you need: lat/lon (beach-side), the nearest NOAA tide station id,
 * the nearest NDBC buoy id, its offshore wind bearing, optional FL Healthy Beaches
 * site names + a city conditions page to scrape, and its cams.
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
    offshoreWindFromDeg: 270, // beach faces east; offshore wind blows from the west
    healthyBeachesSites: ["South Beach Park", "Spanish River Park", "Red Reef Park"],
    cityConditionsUrl: "https://www.myboca.us/2464/Beach-Conditions",
    cams: [
      {
        name: "Boca Surf Cam",
        provider: "bocasurfcam.com",
        embedType: "link",
        url: "http://www.bocasurfcam.com/",
      },
      {
        name: "Boca Raton Inlet Cam",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "link",
        url: "https://video-monitoring.com/beachcams/bocainlet/",
      },
      {
        name: "Boca Raton South Beach Cam",
        provider: "Palm Beach County ERM / video-monitoring.com",
        embedType: "link",
        url: "https://video-monitoring.com/beachcams/boca/",
      },
      {
        name: "City of Boca Raton Cam",
        provider: "livebeaches.com",
        embedType: "link",
        url: "https://www.livebeaches.com/webcams/city-of-boca-raton-cam/",
      },
      {
        name: "Deerfield Beach Pier Cam (nearby)",
        provider: "City of Deerfield Beach",
        embedType: "link",
        url: "https://www.deerfield-beach.com/1474/Livestream-Cameras",
      },
      {
        name: "Surfline — Boca Raton",
        provider: "Surfline",
        embedType: "link",
        url: "https://www.surfline.com/surf-reports-forecasts-cams/united-states/florida/palm-beach-county/boca-raton/4148411",
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
