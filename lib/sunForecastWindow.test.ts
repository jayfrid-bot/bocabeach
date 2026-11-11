import { describe, it, expect } from "vitest";
import {
  SUN_FORECAST_EARLY_SHORT,
  SUN_FORECAST_FIRM_MINUTES,
  SUN_FORECAST_FIRM_MS,
  SUN_FORECAST_WINDOW_MINUTES,
  SUN_FORECAST_WINDOW_MS,
  nextSunForecastField,
  sunForecastEarlyText,
  sunForecastEarlyWhy,
  sunForecastField,
  sunForecastFirm,
  sunForecastOpen,
  sunForecastPendingText,
  sunForecastPendingWhy,
  sunForecastWindow,
} from "@/lib/sunForecastWindow";
import { IR_EARLY_WINDOW_MINUTES, IR_EVENT_WINDOW_MINUTES } from "@/lib/sunAlert";

const NY = "America/New_York";
const MIN = 60_000;

describe("window constants", () => {
  it("opens 120 minutes before and firms up 60 minutes before", () => {
    expect(SUN_FORECAST_WINDOW_MINUTES).toBe(120);
    expect(SUN_FORECAST_WINDOW_MS).toBe(120 * MIN);
    expect(SUN_FORECAST_FIRM_MINUTES).toBe(60);
    expect(SUN_FORECAST_FIRM_MS).toBe(60 * MIN);
  });

  it("matches the model's own windows: the early look is the 120-60 min mean, the firm score is the satellite alone", () => {
    expect(IR_EARLY_WINDOW_MINUTES).toBe(SUN_FORECAST_WINDOW_MINUTES);
    expect(IR_EVENT_WINDOW_MINUTES).toBe(SUN_FORECAST_FIRM_MINUTES);
  });
});

