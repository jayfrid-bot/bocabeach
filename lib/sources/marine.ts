import type { Location, MarineData, Wrapped } from "@/lib/types";
import { cToF, fetchWithTimeout, fetchedAtOf, mToFt, nowIso, oldestIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com) — marine & weather models";

type Current = Record<string, number | string | undefined>;

async function getCurrent(
  url: string,
  revalidate: number,
): Promise<{ current: Current | null; at: string }> {
  const res = await fetchWithTimeout(url, { next: { revalidate } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const json = (await res.json()) as { current?: Current };
  return { current: json.current ?? null, at: fetchedAtOf(res) };
}

export async function fetchMarine(loc: Location): Promise<Wrapped<MarineData>> {
  let fetchedAt = nowIso();
  const marineUrl =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,` +
    `swell_wave_direction,sea_surface_temperature`;
  const uvUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=uv_index,cloud_cover`;

  try {
    const [marineRes, uvRes] = await Promise.allSettled([
      getCurrent(marineUrl, 3600),
      getCurrent(uvUrl, 3600),
    ]);

    fetchedAt = oldestIso(
      marineRes.status === "fulfilled" ? marineRes.value.at : undefined,
      uvRes.status === "fulfilled" ? uvRes.value.at : undefined,
    );

    const data: MarineData = {};
    if (marineRes.status === "fulfilled" && marineRes.value.current) {
      const m = marineRes.value.current;
      const n = (k: string): number | undefined =>
        typeof m[k] === "number" ? (m[k] as number) : undefined;
      const waveM = n("wave_height");
      const swellM = n("swell_wave_height");
      const sstC = n("sea_surface_temperature");
      if (waveM !== undefined) data.waveHeightFt = round(mToFt(waveM), 1);
      if (n("wave_direction") !== undefined) data.waveDirDeg = n("wave_direction");
      if (n("wave_period") !== undefined) data.wavePeriodS = round(n("wave_period") as number, 1);
      if (swellM !== undefined) data.swellHeightFt = round(mToFt(swellM), 1);
      if (n("swell_wave_period") !== undefined)
        data.swellPeriodS = round(n("swell_wave_period") as number, 1);
      if (n("swell_wave_direction") !== undefined)
        data.swellDirDeg = n("swell_wave_direction");
      if (sstC !== undefined) data.seaSurfaceTempF = round(cToF(sstC));
    }
    if (uvRes.status === "fulfilled" && uvRes.value.current) {
      const uv = uvRes.value.current["uv_index"];
      if (typeof uv === "number") data.uvIndex = round(uv, 1);
      const cloud = uvRes.value.current["cloud_cover"];
      if (typeof cloud === "number") data.cloudCoverPct = round(cloud);
    }

    const hasAny = Object.keys(data).length > 0;
    return {
      source: "Open-Meteo Marine",
      status: hasAny ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: hasAny ? data : null,
    };
  } catch (e) {
    return {
      source: "Open-Meteo Marine",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
