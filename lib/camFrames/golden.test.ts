import { describe, expect, it } from "vitest";
import {
  chooseSlot,
  goldenSlotsIn,
  goldenWindowAt,
  goldenWindowsForDate,
  goldenWindowsOverlapping,
  windowIso,
  type GoldenLoc,
} from "@/lib/camFrames/golden";
import { localHourParts } from "@/lib/history/archive";
import { computeSunTimes } from "@/lib/sources/sun";

const MIN = 60_000;
const BOCA: GoldenLoc = { lat: 26.3587, lon: -80.0686, timezone: "America/New_York" };
const LA: GoldenLoc = { lat: 34.0195, lon: -118.4912, timezone: "America/Los_Angeles" };
const SYDNEY: GoldenLoc = { lat: -33.8915, lon: 151.2767, timezone: "Australia/Sydney" };
const SVALBARD: GoldenLoc = { lat: 78.2232, lon: 15.6267, timezone: "Arctic/Longyearbyen" };

const iso = (ms: number) => new Date(ms).toISOString();
const sun = (loc: GoldenLoc, date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return computeSunTimes(loc.lat, loc.lon, y, m, d);
};

describe("goldenWindowsForDate", () => {
  it("sunrise -20/+40 min and sunset -40/+20 min around the app's own sun times", () => {
    for (const date of ["2026-10-11", "2026-06-21", "2026-12-21"]) {
      const t = sun(BOCA, date);
      const w = goldenWindowsForDate(BOCA, date);
      expect(w.sunrise).toEqual({ startMs: t.sunrise!.getTime() - 20 * MIN, endMs: t.sunrise!.getTime() + 40 * MIN });
      expect(w.sunset).toEqual({ startMs: t.sunset!.getTime() - 40 * MIN, endMs: t.sunset!.getTime() + 20 * MIN });
    }
  });

  it("matches known Boca Raton light: Oct 11 sunrise about 7:17 AM EDT, Jun 21 sunset about 8:16 PM EDT", () => {
    const oct = windowIso(goldenWindowsForDate(BOCA, "2026-10-11").sunrise)!;
    expect(oct.startUtc.slice(0, 16)).toBe("2026-10-11T10:57"); // 6:57 AM EDT
    expect(oct.endUtc.slice(0, 16)).toBe("2026-10-11T11:57");
    const jun = windowIso(goldenWindowsForDate(BOCA, "2026-06-21").sunset)!;
    expect(jun.startUtc.slice(0, 16)).toBe("2026-06-21T23:35"); // 7:35 PM EDT
    expect(jun.endUtc.slice(0, 16)).toBe("2026-06-22T00:35"); // 8:35 PM EDT: past UTC midnight
  });

  it("a spring-forward day (2026-03-08): the morning window is in daylight time, local date and hour right", () => {
    const w = goldenWindowsForDate(BOCA, "2026-03-08");
    const start = localHourParts(BOCA.timezone, w.sunrise!.startMs);
    expect(start).toMatchObject({ date: "2026-03-08", hour: 7, offsetMinutes: -240 });
    const end = localHourParts(BOCA.timezone, w.sunset!.endMs);
    expect(end).toMatchObject({ date: "2026-03-08", hour: 19, offsetMinutes: -240 });
  });

  it("a fall-back day (2026-11-01): the morning window is in standard time, the day's windows stay on that date", () => {
    const w = goldenWindowsForDate(BOCA, "2026-11-01");
    expect(localHourParts(BOCA.timezone, w.sunrise!.startMs)).toMatchObject({ date: "2026-11-01", hour: 6, offsetMinutes: -300 });
    expect(localHourParts(BOCA.timezone, w.sunset!.endMs)).toMatchObject({ date: "2026-11-01", hour: 17, offsetMinutes: -300 });
  });

  it("another timezone: Los Angeles lands on its own morning, 3 hours after Boca's", () => {
    const w = goldenWindowsForDate(LA, "2026-10-11");
    const start = localHourParts(LA.timezone, w.sunrise!.startMs);
    expect(start).toMatchObject({ date: "2026-10-11", hour: 6, offsetMinutes: -420 });
    const boca = goldenWindowsForDate(BOCA, "2026-10-11");
    expect(w.sunrise!.startMs - boca.sunrise!.startMs).toBeGreaterThan(2.5 * 3_600_000);
  });

  it("the other side of the date line: a Sydney morning starts on the previous UTC day", () => {
    const w = goldenWindowsForDate(SYDNEY, "2026-10-11");
    expect(iso(w.sunrise!.startMs).slice(0, 10)).toBe("2026-10-10");
    expect(localHourParts(SYDNEY.timezone, w.sunrise!.startMs)).toMatchObject({ date: "2026-10-11", hour: 5, offsetMinutes: 660 });
    expect(localHourParts(SYDNEY.timezone, w.sunset!.endMs).date).toBe("2026-10-11");
  });

  it("returns null windows when the sun does not rise or set (polar day and night)", () => {
    expect(goldenWindowsForDate(SVALBARD, "2026-06-21")).toEqual({ sunrise: null, sunset: null });
    expect(goldenWindowsForDate(SVALBARD, "2026-12-21")).toEqual({ sunrise: null, sunset: null });
  });

  it("returns null windows for a malformed date", () => {
    expect(goldenWindowsForDate(BOCA, "10/11/2026")).toEqual({ sunrise: null, sunset: null });
    expect(goldenWindowsForDate(BOCA, "")).toEqual({ sunrise: null, sunset: null });
  });
});

