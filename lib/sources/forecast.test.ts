import { describe, it, expect } from "vitest";
import { parseOpenMeteoDaily, wmoEmoji } from "@/lib/sources/forecast";

// Mirrors an Open-Meteo /v1/forecast `daily` payload (imperial, forecast_days=7).
const FIXTURE = {
  daily: {
    time: [
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
    ],
    temperature_2m_max: [86.4, 88.1, 84.9, 90.2, 87.7, 85.3, 83.0],
    temperature_2m_min: [74.2, 75.0, 73.6, 76.8, 75.1, 74.0, 72.5],
    precipitation_probability_max: [10, 0, 45, 80, 30, null, 5],
    weathercode: [0, 1, 61, 95, 3, 2, 80],
    wind_speed_10m_max: [9.4, 11.2, 13.6, 18.0, 12.1, 8.7, 10.3],
  },
};

describe("parseOpenMeteoDaily", () => {
  const days = parseOpenMeteoDaily(FIXTURE)!;

  it("returns one entry per day with rounded values", () => {
    expect(days).toHaveLength(7);
    const d0 = days[0];
    expect(d0.date).toBe("2026-05-31");
    expect(d0.hi).toBe(86);
    expect(d0.lo).toBe(74);
    expect(d0.rain).toBe(10);
    expect(d0.windMaxMph).toBe(9);
    expect(d0.weatherCode).toBe(0);
  });

  it("derives a TZ-safe weekday and a sky emoji/label from the code", () => {
    // 2026-05-31 is a Sunday.
    expect(days[0].dow).toBe("Sun");
    expect(days[0].emoji).toBe("☀️"); // code 0 = clear
    expect(days[0].sky).toBe("Clear");
    expect(days[3].emoji).toBe("⛈️"); // code 95 = thunderstorm
    expect(days[2].emoji).toBe("🌧️"); // code 61 = rain
  });

  it("treats a null precip probability as missing, not zero", () => {
    expect(days[5].rain).toBeUndefined();
  });

  it("falls back to weather_code when weathercode is absent", () => {
    const alt = parseOpenMeteoDaily({
      daily: {
        time: ["2026-05-31"],
        temperature_2m_max: [80],
        temperature_2m_min: [70],
        precipitation_probability_max: [20],
        weather_code: [3],
        wind_speed_10m_max: [10],
      },
    })!;
    expect(alt[0].weatherCode).toBe(3);
    expect(alt[0].emoji).toBe("☁️");
  });

  it("returns null when there is no usable daily data", () => {
    expect(parseOpenMeteoDaily({})).toBeNull();
    expect(parseOpenMeteoDaily({ daily: { time: [] } })).toBeNull();
  });
});

describe("wmoEmoji", () => {
  it("maps representative codes", () => {
    expect(wmoEmoji(0)).toBe("☀️");
    expect(wmoEmoji(3)).toBe("☁️");
    expect(wmoEmoji(65)).toBe("🌧️");
    expect(wmoEmoji(95)).toBe("⛈️");
  });
  it("returns a neutral marker for unknown/missing codes", () => {
    expect(wmoEmoji(undefined)).toBe("•");
    expect(wmoEmoji(7)).toBe("•");
  });
});
