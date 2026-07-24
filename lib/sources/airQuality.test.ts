import { describe, it, expect } from "vitest";
import { parseAirQuality } from "@/lib/sources/airQuality";

const SAMPLE = {
  current: {
    time: "2026-06-02T21:00",
    us_aqi: 51,
    pm2_5: 13.4,
    pm10: 17.12,
    ozone: 75,
    us_aqi_pm2_5: 51,
    us_aqi_pm10: 15,
    us_aqi_ozone: 42,
  },
};

describe("parseAirQuality", () => {
  it("reads the US AQI and pollutant concentrations", () => {
    const d = parseAirQuality(SAMPLE)!;
    expect(d.usAqi).toBe(51);
    expect(d.pm2_5).toBe(13.4);
    expect(d.pm10).toBe(17.1); // rounded to 1dp
    expect(d.ozone).toBe(75);
    expect(d.observedAt).toBe("2026-06-02T21:00:00.000Z");
  });

  it("picks the dominant pollutant from the highest sub-index", () => {
    expect(parseAirQuality(SAMPLE)!.dominantPollutant).toBe("PM2.5");
    const ozoneDriven = {
      current: { ...SAMPLE.current, us_aqi_pm2_5: 30, us_aqi_ozone: 88 },
    };
    expect(parseAirQuality(ozoneDriven)!.dominantPollutant).toBe("Ozone");
  });

  it("returns null when there is no AQI reading", () => {
    expect(parseAirQuality({ current: { time: "2026-06-02T21:00" } })).toBeNull();
    expect(parseAirQuality({})).toBeNull();
  });

  it("reads aerosol optical depth (CAMS) when present, rounded to 2dp", () => {
    const withAod = {
      current: { ...SAMPLE.current, aerosol_optical_depth: 0.0873 },
    };
    expect(parseAirQuality(withAod)!.aod).toBe(0.09);
  });

  it("leaves aod undefined when the provider omits it (older feeds / AirNow path)", () => {
    expect(parseAirQuality(SAMPLE)!.aod).toBeUndefined();
  });
});
