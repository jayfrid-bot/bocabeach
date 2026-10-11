import { describe, expect, it } from "vitest";
import {
  bestLine,
  clampDate,
  closestShotText,
  defaultCamId,
  defaultHourUtc,
  dayTitle,
  emptyCamText,
  hour12Label,
  isPickable,
  nearestFrameIndex,
  readingText,
  readingTiles,
  sliderLabel,
  stepDate,
  todayInZone,
} from "@/lib/plus/dayView";
import type { DayHour, DayViewPayload } from "@/lib/history/dayView";

const f = (hourUtc: string, displayAtLocal = "10:42 AM") => ({ hourUtc, displayAtLocal });

describe("nearestFrameIndex", () => {
  const frames = [f("2026-10-10T11:00:00.000Z"), f("2026-10-10T14:00:00.000Z"), f("2026-10-10T19:00:00.000Z")];

  it("is -1 with no frames", () => {
    expect(nearestFrameIndex([], "2026-10-10T14:00:00.000Z")).toBe(-1);
  });

  it("returns the exact slot when there is one", () => {
    expect(nearestFrameIndex(frames, "2026-10-10T14:00:00.000Z")).toBe(1);
  });

  it("returns the closest slot when the hour has no shot", () => {
    expect(nearestFrameIndex(frames, "2026-10-10T12:00:00.000Z")).toBe(0); // 1 h from 11, 2 h from 14
    expect(nearestFrameIndex(frames, "2026-10-10T17:00:00.000Z")).toBe(2); // 3 h from 14, 2 h from 19
    expect(nearestFrameIndex(frames, "2026-10-10T03:00:00.000Z")).toBe(0);
    expect(nearestFrameIndex(frames, "2026-10-10T23:00:00.000Z")).toBe(2);
  });

  it("breaks a tie toward the earlier shot, whatever the array order", () => {
    expect(nearestFrameIndex(frames, "2026-10-10T16:30:00.000Z")).toBe(1); // 2.5 h from 14, 2.5 h from 19
    const shuffled = [frames[2], frames[0], frames[1]];
    expect(shuffled[nearestFrameIndex(shuffled, "2026-10-10T16:30:00.000Z")].hourUtc).toBe("2026-10-10T14:00:00.000Z");
  });

  it("falls back to the first shot without a usable target", () => {
    expect(nearestFrameIndex(frames, null)).toBe(0);
    expect(nearestFrameIndex(frames, "garbage")).toBe(0);
  });

  it("tells a DST fall-back day's two 1 AM hours apart (they are distinct UTC hours)", () => {
    const fall = [f("2026-11-01T05:00:00.000Z", "1:10 AM"), f("2026-11-01T06:00:00.000Z", "1:30 AM")];
    expect(nearestFrameIndex(fall, "2026-11-01T06:00:00.000Z")).toBe(1);
    expect(nearestFrameIndex(fall, "2026-11-01T05:00:00.000Z")).toBe(0);
  });
});

describe("slider and shot labels", () => {
  it("speaks the hour, not the minute", () => {
    expect(sliderLabel("10:42 AM")).toBe("10 AM");
    expect(sliderLabel("12:05 PM")).toBe("12 PM");
    expect(sliderLabel("1:00 am")).toBe("1 AM");
    expect(sliderLabel("noon")).toBe("noon");
  });

  it("says nothing when the shot is from the selected hour, and names the shot when it is not", () => {
    const frame = f("2026-10-10T17:00:00.000Z", "1:42 PM");
    expect(closestShotText(frame, "2026-10-10T17:00:00.000Z")).toBeNull();
    expect(closestShotText(frame, "2026-10-10T14:00:00.000Z")).toBe("Closest shot: 1:42 PM");
    expect(closestShotText(null, "2026-10-10T14:00:00.000Z")).toBeNull();
    expect(closestShotText(frame, null)).toBeNull();
  });

  it("formats hour labels", () => {
    expect(hour12Label(0)).toBe("12 AM");
    expect(hour12Label(12)).toBe("12 PM");
    expect(hour12Label(13)).toBe("1 PM");
  });
});

describe("empty state", () => {
  it("names the day saving began", () => {
    expect(emptyCamText("2026-10-11")).toBe("No saved camera shots for this day. Saving began Oct 11, 2026.");
    expect(emptyCamText("2026-09-22")).toBe("No saved camera shots for this day. Saving began Sept 22, 2026.");
  });

  it("drops the second sentence when no shot has ever been saved", () => {
    expect(emptyCamText(null)).toBe("No saved camera shots for this day.");
  });
});