describe("goldenWindowAt", () => {
  const w = goldenWindowsForDate(BOCA, "2026-10-11");
  const rise = w.sunrise!;

  it("is half-open: the start is inside, the end is outside", () => {
    expect(goldenWindowAt(BOCA, rise.startMs)?.kind).toBe("sunrise");
    expect(goldenWindowAt(BOCA, rise.startMs - 1)).toBeNull();
    expect(goldenWindowAt(BOCA, rise.endMs - 1)?.kind).toBe("sunrise");
    expect(goldenWindowAt(BOCA, rise.endMs)).toBeNull();
  });

  it("names the sunset window too", () => {
    expect(goldenWindowAt(BOCA, w.sunset!.startMs + 5 * MIN)?.kind).toBe("sunset");
  });

  it("is null at midday and at night", () => {
    expect(goldenWindowAt(BOCA, Date.parse("2026-10-11T16:00:00Z"))).toBeNull();
    expect(goldenWindowAt(BOCA, Date.parse("2026-10-11T03:00:00Z"))).toBeNull();
  });

  it("finds a sunset window that runs past UTC midnight, by the beach's local date", () => {
    // 2026-06-22T00:05Z is 8:05 PM EDT on June 21.
    expect(goldenWindowAt(BOCA, Date.parse("2026-06-22T00:05:00Z"))?.kind).toBe("sunset");
    expect(goldenWindowAt(BOCA, Date.parse("2026-06-22T00:40:00Z"))).toBeNull();
  });

  it("never finds a window at a polar beach", () => {
    expect(goldenWindowAt(SVALBARD, Date.parse("2026-06-21T03:00:00Z"))).toBeNull();
    expect(goldenWindowAt(SVALBARD, Date.parse("2026-12-21T09:00:00Z"))).toBeNull();
  });
});

