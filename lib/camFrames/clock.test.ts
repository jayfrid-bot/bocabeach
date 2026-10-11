import { describe, it, expect } from "vitest";
import {
  frameClocks,
  MAX_FRAME_AGE_MS,
  MAX_FRAME_FUTURE_MS,
  validateFrameAt,
} from "@/lib/camFrames/clock";
import { localHourParts } from "@/lib/history/archive";

const NOW = Date.parse("2026-10-11T14:20:00.000Z");
const TZ = "America/New_York";

describe("validateFrameAt", () => {
  it("accepts a recent time and normalizes it to UTC ISO", () => {
    expect(validateFrameAt("2026-10-11T14:10:00Z", NOW)).toBe("2026-10-11T14:10:00.000Z");
    expect(validateFrameAt("2026-10-11T10:10:00-04:00", NOW)).toBe("2026-10-11T14:10:00.000Z");
    expect(validateFrameAt("2026-10-11T14:10:00.123Z", NOW)).toBe("2026-10-11T14:10:00.123Z");
  });

  it("rejects a time more than 5 minutes in the future, accepts exactly 5", () => {
    expect(validateFrameAt(new Date(NOW + MAX_FRAME_FUTURE_MS).toISOString(), NOW)).not.toBeNull();
    expect(validateFrameAt(new Date(NOW + MAX_FRAME_FUTURE_MS + 1000).toISOString(), NOW)).toBeNull();
  });

  it("rejects a time more than 3 hours old, accepts exactly 3 hours", () => {
    expect(validateFrameAt(new Date(NOW - MAX_FRAME_AGE_MS).toISOString(), NOW)).not.toBeNull();
    expect(validateFrameAt(new Date(NOW - MAX_FRAME_AGE_MS - 1000).toISOString(), NOW)).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["number", 1760192400],
    ["empty", ""],
    ["no zone", "2026-10-11T14:10:00"],
    ["date only", "2026-10-11"],
    ["garbage", "yesterday"],
    ["impossible month", "2026-13-11T14:10:00Z"],
    ["too long", "2026-10-11T14:10:00Z" + " ".repeat(40)],
  ])("returns null for %s", (_n, v) => {
    expect(validateFrameAt(v, NOW)).toBeNull();
  });
});

