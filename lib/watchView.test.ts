import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fixture from "./__fixtures__/boca-2026-09-04-phantom-rain.json";
import { SafetyBanner } from "@/components/SafetyBanner";
import { applyLiveRipCap, deriveMetrics } from "@/lib/score";
import { ripCapFor } from "@/lib/ripRisk";
import { buildSafetyBanner } from "@/lib/safetyBanner";
import { buildWatchView, computeValidUntil, windowText, MAX_VALID_MS } from "@/lib/watchView";
import type { ConditionsResponse } from "@/lib/types";

// A real Boca Raton payload (yellow + purple flags, buoy water temp, a 3-7 PM best window).
const NOW = Date.parse(fixture.snapshot.generatedAt);
const iso = (ms: number) => new Date(ms).toISOString();
/** The fixture's radar has rain 20 min out (11 mi north); most scenarios want a dry radar. */
const dry = (r: ConditionsResponse) => {
  Object.assign(r.snapshot.precipRadar.data!, { etaMinutes: null, nearestRainKm: null, nearestBearingDeg: null });
  return r;
};
const res = (): ConditionsResponse => dry(JSON.parse(JSON.stringify(fixture)) as ConditionsResponse);
const lineOf = (v: ReturnType<typeof buildWatchView>, kind: string) => v.lines.find((l) => l.kind === kind);

/** The website's banner for the same snapshot, rendered the way the page renders it. */
function bannerHtml(r: ConditionsResponse, nowMs = NOW): string {
  const s = r.snapshot;
  return renderToStaticMarkup(
    createElement(SafetyBanner, {
      city: s.cityOfficial,
      water: s.waterQuality,
      lightning: s.lightning,
      nws: s.nws,
      ripNwps: s.ripNwps,
      timezone: s.location.timezone,
      nowMs,
    }),
  );
}
const bannerModel = (r: ConditionsResponse, nowMs = NOW) => {
  const s = r.snapshot;
  return buildSafetyBanner({
    city: s.cityOfficial, water: s.waterQuality, lightning: s.lightning, nws: s.nws,
    ripNwps: s.ripNwps, timezone: s.location.timezone, nowMs,
  });
};
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TONE_CLASS = { danger: "bg-rose-500/10", caution: "bg-amber-500/10", calm: "bg-white/80" } as const;

const alert = (event: string, severity: string, fromMin: number, toMin: number, extra: object = {}) => ({
  id: `urn:test:${event}`, event, severity, onset: iso(NOW + fromMin * 60_000), effective: iso(NOW + fromMin * 60_000),
  ends: iso(NOW + toMin * 60_000), expires: iso(NOW + toMin * 60_000), ...extra,
});

const scenarios: Record<string, (r: ConditionsResponse) => void> = {
  "yellow + purple flags": () => {},
  "green + purple flags": (r) => void (r.snapshot.cityOfficial.data!.flags = ["green", "purple"]),
  "double red + purple": (r) => void (r.snapshot.cityOfficial.data!.flags = ["double-red", "purple"]),
  "bacteria advisory": (r) => void (r.snapshot.waterQuality.data!.advisory = true),
  "city no-swim advisory": (r) => void (r.snapshot.cityOfficial.data = { ...r.snapshot.cityOfficial.data!, noSwimAdvisory: { title: "NO SWIM ADVISORY", url: "https://x" } }),
  "lightning within 5 mi": (r) => {
    Object.assign(r.snapshot.lightning, { status: "ok" });
    Object.assign(r.snapshot.lightning.data!, { nearestMi: 3.2, lastMinutesAgo: 5, nearestMinutesAgo: 5 });
  },
  "rip alert in effect": (r) => void (r.snapshot.nws.data!.alerts = [alert("Rip Current Statement", "Moderate", -60, 60, { headline: "rip" })]),
  "upcoming rip alert only": (r) => {
    r.snapshot.cityOfficial.data!.flags = [];
    r.snapshot.nws.data!.alerts = [alert("Rip Current Statement", "Moderate", 90, 300, { headline: "rip" })];
  },
  "upcoming non-rip alert only": (r) => {
    r.snapshot.cityOfficial.data!.flags = [];
    r.snapshot.nws.data!.alerts = [alert("Heat Advisory", "Minor", 60, 300)];
  },
  "many things at once": (r) => {
    r.snapshot.cityOfficial.data = { ...r.snapshot.cityOfficial.data!, flags: ["red", "purple"], noSwimAdvisory: { title: "NO SWIM", url: "https://x" } };
    r.snapshot.waterQuality.data!.advisory = true;
    Object.assign(r.snapshot.lightning, { status: "ok" });
    Object.assign(r.snapshot.lightning.data!, { nearestMi: 2, lastMinutesAgo: 3, nearestMinutesAgo: 3 });
    r.snapshot.nws.data!.alerts = [
      alert("Rip Current Statement", "Moderate", -60, 60, { headline: "rip" }),
      alert("Tornado Warning", "Extreme", -10, 30),
      alert("Coastal Flood Advisory", "Minor", -60, 120),
      alert("Heat Advisory", "Minor", 60, 300),
    ];
  },
};