describe("sunForecastWindow", () => {
  const EVENT = "2026-10-15T22:52:00.000Z"; // 6:52 PM EDT
  const eventMs = Date.parse(EVENT);

  it("is pending until 120 minutes before the event", () => {
    const w = sunForecastWindow(EVENT, eventMs - SUN_FORECAST_WINDOW_MS - 1);
    expect(w).toEqual({
      state: "pending",
      availableAtIso: "2026-10-15T20:52:00.000Z",
      eventIso: EVENT,
      early: false,
      firmAtIso: "2026-10-15T21:52:00.000Z",
    });
  });

  it("opens exactly 120 minutes before (inclusive), as an early look", () => {
    expect(sunForecastWindow(EVENT, eventMs - SUN_FORECAST_WINDOW_MS)).toMatchObject({ state: "available", early: true });
    expect(sunForecastWindow(EVENT, eventMs - 61 * MIN)).toMatchObject({ state: "available", early: true });
  });

  it("firms up exactly 60 minutes before (inclusive)", () => {
    expect(sunForecastWindow(EVENT, eventMs - SUN_FORECAST_FIRM_MS - 1)).toMatchObject({ state: "available", early: true });
    expect(sunForecastWindow(EVENT, eventMs - SUN_FORECAST_FIRM_MS)).toMatchObject({ state: "available", early: false });
    expect(sunForecastWindow(EVENT, eventMs - 59 * MIN)).toMatchObject({ state: "available", early: false });
  });

  it("stays available and firm at and after the event", () => {
    expect(sunForecastWindow(EVENT, eventMs)).toMatchObject({ state: "available", early: false });
    expect(sunForecastWindow(EVENT, eventMs + 25 * MIN)).toMatchObject({ state: "available", early: false });
  });

  it("is null for an unreadable event or clock, never a guess", () => {
    expect(sunForecastWindow(undefined, eventMs)).toBeNull();
    expect(sunForecastWindow(null, eventMs)).toBeNull();
    expect(sunForecastWindow("not a date", eventMs)).toBeNull();
    expect(sunForecastWindow(EVENT, Number.NaN)).toBeNull();
    expect(sunForecastOpen("not a date", eventMs)).toBe(false);
    expect(sunForecastFirm("not a date", eventMs)).toBe(false);
  });

  it("sunForecastOpen mirrors the state; sunForecastFirm waits for the firm mark", () => {
    expect(sunForecastOpen(EVENT, eventMs - 121 * MIN)).toBe(false);
    expect(sunForecastOpen(EVENT, eventMs - 120 * MIN)).toBe(true);
    expect(sunForecastFirm(EVENT, eventMs - 120 * MIN)).toBe(false);
    expect(sunForecastFirm(EVENT, eventMs - 61 * MIN)).toBe(false);
    expect(sunForecastFirm(EVENT, eventMs - 60 * MIN)).toBe(true);
    expect(sunForecastFirm(EVENT, eventMs + 10 * MIN)).toBe(true);
  });

  it("across local midnight: a 12:30 AM event opens at 10:30 PM the day before", () => {
    const ev = "2026-10-15T04:30:00.000Z"; // 12:30 AM EDT Oct 15
    const w = sunForecastWindow(ev, Date.parse("2026-10-15T02:29:59.000Z"));
    expect(w?.state).toBe("pending");
    expect(w?.availableAtIso).toBe("2026-10-15T02:30:00.000Z"); // 10:30 PM EDT Oct 14
    expect(sunForecastPendingText("sunrise", w!.availableAtIso, NY)).toBe("Sunrise forecast ready at 10:30 PM");
    expect(sunForecastWindow(ev, Date.parse("2026-10-15T02:30:00.000Z"))?.state).toBe("available");
  });

  it("DST spring forward: the window is 120 real minutes, not 120 wall-clock minutes", () => {
    // 2027-03-14: 2:00 AM EST jumps to 3:00 AM EDT. Event 3:30 AM EDT = 07:30Z.
    const ev = "2027-03-14T07:30:00.000Z";
    const w = sunForecastWindow(ev, Date.parse("2027-03-14T05:00:00.000Z"));
    expect(w?.availableAtIso).toBe("2027-03-14T05:30:00.000Z"); // 12:30 AM EST
    expect(w?.firmAtIso).toBe("2027-03-14T06:30:00.000Z"); // 1:30 AM EST
    expect(w?.state).toBe("pending");
    expect(sunForecastPendingText("sunrise", w!.availableAtIso, NY)).toBe("Sunrise forecast ready at 12:30 AM");
    expect(sunForecastWindow(ev, Date.parse("2027-03-14T05:30:00.000Z"))?.state).toBe("available");
  });

  it("DST fall back: the repeated hour still opens exactly 120 minutes ahead", () => {
    // 2026-11-01: 2:00 AM EDT falls back to 1:00 AM EST. Event 1:30 AM EST = 06:30Z.
    const ev = "2026-11-01T06:30:00.000Z";
    const w = sunForecastWindow(ev, Date.parse("2026-11-01T04:29:00.000Z"));
    expect(w?.availableAtIso).toBe("2026-11-01T04:30:00.000Z"); // 12:30 AM EDT
    expect(w?.firmAtIso).toBe("2026-11-01T05:30:00.000Z"); // 1:30 AM EDT (the first 1:30)
    expect(w?.state).toBe("pending");
    expect(sunForecastWindow(ev, Date.parse("2026-11-01T04:30:00.000Z"))?.state).toBe("available");
  });
});

describe("sunForecastPendingText", () => {
  it("words the sunset and sunrise lines with h:mm AM/PM in the beach's zone", () => {
    expect(sunForecastPendingText("sunset", "2026-10-15T21:52:00.000Z", NY)).toBe("Sunset forecast ready at 5:52 PM");
    expect(sunForecastPendingText("sunrise", "2026-10-16T10:19:00.000Z", NY)).toBe("Sunrise forecast ready at 6:19 AM");
  });

  it("uses the beach's own zone, not the server's", () => {
    expect(sunForecastPendingText("sunset", "2026-10-15T21:52:00.000Z", "America/Los_Angeles")).toBe(
      "Sunset forecast ready at 2:52 PM",
    );
  });

  it("never carries a score, a band word or '/100'", () => {
    const t = sunForecastPendingText("sunset", "2026-10-15T21:52:00.000Z", NY);
    expect(t).not.toMatch(/\d+\/100|out of 100|Poor|Fair|Good|Great|Amazing/);
    expect(t).not.toMatch(/\bAI\b/);
  });

  it("the second line says the window is 2 hours", () => {
    expect(sunForecastPendingWhy("sunset", "2026-10-15T22:52:00.000Z", NY)).toBe("2 hours before sunset at 6:52 PM");
  });
});