describe("chooseSlot", () => {
  it("floors to 10 minutes inside a window and marks it golden", () => {
    expect(chooseSlot(BOCA, Date.parse("2026-10-11T11:24:30Z"))).toMatchObject({ slotUtc: "2026-10-11T11:20:00.000Z", kind: "golden" });
    expect(chooseSlot(BOCA, Date.parse("2026-10-11T11:20:00Z"))).toMatchObject({ slotUtc: "2026-10-11T11:20:00.000Z", kind: "golden" });
    expect(chooseSlot(BOCA, Date.parse("2026-10-11T11:29:59.999Z"))).toMatchObject({ slotUtc: "2026-10-11T11:20:00.000Z" });
  });

  it("floors to the UTC hour outside a window", () => {
    expect(chooseSlot(BOCA, Date.parse("2026-10-11T14:20:00Z"))).toMatchObject({ slotUtc: "2026-10-11T14:00:00.000Z", kind: "hour" });
  });

  it("a window opening mid-slot: the first golden slot starts before the window", () => {
    // Window opens 10:57:34Z; a frame at 10:58 is golden and floors to 10:50.
    expect(chooseSlot(BOCA, Date.parse("2026-10-11T10:58:00Z"))).toMatchObject({ slotUtc: "2026-10-11T10:50:00.000Z", kind: "golden" });
    expect(chooseSlot(BOCA, Date.parse("2026-10-11T10:57:00Z"))).toMatchObject({ slotUtc: "2026-10-11T10:00:00.000Z", kind: "hour" });
  });

  it("without a location it is always the hour slot", () => {
    expect(chooseSlot(null, Date.parse("2026-10-11T11:24:30Z"))).toMatchObject({ slotUtc: "2026-10-11T11:00:00.000Z", kind: "hour" });
    expect(chooseSlot(undefined, Date.parse("2026-10-11T11:24:30Z")).kind).toBe("hour");
  });

  it("a polar beach archives hourly all day", () => {
    expect(chooseSlot(SVALBARD, Date.parse("2026-06-21T11:24:30Z"))).toMatchObject({ slotUtc: "2026-06-21T11:00:00.000Z", kind: "hour" });
  });

  it("outside the windows an hour holds one slot: every instant of an hour gives the same key", () => {
    const keys = new Set<string>();
    for (let m = 0; m < 60; m += 5) keys.add(chooseSlot(BOCA, Date.parse("2026-10-11T15:00:00Z") + m * MIN).slotUtc);
    expect(keys.size).toBe(1);
  });

  it("inside a window an hour holds up to six slots", () => {
    const keys = new Set<string>();
    for (let m = 0; m < 60; m++) {
      const c = chooseSlot(BOCA, Date.parse("2026-10-11T11:00:00Z") + m * MIN);
      if (c.kind === "golden") keys.add(c.slotUtc);
    }
    expect(keys.size).toBe(6);
  });
});

describe("goldenSlotsIn and goldenWindowsOverlapping", () => {
  const w = goldenWindowsForDate(BOCA, "2026-10-11").sunrise!; // 10:57:34Z - 11:57:34Z

  it("lists the 10-minute slots of a window, from the slot holding its start to the one holding its last instant", () => {
    expect(goldenSlotsIn(w, 0, Number.MAX_SAFE_INTEGER).map((s) => s.slice(11, 16))).toEqual(["10:50", "11:00", "11:10", "11:20", "11:30", "11:40", "11:50"]);
  });

  it("clips to the range asked for", () => {
    const got = goldenSlotsIn(w, Date.parse("2026-10-11T11:00:00Z"), Date.parse("2026-10-11T11:24:00Z"));
    expect(got.map((s) => s.slice(11, 16))).toEqual(["11:00", "11:10", "11:20"]);
  });

  it("finds the windows that overlap a range and skips the rest", () => {
    const from = Date.parse("2026-10-11T08:00:00Z");
    const to = Date.parse("2026-10-11T14:00:00Z");
    expect(goldenWindowsOverlapping(BOCA, from, to).map((x) => x.kind)).toEqual(["sunrise"]);
    expect(goldenWindowsOverlapping(BOCA, Date.parse("2026-10-11T12:00:00Z"), Date.parse("2026-10-11T20:00:00Z"))).toEqual([]);
    const wide = goldenWindowsOverlapping(BOCA, Date.parse("2026-10-11T08:00:00Z"), Date.parse("2026-10-11T23:00:00Z"));
    expect(wide.map((x) => x.kind)).toEqual(["sunrise", "sunset"]);
  });

  it("a range ending exactly when a window starts still counts it, one ending before does not", () => {
    expect(goldenWindowsOverlapping(BOCA, w.startMs - 3 * 3_600_000, w.startMs)).toHaveLength(1);
    expect(goldenWindowsOverlapping(BOCA, w.startMs - 3 * 3_600_000, w.startMs - 1)).toHaveLength(0);
  });
});
