import { describe, it, expect } from "vitest";
import {
  formatDuration,
  goldenHourTiming,
  goldenTrack,
  TRACK_LEAD_MINUTES,
  TRACK_TAIL_MINUTES,
} from "@/lib/goldenHourTiming";

// Boca Raton, 23 Aug 2026 — the real elevation windows from lib/sources/sun.ts,
// written here in UTC (EDT = UTC−4):
//   sunrise 6:56 AM, morning golden 6:41–7:27 AM
//   sunset  7:49 PM, evening golden 7:18–8:03 PM
const D = "2026-08-23";
const N = "2026-08-24";
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

const sunrise = at(D, "10:56"); // 6:56 AM EDT
const sunset = at(D, "23:49"); // 7:49 PM EDT
const amWindow = { start: at(D, "10:41"), end: at(D, "11:27") }; // 6:41–7:27 AM
const eve = { start: at(D, "23:18"), end: at(N, "00:03") }; // 7:18–8:03 PM
const tomorrowAm = { start: at(N, "10:42"), end: at(N, "11:27") }; // 6:42–7:27 AM
const tomorrowSunrise = at(N, "10:56");

const base = {
  windows: { am: amWindow, eve },
  sunrise,
  sunset,
  tomorrowAmWindow: tomorrowAm,
  tomorrowSunrise,
};

// Stands in for the card's `fmtTime(iso, tz)`, in the beach's own zone.
const fmtEDT = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(d);

describe("formatDuration", () => {
  it("renders hours and minutes", () => {
    expect(formatDuration(134 * 60_000)).toBe("2h 14m");
    expect(formatDuration(60 * 60_000)).toBe("1h 0m");
  });

  it("renders bare minutes under an hour", () => {
    expect(formatDuration(48 * 60_000)).toBe("48m");
    expect(formatDuration(60_000)).toBe("1m");
  });

  it("floors to the minute and bottoms out at <1m", () => {
    expect(formatDuration(119_000)).toBe("1m");
    expect(formatDuration(59_000)).toBe("<1m");
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(-5_000)).toBe("<1m");
    expect(formatDuration(Number.NaN)).toBe("<1m");
  });
});

