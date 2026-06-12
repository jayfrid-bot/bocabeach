import { describe, expect, it } from "vitest";
import { parseMetno } from "@/lib/sources/metno";
import { parseAirNow } from "@/lib/sources/airQuality";
import { median } from "@/lib/score";

describe("parseMetno", () => {
  it("converts the current-hour instant details to imperial", () => {
    const d = parseMetno({
      properties: {
        timeseries: [
          {
            time: "2026-06-12T19:00:00Z",
            data: {
              instant: {
                details: {
                  air_temperature: 31.2, // °C -> 88°F
                  wind_speed: 4.6, // m/s -> 10 mph
                  wind_from_direction: 95.4,
                  relative_humidity: 61.5,
                  dew_point_temperature: 23.4, // -> 74°F
                  cloud_area_fraction: 12.5,
                },
              },
            },
          },
        ],
      },
    })!;
    expect(d.airTempF).toBe(88);
    expect(d.windSpeedMph).toBe(10);
    expect(d.windDirDeg).toBe(95);
    expect(d.humidityPct).toBe(62);
    expect(d.dewPointF).toBe(74);
    expect(d.cloudCoverPct).toBe(13);
  });

  it("returns null on an empty or malformed payload", () => {
    expect(parseMetno({})).toBeNull();
    expect(parseMetno({ properties: { timeseries: [] } })).toBeNull();
  });
});

describe("parseAirNow", () => {
  it("takes the worst pollutant as the overall AQI", () => {
    const d = parseAirNow([
      { ParameterName: "O3", AQI: 41 },
      { ParameterName: "PM2.5", AQI: 67 },
      { ParameterName: "PM10", AQI: 22 },
    ])!;
    expect(d.usAqi).toBe(67);
    expect(d.dominantPollutant).toBe("PM2.5");
  });

  it("relabels O3 to Ozone and rejects empty/invalid rows", () => {
    expect(parseAirNow([{ ParameterName: "O3", AQI: 38 }])!.dominantPollutant).toBe("Ozone");
    expect(parseAirNow([])).toBeNull();
    expect(parseAirNow([{ ParameterName: "PM2.5", AQI: -999 }])).toBeNull();
  });
});

describe("median (consensus)", () => {
  it("takes the middle of three so one outlier can't skew the metric", () => {
    expect(median(88, 90, 104)).toBe(90);
  });
  it("averages two and passes through one", () => {
    expect(median(86, 90)).toBe(88);
    expect(median(undefined, 84)).toBe(84);
    expect(median(undefined, undefined)).toBeUndefined();
  });
});
