import { describe, it, expect } from "vitest";
import { parseOpenMeteoCurrent, wmoText } from "@/lib/sources/spotWeather";

// Mirrors an Open-Meteo /v1/forecast `current` payload requested with imperial
// units (temperature_unit=fahrenheit, wind_speed_unit=mph, no timezone -> GMT).
const FIXTURE = {
  current: {
    time: "2026-05-29T18:15",
    interval: 900,
    temperature_2m: 82.6,
    relative_humidity_2m: 86,
    apparent_temperature: 91.9,
    dew_point_2m: 78.4,
    weather_code: 95,
    wind_speed_10m: 8.3,
    wind_direction_10m: 114,
    wind_gusts_10m: 10.7,
  },
};

describe("parseOpenMeteoCurrent", () => {
  it("maps the current block to per-spot weather + wind", () => {
    const d = parseOpenMeteoCurrent(FIXTURE)!;
    expect(d.airTempF).toBe(83);
    expect(d.apparentTempF).toBe(92);
    expect(d.windSpeedMph).toBe(8);
    expect(d.windGustMph).toBe(11);
    expect(d.windDirDeg).toBe(114);
    expect(d.windDirCardinal).toBe("ESE");
    expect(d.humidity).toBe(86);
    expect(d.dewPointF).toBe(78);
    expect(d.weatherCode).toBe(95);
    expect(d.shortForecast).toBe("Thunderstorm");
    expect(d.observedAt).toBe("2026-05-29T18:15:00.000Z");
  });

  it("returns null when there is no usable current data", () => {
    expect(parseOpenMeteoCurrent({})).toBeNull();
    expect(parseOpenMeteoCurrent({ current: {} })).toBeNull();
  });

  it("omits fields that are missing rather than inventing them", () => {
    const d = parseOpenMeteoCurrent({ current: { temperature_2m: 80 } })!;
    expect(d.airTempF).toBe(80);
    expect(d.windSpeedMph).toBeUndefined();
    expect(d.windDirCardinal).toBeUndefined();
  });
});

describe("wmoText", () => {
  it("labels representative WMO codes", () => {
    expect(wmoText(0)).toBe("Clear");
    expect(wmoText(2)).toBe("Partly cloudy");
    expect(wmoText(3)).toBe("Overcast");
    expect(wmoText(61)).toBe("Rain");
    expect(wmoText(95)).toBe("Thunderstorm");
  });

  it("returns undefined for unknown / missing codes", () => {
    expect(wmoText(undefined)).toBeUndefined();
    expect(wmoText(7)).toBeUndefined();
  });
});
