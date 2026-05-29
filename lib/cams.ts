import type { CamView, Location } from "@/lib/types";
import { fetchSpotWeather } from "@/lib/sources/spotWeather";

/**
 * Build the cam list for a location, attaching the live weather/wind at each
 * cam's own coordinates (falling back to the town's lat/lon). Fetches run in
 * parallel; cams sharing a rounded coordinate reuse the same cached request.
 */
export async function buildCamViews(loc: Location): Promise<CamView[]> {
  return Promise.all(
    loc.cams.map(async (cam): Promise<CamView> => {
      const weather = await fetchSpotWeather(cam.lat ?? loc.lat, cam.lon ?? loc.lon);
      return {
        name: cam.name,
        provider: cam.provider,
        embedType: cam.embedType,
        url: cam.url,
        attribution: cam.attribution,
        weather,
      };
    }),
  );
}