describe("early-look copy", () => {
  it("says it is an early look and when it firms up, in the beach's zone", () => {
    expect(sunForecastEarlyText("2026-10-15T21:52:00.000Z", NY)).toBe("Early look. Firms up at 5:52 PM");
    expect(SUN_FORECAST_EARLY_SHORT).toBe("Early look");
  });

  it("explains it in plain words, with the owner's wording rules", () => {
    for (const kind of ["sunrise", "sunset"] as const) {
      const t = sunForecastEarlyWhy(kind);
      expect(t).toContain(`2 hours to 1 hour before the ${kind}`);
      expect(t).not.toMatch(/color forecast/i);
      expect(t).not.toMatch(/\bAI\b/);
    }
  });
});

describe("sunForecastField (watch / agent payloads)", () => {
  const SUNSET = "2026-10-15T22:52:00.000Z";

  it("pending: state, times and the text line", () => {
    const f = sunForecastField("sunset", SUNSET, Date.parse(SUNSET) - 3 * 60 * MIN, NY);
    expect(f).toEqual({
      kind: "sunset",
      state: "pending",
      availableAt: "2026-10-15T20:52:00.000Z",
      eventAt: SUNSET,
      text: "Sunset forecast ready at 4:52 PM",
      early: false,
      firmAt: "2026-10-15T21:52:00.000Z",
    });
    expect(f).not.toHaveProperty("score");
  });

  it("early look: available, flagged early, no text line, still no score", () => {
    const f = sunForecastField("sunset", SUNSET, Date.parse(SUNSET) - 90 * MIN, NY);
    expect(f).toMatchObject({ state: "available", early: true, text: null, firmAt: "2026-10-15T21:52:00.000Z" });
    expect(f).not.toHaveProperty("score");
  });

  it("firm: available, not early, no text line, still no score", () => {
    const f = sunForecastField("sunset", SUNSET, Date.parse(SUNSET) - 30 * MIN, NY);
    expect(f).toMatchObject({ state: "available", early: false, text: null });
    expect(f).not.toHaveProperty("score");
  });

  it("null when the event time is unreadable", () => {
    expect(sunForecastField("sunset", "nope", 0, NY)).toBeNull();
  });
});

describe("nextSunForecastField", () => {
  // Oct 15 2026 Boca-ish: sunrise 7:09 AM EDT, sunset 6:28 PM EDT.
  const sun = {
    sunrise: "2026-10-15T11:09:00.000Z",
    sunset: "2026-10-15T22:28:00.000Z",
    tomorrowSunrise: "2026-10-16T11:10:00.000Z",
  };

  it("before sunrise: the sunrise, pending until two hours before", () => {
    const f = nextSunForecastField(sun, Date.parse("2026-10-15T08:00:00.000Z"), NY);
    expect(f).toMatchObject({ kind: "sunrise", state: "pending", text: "Sunrise forecast ready at 5:09 AM" });
  });

  it("midday: the sunset, pending", () => {
    const f = nextSunForecastField(sun, Date.parse("2026-10-15T17:00:00.000Z"), NY);
    expect(f).toMatchObject({ kind: "sunset", state: "pending", text: "Sunset forecast ready at 4:28 PM" });
  });

  it("between two hours and one hour before sunset: available, early", () => {
    const f = nextSunForecastField(sun, Date.parse("2026-10-15T20:40:00.000Z"), NY);
    expect(f).toMatchObject({ kind: "sunset", state: "available", early: true, text: null });
  });

  it("inside the hour before sunset: available, firm", () => {
    const f = nextSunForecastField(sun, Date.parse("2026-10-15T21:40:00.000Z"), NY);
    expect(f).toMatchObject({ kind: "sunset", state: "available", early: false, text: null });
  });

  it("after the sunset passes it rolls to tomorrow's sunrise, pending", () => {
    const f = nextSunForecastField(sun, Date.parse("2026-10-15T23:00:00.000Z"), NY);
    expect(f).toMatchObject({ kind: "sunrise", state: "pending", eventAt: "2026-10-16T11:10:00.000Z", text: "Sunrise forecast ready at 5:10 AM" });
  });

  it("null with no sun times", () => {
    expect(nextSunForecastField(null, 0, NY)).toBeNull();
    expect(nextSunForecastField({}, 0, NY)).toBeNull();
  });
});