describe("frameClocks", () => {
  it("uses the server time for display when there is no frameAt", () => {
    const c = frameClocks({ nowMs: NOW, frameAtRaw: null, timezone: TZ });
    expect(c.receivedAtUtc).toBe("2026-10-11T14:20:00.000Z");
    expect(c.frameAtUtc).toBeNull();
    expect(c.displayAtUtc).toBe("2026-10-11T14:20:00.000Z");
    expect(c.slotUtc).toBe("2026-10-11T14:00:00.000Z");
    expect(c.localDate).toBe("2026-10-11");
    expect(c.localHour).toBe(10);
    expect(c.localMinute).toBe(20);
    expect(c.utcOffsetMinutes).toBe(-240);
    expect(c.timezone).toBe(TZ);
  });

  it("displays the source time when it is believable, and the slot follows it", () => {
    const c = frameClocks({ nowMs: NOW, frameAtRaw: "2026-10-11T13:55:30Z", timezone: TZ });
    expect(c.frameAtUtc).toBe("2026-10-11T13:55:30.000Z");
    expect(c.displayAtUtc).toBe("2026-10-11T13:55:30.000Z");
    expect(c.receivedAtUtc).toBe("2026-10-11T14:20:00.000Z");
    expect(c.slotUtc).toBe("2026-10-11T13:00:00.000Z");
    expect(c.localHour).toBe(9);
    expect(c.localMinute).toBe(55);
  });

  it("falls back to the server time when frameAt is stale or in the future", () => {
    for (const raw of ["2026-10-11T09:00:00Z", "2026-10-11T15:00:00Z"]) {
      const c = frameClocks({ nowMs: NOW, frameAtRaw: raw, timezone: TZ });
      expect(c.frameAtUtc).toBeNull();
      expect(c.displayAtUtc).toBe(c.receivedAtUtc);
    }
  });

  it("agrees with localHourParts (the helper beach_hourly uses) for date, hour and offset", () => {
    for (const iso of ["2026-10-11T03:59:00Z", "2026-03-08T06:59:00Z", "2026-11-01T05:30:00Z", "2026-01-15T23:45:00Z"]) {
      const ms = Date.parse(iso);
      const c = frameClocks({ nowMs: ms, frameAtRaw: null, timezone: TZ });
      const p = localHourParts(TZ, ms);
      expect(c.localDate).toBe(p.date);
      expect(c.localHour).toBe(p.hour);
      expect(c.utcOffsetMinutes).toBe(p.offsetMinutes);
    }
  });

  it("puts a local-date rollover on the right local day", () => {
    // 03:59Z Oct 11 is 11:59 PM Oct 10 in New York.
    const c = frameClocks({ nowMs: Date.parse("2026-10-11T03:59:00Z"), frameAtRaw: null, timezone: TZ });
    expect(c.localDate).toBe("2026-10-10");
    expect(c.localHour).toBe(23);
    expect(c.localMinute).toBe(59);
  });

  it("keeps the two DST fall-back 1 AM hours as distinct slots with different offsets", () => {
    // 2026-11-01: 1 AM EDT = 05:xxZ, 1 AM EST = 06:xxZ.
    const first = frameClocks({ nowMs: Date.parse("2026-11-01T05:30:00Z"), frameAtRaw: null, timezone: TZ });
    const second = frameClocks({ nowMs: Date.parse("2026-11-01T06:30:00Z"), frameAtRaw: null, timezone: TZ });
    expect(first.localHour).toBe(1);
    expect(second.localHour).toBe(1);
    expect(first.utcOffsetMinutes).toBe(-240);
    expect(second.utcOffsetMinutes).toBe(-300);
    expect(first.slotUtc).not.toBe(second.slotUtc);
    expect(first.localMinute).toBe(30);
    expect(second.localMinute).toBe(30);
  });
});

describe("frameClocks: golden-hour slots", () => {
  const GEO = { lat: 26.3587, lon: -80.0686 };
  // Boca, 2026-10-11: sunrise window 10:57:34Z-11:57:34Z.
  const MORNING = Date.parse("2026-10-11T11:26:00.000Z");

  it("with a location, a display time inside a window floors to 10 minutes and says golden", () => {
    const c = frameClocks({ nowMs: MORNING, frameAtRaw: null, timezone: TZ, geo: GEO });
    expect(c.slotUtc).toBe("2026-10-11T11:20:00.000Z");
    expect(c.slotKind).toBe("golden");
    expect(c.localMinute).toBe(26);
  });

  it("the slot follows frame_at, not received_at", () => {
    const c = frameClocks({ nowMs: MORNING, frameAtRaw: "2026-10-11T11:12:40Z", timezone: TZ, geo: GEO });
    expect(c.displayAtUtc).toBe("2026-10-11T11:12:40.000Z");
    expect(c.slotUtc).toBe("2026-10-11T11:10:00.000Z");
    // frame_at before the window while the server clock is inside it: an hour slot.
    const early = frameClocks({ nowMs: MORNING, frameAtRaw: "2026-10-11T10:40:00Z", timezone: TZ, geo: GEO });
    expect(early.slotUtc).toBe("2026-10-11T10:00:00.000Z");
    expect(early.slotKind).toBe("hour");
  });

  it("outside a window, or with no location, the slot is the UTC hour and the kind is 'hour'", () => {
    expect(frameClocks({ nowMs: NOW, frameAtRaw: null, timezone: TZ, geo: GEO })).toMatchObject({ slotUtc: "2026-10-11T14:00:00.000Z", slotKind: "hour" });
    expect(frameClocks({ nowMs: MORNING, frameAtRaw: null, timezone: TZ })).toMatchObject({ slotUtc: "2026-10-11T11:00:00.000Z", slotKind: "hour" });
  });
});