describe("buildWatchView on a real payload", () => {
  const r0 = res();
  const v = buildWatchView(r0, NOW);

  it("uses the dashboard's score, with the live rip cap, and the band's own words", () => {
    const d = deriveMetrics(r0.snapshot, NOW);
    expect(v.score).toBe(applyLiveRipCap(r0.score, ripCapFor(d.ripNow), d.ripNow).score);
    expect(v.rating).toBe("Good");
    expect(v.band).toBe("good");
    expect(v.slug).toBe("boca-raton");
    expect(v.name).toBe("Boca Raton");
  });

  it("keeps both flags as one line, caution because a purple flag is caution on the website", () => {
    const safety = lineOf(v, "safety");
    expect(safety?.text).toBe("Yellow + purple flags");
    expect(safety?.tone).toBe("caution");
  });

  it("carries water temperature and a best time in the beach's time zone", () => {
    expect(v.waterTempF).toBeGreaterThan(50);
    expect(lineOf(v, "water")?.text).toBe(`Water ${v.waterTempF}°F`);
    expect(lineOf(v, "best")?.text).toBe("Best 3–7 PM");
  });

  it("is small, short on lines, and honest about time", () => {
    expect(JSON.stringify(v).length).toBeLessThan(2048);
    expect(v.generatedAt).toBe(fixture.snapshot.generatedAt);
    expect(v.capturedAt).toBe(iso(NOW));
    expect(v.lines.length).toBeLessThanOrEqual(6);
  });
});

describe("the watch says what the website banner says", () => {
  for (const [name, mutate] of Object.entries(scenarios)) {
    it(name, () => {
      const r = res();
      mutate(r);
      const model = bannerModel(r);
      const html = bannerHtml(r);
      const view = buildWatchView(r, NOW);
      const safety = view.lines.filter((l) => l.kind === "hazard" || l.kind === "safety" || l.kind === "more");

      if (model.hidden) {
        expect(html).toBe("");
        expect(safety).toEqual([]);
        return;
      }
      // The page renders the banner's headline, in the banner's own tone...
      expect(html).toContain(esc(model.headline!.text));
      expect(html).toContain(TONE_CLASS[model.tone]);
      // ...and the watch leads with the same item, in the same order, at the same loudness.
      const items = model.items;
      const first = items[0];
      if (!first.id.startsWith("flag-")) expect(safety[0].text).toBe(first.short);
      else expect(safety[0].kind).toBe("safety");
      // The loudest watch line is as loud as the banner (never softer).
      const loudest = safety.reduce((t, l) => (l.tone === "danger" ? "danger" : l.tone === "caution" && t !== "danger" ? "caution" : t), "calm" as string);
      // (One known website quirk: an UPCOMING rip alert gets an amber block inside a calm banner.)
      expect(loudest).toBe(name === "upcoming rip alert only" ? "caution" : model.tone);
      // Same ranking: the watch's non-flag lines are a prefix of the banner's non-flag items, in order.
      const bannerOrder = items.filter((i) => !i.id.startsWith("flag-")).map((i) => i.short);
      const watchOrder = safety.filter((l) => l.kind !== "more" && !/flag/.test(l.text)).map((l) => l.text);
      expect(watchOrder).toEqual(bannerOrder.slice(0, watchOrder.length));
    });
  }

  it("lightning, bacteria and no-swim all outrank a flag, and none is silently dropped", () => {
    const r = res();
    scenarios["many things at once"](r);
    const view = buildWatchView(r, NOW);
    const texts = view.lines.map((l) => l.text);
    expect(texts[0]).toMatch(/^Lightning 2 mi away/);
    expect(view.lines.filter((l) => l.kind !== "water" && l.kind !== "best")).toHaveLength(4); // 3 safety + "+N more"
    const more = lineOf(view, "more");
    expect(more?.text).toMatch(/^\+\d+ more$/);
    expect(more?.tone).not.toBe("calm"); // what was cut is not all calm
    // 3 shown + N more = every banner candidate (flags counted once).
    const model = bannerModel(r);
    const candidates = model.items.filter((i) => !i.id.startsWith("flag-")).length + 1; // + one flags line
    expect(3 + Number(more!.text.match(/\d+/)![0])).toBe(candidates);
  });

  it("an active rip alert is danger and ranks above the yellow and purple flags", () => {
    const r = res();
    scenarios["rip alert in effect"](r);
    const lines = buildWatchView(r, NOW).lines;
    expect(lines[0]).toEqual({ kind: "safety", text: "Rip current alert", tone: "danger" });
    expect(lines[1].text).toBe("Yellow + purple flags");
  });

  it("an upcoming alert is shown, as informational", () => {
    const r = res();
    scenarios["upcoming non-rip alert only"](r);
    const line = buildWatchView(r, NOW).lines.find((l) => l.text === "Heat Advisory soon");
    expect(line).toEqual({ kind: "hazard", text: "Heat Advisory soon", tone: "calm" });
  });
});

