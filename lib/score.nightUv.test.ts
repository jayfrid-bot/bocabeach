// Night UV rule (lib/score.ts sunIsDown): between sunset and sunrise UV reads 0
// when no feed has a value — but only while the snapshot's sun times are for
// the day being scored, so an old snapshot scored the next morning can never
// read "UV 0" in daylight.
import { describe, expect, it } from "vitest";
import { sunIsDown } from "@/lib/score";

// Boca, 2026-10-17 (EDT): sunrise ~07:19 local = 11:19Z, sunset ~18:50 = 22:50Z.
const SUN = { sunrise: "2026-10-17T11:19:00Z", sunset: "2026-10-17T22:50:00Z" };
const at = (iso: string) => Date.parse(iso);

describe("sunIsDown", () => {
  it("is true before sunrise and after sunset on the snapshot's day", () => {
    expect(sunIsDown(SUN, at("2026-10-17T09:00:00Z"))).toBe(true); // 5 AM
    expect(sunIsDown(SUN, at("2026-10-17T23:30:00Z"))).toBe(true); // 7:30 PM
    expect(sunIsDown(SUN, at("2026-10-18T03:00:00Z"))).toBe(true); // 11 PM
  });

  it("is false in daylight", () => {
    expect(sunIsDown(SUN, at("2026-10-17T16:00:00Z"))).toBe(false);
  });

  it("is false when the snapshot's sun times are from another day (next morning, daylight)", () => {
    expect(sunIsDown(SUN, at("2026-10-18T13:00:00Z"))).toBe(false); // 9 AM next day
    expect(sunIsDown(SUN, at("2026-10-18T11:30:00Z"))).toBe(false); // just after next sunrise
  });

  it("is false when either sun time is unknown", () => {
    expect(sunIsDown({ sunrise: SUN.sunrise }, at("2026-10-17T09:00:00Z"))).toBe(false);
    expect(sunIsDown(null, at("2026-10-17T09:00:00Z"))).toBe(false);
  });
});
