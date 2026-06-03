import { describe, it, expect } from "vitest";
import { parseNowcast } from "@/lib/sources/nowcast";

// 15-min buckets starting 2026-06-03T12:00Z; "now" = 12:05Z (in the first bucket).
const NOW = Date.parse("2026-06-03T12:05:00Z");
const times = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 5, 3, 12, 0) + i * 15 * 60000);
    return d.toISOString().slice(0, 16); // "YYYY-MM-DDThh:mm" (GMT, like Open-Meteo)
  });

describe("parseNowcast", () => {
  it("dry now, rain starting later -> minutes until it starts", () => {
    const d = parseNowcast(
      { minutely_15: { time: times(8), precipitation: [0, 0, 0, 0.4, 0.5, 0, 0, 0] } },
      NOW,
    )!;
    expect(d.state).toBe("dry");
    expect(d.changeInMin).toBe(40); // bucket index 3 = 12:45Z, 40 min after 12:05
    expect(d.text).toMatch(/rain likely in ~40 min/i);
  });

  it("raining now, easing later -> minutes until it stops", () => {
    const d = parseNowcast(
      { minutely_15: { time: times(8), precipitation: [0.6, 0.5, 0, 0, 0, 0, 0, 0] } },
      NOW,
    )!;
    expect(d.state).toBe("raining");
    expect(d.changeInMin).toBe(25); // index 2 = 12:30Z
    expect(d.text).toMatch(/easing/i);
  });

  it("stays dry across the window -> no change", () => {
    const d = parseNowcast(
      { minutely_15: { time: times(8), precipitation: [0, 0, 0, 0, 0, 0, 0, 0] } },
      NOW,
    )!;
    expect(d.state).toBe("dry");
    expect(d.changeInMin).toBeUndefined();
    expect(d.text).toMatch(/dry for the next/i);
  });

  it("returns null without minutely data", () => {
    expect(parseNowcast({}, NOW)).toBeNull();
  });
});