describe("goldenHourTiming", () => {
  it("mid-afternoon: counts down to the evening window", () => {
    // 3:00 PM EDT = 19:00 UTC; the evening window opens 23:18 UTC → 4h 18m.
    const t = goldenHourTiming({ ...base, now: at(D, "19:00"), formatTime: fmtEDT });
    expect(t.phase).toBe("before");
    expect(t.target?.kind).toBe("eve");
    expect(t.target?.day).toBe("today");
    expect(t.msUntilStart).toBe(258 * 60_000);
    expect(t.msUntilEnd).toBeNull();
    expect(t.label).toBe("Golden hour in 4h 18m");
  });

  it("pre-dawn: counts down to the morning window", () => {
    // 5:00 AM EDT = 09:00 UTC; the morning window opens 10:41 UTC → 1h 41m.
    const t = goldenHourTiming({ ...base, now: at(D, "09:00"), formatTime: fmtEDT });
    expect(t.phase).toBe("before");
    expect(t.target?.kind).toBe("am");
    expect(t.target?.eventIso).toBe(new Date(sunrise).toISOString());
    expect(t.headline).toBe("Golden hour in 1h 41m");
    expect(t.badge).toBeNull();
  });

  it("inside the evening window: reports the time left", () => {
    // 7:40 PM EDT = 23:40 UTC; the window closes 00:03 → 23 min left.
    const t = goldenHourTiming({ ...base, now: at(D, "23:40"), formatTime: fmtEDT });
    expect(t.phase).toBe("during");
    expect(t.target?.kind).toBe("eve");
    expect(t.msUntilEnd).toBe(23 * 60_000);
    expect(t.msUntilStart).toBeNull();
    expect(t.label).toBe("Golden hour now · 23 min left");
  });

  it("stays 'during' past sunset until the window closes", () => {
    // 8:00 PM EDT — sunset (7:49 PM) is gone, the −4° window is not.
    const t = goldenHourTiming({ ...base, now: at(N, "00:00"), formatTime: fmtEDT });
    expect(t.phase).toBe("during");
    expect(t.label).toBe("Golden hour now · 3 min left");
  });

  it("inside the morning window: reports the time left", () => {
    // 7:00 AM EDT = 11:00 UTC; the window closes 11:27 → 27 min left.
    const t = goldenHourTiming({ ...base, now: at(D, "11:00"), formatTime: fmtEDT });
    expect(t.phase).toBe("during");
    expect(t.target?.kind).toBe("am");
    expect(t.label).toBe("Golden hour now · 27 min left");
  });

  it("after the evening window: points at tomorrow morning", () => {
    // 9:00 PM EDT = 01:00 UTC; tomorrow's window opens 10:42 UTC → 9h 42m.
    const t = goldenHourTiming({ ...base, now: at(N, "01:00"), formatTime: fmtEDT });
    expect(t.phase).toBe("after-today");
    expect(t.target?.kind).toBe("am");
    expect(t.target?.day).toBe("tomorrow");
    expect(t.target?.eventIso).toBe(new Date(tomorrowSunrise).toISOString());
    expect(t.msUntilStart).toBe((9 * 60 + 42) * 60_000);
    expect(t.label).toBe("Next golden hour 6:42 AM · in 9h 42m");
  });

  it("drops the clock time from the headline without a formatter", () => {
    const t = goldenHourTiming({ ...base, now: at(N, "01:00") });
    expect(t.headline).toBe("Next golden hour");
    expect(t.label).toBe("Next golden hour · in 9h 42m");
  });

  it("between the windows: targets the evening, not the morning that passed", () => {
    // 11:00 AM EDT = 15:00 UTC — the morning window closed hours ago.
    const t = goldenHourTiming({ ...base, now: at(D, "15:00"), formatTime: fmtEDT });
    expect(t.phase).toBe("before");
    expect(t.target?.kind).toBe("eve");
  });

  it("treats both window bounds as inside", () => {
    const opens = goldenHourTiming({ ...base, now: eve.start, formatTime: fmtEDT });
    expect(opens.phase).toBe("during");
    expect(opens.msUntilEnd).toBe(45 * 60_000);
    expect(opens.label).toBe("Golden hour now · 45 min left");

    const closes = goldenHourTiming({ ...base, now: eve.end, formatTime: fmtEDT });
    expect(closes.phase).toBe("during");
    expect(closes.msUntilEnd).toBe(0);
    expect(closes.label).toBe("Golden hour now · <1 min left");

    // One millisecond later the window is over.
    const after = goldenHourTiming({ ...base, now: Date.parse(eve.end) + 1, formatTime: fmtEDT });
    expect(after.phase).toBe("after-today");
  });

  it("one millisecond before the window opens is still 'before'", () => {
    const t = goldenHourTiming({ ...base, now: Date.parse(eve.start) - 1, formatTime: fmtEDT });
    expect(t.phase).toBe("before");
    expect(t.headline).toBe("Golden hour in <1m");
  });

  it("carries the peak-color anchor and the event through to the target", () => {
    const t = goldenHourTiming({
      ...base,
      windows: { am: amWindow, eve: { ...eve, peakAnchorIso: at(D, "23:59") } },
      now: at(D, "19:00"),
    });
    expect(t.target?.peakAnchorIso).toBe(at(D, "23:59"));
    expect(t.target?.eventIso).toBe(new Date(sunset).toISOString());
  });

  it("no windows at all (high latitude): honest 'none'", () => {
    const t = goldenHourTiming({ now: at(D, "19:00"), windows: {} });
    expect(t.phase).toBe("none");
    expect(t.target).toBeNull();
    expect(t.label).toBe("Golden hour times unavailable");
  });

  it("today's windows done and tomorrow unknown: honest 'none'", () => {
    const t = goldenHourTiming({
      now: at(N, "01:00"),
      windows: { am: amWindow, eve },
      sunrise,
      sunset,
    });
    expect(t.phase).toBe("none");
    expect(t.label).toBe("No more golden hour today");
  });

  it("ignores a malformed or inverted window", () => {
    const t = goldenHourTiming({
      now: at(D, "19:00"),
      windows: { eve: { start: "not-a-time", end: eve.end } },
      tomorrowAmWindow: tomorrowAm,
      tomorrowSunrise,
      formatTime: fmtEDT,
    });
    expect(t.phase).toBe("after-today");

    const inverted = goldenHourTiming({
      now: at(D, "19:00"),
      windows: { eve: { start: eve.end, end: eve.start } },
    });
    expect(inverted.phase).toBe("none");
  });

  it("rejects an unparseable `now`", () => {
    expect(goldenHourTiming({ ...base, now: "whenever" }).phase).toBe("none");
  });

  it("accepts Date and epoch-ms inputs alike", () => {
    const asDate = goldenHourTiming({ ...base, now: new Date(at(D, "19:00")) });
    const asMs = goldenHourTiming({ ...base, now: Date.parse(at(D, "19:00")) });
    expect(asDate.label).toBe(asMs.label);
    expect(asDate.label).toBe("Golden hour in 4h 18m");
  });
});

describe("goldenTrack", () => {
  const target = goldenHourTiming({ ...base, now: at(N, "00:00") }).target!;

  it("spans the window plus the fixed lead and tail", () => {
    const track = goldenTrack(target, at(N, "00:00"));
    expect(track.spanStartMs).toBe(target.start.getTime() - TRACK_LEAD_MINUTES * 60_000);
    expect(track.spanEndMs).toBe(target.end.getTime() + TRACK_TAIL_MINUTES * 60_000);
  });

  it("places the window, the event and now along the span", () => {
    // Span = 90 lead + 45 window + 30 tail = 165 min.
    const track = goldenTrack(target, at(N, "00:00"));
    expect(track.startPct).toBeCloseTo((90 / 165) * 100, 5);
    expect(track.endPct).toBeCloseTo((135 / 165) * 100, 5);
    // Sunset 7:49 PM = 31 min after the window opens.
    expect(track.eventPct).toBeCloseTo((121 / 165) * 100, 5);
    // Now 8:00 PM = 42 min after the window opens.
    expect(track.nowPct).toBeCloseTo((132 / 165) * 100, 5);
    expect(track.nowOutside).toBe(false);
  });

  it("pins a now outside the span to the nearest edge", () => {
    const early = goldenTrack(target, at(D, "19:00"));
    expect(early.nowPct).toBe(0);
    expect(early.nowOutside).toBe(true);

    const late = goldenTrack(target, at(N, "05:00"));
    expect(late.nowPct).toBe(100);
    expect(late.nowOutside).toBe(true);
  });

  it("drops an event tick that falls outside the span", () => {
    expect(goldenTrack({ ...target, eventIso: at(D, "12:00") }, at(N, "00:00")).eventPct).toBeNull();
    expect(goldenTrack({ ...target, eventIso: undefined }, at(N, "00:00")).eventPct).toBeNull();
  });
});
