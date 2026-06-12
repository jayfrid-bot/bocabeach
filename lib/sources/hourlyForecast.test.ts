import { describe, it, expect } from "vitest";
import { parseOpenMeteoHourly } from "@/lib/sources/hourlyForecast";

// Mirrors an Open-Meteo /v1/forecast `hourly` payload (imperial, GMT times).
const FIXTURE = {
  hourly: {
    time: [
      "2026-06-01T10:00",
      "2026-06-01T11:00",
      "2026-06-01T12:00",
      "2026-06-01T13:00",
    ],
    temperature_2m: [78.4, 82.1, 86.9, 90.2],
    cloud_cover: [10, 35, 80, 100],
    precipitation_probability: [0, null, 45, 90],
    weather_code: [0, 2, 61, 95],
    wind_speed_10m: [6.3, 9.1, 12.7, 18.4],
    wind_direction_10m: [90, 110, 130, 200],
    uv_index: [3.2, 6.7, 8.1, 2.0],
    relative_humidity_2m: [72, 68, null, 80],
    dew_point_2m: [69.4, 70.1, 72.8, 74.2],
  },
};

describe("parseOpenMeteoHourly", () => {
  const rows = parseOpenMeteoHourly(FIXTURE)!;

  it("returns one row per hour with rounded values", () => {
    expect(rows).toHaveLength(4);
    const r0 = rows[0];
    expect(r0.airTempF).toBe(78);
    expect(r0.cloudCoverPct).toBe(10);
    expect(r0.windSpeedMph).toBe(6);
    expect(r0.windDirDeg).toBe(90);
    expect(r0.uvIndex).toBe(3.2);
    expect(r0.weatherCode).toBe(0);
    expect(r0.humidityPct).toBe(72);
    expect(r0.dewPointF).toBe(69); // rounded
    expect(rows[2].humidityPct).toBeUndefined(); // null humidity -> missing
  });

  it("normalizes the GMT time to an absolute UTC ISO string", () => {
    expect(rows[0].time).toBe("2026-06-01T10:00:00.000Z");
    expect(rows[3].time).toBe("2026-06-01T13:00:00.000Z");
  });

  it("treats a null precip probability as missing, not zero", () => {
    expect(rows[1].precipProbability).toBeUndefined();
    expect(rows[0].precipProbability).toBe(0);
  });

  it("derives a sky emoji and short label from the WMO code", () => {
    expect(rows[1].shortForecast).toBe("Partly cloudy"); // code 2
    expect(rows[2].emoji).toBe("🌧️"); // code 61 = rain
    expect(rows[2].shortForecast).toBe("Rain");
    expect(rows[3].emoji).toBe("⛈️"); // code 95 = thunderstorm
  });

  it("handles a missing weather code (no label, neutral marker)", () => {
    const alt = parseOpenMeteoHourly({
      hourly: { time: ["2026-06-01T15:00"], temperature_2m: [80], weather_code: [null] },
    })!;
    expect(alt[0].weatherCode).toBeUndefined();
    expect(alt[0].shortForecast).toBeUndefined();
    expect(alt[0].emoji).toBe("•");
  });

  it("returns null when there is no usable hourly data", () => {
    expect(parseOpenMeteoHourly({})).toBeNull();
    expect(parseOpenMeteoHourly({ hourly: { time: [] } })).toBeNull();
  });
});

describe("overlaySatelliteRadiation", () => {
  const mk = (iso: string, solar: number) => ({ time: iso, solarWm2: solar });
  const NOW = Date.parse("2026-06-11T18:30:00.000Z");

  it("overrides elapsed hours with satellite-observed values", async () => {
    const { overlaySatelliteRadiation } = await import("@/lib/sources/hourlyForecast");
    // Model hallucinated a cloud at 17:00Z; satellite saw near-full sun.
    const hours = [mk("2026-06-11T17:00:00.000Z", 437), mk("2026-06-11T19:00:00.000Z", 832)];
    overlaySatelliteRadiation(hours, {
      time: ["2026-06-11T17:00", "2026-06-11T19:00"],
      shortwave_radiation: [918, 700],
    }, NOW);
    expect(hours[0].solarWm2).toBe(918); // elapsed -> observed wins
    expect(hours[1].solarWm2).toBe(832); // future -> forecast model stands
  });

  it("leaves hours untouched when satellite data is missing or null", async () => {
    const { overlaySatelliteRadiation } = await import("@/lib/sources/hourlyForecast");
    const hours = [mk("2026-06-11T16:00:00.000Z", 905)];
    overlaySatelliteRadiation(hours, { time: ["2026-06-11T16:00"], shortwave_radiation: [null] }, NOW);
    expect(hours[0].solarWm2).toBe(905);
    overlaySatelliteRadiation(hours, {}, NOW);
    expect(hours[0].solarWm2).toBe(905);
  });
});
