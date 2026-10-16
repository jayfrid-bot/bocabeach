import { describe, expect, it } from "vitest";
import { shapeSun } from "@/lib/history/dayView";

const localDate = (iso: string) => iso.slice(0, 10); // a stand-in zone: UTC

describe("shapeSun", () => {
  it("is null for both with no JSON, bad JSON, or JSON that is not a list", () => {
    const none = { sunrise: null, sunset: null };
    expect(shapeSun(null, "2026-10-10", localDate)).toEqual(none);
    expect(shapeSun("not json", "2026-10-10", localDate)).toEqual(none);
    expect(shapeSun('{"a":1}', "2026-10-10", localDate)).toEqual(none);
    expect(shapeSun("[]", "2026-10-10", localDate)).toEqual(none);
  });

  it("keeps only events on the date, rounds the score, and drops unreadable rows", () => {
    const json = JSON.stringify([
      { kind: "sunrise", eventIso: "2026-10-10T11:17:00.000Z", score: 63.6, band: "good" },
      { kind: "sunset", eventIso: "2026-10-09T22:58:00.000Z", score: 90, band: "epic" }, // other day
      { kind: "moonrise", eventIso: "2026-10-10T12:00:00.000Z", score: 50, band: "good" }, // unknown kind
      { kind: "sunset", eventIso: "2026-10-10T22:57:00.000Z", score: null, band: null }, // no score
      { kind: "sunset", eventIso: "2026-10-10T22:57:00.000Z", score: 50, band: "bogus" }, // unknown band
    ]);
    expect(shapeSun(json, "2026-10-10", localDate)).toEqual({
      sunrise: { score: 64, band: "good", eventIso: "2026-10-10T11:17:00.000Z" },
      sunset: null,
    });
  });

  it("takes the later event when two of one kind land on the date", () => {
    const json = JSON.stringify([
      { kind: "sunset", eventIso: "2026-10-10T22:57:00.000Z", score: 40, band: "plain" },
      { kind: "sunset", eventIso: "2026-10-10T23:50:00.000Z", score: 80, band: "vivid" },
    ]);
    expect(shapeSun(json, "2026-10-10", localDate).sunset).toMatchObject({ score: 80 });
  });
});

describe("shapeSun with the real clock (forecast window)", () => {
  const json = JSON.stringify([
    { kind: "sunrise", eventIso: "2026-10-10T11:17:00.000Z", score: 63, band: "good" },
    { kind: "sunset", eventIso: "2026-10-10T22:57:00.000Z", score: 80, band: "vivid" },
  ]);
  const at = (iso: string) => Date.parse(iso);

  it("keeps past events: an archived score is a record, not a prediction", () => {
    const out = shapeSun(json, "2026-10-10", localDate, at("2026-10-11T08:00:00.000Z"));
    expect(out.sunrise).toMatchObject({ score: 63 });
    expect(out.sunset).toMatchObject({ score: 80 });
  });

  it("drops a still-to-come event until 60 minutes before it", () => {
    // Midday: sunrise is over, the 5:57 PM-ish sunset is hours away.
    const midday = shapeSun(json, "2026-10-10", localDate, at("2026-10-10T17:00:00.000Z"));
    expect(midday.sunrise).toMatchObject({ score: 63 });
    expect(midday.sunset).toBeNull();
    // 61 minutes out: still hidden. 60 minutes out: shown.
    expect(shapeSun(json, "2026-10-10", localDate, at("2026-10-10T21:56:00.000Z")).sunset).toBeNull();
    expect(shapeSun(json, "2026-10-10", localDate, at("2026-10-10T21:57:00.000Z")).sunset).toMatchObject({ score: 80 });
  });

  it("before dawn, both of today's events are hidden", () => {
    const out = shapeSun(json, "2026-10-10", localDate, at("2026-10-10T05:00:00.000Z"));
    expect(out).toEqual({ sunrise: null, sunset: null });
  });
});
