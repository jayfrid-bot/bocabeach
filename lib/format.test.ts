import { describe, expect, it } from "vitest";
import { interpolateColor, seaState } from "@/lib/format";

describe("seaState", () => {
  it("maps wave height to the plain-English ladder", () => {
    expect(seaState(0.5).label).toBe("Calm");
    expect(seaState(1.5).label).toBe("Gentle");
    expect(seaState(2.2).label).toBe("Light chop");
    expect(seaState(2.7).label).toBe("Choppy");
    expect(seaState(3.5).label).toBe("Really choppy");
    expect(seaState(4).label).toBe("Really choppy"); // 3-4.5 ft is serious water
    expect(seaState(5).label).toBe("Big waves");
    expect(seaState(10).label).toBe("Very rough");
  });

  it("treats band edges and bad input sanely", () => {
    expect(seaState(0).label).toBe("Calm");
    expect(seaState(1).label).toBe("Gentle"); // 1 ft crosses into Gentle
    expect(seaState(-2).label).toBe("Calm"); // clamped
    expect(seaState(3).label).toBe("Really choppy");
  });

  it("every band carries a descriptive note", () => {
    for (const ft of [0.5, 1.5, 2.5, 4, 5, 7, 12]) {
      expect(seaState(ft).note.length).toBeGreaterThan(5);
    }
  });
});

describe("interpolateColor", () => {
  const stops = ["#475569", "#34d399", "#a3e635", "#fbbf24", "#fb7185"];

  it("returns the exact stops at the endpoints", () => {
    expect(interpolateColor(0, stops)).toBe("#475569");
    expect(interpolateColor(1, stops)).toBe("#fb7185");
  });

  it("clamps out-of-range fractions to the nearest end stop", () => {
    expect(interpolateColor(-0.5, stops)).toBe("#475569");
    expect(interpolateColor(1.5, stops)).toBe("#fb7185");
  });

  it("blends between the two nearest stops at a midpoint", () => {
    // Two-stop case: the midpoint should be the arithmetic mean of the two
    // channel-wise, not equal to either endpoint.
    const mid = interpolateColor(0.5, ["#000000", "#ffffff"]);
    expect(mid).toBe("#808080");
    expect(mid).not.toBe("#000000");
    expect(mid).not.toBe("#ffffff");
  });

  it("picks the right segment across a multi-stop palette", () => {
    // 5 stops -> 4 segments; a fraction of 0.25 lands exactly on stop[1].
    expect(interpolateColor(0.25, stops)).toBe(stops[1]);
    expect(interpolateColor(0.5, stops)).toBe(stops[2]);
    expect(interpolateColor(0.75, stops)).toBe(stops[3]);
  });

  it("handles degenerate stop lists", () => {
    expect(interpolateColor(0.5, ["#123456"])).toBe("#123456");
    expect(interpolateColor(0.5, [])).toBe("#000000");
  });
});
