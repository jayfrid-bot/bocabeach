import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/boca-2026-09-04-phantom-rain.json";
import { applyLiveRipCap, deriveMetrics } from "@/lib/score";
import { ripCapFor } from "@/lib/ripRisk";
import { buildWatchView, windowText } from "@/lib/watchView";
import type { ConditionsResponse } from "@/lib/types";

// A real Boca Raton payload (yellow + purple flags, buoy water temp, a 1-5 PM best window).
const NOW = Date.parse(fixture.snapshot.generatedAt);
const res = (): ConditionsResponse => JSON.parse(JSON.stringify(fixture)) as ConditionsResponse;
const lineOf = (v: ReturnType<typeof buildWatchView>, kind: string) => v.lines.find((l) => l.kind === kind);

describe("buildWatchView on a real payload", () => {
  const v = buildWatchView(res(), NOW);

  it("uses the dashboard's score, with the live rip cap, and the band's own words", () => {
    const r = res();
    const d = deriveMetrics(r.snapshot, NOW);
    const expected = applyLiveRipCap(r.score, ripCapFor(d.ripNow), d.ripNow).score;
    expect(v.score).toBe(expected);
    expect(v.rating).toBe("Good");
    expect(v.band).toBe("good");
    expect(v.slug).toBe("boca-raton");
    expect(v.name).toBe("Boca Raton");
  });

  it("keeps both flags (yellow and purple), then rip, in one safety line", () => {
    const safety = lineOf(v, "safety");
    expect(safety?.text.startsWith("Yellow + purple flags")).toBe(true);
    expect(safety?.tone).toBe("caution");
  });

  it("carries water temperature and a best time in the beach's time zone", () => {
    expect(v.waterTempF).toBeGreaterThan(50);
    expect(lineOf(v, "water")?.text).toBe(`Water ${v.waterTempF}°F`);
    expect(lineOf(v, "best")?.text).toBe("Best 3–7 PM");
  });

  it("is small and honest about time", () => {
    expect(JSON.stringify(v).length).toBeLessThan(2048);
    expect(v.generatedAt).toBe(fixture.snapshot.generatedAt);
    expect(v.capturedAt).toBe(new Date(NOW).toISOString());
    expect(v.lines.length).toBeLessThanOrEqual(5);
  });
});

describe("hazards use the website's rules", () => {
  it("shows an active lightning hold from the most recent strike inside 5 miles", () => {
    const r = res();
    Object.assign(r.snapshot.lightning, { status: "ok" });
    Object.assign(r.snapshot.lightning.data!, { closeStrikeMinutesAgo: 12, windowMinutes: 30, nearestMi: 3.2, nearestMinutesAgo: 12 });
    const v = buildWatchView(r, NOW);
    expect(v.lines[0]).toEqual({ kind: "hazard", text: "Lightning 3.2 mi away", tone: "danger" });
  });

  it("does not call lightning active from a nearby-but-not-close strike", () => {
    const r = res();
    Object.assign(r.snapshot.lightning.data!, { nearestMi: 4, nearestMinutesAgo: 5, closeStrikeMinutesAgo: undefined });
    r.snapshot.precipRadar.data!.etaMinutes = null; // the fixture's radar has rain 20 min out
    expect(lineOf(buildWatchView(r, NOW), "hazard")).toBeUndefined();
  });

  it("shows an active bacteria advisory next to a reassuring flag", () => {
    const r = res();
    r.snapshot.waterQuality.data!.advisory = true;
    const v = buildWatchView(r, NOW);
    expect(v.lines[0]).toEqual({ kind: "hazard", text: "Water quality advisory", tone: "danger" });
    expect(lineOf(v, "safety")).toBeDefined();
  });

  it("reads the rip model even when the NWS feed failed", () => {
    const r = res();
    r.snapshot.nws.status = "error";
    r.snapshot.nws.data = null;
    const hour = Math.floor(NOW / 3_600_000) * 3_600_000;
    r.snapshot.ripNwps = {
      source: "NOAA/NWS NWPS",
      status: "ok",
      fetchedAt: new Date(NOW).toISOString(),
      attribution: "NOAA",
      data: {
        office: "mfl",
        run: new Date(NOW - 3_600_000).toISOString(),
        point: { lon: -80.07, lat: 26.36 },
        hours: [{ t: new Date(hour).toISOString(), prob: 70, hsFt: 3, periodS: 8, dirDeg: 90 }],
      },
    } as ConditionsResponse["snapshot"]["ripNwps"];
    const safety = lineOf(buildWatchView(r, NOW), "safety");
    expect(safety?.text).toContain("Rip high");
  });

  it("treats a stale radar frame as unknown: no rain line", () => {
    const r = res();
    Object.assign(r.snapshot.precipRadar.data!, {
      frameAgeMinutes: 90, rainNowMmHr: 5, nearestRainKm: 0, etaMinutes: 10, wetMinutesAgo: null,
    });
    expect(buildWatchView(r, NOW).lines.some((l) => /rain/i.test(l.text))).toBe(false);
  });

  it("shows rain now from a fresh radar frame", () => {
    const r = res();
    Object.assign(r.snapshot.precipRadar.data!, { frameAgeMinutes: 4, rainNowMmHr: 3, nearestRainKm: 0 });
    expect(buildWatchView(r, NOW).lines[0]?.text).toMatch(/rain|thunderstorm/i);
  });
});

describe("honest nulls", () => {
  it("has no score when the data is unavailable", () => {
    const r = res();
    r.score.dataAvailable = false;
    const v = buildWatchView(r, NOW);
    expect(v.score).toBeNull();
    expect(v.rating).toBeNull();
    expect(v.band).toBeNull();
  });

  it("drops the flag when the city feed gave none, the water line when there is no temperature, and a past best window", () => {
    const r = res();
    r.snapshot.cityOfficial.data = null;
    r.snapshot.buoy.data = null;
    r.snapshot.marine.data = null;
    const v = buildWatchView(r, NOW + 6 * 3_600_000); // after the 1-5 PM window ended
    expect(lineOf(v, "water")).toBeUndefined();
    expect(lineOf(v, "best")).toBeUndefined();
    expect(lineOf(v, "safety")?.text ?? "").not.toMatch(/flag/);
  });

  it("says there is no good window when the best one is below Decent", () => {
    const r = res();
    r.multiDayWindows[0].best = { startIso: "2026-09-04T20:00:00.000Z", endIso: "2026-09-04T22:00:00.000Z", score: 50 };
    expect(lineOf(buildWatchView(r, NOW), "best")?.text).toBe("No good window today");
  });
});

describe("windowText", () => {
  it("compacts a same-half window and keeps both halves when they differ", () => {
    expect(windowText("2026-10-14T20:00:00Z", "2026-10-14T22:00:00Z", "America/New_York")).toBe("4–6 PM");
    expect(windowText("2026-10-14T15:00:00Z", "2026-10-14T18:00:00Z", "America/New_York")).toBe("11 AM–2 PM");
    expect(windowText("2026-10-14T20:30:00Z", "2026-10-14T22:00:00Z", "America/New_York")).toBe("4:30–6 PM");
    expect(windowText("nope", "nope", "America/New_York")).toBeNull();
  });
});