describe("date bounds and stepping", () => {
  it("steps a day at a time across month, year and leap-day edges", () => {
    expect(stepDate("2026-10-31", 1, null, null)).toBe("2026-11-01");
    expect(stepDate("2026-01-01", -1, null, null)).toBe("2025-12-31");
    expect(stepDate("2028-02-28", 1, null, null)).toBe("2028-02-29");
    expect(stepDate("2026-03-01", -1, null, null)).toBe("2026-02-28");
  });

  it("steps over the DST changes without skipping or repeating a day", () => {
    expect(stepDate("2026-11-01", -1, null, null)).toBe("2026-10-31"); // fall back
    expect(stepDate("2026-11-01", 1, null, null)).toBe("2026-11-02");
    expect(stepDate("2026-03-08", -1, null, null)).toBe("2026-03-07"); // spring forward
    expect(stepDate("2026-03-08", 1, null, null)).toBe("2026-03-09");
  });

  it("returns null at either bound", () => {
    expect(stepDate("2026-10-08", -1, "2026-10-08", "2026-10-11")).toBeNull();
    expect(stepDate("2026-10-11", 1, "2026-10-08", "2026-10-11")).toBeNull();
    expect(stepDate("2026-10-09", -1, "2026-10-08", "2026-10-11")).toBe("2026-10-08");
  });

  it("clamps and validates a typed date", () => {
    expect(clampDate("2026-10-01", "2026-10-08", "2026-10-11")).toBe("2026-10-08");
    expect(clampDate("2026-12-01", "2026-10-08", "2026-10-11")).toBe("2026-10-11");
    expect(isPickable("2026-10-09", "2026-10-08", "2026-10-11")).toBe(true);
    expect(isPickable("2026-10-12", "2026-10-08", "2026-10-11")).toBe(false);
    expect(isPickable("", "2026-10-08", "2026-10-11")).toBe(false);
  });

  it("reads today in the beach's timezone, not UTC's", () => {
    const late = Date.parse("2026-10-12T01:00:00Z"); // 9 PM Oct 11 in New York
    expect(todayInZone("America/New_York", late)).toBe("2026-10-11");
    expect(todayInZone("UTC", late)).toBe("2026-10-12");
    expect(todayInZone("America/New_York", Date.parse("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
    expect(todayInZone("America/New_York", Date.parse("2026-11-01T04:30:00Z"))).toBe("2026-11-01");
  });

  it("titles a day with its full weekday", () => {
    expect(dayTitle("2026-10-10")).toBe("Saturday, Oct 10");
  });
});

describe("readings", () => {
  it("shows an en dash for every missing value", () => {
    expect(readingText(null)).toBe("–");
    expect(readingText(undefined)).toBe("–");
    expect(readingText(Number.NaN)).toBe("–");
    expect(readingTiles(null).every((t) => t.value === "–")).toBe(true);
  });

  it("formats numbers, words and yes/no", () => {
    expect(readingText(84.4, "°")).toBe("84°");
    expect(readingText(1.84, " ft", 1)).toBe("1.8 ft");
    expect(readingText("moderate")).toBe("Moderate");
    expect(readingText(true)).toBe("Yes");
    expect(readingText(false)).toBe("No");
    expect(readingText(0, " mph")).toBe("0 mph");
  });

  it("lists the eleven readings in order", () => {
    expect(readingTiles(null).map((t) => t.key)).toEqual([
      "air", "water", "wind", "surf", "rain", "uv", "sand", "flag", "rip", "seaweed", "crowd",
    ]);
  });
});

describe("defaults", () => {
  const hour = (hourUtc: string, localHour: number, score: number | null): DayHour => ({
    hourUtc,
    localHour,
    utcOffsetMinutes: -240,
    score,
    rating: null,
    engineVersion: "v",
    readings: {
      airF: null, waterF: null, windMph: null, windDir: null, surfFt: null, rainNow: null,
      uv: null, sandF: null, flag: null, rip: null, seaweed: null, crowdPct: null,
    },
  });
  const payload = (over: Partial<DayViewPayload>): DayViewPayload =>
    ({
      date: "2026-10-10",
      timezone: "America/New_York",
      hours: [hour("2026-10-10T14:00:00.000Z", 10, 70), hour("2026-10-10T17:00:00.000Z", 13, 92)],
      summary: { best: { score: 92, localHour: 13 } },
      versions: { current: "v", inRange: [], mixed: false, boundaries: [] },
      cams: [
        { id: "a", name: "A", attribution: null, frames: [] },
        { id: "b", name: "B", attribution: null, frames: [f("2026-10-10T15:00:00.000Z")].map((x) => ({ ...x, attribution: null, url: "u" })) },
      ],
      archiveStart: "2026-10-08",
      framesStart: "2026-10-10",
      ...over,
    }) as unknown as DayViewPayload;

  it("opens on the best hour, else the first hour, else the first shot", () => {
    expect(defaultHourUtc(payload({}))).toBe("2026-10-10T17:00:00.000Z");
    expect(defaultHourUtc(payload({ summary: { best: null } as DayViewPayload["summary"] }))).toBe("2026-10-10T14:00:00.000Z");
    expect(defaultHourUtc(payload({ hours: [], summary: { best: null } as DayViewPayload["summary"] }))).toBe("2026-10-10T15:00:00.000Z");
    expect(defaultHourUtc(payload({ hours: [], cams: [], summary: { best: null } as DayViewPayload["summary"] }))).toBeNull();
  });

  it("opens on the first cam that has a shot", () => {
    expect(defaultCamId(payload({}))).toBe("b");
    expect(defaultCamId(payload({ cams: [] }))).toBeNull();
  });

  it("words the best score", () => {
    expect(bestLine(payload({}))).toBe("Best score 92 at 1 PM");
    expect(bestLine(payload({ summary: { best: null } as DayViewPayload["summary"] }))).toBe("No score for this day");
  });
});
