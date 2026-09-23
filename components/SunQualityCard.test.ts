import { describe, it, expect } from "vitest";
import { cardTitle } from "./SunQualityCard";
import { SUN_QUALITY_BANDS } from "@/lib/sunQuality";

describe("sun color card wording", () => {
  it("says which event is coming, in plain words", () => {
    expect(cardTitle("sunrise", false)).toBe("Upcoming sunrise color");
    expect(cardTitle("sunset", false)).toBe("Upcoming sunset color");
  });

  it("drops 'upcoming' inside the golden window (the sun may already be down)", () => {
    expect(cardTitle("sunrise", true)).toBe("Sunrise color now");
    expect(cardTitle("sunset", true)).toBe("Sunset color now");
  });

  it("ranks with simple words, worst to best", () => {
    expect(SUN_QUALITY_BANDS.map((b) => b.label)).toEqual(["Poor", "Fair", "Good", "Great", "Amazing"]);
  });
});