describe("rain is worded as the website words it", () => {
  it("'Raining now' only for measured rain at the beach", () => {
    const r = res();
    Object.assign(r.snapshot.precipRadar.data!, { frameAgeMinutes: 4, rainNowMmHr: 3, nearestRainKm: 0 });
    expect(buildWatchView(r, NOW).lines.some((l) => l.text === "Raining now")).toBe(true);
  });

  it("rain merely near the beach is not 'Raining now'", () => {
    const r = res();
    Object.assign(r.snapshot.precipRadar.data!, { frameAgeMinutes: 4, rainNowMmHr: 0, nearestRainKm: 3, etaMinutes: null, nearestBearingDeg: 90 });
    const texts = buildWatchView(r, NOW).lines.map((l) => l.text);
    expect(texts).not.toContain("Raining now");
    expect(texts.some((t) => /^Showers on radar/.test(t))).toBe(true);
  });

  it("rain on its way, from a fresh frame", () => {
    const r = JSON.parse(JSON.stringify(fixture)) as ConditionsResponse; // eta 20 min
    expect(buildWatchView(r, NOW).lines.some((l) => l.text === "Rain in ~20 min")).toBe(true);
  });

  it("a stale radar frame is unknown: no rain line", () => {
    const r = res();
    Object.assign(r.snapshot.precipRadar.data!, { frameAgeMinutes: 90, rainNowMmHr: 5, nearestRainKm: 0, etaMinutes: 10 });
    expect(buildWatchView(r, NOW).lines.some((l) => /rain|shower/i.test(l.text))).toBe(false);
  });
});

describe("rip model works even when the NWS feed failed", () => {
  it("shows the model's level", () => {
    const r = res();
    r.snapshot.nws.status = "error";
    r.snapshot.nws.data = null;
    const hour = Math.floor(NOW / 3_600_000) * 3_600_000;
    r.snapshot.ripNwps = {
      source: "NOAA/NWS NWPS", status: "ok", fetchedAt: iso(NOW), attribution: "NOAA",
      data: { office: "mfl", run: iso(NOW - 3_600_000), point: { lon: -80.07, lat: 26.36 },
        hours: [{ t: iso(hour), prob: 70, hsFt: 3, periodS: 8, dirDeg: 90 }] },
    } as ConditionsResponse["snapshot"]["ripNwps"];
    expect(buildWatchView(r, NOW).lines.some((l) => l.text === "Rip current high")).toBe(true);
  });
});

describe("validUntil", () => {
  it("is at most 15 minutes after the snapshot was built", () => {
    const r = res();
    expect(computeValidUntil(r, NOW)).toBe(NOW + MAX_VALID_MS);
    expect(buildWatchView(r, NOW).validUntil).toBe(iso(NOW + MAX_VALID_MS));
  });

  it("ends sooner at an alert starting or ending", () => {
    const r = res();
    r.snapshot.nws.data!.alerts = [alert("Heat Advisory", "Minor", 4, 300)];
    expect(computeValidUntil(r, NOW)).toBe(NOW + 4 * 60_000);
    r.snapshot.nws.data!.alerts = [alert("Rip Current Statement", "Moderate", -60, 7, { headline: "rip" })];
    expect(computeValidUntil(r, NOW)).toBe(NOW + 7 * 60_000);
  });

  it("ends at the next rip model hour, an SRF period boundary, and the best window's end", () => {
    const r = res();
    const nextHour = Math.floor(NOW / 3_600_000) * 3_600_000 + 3_600_000;
    r.snapshot.ripNwps = { status: "ok", data: { run: iso(NOW), hours: [] } } as unknown as ConditionsResponse["snapshot"]["ripNwps"];
    expect(computeValidUntil(r, NOW)).toBe(Math.min(NOW + MAX_VALID_MS, nextHour));
    r.snapshot.ripNwps = undefined as never;
    r.snapshot.nws.data!.srfPeriods = [{ label: "TODAY", level: "low", start: iso(NOW - 3_600_000), end: iso(NOW + 2 * 60_000) }];
    expect(computeValidUntil(r, NOW)).toBe(NOW + 2 * 60_000);
    r.snapshot.nws.data!.srfPeriods = [];
    r.multiDayWindows[0].best = { startIso: iso(NOW - 1000), endIso: iso(NOW + 3 * 60_000), score: 80 };
    expect(computeValidUntil(r, NOW)).toBe(NOW + 3 * 60_000);
  });

  it("ignores boundaries already behind it", () => {
    const r = res();
    r.snapshot.nws.data!.alerts = [alert("Heat Advisory", "Minor", -120, -30)];
    expect(computeValidUntil(r, NOW)).toBe(NOW + MAX_VALID_MS);
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
    const v = buildWatchView(r, NOW + 6 * 3_600_000); // after the best window ended
    expect(lineOf(v, "water")).toBeUndefined();
    expect(lineOf(v, "best")).toBeUndefined();
    expect(v.lines.some((l) => /flag/.test(l.text))).toBe(false);
  });

  it("says there is no good window when the best one is below Decent", () => {
    const r = res();
    r.multiDayWindows[0].best = { startIso: iso(NOW + 3_600_000), endIso: iso(NOW + 7_200_000), score: 50 };
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
