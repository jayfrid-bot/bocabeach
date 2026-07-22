import { describe, it, expect } from "vitest";
import { parseNoaaPredictions, deriveTideData } from "@/lib/sources/tides";

const JSON_OK = {
  predictions: [
    { t: "2026-05-29 06:00", v: "0.3", type: "L" as const },
    { t: "2026-05-29 12:29", v: "2.5", type: "H" as const },
    { t: "2026-05-29 18:55", v: "0.2", type: "L" as const },
  ],
};

describe("parseNoaaPredictions", () => {
  it("keeps only upcoming events and infers trend", () => {
    const now = Date.parse("2026-05-29T09:00:00Z");
    const d = parseNoaaPredictions(JSON_OK, now);
    expect(d).not.toBeNull();
    expect(d!.next).toHaveLength(2);
    expect(d!.next[0].type).toBe("high");
    expect(d!.next[0].heightFt).toBe(2.5);
    expect(d!.trend).toBe("rising"); // next event is a high tide
  });

  it("reports falling when the next event is a low tide", () => {
    const now = Date.parse("2026-05-29T13:00:00Z");
    const d = parseNoaaPredictions(JSON_OK, now);
    expect(d!.next[0].type).toBe("low");
    expect(d!.trend).toBe("falling");
  });

  it("returns null on an API error payload", () => {
    expect(parseNoaaPredictions({ error: { message: "bad station" } })).toBeNull();
  });
});

describe("deriveTideData", () => {
  const TZ = "America/New_York";
  const NOW = Date.parse("2026-07-15T17:00:00Z"); // 2026-07-15 13:00 NY
  const DAY = 86_400_000;
  const pad = (n: number) => String(n).padStart(2, "0");
  const noaaT = (ms: number, hour: number) =>
    `${new Date(ms).toISOString().slice(0, 10)} ${pad(hour)}:00`;

  /** ±20-day NOAA hilo payload; today's high is overridden to a king spike. */
  function wideJson(todayHigh: number) {
    const predictions = [];
    for (let d = -20; d <= 20; d++) {
      const ms = NOW + d * DAY;
      const phase = (2 * Math.PI * d) / 14;
      const hi = d === 0 ? todayHigh : 2.5 + 0.8 * Math.cos(phase);
      const lo = 0.3 - 0.8 * Math.cos(phase);
      predictions.push({ t: noaaT(ms, 12), v: hi.toFixed(3), type: "H" as const });
      predictions.push({ t: noaaT(ms, 20), v: lo.toFixed(3), type: "L" as const });
    }
    return { predictions };
  }

  it("attaches a king-tide aberration from a wide window", () => {
    const data = deriveTideData(wideJson(4.0), TZ, NOW);
    expect(data).not.toBeNull();
    expect(data!.next.length).toBeGreaterThan(0); // upcoming events still parsed
    expect(data!.aberration).toBeDefined();
    expect(data!.aberration!.highStatus).toBe("king");
    expect(data!.aberration!.windowDays).toBe(41);
  });

  it("omits the aberration (honest-null) on a short window", () => {
    // The existing 3-event JSON is far too thin to judge a normal band.
    const data = deriveTideData(JSON_OK, TZ, Date.parse("2026-05-29T09:00:00Z"));
    expect(data).not.toBeNull();
    expect(data!.next.length).toBeGreaterThan(0);
    expect(data!.aberration).toBeUndefined();
  });
});
