import { describe, expect, it } from "vitest";
import { seaState } from "@/lib/format";

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
